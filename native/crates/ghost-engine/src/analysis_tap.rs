//! Analysis tap (DESIGN §5.7): the mixer copies its post-gain, pre-volume mix into an SPSC ring;
//! this thread runs the real-time analyzer in fixed 5 ms hops (200 Hz), stamps every frame with
//! the wall-clock time at which its last sample is *heard* (from the audible clock), and keeps a
//! short history. `frame_now` returns the frame matching the current audible time, so visuals
//! line up with the sound even with Bluetooth latency.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::{Receiver, TryRecvError};
use ghost_analysis::realtime::RealtimeAnalyzer;
use ghost_analysis::AnalysisFrame;
use parking_lot::Mutex;

use crate::clock::Clock;
use crate::mixer::TapBlock;
use crate::util::epoch_us;

const HOPS_PER_SEC: u32 = 200;
const HISTORY: usize = 400; // 2 s at 200 Hz
const SILENCE_RMS: f32 = 1e-4; // -80 dBFS
const IDLE_AFTER_US: u64 = 1_000_000;

pub enum TapMsg {
    Source { tap: rtrb::Consumer<TapBlock>, rate: u32 },
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
}

impl Default for AnalysisShared {
    fn default() -> Self {
        Self { history: Mutex::new(VecDeque::with_capacity(HISTORY)), last_active_us: AtomicU64::new(0) }
    }
}

impl AnalysisShared {
    /// Copy the frame audible right now into `out`. False when idle/silent for over a second.
    pub fn frame_now(&self, out: &mut AnalysisFrame) -> bool {
        let now = epoch_us();
        let last = self.last_active_us.load(Ordering::Relaxed);
        if last == 0 || now.saturating_sub(last) > IDLE_AFTER_US {
            return false;
        }
        let h = self.history.lock();
        let Some(f) = h.iter().rev().find(|s| s.epoch_us <= now).or_else(|| h.front()) else { return false };
        out.clone_from(&f.frame);
        true
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
    loop {
        loop {
            match rx.try_recv() {
                Ok(TapMsg::Source { tap: t, rate: r }) => {
                    tap = Some(t);
                    rate = r.max(8000);
                    hop = (rate / HOPS_PER_SEC) as usize;
                    analyzer = RealtimeAnalyzer::new(rate);
                    fifo.clear();
                }
                Ok(TapMsg::Shutdown) | Err(TryRecvError::Disconnected) => return,
                Err(TryRecvError::Empty) => break,
            }
        }
        if let Some(t) = tap.as_mut() {
            while let Ok(b) = t.pop() {
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
            if rms > SILENCE_RMS && voice != 0 {
                shared.last_active_us.fetch_max(epoch, Ordering::Relaxed);
            }
            {
                let mut h = shared.history.lock();
                let mut item = if h.len() >= HISTORY { h.pop_front().unwrap() } else { Stamped { epoch_us: 0, frame: AnalysisFrame::default() } };
                item.epoch_us = epoch;
                item.frame.clone_from(&scratch);
                h.push_back(item);
            }
            consumed += hop * 2;
            fifo_frame += hop as u64;
        }
        if consumed > 0 {
            fifo.drain(..consumed);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
