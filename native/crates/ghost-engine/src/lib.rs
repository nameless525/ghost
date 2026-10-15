//! GHOST audio engine: streaming cache, decoders, gapless mixer, DSP and output.
//!
//! The public API in this file is a contract with `ghost-node` (napi bindings) and
//! `ghost-cli`. Keep signatures stable; extend additively. Internals live in submodules.
//!
//! Module map (data flows top to bottom):
//! - `engine`: controller thread. Owns the output, creates voices, runs the state machine and
//!   turns everything into `EngineEvent`s. `Engine` methods just send it commands.
//! - `cache` (+ `http`): sparse on-disk Range cache with a blocking `Read + Seek` reader.
//! - `source`: the `AudioSource` trait (re-exported from `ghost-formats`), source opening
//!   (symphonia, or the libgme / vgmstream / libopenmpt decoders in `ghost-formats`, archive
//!   entries, clip ranges) and the loop stage.
//! - `decode` (+ `resample`): decode workers that fill each voice's SPSC ring at the device rate.
//!   Gapless next tracks are decoded as continuations through the same resampler.
//! - `voice`: ring and shared state between a worker, the mixer and the controller.
//! - `mixer` (+ `dsp`): the real-time mixer (gapless/crossfade, fades, gain, preview bus, duck,
//!   overlay low-pass, volume, limiter).
//! - `output`: cpal device streams and the offline null sink.
//! - `clock`: audible-time segments published by the mixer, used for `position`.
//! - `analysis_tap`: real-time analysis aligned to audible time.
//! - `jobs`, `download` (+ `flac`): background analysis; downloads with tagging, rendering chip /
//!   clip sources to FLAC.

use std::path::PathBuf;

pub use ghost_analysis::{offline::OfflineAnalysis, AnalysisFrame};

pub(crate) mod analysis_tap;
pub mod cache;
pub(crate) mod clock;
pub(crate) mod decode;
pub(crate) mod download;
pub mod dsp;
pub mod flac;
pub(crate) mod engine;
pub(crate) mod http;
pub(crate) mod jobs;
pub(crate) mod mixer;
pub(crate) mod output;
pub(crate) mod resample;
pub mod source;
pub mod stats;
pub mod util;
pub(crate) mod voice;
pub mod wav;

pub use source::{AudioSource, LengthHint, LoopInfo};

#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub cache_dir: PathBuf,
    pub cache_max_bytes: u64,
    pub user_agent: String,
}

/// Optional addressing inside a source, shared by both kinds (TS `EngineSourceExtras`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct SourceExtras {
    /// Play only `[clip_start_ms, clip_end_ms)` of the stream (e.g. one chapter of a full-OST
    /// video). Seeks, positions and durations are relative to the clip.
    pub clip_start_ms: Option<u64>,
    pub clip_end_ms: Option<u64>,
    /// 0-based sub-song for multi-song files (NSF, GBS, HES, KSS, FSB banks, modules, ...).
    pub subsong: Option<u32>,
    /// Path of the entry to play inside a `.zip` / `.7z` archive source.
    pub archive_entry: Option<String>,
}

impl SourceExtras {
    pub fn is_empty(&self) -> bool {
        *self == SourceExtras::default()
    }
    pub fn has_clip(&self) -> bool {
        self.clip_start_ms.is_some() || self.clip_end_ms.is_some()
    }
}

#[derive(Clone, Debug)]
pub enum SourceSpec {
    Http { url: String, headers: Vec<(String, String)>, cache_key: String, format_hint: Option<String>, extras: SourceExtras },
    File { path: PathBuf, format_hint: Option<String>, extras: SourceExtras },
}

