//! EBU R128 loudness (integrated, LRA, true peak) via the `ebur128` crate, plus the momentary
//! and short-term loudness series that the energy curve and kiai detection are built from.

use ebur128::{EbuR128, Mode};
use rayon::prelude::*;

/// Loudness series hop: one value every 100 ms (the R128 block hop).
pub(crate) const SERIES_HOP_SEC: f32 = 0.1;
/// Value used for silent blocks (ebur128 reports -inf).
pub(crate) const SILENCE_LUFS: f32 = -120.0;

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

fn finite(v: Result<f64, ebur128::Error>) -> Option<f32> {
    v.ok().filter(|x| x.is_finite()).map(|x| x as f32)
}

/// Run the loudness measurement. `series` additionally records momentary/short-term loudness
/// every 100 ms; `lra` enables the loudness-range measurement. Gated loudness, true peak and the
/// series run in parallel.
pub(crate) fn measure(samples: &[f32], channels: usize, sample_rate: u32, series: bool, lra: bool) -> LoudnessPass {
    if channels == 0 || sample_rate < 16 || samples.len() < channels {
        return LoudnessPass::default();
    }
    let usable = samples.len() - samples.len() % channels;
    let samples = &samples[..usable];
    let ((integrated, lra_v), (true_peak_db, (momentary, short_term))) = rayon::join(
        || gated_loudness(samples, channels, sample_rate, lra),
        || {
            rayon::join(
                || true_peak(samples, channels, sample_rate),
                || if series { loudness_series(samples, channels, sample_rate) } else { (Vec::new(), Vec::new()) },
            )
        },
    );
    LoudnessPass { integrated, lra: lra_v, true_peak_db, momentary, short_term }
}

fn gated_loudness(samples: &[f32], channels: usize, sample_rate: u32, lra: bool) -> (Option<f32>, Option<f32>) {
    let mode = if lra { Mode::I | Mode::LRA } else { Mode::I };
    let Ok(mut ebu) = EbuR128::new(channels as u32, sample_rate, mode) else {
        return (None, None);
    };
    let _ = ebu.add_frames_f32(samples);
    let integrated = finite(ebu.loudness_global());
    let lra_v = if lra && integrated.is_some() { finite(ebu.loudness_range()) } else { None };
    (integrated, lra_v)
}

/// BS.1770 channel weights for ebur128's default channel map (L, R, C, unused, Ls, Rs; 4ch =
/// L, R, Ls, Rs; 5ch = L, R, C, Ls, Rs), so the series matches the gated measurement.
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

/// K-weighting (BS.1770 pre-filter shelf + RLB high-pass) as two biquads, coefficients derived
/// for any sample rate exactly as libebur128 does.
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

/// Momentary (400 ms) and short-term (3 s) loudness at the end of every 100 ms block, from
/// K-weighted block energies. (Querying ebur128 every 100 ms re-sums its whole window each
/// time, which dominated the analysis; this is the same measure in one pass per channel.)
fn loudness_series(samples: &[f32], channels: usize, sample_rate: u32) -> (Vec<f32>, Vec<f32>) {
    let frames = samples.len() / channels;
    let block = (sample_rate as usize + 5) / 10;
    let nblocks = frames.div_ceil(block);
    let coeffs = k_filter(sample_rate as f64);
    let per_channel: Vec<Vec<f64>> = (0..channels)
        .into_par_iter()
        .filter(|&c| channel_weight(channels, c) > 0.0)
        .map(|c| {
            let w = channel_weight(channels, c);
            let mut z = [[0.0f64; 2]; 2]; // transposed direct form II state per biquad
            let mut out = vec![0.0f64; nblocks];
            for (bi, o) in out.iter_mut().enumerate() {
                let a = bi * block;
                let b = (a + block).min(frames);
                let mut acc = 0.0f64;
                for f in a..b {
                    let mut x = samples[f * channels + c] as f64;
                    for (k, q) in coeffs.iter().enumerate() {
                        let y = q[0] * x + z[k][0];
                        z[k][0] = q[1] * x - q[3] * y + z[k][1];
                        z[k][1] = q[2] * x - q[4] * y;
                        x = y;
                    }
                    acc += x * x;
                }
                *o = w * acc / block as f64;
            }
            out
        })
        .collect();
    let mut energy = vec![0.0f64; nblocks];
    for ch in &per_channel {
        for (e, v) in energy.iter_mut().zip(ch) {
            *e += v;
        }
    }
    let to_lufs = |e: f64| if e > 1e-20 { ((-0.691 + 10.0 * e.log10()) as f32).max(SILENCE_LUFS) } else { SILENCE_LUFS };
    let window = |n: usize| -> Vec<f32> {
        let mut acc = 0.0f64;
        (0..nblocks)
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

/// True peak (dBTP) of all channels. The oversampling filter is the expensive part of R128, so
/// the track is split into time chunks measured in parallel and the maximum taken. Each chunk's
/// meter is first primed with the preceding samples in a separate call whose peaks are
/// discarded (`prev_true_peak` reports only the last call), so chunk starts don't ring, and
/// each chunk runs a little past its end so the interpolator's delay doesn't drop samples.
fn true_peak(samples: &[f32], channels: usize, sample_rate: u32) -> Option<f32> {
    let frames = samples.len() / channels;
    let threads = rayon::current_num_threads().max(1);
    let min_chunk = sample_rate as usize * 5;
    let chunk = (frames / (threads * 2)).max(min_chunk).max(1);
    const WARMUP: usize = 256;
    const TAIL: usize = 64;
    let starts: Vec<usize> = (0..frames).step_by(chunk).collect();
    let peak = starts
        .par_iter()
        .map(|&s| {
            let a = s.saturating_sub(WARMUP);
            let b = (s + chunk + TAIL).min(frames);
            let Ok(mut ebu) = EbuR128::new(channels as u32, sample_rate, Mode::TRUE_PEAK) else {
                return 0.0f64;
            };
            if a < s {
                let _ = ebu.add_frames_f32(&samples[a * channels..s * channels]);
            }
            let _ = ebu.add_frames_f32(&samples[s * channels..b * channels]);
            (0..channels as u32).filter_map(|c| ebu.prev_true_peak(c).ok()).fold(0.0f64, f64::max)
        })
        .reduce(|| 0.0, f64::max);
    if peak > 0.0 && peak.is_finite() {
        Some((20.0 * peak.log10()) as f32)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one-pass series matches ebur128's own momentary / short-term readings.
    #[test]
    fn series_matches_ebur128_queries() {
        for (channels, rate) in [(2usize, 44_100u32), (1, 48_000), (6, 32_000)] {
            let frames = rate as usize * 8;
            let mut x = 1u32;
            let samples: Vec<f32> = (0..frames * channels)
                .map(|i| {
                    x ^= x << 13;
                    x ^= x >> 17;
                    x ^= x << 5;
                    let t = (i / channels) as f32 / rate as f32;
                    let env = if (t as usize).is_multiple_of(3) { 0.5 } else { 0.05 };
                    env * ((x as f32 / u32::MAX as f32) - 0.5) + 0.2 * (t * 300.0 * (1 + i % channels) as f32).sin()
                })
                .collect();
            let (m, s) = loudness_series(&samples, channels, rate);
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
}
