//! Real-time mixer / sequencer (DESIGN §5.2, §5.5).
//!
//! ```text
//! current ─┐ (gain, envelope)                                  ┌─ tap → analysis
//! tails ───┼─▶ MUSIC ─▶ transport fade ─▶ duck ─▶ overlay LPF ─┤
//! next  ───┘                                                   ├─▶ master vol ─▶ device fade ─▶ limiter ─▶ out
//! preview ──────────▶ PREVIEW ──────────────────────────────────┘
//! ```
//!
//! Runs on the output callback: no allocation, no locks, no I/O. Commands arrive on an SPSC queue;
//! events, finished voices and analysis-tap blocks leave on SPSC queues. Voices are boxed by the
//! controller and handed back through the garbage queue so they are freed off the RT thread.

#[cfg(test)]
mod tests;

use std::sync::Arc;

use crate::clock::{Clock, Segment};
use crate::dsp::limiter::Limiter;
use crate::dsp::overlay::OverlayFilter;
use crate::dsp::{Curve, DbRamp, Fader, Ramp};
use crate::voice::{Bus, Voice};

/// Largest block rendered in one pass (bigger callbacks are split).
pub const MAX_BLOCK: usize = 512;
const MAX_TAILS: usize = 8;
const MAX_SEGMENTS: usize = 16;

pub const MICRO_FADE_SEC: f32 = 0.008;
pub const SWITCH_FADE_SEC: f32 = 0.010;
pub const PREVIEW_FADE_IN_SEC: f32 = 0.300;
pub const PREVIEW_FADE_OUT_SEC: f32 = 0.300;
pub const PREVIEW_AUTO_FADE_SEC: f32 = 1.0;
pub const PREVIEW_MAX_SEC: f32 = 30.0;
pub const PREVIEW_DUCK_DB: f32 = -12.0;
pub const DUCK_RAMP_SEC: f32 = 0.250;
pub const VOLUME_RAMP_SEC: f32 = 0.020;
pub const PREFILL_SEC: f32 = 0.2;
pub const REBUFFER_SEC: f32 = 0.75;
pub const LIMITER_CEILING_DB: f32 = -1.0;
pub const LIMITER_LOOKAHEAD_MS: f32 = 1.5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transition {
    /// Sample-exact continuation into `next`.
    Gapless,
    /// Equal-power crossfade of this many frames.
    Crossfade(u32),
    /// Silence of this many frames between tracks.
    Gap(u32),
}

