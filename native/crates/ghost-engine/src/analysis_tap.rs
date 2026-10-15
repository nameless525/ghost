//! Analysis tap (DESIGN §5.7): the mixer copies its post-gain, pre-volume mix into an SPSC ring;
//! this thread runs the real-time analyzer in fixed 5 ms hops (200 Hz), stamps every frame with
//! the wall-clock time at which its last sample is *heard* (from the audible clock), and keeps a
//! short history. `frame_now` returns the frame matching the current audible time, so visuals
//! line up with the sound even with Bluetooth latency.
//!
//! Idle cost: the mixer stops feeding the tap shortly after it goes idle, so this thread backs
//! off to a slow poll, and consumers of `frame_now` (the shared-memory publisher) can block in
//! `wait_active` until audio flows again instead of polling.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError};
use ghost_analysis::realtime::RealtimeAnalyzer;
use ghost_analysis::AnalysisFrame;
use parking_lot::{Condvar, Mutex};

use crate::clock::Clock;
use crate::mixer::TapBlock;
use crate::util::epoch_us;

const HOPS_PER_SEC: u32 = 200;
const HISTORY: usize = 400; // 2 s at 200 Hz
const SILENCE_RMS: f32 = 1e-4; // -80 dBFS
const IDLE_AFTER_US: u64 = 1_000_000;
/// Poll interval while tap blocks are flowing. Device callbacks arrive every ~10–21 ms and a
/// block's frames become audible one output latency later (typically 10–30 ms, Bluetooth 100+),
/// so frames analysed up to 8 ms after their block arrived are still ready before they're heard.
const ACTIVE_POLL: Duration = Duration::from_millis(8);
/// Poll once the tap has been quiet for `IDLE_AFTER_QUIET`.
const IDLE_POLL: Duration = Duration::from_millis(100);
const IDLE_AFTER_QUIET: Duration = Duration::from_millis(500);
/// Quiet this long (and no `Wake`): nothing is about to play, so sleep until a command wakes us
/// (the tap ring holds seconds of audio, so even a missed wake loses nothing).
const DEEP_IDLE_POLL: Duration = Duration::from_secs(2);
const DEEP_IDLE_AFTER: Duration = Duration::from_secs(5);

pub enum TapMsg {
    Source { tap: rtrb::Consumer<TapBlock>, rate: u32 },
    /// Audio may start soon (play / load / seek / preview): poll actively again.
    Wake,
    Shutdown,
}

struct Stamped {
    epoch_us: u64,
    frame: AnalysisFrame,
}

pub struct AnalysisShared {
    history: Mutex<VecDeque<Stamped>>,
    /// Audible epoch of the most recent non-silent frame.
    last_active_us: AtomicU64,
    /// `wait_active` support: waiters count, generation bumped on activity, and its condvar.
    waiters: AtomicU32,
    activity: Mutex<u64>,
    activity_cv: Condvar,
}

impl Default for AnalysisShared {
    fn default() -> Self {
        Self {
            history: Mutex::new(VecDeque::with_capacity(HISTORY)),
            last_active_us: AtomicU64::new(0),
            waiters: AtomicU32::new(0),
            activity: Mutex::new(0),
            activity_cv: Condvar::new(),
        }
    }
}

impl AnalysisShared {
    fn active_at(&self, now: u64) -> bool {
        let last = self.last_active_us.load(Ordering::SeqCst);
        last != 0 && now.saturating_sub(last) <= IDLE_AFTER_US
    }

    /// Copy the frame audible right now into `out`. False when idle/silent for over a second.
    pub fn frame_now(&self, out: &mut AnalysisFrame) -> bool {
        let now = epoch_us();
        if !self.active_at(now) {
            return false;
        }
        let h = self.history.lock();
        let Some(f) = h.iter().rev().find(|s| s.epoch_us <= now).or_else(|| h.front()) else { return false };
        out.clone_from(&f.frame);
        true
    }

    /// Block until `frame_now` has something (non-silent audio is being analysed), `cancel` is
    /// set and `wake_all` called, or `timeout` passes. Returns whether frames are available.
    pub fn wait_active(&self, timeout: Duration, cancel: &AtomicBool) -> bool {
        let deadline = Instant::now() + timeout;
        self.waiters.fetch_add(1, Ordering::SeqCst);
        let mut g = self.activity.lock();
        let gen = *g;
        let active = loop {
            if self.active_at(epoch_us()) || *g != gen {
                break true;
            }
            if cancel.load(Ordering::SeqCst) || self.activity_cv.wait_until(&mut g, deadline).timed_out() {
                break self.active_at(epoch_us());
            }
        };
        drop(g);
        self.waiters.fetch_sub(1, Ordering::SeqCst);
        active
    }

    /// Wake every `wait_active` caller (e.g. after setting its cancel flag).
    pub fn wake_all(&self) {
        let mut g = self.activity.lock();
        *g = g.wrapping_add(1);
        self.activity_cv.notify_all();
    }

