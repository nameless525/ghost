//! EBU R128 loudness (integrated, LRA, true peak) plus the momentary and short-term loudness
//! series that the energy curve and kiai detection are built from.
//!
//! Integrated loudness, loudness range and true peak reproduce the `ebur128` crate (0.1.x, the
//! libebur128 algorithm, fed the whole track in one `add_frames` call) **bit for bit**: same
//! filter structure and coefficients, same flushing of tiny filter states at every 100 ms
//! process boundary, the same summation order for every gating block (including the ring-buffer
//! rotation ebur128's sums follow), the same gating and percentile arithmetic, and the same
//! f32 polyphase true-peak interpolator. `tests` below compare against `ebur128` directly. One
//! deliberate difference: true peak also drains the interpolator at the end (as ebur128 does
//! when the track is followed by a few frames of silence), so a peak between the last samples
//! counts.
//! (On x86 ebur128 enables flush-to-zero instead of flushing; there the two can differ only once
//! a filter state has decayed into the subnormal range, i.e. not measurably.)
//!
//! What's different is the cost: one fused pass per channel computes the K-weighted gating-block
//! sums, the short-term (LRA) sums and the 100 ms series together (instead of ebur128 for I/LRA
//! plus a second filter pass for the series), the window sums run several independent
//! accumulators at once, channels run in parallel, and true peak is a vectorisable polyphase
//! kernel over parallel time chunks without ebur128's redundant K-filtering.
//!
//! Non-finite samples (NaN / ±inf) are read as silence. (ebur128 lets one NaN poison its filter
//! state, which made integrated loudness, LRA, the energy curve and intensity disappear, and one
//! inf sample removed true peak.)

use rayon::prelude::*;

/// Loudness series hop: one value every 100 ms (the R128 block hop).
pub(crate) const SERIES_HOP_SEC: f32 = 0.1;
/// Value used for silent blocks (ebur128 reports -inf).
pub(crate) const SILENCE_LUFS: f32 = -120.0;
/// Lowest sample rate measured. K-weighting's 1.68 kHz high shelf has to lie below Nyquist:
/// below 3.36 kHz its bilinear design is meaningless and mostly unstable (poles outside the unit
/// circle: the filter diverges to inf / NaN).
pub(crate) const MIN_RATE: u32 = 4_000;

/// ebur128's lowest histogram boundary (≈ -70 LUFS): blocks quieter than this are never stored.
#[allow(clippy::excessive_precision)]
const MIN_BLOCK_ENERGY: f64 = 0.000000117246530458229809506033624374;
/// Gating block (momentary window) and short-term window lengths, and the short-term hop that
/// ebur128 uses for LRA, all in 100 ms blocks.
const GATE_BLOCKS: usize = 4;
const ST_BLOCKS: usize = 30;
const ST_HOP_BLOCKS: usize = 10;
/// The per-channel pass keeps this many blocks of filtered history (plus as many again).
const SUPER_BLOCKS: usize = 30;

#[derive(Clone, Debug, Default)]
pub(crate) struct LoudnessPass {
    pub integrated: Option<f32>,
    pub lra: Option<f32>,
    pub true_peak_db: Option<f32>,
    /// Momentary loudness (400 ms window) sampled at the end of every 100 ms block.
    pub momentary: Vec<f32>,
    /// Short-term loudness (3 s window) sampled at the end of every 100 ms block.
    pub short_term: Vec<f32>,
}

fn finite(v: f64) -> Option<f32> {
    v.is_finite().then_some(v as f32)
}

