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
use crate::{DeviceInfo, EngineEvent, LoadProgress, LoopMode, NormalizationMode, PlaybackState, PositionInfo, Slot, SourceSpec, TrackInfo, TrackLoad};

/// Device enumeration cadence without change notifications (and the idle loop's longest sleep).
const DEVICE_POLL: Duration = Duration::from_millis(1500);
/// Safety-net enumeration cadence when CoreAudio change notifications are active.
const DEVICE_POLL_WATCHED: Duration = Duration::from_secs(30);
/// After a command, keep the housekeeping cadence fast this long (voices the mixer drops come
/// back through its garbage queue shortly after).
const BUSY_AFTER_CMD: Duration = Duration::from_secs(2);
/// Nothing playing and no commands for this long: suspend the device stream (see `OutputStream::suspend`).
const SUSPEND_STREAM_AFTER: Duration = Duration::from_secs(30);
const SEEK_BUFFERING_AFTER: Duration = Duration::from_millis(250);
/// Loudness assumed for a track nothing is known about yet: its gain until it is measured
/// (−4 dB at the default −16 LUFS target; loud uploads come out a little hot, quiet rips quiet).
const ASSUMED_LUFS: f32 = -12.0;
/// A measurement still under way that has covered this much of the track counts as its loudness
/// (a long single-file soundtrack takes minutes to download in full).
const INTERIM_TRUSTED_SECS: f32 = 180.0;
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
    /// The loop settings changed (they are read live; see `Controller::loops_changed`).
    Loops,
    SetDevice(Option<String>),
    /// Whether anyone shows the live analysis (see `Clock::analysis_wanted`).
    AnalysisDemand(bool),
    Shutdown,
}

pub enum OutputMode {
    Device,
    Offline { rate: u32, block: usize, sink: Sender<Vec<f32>> },
}

/// (track id, duration ms) of a voice, for position lookups.
type VoiceEntry = (Arc<str>, Option<u64>);

/// Retired voices whose entries are kept: the audible clock goes on naming a voice for a moment
/// (the output latency) after the mixer let go of it.
const RETIRED_VOICES: usize = 64;

/// Voice key → entry, for every voice the mixer may still play (the current track however many
/// previews come and go) and the most recently retired ones.
#[derive(Default)]
struct VoiceRegistry {
    live: HashMap<u64, VoiceEntry>,
    retired: VecDeque<(u64, VoiceEntry)>,
}

impl VoiceRegistry {
    fn get(&self, key: u64) -> Option<&VoiceEntry> {
        self.live.get(&key).or_else(|| self.retired.iter().rev().find(|e| e.0 == key).map(|e| &e.1))
    }

