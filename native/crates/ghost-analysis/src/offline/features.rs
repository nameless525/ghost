//! STFT feature pass over the mono downmix (computed per chunk, never as a whole-track copy):
//! onset-strength envelopes (spectral flux on log-compressed log-spaced bands), per-frame level
//! and spectral balance.
//!
//! [`FeatureStream`] takes the track in chunks: every frame whose window is complete is analysed
//! as soon as its samples arrive (band powers, flatness, level, spectral sums: ~180 bytes per
//! frame are kept), and only the parts that need the whole track (normalisation gain → log
//! compression, statistics, flux) run at the end. The result does not depend on the chunking.

use std::sync::{Arc, Mutex};

use rayon::prelude::*;
use realfft::{RealFftPlanner, RealToComplex};

use crate::dsp::{db, log_edges, BandMap, PowerFft};

/// Onset analysis bands.
const NB: usize = 40;
const LO_HZ: f32 = 30.0;
const HI_HZ: f32 = 16_000.0;
/// Bands whose centre is below this feed the low-frequency (kick/bass) flux used for downbeats.
const LF_HZ: f32 = 200.0;
/// High-frequency content region (cymbals, distorted guitars, noise) for the brightness feature.
const HF_LO_HZ: f32 = 2_500.0;
const HF_HI_HZ: f32 = 12_000.0;
/// Bands above this feed the high-frequency flux.
const HF_FLUX_HZ: f32 = 2_000.0;
/// Log-compression knee: `ln(1 + GAMMA·magnitude)`, magnitude relative to a full-scale sine,
/// after normalising the track so its loud passages sit near -20 dBFS RMS. Knee ≈ -60 dB:
/// linear (quiet) below, so noise floors don't produce flux, logarithmic above.
const GAMMA: f32 = 1000.0;
const NORM_TARGET_DB: f32 = -20.0;

pub(crate) struct Features {
    /// Envelope frames per second (~86).
    pub fps: f32,
    /// Seconds to add to `t / fps` to get the time of envelope frame `t`.
    pub time_offset: f32,
    /// Spectral flux, mean positive log-magnitude rise per band (nats), per frame.
    pub flux: Vec<f32>,
    /// Same, restricted to bands below ~200 Hz.
    pub flux_lf: Vec<f32>,
    /// Same, restricted to bands above ~2 kHz (percussive / bright transients).
    pub flux_hf: Vec<f32>,
    /// Per-frame spectral flatness of the band powers (60 Hz–10 kHz), 0..1: how evenly the
    /// spectrum is filled (dense mixes, drums, distortion) vs. a few peaky notes.
    pub flatness: Vec<f32>,
    /// Unnormalised frame level, dB re. full-scale sine (silence ≈ -120).
    pub frame_db: Vec<f32>,
    /// Power in 2.5–12 kHz relative to total, dB, over active frames.
    pub hf_db: f32,
    /// Power-weighted mean log2 frequency (spectral centroid), Hz, over active frames.
    pub centroid_hz: f32,
}

impl Features {
    pub fn time_of(&self, frame: f32) -> f32 {
        frame / self.fps + self.time_offset
    }
}

/// Mono downmix of interleaved samples (non-finite → 0), computed on demand per region instead of
/// as a whole-track copy; values are identical to downmixing the whole track up front.
#[derive(Clone, Copy)]
pub(crate) struct Mono<'a> {
    samples: &'a [f32],
    channels: usize,
}

impl<'a> Mono<'a> {
    pub fn new(samples: &'a [f32], channels: usize) -> Self {
        Self { samples, channels }
    }

    pub fn len(&self) -> usize {
        self.samples.len() / self.channels
    }

