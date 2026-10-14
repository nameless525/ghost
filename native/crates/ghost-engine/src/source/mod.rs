//! Audio sources: anything that yields interleaved f32 frames at its own rate.
//!
//! # Extension point (chiptune / game-engine decoders)
//!
//! A new decoder (libgme, vgmstream, libopenmpt, ...) plugs in by implementing [`AudioSource`]
//! and adding a branch to [`open`] (typically keyed on `format_hint` or the file extension, e.g.
//! `"nsf" | "spc" | "vgz"`). Everything downstream is shared: the [`loop_stage::LoopStage`] applies
//! the engine's [`LoopMode`](crate::LoopMode) to any source that reports [`AudioSource::loop_info`],
//! then the decode worker downmixes to stereo, resamples to the device rate and feeds the mixer.
//! Requirements for implementors:
//! - `read` must be deterministic and must not return 0 frames until the stream has ended.
//! - `seek` must be sample-accurate when `loop_info` is reported (the loop stage seeks to
//!   `loop.start` on every wrap), and should return the frame actually reached.
//! - Sources run on a decode worker thread: blocking I/O is fine, but honour `cancel` promptly.

pub mod loop_stage;
pub mod symphonia_src;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::cache::CacheManager;
use crate::SourceSpec;

/// Loop points in frames at the source's own sample rate. `end` is exclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoopInfo {
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Debug, Default)]
pub struct SourceMeta {
    /// Short codec name, e.g. "mp3", "flac", "aac".
    pub codec: String,
    pub bitrate_kbps: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct SourceError {
    pub message: String,
}

impl SourceError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

impl std::fmt::Display for SourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// A decoded audio stream.
pub trait AudioSource: Send {
    fn sample_rate(&self) -> u32;
    fn channels(&self) -> usize;
    /// Fill `out` (interleaved, `channels()` per frame) with up to `out.len() / channels()` frames.
    /// Returns frames written; `Ok(0)` means end of stream.
    fn read(&mut self, out: &mut [f32]) -> Result<usize, SourceError>;
    /// Seek to `frame`; returns the frame actually reached.
    fn seek(&mut self, frame: u64) -> Result<u64, SourceError>;
    /// Total length in frames, if known.
    fn duration(&self) -> Option<u64>;
    /// Loop region for formats that carry loop points.
    fn loop_info(&self) -> Option<LoopInfo> {
        None
    }
    fn meta(&self) -> SourceMeta;
}

/// Context for opening sources.
pub struct OpenCtx<'a> {
    pub cache: &'a Arc<CacheManager>,
    pub cancel: Arc<AtomicBool>,
    /// Prefer sample-accurate seeking even if it means reading from the start of the stream.
    pub accurate_seek: bool,
}

/// Open a source for `spec`. Add new decoder families here (see module docs).
pub fn open(spec: &SourceSpec, ctx: &OpenCtx<'_>) -> Result<Box<dyn AudioSource>, SourceError> {
    Ok(Box::new(symphonia_src::SymphoniaSource::open(spec, ctx)?))
}

/// Convert interleaved `channels`-channel audio to interleaved stereo, appending to `out`.
pub fn to_stereo(input: &[f32], channels: usize, out: &mut Vec<f32>) {
    match channels {
        0 => {}
        1 => {
            out.reserve(input.len() * 2);
            for &s in input {
                out.push(s);
                out.push(s);
            }
        }
        2 => out.extend_from_slice(input),
        n => {
            // ITU-style downmix for common layouts (L R C LFE Ls Rs [Lb Rb]); extra channels are
            // folded in at -3 dB. Normalised so a full-scale correlated signal stays <= 1.
            const C: f32 = std::f32::consts::FRAC_1_SQRT_2;
            let norm = 1.0 / (1.0 + C + C * ((n.saturating_sub(4)) as f32 / 2.0).max(0.0));
            out.reserve(input.len() / n * 2);
            for f in input.chunks_exact(n) {
                let mut l = f[0];
                let mut r = f[1];
                if n >= 3 {
                    l += C * f[2];
                    r += C * f[2];
                }
                // f[3] is LFE: dropped.
                for (i, &s) in f.iter().enumerate().skip(4) {
                    if i % 2 == 0 {
                        l += C * s;
                    } else {
                        r += C * s;
                    }
                }
                out.push(l * norm);
                out.push(r * norm);
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod test_util {
    use super::*;

    /// Deterministic synthetic source for tests: a ramp/sine with optional loop points.
    pub struct ToneSource {
        pub rate: u32,
        pub channels: usize,
        pub len: u64,
        pub pos: u64,
        pub loop_info: Option<LoopInfo>,
    }

    impl ToneSource {
        pub fn sample(&self, frame: u64, ch: usize) -> f32 {
            ((frame as f32) * 0.001 + ch as f32).sin() * 0.5
        }
    }

    impl AudioSource for ToneSource {
        fn sample_rate(&self) -> u32 {
            self.rate
        }
        fn channels(&self) -> usize {
            self.channels
        }
        fn read(&mut self, out: &mut [f32]) -> Result<usize, SourceError> {
            let want = out.len() / self.channels;
            let n = want.min((self.len - self.pos) as usize);
            for i in 0..n {
                for c in 0..self.channels {
                    out[i * self.channels + c] = self.sample(self.pos + i as u64, c);
                }
            }
            self.pos += n as u64;
            Ok(n)
        }
        fn seek(&mut self, frame: u64) -> Result<u64, SourceError> {
            self.pos = frame.min(self.len);
            Ok(self.pos)
        }
        fn duration(&self) -> Option<u64> {
            Some(self.len)
        }
        fn loop_info(&self) -> Option<LoopInfo> {
            self.loop_info
        }
        fn meta(&self) -> SourceMeta {
            SourceMeta { codec: "tone".into(), bitrate_kbps: None }
        }
    }

    #[test]
    fn downmix_layouts() {
        let mut out = Vec::new();
        to_stereo(&[0.5, -0.5], 1, &mut out);
        assert_eq!(out, vec![0.5, 0.5, -0.5, -0.5]);
        out.clear();
        to_stereo(&[1.0, 1.0, 1.0, 1.0, 1.0, 1.0], 6, &mut out);
        assert!(out[0] <= 1.0 + 1e-6 && out[0] > 0.7);
    }
}