impl SourceSpec {
    /// A local file, no hint, no extras.
    pub fn file(path: impl Into<PathBuf>) -> Self {
        SourceSpec::File { path: path.into(), format_hint: None, extras: SourceExtras::default() }
    }
    /// An HTTP source cached under `cache_key` (the URL itself when empty), no hint, no extras.
    pub fn http(url: impl Into<String>, cache_key: impl Into<String>) -> Self {
        let url = url.into();
        let key = cache_key.into();
        let cache_key = if key.is_empty() { url.clone() } else { key };
        SourceSpec::Http { url, headers: Vec::new(), cache_key, format_hint: None, extras: SourceExtras::default() }
    }
    pub fn with_extras(mut self, extras: SourceExtras) -> Self {
        *self.extras_mut() = extras;
        self
    }
    pub fn with_format_hint(mut self, hint: Option<String>) -> Self {
        match &mut self {
            SourceSpec::Http { format_hint, .. } | SourceSpec::File { format_hint, .. } => *format_hint = hint,
        }
        self
    }
    pub fn extras(&self) -> &SourceExtras {
        match self {
            SourceSpec::Http { extras, .. } | SourceSpec::File { extras, .. } => extras,
        }
    }
    pub fn extras_mut(&mut self) -> &mut SourceExtras {
        match self {
            SourceSpec::Http { extras, .. } | SourceSpec::File { extras, .. } => extras,
        }
    }
    pub fn format_hint(&self) -> Option<&str> {
        match self {
            SourceSpec::Http { format_hint, .. } | SourceSpec::File { format_hint, .. } => format_hint.as_deref(),
        }
    }
    /// The same stream without extras (what the cache / file system stores).
    pub fn base(&self) -> SourceSpec {
        self.clone().with_extras(SourceExtras::default())
    }
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

#[derive(Clone, Debug, Default)]
pub struct TrackInfo {
    pub id: String,
    /// Playback length with the current loop settings (clip length for clips); `None` when
    /// unknown or endless.
    pub duration_ms: Option<u64>,
    pub sample_rate: u32,
    pub channels: u16,
    pub codec: String,
    pub bitrate_kbps: Option<u32>,
    /// Tags from the file itself (chip / tracker formats).
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Sub-songs in the file and the one playing (0-based).
    pub subsong_count: Option<u32>,
    pub subsong: Option<u32>,
    /// Loop region in source time, when the format has loop points.
    pub loop_start_ms: Option<u64>,
    pub loop_end_ms: Option<u64>,
    /// Mutable voices (chip channels), see [`Engine::set_voice_mask`].
    pub voice_count: u32,
    pub voice_names: Vec<String>,
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

/// How `download_with` produces the file.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DownloadOptions {
    /// `Some(true)`: decode and render to FLAC (with the current loop settings; Endless renders as
    /// Album). `Some(false)`: save the stream as-is (for an archive entry: the entry's bytes).
    /// `None` (default): render chip / tracker / game-engine formats and clips, copy the rest.
    pub render_flac: Option<bool>,
}

/// A file inside an archive source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveEntryInfo {
    pub path: String,
    pub size: u64,
}

/// What `inspect_archive` found: every file, plus the text of the `.m3u` / `.txt` files
/// (NEZPlug playlists with per-track titles, lengths and loops).
#[derive(Clone, Debug, Default)]
pub struct ArchiveListing {
    pub entries: Vec<ArchiveEntryInfo>,
    pub playlists: Vec<(String, String)>,
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
    /// `id`: the preview's track id.
    PreviewEnded { id: String },
}

/// Which track [`Engine::load_progress`] reports on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
    Current = 0,
    Preview = 1,
}