    /// Downmix frames `[start, start + out.len())`.
    pub fn fill(&self, start: usize, out: &mut [f32]) {
        let ch = self.channels;
        let inp = &self.samples[start * ch..(start + out.len()) * ch];
        let fin = |m: f32| if m.is_finite() { m } else { 0.0 };
        match ch {
            1 => {
                for (o, &x) in out.iter_mut().zip(inp) {
                    *o = fin(x);
                }
            }
            2 => {
                let (pairs, _) = inp.as_chunks::<2>();
                for (o, [l, r]) in out.iter_mut().zip(pairs) {
                    *o = fin((l + r) * 0.5);
                }
            }
            _ => {
                let inv = 1.0 / ch as f32;
                for (o, fr) in out.iter_mut().zip(inp.chunks_exact(ch)) {
                    *o = fin(fr.iter().sum::<f32>() * inv);
                }
            }
        }
    }
}

/// Normalisation block length (frames): 100 ms.
fn norm_block(sample_rate: u32) -> usize {
    (sample_rate as usize / 10).max(1)
}

/// `db` of the mean square of every complete block of `mono` (whole blocks only; starting at a
/// block boundary), each block summed in order like `Iterator::sum`; four blocks' sums run side by
/// side so the additions overlap.
fn block_levels(mono: Mono, first: usize, blocks: usize, block: usize) -> Vec<f32> {
    const G: usize = 4;
    (0..blocks.div_ceil(G))
        .into_par_iter()
        .map_init(
            || vec![0.0f32; G * block],
            |buf, gi| {
                let n = (blocks - gi * G).min(G);
                let a = first + gi * G * block;
                mono.fill(a, &mut buf[..n * block]);
                let mut acc = [-0.0f32; G];
                if n == G {
                    let blocks: [&[f32]; G] = std::array::from_fn(|k| &buf[k * block..(k + 1) * block]);
                    // Index loop on purpose: one step of every block's sum per iteration.
                    #[allow(clippy::needless_range_loop)]
                    for i in 0..block {
                        for k in 0..G {
                            acc[k] += blocks[k][i] * blocks[k][i];
                        }
                    }
                } else {
                    for k in 0..n {
                        acc[k] = buf[k * block..(k + 1) * block].iter().map(|x| x * x).sum::<f32>();
                    }
                }
                (0..n).map(|k| db(acc[k] / block as f32, 1e-14)).collect::<Vec<f32>>()
            },
        )
        .flatten_iter()
        .collect()
}

/// Gain (dB) that brings the loud part of the track (90th percentile of 100 ms block RMS) to
/// `NORM_TARGET_DB`, clamped to ±60 dB.
fn normalisation_gain_db(levels: &[f32]) -> f32 {
    let mut levels: Vec<f32> = levels.iter().copied().filter(|&d| d > -100.0).collect();
    if levels.is_empty() {
        return 0.0;
    }
    levels.sort_by(f32::total_cmp);
    let p90 = levels[((levels.len() - 1) as f32 * 0.9) as usize];
    (NORM_TARGET_DB - p90).clamp(-60.0, 60.0)
}

/// Per-frame spectral sums: total power from `lo_bin`, power in `[hf_lo, hf_hi)` and
/// Σ power·log2(f) from `lo_bin`. One pass with three independent accumulators; each is summed in
/// ascending bin order from -0.0 exactly like `Iterator::sum`, so the results are bit-identical
/// to three separate `sum()` calls (which were latency-bound chains).
fn spectral_sums(p: &[f32], log2_bin: &[f32], lo_bin: usize, hf_lo: usize, hf_hi: usize) -> (f32, f32, f32) {
    let (mut total, mut hf, mut c) = (-0.0f32, -0.0f32, -0.0f32);
    // HF bins below `lo_bin` (only at absurd sample rates) come first in the HF sum.
    for &v in &p[hf_lo.min(lo_bin)..hf_hi.min(lo_bin)] {
        hf += v;
    }
    let a = hf_lo.clamp(lo_bin, p.len());
    let b = hf_hi.clamp(a, p.len());
    for (&v, &l) in p[lo_bin..a].iter().zip(&log2_bin[lo_bin..a]) {
        total += v;
        c += v * l;
    }
    for (&v, &l) in p[a..b].iter().zip(&log2_bin[a..b]) {
        total += v;
        hf += v;
        c += v * l;
    }
    for (&v, &l) in p[b..].iter().zip(&log2_bin[b..]) {
        total += v;
        c += v * l;
    }
    (total, hf, c)
}

