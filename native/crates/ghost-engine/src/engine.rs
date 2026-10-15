//! Engine controller thread: owns the output stream, creates voices (decode workers + rings),
//! talks to the RT mixer through lock-free queues, and turns everything into `EngineEvent`s.
//! The public `Engine` handle only sends `Cmd`s here, so its methods return immediately.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{select, Receiver, Sender};
use parking_lot::Mutex;

use crate::analysis_tap::{AnalysisShared, TapMsg};
use crate::cache::{CacheEvent, CacheManager, Entry};
use crate::clock::Clock;
use crate::decode::{self, WorkerEvent, WorkerParams};
use crate::jobs::{analyze_job, JobPool, Loudness};
use crate::mixer::{Mixer, MixerCmd, MixerEvent, MixerLink, Transition, PREFILL_SEC, REBUFFER_SEC, SWITCH_FADE_SEC};
use crate::output::{self, NullOutput, OutputStream, ERR_REBUILD};
use crate::source::loop_stage::LoopSettings;
use crate::util::{db_to_lin, epoch_us};
use crate::voice::{self, Bus, Continuation, Voice, VoiceShared, PLAY_STARTED, PLAY_WAITING};
use crate::{DeviceInfo, EngineEvent, LoadProgress, NormalizationMode, PlaybackState, PositionInfo, Slot, SourceSpec, TrackInfo, TrackLoad};

/// Device enumeration cadence without change notifications (and the idle loop's longest sleep).
const DEVICE_POLL: Duration = Duration::from_millis(1500);
/// Safety-net enumeration cadence when CoreAudio change notifications are active.
const DEVICE_POLL_WATCHED: Duration = Duration::from_secs(30);
/// After a command, keep the housekeeping cadence fast this long (voices the mixer drops come
/// back through its garbage queue shortly after).
const BUSY_AFTER_CMD: Duration = Duration::from_secs(2);
const SEEK_BUFFERING_AFTER: Duration = Duration::from_millis(250);
const PROVISIONAL_GAIN_DB: f32 = -4.0;
const LOUDNESS_RAMP_SEC: f32 = 2.0;
const SETTINGS_RAMP_SEC: f32 = 0.3;
const GAP_SEC: f32 = 0.5;

pub enum Cmd {
    SetCurrent { track: TrackLoad, start_ms: u64, autoplay: bool },
    SetNext(Option<TrackLoad>),
    Play,
    Pause,
    Stop,
    Seek(u64),
    Volume(f32),
    Muted(bool),
    Normalization { enabled: bool, target: f32, mode: NormalizationMode },
    Gapless(bool),
    Crossfade(f32),
    Overlay(bool),
    Preview { track: TrackLoad, start_ms: u64 },
    StopPreview,
    SetDevice(Option<String>),
    Shutdown,
}

pub enum OutputMode {
    Device,
    Offline { rate: u32, block: usize, sink: Sender<Vec<f32>> },
}

/// (voice key, track id, duration ms) for position lookups.
type VoiceEntry = (u64, Arc<str>, Option<u64>);

/// What `Engine::load_progress` reads for one slot, published by the controller whenever the
/// slot's track or voice changes.
pub struct LoadWatch {
    id: String,
    voice: Option<Arc<VoiceShared>>,
    /// The cache entry the track's bytes come through (an archive entry's: the archive's), held
    /// open while the track is in the slot so it reads right even after its readers closed.
    entry: Option<Arc<Entry>>,
    /// Local files: the file's size (archive entries: the archive's).
    file_size: Option<u64>,
    whole_file: bool,
    rate: u32,
}

/// State readable from the API handle without going through the controller.
pub struct Shared {
    pub clock: Arc<Clock>,
    pub analysis: Arc<AnalysisShared>,
    voices: Mutex<VecDeque<VoiceEntry>>,
    pub devices: Mutex<Vec<DeviceInfo>>,
    /// `devices` holds a real enumeration (possibly empty), so callers needn't enumerate.
    pub devices_polled: AtomicBool,
    pub transport_playing: AtomicBool,
    pub rate: AtomicU32,
    pub device_name: Mutex<String>,
    /// Mutable voices of the current track (for `Engine::voice_count`).
    pub voice_count: AtomicU32,
    /// Health counters (underruns, xruns, callback load, low water).
    pub stats: Arc<crate::stats::Stats>,
    /// Load watches for the current and preview slots (`Slot as usize`).
    loads: Mutex<[Option<LoadWatch>; 2]>,
}

impl Shared {
    pub fn new() -> Self {
        Self {
            clock: Arc::new(Clock::new()),
            analysis: Arc::new(AnalysisShared::default()),
            voices: Mutex::new(VecDeque::with_capacity(64)),
            devices: Mutex::new(Vec::new()),
            devices_polled: AtomicBool::new(false),
            transport_playing: AtomicBool::new(false),
            rate: AtomicU32::new(0),
            device_name: Mutex::new(String::new()),
            voice_count: AtomicU32::new(0),
            stats: Arc::new(crate::stats::Stats::new()),
            loads: Mutex::new([None, None]),
        }
    }

    /// See `Engine::load_progress`. Holds the watch lock (taken by the controller only when a
    /// slot changes) for a few atomic loads and the entry's `progress()` field reads.
    pub fn load_progress(&self, slot: Slot, stall_timeout: Duration) -> Option<LoadProgress> {
        let loads = self.loads.lock();
        let w = loads[slot as usize].as_ref()?;
        let rate = w.rate.max(1) as u64;
        let frames = |sec: f32| (sec * rate as f32) as u64;
        let (state, buffered, target) = match &w.voice {
            Some(v) => v.wait_progress(frames(PREFILL_SEC), frames(REBUFFER_SEC)),
            None => (PLAY_WAITING, 0, frames(PREFILL_SEC)),
        };
        let (connected, bytes, total_bytes, stalled) = match (&w.entry, w.file_size) {
            (Some(e), _) => {
                let p = e.progress();
                (p.connected, p.bytes, p.total, p.stalled)
            }
            (None, size) => (true, size.unwrap_or(0), size, Duration::ZERO),
        };
        Some(LoadProgress {
            id: w.id.clone(),
            started: state == PLAY_STARTED,
            connected,
            bytes,
            total_bytes,
            whole_file: w.whole_file,
            buffered_ms: buffered * 1000 / rate,
            target_ms: target * 1000 / rate,
            stalled_ms: stalled.as_millis() as u64,
            stall_timeout_ms: stall_timeout.as_millis() as u64,
        })
    }

