//! STFT feature pass over the mono downmix: onset-strength envelopes (spectral flux on
//! log-compressed log-spaced bands), per-frame level and spectral balance.

use rayon::prelude::*;
use realfft::RealFftPlanner;

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

pub(crate) fn downmix(samples: &[f32], channels: usize) -> Vec<f32> {
    let frames = samples.len() / channels;
    let mut mono = vec![0.0f32; frames];
    let inv = 1.0 / channels as f32;
    const CH: usize = 1 << 16;
    mono.par_chunks_mut(CH).zip(samples[..frames * channels].par_chunks(CH * channels)).for_each(|(out, inp)| {
        match channels {
            1 => out.copy_from_slice(inp),
            2 => {
                let (pairs, _) = inp.as_chunks::<2>();
                for (o, [l, r]) in out.iter_mut().zip(pairs) {
                    *o = (l + r) * 0.5;
                }
            }
            _ => {
                for (o, fr) in out.iter_mut().zip(inp.chunks_exact(channels)) {
                    *o = fr.iter().sum::<f32>() * inv;
                }
            }
        }
        for o in out.iter_mut() {
            if !o.is_finite() {
                *o = 0.0;
            }
        }
    });
    mono
}

/// Gain (dB) that brings the loud part of the track (90th percentile of 100 ms block RMS) to
/// `NORM_TARGET_DB`, clamped to ±60 dB.
fn normalisation_gain_db(mono: &[f32], sample_rate: u32) -> f32 {
    let block = (sample_rate as usize / 10).max(1);
    let mut levels: Vec<f32> =
        mono.par_chunks(block).map(|c| db(c.iter().map(|x| x * x).sum::<f32>() / c.len() as f32, 1e-14)).filter(|&d| d > -100.0).collect();
    if levels.is_empty() {
        return 0.0;
    }
    levels.sort_by(f32::total_cmp);
    let p90 = levels[((levels.len() - 1) as f32 * 0.9) as usize];
    (NORM_TARGET_DB - p90).clamp(-60.0, 60.0)
}

pub(crate) fn compute(mono: &[f32], sample_rate: u32) -> Features {
    let sr = sample_rate as f32;
    // ~11.6 ms hop (512 @ 44.1 kHz), ~46 ms window (2048 @ 44.1/48 kHz).
    let hop = ((sr * 512.0 / 44_100.0).round() as usize).max(32);
    let n = ((sr * 0.04).round() as usize).next_power_of_two().max(256);
    let fps = sr / hop as f32;
    let nfr = mono.len().div_ceil(hop);

    let gain_db = normalisation_gain_db(mono, sample_rate);
    let gain_pow = 10f32.powf(gain_db / 10.0);

    let hi = HI_HZ.min(sr * 0.45);
    let edges = log_edges(NB, LO_HZ, hi);
    let map = BandMap::new(&edges, n, sample_rate);
    let n_lf = (0..NB).take_while(|&b| (edges[b] * edges[b + 1]).sqrt() < LF_HZ).count().max(1);
    let centre = |b: usize| (edges[b] * edges[b + 1]).sqrt();
    let hf_band = (0..NB).find(|&b| centre(b) >= HF_FLUX_HZ).unwrap_or(NB - 1);
    let flat_lo = (0..NB).find(|&b| centre(b) >= 60.0).unwrap_or(0);
    let flat_hi = (0..NB).rfind(|&b| centre(b) <= 10_000.0).unwrap_or(NB - 1) + 1;
    let hz_per_bin = sr / n as f32;
    let hf_lo = (HF_LO_HZ / hz_per_bin).round() as usize;
    let hf_hi = ((HF_HI_HZ.min(sr * 0.45)) / hz_per_bin).round() as usize;
    let lo_bin = (LO_HZ / hz_per_bin).ceil() as usize;
    let log2_bin: Vec<f32> = (0..n / 2 + 1).map(|k| ((k.max(1)) as f32 * hz_per_bin).log2()).collect();

    let plan = RealFftPlanner::<f32>::new().plan_fft_forward(n);

    // Frame t's window ends at sample (t+1)·hop, i.e. covers [(t+1)·hop − n, (t+1)·hop).
    // Log bands, frame level and spectral-balance accumulators, computed in parallel chunks.
    let mut logband = vec![0.0f32; nfr * NB];
    let mut frame_db = vec![0.0f32; nfr];
    let mut flatness = vec![0.0f32; nfr];
    const CH: usize = 256;
    let stats: Vec<[f64; 4]> = logband
        .par_chunks_mut(CH * NB)
        .zip(frame_db.par_chunks_mut(CH))
        .zip(flatness.par_chunks_mut(CH))
        .enumerate()
        .map(|(ci, ((lb, fdb), flat))| {
            let mut fft = PowerFft::with_plan(plan.clone());
            let mut bands = [0.0f32; NB];
            let mut acc = [0.0f64; 4]; // hf power, total power, Σ p·log2f, weight
            for (j, (row, fd)) in lb.chunks_mut(NB).zip(fdb.iter_mut()).enumerate() {
                let t = ci * CH + j;
                let end = (t + 1) * hop;
                let start = end as isize - n as isize;
                for (i, (d, &w)) in fft.input.iter_mut().zip(&fft.window).enumerate() {
                    let s = start + i as isize;
                    *d = if s >= 0 && (s as usize) < mono.len() { mono[s as usize] * w } else { 0.0 };
                }
                fft.process_input();
                map.apply(&fft.power, &mut bands);
                for (r, &p) in row.iter_mut().zip(&bands) {
                    *r = (1.0 + GAMMA * (p * gain_pow).sqrt()).ln();
                }
                let fb = &bands[flat_lo..flat_hi];
                let am = fb.iter().sum::<f32>() / fb.len() as f32;
                let gm = (fb.iter().map(|&p| (p + 1e-12).ln()).sum::<f32>() / fb.len() as f32).exp();
                flat[j] = if am > 1e-10 { (gm / am).clamp(0.0, 1.0) } else { 0.0 };
                let total: f32 = fft.power[lo_bin..].iter().sum();
                *fd = db(total, 1e-12);
                let hf: f32 = fft.power[hf_lo.min(fft.power.len())..hf_hi.min(fft.power.len())].iter().sum();
                acc[0] += hf as f64;
                acc[1] += total as f64;
                let c: f32 = fft.power[lo_bin..].iter().zip(&log2_bin[lo_bin..]).map(|(p, l)| p * l).sum();
                acc[2] += c as f64;
                acc[3] += total as f64;
            }
            acc
        })
        .collect();
    let mut acc = [0.0f64; 4];
    for s in &stats {
        for k in 0..4 {
            acc[k] += s[k];
        }
    }
    let hf_db = if acc[1] > 0.0 { (10.0 * (acc[0] / acc[1]).max(1e-12).log10()) as f32 } else { -60.0 };
    let centroid_hz = if acc[3] > 0.0 { 2f64.powf(acc[2] / acc[3]) as f32 } else { 0.0 };

    // Spectral flux against a ±1-band maximum of the previous frame (SuperFlux-style vibrato
    // suppression), half-wave rectified, averaged over bands.
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
        fps,
        // A sharp onset enters frame t's window within its last hop, but the flux (after the
        // envelope smoothing and peak interpolation downstream) peaks about 1.25 hops later
        // than the onset itself. Calibrated on synthetic kicks (tests/offline_tempo.rs) so
        // beat times land on the attack, which is where a beat pulse should be seen.
        time_offset: -0.25 * hop as f32 / sr,
        flux,
        flux_lf,
        flux_hf,
        flatness,
        frame_db,
        hf_db,
        centroid_hz,
    }
}