/// Frame geometry, band layout and spectral regions for one sample rate.
struct Setup {
    sr: f32,
    /// ~11.6 ms hop (512 @ 44.1 kHz).
    hop: usize,
    /// ~46 ms window (2048 @ 44.1/48 kHz).
    n: usize,
    norm_block: usize,
    map: BandMap,
    n_lf: usize,
    hf_band: usize,
    flat_lo: usize,
    flat_hi: usize,
    lo_bin: usize,
    hf_lo: usize,
    hf_hi: usize,
    log2_bin: Vec<f32>,
    plan: Arc<dyn RealToComplex<f32>>,
}

impl Setup {
    fn new(sample_rate: u32) -> Self {
        let sr = sample_rate as f32;
        let hop = ((sr * 512.0 / 44_100.0).round() as usize).max(32);
        let n = ((sr * 0.04).round() as usize).next_power_of_two().max(256);
        let hi = HI_HZ.min(sr * 0.45);
        let edges = log_edges(NB, LO_HZ, hi);
        let map = BandMap::new(&edges, n, sample_rate);
        let n_lf = (0..NB).take_while(|&b| (edges[b] * edges[b + 1]).sqrt() < LF_HZ).count().max(1);
        let centre = |b: usize| (edges[b] * edges[b + 1]).sqrt();
        let hf_band = (0..NB).find(|&b| centre(b) >= HF_FLUX_HZ).unwrap_or(NB - 1);
        let flat_lo = (0..NB).find(|&b| centre(b) >= 60.0).unwrap_or(0);
        let flat_hi = (0..NB).rfind(|&b| centre(b) <= 10_000.0).unwrap_or(NB - 1) + 1;
        let hz_per_bin = sr / n as f32;
        let nbins = n / 2 + 1;
        let lo_bin = ((LO_HZ / hz_per_bin).ceil() as usize).min(nbins);
        let hf_lo = ((HF_LO_HZ / hz_per_bin).round() as usize).min(nbins);
        // Below ~5.6 kHz sample rate the region is empty (this used to slice hi..lo and panic).
        let hf_hi = (((HF_HI_HZ.min(sr * 0.45)) / hz_per_bin).round() as usize).clamp(hf_lo, nbins);
        let log2_bin: Vec<f32> = (0..n / 2 + 1).map(|k| ((k.max(1)) as f32 * hz_per_bin).log2()).collect();
        let plan = RealFftPlanner::<f32>::new().plan_fft_forward(n);
        Self { sr, hop, n, norm_block: norm_block(sample_rate), map, n_lf, hf_band, flat_lo, flat_hi, lo_bin, hf_lo, hf_hi, log2_bin, plan }
    }

    /// Analyse the windowed frame in `fft.input`: band powers into `row`, flatness, level and
    /// spectral sums.
    fn frame(&self, fft: &mut PowerFft, row: &mut [f32], flat: &mut f32, fd: &mut f32, sums: &mut [f32; 3]) {
        fft.process_input();
        self.map.apply(&fft.power, row);
        let fb = &row[self.flat_lo..self.flat_hi];
        let am = fb.iter().sum::<f32>() / fb.len() as f32;
        let gm = (fb.iter().map(|&p| (p + 1e-12).ln()).sum::<f32>() / fb.len() as f32).exp();
        *flat = if am > 1e-10 { (gm / am).clamp(0.0, 1.0) } else { 0.0 };
        let (total, hf, c) = spectral_sums(&fft.power, &self.log2_bin, self.lo_bin, self.hf_lo, self.hf_hi);
        *fd = db(total, 1e-12);
        *sums = [hf, total, c];
    }
}