    fn get_mut(&mut self, key: u64) -> Option<&mut VoiceEntry> {
        match self.live.get_mut(&key) {
            Some(e) => Some(e),
            None => self.retired.iter_mut().rev().find(|e| e.0 == key).map(|e| &mut e.1),
        }
    }
}

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
    voices: Mutex<VoiceRegistry>,
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
            voices: Mutex::new(VoiceRegistry::default()),
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
        self.voices.lock().live.insert(key, (Arc::from(id), duration_ms));
    }

    /// The mixer let go of the voice (or went away with it).
    fn retire_voice(&self, key: u64) {
        let mut v = self.voices.lock();
        if let Some(e) = v.live.remove(&key) {
            if v.retired.len() >= RETIRED_VOICES {
                v.retired.pop_front();
            }
            v.retired.push_back((key, e));
        }
    }

    fn set_voice_duration(&self, key: u64, duration_ms: Option<u64>) {
        if let Some(e) = self.voices.lock().get_mut(key) {
            e.1 = duration_ms;
        }
    }

    fn voice(&self, key: u64) -> Option<(Arc<str>, Option<u64>)> {
        self.voices.lock().get(key).cloned()
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
    /// Loudness of the part measured so far while the stream downloads, and whether that part
    /// is long enough to stand for the whole track (see `gain`).
    interim_lufs: Option<f32>,
    interim_trusted: bool,
    /// Stops this track's measurement while it still reads a downloading stream.
    measure_cancel: Option<Arc<AtomicBool>>,
    info: Option<TrackInfo>,
    started: bool,
    ever_started: bool,
    /// Its voice ran dry or its decoder failed: it waits for data, not only for playback.
    stalled: bool,
    /// What `EngineEvent::Buffering` last said: a wait for data while playback is requested.
    buffering: bool,
    /// Since when playback has been requested without the voice producing audio.
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
            interim_lufs: None,
            interim_trusted: false,
            measure_cancel: None,
            info: None,
            started: false,
            ever_started: false,
            stalled: false,
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
    /// The loop settings the playing tracks were last brought in line with.
    loops_seen: (LoopMode, u32, f32),
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
    dev_tx: Sender<()>,
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
            loops_seen: init.loops.get(),
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
            dev_tx,
            dev_gen: output::device_watch::generation(),
            dev_watched: false,
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
        // Registering for device changes is the process's first CoreAudio call, which starts its
        // HAL client (~45 ms). It happens here, on the engine thread: in new() it ran on the
        // caller's thread, which is Electron's main thread, ahead of the window.
        if matches!(self.mode, OutputMode::Device) && output::device_watch::watching() {
            output::device_watch::subscribe(self.dev_tx.clone());
            self.dev_watched = true;
        }
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
        for t in [&self.current, &self.next, &self.preview].into_iter().flatten() {
            if let Some(c) = &t.measure_cancel {
                c.store(true, Ordering::Relaxed);
            }
        }
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
            self.shared.retire_voice(v.key);
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
            // Not heard yet (loaded paused): where its voice starts.
            cur.shared.as_ref().map_or(0, |s| s.origin.load(Ordering::Relaxed) * 1000 / self.rate.max(1) as u64)
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
                cur.stalled = false;
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
        // The mixer takes commands in the device callback: a suspended stream must run again first.
        if let Out::Device(s) = &mut self.out {
            if s.resume().is_err() {
                self.device_err.fetch_or(ERR_REBUILD, Ordering::Relaxed);
            }
        }
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
        // A measurement still reading the stream as it downloads stops with its track (it would
        // fetch the rest of the file for nothing); one that has all the data finishes and is kept.
        if let Some(c) = &t.measure_cancel {
            if !t.cache_key().is_some_and(|k| self.cache.complete_path(k).is_some()) {
                c.store(true, Ordering::Relaxed);
            }
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
        self.gain(t, self.album_mode_for(&t.load, prev, next))
    }

    /// A preview stands alone: album gain only when that is the mode.
    fn preview_gain(&self, t: &Track) -> f32 {
        self.gain(t, self.norm_mode == NormalizationMode::Album)
    }

    /// Track (or album) gain for `t` (see [`gain_lufs`]).
    fn gain(&self, t: &Track, album: bool) -> f32 {
        if !self.norm_enabled {
            return 0.0;
        }
        let interim = t.interim_lufs.map(|l| (l, t.interim_trusted));
        (self.norm_target - gain_lufs(t.load.lufs.or(t.measured_lufs), t.load.album_lufs, album, interim)).clamp(-24.0, 12.0)
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
            cmds.push((2, p.key, self.preview_gain(p)));
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

    fn slot_mut(&mut self, slot: u8) -> Option<&mut Track> {
        match slot {
            0 => self.current.as_mut(),
            1 => self.next.as_mut(),
            _ => self.preview.as_mut(),
        }
    }

    /// Measure the loudness of the track in `slot` (0 current, 1 next, 2 preview). A stream
    /// still downloading is measured as it arrives, through background reads that never get
    /// ahead of playback: the part measured so far already shows a loud track (interim
    /// results), and a clip (a chapter of a long video) needs only its own bytes, not the whole
    /// video. A preview of a whole stream waits for it instead: measuring must not download
    /// more than listening does.
    fn maybe_measure(&mut self, slot: u8) {
        let Some(t) = self.slot_mut(slot) else { return };
        if t.load.lufs.is_some() || t.measured_lufs.is_some() {
            return;
        }
        let (id, source) = (t.load.id.clone(), t.load.source.clone());
        if self.measuring.contains(&id) {
            return;
        }
        let complete = match &source {
            SourceSpec::File { .. } => true,
            SourceSpec::Http { cache_key, .. } => self.cache.complete_path(cache_key).is_some(),
        };
        if !complete && slot == 2 && !source.extras().has_clip() {
            return;
        }
        let cancel = if complete { self.measure_cancel.clone() } else { Arc::new(AtomicBool::new(false)) };
        if !complete {
            if let Some(t) = self.slot_mut(slot) {
                t.measure_cancel = Some(cancel.clone());
            }
        }
        self.measuring.insert(id.clone());
        let (cache, events, loud) = (self.cache.clone(), self.events.clone(), self.loud_tx.clone());
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
                if let Some(c) = self.current.as_mut() {
                    // A track not producing audio (seeked or ran dry while paused) has waited only
                    // for permission so far: buffering counts from now.
                    if c.stalled || (!c.started && c.ever_started) {
                        c.pending_since = Some(Instant::now());
                    }
                    self.playing = true;
                    self.send(MixerCmd::Play);
                    self.update_state();
                }
            }
            Cmd::Pause => {
                self.playing = false;
                self.send(MixerCmd::Pause);
                // Paused, nothing is waited for: a stall shows again once playback is requested.
                self.set_buffering(false);
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
            Cmd::StopPreview => {
                // Its fade plays from what is buffered; nothing more is needed from the stream.
                if let Some(s) = self.preview.as_ref().and_then(|p| p.shared.as_ref()) {
                    s.cancel();
                }
                self.send(MixerCmd::StopPreview);
            }
            Cmd::Loops => self.loops_changed(),
            Cmd::AnalysisDemand(on) => {
                let was = self.shared.clock.analysis_wanted.swap(on, Ordering::Relaxed);
                // back on: the analysis thread may be in its deep-idle poll (2 s)
                if on && !was {
                    let _ = self.tap_tx.send(TapMsg::Wake);
                }
            }
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
            c.stalled = false;
            c.pending_since = Some(Instant::now());
            self.rechain(old_shared);
        }
    }

    /// The loop settings changed. The loop stages of playing tracks follow them at once; each
    /// looped track's worker then reports its new length and end estimate. Waking the workers
    /// gets that done promptly; an Endless track stops counting on its old end right here, so
    /// it can't crossfade or advance on it meanwhile (a worker may wait on the network).
    fn loops_changed(&mut self) {
        let now = self.loops.get();
        if now == self.loops_seen {
            return;
        }
        self.loops_seen = now;
        for v in self.voices.values().filter(|v| v.loop_bound.load(Ordering::Acquire)) {
            if now.0 == LoopMode::Endless {
                v.est_end.store(u64::MAX, Ordering::Release);
            }
            v.wake();
        }
        // A worker that already decoded to the end of the old plan (its last seconds are in the
        // ring) can't take up the new one: start the track over where it is heard.
        let finished = self.current.as_ref().and_then(|c| c.shared.as_ref()).is_some_and(|s| s.loop_bound.load(Ordering::Acquire) && s.chain.lock().closed);
        if finished {
            let pos = self.current_position_ms();
            self.seek(pos);
        }
    }

    fn preview(&mut self, load: TrackLoad, start_ms: u64) {
        if let Some(old) = self.preview.take() {
            self.cancel_track(&old);
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        let mut t = Track::new(load, seq);
        let gain = self.preview_gain(&t);
        t.gain_db = gain;
        if let Some((v, sh)) = self.make_voice(&t.load, start_ms, Bus::Preview, seq, gain) {
            t.key = v.key;
            t.shared = Some(sh);
            self.send(MixerCmd::Preview(v));
            self.preview = Some(t);
            // Measured like a played track: the preview evens out, and the track's first real
            // play starts at the right level.
            self.maybe_measure(2);
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
            self.shared.retire_voice(v.key);
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
                    c.stalled = false;
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
                if let Some(c) = self.current.as_mut().filter(|c| c.key == key) {
                    c.stalled = on;
                    if !on {
                        c.pending_since = None;
                    }
                    // Ran dry as a pause faded out: it shows once playback is requested (`tick`).
                    let show = on && self.playing;
                    self.set_buffering(show);
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
            WorkerEvent::Info { key, rate, channels, duration_ms, looped, meta, loop_ms, voices } => {
                let mut emit = None;
                let mut dur = None;
                if let Some((slot, t)) = self.track_by_key(key) {
                    let meta = *meta;
                    let info = TrackInfo {
                        id: t.load.id.clone(),
                        // A looped track without a length is Endless, not of unknown length.
                        duration_ms: if looped { duration_ms } else { duration_ms.or(t.load.expected_duration_ms) },
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
                    // First heard of, or a new voice of it (a seek) found another length (the
                    // loop settings changed since the last one opened).
                    if slot != 2 && t.info.as_ref().is_none_or(|i| i.duration_ms != info.duration_ms) {
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
            WorkerEvent::Duration { key, duration_ms } => {
                let mut emit = None;
                if let Some((slot, t)) = self.track_by_key(key) {
                    if let Some(info) = t.info.as_mut().filter(|i| i.duration_ms != duration_ms) {
                        info.duration_ms = duration_ms;
                        // The playing track's length changed under the player; a preloaded one
                        // reports it when it starts.
                        if slot == 0 {
                            emit = Some(info.clone());
                        }
                    }
                }
                self.shared.set_voice_duration(key, duration_ms);
                if let Some(i) = emit {
                    self.emit(EngineEvent::TrackInfo(i));
                }
            }
            WorkerEvent::Error { key, message } => {
                if let Some((slot, t)) = self.track_by_key(key) {
                    let id = t.load.id.clone();
                    if slot == 0 {
                        t.stalled = true;
                    }
                    self.emit(EngineEvent::Error { id: Some(id), message, recoverable: true });
                    if slot == 0 && self.playing {
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
        if self.preview.as_ref().is_some_and(|c| c.cache_key() == Some(cache_key.as_str())) {
            self.maybe_measure(2);
        }
    }

    fn on_loudness(&mut self, l: Loudness) {
        let mut changed = false;
        if l.interim {
            let trusted = l.secs >= INTERIM_TRUSTED_SECS;
            for t in [&mut self.current, &mut self.next, &mut self.preview].into_iter().flatten() {
                // Every change is a ramp: only moves of 1 LU or more.
                if let (true, None, Some(v)) = (t.load.id == l.id, t.measured_lufs, l.lufs) {
                    if t.interim_lufs.is_none_or(|p| (v - p).abs() >= 1.0) || trusted != t.interim_trusted {
                        t.interim_lufs = Some(v);
                        t.interim_trusted = trusted;
                        changed = true;
                    }
                }
            }
            if changed {
                self.refresh_gains(LOUDNESS_RAMP_SEC);
            }
            return;
        }
        self.measuring.remove(&l.id);
        let mut restart = Vec::new();
        let cache = &self.cache;
        for (slot, t) in [&mut self.current, &mut self.next, &mut self.preview].into_iter().enumerate() {
            let Some(t) = t.as_mut().filter(|t| t.load.id == l.id) else { continue };
            t.measure_cancel = None;
            if l.canceled {
                // The job of a dropped instance of this track: this one measures on its own.
                restart.push(slot as u8);
                continue;
            }
            // Measured while it downloaded, it can fail with the network (a stall): the whole
            // stream arriving later tries again. Any other failure is final: NaN keeps the
            // provisional gain and stops re-measuring (a full decode) on every trigger.
            let retry = l.lufs.is_none() && matches!(&t.load.source, SourceSpec::Http { cache_key, .. } if cache.complete_path(cache_key).is_none());
            if !retry {
                t.measured_lufs = Some(l.lufs.unwrap_or(f32::NAN));
            }
            changed |= l.lufs.is_some();
        }
        for slot in restart {
            self.maybe_measure(slot);
        }
        if changed {
            self.refresh_gains(LOUDNESS_RAMP_SEC);
        }
    }

    // ---------------------------------------------------------------- periodic

    fn tick(&mut self) {
        // Playback requested and no audio coming quickly (after a seek, or resuming a track that
        // ran dry) counts as buffering. Paused, a voice only waits for permission.
        if let Some(c) = &self.current {
            let waiting = c.stalled || (!c.started && c.ever_started);
            if self.playing && waiting && !c.buffering && c.pending_since.is_some_and(|t| t.elapsed() > SEEK_BUFFERING_AFTER) {
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
        if !self.playing && self.preview.is_none() && self.last_cmd.elapsed() >= SUSPEND_STREAM_AFTER {
            if let Out::Device(s) = &mut self.out {
                s.suspend();
            }
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

/// The loudness a track's gain is set from: its own (`album`: its album's), once measured. Until
/// then its album's loudness (what the caller knows of it) is the best guess, else
/// `ASSUMED_LUFS`. A measurement under way (`interim`: loudness so far, and whether it covers
/// enough of the track to stand for it) may raise that guess at once, as the part heard so far
/// shows a loud track but not that the rest stays quiet, and replaces it once trusted.
fn gain_lufs(own: Option<f32>, album_lufs: Option<f32>, album: bool, interim: Option<(f32, bool)>) -> f32 {
    let known = |l: &f32| l.is_finite();
    let (own, album_lufs) = (own.filter(known), album_lufs.filter(known));
    let measured = if album { album_lufs.or(own) } else { own };
    measured.unwrap_or_else(|| {
        let guess = album_lufs.unwrap_or(ASSUMED_LUFS);
        match interim.filter(|(l, _)| l.is_finite()) {
            Some((l, true)) => l,
            Some((l, false)) => l.max(guess),
            None => guess,
        }
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A controller without an output (mixer commands go nowhere), driven by hand.
    fn controller() -> (Controller, Receiver<EngineEvent>) {
        let dir = std::env::temp_dir().join(format!("ghost-ctl-test-{}-{}", std::process::id(), epoch_us()));
        let (events, rx) = crossbeam_channel::unbounded();
        let (_, cmd_rx) = crossbeam_channel::unbounded();
        let (tap_tx, _) = crossbeam_channel::unbounded();
        let (sink, _) = crossbeam_channel::unbounded();
        let c = Controller::new(ControllerInit {
            cache: CacheManager::new_for_test(dir, 1 << 30, Duration::from_secs(8)),
            events,
            shared: Arc::new(Shared::new()),
            cmd_rx,
            jobs: Arc::new(JobPool::new(1)),
            loops: Arc::new(LoopSettings::default()),
            tap_tx,
            mode: OutputMode::Offline { rate: 48_000, block: 512, sink },
        });
        (c, rx)
    }

    /// State and buffering events since the last call.
    fn transport(rx: &Receiver<EngineEvent>) -> Vec<String> {
        rx.try_iter()
            .filter_map(|e| match e {
                EngineEvent::State { state, .. } => Some(format!("{state:?}")),
                EngineEvent::Buffering { buffering, .. } => Some(format!("buffering {buffering}")),
                _ => None,
            })
            .collect()
    }

    /// Buffering is a wait for data while playback is requested. Paused, a voice only waits for
    /// permission: a seek, or a voice that ran dry, shows as paused, and a wait that goes on once
    /// playback resumes shows as buffering again.
    #[test]
    fn buffering_shows_only_while_playback_is_requested() {
        let (mut c, rx) = controller();
        let load = TrackLoad { id: "t".into(), source: SourceSpec::file("t.wav"), lufs: None, album_lufs: None, album_key: None, expected_duration_ms: None };
        let mut t = Track::new(load, 1);
        t.key = 7;
        t.info = Some(TrackInfo::default());
        c.current = Some(t);
        c.handle(Cmd::Play);
        c.on_mixer(MixerEvent::Started(7));
        transport(&rx);
        // What `seek` leaves behind, long enough ago to count as buffering if it were playing.
        let seeked = |c: &mut Controller| {
            let t = c.current.as_mut().unwrap();
            t.started = false;
            t.pending_since = Some(Instant::now() - SEEK_BUFFERING_AFTER * 4);
        };
        let waited = |c: &mut Controller| c.current.as_mut().unwrap().pending_since = Some(Instant::now() - SEEK_BUFFERING_AFTER * 4);

        // Seeking while paused.
        c.handle(Cmd::Pause);
        seeked(&mut c);
        c.tick();
        assert_eq!(transport(&rx), ["Paused"]);
        // Resumed: buffering only if the audio doesn't come quickly.
        c.handle(Cmd::Play);
        c.tick();
        assert_eq!(transport(&rx), ["Playing"]);
        waited(&mut c);
        c.tick();
        assert_eq!(transport(&rx), ["buffering true", "Buffering"]);
        c.on_mixer(MixerEvent::Started(7));
        assert_eq!(transport(&rx), ["buffering false", "Playing"]);

        // Pausing during an underrun.
        c.on_mixer(MixerEvent::Underrun(7, true));
        assert_eq!(transport(&rx), ["buffering true", "Buffering"]);
        c.handle(Cmd::Pause);
        waited(&mut c);
        c.tick();
        assert_eq!(transport(&rx), ["buffering false", "Paused"]);
        c.handle(Cmd::Play);
        c.tick();
        assert_eq!(transport(&rx), ["Playing"]);
        waited(&mut c);
        c.tick();
        assert_eq!(transport(&rx), ["buffering true", "Buffering"]);
        c.on_mixer(MixerEvent::Underrun(7, false));
        assert_eq!(transport(&rx), ["buffering false", "Playing"]);
    }

    /// The current track keeps its id and length however many other voices come and go.
    #[test]
    fn registry_keeps_live_voices() {
        let s = Shared::new();
        s.register_voice(1, "current", Some(60_000));
        for key in 2..200 {
            s.register_voice(key, "preview", None);
            s.retire_voice(key);
        }
        assert_eq!(s.voice(1), Some((Arc::from("current"), Some(60_000))));
        // Retired ones linger a while, then go.
        assert!(s.voice(199).is_some() && s.voice(2).is_none());
        assert_eq!(s.voices.lock().retired.len(), RETIRED_VOICES);
        s.retire_voice(1);
        s.set_voice_duration(1, Some(1));
        assert_eq!(s.voice(1), Some((Arc::from("current"), Some(1))));
    }

    #[test]
    fn gain_lufs_prefers_measurements_then_the_best_guess() {
        let nan = f32::NAN;
        for (own, album_lufs, album, interim, expect) in [
            // Measured: the track's own loudness, or in album mode the album's.
            (Some(-20.0), Some(-22.0), false, None, -20.0),
            (Some(-20.0), Some(-22.0), true, None, -22.0),
            (Some(-20.0), None, true, None, -20.0),
            // Not yet: its album's loudness is the better guess, else the assumption.
            (None, Some(-22.0), false, None, -22.0),
            (None, None, false, None, ASSUMED_LUFS),
            // A failed measurement (NaN) is no measurement.
            (Some(nan), Some(-22.0), false, None, -22.0),
            // Under way: may say "louder" at once, "quieter" only once it covers enough.
            (None, None, false, Some((-6.0, false)), -6.0),
            (None, None, false, Some((-30.0, false)), ASSUMED_LUFS),
            (None, Some(-22.0), false, Some((-25.0, false)), -22.0),
            (None, None, false, Some((-30.0, true)), -30.0),
            // A finished measurement wins over one under way.
            (Some(-20.0), None, false, Some((-6.0, true)), -20.0),
        ] {
            assert_eq!(gain_lufs(own, album_lufs, album, interim), expect, "{own:?} {album_lufs:?} album={album} {interim:?}");
        }
    }
}