/// What a track's start (or rebuffer) is waiting on, for honest progress bars; see
/// [`Engine::load_progress`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LoadProgress {
    /// Track id (`TrackLoad::id`).
    pub id: String,
    /// The track is producing audio (started, and not rebuffering).
    pub started: bool,
    /// The source answered: the HTTP response header is in (size / type known; for a cached
    /// entry reopened from disk, known from an earlier fetch). Always true for local files.
    pub connected: bool,
    /// Bytes of the source in the stream cache (for an archive entry: of the archive, which is
    /// what is fetched); for local files the file's size.
    pub bytes: u64,
    pub total_bytes: Option<u64>,
    /// The decoder can't start before the whole file is in (libgme / libopenmpt formats, archive
    /// entries), so `bytes / total_bytes` is the progress toward the first sound. Judged from the
    /// extension / hint (a chip file behind an unknown extension reads false).
    pub whole_file: bool,
    /// Decoded audio ready to play, and how much the voice waits for before it (re)starts: the
    /// prefill (200 ms) before the first sound, the rebuffer amount (750 ms) after running dry.
    /// Both 0 while `started` (the fill isn't tracked while audio flows).
    pub buffered_ms: u64,
    pub target_ms: u64,
    /// How long a reader has waited for bytes that haven't come (0 when none is waiting; any
    /// byte arriving restarts it), and when it gives up (a recoverable error: the player then
    /// tries another source).
    pub stalled_ms: u64,
    pub stall_timeout_ms: u64,
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
pub use stats::{StatsSnapshot, ThreadCpu};

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
        let crash_tx = events_tx.clone();
        util::spawn_named("ghost-engine", move || {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ctl.run())).is_err() {
                let _ = crash_tx.send(EngineEvent::Error { id: None, message: "audio engine crashed; restart GHOST".into(), recoverable: false });
            }
        });
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
        // NaN would slip past the mute threshold and `min(12.0)` and play at +12 dB.
        if db.is_finite() {
            self.cmd(engine::Cmd::Volume(db));
        }
    }
    pub fn set_muted(&self, muted: bool) {
        self.cmd(engine::Cmd::Muted(muted));
    }
    /// Applies live to playing tracks that carry loop points.
    pub fn set_loop(&self, mode: LoopMode, count: u32, fade_sec: f32) {
        self.inner.loops.set(mode, count, if fade_sec.is_finite() { fade_sec } else { 10.0 });
    }
    pub fn set_normalization(&self, enabled: bool, target_lufs: f32, mode: NormalizationMode) {
        // A NaN target would make every voice gain NaN (and poison the limiter state).
        let target = if target_lufs.is_finite() { target_lufs.clamp(-70.0, 0.0) } else { -16.0 };
        self.cmd(engine::Cmd::Normalization { enabled, target, mode });
    }
    pub fn set_gapless(&self, enabled: bool) {
        self.cmd(engine::Cmd::Gapless(enabled));
    }
    pub fn set_crossfade(&self, sec: f32) {
        self.cmd(engine::Cmd::Crossfade(if sec.is_finite() { sec } else { 0.0 }));
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

    /// What the current (or preview) track's start or rebuffer waits on; `None` when that slot is
    /// empty. Cheap (a few atomic loads and two briefly held locks, no I/O): meant to be polled a
    /// few times a second while the player waits.
    pub fn load_progress(&self, slot: Slot) -> Option<LoadProgress> {
        self.inner.shared.load_progress(slot, self.inner.cache.stall_timeout)
    }

    /// Bytes of `cache_key`'s stream in the cache and its size (if known), while its entry is
    /// open: being fetched or read (a playing track, an analysis, an `inspect_archive` or
    /// download in flight). `None` otherwise, including before the first read and after the
    /// last reader is done. Memory only (a map lookup and a few field reads).
    pub fn cache_progress(&self, cache_key: &str) -> Option<(u64, Option<u64>)> {
        self.inner.cache.progress(cache_key).map(|p| (p.bytes, p.total))
    }

    /// Copy the latest real-time analysis frame (audible-time aligned). Returns false if none.
    pub fn analysis_frame(&self, out: &mut AnalysisFrame) -> bool {
        self.inner.shared.analysis.frame_now(out)
    }

    /// Block until `analysis_frame` has frames again (audio is playing), `cancel` is set and
    /// `wake_analysis_waiters` is called, or `timeout` passes. Lets frame consumers sleep while
    /// nothing plays instead of polling. Returns whether frames are available.
    pub fn wait_analysis(&self, timeout: std::time::Duration, cancel: &std::sync::atomic::AtomicBool) -> bool {
        self.inner.shared.analysis.wait_active(timeout, cancel)
    }

    /// Wake all `wait_analysis` callers (after setting their cancel flag).
    pub fn wake_analysis_waiters(&self) {
        self.inner.shared.analysis.wake_all();
    }

    /// Output devices as last seen by the engine (kept current by change notifications / polling).
    /// Enumerates directly only before the engine's first look (that takes tens of ms).
    pub fn list_devices(&self) -> Vec<DeviceInfo> {
        if self.inner.shared.devices_polled.load(std::sync::atomic::Ordering::Acquire) {
            return self.inner.shared.devices.lock().clone();
        }
        output::list_devices()
    }
    pub fn set_device(&self, id: Option<String>) {
        self.cmd(engine::Cmd::SetDevice(id));
    }

    /// Decode the whole (cached) source in the background; emits `EngineEvent::Analysis`.
    pub fn analyze(&self, id: String, source: SourceSpec) {
        let (cache, events, cancel) = (self.inner.cache.clone(), self._events_tx.clone(), self.inner.analyze_cancel.clone());
        let loops = self.inner.loops.get();
        self.inner.jobs.submit(move || jobs::analyze_job(id, source, cache, events, None, cancel, loops));
    }

    /// Copy/fetch the source to `dest`, tag it, emit `EngineEvent::Download` progress.
    /// Chip / tracker / game-engine formats and clips are rendered to FLAC (see
    /// [`DownloadOptions`]); the file then gets a `.flac` extension, and the `Done` event carries
    /// the final path.
    pub fn download(&self, download_id: String, source: SourceSpec, dest: PathBuf, tags: TagInfo) {
        self.download_with(download_id, source, dest, tags, DownloadOptions::default());
    }

    pub fn download_with(&self, download_id: String, source: SourceSpec, dest: PathBuf, tags: TagInfo, options: DownloadOptions) {
        let loops = self.inner.loops.get();
        self.inner.downloads.start(download_id, source, dest, tags, options, loops, self.inner.cache.clone(), self._events_tx.clone());
    }

    /// List an archive source (`.zip` / `.7z`, fetched through the stream cache) and return the
    /// text of its playlists. Blocks until the archive is available.
    pub fn inspect_archive(&self, source: &SourceSpec) -> Result<ArchiveListing, EngineError> {
        source::inspect_archive(source, &self.inner.cache).map_err(|e| EngineError(e.message))
    }

    /// Mute chip voices on the playing tracks: bit `i` mutes voice `i` (see
    /// `TrackInfo::voice_names`). Applies to sources that support it (libgme, libopenmpt); the
    /// mask persists across tracks until changed.
    pub fn set_voice_mask(&self, mask: u64) {
        self.inner.loops.set_voice_mask(mask);
    }

    /// Mutable voices of the current track (0 when unsupported or nothing is playing).
    pub fn voice_count(&self) -> u32 {
        self.inner.shared.voice_count.load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn cancel_download(&self, download_id: &str) {
        self.inner.downloads.cancel(download_id);
    }

    /// Playback health counters (underruns, device xruns, output-callback load, decode-buffer low
    /// water) and CPU time per engine thread class. `reset` zeroes the counters afterwards.
    pub fn stats(&self, reset: bool) -> StatsSnapshot {
        self.inner.shared.stats.snapshot(reset)
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