/// Per-thread FFT and downmix scratch.
struct Worker {
    fft: PowerFft,
    local: Vec<f32>,
}

/// Frames per parallel work item.
const FRAMES_PER_TASK: usize = 64;

/// Incremental feature pass: push whole interleaved frames in any chunks, then `finish`.
pub(crate) struct FeatureStream {
    channels: usize,
    st: Setup,
    /// One per rayon worker thread (indexed by `rayon::current_thread_index`).
    workers: Vec<Mutex<Worker>>,
    /// Mono samples received.
    len: usize,
    /// Frames analysed so far (all frames whose window ends by `len`).
    done: usize,
    /// Mono samples `[tail_start, len)`: everything the next frames' windows still need.
    tail: Vec<f32>,
    tail_start: usize,
    /// Per frame: `NB` band powers (log-compressed at the end), flatness, level (dB) and
    /// spectral sums (HF power, total power, Σ power·log2 f).
    bands: Vec<f32>,
    flat: Vec<f32>,
    frame_db: Vec<f32>,
    sums: Vec<[f32; 3]>,
    /// Normalisation: levels of complete 100 ms blocks, and the running sum of squares of the
    /// current block (`lvl_n` samples so far).
    levels: Vec<f32>,
    lvl_acc: f32,
    lvl_n: usize,
}

impl FeatureStream {
    /// `channels >= 1`, `sample_rate >= 1000`.
    pub fn new(channels: usize, sample_rate: u32) -> Self {
        Self {
            channels,
            st: Setup::new(sample_rate),
            workers: Vec::new(),
            len: 0,
            done: 0,
            tail: Vec::new(),
            tail_start: 0,
            bands: Vec::new(),
            flat: Vec::new(),
            frame_db: Vec::new(),
            sums: Vec::new(),
            levels: Vec::new(),
            lvl_acc: -0.0,
            lvl_n: 0,
        }
    }

