//! Decode worker: source → loop stage → stereo → resample to device rate → voice ring.
//!
//! One worker per voice. Seeking creates a new voice (and worker) at the target position, so a
//! worker only ever moves forward. Blocking reads from the stream cache are fine here.

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::Sender;

use crate::cache::CacheManager;
use crate::resample::StreamResampler;
use crate::source::loop_stage::{LoopSettings, LoopStage};
use crate::source::{self, AudioSource, OpenCtx, SourceMeta};
use crate::util::{ms_to_frames, spawn_named};
use crate::voice::{Continuation, VoiceShared};
use crate::SourceSpec;

const READ_FRAMES: usize = 1024;

#[derive(Debug)]
pub enum WorkerEvent {
    Info { key: u64, rate: u32, channels: u16, duration_ms: Option<u64>, meta: Box<SourceMeta>, loop_ms: Option<(u64, u64)>, voices: u32 },
    Error { key: u64, message: String },
    Eof { key: u64 },
}

pub struct WorkerParams {
    pub spec: SourceSpec,
    pub start_ms: u64,
    pub dev_rate: u32,
    pub producer: rtrb::Producer<f32>,
    pub shared: Arc<VoiceShared>,
    pub cache: Arc<CacheManager>,
    pub loops: Arc<LoopSettings>,
    pub events: Sender<WorkerEvent>,
}

pub fn spawn(p: WorkerParams) {
    let shared = p.shared.clone();
    let h = spawn_named("ghost-decode", move || run(p));
    *shared.thread.lock() = Some(h.thread().clone());
}

/// Start decoding `p`, preferably as the gapless continuation of `prev`'s worker (same thread,
/// same resampler). Falls back to a standalone worker if `prev` has already finished reading.
pub fn spawn_or_chain(p: WorkerParams, prev: Option<&Arc<VoiceShared>>) {
    let Some(prev) = prev.filter(|_| p.start_ms == 0) else { return spawn(p) };
    let WorkerParams { spec, start_ms, dev_rate, producer, shared, cache, loops, events } = p;
    match prev.attach_next(Continuation { spec, shared, producer }) {
        Ok(()) => {}
        Err(c) => spawn(WorkerParams { spec: c.spec, start_ms, dev_rate, producer: c.producer, shared: c.shared, cache, loops, events }),
    }
}

/// Re-home a not-yet-started continuation (e.g. after a seek replaced `from`'s worker).
pub fn move_chain(from: &VoiceShared, to: Option<&Arc<VoiceShared>>, standalone: impl FnOnce(Continuation)) {
    let Some(c) = from.detach_next() else { return };
    match to {
        Some(t) => {
            if let Err(c) = t.attach_next(c) {
                standalone(c);
            }
        }
        None => standalone(c),
    }
}

fn fail(shared: &VoiceShared, events: &Sender<WorkerEvent>, message: String) {
    if shared.is_canceled() {
        return;
    }
    shared.failed.store(true, Ordering::Release);
    let _ = events.send(WorkerEvent::Error { key: shared.key, message });
}

/// Output destination for one voice.
struct Lane {
    shared: Arc<VoiceShared>,
    producer: rtrb::Producer<f32>,
    origin: u64,
    written: u64,
    /// Frames this lane still receives before output moves on to the next lane (None = all).
    quota: Option<u64>,
}

/// Routes resampled output to consecutive voices, switching at exact frame boundaries.
struct Router {
    lanes: VecDeque<Lane>,
    events: Sender<WorkerEvent>,
}

impl Router {
    fn finish_front(&mut self) {
        if let Some(l) = self.lanes.pop_front() {
            l.shared.end_pos.store(l.origin + l.written, Ordering::Release);
            l.shared.eof.store(true, Ordering::Release);
            let _ = self.events.send(WorkerEvent::Eof { key: l.shared.key });
        }
    }

    fn finish_all(&mut self) {
        while !self.lanes.is_empty() {
            self.finish_front();
        }
    }

    /// Push `buf[pos..]` as far as the rings allow; returns the new position.
    fn push(&mut self, buf: &[f32], mut pos: usize) -> usize {
        while pos < buf.len() {
            let Some(front) = self.lanes.front_mut() else { return buf.len() };
            if front.quota == Some(0) {
                self.finish_front();
                continue;
            }
            let mut n = buf.len() - pos;
            if let Some(q) = front.quota {
                n = n.min(q as usize * 2);
            }
            let discard = front.shared.is_canceled() || front.producer.is_abandoned();
            let pushed = if discard {
                n
            } else {
                let k = n.min(front.producer.slots() & !1);
                if k == 0 {
                    break;
                }
                front.producer.push_partial_slice(&buf[pos..pos + k]).0.len()
            };
            let frames = (pushed / 2) as u64;
            front.written += frames;
            if let Some(q) = front.quota.as_mut() {
                *q -= frames;
            }
            pos += pushed;
            if front.quota == Some(0) {
                self.finish_front();
            } else if pushed < n {
                break;
            }
        }
        pos
    }
}

