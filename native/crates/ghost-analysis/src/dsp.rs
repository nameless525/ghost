//! Shared DSP helpers: windows, FFT power spectra and log-spaced band maps.

use std::sync::Arc;

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};

/// Periodic Hann window (the right choice for overlapped STFT analysis).
pub(crate) fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let x = std::f64::consts::PI * i as f64 / n as f64;
            (x.sin() * x.sin()) as f32
        })
        .collect()
}

/// Geometric band edges (`nb + 1` values) from `f_lo` to `f_hi` Hz.
pub(crate) fn log_edges(nb: usize, f_lo: f32, f_hi: f32) -> Vec<f32> {
    let ratio = (f_hi as f64 / f_lo as f64).ln();
    (0..=nb).map(|i| (f_lo as f64 * (ratio * i as f64 / nb as f64).exp()) as f32).collect()
}

/// A planned real FFT with its own buffers: windowed frame in, normalised power spectrum out.
///
/// Power is scaled so that a full-scale sine summed over its Hann main lobe reads 1.0
/// (0 dB), i.e. band power in dB is directly comparable to dBFS of a sine.
pub(crate) struct PowerFft {
    plan: Arc<dyn RealToComplex<f32>>,
    pub input: Vec<f32>,
    output: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    pub window: Vec<f32>,
    /// `n / 2 + 1` bins.
    pub power: Vec<f32>,
    norm: f32,
}

impl PowerFft {
    pub fn new(planner: &mut RealFftPlanner<f32>, n: usize) -> Self {
        Self::with_plan(planner.plan_fft_forward(n))
    }

    /// Fresh buffers around an existing (shareable) plan, e.g. one per worker thread.
    pub fn with_plan(plan: Arc<dyn RealToComplex<f32>>) -> Self {
        let n = plan.len();
        let window = hann(n);
        let wsum: f32 = window.iter().sum();
        // |X| of a sine at a bin centre = A * wsum / 2; the Hann main lobe holds 1.5 bins of
        // equivalent noise bandwidth, so divide that out too.
        let norm = 4.0 / (wsum * wsum) / 1.5;
        Self {
            input: plan.make_input_vec(),
            output: plan.make_output_vec(),
            scratch: plan.make_scratch_vec(),
            power: vec![0.0; n / 2 + 1],
            plan,
            window,
            norm,
        }
    }

    pub fn len(&self) -> usize {
        self.window.len()
    }

    /// Window `frame` (must be `len()` samples) and compute the power spectrum. No allocation.
    pub fn process(&mut self, frame: &[f32]) {
        for ((d, &s), &w) in self.input.iter_mut().zip(frame).zip(&self.window) {
            *d = s * w;
        }
        self.process_input();
    }

    /// Compute the power spectrum of `self.input`, which the caller has already windowed.
    pub fn process_input(&mut self) {
        // Lengths always match (buffers come from the plan), so this cannot fail.
        let _ = self.plan.process_with_scratch(&mut self.input, &mut self.output, &mut self.scratch);
        let norm = self.norm;
        for (p, c) in self.power.iter_mut().zip(&self.output) {
            *p = (c.re * c.re + c.im * c.im) * norm;
        }
    }
}

/// Map from an FFT power spectrum to bands.
///
/// Bands at least one bin wide read the integral of the linearly interpolated power spectrum
/// over the band (a sparse weighted sum of bins), so wide bands sum their bins and a sine reads
/// the same in any band.
///
/// Bands narrower than one bin (the bass end of a log scale) read the spectrum *at* their centre
/// frequency, interpolated with a cubic spline through the four nearest bins in the log-power
/// domain (close to exact for a Hann main lobe), so a tone between two bins peaks near its true
/// frequency and the bars form a smooth hump instead of empty bands or a staircase of repeated
/// bin values.
pub(crate) struct BandMap {
    starts: Vec<u32>,
    idx: Vec<u32>,
    w: Vec<f32>,
    /// Per band: fractional centre bin when the band is narrower than a bin, else negative.
    narrow: Vec<f32>,
}

