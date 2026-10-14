//! GHOST audio engine: streaming cache, decoders, gapless mixer, DSP and output.
//!
//! The public API in this file is a contract with `ghost-node` (napi bindings) and
//! `ghost-cli`. Keep signatures stable; extend additively. Internals live in submodules.
//!
//! Module map (data flows top to bottom):
//! - `engine`: controller thread. Owns the output, creates voices, runs the state machine and
//!   turns everything into `EngineEvent`s. `Engine` methods just send it commands.
//! - `cache` (+ `http`): sparse on-disk Range cache with a blocking `Read + Seek` reader.
//! - `source`: the `AudioSource` trait (extension point for chiptune decoders), the symphonia
//!   source and the loop stage.
//! - `decode` (+ `resample`): decode workers that fill each voice's SPSC ring at the device rate.
//!   Gapless next tracks are decoded as continuations through the same resampler.
//! - `voice`: ring and shared state between a worker, the mixer and the controller.
//! - `mixer` (+ `dsp`): the real-time mixer (gapless/crossfade, fades, gain, preview bus, duck,
//!   overlay low-pass, volume, limiter).
//! - `output`: cpal device streams and the offline null sink.
//! - `clock`: audible-time segments published by the mixer, used for `position`.
//! - `analysis_tap`: real-time analysis aligned to audible time.
//! - `jobs`, `download`: background analysis and downloads with tagging.

use std::path::PathBuf;

pub use ghost_analysis::{offline::OfflineAnalysis, AnalysisFrame};

pub(crate) mod analysis_tap;
pub mod cache;
pub(crate) mod clock;
pub(crate) mod decode;
pub(crate) mod download;
pub mod dsp;
pub(crate) mod engine;
pub(crate) mod http;
pub(crate) mod jobs;
pub(crate) mod mixer;
pub(crate) mod output;
pub(crate) mod resample;
pub mod source;
pub mod util;
pub(crate) mod voice;
pub mod wav;

pub use source::{AudioSource, LoopInfo};

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

/// Offline (null sink) output: renders the same mixer as fast as decoding allows, with no audio
/// device. Used by `ghost-cli render` and tests.
#[derive(Clone, Copy, Debug)]
pub struct OfflineConfig {
    pub sample_rate: u32,
    /// Frames per rendered block.
    pub block_frames: usize,
}

impl Default for OfflineConfig {
    fn default() -> Self {
        Self { sample_rate: 48_000, block_frames: 512 }
    }
}

/// Receives interleaved stereo f32 blocks from an offline engine. Blocks only flow while
/// something is playing; the limiter's look-ahead delay is already compensated.
pub struct OfflineSink {
    pub sample_rate: u32,
    pub blocks: crossbeam_channel::Receiver<Vec<f32>>,
}

/// Output diagnostics.
#[derive(Clone, Debug, Default)]
pub struct OutputInfo {
    pub device_name: String,
    pub sample_rate: u32,
    /// Device output latency reported by the host (callback → DAC), ms.
    pub device_latency_ms: f64,
    /// Latency added by the engine itself (limiter look-ahead), ms.
    pub engine_latency_ms: f64,
}

pub use cache::CacheStats;

/// Enumerate output devices without starting an engine.
pub fn list_output_devices() -> Vec<DeviceInfo> {
    output::list_devices()
}

struct EngineInner {
    cmd_tx: crossbeam_channel::Sender<engine::Cmd>,
    shared: std::sync::Arc<engine::Shared>,
    cache: std::sync::Arc<cache::CacheManager>,
    jobs: std::sync::Arc<jobs::JobPool>,
    downloads: download::Downloads,
    loops: std::sync::Arc<source::loop_stage::LoopSettings>,
    analyze_cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    shut: std::sync::atomic::AtomicBool,
}

/// Thread-safe handle; all methods return immediately (work happens on engine threads).
pub struct Engine {
    events_rx: crossbeam_channel::Receiver<EngineEvent>,
    _events_tx: crossbeam_channel::Sender<EngineEvent>,
    inner: std::sync::Arc<EngineInner>,
}

impl Engine {
    pub fn new(config: EngineConfig) -> Result<Engine, EngineError> {
        Self::start(config, engine::OutputMode::Device)
    }

    /// Engine rendering into an offline null sink instead of an audio device.
    pub fn new_offline(config: EngineConfig, offline: OfflineConfig) -> Result<(Engine, OfflineSink), EngineError> {
        let (tx, rx) = crossbeam_channel::unbounded();
        let rate = offline.sample_rate.clamp(8_000, 384_000);
        let e = Self::start(config, engine::OutputMode::Offline { rate, block: offline.block_frames, sink: tx })?;
        Ok((e, OfflineSink { sample_rate: rate, blocks: rx }))
    }

    fn start(config: EngineConfig, mode: engine::OutputMode) -> Result<Engine, EngineError> {
        use std::sync::Arc;
        let cache = cache::CacheManager::new(config.cache_dir.clone(), config.cache_max_bytes, &config.user_agent)
            .map_err(|e| EngineError(e.to_string()))?;
        let (events_tx, events_rx) = crossbeam_channel::unbounded();
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded();
        let (tap_tx, tap_rx) = crossbeam_channel::unbounded();
        let shared = Arc::new(engine::Shared::new());
        let jobs = Arc::new(jobs::JobPool::new(2));
        let loops = Arc::new(source::loop_stage::LoopSettings::default());
        analysis_tap::spawn(shared.analysis.clone(), shared.clock.clone(), tap_rx);
        let ctl = engine::Controller::new(engine::ControllerInit {
            cache: cache.clone(),
            events: events_tx.clone(),
            shared: shared.clone(),
            cmd_rx,
            jobs: jobs.clone(),
            loops: loops.clone(),
            tap_tx,
            mode,
        });
        util::spawn_named("ghost-engine", move || ctl.run());
        let inner = Arc::new(EngineInner {
            cmd_tx,
            shared,
            cache,
            jobs,
            downloads: download::Downloads::default(),
            loops,
            analyze_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            shut: std::sync::atomic::AtomicBool::new(false),
        });
        Ok(Engine { events_rx, _events_tx: events_tx, inner })
    }

