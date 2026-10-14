//! Audible clock (DESIGN §5.8).
//!
//! The mixer publishes one record per contiguous piece of output ("segment"): which voice/track
//! it came from, the track position of its first frame, whether the position advances, and the
//! wall-clock time at which that first frame will actually be heard (callback time + output
//! latency + limiter delay). Readers (position queries, the analysis thread) look up the segment
//! covering "now" or a given device frame. Writes are wait-free (per-slot seqlocks over atomics),
//! so the RT thread never blocks.

use std::sync::atomic::{fence, AtomicU64, Ordering};

const SLOTS: usize = 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Segment {
    /// Device frame index of the first frame (mix timeline).
    pub dev_frame: u64,
    pub frames: u32,
    pub rate: u32,
    /// Wall-clock µs at which `dev_frame` is audible.
    pub epoch_us: u64,
    /// Voice key (0 = nothing playing).
    pub voice: u64,
    pub seq: u32,
    /// Track position (device frames) at `dev_frame`.
    pub pos: u64,
    pub advancing: bool,
}

impl Segment {
    /// Track position at a device frame inside (or after) this segment.
    pub fn pos_at_frame(&self, dev_frame: u64) -> u64 {
        if !self.advancing {
            return self.pos;
        }
        let off = dev_frame.saturating_sub(self.dev_frame).min(self.frames as u64);
        self.pos + off
    }

    /// Track position (fractional frames) at wall-clock time `now_us`.
    pub fn pos_at_epoch(&self, now_us: u64) -> f64 {
        if !self.advancing || self.rate == 0 {
            return self.pos as f64;
        }
        let dt = now_us.saturating_sub(self.epoch_us) as f64 / 1e6;
        let off = (dt * self.rate as f64).min(self.frames as f64);
        self.pos as f64 + off
    }

    pub fn epoch_of_frame(&self, dev_frame: u64) -> u64 {
        if self.rate == 0 {
            return self.epoch_us;
        }
        let off = dev_frame as i64 - self.dev_frame as i64;
        (self.epoch_us as i64 + off * 1_000_000 / self.rate as i64).max(0) as u64
    }
}

#[derive(Default)]
struct Slot {
    seq: AtomicU64,
    dev_frame: AtomicU64,
    frames_rate: AtomicU64,
    epoch_us: AtomicU64,
    voice: AtomicU64,
    seq_adv: AtomicU64,
    pos: AtomicU64,
}

pub struct Clock {
    slots: Box<[Slot]>,
    write_idx: AtomicU64,
    /// Latest measured device output latency in µs (diagnostics).
    pub latency_us: AtomicU64,
    /// Device frames rendered so far.
    pub rendered: AtomicU64,
}

impl Default for Clock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock {
    pub fn new() -> Self {
        Self {
            slots: (0..SLOTS).map(|_| Slot::default()).collect(),
            write_idx: AtomicU64::new(0),
            latency_us: AtomicU64::new(0),
            rendered: AtomicU64::new(0),
        }
    }

    /// RT-safe: publish a segment.
    pub fn push(&self, s: &Segment) {
        let idx = self.write_idx.load(Ordering::Relaxed);
        let slot = &self.slots[(idx as usize) % SLOTS];
        let v = slot.seq.load(Ordering::Relaxed);
        slot.seq.store(v.wrapping_add(1), Ordering::Relaxed);
        fence(Ordering::Release);
        slot.dev_frame.store(s.dev_frame, Ordering::Relaxed);
        slot.frames_rate.store(((s.frames as u64) << 32) | s.rate as u64, Ordering::Relaxed);
        slot.epoch_us.store(s.epoch_us, Ordering::Relaxed);
        slot.voice.store(s.voice, Ordering::Relaxed);
        slot.seq_adv.store(((s.seq as u64) << 1) | s.advancing as u64, Ordering::Relaxed);
        slot.pos.store(s.pos, Ordering::Relaxed);
        slot.seq.store(v.wrapping_add(2), Ordering::Release);
        self.write_idx.store(idx + 1, Ordering::Release);
    }

    fn read(&self, idx: u64) -> Option<Segment> {
        let slot = &self.slots[(idx as usize) % SLOTS];
        for _ in 0..8 {
            let s1 = slot.seq.load(Ordering::Acquire);
            if s1 & 1 == 1 {
                std::hint::spin_loop();
                continue;
            }
            let dev_frame = slot.dev_frame.load(Ordering::Relaxed);
            let fr = slot.frames_rate.load(Ordering::Relaxed);
            let epoch_us = slot.epoch_us.load(Ordering::Relaxed);
            let voice = slot.voice.load(Ordering::Relaxed);
            let sa = slot.seq_adv.load(Ordering::Relaxed);
            let pos = slot.pos.load(Ordering::Relaxed);
            fence(Ordering::Acquire);
            if slot.seq.load(Ordering::Relaxed) == s1 {
                return Some(Segment {
                    dev_frame,
                    frames: (fr >> 32) as u32,
                    rate: fr as u32,
                    epoch_us,
                    voice,
                    seq: (sa >> 1) as u32,
                    pos,
                    advancing: sa & 1 == 1,
                });
            }
        }
        None
    }

    /// Iterate segments newest → oldest (bounded by ring size, skipping torn reads).
    fn newest_first(&self) -> impl Iterator<Item = Segment> + '_ {
        let w = self.write_idx.load(Ordering::Acquire);
        let oldest = w.saturating_sub(SLOTS as u64 - 8);
        (oldest..w).rev().filter_map(move |i| self.read(i))
    }

    /// Segment audible at wall-clock `now_us`: the newest one whose first frame is already
    /// audible; if none is audible yet, the oldest known one.
    pub fn at_epoch(&self, now_us: u64) -> Option<Segment> {
        let mut last = None;
        for s in self.newest_first() {
            if s.epoch_us <= now_us {
                return Some(s);
            }
            last = Some(s);
        }
        last
    }

    /// Segment containing device frame `f` (or the closest preceding one).
    pub fn at_frame(&self, f: u64) -> Option<Segment> {
        let mut last = None;
        for s in self.newest_first() {
            if s.dev_frame <= f {
                return Some(s);
            }
            last = Some(s);
        }
        last
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_by_epoch_and_frame() {
        let c = Clock::new();
        for i in 0..2000u64 {
            c.push(&Segment {
                dev_frame: i * 512,
                frames: 512,
                rate: 48_000,
                epoch_us: 1_000_000 + i * 512 * 1_000_000 / 48_000,
                voice: 7,
                seq: 1,
                pos: i * 512,
                advancing: true,
            });
        }
        let s = c.at_frame(1999 * 512 + 100).unwrap();
        assert_eq!(s.dev_frame, 1999 * 512);
        assert_eq!(s.pos_at_frame(1999 * 512 + 100), 1999 * 512 + 100);
        let now = 1_000_000 + 1990 * 512 * 1_000_000 / 48_000 + 5_000;
        let s = c.at_epoch(now).unwrap();
        assert_eq!(s.dev_frame, 1990 * 512);
        let p = s.pos_at_epoch(now);
        assert!((p - (1990.0 * 512.0 + 240.0)).abs() < 1.0);
    }
}