    fn register_voice(&self, key: u64, id: &str, duration_ms: Option<u64>) {
        let mut v = self.voices.lock();
        if v.len() >= 64 {
            v.pop_front();
        }
        v.push_back((key, Arc::from(id), duration_ms));
    }

    fn set_voice_duration(&self, key: u64, duration_ms: Option<u64>) {
        for e in self.voices.lock().iter_mut() {
            if e.0 == key {
                e.2 = duration_ms;
            }
        }
    }

    fn voice(&self, key: u64) -> Option<(Arc<str>, Option<u64>)> {
        self.voices.lock().iter().rev().find(|e| e.0 == key).map(|e| (e.1.clone(), e.2))
    }

    /// Audible position right now.
    pub fn position(&self) -> PositionInfo {
        let now = epoch_us();
        let at = now as f64 / 1000.0;
        let Some(seg) = self.clock.at_epoch(now) else {
            return PositionInfo { id: None, position_ms: 0.0, duration_ms: None, playing: false, at_epoch_ms: at };
        };
        if seg.voice == 0 {
            return PositionInfo { id: None, position_ms: 0.0, duration_ms: None, playing: false, at_epoch_ms: at };
        }
        let (id, duration_ms) = self.voice(seg.voice).map(|(i, d)| (Some(i.to_string()), d)).unwrap_or((None, None));
        let pos = seg.pos_at_epoch(now) * 1000.0 / seg.rate.max(1) as f64;
        let playing = seg.advancing && self.transport_playing.load(Ordering::Relaxed);
        PositionInfo { id, position_ms: pos, duration_ms, playing, at_epoch_ms: at }
    }
}

struct Track {
    load: TrackLoad,
    key: u64,
    shared: Option<Arc<VoiceShared>>,
    seq: u32,
    measured_lufs: Option<f32>,
    info: Option<TrackInfo>,
    started: bool,
    ever_started: bool,
    buffering: bool,
    pending_since: Option<Instant>,
    gain_db: f32,
}

impl Track {
    fn new(load: TrackLoad, seq: u32) -> Self {
        Self {
            load,
            key: 0,
            shared: None,
            seq,
            measured_lufs: None,
            info: None,
            started: false,
            ever_started: false,
            buffering: false,
            pending_since: None,
            gain_db: 0.0,
        }
    }
    fn cache_key(&self) -> Option<&str> {
        match &self.load.source {
            SourceSpec::Http { cache_key, .. } => Some(cache_key.as_str()),
            SourceSpec::File { .. } => None,
        }
    }
}

enum Out {
    None,
    Device(OutputStream),
    Null(#[allow(dead_code)] NullOutput),
}

pub struct Controller {
    cache: Arc<CacheManager>,
    events: Sender<EngineEvent>,
    shared: Arc<Shared>,
    cmd_rx: Receiver<Cmd>,
    worker_tx: Sender<WorkerEvent>,
    worker_rx: Receiver<WorkerEvent>,
    cache_rx: Receiver<CacheEvent>,
    loud_tx: Sender<Loudness>,
    loud_rx: Receiver<Loudness>,
    jobs: Arc<JobPool>,
    loops: Arc<LoopSettings>,
    tap_tx: Sender<TapMsg>,

    mode: OutputMode,
    out: Out,
    link: Option<MixerLink>,
    rate: u32,
    selected_device: Option<String>,
    device_err: Arc<AtomicU32>,
    known_devices: Vec<DeviceInfo>,
    last_poll: Instant,
    /// Device-change notifications (wake-ups) and the generation last enumerated.
    dev_rx: Receiver<()>,
    /// Kept so `dev_rx` never disconnects (a disconnected channel is always ready in `select!`).
    _dev_tx: Sender<()>,
    dev_gen: u64,
    dev_watched: bool,
    last_cmd: Instant,
    last_open_error: Option<String>,

    current: Option<Track>,
    next: Option<Track>,
    preview: Option<Track>,
    prev_album_key: Option<String>,
    /// Tracks that just ended on their own (key, id, cache key), newest last. A decoder's error or
    /// the cache finishing can arrive after the mixer ended the track (an offline render outruns
    /// the download): they're still reported against the right id.
    ended: VecDeque<(u64, String, Option<String>)>,
    playing: bool,
    state: (PlaybackState, Option<String>),

    volume_db: f32,
    muted: bool,
    crossfade_sec: f32,
    gapless: bool,
    overlay: bool,
    norm_enabled: bool,
    norm_target: f32,
    norm_mode: NormalizationMode,

    next_key: u64,
    next_seq: u32,
    voices: HashMap<u64, Arc<VoiceShared>>,
    measuring: HashSet<String>,
    measure_cancel: Arc<AtomicBool>,
    /// Keeps the next track's cache entry filling while it waits as a chained continuation.
    next_warm: Option<crate::cache::CacheReader>,
    /// (track seq, voice key) of the current / preview tracks the load watches were built for.
    published_loads: [(u32, u64); 2],
}

pub struct ControllerInit {
    pub cache: Arc<CacheManager>,
    pub events: Sender<EngineEvent>,
    pub shared: Arc<Shared>,
    pub cmd_rx: Receiver<Cmd>,
    pub jobs: Arc<JobPool>,
    pub loops: Arc<LoopSettings>,
    pub tap_tx: Sender<TapMsg>,
    pub mode: OutputMode,
}

impl Controller {
    pub fn new(init: ControllerInit) -> Self {
        let (worker_tx, worker_rx) = crossbeam_channel::unbounded();
        let (cache_tx, cache_rx) = crossbeam_channel::unbounded();
        init.cache.subscribe(cache_tx);
        let (loud_tx, loud_rx) = crossbeam_channel::unbounded();
        let (dev_tx, dev_rx) = crossbeam_channel::bounded(1);
        let dev_watched = matches!(init.mode, OutputMode::Device) && output::device_watch::watching();
        if dev_watched {
            output::device_watch::subscribe(dev_tx.clone());
        }
        Self {
            cache: init.cache,
            events: init.events,
            shared: init.shared,
            cmd_rx: init.cmd_rx,
            worker_tx,
            worker_rx,
            cache_rx,
            loud_tx,
            loud_rx,
            jobs: init.jobs,
            loops: init.loops,
            tap_tx: init.tap_tx,
            mode: init.mode,
            out: Out::None,
            link: None,
            rate: 0,
            selected_device: None,
            device_err: Arc::new(AtomicU32::new(0)),
            known_devices: Vec::new(),
            last_poll: Instant::now().checked_sub(DEVICE_POLL_WATCHED).unwrap_or_else(Instant::now),
            dev_rx,
            _dev_tx: dev_tx,
            dev_gen: output::device_watch::generation(),
            dev_watched,
            last_cmd: Instant::now(),
            last_open_error: None,
            current: None,
            next: None,
            preview: None,
            prev_album_key: None,
            ended: VecDeque::new(),
            playing: false,
            state: (PlaybackState::Idle, None),
            volume_db: 0.0,
            muted: false,
            crossfade_sec: 0.0,
            gapless: true,
            overlay: false,
            norm_enabled: true,
            norm_target: -16.0,
            norm_mode: NormalizationMode::Auto,
            next_key: 1,
            next_seq: 1,
            voices: HashMap::new(),
            measuring: HashSet::new(),
            measure_cancel: Arc::new(AtomicBool::new(false)),
            next_warm: None,
            published_loads: [(0, 0); 2],
        }
    }