    fn cmd(&self, c: engine::Cmd) {
        let _ = self.inner.cmd_tx.send(c);
    }

    /// Receiver for engine events (clone it; one consumer recommended).
    pub fn events(&self) -> crossbeam_channel::Receiver<EngineEvent> {
        self.events_rx.clone()
    }

    pub fn set_current(&self, track: TrackLoad, start_ms: u64, autoplay: bool) {
        self.cmd(engine::Cmd::SetCurrent { track, start_ms, autoplay });
    }
    pub fn set_next(&self, track: Option<TrackLoad>) {
        self.cmd(engine::Cmd::SetNext(track));
    }
    pub fn play(&self) {
        self.cmd(engine::Cmd::Play);
    }
    pub fn pause(&self) {
        self.cmd(engine::Cmd::Pause);
    }
    pub fn stop(&self) {
        self.cmd(engine::Cmd::Stop);
    }
    pub fn seek(&self, ms: u64) {
        self.cmd(engine::Cmd::Seek(ms));
    }
    pub fn set_volume_db(&self, db: f32) {
        self.cmd(engine::Cmd::Volume(db));
    }
    pub fn set_muted(&self, muted: bool) {
        self.cmd(engine::Cmd::Muted(muted));
    }
    /// Applies live to playing tracks that carry loop points.
    pub fn set_loop(&self, mode: LoopMode, count: u32, fade_sec: f32) {
        self.inner.loops.set(mode, count, fade_sec);
    }
    pub fn set_normalization(&self, enabled: bool, target_lufs: f32, mode: NormalizationMode) {
        self.cmd(engine::Cmd::Normalization { enabled, target: target_lufs, mode });
    }
    pub fn set_gapless(&self, enabled: bool) {
        self.cmd(engine::Cmd::Gapless(enabled));
    }
    pub fn set_crossfade(&self, sec: f32) {
        self.cmd(engine::Cmd::Crossfade(sec));
    }
    pub fn set_overlay_filter(&self, active: bool) {
        self.cmd(engine::Cmd::Overlay(active));
    }
    pub fn preview(&self, track: TrackLoad, start_ms: u64) {
        self.cmd(engine::Cmd::Preview { track, start_ms });
    }
    pub fn stop_preview(&self) {
        self.cmd(engine::Cmd::StopPreview);
    }

    pub fn position(&self) -> PositionInfo {
        self.inner.shared.position()
    }

    /// Copy the latest real-time analysis frame (audible-time aligned). Returns false if none.
    pub fn analysis_frame(&self, out: &mut AnalysisFrame) -> bool {
        self.inner.shared.analysis.frame_now(out)
    }

    pub fn list_devices(&self) -> Vec<DeviceInfo> {
        let cached = self.inner.shared.devices.lock().clone();
        if cached.is_empty() {
            output::list_devices()
        } else {
            cached
        }
    }
    pub fn set_device(&self, id: Option<String>) {
        self.cmd(engine::Cmd::SetDevice(id));
    }

    /// Decode the whole (cached) source in the background; emits `EngineEvent::Analysis`.
    pub fn analyze(&self, id: String, source: SourceSpec) {
        let (cache, events, cancel) = (self.inner.cache.clone(), self._events_tx.clone(), self.inner.analyze_cancel.clone());
        self.inner.jobs.submit(move || jobs::analyze_job(id, source, cache, events, None, cancel));
    }

    /// Copy/fetch the source to `dest`, tag it, emit `EngineEvent::Download` progress.
    pub fn download(&self, download_id: String, source: SourceSpec, dest: PathBuf, tags: TagInfo) {
        self.inner.downloads.start(download_id, source, dest, tags, self.inner.cache.clone(), self._events_tx.clone());
    }
    pub fn cancel_download(&self, download_id: &str) {
        self.inner.downloads.cancel(download_id);
    }

    /// Stream cache statistics.
    pub fn cache_stats(&self) -> CacheStats {
        self.inner.cache.stats()
    }

    /// Delete every cached stream that isn't currently open.
    pub fn clear_cache(&self) {
        self.inner.cache.clear();
    }

    /// Output sample rate and latency figures.
    pub fn output_info(&self) -> OutputInfo {
        let rate = self.inner.shared.rate.load(std::sync::atomic::Ordering::Relaxed);
        let lim = dsp::limiter::Limiter::new(rate.max(1), mixer::LIMITER_CEILING_DB, mixer::LIMITER_LOOKAHEAD_MS).latency();
        OutputInfo {
            device_name: self.inner.shared.device_name.lock().clone(),
            sample_rate: rate,
            device_latency_ms: self.inner.shared.clock.latency_us.load(std::sync::atomic::Ordering::Relaxed) as f64 / 1000.0,
            engine_latency_ms: if rate > 0 { lim as f64 * 1000.0 / rate as f64 } else { 0.0 },
        }
    }

    pub fn shutdown(&self) {
        if !self.inner.shut.swap(true, std::sync::atomic::Ordering::SeqCst) {
            self.inner.analyze_cancel.store(true, std::sync::atomic::Ordering::Relaxed);
            self.cmd(engine::Cmd::Shutdown);
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.shutdown();
    }
}