pub enum MixerCmd {
    /// Replace the current voice (old one fades out over `fade_frames`).
    SetCurrent { voice: Option<Box<Voice>>, fade_frames: u32 },
    /// Make the preloaded next voice current right now (skip to next without re-decoding).
    PromoteNext { fade_frames: u32 },
    SetNext(Option<Box<Voice>>),
    Play,
    Pause,
    SetTransition(Transition),
    /// Master gain (linear, mute folded in), ramped over ~20 ms.
    SetMaster(f32),
    SetVoiceGain { key: u64, lin: f32, frames: u32 },
    SetOverlay(bool),
    Preview(Box<Voice>),
    StopPreview,
    /// Device-switch fade of the whole output.
    DeviceFade { to: f32, frames: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MixerEvent {
    /// A voice started producing audio (after prefill).
    Started(u64),
    /// Moved from `from` into the preloaded next voice `to` (gapless or crossfade).
    Advanced { from: u64, to: u64 },
    /// Current voice finished with no next voice.
    Ended(u64),
    /// Underrun started (true) / recovered (false).
    Underrun(u64, bool),
    PreviewStarted(u64),
    PreviewEnded(u64),
    /// Transport fade-out finished; music is now paused.
    Paused,
}

/// Interleaved stereo tap of the post-gain, pre-volume mix.
#[derive(Clone, Copy)]
pub struct TapBlock {
    pub dev_frame: u64,
    pub frames: u32,
    pub data: [f32; MAX_BLOCK * 2],
}

impl TapBlock {
    pub fn new() -> Self {
        Self { dev_frame: 0, frames: 0, data: [0.0; MAX_BLOCK * 2] }
    }
}

impl Default for TapBlock {
    fn default() -> Self {
        Self::new()
    }
}

/// Controller-side endpoints of a mixer's queues.
pub struct MixerLink {
    pub cmd: rtrb::Producer<MixerCmd>,
    pub events: rtrb::Consumer<MixerEvent>,
    pub garbage: rtrb::Consumer<Box<Voice>>,
}

struct SegBuilder {
    base_frame: u64,
    base_epoch: u64,
    rate: u32,
    items: [Segment; MAX_SEGMENTS],
    len: usize,
}

impl SegBuilder {
    fn begin(&mut self, base_frame: u64, base_epoch: u64) {
        self.base_frame = base_frame;
        self.base_epoch = base_epoch;
        self.len = 0;
    }

    fn piece(&mut self, off: usize, frames: usize, voice: u64, seq: u32, pos: u64, advancing: bool) {
        if frames == 0 {
            return;
        }
        let dev_frame = self.base_frame + off as u64;
        if self.len > 0 {
            let last = &mut self.items[self.len - 1];
            let contiguous = last.dev_frame + last.frames as u64 == dev_frame;
            let same_pos = if advancing { last.pos + last.frames as u64 == pos } else { last.pos == pos };
            if (contiguous && last.voice == voice && last.advancing == advancing && same_pos) || self.len == MAX_SEGMENTS {
                last.frames += frames as u32;
                return;
            }
        }
        self.items[self.len] = Segment {
            dev_frame,
            frames: frames as u32,
            rate: self.rate,
            epoch_us: self.base_epoch + (off as u64 * 1_000_000) / self.rate as u64,
            voice,
            seq,
            pos,
            advancing,
        };
        self.len += 1;
    }

    fn flush(&mut self, clock: &Clock) {
        for s in &self.items[..self.len] {
            clock.push(s);
        }
        self.len = 0;
    }
}

pub struct Mixer {
    rate: u32,
    offline: bool,
    cmd_rx: rtrb::Consumer<MixerCmd>,
    ev_tx: rtrb::Producer<MixerEvent>,
    garbage_tx: rtrb::Producer<Box<Voice>>,
    tap_tx: Option<rtrb::Producer<TapBlock>>,
    clock: Arc<Clock>,

    current: Option<Box<Voice>>,
    next: Option<Box<Voice>>,
    preview: Option<Box<Voice>>,
    tails: [Option<Box<Voice>>; MAX_TAILS],

    transition: Transition,
    gap_left: u32,
    playing: bool,
    paused_hard: bool,
    transport: Fader,

    master: Ramp,
    device: Ramp,
    duck: DbRamp,
    overlay: OverlayFilter,
    limiter: Limiter,

    music: Box<[f32]>,
    prev: Box<[f32]>,
    tap: Box<TapBlock>,
    seg: SegBuilder,
    dev_frame: u64,
    /// Device frame just past the last frame of voice content mixed (offline trimming).
    content_end: u64,

    preview_elapsed: u64,
    preview_fading: bool,

    prefill: usize,
    rebuffer: usize,
    micro: u32,
    switch_fade: u32,
}

pub struct MixerParts {
    pub mixer: Box<Mixer>,
    pub link: MixerLink,
    pub tap: rtrb::Consumer<TapBlock>,
}

impl Mixer {
    /// Build a mixer and its queues. `start_frame` continues the device-frame timeline across
    /// device switches; `fade_in` starts the output silent and fades it in (device switch).
    pub fn create(rate: u32, clock: Arc<Clock>, offline: bool, start_frame: u64, fade_in: bool) -> MixerParts {
        let (cmd_tx, cmd_rx) = rtrb::RingBuffer::new(1024);
        let (ev_tx, ev_rx) = rtrb::RingBuffer::new(1024);
        let (garbage_tx, garbage_rx) = rtrb::RingBuffer::new(256);
        let (tap_tx, tap_rx) = rtrb::RingBuffer::new(512);
        let r = rate as f32;
        let mut device = Ramp::new(if fade_in { 0.0 } else { 1.0 });
        if fade_in {
            device.set(1.0, (0.030 * r) as u32);
        }
        let mixer = Box::new(Mixer {
            rate,
            offline,
            cmd_rx,
            ev_tx,
            garbage_tx,
            tap_tx: Some(tap_tx),
            clock,
            current: None,
            next: None,
            preview: None,
            tails: Default::default(),
            transition: Transition::Gapless,
            gap_left: 0,
            playing: false,
            paused_hard: true,
            transport: Fader::fixed(0.0),
            master: Ramp::new(1.0),
            device,
            duck: DbRamp::new(0.0),
            overlay: OverlayFilter::new(rate),
            limiter: Limiter::new(rate, LIMITER_CEILING_DB, LIMITER_LOOKAHEAD_MS),
            music: vec![0.0; MAX_BLOCK * 2].into_boxed_slice(),
            prev: vec![0.0; MAX_BLOCK * 2].into_boxed_slice(),
            tap: Box::new(TapBlock::new()),
            seg: SegBuilder { base_frame: 0, base_epoch: 0, rate, items: [Segment::default(); MAX_SEGMENTS], len: 0 },
            dev_frame: start_frame,
            content_end: start_frame,
            preview_elapsed: 0,
            preview_fading: false,
            prefill: (PREFILL_SEC * r) as usize,
            rebuffer: (REBUFFER_SEC * r) as usize,
            micro: (MICRO_FADE_SEC * r) as u32,
            switch_fade: (SWITCH_FADE_SEC * r) as u32,
        });
        MixerParts { mixer, link: MixerLink { cmd: cmd_tx, events: ev_rx, garbage: garbage_rx }, tap: tap_rx }
    }

    /// Output delay added by the mixer itself (limiter look-ahead), in frames.
    pub fn latency_frames(&self) -> usize {
        self.limiter.latency()
    }

    /// Next device frame to be rendered.
    pub fn dev_frame(&self) -> u64 {
        self.dev_frame
    }

    /// Device frame just past the last voice frame mixed so far.
    pub fn content_end(&self) -> u64 {
        self.content_end
    }

    #[inline]
    fn emit(&mut self, ev: MixerEvent) {
        let _ = self.ev_tx.push(ev);
    }

    /// Hand a voice back to the controller for deallocation.
    #[inline]
    fn discard(&mut self, v: Box<Voice>) {
        if let Err(rtrb::PushError::Full(v)) = self.garbage_tx.push(v) {
            // Never free on the RT thread; leaking is the lesser evil (practically unreachable).
            std::mem::forget(v);
        }
    }

    fn push_tail(&mut self, v: Box<Voice>) {
        if let Some(slot) = self.tails.iter_mut().find(|t| t.is_none()) {
            *slot = Some(v);
        } else {
            self.discard(v);
        }
    }

    fn transport_running(&self) -> bool {
        !self.paused_hard
    }

    pub fn process_commands(&mut self) {
        while let Ok(cmd) = self.cmd_rx.pop() {
            match cmd {
                MixerCmd::SetCurrent { voice, fade_frames } => self.replace_current(voice, fade_frames),
                MixerCmd::PromoteNext { fade_frames } => {
                    if let Some(nx) = self.next.take() {
                        self.replace_current(Some(nx), fade_frames);
                    }
                }
                MixerCmd::SetNext(v) => {
                    if let Some(old) = self.next.take() {
                        self.discard(old);
                    }
                    self.next = v;
                }
                MixerCmd::Play => {
                    self.playing = true;
                    self.paused_hard = false;
                    let natural = self.current.as_ref().is_none_or(|c| !c.started);
                    if natural && self.transport.value() == 0.0 {
                        self.transport = Fader::fixed(1.0);
                    } else {
                        self.transport.retarget(1.0, self.micro, Curve::SCurve);
                    }
                }
                MixerCmd::Pause => {
                    self.playing = false;
                    if self.current.as_ref().is_none_or(|c| !c.started) && self.tails.iter().all(|t| t.is_none()) {
                        self.transport = Fader::fixed(0.0);
                        self.paused_hard = true;
                    } else {
                        self.transport.retarget(0.0, self.micro, Curve::SCurve);
                    }
                }
                MixerCmd::SetTransition(t) => self.transition = t,
                MixerCmd::SetMaster(lin) => self.master.set(lin, (VOLUME_RAMP_SEC * self.rate as f32) as u32),
                MixerCmd::SetVoiceGain { key, lin, frames } => {
                    let all = [&mut self.current, &mut self.next, &mut self.preview];
                    for v in all.into_iter().flatten() {
                        if v.key == key {
                            v.gain.set(lin, frames);
                        }
                    }
                    for v in self.tails.iter_mut().flatten() {
                        if v.key == key {
                            v.gain.set(lin, frames);
                        }
                    }
                }
                MixerCmd::SetOverlay(on) => self.overlay.set_active(on),
                MixerCmd::Preview(v) => {
                    if let Some(mut old) = self.preview.take() {
                        if old.started {
                            old.env.retarget(0.0, (0.05 * self.rate as f32) as u32, Curve::SCurve);
                            old.release_when_silent = true;
                            self.push_tail(old);
                        } else {
                            self.discard(old);
                        }
                    }
                    self.preview = Some(v);
                    self.preview_elapsed = 0;
                    self.preview_fading = false;
                }
                MixerCmd::StopPreview => {
                    if let Some(p) = self.preview.as_mut() {
                        if p.started {
                            p.env.retarget(0.0, (PREVIEW_FADE_OUT_SEC * self.rate as f32) as u32, Curve::SCurve);
                            self.preview_fading = true;
                        } else {
                            let p = self.preview.take().unwrap();
                            let key = p.key;
                            self.discard(p);
                            self.end_preview_duck();
                            self.emit(MixerEvent::PreviewEnded(key));
                        }
                    }
                }
                MixerCmd::DeviceFade { to, frames } => self.device.set(to, frames),
            }
        }
    }

    fn replace_current(&mut self, voice: Option<Box<Voice>>, fade_frames: u32) {
        if let Some(mut old) = self.current.take() {
            if old.started && self.transport_running() && fade_frames > 0 {
                old.env.retarget(0.0, fade_frames, Curve::SCurve);
                old.release_when_silent = true;
                self.push_tail(old);
            } else {
                self.discard(old);
            }
        }
        self.gap_left = 0;
        self.current = voice;
    }

    fn end_preview_duck(&mut self) {
        self.duck.set(0.0, (DUCK_RAMP_SEC * self.rate as f32) as u32);
    }

    /// Is there anything to render? (Offline sinks only advance time while active.)
    pub fn is_active(&self) -> bool {
        let music = self.current.is_some() || self.gap_left > 0 || self.tails.iter().flatten().any(|t| t.bus == Bus::Music);
        (self.transport_running() && music)
            || self.preview.is_some()
            || self.tails.iter().flatten().any(|t| t.bus == Bus::Preview)
    }

    /// Offline sinks: would rendering `frames` now be free of buffer underruns?
    pub fn offline_ready(&self, frames: usize) -> bool {
        let done = |v: &Voice| v.eof() || v.failed();
        let ready_running = |v: &Voice| v.available() >= frames || done(v);
        let ready_start = |v: &Voice| v.available() >= self.prefill.max(frames) || done(v);
        let check = |v: &Voice| if v.started { ready_running(v) } else { ready_start(v) };
        if self.transport_running() {
            if let Some(c) = &self.current {
                if !check(c) {
                    return false;
                }
                // The next voice matters only once the current one ends (or a crossfade is due)
                // within this block. A chained next only fills after the current one is decoded.
                if let Some(n) = &self.next {
                    let ending = c.started && done(c) && c.available() < frames;
                    let xfade_due = matches!(self.transition, Transition::Crossfade(xf)
                        if c.started && c.remaining().is_some_and(|r| r <= xf as u64 + frames as u64));
                    if (ending || xfade_due) && !ready_start(n) {
                        return false;
                    }
                }
            }
        }
        if let Some(p) = &self.preview {
            if !check(p) {
                return false;
            }
        }
        self.tails.iter().flatten().all(|t| ready_running(t) || (t.bus == Bus::Music && !self.transport_running()))
    }

    /// Render `out.len() / 2` interleaved stereo frames. `epoch_us` is the wall-clock time at
    /// which the first output frame will be audible.
    pub fn render(&mut self, out: &mut [f32], epoch_us: u64) {
        self.process_commands();
        let n = out.len() / 2;
        let mut off = 0;
        while off < n {
            let m = (n - off).min(MAX_BLOCK);
            let e = epoch_us + (off as u64 * 1_000_000) / self.rate as u64;
            self.render_block(&mut out[off * 2..(off + m) * 2], e);
            off += m;
        }
    }

    fn render_block(&mut self, out: &mut [f32], epoch_us: u64) {
        let n = out.len() / 2;
        self.music[..n * 2].fill(0.0);
        self.prev[..n * 2].fill(0.0);
        // Mix frames are heard `limiter latency` frames after the output frame they're mixed into.
        let lat_us = self.limiter.latency() as u64 * 1_000_000 / self.rate as u64;
        self.seg.begin(self.dev_frame, epoch_us + lat_us);

        if self.transport_running() {
            self.render_music(n);
        } else {
            let (k, s, p) = self.current.as_ref().map(|c| (c.key, c.seq, c.pos)).unwrap_or((0, 0, 0));
            self.seg.piece(0, n, k, s, p, false);
        }
        self.render_tails(n);
        self.render_preview(n);

        let mut tap_idx = 0;
        for i in 0..n {
            let t = self.transport.step();
            let d = self.duck.step();
            let g = t * d;
            let (l, r) = self.overlay.process(self.music[2 * i] * g, self.music[2 * i + 1] * g);
            let l = l + self.prev[2 * i];
            let r = r + self.prev[2 * i + 1];
            self.tap.data[tap_idx] = l;
            self.tap.data[tap_idx + 1] = r;
            tap_idx += 2;
            let m = self.master.step() * self.device.step();
            let (l, r) = self.limiter.process(l * m, r * m);
            out[2 * i] = l;
            out[2 * i + 1] = r;
        }
        self.tap.dev_frame = self.dev_frame;
        self.tap.frames = n as u32;
        if let Some(tx) = self.tap_tx.as_mut() {
            let _ = tx.push(*self.tap);
        }
        self.seg.flush(&self.clock);
        self.dev_frame += n as u64;
        self.clock.rendered.store(self.dev_frame, std::sync::atomic::Ordering::Relaxed);

        if !self.playing && !self.paused_hard && self.transport.done() && self.transport.value() == 0.0 {
            self.paused_hard = true;
            // Fully paused: tails of a stopped/seeked track have nothing left to say.
            for i in 0..MAX_TAILS {
                if self.tails[i].as_ref().is_some_and(|t| t.bus == Bus::Music && t.release_when_silent) {
                    let t = self.tails[i].take().unwrap();
                    self.discard(t);
                }
            }
            self.emit(MixerEvent::Paused);
        }
    }

    fn start_crossfade(&mut self, len: u32, block_offset: usize) {
        let Some(mut old) = self.current.take() else { return };
        let Some(mut nx) = self.next.take() else {
            self.current = Some(old);
            return;
        };
        let from = old.key;
        old.env.retarget(0.0, len, Curve::EqualPower);
        old.release_when_silent = true;
        old.block_offset = block_offset as u32;
        self.push_tail(old);
        nx.env = Fader::new(0.0, 1.0, len, Curve::EqualPower);
        let to = nx.key;
        self.current = Some(nx);
        self.emit(MixerEvent::Advanced { from, to });
    }

    fn render_music(&mut self, n: usize) {
        let offline = self.offline;
        let mut off = 0;
        while off < n {
            if self.gap_left > 0 {
                let k = (self.gap_left as usize).min(n - off);
                let (key, seq, pos) = self.current.as_ref().map(|c| (c.key, c.seq, c.pos)).unwrap_or((0, 0, 0));
                self.seg.piece(off, k, key, seq, pos, false);
                self.gap_left -= k as u32;
                off += k;
                continue;
            }
            let rate = self.rate;
            let prefill = self.prefill;
            let Some(cur) = self.current.as_mut() else {
                self.seg.piece(off, n - off, 0, 0, 0, false);
                break;
            };
            if !cur.started {
                if cur.try_start(prefill, rate, offline) {
                    let key = cur.key;
                    self.emit(MixerEvent::Started(key));
                    continue;
                }
                let (key, seq, pos) = (cur.key, cur.seq, cur.shared.origin.load(std::sync::atomic::Ordering::Relaxed));
                self.seg.piece(off, n - off, key, seq, pos, false);
                break;
            }
            if cur.underrun {
                let ready = cur.available() >= self.rebuffer || cur.eof() || (offline && cur.failed());
                if !ready {
                    let (key, seq, pos) = (cur.key, cur.seq, cur.pos);
                    self.seg.piece(off, n - off, key, seq, pos, false);
                    break;
                }
                cur.underrun = false;
                cur.env.retarget(1.0, self.switch_fade, Curve::SCurve);
                let key = cur.key;
                self.emit(MixerEvent::Underrun(key, false));
                continue;
            }
            if let (Transition::Crossfade(xf), Some(_)) = (self.transition, self.next.as_ref()) {
                if let Some(rem) = cur.remaining() {
                    if rem > 0 && rem <= xf as u64 {
                        self.start_crossfade(rem.min(xf as u64) as u32, off);
                        continue;
                    }
                }
            }
            let mut want = n - off;
            // Stop exactly where a pending crossfade has to begin.
            if let (Transition::Crossfade(xf), Some(_)) = (self.transition, self.next.as_ref()) {
                if let Some(rem) = cur.remaining() {
                    if rem > xf as u64 {
                        want = want.min((rem - xf as u64) as usize);
                    }
                }
            }
            let avail = cur.available();
            let k = avail.min(want);
            let starving = k < want && !(cur.eof() || (offline && cur.failed()));
            if k > 0 {
                self.seg.piece(off, k, cur.key, cur.seq, cur.pos, true);
                cur.mix_into(&mut self.music[off * 2..(off + k) * 2], k, starving);
                off += k;
                self.content_end = self.dev_frame + off as u64;
            }
            if off >= n {
                break;
            }
            if k == want {
                // Stopped at a crossfade point; go round again to start it.
                continue;
            }
            let cur = self.current.as_mut().unwrap();
            if cur.finished(offline) {
                let old = self.current.take().unwrap();
                let from = old.key;
                self.discard(old);
                match self.next.take() {
                    Some(nx) => {
                        let to = nx.key;
                        if let Transition::Gap(g) = self.transition {
                            self.gap_left = g;
                        }
                        self.current = Some(nx);
                        self.emit(MixerEvent::Advanced { from, to });
                    }
                    None => self.emit(MixerEvent::Ended(from)),
                }
                continue;
            }
            // Underrun: wait for the decoder to catch up.
            if !cur.underrun {
                cur.underrun = true;
                let key = cur.key;
                self.emit(MixerEvent::Underrun(key, true));
            }
            let cur = self.current.as_ref().unwrap();
            self.seg.piece(off, n - off, cur.key, cur.seq, cur.pos, false);
            break;
        }
    }

    fn render_tails(&mut self, n: usize) {
        let running = self.transport_running();
        let offline = self.offline;
        for i in 0..MAX_TAILS {
            let Some(t) = self.tails[i].as_mut() else { continue };
            if t.bus == Bus::Music && !running {
                continue;
            }
            let start = (t.block_offset as usize).min(n);
            t.block_offset = 0;
            let k = t.available().min(n - start);
            let bus = if t.bus == Bus::Music { &mut self.music } else { &mut self.prev };
            let starving = k < n - start && !t.finished(offline);
            t.mix_into(&mut bus[start * 2..(start + k) * 2], k, starving);
            if k > 0 {
                self.content_end = self.content_end.max(self.dev_frame + (start + k) as u64);
            }
            let silent = t.env.done() && t.env.target() == 0.0 && t.release_when_silent;
            if silent || t.finished(offline) || starving {
                let t = self.tails[i].take().unwrap();
                self.discard(t);
            }
        }
    }

    fn render_preview(&mut self, n: usize) {
        let offline = self.offline;
        let rate = self.rate;
        let prefill = self.prefill;
        let Some(p) = self.preview.as_mut() else { return };
        if !p.started {
            if !p.try_start(prefill, rate, offline) {
                if (offline && p.failed()) || p.finished(offline) {
                    let p = self.preview.take().unwrap();
                    let key = p.key;
                    self.discard(p);
                    self.emit(MixerEvent::PreviewEnded(key));
                }
                return;
            }
            p.env = Fader::new(0.0, 1.0, (PREVIEW_FADE_IN_SEC * rate as f32) as u32, Curve::SCurve);
            let key = p.key;
            self.duck.set(PREVIEW_DUCK_DB, (DUCK_RAMP_SEC * rate as f32) as u32);
            self.emit(MixerEvent::PreviewStarted(key));
        }
        let p = self.preview.as_mut().unwrap();
        let k = p.available().min(n);
        p.mix_into(&mut self.prev[..k * 2], k, false);
        if k > 0 {
            self.content_end = self.content_end.max(self.dev_frame + k as u64);
        }
        self.preview_elapsed += k as u64;
        if !self.preview_fading && self.preview_elapsed >= (PREVIEW_MAX_SEC * rate as f32) as u64 {
            p.env.retarget(0.0, (PREVIEW_AUTO_FADE_SEC * rate as f32) as u32, Curve::SCurve);
            self.preview_fading = true;
        }
        let faded = self.preview_fading && p.env.done();
        if faded || p.finished(offline) || (p.failed() && p.available() == 0) {
            let p = self.preview.take().unwrap();
            let key = p.key;
            self.discard(p);
            self.end_preview_duck();
            self.emit(MixerEvent::PreviewEnded(key));
        }
    }
}