    fn emit(&self, ev: EngineEvent) {
        let _ = self.events.send(ev);
    }

    pub fn run(mut self) {
        self.open_output(false);
        loop {
            select! {
                recv(self.cmd_rx) -> c => match c {
                    Ok(Cmd::Shutdown) | Err(_) => break,
                    Ok(c) => {
                        self.last_cmd = Instant::now();
                        self.handle(c);
                    }
                },
                recv(self.dev_rx) -> _ => {},
                recv(self.worker_rx) -> w => if let Ok(w) = w { self.on_worker(w) },
                recv(self.cache_rx) -> e => if let Ok(e) = e { self.on_cache(e) },
                recv(self.loud_rx) -> l => if let Ok(l) = l { self.on_loudness(l) },
                default(self.poll_interval()) => {}
            }
            self.poll_mixer();
            self.tick();
            self.publish_loads();
        }
        // Released here, not under the lock (dropping one may close a cache entry).
        let loads = std::mem::take(&mut *self.shared.loads.lock());
        drop(loads);
        self.measure_cancel.store(true, Ordering::Relaxed);
        for v in self.voices.values() {
            v.cancel();
        }
        self.link = None;
        self.out = Out::None;
        let _ = self.tap_tx.send(TapMsg::Shutdown);
    }

    /// Housekeeping cadence (commands and device changes always wake the loop at once): mixer
    /// events and buffering checks matter while audio runs; right after a command, voices the
    /// mixer let go trickle back; otherwise (paused, stopped, idle) nothing happens until the
    /// next command, so the loop only wakes for device-error checks.
    fn poll_interval(&self) -> Duration {
        if self.preview.is_some() || (self.playing && self.current.is_some()) {
            // Only UI-facing events wait on this (gapless / crossfade / underrun handling all
            // happen in the mixer and workers); 20 ms is below anything visible.
            Duration::from_millis(20)
        } else if self.last_cmd.elapsed() < BUSY_AFTER_CMD {
            Duration::from_millis(50)
        } else {
            DEVICE_POLL
        }
    }

    // ---------------------------------------------------------------- output

    fn open_output(&mut self, fade_in: bool) -> bool {
        let start_frame = self.shared.clock.rendered.load(Ordering::Relaxed);
        let (rate, parts) = match &self.mode {
            OutputMode::Device => {
                let choice = match output::choose_device(self.selected_device.as_deref()) {
                    Ok(c) => c,
                    Err(e) => {
                        self.report_output_error(e);
                        return false;
                    }
                };
                let rate = choice.config.sample_rate();
                let mut parts = Mixer::create(rate, self.shared.clock.clone(), false, start_frame, fade_in);
                parts.mixer.set_stats(self.shared.stats.clone());
                self.device_err.store(0, Ordering::Relaxed);
                match output::start(choice, parts.mixer, self.shared.clock.clone(), self.device_err.clone(), self.shared.stats.clone()) {
                    Ok(stream) => {
                        *self.shared.device_name.lock() = stream.device_name.clone();
                        self.out = Out::Device(stream);
                        (rate, (parts.link, parts.tap))
                    }
                    Err(e) => {
                        self.report_output_error(e);
                        return false;
                    }
                }
            }
            OutputMode::Offline { rate, block, sink } => {
                let mut parts = Mixer::create(*rate, self.shared.clock.clone(), true, start_frame, false);
                parts.mixer.set_stats(self.shared.stats.clone());
                let null = NullOutput::start(parts.mixer, *block, sink.clone());
                *self.shared.device_name.lock() = "offline null sink".into();
                self.out = Out::Null(null);
                (*rate, (parts.link, parts.tap))
            }
        };
        self.last_open_error = None;
        self.rate = rate;
        self.shared.rate.store(rate, Ordering::Relaxed);
        self.shared.stats.rate.store(rate as u64, Ordering::Relaxed);
        self.link = Some(parts.0);
        let _ = self.tap_tx.send(TapMsg::Source { tap: parts.1, rate });
        self.send(MixerCmd::SetMaster(self.master_lin()));
        self.send(MixerCmd::SetOverlay(self.overlay));
        self.send_transition();
        true
    }

    fn report_output_error(&mut self, e: String) {
        if self.last_open_error.as_deref() != Some(e.as_str()) {
            self.emit(EngineEvent::Error { id: None, message: format!("audio output: {e}"), recoverable: false });
            self.last_open_error = Some(e);
        }
    }

    /// Fade out, rebuild the stream (new device and/or rate), restore playback at the same spot.
    fn rebuild_output(&mut self) {
        let pos_ms = self.current_position_ms();
        if self.link.is_some() && matches!(self.out, Out::Device(_)) {
            self.send(MixerCmd::DeviceFade { to: 0.0, frames: (0.030 * self.rate as f32) as u32 });
            std::thread::sleep(Duration::from_millis(45));
        }
        self.link = None;
        self.out = Out::None;
        for v in self.voices.values() {
            v.cancel();
        }
        self.voices.clear();
        if self.open_output(true) {
            self.restore(pos_ms);
        }
    }

    fn current_position_ms(&self) -> u64 {
        let Some(cur) = &self.current else { return 0 };
        let p = self.shared.position();
        let ours = self.shared.voice(cur.key).is_some() && p.id.as_deref() == Some(cur.load.id.as_str());
        if ours {
            p.position_ms.max(0.0) as u64
        } else {
            0
        }
    }