    /// Whole interleaved frames.
    pub fn push(&mut self, src: &[f32]) {
        let mono = Mono::new(src, self.channels);
        let m = mono.len();
        if m == 0 {
            return;
        }
        while self.workers.len() < rayon::current_num_threads().max(1) {
            self.workers.push(Mutex::new(Worker { fft: PowerFft::with_plan(self.st.plan.clone()), local: Vec::new() }));
        }
        let (pos, end) = (self.len, self.len + m);
        let ready = end / self.st.hop; // frames whose window ends by `end`
        let new_frames = ready - self.done;
        self.bands.resize(ready * NB, 0.0);
        self.flat.resize(ready, 0.0);
        self.frame_db.resize(ready, 0.0);
        self.sums.resize(ready, [0.0; 3]);

        let (st, workers, tail, tail_start, done) = (&self.st, &self.workers, &self.tail, self.tail_start, self.done);
        let frames = (&mut self.bands[done * NB..], &mut self.flat[done..], &mut self.frame_db[done..], &mut self.sums[done..]);
        let (lvl_acc, lvl_n, levels) = (&mut self.lvl_acc, &mut self.lvl_n, &mut self.levels);
        rayon::join(
            || {
                // Normalisation levels: finish the current block, whole blocks in parallel, keep
                // the remainder running.
                let block = st.norm_block;
                let mut buf = vec![0.0f32; (block - *lvl_n).min(m)];
                mono.fill(0, &mut buf);
                for x in &buf {
                    *lvl_acc += x * x;
                }
                *lvl_n += buf.len();
                let mut at = buf.len();
                if *lvl_n == block {
                    levels.push(db(*lvl_acc / block as f32, 1e-14));
                    *lvl_acc = -0.0; // `lvl_n` is set below
                    let whole = (m - at) / block;
                    levels.extend(block_levels(mono, at, whole, block));
                    at += whole * block;
                    buf.resize(m - at, 0.0);
                    mono.fill(at, &mut buf);
                    for x in &buf {
                        *lvl_acc += x * x;
                    }
                    *lvl_n = buf.len();
                }
            },
            || {
                if new_frames == 0 {
                    return;
                }
                let (bands, flat, fdb, sums) = frames;
                bands
                    .par_chunks_mut(FRAMES_PER_TASK * NB)
                    .zip(flat.par_chunks_mut(FRAMES_PER_TASK))
                    .zip(fdb.par_chunks_mut(FRAMES_PER_TASK))
                    .zip(sums.par_chunks_mut(FRAMES_PER_TASK))
                    .enumerate()
                    .for_each(|(ci, (((rows, flat), fdb), sums))| {
                        let w = &workers[rayon::current_thread_index().unwrap_or(0) % workers.len()];
                        let mut w = w.lock().unwrap_or_else(|p| p.into_inner());
                        let Worker { fft, local } = &mut *w;
                        let (n, hop) = (st.n, st.hop);
                        let t0 = done + ci * FRAMES_PER_TASK;
                        // Mono for every window of these frames: [lo, hi), from the tail kept
                        // from earlier pushes (before `pos`) and from `src`.
                        let lo = ((t0 + 1) * hop).saturating_sub(n);
                        let hi = (t0 + flat.len()) * hop;
                        local.clear();
                        local.resize(hi - lo, 0.0);
                        let split = pos.clamp(lo, hi);
                        if split > lo {
                            local[..split - lo].copy_from_slice(&tail[lo - tail_start..split - tail_start]);
                        }
                        mono.fill(split - pos, &mut local[split - lo..]);
                        for (j, row) in rows.chunks_mut(NB).enumerate() {
                            let end = (t0 + j + 1) * hop;
                            let start = end as isize - n as isize;
                            if start >= 0 {
                                let x = &local[start as usize - lo..end - lo];
                                for ((d, &w), &x) in fft.input.iter_mut().zip(&fft.window).zip(x) {
                                    *d = x * w;
                                }
                            } else {
                                for (i, (d, &w)) in fft.input.iter_mut().zip(&fft.window).enumerate() {
                                    let s = start + i as isize;
                                    *d = if s >= 0 { local[s as usize - lo] * w } else { 0.0 };
                                }
                            }
                            st.frame(fft, row, &mut flat[j], &mut fdb[j], &mut sums[j]);
                        }
                    });
            },
        );

        // Keep what the next frame's window needs: [(ready + 1)·hop − n, end).
        let keep_from = ((ready + 1) * self.st.hop).saturating_sub(self.st.n).min(end);
        let mut tail = Vec::with_capacity(end - keep_from);
        if keep_from < pos {
            tail.extend_from_slice(&self.tail[keep_from - self.tail_start..]);
        }
        let from = keep_from.max(pos);
        let at = tail.len();
        tail.resize(at + (end - from), 0.0);
        mono.fill(from - pos, &mut tail[at..]);
        self.tail = tail;
        self.tail_start = keep_from;
        self.len = end;
        self.done = ready;
    }

