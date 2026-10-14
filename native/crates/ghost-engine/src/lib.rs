//! GHOST audio engine: streaming cache, decoders, gapless mixer, DSP and output.
//!
//! The public API in this file is a contract with `ghost-node` (napi bindings) and
//! `ghost-cli`. Keep signatures stable; extend additively. Internals live in submodules.

use std::path::PathBuf;

pub use ghost_analysis::{offline::OfflineAnalysis, AnalysisFrame};

#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub cache_dir: PathBuf,
    pub cache_max_bytes: u64,
    pub user_agent: String,
}

#[derive(Clone, Debug)]
pub enum SourceSpec {
    Http { url: String, headers: Vec<(String, String)>, cache_key: String, format_hint: Option<String> },
    File { path: PathBuf, format_hint: Option<String> },
}

#[derive(Clone, Debug)]
pub struct TrackLoad {
    /// Opaque id chosen by the caller (queue item uid).
    pub id: String,
    pub source: SourceSpec,
    pub lufs: Option<f32>,
    pub album_lufs: Option<f32>,
    pub album_key: Option<String>,
    pub expected_duration_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopMode {
    /// Loop `count` times then fade (rip convention, default count=2).
    Album,
    Endless,
    Custom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NormalizationMode {
    Auto,
    Track,
    Album,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaybackState {
    Idle,
    Loading,
    Playing,
    Paused,
    Buffering,
}

#[derive(Clone, Debug)]
pub struct TrackInfo {
    pub id: String,
    pub duration_ms: Option<u64>,
    pub sample_rate: u32,
    pub channels: u16,
    pub codec: String,
    pub bitrate_kbps: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Clone, Debug, Default)]
pub struct TagInfo {
    pub title: String,
    pub album: String,
    pub album_artist: Option<String>,
    pub artist: Option<String>,
    pub composer: Option<String>,
    pub track_number: Option<u32>,
    pub track_total: Option<u32>,
    pub disc_number: Option<u32>,
    pub year: Option<u32>,
    pub genre: Option<String>,
    pub comment: Option<String>,
    pub cover_url: Option<String>,
    pub replay_gain_track_db: Option<f32>,
    pub replay_gain_track_peak: Option<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DownloadStatus {
    Progress,
    Done,
    Error,
    Canceled,
}

#[derive(Clone, Debug)]
pub enum EngineEvent {
    State { state: PlaybackState, id: Option<String> },
    /// Moved gaplessly into the preloaded `next` track.
    Advanced { id: String },
    /// Current track finished and there was no `next`.
    Ended { id: String },
    TrackInfo(TrackInfo),
    Buffering { id: String, buffering: bool },
    Error { id: Option<String>, message: String, recoverable: bool },
    Analysis { id: String, cache_key: Option<String>, result: OfflineAnalysis },
    CacheComplete { id: String, cache_key: String, path: PathBuf, bytes: u64 },
    Download { download_id: String, status: DownloadStatus, bytes: u64, total_bytes: Option<u64>, path: Option<PathBuf>, error: Option<String> },
    Devices(Vec<DeviceInfo>),
    PreviewEnded,
}

#[derive(Clone, Debug)]
pub struct PositionInfo {
    pub id: Option<String>,
    /// Audible (latency-compensated) position.
    pub position_ms: f64,
    pub duration_ms: Option<u64>,
    pub playing: bool,
    /// Epoch milliseconds when sampled.
    pub at_epoch_ms: f64,
}

#[derive(Debug)]
pub struct EngineError(pub String);
impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for EngineError {}

/// Thread-safe handle; all methods return immediately (work happens on engine threads).
pub struct Engine {
    events_rx: crossbeam_channel::Receiver<EngineEvent>,
    _events_tx: crossbeam_channel::Sender<EngineEvent>,
}

impl Engine {
    pub fn new(_config: EngineConfig) -> Result<Engine, EngineError> {
        let (tx, rx) = crossbeam_channel::unbounded();
        Ok(Engine { events_rx: rx, _events_tx: tx })
    }

    /// Receiver for engine events (clone it; one consumer recommended).
    pub fn events(&self) -> crossbeam_channel::Receiver<EngineEvent> {
        self.events_rx.clone()
    }

    pub fn set_current(&self, _track: TrackLoad, _start_ms: u64, _autoplay: bool) {}
    pub fn set_next(&self, _track: Option<TrackLoad>) {}
    pub fn play(&self) {}
    pub fn pause(&self) {}
    pub fn stop(&self) {}
    pub fn seek(&self, _ms: u64) {}
    pub fn set_volume_db(&self, _db: f32) {}
    pub fn set_muted(&self, _muted: bool) {}
    pub fn set_loop(&self, _mode: LoopMode, _count: u32, _fade_sec: f32) {}
    pub fn set_normalization(&self, _enabled: bool, _target_lufs: f32, _mode: NormalizationMode) {}
    pub fn set_gapless(&self, _enabled: bool) {}
    pub fn set_crossfade(&self, _sec: f32) {}
    pub fn set_overlay_filter(&self, _active: bool) {}
    pub fn preview(&self, _track: TrackLoad, _start_ms: u64) {}
    pub fn stop_preview(&self) {}

    pub fn position(&self) -> PositionInfo {
        PositionInfo { id: None, position_ms: 0.0, duration_ms: None, playing: false, at_epoch_ms: 0.0 }
    }

    /// Copy the latest real-time analysis frame (audible-time aligned). Returns false if none.
    pub fn analysis_frame(&self, _out: &mut AnalysisFrame) -> bool {
        false
    }

    pub fn list_devices(&self) -> Vec<DeviceInfo> {
        Vec::new()
    }
    pub fn set_device(&self, _id: Option<String>) {}

    /// Decode the whole (cached) source in the background; emits `EngineEvent::Analysis`.
    pub fn analyze(&self, _id: String, _source: SourceSpec) {}

    /// Copy/fetch the source to `dest`, tag it, emit `EngineEvent::Download` progress.
    pub fn download(&self, _download_id: String, _source: SourceSpec, _dest: PathBuf, _tags: TagInfo) {}
    pub fn cancel_download(&self, _download_id: &str) {}

    pub fn shutdown(&self) {}
}