    /// Re-create voices on a fresh mixer.
    fn restore(&mut self, pos_ms: u64) {
        if let Some(mut cur) = self.current.take() {
            let gain = self.gain_for(&cur, None, self.next.as_ref().map(|n| &n.load));
            cur.gain_db = gain;
            if let Some((v, sh)) = self.make_voice(&cur.load, pos_ms, Bus::Music, cur.seq, gain) {
                cur.key = v.key;
                cur.shared = Some(sh);
                cur.started = false;
                cur.pending_since = Some(Instant::now());
                self.send(MixerCmd::SetCurrent { voice: Some(v), fade_frames: 0 });
                self.send(if self.playing { MixerCmd::Play } else { MixerCmd::Pause });
            }
            self.current = Some(cur);
        }
        if let Some(mut nx) = self.next.take() {
            let gain = self.gain_for(&nx, self.current.as_ref().map(|c| &c.load), None);
            let chain_to = if matches!(self.transition(), Transition::Crossfade(_)) { None } else { self.current.as_ref().and_then(|c| c.shared.clone()) };
            if let Some((v, sh)) = self.make_voice_chained(&nx.load, 0, Bus::Music, nx.seq, gain, chain_to) {
                nx.key = v.key;
                nx.shared = Some(sh);
                nx.started = false;
                nx.gain_db = gain;
                self.send(MixerCmd::SetNext(Some(v)));
            }
            self.next = Some(nx);
        }
        if let Some(p) = self.preview.take() {
            self.emit(EngineEvent::PreviewEnded { id: p.load.id });
        }
        self.send_transition();
    }