    /// Analysis thread: a non-silent frame audible at `epoch` was stored.
    fn mark_active(&self, epoch: u64) {
        let prev = self.last_active_us.fetch_max(epoch, Ordering::SeqCst);
        let now = epoch_us();
        // Only the idle → active edge needs a wake-up (waiters sleep only while idle).
        let was_idle = prev == 0 || now.saturating_sub(prev) > IDLE_AFTER_US / 2;
        if was_idle && self.waiters.load(Ordering::SeqCst) > 0 {
            self.wake_all();
        }
    }
}

pub fn spawn(shared: Arc<AnalysisShared>, clock: Arc<Clock>, rx: Receiver<TapMsg>) -> std::thread::JoinHandle<()> {
    crate::util::spawn_named("ghost-analysis", move || run(shared, clock, rx))
}

fn run(shared: Arc<AnalysisShared>, clock: Arc<Clock>, rx: Receiver<TapMsg>) {
    let mut tap: Option<rtrb::Consumer<TapBlock>> = None;
    let mut rate = 48_000u32;
    let mut hop = (rate / HOPS_PER_SEC) as usize;
    let mut analyzer = RealtimeAnalyzer::new(rate);
    let mut fifo: Vec<f32> = Vec::with_capacity(16_384);
    let mut fifo_frame: u64 = 0;
    let mut last_track: (u64, u32) = (0, 0);
    let mut scratch = AnalysisFrame::default();
    let mut last_data = Instant::now();
    let mut wait = ACTIVE_POLL;
    loop {
        // Sleep until the next poll, waking early for commands.
        let mut msg = rx.recv_timeout(wait);
        loop {
            match msg {
                Ok(TapMsg::Source { tap: t, rate: r }) => {
                    tap = Some(t);
                    rate = r.max(8000);
                    hop = (rate / HOPS_PER_SEC) as usize;
                    analyzer = RealtimeAnalyzer::new(rate);
                    fifo.clear();
                    last_data = Instant::now();
                }
                Ok(TapMsg::Wake) => {
                    last_data = Instant::now();
                    wait = ACTIVE_POLL;
                }
                Ok(TapMsg::Shutdown) | Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => break,
            }
            msg = rx.try_recv().map_err(|e| match e {
                crossbeam_channel::TryRecvError::Empty => RecvTimeoutError::Timeout,
                crossbeam_channel::TryRecvError::Disconnected => RecvTimeoutError::Disconnected,
            });
        }
        let mut got = false;
        if let Some(t) = tap.as_mut() {
            while let Ok(b) = t.pop() {
                got = true;
                let expected = fifo_frame + (fifo.len() / 2) as u64;
                if fifo.is_empty() || b.dev_frame != expected {
                    // Start, or a gap (dropped blocks / device switch): restart the hop grid.
                    fifo.clear();
                    fifo_frame = b.dev_frame;
                }
                fifo.extend_from_slice(&b.data[..b.frames as usize * 2]);
            }
        }
        let mut consumed = 0usize;
        while fifo.len() - consumed >= hop * 2 {
            let samples = &fifo[consumed..consumed + hop * 2];
            let last_frame = fifo_frame + hop as u64 - 1;
            let seg = clock.at_frame(last_frame);
            let (voice, seq, pos_ms, epoch) = match seg {
                Some(s) => (s.voice, s.seq, s.pos_at_frame(last_frame) as f64 * 1000.0 / s.rate.max(1) as f64, s.epoch_of_frame(last_frame)),
                None => (0, 0, 0.0, epoch_us()),
            };
            if (voice, seq) != last_track {
                // New track or seek: don't smear smoothing across the discontinuity.
                if last_track.0 != 0 {
                    analyzer.reset();
                }
                last_track = (voice, seq);
            }
            analyzer.push_interleaved(samples, 2);
            analyzer.compute(hop as f32 / rate as f32, &mut scratch);
            scratch.position_ms = pos_ms;
            scratch.track_seq = seq;
            let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
            {
                let mut h = shared.history.lock();
                let mut item = if h.len() >= HISTORY { h.pop_front().unwrap() } else { Stamped { epoch_us: 0, frame: AnalysisFrame::default() } };
                item.epoch_us = epoch;
                item.frame.clone_from(&scratch);
                h.push_back(item);
            }
            if rms > SILENCE_RMS && voice != 0 {
                shared.mark_active(epoch);
            }
            consumed += hop * 2;
            fifo_frame += hop as u64;
        }
        if consumed > 0 {
            fifo.drain(..consumed);
        }
        if got {
            last_data = Instant::now();
            wait = ACTIVE_POLL;
        } else if last_data.elapsed() > DEEP_IDLE_AFTER {
            wait = DEEP_IDLE_POLL;
        } else if last_data.elapsed() > IDLE_AFTER_QUIET {
            wait = IDLE_POLL;
        }
    }
}