#[inline(always)]
fn clean(x: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

/// Run the loudness measurement. `series` additionally records momentary/short-term loudness
/// every 100 ms; `lra` enables the loudness-range measurement (and, as in ebur128, a 3 s
/// filter history, which changes the gating sums' rounding order). The K-weighted pass and true
/// peak run in parallel.
pub(crate) fn measure(samples: &[f32], channels: usize, sample_rate: u32, series: bool, lra: bool) -> LoudnessPass {
    if channels == 0 || sample_rate < MIN_RATE || samples.len() < channels {
        return LoudnessPass::default();
    }
    let usable = samples.len() - samples.len() % channels;
    let mut stream = LoudnessStream::new(channels, sample_rate, series, lra);
    stream.push(&samples[..usable]);
    stream.finish()
}

/// Incremental [`measure`]: feed whole interleaved frames in any chunks; the result is
/// bit-identical to measuring the concatenation in one call.
pub(crate) struct LoudnessStream {
    k: KPass,
    tp: TpStream,
    series: bool,
    lra: bool,
}

impl LoudnessStream {
    /// `channels >= 1`, `sample_rate >= MIN_RATE`.
    pub fn new(channels: usize, sample_rate: u32, series: bool, lra: bool) -> Self {
        Self { k: KPass::new(channels, sample_rate, series, lra), tp: TpStream::new(channels, sample_rate), series, lra }
    }

    /// Whole interleaved frames.
    pub fn push(&mut self, src: &[f32]) {
        let (k, tp) = (&mut self.k, &mut self.tp);
        rayon::join(|| k.push(src), || tp.push(src));
    }

    /// Integrated loudness of everything pushed so far: once everything is pushed, exactly the
    /// value `finish` reports. Cheap (gating blocks are kept as they complete); nothing is
    /// consumed, so pushing may continue.
    pub fn integrated_so_far(&self) -> Option<f32> {
        finite(gated_loudness(&self.k.gating_now()))
    }

    pub fn finish(self) -> LoudnessPass {
        let k = self.k.finish();
        let integrated = finite(gated_loudness(&k.gating));
        let lra = if self.lra && integrated.is_some() { finite(loudness_range(k.short_term)) } else { None };
        let (momentary, short_term) = if self.series { series_windows(&k.series) } else { (Vec::new(), Vec::new()) };
        LoudnessPass { integrated, lra, true_peak_db: self.tp.finish(), momentary, short_term }
    }
}

/// BS.1770 channel weights for ebur128's default channel map (L, R, C, unused, Ls, Rs; 4ch =
/// L, R, Ls, Rs; 5ch = L, R, C, Ls, Rs; channels past the sixth unused).
fn channel_weight(channels: usize, c: usize) -> f64 {
    const SURROUND: f64 = 1.41;
    let surround = match channels {
        4 => [2, 3].contains(&c),
        5 => [3, 4].contains(&c),
        _ => [4, 5].contains(&c),
    };
    let front = match channels {
        4 => c < 2,
        5 => c < 3,
        _ => c < 3,
    };
    if surround {
        SURROUND
    } else if front {
        1.0
    } else {
        0.0
    }
}

/// ebur128's combined K-weighting filter: the two BS.1770 biquads multiplied out into one
/// 4th-order direct-form-II section (numerator `b`, denominator `a`), exactly as it computes it.
#[allow(non_snake_case)]
fn ebu_filter(rate: f64) -> ([f64; 5], [f64; 5]) {
    let f0 = 1681.974450955533;
    let G = 3.999843853973347;
    let Q = 0.7071752369554196;
    let K = f64::tan(std::f64::consts::PI * f0 / rate);
    let Vh = f64::powf(10.0, G / 20.0);
    let Vb = f64::powf(Vh, 0.4996667741545416);
    let mut pb = [0.0, 0.0, 0.0];
    let mut pa = [1.0, 0.0, 0.0];
    let rb = [1.0, -2.0, 1.0];
    let mut ra = [1.0, 0.0, 0.0];
    let a0 = 1.0 + K / Q + K * K;
    pb[0] = (Vh + Vb * K / Q + K * K) / a0;
    pb[1] = 2.0 * (K * K - Vh) / a0;
    pb[2] = (Vh - Vb * K / Q + K * K) / a0;
    pa[1] = 2.0 * (K * K - 1.0) / a0;
    pa[2] = (1.0 - K / Q + K * K) / a0;
    let f0 = 38.13547087602444;
    let Q = 0.5003270373238773;
    let K = f64::tan(std::f64::consts::PI * f0 / rate);
    ra[1] = 2.0 * (K * K - 1.0) / (1.0 + K / Q + K * K);
    ra[2] = (1.0 - K / Q + K * K) / (1.0 + K / Q + K * K);
    (
        [
            pb[0] * rb[0],
            pb[0] * rb[1] + pb[1] * rb[0],
            pb[0] * rb[2] + pb[1] * rb[1] + pb[2] * rb[0],
            pb[1] * rb[2] + pb[2] * rb[1],
            pb[2] * rb[2],
        ],
        [
            pa[0] * ra[0],
            pa[0] * ra[1] + pa[1] * ra[0],
            pa[0] * ra[2] + pa[1] * ra[1] + pa[2] * ra[0],
            pa[1] * ra[2] + pa[2] * ra[1],
            pa[2] * ra[2],
        ],
    )
}

/// K-weighting (BS.1770 pre-filter shelf + RLB high-pass) as two biquads for the 100 ms series,
/// coefficients derived for any sample rate exactly as libebur128 does.
#[allow(non_snake_case)]
fn k_filter(rate: f64) -> [[f64; 5]; 2] {
    let (f0, G, Q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
    let K = (std::f64::consts::PI * f0 / rate).tan();
    let Vh = 10f64.powf(G / 20.0);
    let Vb = Vh.powf(0.4996667741545416);
    let a0 = 1.0 + K / Q + K * K;
    let pre = [
        (Vh + Vb * K / Q + K * K) / a0,
        2.0 * (K * K - Vh) / a0,
        (Vh - Vb * K / Q + K * K) / a0,
        2.0 * (K * K - 1.0) / a0,
        (1.0 - K / Q + K * K) / a0,
    ];
    let (f0, Q) = (38.13547087602444, 0.5003270373238773);
    let K = (std::f64::consts::PI * f0 / rate).tan();
    let d = 1.0 + K / Q + K * K;
    let rlb = [1.0, -2.0, 1.0, 2.0 * (K * K - 1.0) / d, (1.0 - K / Q + K * K) / d];
    [pre, rlb]
}

/// ebur128's filter-state flush at the end of every `process` call (only on targets where it
/// does not switch the FPU to flush-to-zero instead).
#[inline]
fn flush_state(state: &mut [f64; 5]) {
    #[cfg(not(all(any(target_arch = "x86", target_arch = "x86_64"), target_feature = "sse2")))]
    for v in state.iter_mut() {
        if v.abs() < f64::EPSILON {
            *v = 0.0;
        }
    }
    #[cfg(all(any(target_arch = "x86", target_arch = "x86_64"), target_feature = "sse2"))]
    let _ = state;
}

#[derive(Clone, Copy)]
struct PassConfig {
    /// ebur128's `samples_in_100ms`.
    block: usize,
    /// ebur128's ring buffer length in blocks (400 ms or 3 s window, rounded up to whole blocks).
    ring_blocks: usize,
    lra: bool,
    series: bool,
    ebu_b: [f64; 5],
    ebu_a: [f64; 5],
    series_q: [[f64; 5]; 2],
}

/// Per-channel results of the fused pass.
struct ChannelSums {
    /// Unweighted sum of squared K-weighted samples over every gating block (400 ms, ending at
    /// block 4, 5, …), in ebur128's summation order.
    gating: Vec<f64>,
    /// Same over every LRA short-term block (3 s, ending at block 30, 40, 50, …).
    short_term: Vec<f64>,
    /// Weighted mean square of every 100 ms block (the series' own biquad filter).
    series: Vec<f64>,
}

struct KWeighted {
    /// Gating-block energies (all channels), in order.
    gating: Vec<f64>,
    short_term: Vec<f64>,
    /// 100 ms block energies for the momentary / short-term series.
    series: Vec<f64>,
}

/// The fused K-weighted pass over all channels, fed incrementally: channels in pairs (two
/// recursions per thread overlap for free), pairs in parallel.
struct KPass {
    channels: usize,
    cfg: PassConfig,
    used: Vec<usize>,
    pairs: Vec<KPair>,
}

enum KPair {
    Two(KStream<2>),
    One(KStream<1>),
}

impl KPass {
    fn new(channels: usize, sample_rate: u32, series: bool, lra: bool) -> Self {
        let block = (sample_rate as usize + 5) / 10;
        // ebur128::allocate_audio_data: the window in frames, rounded up to whole blocks.
        let window_ms = if lra { 3000 } else { 400 };
        let ring_blocks = (sample_rate as usize * window_ms / 1000).div_ceil(block);
        let (ebu_b, ebu_a) = ebu_filter(sample_rate as f64);
        let cfg = PassConfig { block, ring_blocks, lra, series, ebu_b, ebu_a, series_q: k_filter(sample_rate as f64) };
        let used: Vec<usize> = (0..channels).filter(|&c| channel_weight(channels, c) > 0.0).collect();
        let w = |c: usize| channel_weight(channels, c);
        let pairs = used
            .chunks(2)
            .map(|p| match *p {
                [c0, c1] => KPair::Two(KStream::new([c0, c1], [w(c0), w(c1)], &cfg)),
                [c0] => KPair::One(KStream::new([c0], [w(c0)], &cfg)),
                _ => unreachable!(),
            })
            .collect();
        Self { channels, cfg, used, pairs }
    }

    fn push(&mut self, src: &[f32]) {
        let (channels, cfg) = (self.channels, &self.cfg);
        let run = |p: &mut KPair| match p {
            KPair::Two(k) => k.push(src, channels, cfg),
            KPair::One(k) => k.push(src, channels, cfg),
        };
        if self.pairs.len() == 1 {
            run(&mut self.pairs[0]);
        } else {
            self.pairs.par_iter_mut().for_each(run);
        }
    }

    /// Gating-block energies so far, including blocks in the current, incomplete super-block
    /// (summed into scratch, exactly as `finish` will sum them).
    fn gating_now(&self) -> Vec<f64> {
        let per_channel: Vec<Vec<f64>> = self
            .pairs
            .iter()
            .flat_map(|p| match p {
                KPair::Two(k) => Vec::from(k.gating_now(&self.cfg)),
                KPair::One(k) => Vec::from(k.gating_now(&self.cfg)),
            })
            .collect();
        let refs: Vec<&Vec<f64>> = per_channel.iter().collect();
        combine(self.channels, &self.used, &refs, GATE_BLOCKS * self.cfg.block)
    }

    fn finish(self) -> KWeighted {
        let (channels, cfg, used) = (self.channels, self.cfg, self.used);
        let per_channel: Vec<ChannelSums> = self
            .pairs
            .into_iter()
            .flat_map(|p| match p {
                KPair::Two(k) => Vec::from(k.finish(&cfg)),
                KPair::One(k) => Vec::from(k.finish(&cfg)),
            })
            .collect();
        let gating: Vec<&Vec<f64>> = per_channel.iter().map(|p| &p.gating).collect();
        let short_term: Vec<&Vec<f64>> = per_channel.iter().map(|p| &p.short_term).collect();
        let gating = combine(channels, &used, &gating, GATE_BLOCKS * cfg.block);
        let short_term = combine(channels, &used, &short_term, ST_BLOCKS * cfg.block);
        let mut series = vec![0.0f64; per_channel.first().map_or(0, |p| p.series.len())];
        for ch in &per_channel {
            for (e, v) in series.iter_mut().zip(&ch.series) {
                *e += v;
            }
        }
        KWeighted { gating, short_term, series }
    }
}

/// Combine channels as ebur128::Filter::calc_gating_block does: per-channel sum, ×1.41 for
/// surround channels, summed in channel order, divided by the block length.
fn combine(channels: usize, used: &[usize], per_channel: &[&Vec<f64>], len: usize) -> Vec<f64> {
    let n = per_channel.first().map_or(0, |p| p.len());
    (0..n)
        .map(|i| {
            let mut sum = 0.0f64;
            for (ch, &c) in per_channel.iter().zip(used) {
                let mut s = ch[i];
                if channel_weight(channels, c) > 1.0 {
                    s *= 1.41; // surround (ebur128 leaves front channels unscaled)
                }
                sum += s;
            }
            sum / len as f64
        })
        .collect()
}

/// The whole K-weighted pass over a buffer.
#[cfg(test)]
fn k_weighted(samples: &[f32], channels: usize, sample_rate: u32, series: bool, lra: bool) -> KWeighted {
    let mut k = KPass::new(channels, sample_rate, series, lra);
    k.push(samples);
    k.finish()
}

/// One window to sum: elements `[0, split)` come from `hist[r1..]`, the rest from `hist[r2..]`.
#[derive(Clone, Copy)]
struct Win {
    r1: usize,
    split: usize,
    r2: usize,
}

/// Sum `len` elements of each of `G` windows, each strictly in its own order (so every sum is
/// bit-identical to a plain sequential loop), interleaving the windows for instruction-level
/// parallelism.
fn sum_windows<const G: usize>(hist: &[f64], wins: &[Win; G], len: usize) -> [f64; G] {
    let mut acc = [0.0f64; G];
    let mut cuts = [0usize; G];
    for (c, w) in cuts.iter_mut().zip(wins) {
        *c = w.split.min(len);
    }
    cuts.sort_unstable();
    let mut s0 = 0usize;
    for cut in cuts.into_iter().chain(std::iter::once(len)) {
        if cut <= s0 {
            continue;
        }
        let n = cut - s0;
        let sl: [&[f64]; G] = std::array::from_fn(|g| {
            let w = wins[g];
            let base = if s0 < w.split { w.r1 + s0 } else { w.r2 + (s0 - w.split) };
            &hist[base..base + n]
        });
        // Index loop on purpose: one step of every window per iteration.
        #[allow(clippy::needless_range_loop)]
        for i in 0..n {
            for g in 0..G {
                acc[g] += sl[g][i];
            }
        }
        s0 = cut;
    }
    acc
}

/// The window of `blocks` blocks ending at block `k` (1-based count of complete blocks), in the
/// order ebur128 sums it: its ring index after block `k` is `i` blocks; when `i < blocks` the
/// window wraps the ring, so the newest `i` blocks are summed first, then the older ones.
/// `first_block` is the global index of the block at `hist[0]`.
fn window(k: usize, blocks: usize, ring_blocks: usize, block: usize, first_block: usize) -> Win {
    let i = (k - 1) % ring_blocks + 1;
    let start = (k - blocks - first_block) * block;
    if i < blocks {
        let newest = (k - i - first_block) * block;
        Win { r1: newest, split: i * block, r2: start }
    } else {
        Win { r1: start, split: blocks * block, r2: start }
    }
}

/// Sum every window ending at a block in `ks`, up to six at a time.
fn sum_all(hist: &[f64], ks: &[usize], blocks: usize, cfg: &PassConfig, first_block: usize, out: &mut Vec<f64>) {
    let len = blocks * cfg.block;
    let win = |k: usize| window(k, blocks, cfg.ring_blocks, cfg.block, first_block);
    let mut ks = ks;
    while !ks.is_empty() {
        let n = match ks.len() {
            n if n >= 6 => 6,
            n => n,
        };
        let w = |i: usize| win(ks[i]);
        match n {
            6 => out.extend(sum_windows::<6>(hist, &[w(0), w(1), w(2), w(3), w(4), w(5)], len)),
            5 => out.extend(sum_windows::<5>(hist, &[w(0), w(1), w(2), w(3), w(4)], len)),
            4 => out.extend(sum_windows::<4>(hist, &[w(0), w(1), w(2), w(3)], len)),
            3 => out.extend(sum_windows::<3>(hist, &[w(0), w(1), w(2)], len)),
            2 => out.extend(sum_windows::<2>(hist, &[w(0), w(1)], len)),
            _ => out.extend(sum_windows::<1>(hist, &[w(0)], len)),
        }
        ks = &ks[n..];
    }
}

/// Filter state of one channel between blocks.
#[derive(Clone, Copy, Default)]
struct ChannelState {
    /// ebur128 direct-form-II state (`filter_state[1..5]`).
    s: [f64; 4],
    /// Series biquads, transposed direct form II.
    z: [[f64; 2]; 2],
}

/// Run one block of `N` channels (`cs`) through ebur128's K-weighting filter (squared outputs
/// into `dst`) and, if `SERIES`, the series biquads, returning each channel's series sum of
/// squares. The channels advance in lockstep and everything stays in registers, so up to four
/// independent recursions overlap; per channel, arithmetic and order are exactly those of
/// `ebur128::Filter::process` and the series filter.
#[inline(always)]
fn filter_block<const N: usize, const SERIES: bool>(
    src: &[f32],
    channels: usize,
    cs: [usize; N],
    dst: [&mut [f64]; N],
    state: &mut [ChannelState; N],
    cfg: &PassConfig,
    acc: [f64; N],
) -> [f64; N] {
    let [b0, b1, b2, b3, b4] = cfg.ebu_b;
    let [_, a1, a2, a3, a4] = cfg.ebu_a;
    let [[q00, q01, q02, q03, q04], [q10, q11, q12, q13, q14]] = cfg.series_q;
    let mut s1: [f64; N] = std::array::from_fn(|k| state[k].s[0]);
    let mut s2: [f64; N] = std::array::from_fn(|k| state[k].s[1]);
    let mut s3: [f64; N] = std::array::from_fn(|k| state[k].s[2]);
    let mut s4: [f64; N] = std::array::from_fn(|k| state[k].s[3]);
    let mut z00: [f64; N] = std::array::from_fn(|k| state[k].z[0][0]);
    let mut z01: [f64; N] = std::array::from_fn(|k| state[k].z[0][1]);
    let mut z10: [f64; N] = std::array::from_fn(|k| state[k].z[1][0]);
    let mut z11: [f64; N] = std::array::from_fn(|k| state[k].z[1][1]);
    let mut acc = acc;
    let n = dst[0].len();
    let dst: [&mut [f64]; N] = dst.map(|d| &mut d[..n]);
    for (i, fr) in src.chunks_exact(channels).take(n).enumerate() {
        for k in 0..N {
            let x = clean(fr[cs[k]]) as f64;
            let s0 = x - a1 * s1[k] - a2 * s2[k] - a3 * s3[k] - a4 * s4[k];
            let y = b0 * s0 + b1 * s1[k] + b2 * s2[k] + b3 * s3[k] + b4 * s4[k];
            s4[k] = s3[k];
            s3[k] = s2[k];
            s2[k] = s1[k];
            s1[k] = s0;
            dst[k][i] = y * y;
            if SERIES {
                let y1 = q00 * x + z00[k];
                z00[k] = q01 * x - q03 * y1 + z01[k];
                z01[k] = q02 * x - q04 * y1;
                let y2 = q10 * y1 + z10[k];
                z10[k] = q11 * y1 - q13 * y2 + z11[k];
                z11[k] = q12 * y1 - q14 * y2;
                acc[k] += y2 * y2;
            }
        }
    }
    for k in 0..N {
        state[k] = ChannelState { s: [s1[k], s2[k], s3[k], s4[k]], z: [[z00[k], z01[k]], [z10[k], z11[k]]] };
    }
    acc
}

/// [`filter_block`] for a channel pair with both lanes in 2×f64 NEON registers. NEON
/// multiply/add/subtract are exact IEEE per lane and are never fused here, so every value is
/// bit-identical to the scalar code; it just keeps all state in registers.
#[cfg(target_arch = "aarch64")]
#[inline(always)]
fn filter_block2<const SERIES: bool>(
    src: &[f32],
    channels: usize,
    cs: [usize; 2],
    dst: [&mut [f64]; 2],
    state: &mut [ChannelState; 2],
    cfg: &PassConfig,
    acc: [f64; 2],
) -> [f64; 2] {
    use std::arch::aarch64::*;
    // SAFETY: NEON is part of the aarch64 baseline; loads/stores go through 2-element arrays.
    unsafe {
        let ld = |v: [f64; 2]| vld1q_f64(v.as_ptr());
        let dup = |v: f64| vdupq_n_f64(v);
        let lanes = |v: float64x2_t| -> [f64; 2] { [vgetq_lane_f64::<0>(v), vgetq_lane_f64::<1>(v)] };
        let [b0, b1, b2, b3, b4] = cfg.ebu_b.map(dup);
        let [_, a1, a2, a3, a4] = cfg.ebu_a.map(dup);
        let [[q00, q01, q02, q03, q04], [q10, q11, q12, q13, q14]] = cfg.series_q.map(|q| q.map(dup));
        let mut s1 = ld([state[0].s[0], state[1].s[0]]);
        let mut s2 = ld([state[0].s[1], state[1].s[1]]);
        let mut s3 = ld([state[0].s[2], state[1].s[2]]);
        let mut s4 = ld([state[0].s[3], state[1].s[3]]);
        let mut z00 = ld([state[0].z[0][0], state[1].z[0][0]]);
        let mut z01 = ld([state[0].z[0][1], state[1].z[0][1]]);
        let mut z10 = ld([state[0].z[1][0], state[1].z[1][0]]);
        let mut z11 = ld([state[0].z[1][1], state[1].z[1][1]]);
        let mut acc = ld(acc);
        let n = dst[0].len().min(dst[1].len());
        let [d0, d1] = dst;
        let (d0, d1) = (&mut d0[..n], &mut d1[..n]);
        for (i, fr) in src.chunks_exact(channels).take(n).enumerate() {
            let x = ld([clean(fr[cs[0]]) as f64, clean(fr[cs[1]]) as f64]);
            let s0 =
                vsubq_f64(vsubq_f64(vsubq_f64(vsubq_f64(x, vmulq_f64(a1, s1)), vmulq_f64(a2, s2)), vmulq_f64(a3, s3)), vmulq_f64(a4, s4));
            let y = vaddq_f64(
                vaddq_f64(vaddq_f64(vaddq_f64(vmulq_f64(b0, s0), vmulq_f64(b1, s1)), vmulq_f64(b2, s2)), vmulq_f64(b3, s3)),
                vmulq_f64(b4, s4),
            );
            s4 = s3;
            s3 = s2;
            s2 = s1;
            s1 = s0;
            let [y0, y1] = lanes(vmulq_f64(y, y));
            d0[i] = y0;
            d1[i] = y1;
            if SERIES {
                let v1 = vaddq_f64(vmulq_f64(q00, x), z00);
                z00 = vaddq_f64(vsubq_f64(vmulq_f64(q01, x), vmulq_f64(q03, v1)), z01);
                z01 = vsubq_f64(vmulq_f64(q02, x), vmulq_f64(q04, v1));
                let v2 = vaddq_f64(vmulq_f64(q10, v1), z10);
                z10 = vaddq_f64(vsubq_f64(vmulq_f64(q11, v1), vmulq_f64(q13, v2)), z11);
                z11 = vsubq_f64(vmulq_f64(q12, v1), vmulq_f64(q14, v2));
                acc = vaddq_f64(acc, vmulq_f64(v2, v2));
            }
        }
        let (s1, s2, s3, s4) = (lanes(s1), lanes(s2), lanes(s3), lanes(s4));
        let (z00, z01, z10, z11) = (lanes(z00), lanes(z01), lanes(z10), lanes(z11));
        for k in 0..2 {
            state[k] = ChannelState { s: [s1[k], s2[k], s3[k], s4[k]], z: [[z00[k], z01[k]], [z10[k], z11[k]]] };
        }
        lanes(acc)
    }
}

/// One block of the fused pass: NEON for channel pairs on aarch64, scalar otherwise.
#[inline(always)]
fn run_block<const N: usize>(
    src: &[f32],
    channels: usize,
    cs: [usize; N],
    dst: [&mut [f64]; N],
    state: &mut [ChannelState; N],
    cfg: &PassConfig,
    acc: [f64; N],
) -> [f64; N] {
    #[cfg(target_arch = "aarch64")]
    if N == 2 {
        // N == 2: these reinterpretations are identities.
        let cs2: [usize; 2] = std::array::from_fn(|k| cs[k]);
        let mut it = dst.into_iter();
        let dst2: [&mut [f64]; 2] = std::array::from_fn(|_| it.next().unwrap());
        let st2: &mut [ChannelState; 2] = (&mut state[..]).try_into().unwrap();
        let acc2: [f64; 2] = std::array::from_fn(|k| acc[k]);
        let acc = if cfg.series {
            filter_block2::<true>(src, channels, cs2, dst2, st2, cfg, acc2)
        } else {
            filter_block2::<false>(src, channels, cs2, dst2, st2, cfg, acc2)
        };
        return std::array::from_fn(|k| acc[k]);
    }
    if cfg.series {
        filter_block::<N, true>(src, channels, cs, dst, state, cfg, acc)
    } else {
        filter_block::<N, false>(src, channels, cs, dst, state, cfg, acc)
    }
}

/// The fused pass over `N` channels (`cs`, series weights `ws`) in lockstep, fed whole frames in
/// any chunks. Blocks may be split across pushes: the filters and the block's series sum just
/// continue, so the result never depends on the chunking.
struct KStream<const N: usize> {
    cs: [usize; N],
    ws: [f64; N],
    state: [ChannelState; N],
    /// Per channel: squared K-weighted samples of the previous and the current super-block.
    hist: [Vec<f64>; N],
    /// Frames filtered so far.
    frames: usize,
    /// Series sum of squares of the current (incomplete) block.
    acc: [f64; N],
    out: [ChannelSums; N],
    ks: Vec<usize>,
}

impl<const N: usize> KStream<N> {
    fn new(cs: [usize; N], ws: [f64; N], cfg: &PassConfig) -> Self {
        Self {
            cs,
            ws,
            state: [ChannelState::default(); N],
            hist: std::array::from_fn(|_| vec![0.0f64; 2 * SUPER_BLOCKS * cfg.block]),
            frames: 0,
            acc: [0.0; N],
            out: std::array::from_fn(|_| ChannelSums { gating: Vec::new(), short_term: Vec::new(), series: Vec::new() }),
            ks: Vec::with_capacity(SUPER_BLOCKS),
        }
    }

    fn push(&mut self, src: &[f32], channels: usize, cfg: &PassConfig) {
        let b = cfg.block;
        let n = src.len() / channels;
        let mut i = 0;
        while i < n {
            let (blk, o) = (self.frames / b, self.frames % b);
            let (sb, j) = (blk / SUPER_BLOCKS, blk % SUPER_BLOCKS);
            let m = (b - o).min(n - i);
            let off = if sb == 0 { 0 } else { SUPER_BLOCKS * b } + j * b + o;
            let dst: [&mut [f64]; N] = {
                let mut it = self.hist.iter_mut();
                std::array::from_fn(|_| &mut it.next().unwrap()[off..off + m])
            };
            self.acc = run_block(&src[i * channels..(i + m) * channels], channels, self.cs, dst, &mut self.state, cfg, self.acc);
            i += m;
            self.frames += m;
            if o + m < b {
                continue;
            }
            // Block complete.
            if cfg.series {
                for k in 0..N {
                    self.out[k].series.push(self.ws[k] * self.acc[k] / b as f64);
                }
            }
            self.acc = [0.0; N];
            // ebur128 processes 400 ms first, then 100 ms at a time, flushing its filter state
            // (`filter_state[0..5]`, where [0] equals [1] here) after each call.
            if blk + 1 >= GATE_BLOCKS {
                for st in &mut self.state {
                    let mut full = [st.s[0], st.s[0], st.s[1], st.s[2], st.s[3]];
                    flush_state(&mut full);
                    st.s = [full[1], full[2], full[3], full[4]];
                }
            }
            if j == SUPER_BLOCKS - 1 {
                self.windows(sb, (sb + 1) * SUPER_BLOCKS, cfg);
                if sb > 0 {
                    for h in &mut self.hist {
                        h.copy_within(SUPER_BLOCKS * b.., 0);
                    }
                }
            }
        }
    }

    /// Sum the gating (and LRA short-term) windows ending at blocks `sb·30 + 1 ..= k_hi`.
    fn windows(&mut self, sb: usize, k_hi: usize, cfg: &PassConfig) {
        let first_block = (sb * SUPER_BLOCKS).saturating_sub(SUPER_BLOCKS);
        let k_lo = sb * SUPER_BLOCKS + 1;
        for k in 0..N {
            self.ks.clear();
            self.ks.extend((k_lo..=k_hi).filter(|&k| k >= GATE_BLOCKS));
            sum_all(&self.hist[k], &self.ks, GATE_BLOCKS, cfg, first_block, &mut self.out[k].gating);
            if cfg.lra {
                self.ks.clear();
                self.ks.extend((k_lo..=k_hi).filter(|&k| k >= ST_BLOCKS && k % ST_HOP_BLOCKS == 0));
                sum_all(&self.hist[k], &self.ks, ST_BLOCKS, cfg, first_block, &mut self.out[k].short_term);
            }
        }
    }

    /// Gating sums so far plus those of windows ending in the current, incomplete super-block
    /// (which `finish` would add), without consuming anything.
    fn gating_now(&self, cfg: &PassConfig) -> [Vec<f64>; N] {
        let mut out: [Vec<f64>; N] = std::array::from_fn(|k| self.out[k].gating.clone());
        let b = cfg.block;
        if !self.frames.is_multiple_of(SUPER_BLOCKS * b) {
            let sb = self.frames / (SUPER_BLOCKS * b);
            let first_block = (sb * SUPER_BLOCKS).saturating_sub(SUPER_BLOCKS);
            let ks: Vec<usize> = (sb * SUPER_BLOCKS + 1..=self.frames / b).filter(|&k| k >= GATE_BLOCKS).collect();
            for (h, o) in self.hist.iter().zip(out.iter_mut()) {
                sum_all(h, &ks, GATE_BLOCKS, cfg, first_block, o);
            }
        }
        out
    }

    fn finish(mut self, cfg: &PassConfig) -> [ChannelSums; N] {
        let b = cfg.block;
        if !self.frames.is_multiple_of(b) && cfg.series {
            // The final partial block still gets a series value (mean square over a full block).
            for k in 0..N {
                self.out[k].series.push(self.ws[k] * self.acc[k] / b as f64);
            }
        }
        // Windows in a final, incomplete super-block (complete ones were summed as they ended).
        if !self.frames.is_multiple_of(SUPER_BLOCKS * b) {
            self.windows(self.frames / (SUPER_BLOCKS * b), self.frames / b, cfg);
        }
        self.out
    }
}

/// ebur128's `energy_to_loudness`.
fn energy_to_loudness(energy: f64) -> f64 {
    10.0 * f64::log10(energy) - 0.691
}

/// ebur128 gated (integrated) loudness over its block-energy queue (non-histogram mode).
fn gated_loudness(energies: &[f64]) -> f64 {
    let kept: Vec<f64> = energies.iter().copied().filter(|e| e.is_nan() || *e >= MIN_BLOCK_ENERGY).collect();
    if kept.is_empty() {
        return f64::NEG_INFINITY;
    }
    let sum = 0.0 + kept.iter().sum::<f64>();
    if sum.is_nan() {
        return f64::NAN;
    }
    let relative_gate_factor = f64::powf(10.0, -10.0 / 10.0);
    let relative_threshold = (sum / kept.len() as f64) * relative_gate_factor;
    let (count, total) = kept.iter().filter(|&&e| e >= relative_threshold).fold((0u64, 0.0f64), |(n, t), &e| (n + 1, t + e));
    if count == 0 {
        return f64::NEG_INFINITY;
    }
    energy_to_loudness(total / count as f64)
}

/// ebur128 loudness range (EBU Tech 3342) over its short-term block queue.
fn loudness_range(energies: Vec<f64>) -> f64 {
    let mut q: Vec<f64> = energies.into_iter().filter(|e| e.is_nan() || *e >= MIN_BLOCK_ENERGY).collect();
    if q.iter().any(|e| e.is_nan()) {
        return f64::NAN;
    }
    q.sort_unstable_by(f64::total_cmp);
    if q.is_empty() {
        return 0.0;
    }
    let power = q.iter().sum::<f64>() / q.len() as f64;
    let minus_twenty_decibels = f64::powf(10.0, -20.0 / 10.0);
    let integrated = minus_twenty_decibels * power;
    let relgated = q.iter().take_while(|&v| *v < integrated).count();
    let relgated_size = q.len() - relgated;
    if let Some(relgated_size) = relgated_size.checked_sub(1) {
        let relgated_size = relgated_size as f64;
        let h_en = q[relgated + (relgated_size * 0.95 + 0.5) as usize];
        let l_en = q[relgated + (relgated_size * 0.1 + 0.5) as usize];
        energy_to_loudness(h_en) - energy_to_loudness(l_en)
    } else {
        0.0
    }
}

/// Momentary (400 ms) and short-term (3 s) loudness at the end of every 100 ms block, from
/// K-weighted block energies. (Querying ebur128 every 100 ms re-sums its whole window each
/// time; this is the same measure from one pass.)
fn series_windows(energy: &[f64]) -> (Vec<f32>, Vec<f32>) {
    let to_lufs = |e: f64| {
        if e > 1e-20 {
            ((-0.691 + 10.0 * e.log10()) as f32).max(SILENCE_LUFS)
        } else {
            SILENCE_LUFS
        }
    };
    let window = |n: usize| -> Vec<f32> {
        let mut acc = 0.0f64;
        (0..energy.len())
            .map(|i| {
                acc += energy[i];
                if i >= n {
                    acc -= energy[i - n];
                }
                to_lufs(acc.max(0.0) / n as f64)
            })
            .collect()
    };
    (window(4), window(30))
}

/// ebur128's true-peak interpolator coefficients: a 48-tap Hann-windowed sinc split into
/// `F` phases of `A` taps (`filter[tap][phase]`).
fn tp_coeffs<const A: usize, const F: usize>() -> [[f32; F]; A] {
    use std::f64::consts::PI;
    let mut filter = [[0f32; F]; A];
    for (j, coeff) in filter.iter_mut().flat_map(|x| x.iter_mut()).enumerate() {
        let j = j as f64;
        let window = 48.0;
        let w = 0.5 * (1.0 - f64::cos(2.0 * PI * j / window));
        let m = j - window / 2.0;
        *coeff = if m.abs() > 0.000001 { w * f64::sin(m * PI / F as f64) / (m * PI / F as f64) } else { w } as f32;
    }
    filter
}

/// Largest |sample| and |interpolated sample| of one channel. `x` holds `A - 1` frames of
/// history followed by the frames to measure. Every output is accumulated exactly as ebur128's
/// `InterpF::interpolate` does (from 0.0, tap by tap, separate multiply and add), lanes run
/// over consecutive output frames so the loop vectorises, and NaN never wins a comparison.
fn tp_channel<const A: usize, const F: usize>(x: &[f32], coef: &[[f32; F]; A]) -> f32 {
    const L: usize = 8;
    let n = x.len() + 1 - A;
    let mut pk = [0.0f32; L];
    let mut sp = [0.0f32; L];
    let mut t = 0;
    while t + L <= n {
        let mut acc = [[0.0f32; L]; F];
        for (tap, c) in coef.iter().enumerate() {
            let xs: &[f32; L] = x[A - 1 + t - tap..A - 1 + t - tap + L].try_into().unwrap();
            for p in 0..F {
                for i in 0..L {
                    acc[p][i] += xs[i] * c[p];
                }
            }
        }
        for a in &acc {
            for i in 0..L {
                let v = a[i].abs();
                if v > pk[i] {
                    pk[i] = v;
                }
            }
        }
        let xs: &[f32; L] = x[A - 1 + t..A - 1 + t + L].try_into().unwrap();
        for i in 0..L {
            let v = xs[i].abs();
            if v > sp[i] {
                sp[i] = v;
            }
        }
        t += L;
    }
    let mut peak = 0.0f32;
    for v in pk.into_iter().chain(sp) {
        if v > peak {
            peak = v;
        }
    }
    for t in t..n {
        for p in 0..F {
            let mut acc = 0.0f32;
            for (tap, c) in coef.iter().enumerate() {
                acc += x[A - 1 + t - tap] * c[p];
            }
            let v = acc.abs();
            if v > peak {
                peak = v;
            }
        }
        let v = x[A - 1 + t].abs();
        if v > peak {
            peak = v;
        }
    }
    peak
}

/// Peak over frames `[s, e)` of `cur` (all channels): sample peak and (below 192 kHz) the
/// true peak of ebur128's 4× (2× from 96 kHz) interpolator. The `A - 1` frames before `cur` are
/// `hist` (zeros before the track starts), so any chunking gives the same answer as one pass.
fn tp_range<const A: usize, const F: usize>(hist: &[f32], cur: &[f32], channels: usize, s: usize, e: usize, coef: &[[f32; F]; A]) -> f32 {
    const CHUNK: usize = 4096;
    let mut buf = vec![0.0f32; CHUNK + A - 1];
    let mut peak = 0.0f32;
    let mut t0 = s;
    while t0 < e {
        let t1 = (t0 + CHUNK).min(e);
        let len = t1 - t0 + A - 1;
        for c in 0..channels {
            for (i, d) in buf[..len].iter_mut().enumerate() {
                let f = (t0 + i) as isize - (A as isize - 1);
                *d = clean(if f >= 0 { cur[f as usize * channels + c] } else { hist[(f + A as isize - 1) as usize * channels + c] });
            }
            let v = tp_channel::<A, F>(&buf[..len], coef);
            if v > peak {
                peak = v;
            }
        }
        t0 = t1;
    }
    peak
}

/// Streaming true peak (dBTP) of all channels; each push is measured in parallel time chunks.
struct TpStream {
    kind: TpKind,
    channels: usize,
    rate: u32,
    /// The last `A - 1` frames pushed (interpolator history).
    hist: Vec<f32>,
    peak: f32,
}

enum TpKind {
    X4(Box<[[f32; 4]; 12]>),
    X2(Box<[[f32; 2]; 24]>),
    /// ebur128 does not oversample at 192 kHz and up: the sample peak.
    X1,
}

impl TpStream {
    fn new(channels: usize, rate: u32) -> Self {
        let (kind, taps) = if rate < 96_000 {
            (TpKind::X4(Box::new(tp_coeffs::<12, 4>())), 12)
        } else if rate < 192_000 {
            (TpKind::X2(Box::new(tp_coeffs::<24, 2>())), 24)
        } else {
            (TpKind::X1, 1)
        };
        Self { kind, channels, rate, hist: vec![0.0; (taps - 1) * channels], peak: 0.0 }
    }

    fn push(&mut self, src: &[f32]) {
        let channels = self.channels;
        let frames = src.len() / channels;
        if frames == 0 {
            return;
        }
        let threads = rayon::current_num_threads().max(1);
        let chunk = (frames / (threads * 2)).max(self.rate as usize * 5).max(1);
        let starts: Vec<usize> = (0..frames).step_by(chunk).collect();
        let hist = &self.hist;
        let run = |f: &(dyn Fn(usize, usize) -> f32 + Sync)| -> f32 {
            if starts.len() == 1 {
                return f(0, frames);
            }
            starts.par_iter().map(|&s| f(s, (s + chunk).min(frames))).reduce(|| 0.0, |a, b| if b > a { b } else { a })
        };
        let v = match &self.kind {
            TpKind::X4(c) => run(&|s, e| tp_range::<12, 4>(hist, src, channels, s, e, c)),
            TpKind::X2(c) => run(&|s, e| tp_range::<24, 2>(hist, src, channels, s, e, c)),
            TpKind::X1 => run(&|s, e| tp_range::<1, 1>(hist, src, channels, s, e, &[[1.0]])),
        };
        if v > self.peak {
            self.peak = v;
        }
        // Keep the last `A - 1` frames of history ++ src.
        let keep = self.hist.len();
        if keep > 0 {
            if src.len() >= keep {
                self.hist.copy_from_slice(&src[src.len() - keep..]);
            } else {
                self.hist.copy_within(src.len().., 0);
                let at = keep - src.len();
                self.hist[at..].copy_from_slice(src);
            }
        }
    }

    fn finish(mut self) -> Option<f32> {
        // The interpolator lags its input by up to `A - 1` frames: the reconstructed waveform
        // between the last samples only comes out once silence follows them.
        let tail = vec![0.0; self.hist.len()];
        self.push(&tail);
        let peak = self.peak as f64;
        if peak > 0.0 && peak.is_finite() {
            Some((20.0 * peak.log10()) as f32)
        } else {
            None
        }
    }
}

/// True peak (dBTP) of a whole buffer.
#[cfg(test)]
fn true_peak(samples: &[f32], channels: usize, sample_rate: u32) -> Option<f32> {
    let mut t = TpStream::new(channels, sample_rate);
    t.push(samples);
    t.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ebur128::{EbuR128, Mode};

    fn xorshift(x: &mut u32) -> f32 {
        *x ^= *x << 13;
        *x ^= *x >> 17;
        *x ^= *x << 5;
        *x as f32 / u32::MAX as f32 - 0.5
    }

    /// Bursty noise plus tones, with stretches of digital silence (filter states decay and get
    /// flushed) and a final partial block.
    fn signal(channels: usize, rate: u32, secs: f32, seed: u32) -> Vec<f32> {
        let frames = (rate as f32 * secs) as usize + 37;
        let mut x = seed;
        (0..frames * channels)
            .map(|i| {
                let t = (i / channels) as f32 / rate as f32;
                // Includes digital silence and near-subnormal passages, where ebur128's state
                // flushes change the output.
                let env = match (t * 1.7) as usize % 7 {
                    0 => 0.6,
                    1 => 0.02,
                    2 => 0.0,
                    3 => 1.3,
                    4 => 3e-17,
                    5 => 1e-9,
                    _ => 0.2,
                };
                if env == 0.0 {
                    return 0.0;
                }
                env * (xorshift(&mut x) + 0.4 * (t * 300.0 * (1 + i % channels) as f32).sin())
            })
            .collect()
    }

    /// The pre-optimisation measurement: ebur128 over the whole track in one call.
    fn reference(samples: &[f32], channels: usize, rate: u32, lra: bool) -> (f64, Option<f64>, f64) {
        let mode = if lra { Mode::I | Mode::LRA } else { Mode::I };
        let mut e = EbuR128::new(channels as u32, rate, mode).unwrap();
        e.add_frames_f32(samples).unwrap();
        let i = e.loudness_global().unwrap();
        let r = lra.then(|| e.loudness_range().unwrap());
        (i, r, reference_true_peak(samples, channels, rate))
    }

    /// ebur128's true peak of the track followed by enough silence to drain its interpolator
    /// (at most 23 frames, at 2x).
    fn reference_true_peak(samples: &[f32], channels: usize, rate: u32) -> f64 {
        let mut t = EbuR128::new(channels as u32, rate, Mode::TRUE_PEAK).unwrap();
        t.add_frames_f32(samples).unwrap();
        t.add_frames_f32(&vec![0.0; 23 * channels]).unwrap();
        (0..channels as u32).map(|c| t.true_peak(c).unwrap()).fold(0.0f64, f64::max)
    }

    /// Integrated loudness, LRA and true peak equal ebur128's to the last bit.
    #[test]
    fn matches_ebur128_bit_for_bit() {
        let cases = [
            (2usize, 48_000u32, 13.0f32),
            (2, 44_100, 9.5),
            (1, 22_050, 7.0),
            (1, 8_000, 6.0),
            (2, 11_024, 5.0), // ring rounds up to 31 blocks
            (3, 32_000, 4.0),
            (4, 96_000, 4.5),
            (5, 16_000, 6.0),
            (6, 44_100, 4.0),
            (8, 48_000, 3.5),
            (2, 192_000, 3.2),
            (2, 48_000, 0.35), // shorter than one gating block
        ];
        for (n, &(channels, rate, secs)) in cases.iter().enumerate() {
            let s = signal(channels, rate, secs, 7 + n as u32);
            for lra in [false, true] {
                let (ri, rl, rtp) = reference(&s, channels, rate, lra);
                let k = k_weighted(&s, channels, rate, false, lra);
                // Every gating block: feeding 400 ms then 100 ms at a time gives ebur128 the same
                // process boundaries as one call, and its momentary reading is the block energy.
                let mode = if lra { Mode::I | Mode::LRA } else { Mode::I };
                let mut e = EbuR128::new(channels as u32, rate, mode).unwrap();
                let b = (rate as usize + 5) / 10;
                let mut blocks = 0;
                let mut at = 0;
                while at + if at == 0 { 4 * b } else { b } <= s.len() / channels {
                    let n = if at == 0 { 4 * b } else { b };
                    e.add_frames_f32(&s[at * channels..(at + n) * channels]).unwrap();
                    at += n;
                    let m = e.loudness_momentary().unwrap();
                    let g = k.gating[blocks];
                    let mine = if g <= 0.0 { f64::NEG_INFINITY } else { energy_to_loudness(g) };
                    assert_eq!(mine.to_bits(), m.to_bits(), "{channels}ch {rate} lra={lra}: block {blocks}: {mine} vs {m}");
                    blocks += 1;
                }
                assert_eq!(blocks, k.gating.len());
                let i = gated_loudness(&k.gating);
                assert_eq!(i.to_bits(), ri.to_bits(), "{channels}ch {rate} lra={lra}: integrated {i} vs {ri}");
                if let Some(rl) = rl {
                    let l = loudness_range(k.short_term);
                    assert_eq!(l.to_bits(), rl.to_bits(), "{channels}ch {rate}: LRA {l} vs {rl}");
                }
                let tp = true_peak(&s, channels, rate);
                let rtp = (rtp > 0.0).then(|| (20.0 * rtp.log10()) as f32);
                assert_eq!(tp.map(f32::to_bits), rtp.map(f32::to_bits), "{channels}ch {rate}: true peak {tp:?} vs {rtp:?}");
            }
        }
    }

    /// The scalar channel-pair kernel (used off aarch64) and the NEON one agree bit for bit.
    #[cfg(target_arch = "aarch64")]
    #[test]
    fn scalar_and_neon_pair_kernels_agree() {
        let s = signal(3, 44_100, 2.0, 5);
        let (ebu_b, ebu_a) = ebu_filter(44_100.0);
        let cfg = PassConfig { block: 4410, ring_blocks: 30, lra: true, series: true, ebu_b, ebu_a, series_q: k_filter(44_100.0) };
        for series in [false, true] {
            let cfg = PassConfig { series, ..cfg };
            let (mut sa, mut sb) = ([ChannelState::default(); 2], [ChannelState::default(); 2]);
            let n = s.len() / 3;
            let (mut a0, mut a1, mut b0, mut b1) = (vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]);
            let ra = if series {
                filter_block::<2, true>(&s, 3, [2, 0], [&mut a0, &mut a1], &mut sa, &cfg, [0.5, 0.25])
            } else {
                filter_block::<2, false>(&s, 3, [2, 0], [&mut a0, &mut a1], &mut sa, &cfg, [0.5, 0.25])
            };
            let rb = if series {
                filter_block2::<true>(&s, 3, [2, 0], [&mut b0, &mut b1], &mut sb, &cfg, [0.5, 0.25])
            } else {
                filter_block2::<false>(&s, 3, [2, 0], [&mut b0, &mut b1], &mut sb, &cfg, [0.5, 0.25])
            };
            let bits = |v: &[f64]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
            assert_eq!(bits(&a0), bits(&b0));
            assert_eq!(bits(&a1), bits(&b1));
            assert_eq!(bits(&ra), bits(&rb));
            for k in 0..2 {
                assert_eq!(bits(&sa[k].s), bits(&sb[k].s));
                assert_eq!(bits(&sa[k].z.concat()), bits(&sb[k].z.concat()));
            }
        }
    }

    /// Chunked true peak equals one pass over the whole track, wherever the chunks fall.
    #[test]
    fn true_peak_is_chunking_independent() {
        let s = signal(2, 44_100, 3.0, 99);
        let coef = tp_coeffs::<12, 4>();
        let zeros = [0.0f32; 22];
        let whole = tp_range::<12, 4>(&zeros, &s, 2, 0, s.len() / 2, &coef);
        for cut in [1usize, 7, 11, 12, 4095, 4096, 50_000] {
            let a = tp_range::<12, 4>(&zeros, &s, 2, 0, cut, &coef);
            let b = tp_range::<12, 4>(&zeros, &s, 2, cut, s.len() / 2, &coef);
            assert_eq!(a.max(b).to_bits(), whole.to_bits(), "cut {cut}");
            // Streaming: the second half sees the first half only through the pushed history.
            let mut t = TpStream::new(2, 44_100);
            t.push(&s[..cut * 2]);
            t.push(&s[cut * 2..]);
            assert_eq!(t.finish(), true_peak(&s, 2, 44_100), "stream cut {cut}");
        }
    }

    /// A peak between the very last samples counts: whole-track and chunked measurement agree
    /// with the drained reference, and appending silence changes nothing.
    #[test]
    fn true_peak_includes_the_end_of_the_track() {
        for (channels, rate) in [(1usize, 44_100u32), (1, 48_000), (2, 96_000), (2, 44_100)] {
            // A second of silence, then an abrupt [0.7, -0.7, -0.7, 0.7] (its overshoot lies
            // between the two -0.7s) in the last channel.
            let mut s = vec![0.0f32; rate as usize * channels];
            for v in [0.7f32, -0.7, -0.7, 0.7] {
                s.extend(std::iter::repeat_n(0.0, channels - 1));
                s.push(v);
            }
            let whole = measure(&s, channels, rate, false, true).true_peak_db.unwrap();
            let mut padded = s.clone();
            padded.extend(std::iter::repeat_n(0.0, 48 * channels));
            assert_eq!(whole.to_bits(), measure(&padded, channels, rate, false, true).true_peak_db.unwrap().to_bits(), "{channels}ch {rate}");
            let reference = (20.0 * reference_true_peak(&s, channels, rate).log10()) as f32;
            assert_eq!(whole.to_bits(), reference.to_bits(), "{channels}ch {rate}: {whole} vs {reference}");
            assert!(whole > 0.5, "{channels}ch {rate}: {whole} dBTP (sample peak is -3.1 dB)");
            for cut in [1, 2, 3, 5, 4800] {
                let at = s.len() - cut * channels;
                let mut l = LoudnessStream::new(channels, rate, false, true);
                l.push(&s[..at]);
                l.push(&s[at..]);
                assert_eq!(l.finish().true_peak_db.map(f32::to_bits), Some(whole.to_bits()), "{channels}ch {rate}: cut {cut}");
            }
        }
    }

    /// The one-pass series matches ebur128's own momentary / short-term readings.
    #[test]
    fn series_matches_ebur128_queries() {
        for (channels, rate) in [(2usize, 44_100u32), (1, 48_000), (6, 32_000)] {
            let frames = rate as usize * 8;
            let mut x = 1u32;
            let samples: Vec<f32> = (0..frames * channels)
                .map(|i| {
                    let t = (i / channels) as f32 / rate as f32;
                    let env = if (t as usize).is_multiple_of(3) { 0.5 } else { 0.05 };
                    env * xorshift(&mut x) + 0.2 * (t * 300.0 * (1 + i % channels) as f32).sin()
                })
                .collect();
            let k = k_weighted(&samples, channels, rate, true, false);
            let (m, s) = series_windows(&k.series);
            let mut ebu = EbuR128::new(channels as u32, rate, Mode::S).unwrap();
            let hop = ((rate as usize + 5) / 10) * channels;
            for (i, chunk) in samples.chunks(hop).enumerate() {
                ebu.add_frames_f32(chunk).unwrap();
                let em = ebu.loudness_momentary().unwrap() as f32;
                let es = ebu.loudness_shortterm().unwrap() as f32;
                assert!((em - m[i]).abs() < 0.02, "{channels}ch {rate}: momentary[{i}] {em} vs {}", m[i]);
                assert!((es - s[i]).abs() < 0.02, "{channels}ch {rate}: short-term[{i}] {es} vs {}", s[i]);
            }
        }
    }

    /// Non-finite samples read as silence instead of poisoning the measurement.
    #[test]
    fn non_finite_samples_are_ignored() {
        let clean_sig = signal(2, 48_000, 6.0, 3);
        let mut dirty = clean_sig.clone();
        let ref_l = measure(&clean_sig, 2, 48_000, true, true);
        for (i, v) in dirty.iter_mut().enumerate().step_by(4801) {
            *v = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY][i % 3];
        }
        let l = measure(&dirty, 2, 48_000, true, true);
        assert!(l.integrated.is_some() && l.lra.is_some() && l.true_peak_db.is_some(), "{l:?}");
        assert!((l.integrated.unwrap() - ref_l.integrated.unwrap()).abs() < 0.1);
        assert!(l.momentary.iter().zip(&ref_l.momentary).all(|(a, b)| (a - b).abs() < 1.0));
    }
}