struct Seg {
    spec: SourceSpec,
    shared: Arc<VoiceShared>,
    producer: rtrb::Producer<f32>,
    start_ms: u64,
}

fn open_source(spec: &SourceSpec, cache: &Arc<CacheManager>, cancel: &Arc<std::sync::atomic::AtomicBool>, loops: &Arc<LoopSettings>) -> Result<Box<dyn AudioSource>, String> {
    let ctx = OpenCtx { cache, cancel: cancel.clone(), accurate_seek: false };
    let src = source::open(spec, &ctx).map_err(|e| e.message)?;
    Ok(Box::new(LoopStage::new(src, loops.clone())))
}

/// One resampler run (continuous across chained voices of the same source rate).
struct Run {
    rate: u32,
    dev_rate: u32,
    rs: Option<StreamResampler>,
    in_total: u64,
    out_assigned: u64,
}

impl Run {
    fn new(rate: u32, dev_rate: u32) -> Result<Self, String> {
        let rs = if rate != dev_rate { Some(StreamResampler::new(rate, dev_rate)?) } else { None };
        Ok(Self { rate, dev_rate, rs, in_total: 0, out_assigned: 0 })
    }
    fn expected_out(&self, input: u64) -> u64 {
        if self.rs.is_some() {
            (input as f64 * self.dev_rate as f64 / self.rate as f64).round() as u64
        } else {
            input
        }
    }
}

/// Flush the resampler and deliver everything that's left, waiting for ring space.
fn drain(run: &mut Run, out: &mut Vec<f32>, out_pos: &mut usize, router: &mut Router) {
    if let Some(rs) = run.rs.as_mut() {
        let _ = rs.finish(out);
    }
    loop {
        *out_pos = router.push(out, *out_pos);
        if *out_pos >= out.len() || router.lanes.is_empty() {
            break;
        }
        std::thread::park_timeout(Duration::from_millis(10));
    }
    out.clear();
    *out_pos = 0;
    router.finish_all();
}

