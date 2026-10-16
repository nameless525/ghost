//! Clip stage: exposes only `[start, end)` of a source (one chapter of a full-OST video that is
//! cached once). Positions, seeks and the duration are relative to the clip start, so the rest
//! of the engine treats a clip like any other track. Consecutive clips of one file chain
//! gaplessly: the clip start is a sample-accurate seek and the end is cut exactly.

use super::{AudioSource, LengthHint, LoopInfo, SourceError, SourceMeta};
use crate::util::ms_to_frames;

pub struct ClipStage {
    inner: Box<dyn AudioSource>,
    start: u64,
    end: Option<u64>,
    /// Frames into the clip.
    pos: u64,
    ended: bool,
}

impl ClipStage {
    pub fn new(mut inner: Box<dyn AudioSource>, start_ms: u64, end_ms: Option<u64>) -> Result<Self, SourceError> {
        let rate = inner.sample_rate().max(1);
        let start = ms_to_frames(start_ms as f64, rate);
        let end = end_ms.map(|e| ms_to_frames(e as f64, rate));
        if end.is_some_and(|e| e <= start) {
            return Err(SourceError::new(format!("empty clip ({start_ms} ms .. {} ms)", end_ms.unwrap_or(0))));
        }
        if inner.duration().is_some_and(|d| d > 0 && start >= d) {
            return Err(SourceError::new(format!("clip starts at {start_ms} ms, past the end of the stream")));
        }
        let reached = if start > 0 { inner.seek(start)? } else { 0 };
        Ok(Self { inner, start, end, pos: reached.saturating_sub(start), ended: false })
    }

    fn remaining(&self) -> Option<u64> {
        self.end.map(|e| (e - self.start).saturating_sub(self.pos))
    }
}

impl AudioSource for ClipStage {
    fn sample_rate(&self) -> u32 {
        self.inner.sample_rate()
    }
    fn channels(&self) -> usize {
        self.inner.channels()
    }
    fn channel_mask(&self) -> Option<u32> {
        self.inner.channel_mask()
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, SourceError> {
        if self.ended {
            return Ok(0);
        }
        let ch = self.inner.channels().max(1);
        let mut want = out.len() / ch;
        if let Some(r) = self.remaining() {
            want = want.min(r as usize);
        }
        if want == 0 {
            self.ended = true;
            return Ok(0);
        }
        let n = self.inner.read(&mut out[..want * ch])?;
        if n == 0 {
            self.ended = true;
        }
        self.pos += n as u64;
        Ok(n)
    }

    fn seek(&mut self, frame: u64) -> Result<u64, SourceError> {
        if let Some(e) = self.end {
            if self.start + frame >= e {
                self.pos = e - self.start;
                self.ended = true;
                return Ok(self.pos);
            }
        }
        let reached = self.inner.seek(self.start + frame)?;
        self.pos = reached.saturating_sub(self.start);
        self.ended = false;
        Ok(self.pos)
    }

    fn duration(&self) -> Option<u64> {
        match (self.end, self.inner.duration()) {
            (Some(e), Some(d)) => Some(e.min(d).saturating_sub(self.start)),
            (Some(e), None) => Some(e - self.start),
            (None, Some(d)) => Some(d.saturating_sub(self.start)),
            (None, None) => None,
        }
    }

    /// A bounded clip is a plain finite stream; an open-ended one keeps the source's loop (when
    /// the loop lies inside the clip) or play-time hint, shifted.
    fn loop_info(&self) -> Option<LoopInfo> {
        if self.end.is_some() {
            return None;
        }
        self.inner.loop_info().filter(|l| l.start >= self.start).map(|l| LoopInfo { start: l.start - self.start, end: l.end - self.start })
    }

    fn length_hint(&self) -> Option<LengthHint> {
        if self.end.is_some() {
            return None;
        }
        self.inner.length_hint().map(|h| LengthHint { length: h.length.saturating_sub(self.start), fade: h.fade })
    }

    fn meta(&self) -> SourceMeta {
        self.inner.meta()
    }
    fn voice_count(&self) -> usize {
        self.inner.voice_count()
    }
    fn set_voice_mask(&mut self, mask: u64) {
        self.inner.set_voice_mask(mask)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::test_util::ToneSource;

    fn tone(len: u64) -> Box<dyn AudioSource> {
        Box::new(ToneSource { rate: 1000, channels: 2, len, pos: 0, loop_info: None })
    }

    #[test]
    fn clip_reads_exact_range_and_seeks_relative() {
        let reference = ToneSource { rate: 1000, channels: 2, len: 10_000, pos: 0, loop_info: None };
        let mut c = ClipStage::new(tone(10_000), 2_000, Some(5_500)).unwrap();
        assert_eq!(c.duration(), Some(3_500));
        let mut buf = vec![0.0; 2 * 1000];
        let mut got = Vec::new();
        loop {
            let n = c.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            got.extend_from_slice(&buf[..n * 2]);
        }
        assert_eq!(got.len(), 3_500 * 2);
        assert_eq!(got[0], reference.sample(2_000, 0));
        assert_eq!(got[got.len() - 1], reference.sample(5_499, 1));
        assert_eq!(c.seek(1_000).unwrap(), 1_000);
        let mut one = [0.0f32; 2];
        c.read(&mut one).unwrap();
        assert_eq!(one[0], reference.sample(3_000, 0));
        assert_eq!(c.seek(4_000).unwrap(), 3_500);
        assert_eq!(c.read(&mut one).unwrap(), 0);
    }

    #[test]
    fn open_ended_clip_and_bad_ranges() {
        let c = ClipStage::new(tone(10_000), 9_000, None).unwrap();
        assert_eq!(c.duration(), Some(1_000));
        assert!(ClipStage::new(tone(10_000), 3_000, Some(3_000)).is_err());
        assert!(ClipStage::new(tone(10_000), 12_000, None).is_err());
        // End past the stream: duration clamps to the stream.
        let c = ClipStage::new(tone(10_000), 8_000, Some(20_000)).unwrap();
        assert_eq!(c.duration(), Some(2_000));
    }
}
