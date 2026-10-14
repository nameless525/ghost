//! Loop stage: applies the engine [`LoopMode`] to sources that report loop points.
//!
//! The stage presents an "unrolled" timeline: intro, then the loop body repeated, then (for
//! Album/Custom) one more pass through the body while fading out over `fade_sec`. Seeking maps
//! unrolled positions back to source positions. Sources that play forever without loop points
//! report a [`LengthHint`] instead: Album/Custom play that long and fade, Endless keeps going.
//! Other sources pass through untouched. Settings are read live from [`LoopSettings`], so
//! `set_loop` affects playing tracks; so does the chip voice mask, applied before each read.

use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};

use super::{AudioSource, LengthHint, LoopInfo, SourceError, SourceMeta};
use crate::LoopMode;

/// Live loop settings (and the chip voice mask) shared with the controller.
pub struct LoopSettings {
    mode: AtomicU8,
    count: AtomicU32,
    fade_bits: AtomicU32,
    voice_mask: AtomicU64,
}

impl Default for LoopSettings {
    fn default() -> Self {
        Self { mode: AtomicU8::new(0), count: AtomicU32::new(2), fade_bits: AtomicU32::new(10.0f32.to_bits()), voice_mask: AtomicU64::new(0) }
    }
}

/// Album defaults (2 loops, 10 s fade): what renders and analyses use when playback is Endless.
pub const FINITE_DEFAULT: (LoopMode, u32, f32) = (LoopMode::Album, 2, 10.0);

impl LoopSettings {
    pub fn set(&self, mode: LoopMode, count: u32, fade_sec: f32) {
        let m = match mode {
            LoopMode::Album => 0,
            LoopMode::Endless => 1,
            LoopMode::Custom => 2,
        };
        self.mode.store(m, Ordering::Relaxed);
        self.count.store(count.max(1), Ordering::Relaxed);
        self.fade_bits.store(fade_sec.clamp(0.0, 600.0).to_bits(), Ordering::Relaxed);
    }

    /// Settings fixed to `(mode, count, fade)`.
    pub fn fixed(v: (LoopMode, u32, f32)) -> Self {
        let s = Self::default();
        s.set(v.0, v.1, v.2);
        s
    }

    /// `v`, or the Album defaults when `v` is Endless (offline renders must end).
    pub fn finite(v: (LoopMode, u32, f32)) -> (LoopMode, u32, f32) {
        if v.0 == LoopMode::Endless {
            FINITE_DEFAULT
        } else {
            v
        }
    }

    pub fn set_voice_mask(&self, mask: u64) {
        self.voice_mask.store(mask, Ordering::Relaxed);
    }

    pub fn voice_mask(&self) -> u64 {
        self.voice_mask.load(Ordering::Relaxed)
    }

    pub fn get(&self) -> (LoopMode, u32, f32) {
        let mode = match self.mode.load(Ordering::Relaxed) {
            1 => LoopMode::Endless,
            2 => LoopMode::Custom,
            _ => LoopMode::Album,
        };
        (mode, self.count.load(Ordering::Relaxed), f32::from_bits(self.fade_bits.load(Ordering::Relaxed)))
    }
}

pub struct LoopStage {
    inner: Box<dyn AudioSource>,
    settings: std::sync::Arc<LoopSettings>,
    info: Option<LoopInfo>,
    hint: Option<LengthHint>,
    /// Frames emitted on the unrolled timeline.
    pos: u64,
    /// Position inside the source.
    src_pos: u64,
    ended: bool,
    voice_mask: u64,
}

impl LoopStage {
    pub fn new(mut inner: Box<dyn AudioSource>, settings: std::sync::Arc<LoopSettings>) -> Self {
        let info = inner.loop_info().filter(|l| l.end > l.start && l.end <= inner.duration().unwrap_or(u64::MAX));
        let hint = if info.is_none() { inner.length_hint() } else { None };
        let voice_mask = settings.voice_mask();
        if voice_mask != 0 && inner.voice_count() > 0 {
            inner.set_voice_mask(voice_mask);
        }
        Self { inner, settings, info, hint, pos: 0, src_pos: 0, ended: false, voice_mask }
    }

