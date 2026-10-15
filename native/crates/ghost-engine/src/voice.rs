//! A voice is one decoded stream feeding the mixer: a decode worker thread writes interleaved
//! stereo at the device rate into a lock-free SPSC ring; the mixer reads it on the RT thread.
//!
//! The controller allocates voices (ring, box, shared state) and hands them to the mixer through
//! the command queue; the mixer returns finished voices through a garbage queue so nothing is ever
//! freed on the audio thread.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

use crate::dsp::{Curve, Fader, Ramp};

/// Ring capacity in seconds.
pub const RING_SECONDS: f32 = 2.0;

/// `VoiceShared::play_state`: waiting for the prefill before the first sample.
pub const PLAY_WAITING: u8 = 0;
/// Producing audio.
pub const PLAY_STARTED: u8 = 1;
/// Ran dry mid-track; waiting for the rebuffer amount.
pub const PLAY_REBUFFERING: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bus {
    Music,
    Preview,
}

/// State shared between a decode worker, the mixer and the controller.
pub struct VoiceShared {
    pub key: u64,
    /// Set by the controller to stop the worker.
    pub cancel: Arc<AtomicBool>,
    /// The worker has written its last frame.
    pub eof: AtomicBool,
    /// The worker failed (open/stall/decode error); see the worker event for the message.
    pub failed: AtomicBool,
    /// Track position (device frames) of the first frame in the ring. Valid once `origin_set`.
    pub origin: AtomicU64,
    pub origin_set: AtomicBool,
    /// Track position just past the last frame (exact, set at EOF), or u64::MAX.
    pub end_pos: AtomicU64,
    /// Estimated track length in device frames (from the container), or u64::MAX.
    pub est_end: AtomicU64,
    /// Track position just past the last frame the worker pushed into the ring (Release, after
    /// `origin`; 0 until the first push).
    pub write_pos: AtomicU64,
    /// Mixer state (`PLAY_*`), stored by the mixer on transitions only (start, run dry, recover).
    pub play_state: AtomicU8,
    /// Track position where the mixer ran dry (stored before `play_state` turns
    /// `PLAY_REBUFFERING`); with `write_pos`, the audio buffered toward the rebuffer target.
    pub stall_pos: AtomicU64,
    /// Worker thread handle, so the controller can wake it when cancelling.
    pub thread: parking_lot::Mutex<Option<std::thread::Thread>>,
    /// Gapless continuation: the next voice this voice's worker should decode into once its own
    /// source ends (same resampler, so resampled transitions stay sample-continuous).
    pub chain: parking_lot::Mutex<ChainSlot>,
}

/// A voice to continue into, handed to the worker of the voice before it.
pub struct Continuation {
    pub spec: crate::SourceSpec,
    pub shared: Arc<VoiceShared>,
    pub producer: rtrb::Producer<f32>,
}

#[derive(Default)]
pub struct ChainSlot {
    /// The worker has passed the end of this voice's source; attaching now is too late.
    pub closed: bool,
    pub next: Option<Continuation>,
}

impl VoiceShared {
    pub fn new(key: u64) -> Arc<Self> {
        Arc::new(Self {
            key,
            cancel: Arc::new(AtomicBool::new(false)),
            eof: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            origin: AtomicU64::new(0),
            origin_set: AtomicBool::new(false),
            end_pos: AtomicU64::new(u64::MAX),
            est_end: AtomicU64::new(u64::MAX),
            write_pos: AtomicU64::new(0),
            play_state: AtomicU8::new(PLAY_WAITING),
            stall_pos: AtomicU64::new(0),
            thread: parking_lot::Mutex::new(None),
            chain: parking_lot::Mutex::new(ChainSlot::default()),
        })
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(t) = self.thread.lock().as_ref() {
            t.unpark();
        }
    }

    #[inline]
    pub fn is_canceled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    /// Hand `c` to this voice's worker as its gapless continuation. Gives it back if the worker
    /// has already finished reading (the caller then starts a standalone worker).
    #[allow(clippy::result_large_err)]
    pub fn attach_next(&self, c: Continuation) -> Result<(), Continuation> {
        let mut slot = self.chain.lock();
        if slot.closed || self.is_canceled() {
            return Err(c);
        }
        slot.next = Some(c);
        Ok(())
    }

    /// Take back a continuation that the worker hasn't started yet.
    pub fn detach_next(&self) -> Option<Continuation> {
        self.chain.lock().next.take()
    }

    /// What the voice waits for, from the worker's write position and the mixer's state
    /// transitions: (`PLAY_*` state, frames decoded toward the target, target frames). The
    /// target is the prefill before the first sample, the rebuffer amount after running dry, and
    /// 0 while playing (the fill isn't tracked then: that would cost the audio thread a store per
    /// block).
    pub fn wait_progress(&self, prefill: u64, rebuffer: u64) -> (u8, u64, u64) {
        let state = self.play_state.load(Ordering::Acquire);
        let written = self.write_pos.load(Ordering::Acquire);
        match state {
            PLAY_WAITING => (state, written.saturating_sub(self.origin.load(Ordering::Acquire)), prefill),
            PLAY_REBUFFERING => (state, written.saturating_sub(self.stall_pos.load(Ordering::Relaxed)), rebuffer),
            _ => (state, 0, 0),
        }
    }
}