fn run(p: WorkerParams) {
    let WorkerParams { spec, start_ms, dev_rate, producer, shared, cache, loops, events } = p;
    let mut router = Router { lanes: VecDeque::new(), events: events.clone() };
    let mut next_seg = Some(Seg { spec, shared, producer, start_ms });
    let mut pre_opened: Option<Box<dyn AudioSource>> = None;
    let mut run: Option<Run> = None;
    let mut native: Vec<f32> = Vec::new();
    let mut stereo: Vec<f32> = Vec::with_capacity(READ_FRAMES * 2);
    let mut out: Vec<f32> = Vec::with_capacity(READ_FRAMES * 4);
    let mut out_pos = 0usize;

    while let Some(seg) = next_seg.take() {
        *seg.shared.thread.lock() = Some(std::thread::current());
        let key = seg.shared.key;
        let cancel = seg.shared.cancel.clone();
        let mut src = match pre_opened.take() {
            Some(s) => s,
            None => match open_source(&seg.spec, &cache, &cancel, &loops) {
                Ok(s) => s,
                Err(e) => {
                    fail(&seg.shared, &events, e);
                    if let Some(r) = run.as_mut() {
                        drain(r, &mut out, &mut out_pos, &mut router);
                    }
                    return;
                }
            },
        };
        if cancel.load(Ordering::Relaxed) {
            if let Some(r) = run.as_mut() {
                drain(r, &mut out, &mut out_pos, &mut router);
            }
            return;
        }
        let rate = src.sample_rate().max(1);
        let ch = src.channels().max(1);
        let meta = src.meta();
        let duration = src.duration();
        let to_ms = |f: u64| f * 1000 / rate as u64;
        let _ = events.send(WorkerEvent::Info {
            key,
            rate,
            channels: ch as u16,
            duration_ms: duration.map(to_ms),
            meta: Box::new(meta),
            loop_ms: src.loop_info().map(|l| (to_ms(l.start), to_ms(l.end))),
            voices: src.voice_count() as u32,
        });
        if run.as_ref().is_none_or(|r| r.rate != rate) {
            match Run::new(rate, dev_rate) {
                Ok(r) => run = Some(r),
                Err(e) => return fail(&seg.shared, &events, format!("resampler: {e}")),
            }
        }
        let r = run.as_mut().unwrap();

        let mut start_native = 0u64;
        if seg.start_ms > 0 {
            match src.seek(ms_to_frames(seg.start_ms as f64, rate)) {
                Ok(f) => start_native = f,
                Err(e) => return fail(&seg.shared, &events, format!("seek failed: {e}")),
            }
        }
        let to_dev = |frames: u64| -> u64 { (frames as f64 * dev_rate as f64 / rate as f64).round() as u64 };
        let origin = to_dev(start_native);
        seg.shared.origin.store(origin, Ordering::Release);
        seg.shared.origin_set.store(true, Ordering::Release);
        if let Some(d) = duration {
            seg.shared.est_end.store(to_dev(d), Ordering::Release);
        }
        router.lanes.push_back(Lane { shared: seg.shared.clone(), producer: seg.producer, origin, written: 0, quota: None });
        native.resize(READ_FRAMES * ch, 0.0);

        loop {
            if cancel.load(Ordering::Relaxed) {
                // Earlier (chained) voices still get their exact tails; ours is discarded.
                drain(r, &mut out, &mut out_pos, &mut router);
                return;
            }
            if out_pos < out.len() {
                out_pos = router.push(&out, out_pos);
                if out_pos < out.len() {
                    std::thread::park_timeout(Duration::from_millis(10));
                    continue;
                }
                out.clear();
                out_pos = 0;
            }
            let n = match src.read(&mut native) {
                Ok(n) => n,
                Err(e) => {
                    fail(&seg.shared, &events, e.message);
                    // Deliver what earlier voices are owed, but don't mark this one as ended.
                    let failed = router.lanes.pop_back();
                    drain(r, &mut out, &mut out_pos, &mut router);
                    drop(failed);
                    return;
                }
            };
            if n == 0 {
                // End of this voice's source: continue gaplessly into the next one if attached.
                let cont = {
                    let mut slot = seg.shared.chain.lock();
                    slot.closed = true;
                    slot.next.take()
                };
                if let Some(c) = cont.filter(|c| !c.shared.is_canceled()) {
                    match open_source(&c.spec, &cache, &c.shared.cancel, &loops) {
                        Ok(next_src) => {
                            if next_src.sample_rate().max(1) == rate {
                                // Same rate: keep the resampler running; this voice ends exactly
                                // where its input ends on the output timeline.
                                let total = r.expected_out(r.in_total) - r.out_assigned;
                                r.out_assigned += total;
                                let lane = router.lanes.back_mut().unwrap();
                                lane.quota = Some(total.saturating_sub(lane.written));
                            } else {
                                drain(r, &mut out, &mut out_pos, &mut router);
                            }
                            pre_opened = Some(next_src);
                            next_seg = Some(Seg { spec: c.spec, shared: c.shared, producer: c.producer, start_ms: 0 });
                            break;
                        }
                        Err(e) => fail(&c.shared, &events, e),
                    }
                }
                drain(r, &mut out, &mut out_pos, &mut router);
                return;
            }
            r.in_total += n as u64;
            stereo.clear();
            source::to_stereo(&native[..n * ch], ch, &mut stereo);
            match r.rs.as_mut() {
                Some(rs) => {
                    if let Err(e) = rs.push(&stereo, &mut out) {
                        return fail(&seg.shared, &events, format!("resampler: {e}"));
                    }
                }
                None => std::mem::swap(&mut out, &mut stereo),
            }
        }
    }
}

/// Decode a whole source at its native rate, downmixed to at most 2 channels (analysis jobs).
/// Looping formats play as `loops` would (Endless counts as the Album default), so the analysis
/// matches what is heard.
pub fn decode_all(
    spec: &SourceSpec,
    cache: &Arc<CacheManager>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    loops: (crate::LoopMode, u32, f32),
) -> Result<(Vec<f32>, usize, u32), String> {
    let ctx = OpenCtx { cache, cancel: cancel.clone(), accurate_seek: true };
    let raw = source::open(spec, &ctx).map_err(|e| e.message)?;
    let settings = Arc::new(LoopSettings::fixed(LoopSettings::finite(loops)));
    let mut src = LoopStage::new(raw, settings);
    let ch = src.channels().max(1);
    let rate = src.sample_rate();
    let out_ch = ch.min(2);
    let mut out = Vec::with_capacity(src.duration().map(|d| d as usize * out_ch).unwrap_or(rate as usize * 240 * out_ch).min(1 << 28));
    let mut buf = vec![0.0f32; 4096 * ch];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("canceled".into());
        }
        let n = src.read(&mut buf).map_err(|e| e.message)?;
        if n == 0 {
            break;
        }
        if ch <= 2 {
            out.extend_from_slice(&buf[..n * ch]);
        } else {
            source::to_stereo(&buf[..n * ch], ch, &mut out);
        }
    }
    Ok((out, out_ch, rate))
}
