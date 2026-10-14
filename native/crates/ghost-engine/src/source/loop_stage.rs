//! Loop stage: applies the engine [`LoopMode`] to sources that report loop points.
//!
//! The stage presents an "unrolled" timeline: intro, then the loop body repeated, then (for
//! Album/Custom) one more pass through the body while fading out over `fade_sec`. Seeking maps
//! unrolled positions back to source positions. Sources without loop points pass through
//! untouched. Settings are read live from [`LoopSettings`], so `set_loop` affects playing tracks.

use std::sync::atomic::{AtomicU32, AtomicU8, Ordering};

use super::{AudioSource, LoopInfo, SourceError, SourceMeta};
use crate::LoopMode;

/// Live loop settings shared with the controller.
pub struct LoopSettings {
    mode: AtomicU8,
    count: AtomicU32,
    fade_bits: AtomicU32,
}

impl Default for LoopSettings {
    fn default() -> Self {
        Self { mode: AtomicU8::new(0), count: AtomicU32::new(2), fade_bits: AtomicU32::new(10.0f32.to_bits()) }
    }
}

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
    /// Frames emitted on the unrolled timeline.
    pos: u64,
    /// Position inside the source.
    src_pos: u64,
    ended: bool,
}

impl LoopStage {
    pub fn new(inner: Box<dyn AudioSource>, settings: std::sync::Arc<LoopSettings>) -> Self {
        let info = inner.loop_info().filter(|l| l.end > l.start && l.end <= inner.duration().unwrap_or(u64::MAX));
        Self { inner, settings, info, pos: 0, src_pos: 0, ended: false }
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
        let Some(l) = self.info else {
            let n = self.inner.read(out)?;
            self.pos += n as u64;
            return Ok(n);
        };
        if self.ended {
            return Ok(0);
        }
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
                for i in 0..got {
                    let p = self.pos + i as u64;
                    if p >= fs {
                        let t = (p - fs) as f32 / fl.max(1) as f32;
                        let g = 0.5 + 0.5 * (std::f32::consts::PI * t.min(1.0)).cos();
                        for s in &mut out[(done + i) * ch..(done + i + 1) * ch] {
                            *s *= g;
                        }
                    }
                }
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
        match self.info {
            None => self.inner.duration(),
            Some(l) => self.fade_window(l).map(|(fs, fl)| fs + fl),
        }
    }

    fn loop_info(&self) -> Option<LoopInfo> {
        self.info
    }

    fn meta(&self) -> SourceMeta {
        self.inner.meta()
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
