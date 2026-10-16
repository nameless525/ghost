//! The decoder interface shared by every audio source in GHOST.
//!
//! It lives here (and is re-exported by `ghost_engine::source`) so the decoders in this crate
//! implement the very trait the engine consumes, without a dependency cycle.
//!
//! Requirements for implementors:
//! - `read` must be deterministic and must not return 0 frames until the stream has ended.
//! - `seek` must be sample-accurate when `loop_info` is reported (the engine's loop stage seeks to
//!   `loop.start` on every wrap), and should return the frame actually reached.
//! - Sources run on a decode worker thread: blocking I/O is fine, but honour cancellation promptly.

/// Loop points in frames at the source's own sample rate. `end` is exclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoopInfo {
    pub start: u64,
    pub end: u64,
}

/// For sources that would play forever but carry no loop points (emulated chip music with a
/// known or default play time): play `length` frames, then fade out over `fade` frames (the
/// engine's fade setting when `None`). Ignored in Endless mode, where the source just keeps going.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LengthHint {
    pub length: u64,
    pub fade: Option<u64>,
}

#[derive(Clone, Debug, Default)]
pub struct SourceMeta {
    /// Short codec name, e.g. "mp3", "flac", "aac", "nsf", "adx".
    pub codec: String,
    pub bitrate_kbps: Option<u32>,
    /// Song title from the file (chip formats carry one per subsong).
    pub title: Option<String>,
    /// Author / composer.
    pub artist: Option<String>,
    /// Game (album) name.
    pub album: Option<String>,
    /// Sound hardware, e.g. "Nintendo NES", "Super Nintendo".
    pub system: Option<String>,
    pub copyright: Option<String>,
    pub comment: Option<String>,
    /// Number of sub-songs in the file, for multi-song formats.
    pub subsong_count: Option<u32>,
    /// Selected sub-song (0-based).
    pub subsong: Option<u32>,
    /// Names of the voices that can be muted with [`AudioSource::set_voice_mask`] (empty when the
    /// format doesn't support muting).
    pub voice_names: Vec<String>,
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

impl std::error::Error for SourceError {}

/// A decoded audio stream.
pub trait AudioSource: Send {
    fn sample_rate(&self) -> u32;
    fn channels(&self) -> usize;
    /// Speaker positions of the channels as a WAVE (`WAVEFORMATEXTENSIBLE`) channel mask: one bit
    /// per channel, channels in ascending bit order (bit 0 front left, 1 front right, 2 front
    /// centre, 3 LFE, 4/5 back left/right, 9/10 side left/right, ...). `None` when unknown: the
    /// downmix then assumes the usual layout for the channel count.
    fn channel_mask(&self) -> Option<u32> {
        None
    }
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
    /// Play time for endless sources without loop points (see [`LengthHint`]).
    fn length_hint(&self) -> Option<LengthHint> {
        None
    }
    fn meta(&self) -> SourceMeta;
    /// Number of mutable voices (chip channels / tracker channels); 0 if unsupported.
    fn voice_count(&self) -> usize {
        0
    }
    /// Mute voices: bit `i` set mutes voice `i`. No-op for sources without voices.
    fn set_voice_mask(&mut self, _mask: u64) {}
}