/// Mixer-side view of a voice (owned by the RT thread while active).
pub struct Voice {
    pub key: u64,
    /// Track sequence number (changes on every track change, not on seeks).
    pub seq: u32,
    pub bus: Bus,
    pub cons: rtrb::Consumer<f32>,
    pub shared: Arc<VoiceShared>,
    /// Track position (device frames) of the next frame to be read.
    pub pos: u64,
    pub started: bool,
    /// Fade in when playback starts (seek / resume mid-track); off for natural starts.
    pub fade_in: bool,
    pub underrun: bool,
    /// Normalisation gain.
    pub gain: Ramp,
    /// Fade envelope (micro-fades, crossfades, preview fades).
    pub env: Fader,
    /// Drop the voice once `env` reaches 0.
    pub release_when_silent: bool,
    /// When a voice becomes a tail mid-block, the frame offset in that block where it resumes.
    pub block_offset: u32,
    /// Low-water tracking (stats): the ring has filled past the threshold once since starting.
    pub low_water_armed: bool,
    pub below_low_water: bool,
}

impl Voice {
    pub fn new(key: u64, seq: u32, bus: Bus, cons: rtrb::Consumer<f32>, shared: Arc<VoiceShared>, gain_lin: f32) -> Self {
        Self {
            key,
            seq,
            bus,
            cons,
            shared,
            pos: 0,
            started: false,
            fade_in: false,
            underrun: false,
            gain: Ramp::new(gain_lin),
            env: Fader::fixed(1.0),
            release_when_silent: false,
            block_offset: 0,
            low_water_armed: false,
            below_low_water: false,
        }
    }

    #[inline]
    pub fn available(&self) -> usize {
        self.cons.slots() / 2
    }

    #[inline]
    pub fn eof(&self) -> bool {
        self.shared.eof.load(Ordering::Acquire)
    }

    #[inline]
    pub fn failed(&self) -> bool {
        self.shared.failed.load(Ordering::Acquire)
    }

    /// The engine let go of this voice (stopped or replaced). Its worker stops, possibly without
    /// marking the end (cancelled mid-read), so frames that haven't arrived never will.
    #[inline]
    pub fn cancelled(&self) -> bool {
        self.shared.cancel.load(Ordering::Acquire)
    }

    /// No more frames will ever arrive and the ring is drained.
    #[inline]
    pub fn finished(&self, offline: bool) -> bool {
        (self.eof() || (offline && self.failed())) && self.cons.is_empty()
    }

    /// Frames left until the end of the track (exact once the worker hit EOF, else estimated).
    pub fn remaining(&self) -> Option<u64> {
        let end = self.shared.end_pos.load(Ordering::Acquire);
        let end = if end != u64::MAX { end } else { self.shared.est_end.load(Ordering::Relaxed) };
        (end != u64::MAX).then(|| end.saturating_sub(self.pos))
    }

    /// Try to start playback once enough audio is buffered. Returns true when started now.
    pub fn try_start(&mut self, prefill: usize, rate: u32, offline: bool) -> bool {
        if self.started {
            return false;
        }
        let avail = self.available();
        let done = self.eof() || (offline && self.failed());
        if avail >= prefill || done {
            // The worker publishes `origin` before pushing its first frame.
            self.pos = if self.shared.origin_set.load(Ordering::Acquire) { self.shared.origin.load(Ordering::Acquire) } else { 0 };
            self.started = true;
            self.shared.play_state.store(PLAY_STARTED, Ordering::Relaxed);
            if self.fade_in {
                self.env = Fader::new(0.0, self.env.target(), (rate / 100).max(1), Curve::SCurve);
            }
            return true;
        }
        false
    }

    /// Mix `n` frames into `dst` (interleaved stereo). If `fade_out` is set, the frames are
    /// ramped to silence (used right before an underrun, so the dropout doesn't click).
    #[inline]
    pub fn mix_into(&mut self, dst: &mut [f32], n: usize, fade_out: bool) {
        if n == 0 {
            return;
        }
        let Ok(chunk) = self.cons.read_chunk(n * 2) else { return };
        let (a, b) = chunk.as_slices();
        let mut i = 0usize;
        let inv = 1.0 / n as f32;
        for src in [a, b] {
            for f in src.as_chunks::<2>().0 {
                let mut g = self.gain.step() * self.env.step();
                if fade_out {
                    g *= 1.0 - (i as f32 + 1.0) * inv;
                }
                dst[i * 2] += f[0] * g;
                dst[i * 2 + 1] += f[1] * g;
                i += 1;
            }
        }
        chunk.commit_all();
        self.pos += n as u64;
    }
}

/// Allocate a ring for a voice at `rate`.
pub fn ring(rate: u32) -> (rtrb::Producer<f32>, rtrb::Consumer<f32>) {
    let frames = (rate as f32 * RING_SECONDS) as usize;
    rtrb::RingBuffer::new(frames * 2)
}