    fn send(&mut self, cmd: MixerCmd) {
        let Some(link) = self.link.as_mut() else { return };
        let mut cmd = cmd;
        for _ in 0..200 {
            match link.cmd.push(cmd) {
                Ok(()) => return,
                Err(rtrb::PushError::Full(c)) => {
                    cmd = c;
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        }
    }

    fn master_lin(&self) -> f32 {
        if self.muted || self.volume_db <= -60.0 {
            0.0
        } else {
            db_to_lin(self.volume_db.min(12.0))
        }
    }

    // ---------------------------------------------------------------- voices

    fn make_voice(&mut self, load: &TrackLoad, start_ms: u64, bus: Bus, seq: u32, gain_db: f32) -> Option<(Box<Voice>, Arc<VoiceShared>)> {
        self.make_voice_chained(load, start_ms, bus, seq, gain_db, None)
    }

    fn worker_params(&self, spec: SourceSpec, start_ms: u64, producer: rtrb::Producer<f32>, shared: Arc<VoiceShared>) -> WorkerParams {
        WorkerParams {
            spec,
            start_ms,
            dev_rate: self.rate,
            producer,
            shared,
            cache: self.cache.clone(),
            loops: self.loops.clone(),
            events: self.worker_tx.clone(),
        }
    }

    /// Start a standalone worker for a continuation that couldn't be chained.
    fn spawn_standalone(&self, c: Continuation) {
        decode::spawn(self.worker_params(c.spec, 0, c.producer, c.shared));
    }

    /// Create a voice; with `chain_to`, it is decoded as the gapless continuation of that voice.
    fn make_voice_chained(
        &mut self,
        load: &TrackLoad,
        start_ms: u64,
        bus: Bus,
        seq: u32,
        gain_db: f32,
        chain_to: Option<Arc<VoiceShared>>,
    ) -> Option<(Box<Voice>, Arc<VoiceShared>)> {
        self.link.as_ref()?;
        let key = self.next_key;
        self.next_key += 1;
        let shared = VoiceShared::new(key);
        // Provisional origin so the position reads right while the worker is still opening.
        shared.origin.store(crate::util::ms_to_frames(start_ms as f64, self.rate), Ordering::Relaxed);
        let (prod, cons) = voice::ring(self.rate);
        let params = self.worker_params(load.source.clone(), start_ms, prod, shared.clone());
        decode::spawn_or_chain(params, chain_to.as_ref());
        let mut v = Box::new(Voice::new(key, seq, bus, cons, shared.clone(), db_to_lin(gain_db)));
        v.fade_in = start_ms > 0;
        self.voices.insert(key, shared.clone());
        self.shared.register_voice(key, &load.id, load.expected_duration_ms);
        Some((v, shared))
    }

    /// Rebuild the load watches of slots whose track or voice changed (a compare otherwise).
    fn publish_loads(&mut self) {
        let slots = [self.current.as_ref(), self.preview.as_ref()];
        let now = slots.map(|t| t.map_or((0, 0), |t| (t.seq, t.key)));
        if now == self.published_loads {
            return;
        }
        let mut fresh: [Option<Option<LoadWatch>>; 2] = [None, None];
        for (i, t) in slots.into_iter().enumerate() {
            if now[i] != self.published_loads[i] {
                fresh[i] = Some(t.map(|t| self.load_watch(t)));
            }
        }
        self.published_loads = now;
        let mut old = Vec::new();
        {
            let mut loads = self.shared.loads.lock();
            for (slot, w) in loads.iter_mut().zip(fresh) {
                if let Some(w) = w {
                    old.push(std::mem::replace(slot, w));
                }
            }
        }
        drop(old);
    }

    fn load_watch(&self, t: &Track) -> LoadWatch {
        let (entry, file_size) = match &t.load.source {
            // The worker opens the same entry moments later; this only takes a handle on it.
            SourceSpec::Http { .. } => (self.cache.entry(&t.load.source).ok(), None),
            SourceSpec::File { path, .. } => (None, std::fs::metadata(path).ok().map(|m| m.len())),
        };
        LoadWatch {
            id: t.load.id.clone(),
            voice: t.shared.clone(),
            entry,
            file_size,
            whole_file: crate::source::whole_file_hint(&t.load.source),
            rate: self.rate,
        }
    }

    fn cancel_track(&mut self, t: &Track) {
        if let Some(s) = &t.shared {
            s.cancel();
        }
    }

    // ---------------------------------------------------------------- gain

    fn album_mode_for(&self, t: &TrackLoad, prev: Option<&TrackLoad>, next: Option<&TrackLoad>) -> bool {
        match self.norm_mode {
            NormalizationMode::Track => false,
            NormalizationMode::Album => true,
            NormalizationMode::Auto => {
                let Some(k) = &t.album_key else { return false };
                let prev_key = prev.and_then(|p| p.album_key.as_ref()).or(self.prev_album_key.as_ref());
                prev_key == Some(k) || next.and_then(|n| n.album_key.as_ref()) == Some(k)
            }
        }
    }

    /// Normalisation gain for `t`; `prev`/`next` are its neighbours (for Auto album mode).
    fn gain_for(&self, t: &Track, prev: Option<&TrackLoad>, next: Option<&TrackLoad>) -> f32 {
        if !self.norm_enabled {
            return 0.0;
        }
        let track_lufs = t.load.lufs.or(t.measured_lufs);
        let lufs = if self.album_mode_for(&t.load, prev, next) { t.load.album_lufs.or(track_lufs) } else { track_lufs };
        match lufs {
            Some(l) if l.is_finite() => (self.norm_target - l).clamp(-24.0, 12.0),
            _ => PROVISIONAL_GAIN_DB,
        }
    }

    fn refresh_gains(&mut self, ramp_sec: f32) {
        let frames = (ramp_sec * self.rate as f32) as u32;
        let mut cmds = Vec::new();
        if let Some(c) = &self.current {
            let g = self.gain_for(c, None, self.next.as_ref().map(|n| &n.load));
            cmds.push((0, c.key, g));
        }
        if let Some(n) = &self.next {
            let g = self.gain_for(n, self.current.as_ref().map(|c| &c.load), None);
            cmds.push((1, n.key, g));
        }
        if let Some(p) = &self.preview {
            let g = if self.norm_enabled { p.load.lufs.map(|l| (self.norm_target - l).clamp(-24.0, 12.0)).unwrap_or(PROVISIONAL_GAIN_DB) } else { 0.0 };
            cmds.push((2, p.key, g));
        }
        for (slot, key, g) in cmds {
            let t = match slot {
                0 => self.current.as_mut(),
                1 => self.next.as_mut(),
                _ => self.preview.as_mut(),
            };
            if let Some(t) = t {
                if (t.gain_db - g).abs() > 0.01 {
                    t.gain_db = g;
                    self.send(MixerCmd::SetVoiceGain { key, lin: db_to_lin(g), frames });
                }
            }
        }
    }

    fn transition(&self) -> Transition {
        let same_album = match (&self.current, &self.next) {
            (Some(c), Some(n)) => matches!((&c.load.album_key, &n.load.album_key), (Some(a), Some(b)) if a == b),
            _ => false,
        };
        if self.crossfade_sec > 0.05 && !same_album {
            Transition::Crossfade((self.crossfade_sec.min(12.0) * self.rate as f32) as u32)
        } else if self.gapless {
            Transition::Gapless
        } else {
            Transition::Gap((GAP_SEC * self.rate as f32) as u32)
        }
    }

    fn send_transition(&mut self) {
        let t = self.transition();
        if matches!(t, Transition::Crossfade(_)) {
            // A crossfade needs the next track decoding concurrently, not after the current one.
            if let Some(cur) = self.current.as_ref().and_then(|c| c.shared.clone()) {
                if let Some(c) = cur.detach_next() {
                    self.spawn_standalone(c);
                }
            }
        }
        self.send(MixerCmd::SetTransition(t));
    }

    /// After the current voice was replaced (seek / new track), move a pending continuation to
    /// the new current voice.
    fn rechain(&mut self, old: Option<Arc<VoiceShared>>) {
        let Some(old) = old else { return };
        let to = if matches!(self.transition(), Transition::Crossfade(_)) { None } else { self.current.as_ref().and_then(|c| c.shared.clone()) };
        let mut standalone = Vec::new();
        decode::move_chain(&old, to.as_ref(), |c| standalone.push(c));
        for c in standalone {
            self.spawn_standalone(c);
        }
    }

    fn maybe_measure(&mut self, slot: u8) {
        let t = match slot {
            0 => self.current.as_ref(),
            _ => self.next.as_ref(),
        };
        let Some(t) = t else { return };
        if t.load.lufs.is_some() || t.measured_lufs.is_some() || self.measuring.contains(&t.load.id) {
            return;
        }
        let ready = match &t.load.source {
            SourceSpec::File { .. } => true,
            SourceSpec::Http { cache_key, .. } => self.cache.complete_path(cache_key).is_some(),
        };
        if !ready {
            return;
        }
        let id = t.load.id.clone();
        let source = t.load.source.clone();
        self.measuring.insert(id.clone());
        let (cache, events, loud, cancel) = (self.cache.clone(), self.events.clone(), self.loud_tx.clone(), self.measure_cancel.clone());
        let loops = self.loops.get();
        self.jobs.submit(move || analyze_job(id, source, cache, events, Some(loud), cancel, loops));
    }

    // ---------------------------------------------------------------- state

    fn update_state(&mut self) {
        let (st, id) = match &self.current {
            None => (PlaybackState::Idle, None),
            Some(c) => {
                let id = Some(c.load.id.clone());
                let st = if c.buffering {
                    PlaybackState::Buffering
                } else if !c.started && !c.ever_started {
                    if !self.playing && c.info.is_some() {
                        PlaybackState::Paused
                    } else {
                        PlaybackState::Loading
                    }
                } else if self.playing {
                    PlaybackState::Playing
                } else {
                    PlaybackState::Paused
                };
                (st, id)
            }
        };
        self.shared.transport_playing.store(self.playing && st == PlaybackState::Playing, Ordering::Relaxed);
        let voices = self.current.as_ref().and_then(|c| c.info.as_ref()).map_or(0, |i| i.voice_count);
        self.shared.voice_count.store(voices, Ordering::Relaxed);
        if self.state.0 != st || self.state.1 != id {
            self.state = (st, id.clone());
            self.emit(EngineEvent::State { state: st, id });
        }
    }

    fn set_buffering(&mut self, on: bool) {
        let Some(c) = self.current.as_mut() else { return };
        if c.buffering != on {
            c.buffering = on;
            let id = c.load.id.clone();
            self.emit(EngineEvent::Buffering { id, buffering: on });
        }
        self.update_state();
    }

    // ---------------------------------------------------------------- commands

    fn handle(&mut self, cmd: Cmd) {
        if matches!(cmd, Cmd::SetCurrent { .. } | Cmd::Play | Cmd::Seek(_) | Cmd::Preview { .. } | Cmd::SetNext(_)) {
            let _ = self.tap_tx.send(TapMsg::Wake);
        }
        match cmd {
            Cmd::SetCurrent { track, start_ms, autoplay } => self.set_current(track, start_ms, autoplay),
            Cmd::SetNext(t) => self.set_next(t),
            Cmd::Play => {
                if self.current.is_some() {
                    self.playing = true;
                    self.send(MixerCmd::Play);
                    self.update_state();
                }
            }
            Cmd::Pause => {
                self.playing = false;
                self.send(MixerCmd::Pause);
                self.update_state();
            }
            Cmd::Stop => {
                self.send(MixerCmd::SetCurrent { voice: None, fade_frames: (SWITCH_FADE_SEC * self.rate as f32) as u32 });
                self.send(MixerCmd::SetNext(None));
                if let Some(c) = self.current.take() {
                    self.prev_album_key = c.load.album_key.clone();
                    self.cancel_track(&c);
                }
                if let Some(n) = self.next.take() {
                    self.cancel_track(&n);
                }
                self.next_warm = None;
                self.playing = false;
                self.update_state();
            }
            Cmd::Seek(ms) => self.seek(ms),
            Cmd::Volume(db) => {
                self.volume_db = db;
                self.send(MixerCmd::SetMaster(self.master_lin()));
            }
            Cmd::Muted(m) => {
                self.muted = m;
                self.send(MixerCmd::SetMaster(self.master_lin()));
            }
            Cmd::Normalization { enabled, target, mode } => {
                self.norm_enabled = enabled;
                self.norm_target = target;
                self.norm_mode = mode;
                self.refresh_gains(SETTINGS_RAMP_SEC);
            }
            Cmd::Gapless(g) => {
                self.gapless = g;
                self.send_transition();
            }
            Cmd::Crossfade(s) => {
                self.crossfade_sec = s.max(0.0);
                self.send_transition();
            }
            Cmd::Overlay(on) => {
                self.overlay = on;
                self.send(MixerCmd::SetOverlay(on));
            }
            Cmd::Preview { track, start_ms } => self.preview(track, start_ms),
            Cmd::StopPreview => self.send(MixerCmd::StopPreview),
            Cmd::SetDevice(id) => {
                self.selected_device = id;
                if matches!(self.mode, OutputMode::Device) {
                    self.rebuild_output();
                }
            }
            Cmd::Shutdown => {}
        }
    }

    fn set_current(&mut self, load: TrackLoad, start_ms: u64, autoplay: bool) {
        let preloaded = start_ms == 0
            && self.link.is_some()
            && self.next.as_ref().is_some_and(|n| n.shared.is_some() && n.load.id == load.id && same_source(&n.load.source, &load.source));
        if preloaded {
            return self.promote_next(load, autoplay);
        }
        let mut old_shared = None;
        if let Some(old) = self.current.take() {
            self.prev_album_key = old.load.album_key.clone();
            self.cancel_track(&old);
            old_shared = old.shared.clone();
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        let mut t = Track::new(load, seq);
        let gain = self.gain_for(&t, None, self.next.as_ref().map(|n| &n.load));
        t.gain_db = gain;
        if let Some((v, sh)) = self.make_voice(&t.load, start_ms, Bus::Music, seq, gain) {
            t.key = v.key;
            t.shared = Some(sh);
            t.pending_since = Some(Instant::now());
            self.send(MixerCmd::SetCurrent { voice: Some(v), fade_frames: (SWITCH_FADE_SEC * self.rate as f32) as u32 });
        }
        self.playing = autoplay;
        self.send(if autoplay { MixerCmd::Play } else { MixerCmd::Pause });
        self.current = Some(t);
        self.rechain(old_shared);
        self.send_transition();
        self.refresh_gains(SETTINGS_RAMP_SEC);
        self.update_state();
        self.maybe_measure(0);
    }

    /// Skip into the preloaded next track: it's already decoding, so playback starts instantly.
    fn promote_next(&mut self, load: TrackLoad, autoplay: bool) {
        let mut nx = self.next.take().unwrap();
        self.next_warm = None;
        if let Some(old) = self.current.take() {
            self.prev_album_key = old.load.album_key.clone();
            if let Some(sh) = &old.shared {
                // If the next track was waiting as this voice's continuation, decode it standalone.
                if let Some(c) = sh.detach_next() {
                    self.spawn_standalone(c);
                }
            }
            self.cancel_track(&old);
        }
        nx.load = load;
        nx.pending_since = Some(Instant::now());
        self.send(MixerCmd::PromoteNext { fade_frames: (SWITCH_FADE_SEC * self.rate as f32) as u32 });
        self.playing = autoplay;
        self.send(if autoplay { MixerCmd::Play } else { MixerCmd::Pause });
        let info = nx.info.clone();
        self.current = Some(nx);
        if let Some(i) = info {
            self.emit(EngineEvent::TrackInfo(i));
        }
        self.send_transition();
        self.refresh_gains(SETTINGS_RAMP_SEC);
        self.update_state();
        self.maybe_measure(0);
    }

    fn set_next(&mut self, load: Option<TrackLoad>) {
        if let (Some(n), Some(l)) = (&self.next, &load) {
            if n.load.id == l.id && same_source(&n.load.source, &l.source) {
                // Same preload: keep the decoded audio, just refresh the metadata.
                let n = self.next.as_mut().unwrap();
                n.load = l.clone();
                self.send_transition();
                self.refresh_gains(SETTINGS_RAMP_SEC);
                return;
            }
        }
        if let Some(old) = self.next.take() {
            self.cancel_track(&old);
        }
        self.next_warm = None;
        let Some(load) = load else {
            self.send(MixerCmd::SetNext(None));
            self.send_transition();
            return;
        };
        let seq = self.next_seq;
        self.next_seq += 1;
        let mut t = Track::new(load, seq);
        let gain = self.gain_for(&t, self.current.as_ref().map(|c| &c.load), None);
        t.gain_db = gain;
        self.next = Some(t);
        // Gapless (not crossfading): decode the next track as a continuation of the current
        // one's worker, so resampled transitions are sample-continuous.
        let chain_to = if matches!(self.transition(), Transition::Crossfade(_)) {
            None
        } else {
            self.current.as_ref().and_then(|c| c.shared.clone())
        };
        let mut t = self.next.take().unwrap();
        if chain_to.is_some() && matches!(t.load.source, SourceSpec::Http { .. }) {
            // The chained worker only opens it near the end of the current track; start
            // fetching now so it's cached by then.
            self.next_warm = self.cache.open_reader(&t.load.source, None).ok();
        }
        if let Some((v, sh)) = self.make_voice_chained(&t.load, 0, Bus::Music, seq, gain, chain_to) {
            t.key = v.key;
            t.shared = Some(sh);
            self.send(MixerCmd::SetNext(Some(v)));
        }
        self.next = Some(t);
        self.send_transition();
        self.refresh_gains(SETTINGS_RAMP_SEC);
        self.maybe_measure(1);
    }

    fn seek(&mut self, ms: u64) {
        let Some(cur) = self.current.as_ref() else { return };
        let (load, seq, gain) = (cur.load.clone(), cur.seq, cur.gain_db);
        let old_shared = cur.shared.clone();
        if let Some(old) = &cur.shared {
            old.cancel();
        }
        if let Some((mut v, sh)) = self.make_voice(&load, ms, Bus::Music, seq, gain) {
            v.fade_in = true;
            let key = v.key;
            self.send(MixerCmd::SetCurrent { voice: Some(v), fade_frames: (SWITCH_FADE_SEC * self.rate as f32) as u32 });
            if self.playing {
                self.send(MixerCmd::Play);
            }
            let c = self.current.as_mut().unwrap();
            c.key = key;
            c.shared = Some(sh);
            c.started = false;
            c.pending_since = Some(Instant::now());
            self.rechain(old_shared);
        }
    }

    fn preview(&mut self, load: TrackLoad, start_ms: u64) {
        if let Some(old) = self.preview.take() {
            self.cancel_track(&old);
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        let mut t = Track::new(load, seq);
        let gain = if self.norm_enabled { t.load.lufs.map(|l| (self.norm_target - l).clamp(-24.0, 12.0)).unwrap_or(PROVISIONAL_GAIN_DB) } else { 0.0 };
        t.gain_db = gain;
        if let Some((v, sh)) = self.make_voice(&t.load, start_ms, Bus::Preview, seq, gain) {
            t.key = v.key;
            t.shared = Some(sh);
            self.send(MixerCmd::Preview(v));
            self.preview = Some(t);
        } else {
            self.emit(EngineEvent::PreviewEnded { id: t.load.id });
        }
    }

    // ---------------------------------------------------------------- events in

    fn poll_mixer(&mut self) {
        let mut evs = Vec::new();
        let mut garbage = Vec::new();
        if let Some(link) = self.link.as_mut() {
            while let Ok(e) = link.events.pop() {
                evs.push(e);
            }
            while let Ok(v) = link.garbage.pop() {
                garbage.push(v);
            }
        }
        for v in garbage {
            v.shared.cancel();
            self.voices.remove(&v.key);
            drop(v);
        }
        for e in evs {
            self.on_mixer(e);
        }
    }

    fn on_mixer(&mut self, e: MixerEvent) {
        match e {
            MixerEvent::Started(key) => {
                if let Some(c) = self.current.as_mut().filter(|c| c.key == key) {
                    c.started = true;
                    c.ever_started = true;
                    c.pending_since = None;
                    if c.buffering {
                        self.set_buffering(false);
                    }
                    self.update_state();
                }
            }
            MixerEvent::Advanced { from: _, to } => {
                if self.next.as_ref().is_some_and(|n| n.key == to) {
                    let nx = self.next.take().unwrap();
                    if let Some(old) = self.current.take() {
                        self.prev_album_key = old.load.album_key.clone();
                        self.remember_ended(&old);
                    }
                    let id = nx.load.id.clone();
                    self.current = Some(nx);
                    self.next_warm = None;
                    let gap = match self.transition() {
                        Transition::Gap(g) => Duration::from_secs_f64(g as f64 / self.rate.max(1) as f64),
                        _ => Duration::ZERO,
                    };
                    if let Some(c) = self.current.as_mut() {
                        c.pending_since = Some(Instant::now() + gap);
                        // Gapless/crossfade: there is audio flowing immediately.
                        c.ever_started = true;
                    }
                    self.emit(EngineEvent::Advanced { id });
                    if let Some(info) = self.current.as_ref().and_then(|c| c.info.clone()) {
                        self.emit(EngineEvent::TrackInfo(info));
                    }
                    self.send_transition();
                    self.refresh_gains(SETTINGS_RAMP_SEC);
                    self.update_state();
                    self.maybe_measure(0);
                }
            }
            MixerEvent::Ended(key) => {
                if self.current.as_ref().is_some_and(|c| c.key == key) {
                    let c = self.current.take().unwrap();
                    self.prev_album_key = c.load.album_key.clone();
                    self.remember_ended(&c);
                    self.emit(EngineEvent::Ended { id: c.load.id.clone() });
                    self.update_state();
                }
            }
            MixerEvent::Underrun(key, on) => {
                if self.current.as_ref().is_some_and(|c| c.key == key) {
                    self.set_buffering(on);
                }
            }
            MixerEvent::PreviewStarted(_) => {}
            MixerEvent::PreviewEnded(key) => {
                if let Some(p) = self.preview.take_if(|p| p.key == key) {
                    self.emit(EngineEvent::PreviewEnded { id: p.load.id });
                }
            }
            MixerEvent::Paused => {}
        }
    }

    fn remember_ended(&mut self, t: &Track) {
        if self.ended.len() == 8 {
            self.ended.pop_front();
        }
        self.ended.push_back((t.key, t.load.id.clone(), t.cache_key().map(str::to_string)));
    }

    fn track_by_key(&mut self, key: u64) -> Option<(u8, &mut Track)> {
        if let Some(c) = self.current.as_mut().filter(|c| c.key == key) {
            return Some((0, c));
        }
        if let Some(n) = self.next.as_mut().filter(|n| n.key == key) {
            return Some((1, n));
        }
        if let Some(p) = self.preview.as_mut().filter(|p| p.key == key) {
            return Some((2, p));
        }
        None
    }

    fn on_worker(&mut self, w: WorkerEvent) {
        match w {
            WorkerEvent::Info { key, rate, channels, duration_ms, meta, loop_ms, voices } => {
                let mut emit = None;
                let mut dur = None;
                if let Some((slot, t)) = self.track_by_key(key) {
                    let meta = *meta;
                    let info = TrackInfo {
                        id: t.load.id.clone(),
                        duration_ms: duration_ms.or(t.load.expected_duration_ms),
                        sample_rate: rate,
                        channels,
                        codec: meta.codec,
                        bitrate_kbps: meta.bitrate_kbps,
                        title: meta.title,
                        artist: meta.artist,
                        album: meta.album,
                        subsong_count: meta.subsong_count,
                        subsong: meta.subsong,
                        loop_start_ms: loop_ms.map(|l| l.0),
                        loop_end_ms: loop_ms.map(|l| l.1),
                        voice_count: voices,
                        voice_names: if voices > 0 { meta.voice_names } else { Vec::new() },
                    };
                    dur = info.duration_ms;
                    if t.info.is_none() && slot != 2 {
                        emit = Some(info.clone());
                    }
                    t.info = Some(info);
                }
                self.shared.set_voice_duration(key, dur);
                if let Some(i) = emit {
                    self.emit(EngineEvent::TrackInfo(i));
                }
                self.update_state();
            }
            WorkerEvent::Error { key, message } => {
                if let Some((slot, t)) = self.track_by_key(key) {
                    let id = t.load.id.clone();
                    self.emit(EngineEvent::Error { id: Some(id), message, recoverable: true });
                    if slot == 0 {
                        self.set_buffering(true);
                    }
                } else if let Some((_, id, _)) = self.ended.iter().rev().find(|(k, _, _)| *k == key) {
                    // Its track already ended (the error raced the mixer's end event).
                    let id = id.clone();
                    self.emit(EngineEvent::Error { id: Some(id), message, recoverable: true });
                }
            }
            WorkerEvent::Eof { key } => {
                // Decoding finished: the file is fully read, so a cached stream may be complete.
                if self.current.as_ref().is_some_and(|c| c.key == key) {
                    self.maybe_measure(0);
                }
            }
        }
    }

    fn on_cache(&mut self, e: CacheEvent) {
        let CacheEvent::Complete { cache_key, path, bytes } = e;
        let mut ids = Vec::new();
        for t in [&self.current, &self.next, &self.preview].into_iter().flatten() {
            if t.cache_key() == Some(cache_key.as_str()) && !ids.contains(&t.load.id) {
                ids.push(t.load.id.clone());
            }
        }
        for (_, id, key) in &self.ended {
            if key.as_deref() == Some(cache_key.as_str()) && !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        for id in ids {
            self.emit(EngineEvent::CacheComplete { id, cache_key: cache_key.clone(), path: path.clone(), bytes });
        }
        if self.current.as_ref().is_some_and(|c| c.cache_key() == Some(cache_key.as_str())) {
            self.maybe_measure(0);
        }
        if self.next.as_ref().is_some_and(|c| c.cache_key() == Some(cache_key.as_str())) {
            self.maybe_measure(1);
        }
    }

    fn on_loudness(&mut self, l: Loudness) {
        self.measuring.remove(&l.id);
        let mut changed = false;
        for t in [&mut self.current, &mut self.next].into_iter().flatten() {
            if t.load.id == l.id {
                // NaN = measured but failed: keeps the provisional gain and stops re-measuring
                // (a full decode) on every later trigger.
                t.measured_lufs = Some(l.lufs.unwrap_or(f32::NAN));
                changed |= l.lufs.is_some();
            }
        }
        if changed {
            self.refresh_gains(LOUDNESS_RAMP_SEC);
        }
    }

    // ---------------------------------------------------------------- periodic

    fn tick(&mut self) {
        // A seek that hasn't produced audio quickly counts as buffering.
        if let Some(c) = &self.current {
            if !c.started && c.ever_started && !c.buffering && c.pending_since.is_some_and(|t| t.elapsed() > SEEK_BUFFERING_AFTER) {
                self.set_buffering(true);
            }
        }
        if !matches!(self.mode, OutputMode::Device) {
            return;
        }
        let err = self.device_err.swap(0, Ordering::Relaxed);
        if err & ERR_REBUILD != 0 {
            self.rebuild_output();
            return;
        }
        let gen = output::device_watch::generation();
        let every = if self.dev_watched { DEVICE_POLL_WATCHED } else { DEVICE_POLL };
        if gen == self.dev_gen && self.last_poll.elapsed() < every && !matches!(self.out, Out::None) {
            return;
        }
        if matches!(self.out, Out::None) && self.last_poll.elapsed() < DEVICE_POLL {
            return;
        }
        let notified = gen != self.dev_gen;
        self.dev_gen = gen;
        // After a change notification, look once more shortly after (CoreAudio may notify before
        // every property has settled).
        let now = Instant::now();
        self.last_poll = if notified { now.checked_sub(every - Duration::from_millis(500)).unwrap_or(now) } else { now };
        let devices = output::list_devices();
        let changed = devices.len() != self.known_devices.len()
            || devices.iter().zip(&self.known_devices).any(|(a, b)| a.id != b.id || a.name != b.name || a.is_default != b.is_default);
        if changed {
            self.known_devices = devices.clone();
            *self.shared.devices.lock() = devices.clone();
            self.emit(EngineEvent::Devices(devices.clone()));
        }
        self.shared.devices_polled.store(true, Ordering::Release);
        let current_id = match &self.out {
            Out::Device(s) => Some(s.device_id.clone()),
            _ => None,
        };
        let Some(current_id) = current_id else {
            // No stream yet (no device at startup, or it failed): keep trying.
            if !devices.is_empty() && self.open_output(true) {
                let pos = self.current_position_ms();
                self.restore(pos);
            }
            return;
        };
        if devices.is_empty() {
            // Enumeration hiccup (or truly nothing): don't tear down a working stream over it;
            // a real disconnect arrives through the stream's error callback.
            return;
        }
        let default_id = devices.iter().find(|d| d.is_default).map(|d| d.id.clone());
        let wanted = match &self.selected_device {
            Some(id) if devices.iter().any(|d| &d.id == id) => Some(id.clone()),
            _ => default_id,
        };
        if let Some(w) = wanted {
            if w != current_id {
                self.rebuild_output();
            }
        } else if !devices.iter().any(|d| d.id == current_id) {
            self.rebuild_output();
        }
    }
}

fn same_source(a: &SourceSpec, b: &SourceSpec) -> bool {
    let same_stream = match (a, b) {
        (SourceSpec::Http { cache_key: ka, url: ua, .. }, SourceSpec::Http { cache_key: kb, url: ub, .. }) => ka == kb && ua == ub,
        (SourceSpec::File { path: pa, .. }, SourceSpec::File { path: pb, .. }) => pa == pb,
        _ => false,
    };
    // Clips / sub-songs / archive entries of one file are different tracks.
    same_stream && a.extras() == b.extras()
}