    /// Fade start and length on the timeline of a source with a length hint (None = endless).
    fn hint_window(&self, h: LengthHint) -> Option<(u64, u64)> {
        let (mode, _, fade) = self.settings.get();
        if mode == LoopMode::Endless {
            return None;
        }
        Some((h.length, h.fade.unwrap_or((fade as f64 * self.inner.sample_rate() as f64) as u64)))
    }

    fn sync_voice_mask(&mut self) {
        let m = self.settings.voice_mask();
        if m != self.voice_mask {
            self.voice_mask = m;
            self.inner.set_voice_mask(m);
        }
    }

    /// Apply the raised-cosine fade to `buf` (frames starting at timeline `pos`).
    fn apply_fade(buf: &mut [f32], ch: usize, pos: u64, fs: u64, fl: u64) {
        for (i, f) in buf.chunks_exact_mut(ch).enumerate() {
            let p = pos + i as u64;
            if p >= fs {
                let t = (p - fs) as f32 / fl.max(1) as f32;
                let g = 0.5 + 0.5 * (std::f32::consts::PI * t.min(1.0)).cos();
                for s in f {
                    *s *= g;
                }
            }
        }
    }

    /// Read path for sources with a length hint: play to the fade window, fade, stop.
    fn read_hinted(&mut self, h: LengthHint, out: &mut [f32]) -> Result<usize, SourceError> {
        let ch = self.inner.channels();
        let Some((fs, fl)) = self.hint_window(h) else {
            let n = self.inner.read(out)?;
            self.pos += n as u64;
            return Ok(n);
        };
        if self.pos >= fs + fl {
            self.ended = true;
            return Ok(0);
        }
        let want = (out.len() / ch).min((fs + fl - self.pos) as usize);
        let got = self.inner.read(&mut out[..want * ch])?;
        Self::apply_fade(&mut out[..got * ch], ch, self.pos, fs, fl);
        self.pos += got as u64;
        if got == 0 {
            self.ended = true;
        }
        Ok(got)
    }

    /// (loops before fading, fade length in frames); None = endless.
    fn plan(&self) -> Option<(u64, u64)> {
        let (mode, count, fade) = self.settings.get();
        match mode {
            LoopMode::Endless => None,
            LoopMode::Album | LoopMode::Custom => Some((count.max(1) as u64, (fade as f64 * self.inner.sample_rate() as f64) as u64)),
        }
    }

    /// Unrolled frame at which the fade starts and its length, for looped sources.
    fn fade_window(&self, l: LoopInfo) -> Option<(u64, u64)> {
        let (count, fade) = self.plan()?;
        let body = l.end - l.start;
        Some((l.start + count * body, fade))
    }
}

