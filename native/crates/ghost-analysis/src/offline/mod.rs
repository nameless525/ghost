//! Offline whole-track analysis: EBU R128 loudness, tempo + beat grid, kiai sections, energy
//! curve and intensity stars.
//!
//! Pipeline (`analyze`), with the two halves running in parallel on rayon:
//! - loudness: `ebur128` integrated / LRA, true peak measured in parallel time chunks, and
//!   100 ms momentary / short-term (BS.1770 K-weighted) series computed per channel;
//! - spectral: mono downmix → 46 ms Hann STFT at an ~11.6 ms hop → 40 log bands →
//!   log-compressed spectral flux (onset envelope) → tempo (autocorrelation, log-Gaussian
//!   prior, octave check) → Ellis DP beat tracker → downbeat phase → onset picking.
//!
//! Then the energy curve (momentary loudness), intensity (see `intensity.rs`) and kiai
//! (short-term loudness + onset density with hysteresis; only for tracks ≥ 2.5★) are derived
//! from both.

mod features;
mod intensity;
mod loudness;
mod sections;
mod tempo;

pub use intensity::{intensity as intensity_from_inputs, IntensityInputs, IntensityParts};
pub use tempo::TempoDiag;

use crate::ENERGY_POINTS;

/// Full-track analysis, stored in the catalog DB.
#[derive(Clone, Debug, Default)]
pub struct OfflineAnalysis {
    pub integrated_lufs: Option<f32>,
    pub loudness_range: Option<f32>,
    pub true_peak_db: Option<f32>,
    pub bpm: Option<f32>,
    /// 0..1
    pub bpm_confidence: f32,
    /// Beat times in seconds (empty when confidence is low).
    pub beats: Vec<f32>,
    pub downbeats: Vec<f32>,
    /// High-energy sections, [start, end] seconds.
    pub kiai: Vec<(f32, f32)>,
    /// ENERGY_POINTS values, 0..1.
    pub energy: Vec<f32>,
    /// 0..10 osu!-style stars.
    pub intensity: Option<f32>,
    pub duration_ms: u64,
}

/// Intermediate features behind an [`OfflineAnalysis`] (diagnostics / calibration; additive API).
#[derive(Clone, Debug, Default)]
pub struct AnalysisDetails {
    /// Tempo estimate even when confidence was too low to publish it.
    pub bpm_estimate: Option<f32>,
    pub tempo: TempoDiag,
    /// Detected onset times, seconds.
    pub onsets: Vec<f32>,
    /// Onsets per second over the audible part of the track.
    pub onset_density: f32,
    /// Mean spectral flux over the audible part of the track.
    pub mean_flux: f32,
    /// Power in 2.5–12 kHz relative to the whole spectrum, dB.
    pub hf_db: f32,
    pub centroid_hz: f32,
    /// Mean spectral flux above ~2 kHz (percussive activity).
    pub hf_flux: f32,
    /// Mean spectral flux below ~200 Hz (kick / bass activity).
    pub lf_flux: f32,
    /// Mean spectral flatness (60 Hz–10 kHz), 0..1.
    pub flatness: f32,
    pub intensity_inputs: IntensityInputs,
    pub intensity_parts: IntensityParts,
}

/// Loudness summary (additive API; see [`loudness_full`]).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Loudness {
    pub integrated_lufs: Option<f32>,
    pub loudness_range: Option<f32>,
    /// True peak, dBTP.
    pub true_peak_db: Option<f32>,
}

/// Analyse a whole decoded track. `samples` are interleaved f32 at `sample_rate`.
pub fn analyze(samples: &[f32], channels: usize, sample_rate: u32) -> OfflineAnalysis {
    analyze_detailed(samples, channels, sample_rate).0
}

/// Loudness only (fast path for normalisation before the full analysis is done).
///
/// Returns `(integrated LUFS, true peak dBTP)`: the gain to apply and the headroom it leaves.
/// Both are `None` for silence or input too short to measure (< 400 ms).
pub fn loudness(samples: &[f32], channels: usize, sample_rate: u32) -> (Option<f32>, Option<f32>) {
    let l = loudness::measure(samples, channels, sample_rate, false, false);
    (l.integrated, l.true_peak_db)
}