impl BandMap {
    pub fn new(edges_hz: &[f32], fft_size: usize, sample_rate: u32) -> Self {
        let nbins = fft_size / 2 + 1;
        let hz_per_bin = sample_rate as f64 / fft_size as f64;
        let max_bin = (nbins - 1) as f64;
        let mut starts = vec![0u32];
        let mut idx = Vec::new();
        let mut w = Vec::new();
        let mut narrow = Vec::new();
        for pair in edges_hz.windows(2) {
            let a = (pair[0] as f64 / hz_per_bin).clamp(0.0, max_bin);
            let b = (pair[1] as f64 / hz_per_bin).clamp(0.0, max_bin);
            let width = b - a;
            if width < 1.0 && nbins >= 4 {
                let centre = if a > 0.0 { (a * b).sqrt() } else { 0.5 * (a + b) };
                narrow.push(centre as f32);
            } else {
                narrow.push(-1.0);
                let j0 = a.floor() as usize;
                let j1 = (b.ceil() as usize).min(nbins - 1);
                let mut acc = vec![0.0f64; j1 - j0 + 1];
                for j in j0..j1 {
                    let s = a.max(j as f64);
                    let e = b.min(j as f64 + 1.0);
                    if e <= s {
                        continue;
                    }
                    let (u0, u1) = (s - j as f64, e - j as f64);
                    let half_sq = (u1 * u1 - u0 * u0) * 0.5;
                    acc[j - j0] += (u1 - u0) - half_sq;
                    acc[j + 1 - j0] += half_sq;
                }
                for (k, v) in acc.into_iter().enumerate() {
                    if v > 0.0 {
                        idx.push((j0 + k) as u32);
                        w.push(v as f32);
                    }
                }
            }
            starts.push(idx.len() as u32);
        }
        Self { starts, idx, w, narrow }
    }

    pub fn bands(&self) -> usize {
        self.starts.len() - 1
    }

    /// Fill `out` with band powers. No allocation.
    #[inline]
    pub fn apply(&self, power: &[f32], out: &mut [f32]) {
        let last = power.len() - 1;
        for (b, o) in out.iter_mut().enumerate().take(self.bands()) {
            let c = self.narrow[b];
            if c >= 0.0 {
                // Catmull-Rom spline through the log power of the four surrounding bins:
                // continuous in frequency, so a gliding tone's peak glides across the bands.
                let j = (c.floor() as usize).clamp(1, last - 2);
                let t = c - j as f32;
                const EPS: f32 = 1e-20;
                let p0 = (power[j - 1] + EPS).ln();
                let p1 = (power[j] + EPS).ln();
                let p2 = (power[j + 1] + EPS).ln();
                let p3 = (power[j + 2] + EPS).ln();
                let y = 0.5
                    * (2.0 * p1 + (p2 - p0) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t + (3.0 * (p1 - p2) + p3 - p0) * t * t * t);
                // A tone halfway between bins really is ~1.4 dB above both (Hann scalloping);
                // allow that, but cap the spline's overshoot on irregular (noisy) spectra.
                *o = y.min(p1.max(p2) + 0.35).exp();
                continue;
            }
            let (s, e) = (self.starts[b] as usize, self.starts[b + 1] as usize);
            let mut acc = 0.0f32;
            for k in s..e {
                acc += self.w[k] * power[self.idx[k] as usize];
            }
            *o = acc;
        }
    }
}

/// Power in dB with a floor (`10·log10(p + floor)`).
#[inline]
pub(crate) fn db(p: f32, floor: f32) -> f32 {
    10.0 * (p + floor).log10()
}

/// One-pole smoothing coefficient for time constant `tau` seconds over a step of `dt` seconds.
#[inline]
pub(crate) fn one_pole(dt: f32, tau: f32) -> f32 {
    if tau <= 0.0 {
        1.0
    } else {
        1.0 - (-dt / tau).exp()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn band_map_sine_reads_zero_db_and_narrow_bands_are_filled() {
        let sr = 48_000;
        let n = 4096;
        let mut planner = RealFftPlanner::new();
        let mut fft = PowerFft::new(&mut planner, n);
        let f = 86.0 * sr as f32 / n as f32; // bin-centred, ~1 kHz
        let frame: Vec<f32> = (0..n).map(|i| (2.0 * std::f32::consts::PI * f * i as f32 / sr as f32).sin()).collect();
        fft.process(&frame);
        // One wide band around the tone: should read ~0 dB.
        let map = BandMap::new(&[f * 0.8, f * 1.25], n, sr);
        let mut out = [0.0f32; 1];
        map.apply(&fft.power, &mut out);
        assert!((db(out[0], 1e-12)).abs() < 0.3, "{}", db(out[0], 1e-12));
        // Many narrow bands at low frequency: none empty.
        let edges = log_edges(40, 30.0, 200.0);
        let map = BandMap::new(&edges, n, sr);
        let mut out = vec![0.0f32; map.bands()];
        let low: Vec<f32> = (0..n).map(|i| (2.0 * std::f32::consts::PI * 50.0 * i as f32 / sr as f32).sin()).collect();
        fft.process(&low);
        map.apply(&fft.power, &mut out);
        assert!(out.iter().all(|&v| v > 0.0 && v.is_finite()));
        // The 50 Hz tone peaks in the band containing 50 Hz.
        let peak = out.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        assert!(edges[peak] <= 52.0 && edges[peak + 1] >= 48.0, "peak band {peak}: {}..{}", edges[peak], edges[peak + 1]);
    }
}
