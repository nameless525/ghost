//! `ghost.node`: napi-rs bindings for the GHOST audio engine.
//!
//! * `GhostEngine` wraps `ghost_engine::Engine` with the exact `EngineBridge` surface from
//!   `src/main/engine/types.ts` (loaded in Electron's main process).
//! * `AnalysisReader` maps the shared-memory analysis region read-only (see `shm.rs` for the
//!   layout). The renderer preload loads this same addon only to construct readers;
//!   constructing one never starts the engine, audio or any thread.
//! * `processArt` / `artAccent` run the cover-art pipeline (`ghost-art`) on a small dedicated
//!   pool (see `art.rs`); usable without a `GhostEngine`, and lazy (no threads until first use).

mod art;
mod convert;
mod publisher;
mod shm;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crossbeam_channel::{Receiver, Sender};
use ghost_engine::{Engine, EngineConfig, EngineEvent};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use convert::*;
use publisher::Publisher;
use shm::{ShmReader, Snapshot};

/// Callback into JS: unref'd (weak) so it never keeps the Node/Electron event loop alive,
/// not callee-handled (JS receives just the event object), unbounded queue (never blocks).
type EventTsfn = ThreadsafeFunction<JsEvent, (), JsEvent, Status, false, true, 0>;

/// Used when `cacheMaxBytes` is missing/invalid (DESIGN §5.3 default: 5 GB).
const DEFAULT_CACHE_MAX_BYTES: u64 = 5 * 1024 * 1024 * 1024;

/// Bitmask of live engines in this process; slot `n` owns region `region_path(n)`. Slots are
/// reused, so an engine recreated after `shutdown()` publishes at the same path and renderer
/// readers (whose preload args are fixed) reconnect on their own.
static SLOTS: Mutex<u64> = Mutex::new(0);
static SWEEP: std::sync::Once = std::sync::Once::new();

fn acquire_slot() -> u32 {
    let mut m = SLOTS.lock().unwrap_or_else(|p| p.into_inner());
    let n = (!*m).trailing_zeros().min(63);
    *m |= 1 << n;
    n
}

fn release_slot(n: u32) {
    *SLOTS.lock().unwrap_or_else(|p| p.into_inner()) &= !(1u64 << n);
}

struct EventPump {
    stop_tx: Option<Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

#[napi]
pub struct GhostEngine {
    engine: Arc<Engine>,
    closed: AtomicBool,
    slot: u32,
    shm_path: String,
    publisher: Mutex<Option<Publisher>>,
    sink: Arc<Mutex<Option<EventTsfn>>>,
    pump: Mutex<Option<EventPump>>,
}

fn generic(msg: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, msg.into())
}