impl AudioSource for LoopStage {
    fn sample_rate(&self) -> u32 {
        self.inner.sample_rate()
    }
    fn channels(&self) -> usize {
        self.inner.channels()
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, SourceError> {
        self.sync_voice_mask();
        if self.ended {
            return Ok(0);
        }
        let Some(l) = self.info else {
            if let Some(h) = self.hint {
                return self.read_hinted(h, out);
            }
            let n = self.inner.read(out)?;
            self.pos += n as u64;
            return Ok(n);
        };
        let ch = self.inner.channels();
        let want = out.len() / ch;
        let mut done = 0usize;
        while done < want {
            let fade = self.fade_window(l);
            if let Some((fs, fl)) = fade {
                if self.pos >= fs + fl {
                    self.ended = true;
                    break;
                }
            }
            // Don't cross the loop end or the end of the fade in one read.
            let mut n = want - done;
            if self.src_pos < l.end {
                n = n.min((l.end - self.src_pos) as usize);
            }
            if let Some((fs, fl)) = fade {
                n = n.min((fs + fl - self.pos) as usize);
            }
            let got = self.inner.read(&mut out[done * ch..(done + n) * ch])?;
            if let Some((fs, fl)) = fade {
                Self::apply_fade(&mut out[done * ch..(done + got) * ch], ch, self.pos, fs, fl);
            }
            done += got;
            self.pos += got as u64;
            self.src_pos += got as u64;
            if self.src_pos >= l.end || got == 0 {
                if got == 0 && self.src_pos < l.end {
                    // Source ended before its loop end: nothing more to play.
                    self.ended = true;
                    break;
                }
                self.src_pos = self.inner.seek(l.start)?;
            }
        }
        Ok(done)
    }

    fn seek(&mut self, frame: u64) -> Result<u64, SourceError> {
        self.ended = false;
        let Some(l) = self.info else {
            if let Some((fs, fl)) = self.hint.and_then(|h| self.hint_window(h)) {
                if frame >= fs + fl {
                    self.ended = true;
                    self.pos = fs + fl;
                    return Ok(self.pos);
                }
            }
            let p = self.inner.seek(frame)?;
            self.pos = p;
            return Ok(p);
        };
        if let Some((fs, fl)) = self.fade_window(l) {
            if frame >= fs + fl {
                self.ended = true;
                self.pos = fs + fl;
                return Ok(self.pos);
            }
        }
        let src = if frame < l.end { frame } else { l.start + (frame - l.start) % (l.end - l.start) };
        let reached = self.inner.seek(src)?;
        self.src_pos = reached;
        self.pos = frame - (src - reached.min(src));
        Ok(self.pos)
    }

    fn duration(&self) -> Option<u64> {
        match (self.info, self.hint) {
            (Some(l), _) => self.fade_window(l).map(|(fs, fl)| fs + fl),
            (None, Some(h)) => self.hint_window(h).map(|(fs, fl)| fs + fl),
            (None, None) => self.inner.duration(),
        }
    }

    fn loop_info(&self) -> Option<LoopInfo> {
        self.info
    }

    fn length_hint(&self) -> Option<LengthHint> {
        self.hint
    }

    fn meta(&self) -> SourceMeta {
        self.inner.meta()
    }

    fn voice_count(&self) -> usize {
        self.inner.voice_count()
    }

    fn set_voice_mask(&mut self, mask: u64) {
        self.voice_mask = mask;
        self.inner.set_voice_mask(mask);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::test_util::ToneSource;
    use std::sync::Arc;

    fn read_all(s: &mut dyn AudioSource) -> Vec<f32> {
        let mut out = Vec::new();
        let mut buf = vec![0.0; 333 * s.channels()];
        loop {
            let n = s.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n * s.channels()]);
        }
        out
    }

    #[test]
    fn passthrough_without_loops() {
        let settings = Arc::new(LoopSettings::default());
        let tone = ToneSource { rate: 1000, channels: 1, len: 5000, pos: 0, loop_info: None };
        let mut st = LoopStage::new(Box::new(tone), settings);
        assert_eq!(st.duration(), Some(5000));
        assert_eq!(read_all(&mut st).len(), 5000);
    }

    #[test]
    fn album_mode_loops_then_fades() {
        let settings = Arc::new(LoopSettings::default());
        settings.set(LoopMode::Album, 2, 1.0); // 2 loops, 1 s fade at 1 kHz = 1000 frames
        let li = LoopInfo { start: 1000, end: 3000 };
        let tone = ToneSource { rate: 1000, channels: 1, len: 4000, pos: 0, loop_info: Some(li) };
        let reference = ToneSource { rate: 1000, channels: 1, len: 4000, pos: 0, loop_info: None };
        let mut st = LoopStage::new(Box::new(tone), settings);
        // intro 1000 + 2 * 2000 body + 1000 fade
        assert_eq!(st.duration(), Some(6000));
        let out = read_all(&mut st);
        assert_eq!(out.len(), 6000);
        // Second pass of the body is identical to the first (sample-accurate wrap).
        for i in 0..2000u64 {
            assert_eq!(out[(1000 + i) as usize], reference.sample(1000 + i, 0));
            assert_eq!(out[(3000 + i) as usize], reference.sample(1000 + i, 0));
        }
        // Fade: starts at unity, ends near silence.
        assert!((out[5000] - reference.sample(1000, 0)).abs() < 1e-6);
        assert!(out[5999].abs() < 0.01);
    }