/// Integrated loudness, loudness range and true peak.
pub fn loudness_full(samples: &[f32], channels: usize, sample_rate: u32) -> Loudness {
    let l = loudness::measure(samples, channels, sample_rate, false, true);
    Loudness { integrated_lufs: l.integrated, loudness_range: l.lra, true_peak_db: l.true_peak_db }
}

/// [`analyze`] plus the intermediate features.
pub fn analyze_detailed(samples: &[f32], channels: usize, sample_rate: u32) -> (OfflineAnalysis, AnalysisDetails) {
    let frames = samples.len().checked_div(channels).unwrap_or(0);
    let duration_ms = if sample_rate > 0 { frames as u64 * 1000 / sample_rate as u64 } else { 0 };
    let mut out = OfflineAnalysis { duration_ms, energy: vec![0.0; ENERGY_POINTS], ..Default::default() };
    if channels == 0 || sample_rate < 1000 || frames == 0 {
        return (out, AnalysisDetails::default());
    }
    let samples = &samples[..frames * channels];
    let duration = frames as f32 / sample_rate as f32;

    let (loud, spectral) = rayon::join(
        || loudness::measure(samples, channels, sample_rate, true, true),
        || {
            let mono = features::downmix(samples, channels);
            let f = features::compute(&mono, sample_rate);
            drop(mono);
            let os = tempo::gauss_smooth(&f.flux, 1.0);
            let active = tempo::active_range(&f);
            let beats = tempo::track(&f, &os, active);
            let onsets = active.map(|r| tempo::pick_onsets(&os, f.fps, r)).unwrap_or_default();
            (f, active, beats, onsets)
        },
    );
    let (f, active, beats, onsets) = spectral;

    out.integrated_lufs = loud.integrated;
    out.loudness_range = loud.lra;
    out.true_peak_db = loud.true_peak_db;
    out.bpm_confidence = beats.confidence;
    if beats.confidence >= tempo::MIN_CONFIDENCE {
        out.bpm = beats.bpm;
    }
    out.beats = beats.beats;
    out.downbeats = beats.downbeats;

    let onset_times: Vec<f32> = onsets.iter().map(|&t| f.time_of(t as f32)).collect();
    out.energy = sections::energy_curve(&loud.momentary, duration);

    // Audible frames (within 45 dB of the loud level) for per-second / per-frame averages.
    let mut means = [0.0f32; 4]; // flux, hf flux, lf flux, flatness
    let mut onset_density = 0.0;
    if let Some((a, b)) = active {
        let thr = tempo::active_threshold(&f).unwrap_or(-80.0);
        let mut n = 0usize;
        for t in a..b {
            if f.frame_db[t] > thr {
                n += 1;
                means[0] += f.flux[t];
                means[1] += f.flux_hf[t];
                means[2] += f.flux_lf[t];
                means[3] += f.flatness[t];
            }
        }
        for m in &mut means {
            *m /= n.max(1) as f32;
        }
        onset_density = onsets.len() as f32 / (n as f32 / f.fps).max(1.0);
    }
    let mean_flux = means[0];

    let inputs = IntensityInputs {
        bpm: beats.bpm,
        bpm_confidence: beats.confidence,
        onset_density,
        mean_flux,
        flatness: means[3],
        integrated_lufs: loud.integrated,
        loudness_range: loud.lra,
        hf_db: f.hf_db,
    };
    let (stars, parts) = intensity::intensity(&inputs);
    if active.is_some() && loud.integrated.is_some() {
        out.intensity = Some(stars);
        // Calm pieces never enter kiai mode, however much they swell.
        if stars >= sections::KIAI_MIN_STARS {
            out.kiai = sections::kiai(&loud.short_term, &loud.momentary, &onset_times, duration, &out.beats, &out.downbeats);
        }
    }

    let details = AnalysisDetails {
        bpm_estimate: beats.bpm,
        tempo: beats.diag,
        onsets: onset_times,
        onset_density,
        mean_flux,
        hf_db: f.hf_db,
        centroid_hz: f.centroid_hz,
        hf_flux: means[1],
        lf_flux: means[2],
        flatness: means[3],
        intensity_inputs: inputs,
        intensity_parts: parts,
    };
    (out, details)
}