fn deliver(sink: &Mutex<Option<EventTsfn>>, ev: EngineEvent) {
    if !JsEvent::is_known(&ev) {
        return;
    }
    if let Some(tsfn) = sink.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        let _ = tsfn.call(JsEvent(ev), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

fn spawn_pump(rx: Receiver<EngineEvent>, sink: Arc<Mutex<Option<EventTsfn>>>) -> Result<EventPump> {
    let (stop_tx, stop_rx) = crossbeam_channel::bounded::<()>(0);
    let thread = std::thread::Builder::new()
        .name("ghost-node-events".into())
        .spawn(move || {
            let _cpu = ghost_engine::stats::register_thread("ghost-node-events");
            loop {
            crossbeam_channel::select! {
                recv(rx) -> ev => match ev {
                    Ok(ev) => deliver(&sink, ev),
                    Err(_) => break, // engine dropped its sender
                },
                recv(stop_rx) -> _ => {
                    // Shutting down: flush whatever the engine emitted on its way out.
                    while let Ok(ev) = rx.try_recv() {
                        deliver(&sink, ev);
                    }
                    break;
                }
            }
            }
        })
        .map_err(|e| generic(format!("failed to spawn event thread: {e}")))?;
    Ok(EventPump {
        stop_tx: Some(stop_tx),
        thread: Some(thread),
    })
}

#[napi]
impl GhostEngine {
    /// `new GhostEngine({ cacheDir, cacheMaxBytes, userAgent })`
    #[napi(constructor, catch_unwind)]
    pub fn new(config: JsEngineConfig) -> Result<Self> {
        let cfg = EngineConfig {
            cache_dir: config.cache_dir.into(),
            cache_max_bytes: if config.cache_max_bytes.is_finite() && config.cache_max_bytes > 0.0 {
                config.cache_max_bytes as u64
            } else {
                DEFAULT_CACHE_MAX_BYTES
            },
            user_agent: config.user_agent,
        };
        let engine = Arc::new(Engine::new(cfg).map_err(|e| generic(format!("engine init failed: {e}")))?);

        SWEEP.call_once(shm::sweep_orphans);
        let slot = acquire_slot();
        let path = shm::region_path(slot);
        let publisher = Publisher::start(engine.clone(), &path).map_err(|e| {
            engine.shutdown();
            release_slot(slot);
            generic(format!("failed to create analysis region {}: {e}", path.display()))
        })?;
        let shm_path = publisher.path().to_string_lossy().into_owned();

        Ok(GhostEngine {
            engine,
            closed: AtomicBool::new(false),
            slot,
            shm_path,
            publisher: Mutex::new(Some(publisher)),
            sink: Arc::new(Mutex::new(None)),
            pump: Mutex::new(None),
        })
    }

    #[inline]
    fn live(&self) -> Option<&Engine> {
        if self.closed.load(Ordering::Acquire) {
            None
        } else {
            Some(&self.engine)
        }
    }

    #[napi(catch_unwind)]
    pub fn set_current(&self, track: JsEngineTrack, start_ms: f64, autoplay: bool) -> Result<()> {
        let track = track_from_js(track)?;
        if let Some(e) = self.live() {
            e.set_current(track, ms(start_ms), autoplay);
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn set_next(&self, track: Option<JsEngineTrack>) -> Result<()> {
        let track = track.map(track_from_js).transpose()?;
        if let Some(e) = self.live() {
            e.set_next(track);
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn play(&self) {
        if let Some(e) = self.live() {
            e.play();
        }
    }

    #[napi(catch_unwind)]
    pub fn pause(&self) {
        if let Some(e) = self.live() {
            e.pause();
        }
    }

    #[napi(catch_unwind)]
    pub fn stop(&self) {
        if let Some(e) = self.live() {
            e.stop();
        }
    }

    #[napi(catch_unwind)]
    pub fn seek(&self, ms_: f64) {
        if let Some(e) = self.live() {
            e.seek(ms(ms_));
        }
    }

    #[napi(catch_unwind)]
    pub fn set_volume_db(&self, db: f64) {
        if let Some(e) = self.live() {
            e.set_volume_db(if db.is_finite() { db as f32 } else { -120.0 });
        }
    }

    #[napi(catch_unwind)]
    pub fn set_muted(&self, muted: bool) {
        if let Some(e) = self.live() {
            e.set_muted(muted);
        }
    }

    #[napi(catch_unwind)]
    pub fn set_loop(&self, mode: String, count: u32, fade_sec: f64) -> Result<()> {
        let mode = loop_mode(&mode)?;
        if let Some(e) = self.live() {
            e.set_loop(mode, count, fade_sec.max(0.0) as f32);
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn set_normalization(&self, enabled: bool, target_lufs: f64, mode: String) -> Result<()> {
        let mode = normalization_mode(&mode)?;
        if let Some(e) = self.live() {
            e.set_normalization(enabled, target_lufs as f32, mode);
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn set_gapless(&self, enabled: bool) {
        if let Some(e) = self.live() {
            e.set_gapless(enabled);
        }
    }

    #[napi(catch_unwind)]
    pub fn set_crossfade(&self, sec: f64) {
        if let Some(e) = self.live() {
            e.set_crossfade(sec.max(0.0) as f32);
        }
    }

    #[napi(catch_unwind)]
    pub fn set_overlay_filter(&self, active: bool) {
        if let Some(e) = self.live() {
            e.set_overlay_filter(active);
        }
    }

    #[napi(catch_unwind)]
    pub fn preview(&self, track: JsEngineTrack, start_ms: f64) -> Result<()> {
        let track = track_from_js(track)?;
        if let Some(e) = self.live() {
            e.preview(track, ms(start_ms));
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn stop_preview(&self) {
        if let Some(e) = self.live() {
            e.stop_preview();
        }
    }

    /// `{ id, positionMs, durationMs, playing, at }`
    #[napi(catch_unwind)]
    pub fn position(&self) -> JsEnginePosition {
        match self.live() {
            Some(e) => e.position().into(),
            None => JsEnginePosition {
                id: None,
                position_ms: 0.0,
                duration_ms: None,
                playing: false,
                at: now_ms(),
            },
        }
    }

    /// `loadProgress(which: 'current' | 'preview')`: what that track's start or rebuffer waits on
    /// (`EngineLoadProgress`), or null when the slot is empty. Cheap; poll it while waiting.
    #[napi(catch_unwind)]
    pub fn load_progress(&self, which: String) -> Result<Option<JsLoadProgress>> {
        let slot = slot(&which)?;
        Ok(self.live().and_then(|e| e.load_progress(slot)).map(Into::into))
    }

    /// `cacheProgress(cacheKey)`: `{ bytes, totalBytes }` of that stream in the cache while it is
    /// being fetched or read (a track, an analysis, an `inspectArchive` in flight), else null.
    #[napi(catch_unwind)]
    pub fn cache_progress(&self, cache_key: String) -> Option<JsCacheProgress> {
        let (bytes, total) = self.live()?.cache_progress(&cache_key)?;
        Some(JsCacheProgress { bytes: bytes as f64, total_bytes: total.map(|t| t as f64) })
    }

    #[napi(catch_unwind)]
    pub fn list_devices(&self) -> Vec<JsDeviceInfo> {
        match self.live() {
            Some(e) => e.list_devices().into_iter().map(Into::into).collect(),
            None => Vec::new(),
        }
    }

    #[napi(catch_unwind)]
    pub fn set_device(&self, id: Option<String>) {
        if let Some(e) = self.live() {
            e.set_device(id);
        }
    }

    #[napi(catch_unwind)]
    pub fn analyze(&self, id: String, source: JsEngineSource) -> Result<()> {
        let source = source_from_js(source)?;
        if let Some(e) = self.live() {
            e.analyze(id, source);
        }
        Ok(())
    }

    /// `download(downloadId, source, destPath, tags, options?)`. Chip / tracker / game-engine
    /// formats and clips render to FLAC by default (`options.renderFlac` overrides); the `done`
    /// event's `path` is the final file (its extension may have become `.flac`).
    #[napi(catch_unwind)]
    pub fn download(
        &self,
        download_id: String,
        source: JsEngineSource,
        dest_path: String,
        tags: JsTagInfo,
        options: Option<JsDownloadOptions>,
    ) -> Result<()> {
        let source = source_from_js(source)?;
        if let Some(e) = self.live() {
            let opts = options.map(Into::into).unwrap_or_default();
            e.download_with(download_id, source, dest_path.into(), tags_from_js(tags), opts);
        }
        Ok(())
    }

    /// `inspectArchive(source): Promise<{ entries: { path, size }[], playlists: { path, text }[] }>`.
    /// Fetches the archive through the stream cache on a background thread (never the JS thread
    /// or libuv's pool); rejects if it isn't a zip / 7z or can't be fetched.
    #[napi(ts_return_type = "Promise<ArchiveListing>", catch_unwind)]
    pub fn inspect_archive<'env>(&self, env: &'env Env, source: JsEngineSource) -> Result<Object<'env>> {
        type Resolver = Box<dyn FnOnce(Env) -> Result<JsArchiveListing> + Send>;
        let source = source_from_js(source)?;
        let (deferred, promise) = env.create_deferred::<JsArchiveListing, Resolver>()?;
        if self.closed.load(Ordering::Acquire) {
            deferred.reject(generic("engine is shut down"));
            return Ok(promise);
        }
        let engine = self.engine.clone();
        std::thread::Builder::new()
            .name("ghost-node-inspect".into())
            // A panic (hostile archive) must still settle the promise.
            .spawn(move || match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| engine.inspect_archive(&source))) {
                Ok(Ok(listing)) => deferred.resolve(Box::new(move |_| Ok(JsArchiveListing::from(listing)))),
                Ok(Err(e)) => deferred.reject(generic(e.0)),
                Err(_) => deferred.reject(generic("archive inspection crashed (malformed archive?)")),
            })
            .map_err(|e| generic(format!("failed to spawn inspect thread: {e}")))?;
        Ok(promise)
    }

    /// Mute chip voices on the playing tracks: bit `i` mutes voice `i` (see the `trackInfo`
    /// event's `voiceNames`). Persists across tracks until changed; 0 unmutes everything.
    #[napi(catch_unwind)]
    pub fn set_voice_mask(&self, mask: f64) {
        if let Some(e) = self.live() {
            let m = if mask.is_finite() && mask > 0.0 { mask.min(u64::MAX as f64) as u64 } else { 0 };
            e.set_voice_mask(m);
        }
    }

    /// Mutable voices of the current track (0 when unsupported or idle).
    #[napi(catch_unwind)]
    pub fn voice_count(&self) -> u32 {
        self.live().map_or(0, |e| e.voice_count())
    }

    #[napi(catch_unwind)]
    pub fn cancel_download(&self, download_id: String) {
        if let Some(e) = self.live() {
            e.cancel_download(&download_id);
        }
    }

    /// Playback health: `{ underruns, xruns, callbacks, callbackOverBudget, callbackGaps,
    /// callbackMaxUs, callbackAvgUs, callbackPeriodUs, lowWaterMs, lowWaterEvents,
    /// threads: [{ name, count, cpuMs }] }`. Counters accumulate until read with `reset = true`.
    /// Cheap (atomics plus one kernel query per engine thread); callable from any JS thread.
    #[napi(catch_unwind)]
    pub fn stats(&self, reset: Option<bool>) -> JsEngineStats {
        self.engine.stats(reset.unwrap_or(false)).into()
    }

    /// Absolute path of the memory-mapped analysis region (pass to `AnalysisReader`).
    #[napi(catch_unwind)]
    pub fn analysis_shm_name(&self) -> String {
        self.shm_path.clone()
    }

    /// Register the event callback (replaces any previous one). Events emitted before the
    /// first registration are queued and delivered on registration.
    #[napi(catch_unwind)]
    pub fn on_event(&self, cb: Function<JsEvent, ()>) -> Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        let tsfn: EventTsfn = cb
            .build_threadsafe_function::<JsEvent>()
            .weak::<true>()
            .callee_handled::<false>()
            .build()?;
        *self.sink.lock().unwrap_or_else(|p| p.into_inner()) = Some(tsfn);
        let mut pump = self.pump.lock().unwrap_or_else(|p| p.into_inner());
        if pump.is_none() {
            *pump = Some(spawn_pump(self.engine.events(), self.sink.clone())?);
        }
        Ok(())
    }

    /// Stop playback and all engine threads, delete the analysis region, release the event
    /// callback. Idempotent; every other method becomes a no-op afterwards.
    #[napi(catch_unwind)]
    pub fn shutdown(&self) {
        self.close();
    }

    fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        // Publisher first so nothing polls the engine while it tears down; readers see
        // valid = 0 immediately and the region file is removed.
        if let Some(mut p) = self.publisher.lock().unwrap_or_else(|p| p.into_inner()).take() {
            p.stop();
        }
        release_slot(self.slot);
        self.engine.shutdown();
        if let Some(mut pump) = self.pump.lock().unwrap_or_else(|p| p.into_inner()).take() {
            drop(pump.stop_tx.take()); // wakes the pump, which flushes and exits
            if let Some(t) = pump.thread.take() {
                let _ = t.join();
            }
        }
        // Release (not abort): events already queued still reach JS, then the tsfn finalizes.
        drop(self.sink.lock().unwrap_or_else(|p| p.into_inner()).take());
    }
}

impl Drop for GhostEngine {
    fn drop(&mut self) {
        self.close();
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

// ---------------------------------------------------------------------------------------------
// Analysis reader (renderer side)

/// One frame, as `{ bands: Float32Array(96), waveform: Float32Array(512), rms, peak, onset,
/// positionMs, trackSeq }`. Typed arrays are V8-owned copies (no external buffers, which
/// Electron's memory cage forbids).
pub struct JsAnalysisFrame(Box<Snapshot>);

unsafe fn f32_array(env: napi::sys::napi_env, data: &[f32]) -> Result<napi::sys::napi_value> {
    let byte_len = std::mem::size_of_val(data);
    let mut buf: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut ab = std::ptr::null_mut();
    napi::check_status!(unsafe { napi::sys::napi_create_arraybuffer(env, byte_len, &mut buf, &mut ab) })?;
    unsafe { std::ptr::copy_nonoverlapping(data.as_ptr() as *const u8, buf as *mut u8, byte_len) };
    let mut ta = std::ptr::null_mut();
    napi::check_status!(unsafe {
        napi::sys::napi_create_typedarray(
            env,
            napi::sys::TypedarrayType::float32_array,
            data.len(),
            ab,
            0,
            &mut ta,
        )
    })?;
    Ok(ta)
}

impl ToNapiValue for JsAnalysisFrame {
    unsafe fn to_napi_value(raw_env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let s = val.0;
        let mut o = Object::new(&env)?;
        o.set("bands", unsafe { RawValue(f32_array(raw_env, &s.bands)?) })?;
        o.set("waveform", unsafe { RawValue(f32_array(raw_env, &s.waveform)?) })?;
        o.set("rms", s.rms as f64)?;
        o.set("peak", s.peak as f64)?;
        o.set("onset", s.onset as f64)?;
        o.set("positionMs", s.position_ms)?;
        o.set("trackSeq", s.track_seq)?;
        Ok(napi::JsValue::raw(&o))
    }
}

/// Pass an already-created napi value through `Object::set`.
struct RawValue(napi::sys::napi_value);
impl ToNapiValue for RawValue {
    unsafe fn to_napi_value(_env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
        Ok(val.0)
    }
}

#[napi]
pub struct AnalysisReader {
    reader: ShmReader,
}

#[napi]
impl AnalysisReader {
    /// Map the region at `path` read-only. Throws if it doesn't exist (yet).
    #[napi(constructor, catch_unwind)]
    pub fn new(path: String) -> Result<Self> {
        let reader = ShmReader::open(std::path::Path::new(&path))
            .map_err(|e| generic(format!("cannot open analysis region {path}: {e}")))?;
        Ok(AnalysisReader { reader })
    }

    /// True while a publisher is updating the region. False means it was orphaned (engine shut
    /// down or replaced): drop this reader and construct a new one on the same path.
    #[napi(catch_unwind)]
    pub fn alive(&mut self) -> bool {
        self.reader.alive()
    }

    /// Latest consistent frame, or `null` when nothing is playing, the region is invalid, or
    /// the publisher has stopped updating it.
    #[napi(catch_unwind)]
    pub fn read(&mut self) -> Option<JsAnalysisFrame> {
        let mut snap = Box::<Snapshot>::default();
        if self.reader.read(&mut snap) {
            Some(JsAnalysisFrame(snap))
        } else {
            None
        }
    }
}

#[cfg(feature = "debug-events")]
#[napi]
impl GhostEngine {
    /// Test hook: push one of every `EngineEvent` variant through the real JS delivery path.
    #[napi(js_name = "_debugEmitAllEvents", catch_unwind)]
    pub fn debug_emit_all_events(&self) {
        use ghost_engine::*;
        let analysis = OfflineAnalysis {
            integrated_lufs: Some(-14.2),
            loudness_range: Some(6.5),
            true_peak_db: Some(-0.3),
            bpm: Some(128.0),
            bpm_confidence: 0.8,
            beats: vec![0.1, 0.57, 1.04],
            downbeats: vec![0.1],
            kiai: vec![(30.0, 45.5), (90.25, 120.0)],
            energy: vec![0.1, 0.5, 0.9],
            intensity: Some(4.2),
            duration_ms: 123_456,
        };
        let events = vec![
            EngineEvent::State {
                state: PlaybackState::Playing,
                id: Some("q1".into()),
            },
            EngineEvent::State {
                state: PlaybackState::Idle,
                id: None,
            },
            EngineEvent::Advanced { id: "q2".into() },
            EngineEvent::Ended { id: "q2".into() },
            EngineEvent::TrackInfo(TrackInfo {
                id: "q1".into(),
                duration_ms: Some(201_000),
                sample_rate: 44_100,
                channels: 2,
                codec: "mp3".into(),
                bitrate_kbps: None,
                ..Default::default()
            }),
            EngineEvent::Buffering {
                id: "q1".into(),
                buffering: true,
            },
            EngineEvent::Error {
                id: None,
                message: "boom".into(),
                recoverable: true,
            },
            EngineEvent::Analysis {
                id: "q1".into(),
                cache_key: None,
                result: analysis,
            },
            EngineEvent::CacheComplete {
                id: "q1".into(),
                cache_key: "k".into(),
                path: "/c/k.bin".into(),
                bytes: 5_000_000,
            },
            EngineEvent::Download {
                download_id: "d1".into(),
                status: DownloadStatus::Progress,
                bytes: 10,
                total_bytes: None,
                path: None,
                error: None,
            },
            EngineEvent::Download {
                download_id: "d1".into(),
                status: DownloadStatus::Done,
                bytes: 100,
                total_bytes: Some(100),
                path: Some("/m/a.mp3".into()),
                error: None,
            },
            EngineEvent::Devices(vec![DeviceInfo {
                id: "dev1".into(),
                name: "Speakers".into(),
                is_default: true,
            }]),
            EngineEvent::PreviewEnded { id: "preview".into() },
        ];
        for ev in events {
            deliver(&self.sink, ev);
        }
    }
}