    /// Endless emulator-like source: a tone that never ends, with a play-time hint.
    struct Forever {
        pos: u64,
        hint: LengthHint,
        mask: u64,
    }
    impl AudioSource for Forever {
        fn sample_rate(&self) -> u32 {
            1000
        }
        fn channels(&self) -> usize {
            1
        }
        fn read(&mut self, out: &mut [f32]) -> Result<usize, SourceError> {
            for (i, o) in out.iter_mut().enumerate() {
                *o = if self.mask & 1 != 0 { 0.0 } else { (((self.pos + i as u64) % 7) as f32 + 1.0) * 0.1 };
            }
            self.pos += out.len() as u64;
            Ok(out.len())
        }
        fn seek(&mut self, frame: u64) -> Result<u64, SourceError> {
            self.pos = frame;
            Ok(frame)
        }
        fn duration(&self) -> Option<u64> {
            None
        }
        fn length_hint(&self) -> Option<LengthHint> {
            Some(self.hint)
        }
        fn meta(&self) -> SourceMeta {
            SourceMeta::default()
        }
        fn voice_count(&self) -> usize {
            1
        }
        fn set_voice_mask(&mut self, mask: u64) {
            self.mask = mask;
        }
    }

    #[test]
    fn length_hint_plays_then_fades_and_endless_continues() {
        let settings = Arc::new(LoopSettings::default());
        settings.set(LoopMode::Album, 2, 0.5); // engine fade 500 frames, used when the hint has none
        let mut st = LoopStage::new(Box::new(Forever { pos: 0, hint: LengthHint { length: 3000, fade: None }, mask: 0 }), settings.clone());
        assert_eq!(st.duration(), Some(3500));
        let out = read_all(&mut st);
        assert_eq!(out.len(), 3500);
        assert!((out[2999] - ((2999 % 7) as f32 + 1.0) * 0.1).abs() < 1e-6, "unfaded before the fade window");
        assert!(out[3499].abs() < 0.01);
        // The file's own fade wins over the engine's.
        let mut st = LoopStage::new(Box::new(Forever { pos: 0, hint: LengthHint { length: 1000, fade: Some(0) }, mask: 0 }), settings.clone());
        assert_eq!(read_all(&mut st).len(), 1000);
        // Seeking past the end ends; Endless never ends.
        assert_eq!(st.seek(5000).unwrap(), 1000);
        settings.set(LoopMode::Endless, 2, 0.5);
        let mut st = LoopStage::new(Box::new(Forever { pos: 0, hint: LengthHint { length: 1000, fade: Some(0) }, mask: 0 }), settings.clone());
        assert_eq!(st.duration(), None);
        let mut buf = vec![0.0; 777];
        for _ in 0..100 {
            assert_eq!(st.read(&mut buf).unwrap(), 777);
        }
        // Voice mask applies live.
        settings.set_voice_mask(1);
        st.read(&mut buf).unwrap();
        assert!(buf.iter().all(|&v| v == 0.0));
        settings.set_voice_mask(0);
        st.read(&mut buf).unwrap();
        assert!(buf.iter().any(|&v| v != 0.0));
    }

    #[test]
    fn endless_never_ends_and_seek_maps_into_body() {
        let settings = Arc::new(LoopSettings::default());
        settings.set(LoopMode::Endless, 2, 10.0);
        let li = LoopInfo { start: 100, end: 300 };
        let tone = ToneSource { rate: 1000, channels: 2, len: 400, pos: 0, loop_info: Some(li) };
        let reference = ToneSource { rate: 1000, channels: 2, len: 400, pos: 0, loop_info: None };
        let mut st = LoopStage::new(Box::new(tone), settings);
        assert_eq!(st.duration(), None);
        let mut buf = vec![0.0; 2 * 1000];
        for _ in 0..20 {
            assert_eq!(st.read(&mut buf).unwrap(), 1000);
        }
        // Unrolled 10_050 → body offset (10_050 - 100) % 200 = 150 → source frame 250.
        assert_eq!(st.seek(10_050).unwrap(), 10_050);
        let mut one = [0.0f32; 2];
        st.read(&mut one).unwrap();
        assert_eq!(one[0], reference.sample(250, 0));
    }
}