    pub fn finish(mut self) -> Features {
        let st = &self.st;
        let (len, hop, n) = (self.len, st.hop, st.n);
        let nfr = len.div_ceil(hop);
        // The last frame(s) run past the end of the track: zeros there.
        if nfr > self.done {
            let mut w = Worker { fft: PowerFft::with_plan(st.plan.clone()), local: Vec::new() };
            self.bands.resize(nfr * NB, 0.0);
            self.flat.resize(nfr, 0.0);
            self.frame_db.resize(nfr, 0.0);
            self.sums.resize(nfr, [0.0; 3]);
            for t in self.done..nfr {
                let start = ((t + 1) * hop) as isize - n as isize;
                for (i, (d, &wv)) in w.fft.input.iter_mut().zip(&w.fft.window).enumerate() {
                    let s = start + i as isize;
                    *d = if s >= 0 && (s as usize) < len { self.tail[s as usize - self.tail_start] * wv } else { 0.0 };
                }
                let row = &mut self.bands[t * NB..(t + 1) * NB];
                st.frame(&mut w.fft, row, &mut self.flat[t], &mut self.frame_db[t], &mut self.sums[t]);
            }
        }
        if self.lvl_n > 0 {
            self.levels.push(db(self.lvl_acc / self.lvl_n as f32, 1e-14));
        }
        let gain_db = normalisation_gain_db(&self.levels);
        let gain_pow = 10f32.powf(gain_db / 10.0);

        // Log-compressed bands.
        let mut logband = self.bands;
        logband.par_chunks_mut(4096).for_each(|c| {
            for r in c {
                *r = (1.0 + GAMMA * (*r * gain_pow).sqrt()).ln();
            }
        });

        // Spectral balance: per-frame sums accumulated per 256-frame chunk, then over chunks
        // (the order the batch pass always used).
        let mut acc = [0.0f64; 4]; // hf power, total power, Σ p·log2f, weight
        for chunk in self.sums.chunks(256) {
            let mut a = [0.0f64; 4];
            for &[hf, total, c] in chunk {
                a[0] += hf as f64;
                a[1] += total as f64;
                a[2] += c as f64;
                a[3] += total as f64;
            }
            for k in 0..4 {
                acc[k] += a[k];
            }
        }
        let hf_db = if acc[1] > 0.0 { (10.0 * (acc[0] / acc[1]).max(1e-12).log10()) as f32 } else { -60.0 };
        let centroid_hz = if acc[3] > 0.0 { 2f64.powf(acc[2] / acc[3]) as f32 } else { 0.0 };

        // Spectral flux against a ±1-band maximum of the previous frame (SuperFlux-style vibrato
        // suppression), half-wave rectified, averaged over bands.
        let (n_lf, hf_band) = (st.n_lf, st.hf_band);
        let mut flux = vec![0.0f32; nfr];
        let mut flux_lf = vec![0.0f32; nfr];
        let mut flux_hf = vec![0.0f32; nfr];
        flux.par_iter_mut().zip(flux_lf.par_iter_mut()).zip(flux_hf.par_iter_mut()).enumerate().skip(1).for_each(|(t, ((f, fl), fh))| {
            let cur = &logband[t * NB..(t + 1) * NB];
            let prev = &logband[(t - 1) * NB..t * NB];
            let mut s = 0.0f32;
            let mut s_lf = 0.0f32;
            let mut s_hf = 0.0f32;
            for (b, &c) in cur.iter().enumerate() {
                let lo = b.saturating_sub(1);
                let hi = (b + 1).min(NB - 1);
                let r = prev[lo..=hi].iter().copied().fold(f32::MIN, f32::max);
                let d = (c - r).max(0.0);
                s += d;
                if b < n_lf {
                    s_lf += d;
                }
                if b >= hf_band {
                    s_hf += d;
                }
            }
            *f = s / NB as f32;
            *fl = s_lf / n_lf as f32;
            *fh = s_hf / (NB - hf_band) as f32;
        });

        Features {
            fps: st.sr / hop as f32,
            // A sharp onset enters frame t's window within its last hop, but the flux (after the
            // envelope smoothing and peak interpolation downstream) peaks about 1.25 hops later
            // than the onset itself. Calibrated on synthetic kicks (tests/offline_tempo.rs) so
            // beat times land on the attack, which is where a beat pulse should be seen.
            time_offset: -0.25 * hop as f32 / st.sr,
            flux,
            flux_lf,
            flux_hf,
            flatness: self.flat,
            frame_db: self.frame_db,
            hf_db,
            centroid_hz,
        }
    }
}
