//! Intensity ★: an osu!-style 0..10 "difficulty" rating for a piece of music.
//!
//! ## Formula
//!
//! Each input is mapped to 0..1 with a clamped linear ramp `r(x, lo, hi)`:
//!
//! | term     | definition                                              | 0 at → 1 at          |
//! |----------|---------------------------------------------------------|----------------------|
//! | `conf`   | `r(bpm_confidence, 0.25, 0.6)`                          |                      |
//! | `tempo`  | `conf · r(bpm, 80, 180)`                                | 80 → 180 BPM         |
//! | `act`    | `r(ln mean_flux, ln 0.012, ln 0.07)`                    | spectral change rate |
//! | `drive`  | `tempo · (0.25 + 0.75·act)` — fast *and* busy           |                      |
//! | `tex`    | `r(flatness, 0.03, 0.35)` — full/noisy/distorted mix    |                      |
//! | `bright` | `r(hf_db, -30, -10)` — 2.5–12 kHz share of the power    |                      |
//! | `loud`   | `r(integrated LUFS, -24, -9)`                           |                      |
//! | `dens`   | `r(log2 onsets/s, 0, 2.5)` — 1 → 5.7 onsets/s           |                      |
//! | `dyn`    | `r(LRA, 5, 18)` — wide macro-dynamics read as calmer     |                      |
//!
//! `raw = 2.6·drive + 1.0·act + 1.8·tex + 1.2·bright + 2.6·loud + 0.4·dens − 1.2·dyn − 1.2`
//!
//! `stars = curve(raw)`, a fixed monotone piecewise-linear calibration curve ([`CURVE`]): close
//! to identity through the middle, a soft floor so ambient pieces land around 0.3–1★ rather
//! than all at 0, and a little expansion above ~4 so intense tracks spread across 5–8★.
//!
//! The weights were fitted (then rounded and sign-constrained) against ~40 hand-rated game
//! tracks spanning chiptune (GB/SNES/N64), orchestral, metal and lo-fi soundtracks, aiming
//! for calm town / ambient ≈ 1–2★, field / overworld ≈ 3–4★ and battle / boss ≈ 5.5–7.5★.
//! Tempo only counts when the beat grid is trustworthy and the music is actually busy, which
//! keeps slow arpeggiated pieces (whose beat tracker may lock to the faster pulse) calm.

#[derive(Clone, Debug, Default)]
pub struct IntensityInputs {
    pub bpm: Option<f32>,
    pub bpm_confidence: f32,
    /// Peak-picked onsets per second over the audible part of the track.
    pub onset_density: f32,
    /// Mean spectral flux (nats per band per frame) over the audible part of the track.
    pub mean_flux: f32,
    /// Mean spectral flatness (60 Hz–10 kHz), 0..1.
    pub flatness: f32,
    pub integrated_lufs: Option<f32>,
    pub loudness_range: Option<f32>,
    /// Power in 2.5–12 kHz relative to the whole spectrum, dB.
    pub hf_db: f32,
}

/// The 0..1 terms of the formula and the pre-curve score (diagnostics).
#[derive(Clone, Debug, Default)]
pub struct IntensityParts {
    pub tempo: f32,
    pub activity: f32,
    pub drive: f32,
    pub texture: f32,
    pub brightness: f32,
    pub loudness: f32,
    pub density: f32,
    pub dynamics: f32,
    pub raw: f32,
}

const W_DRIVE: f32 = 2.6;
const W_ACT: f32 = 1.0;
const W_TEX: f32 = 1.8;
const W_BRIGHT: f32 = 1.2;
const W_LOUD: f32 = 2.6;
const W_DENS: f32 = 0.4;
const W_DYN: f32 = 1.2;
const BIAS: f32 = -1.2;

/// Calibration curve (raw score → stars).
pub const CURVE: [(f32, f32); 12] = [
    (-2.0, 0.2),
    (-1.0, 0.35),
    (0.0, 0.6),
    (1.0, 1.2),
    (2.0, 2.0),
    (3.0, 3.0),
    (4.0, 4.3),
    (5.0, 5.7),
    (6.0, 6.9),
    (7.0, 7.8),
    (8.0, 8.5),
    (10.0, 9.5),
];

fn ramp(x: f32, lo: f32, hi: f32) -> f32 {
    if !x.is_finite() {
        return 0.0;
    }
    ((x - lo) / (hi - lo)).clamp(0.0, 1.0)
}

fn curve(x: f32) -> f32 {
    let (first, last) = (CURVE[0], CURVE[CURVE.len() - 1]);
    if x <= first.0 {
        return first.1;
    }
    for w in CURVE.windows(2) {
        let ((a, fa), (b, fb)) = (w[0], w[1]);
        if x <= b {
            return fa + (fb - fa) * (x - a) / (b - a);
        }
    }
    last.1
}

/// Stars (0..10) and the terms behind them.
pub fn intensity(i: &IntensityInputs) -> (f32, IntensityParts) {
    let conf = ramp(i.bpm_confidence, 0.25, 0.6);
    let tempo = conf * i.bpm.map(|b| ramp(b, 80.0, 180.0)).unwrap_or(0.0);
    let activity = ramp(i.mean_flux.max(1e-6).ln(), 0.012f32.ln(), 0.07f32.ln());
    let drive = tempo * (0.25 + 0.75 * activity);
    let texture = ramp(i.flatness, 0.03, 0.35);
    let brightness = ramp(i.hf_db, -30.0, -10.0);
    let loudness = i.integrated_lufs.map(|l| ramp(l, -24.0, -9.0)).unwrap_or(0.0);
    let density = ramp(i.onset_density.max(1e-3).log2(), 0.0, 2.5);
    let dynamics = i.loudness_range.map(|r| ramp(r, 5.0, 18.0)).unwrap_or(0.0);
    let raw = W_DRIVE * drive + W_ACT * activity + W_TEX * texture + W_BRIGHT * brightness + W_LOUD * loudness + W_DENS * density
        - W_DYN * dynamics
        + BIAS;
    let stars = curve(raw).clamp(0.0, 10.0);
    (stars, IntensityParts { tempo, activity, drive, texture, brightness, loudness, density, dynamics, raw })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_is_monotone_and_bounded() {
        let mut prev = -1.0;
        let mut x = -5.0;
        while x < 15.0 {
            let y = curve(x);
            assert!(y >= prev && (0.0..=10.0).contains(&y));
            prev = y;
            x += 0.01;
        }
    }

    #[test]
    fn each_input_pushes_the_right_way() {
        let base = IntensityInputs {
            bpm: Some(120.0),
            bpm_confidence: 0.8,
            onset_density: 3.0,
            mean_flux: 0.03,
            flatness: 0.15,
            integrated_lufs: Some(-16.0),
            loudness_range: Some(8.0),
            hf_db: -20.0,
        };
        let s0 = intensity(&base).0;
        let up = |f: &dyn Fn(&mut IntensityInputs)| {
            let mut i = base.clone();
            f(&mut i);
            intensity(&i).0
        };
        assert!(up(&|i| i.bpm = Some(170.0)) > s0);
        assert!(up(&|i| i.mean_flux = 0.06) > s0);
        assert!(up(&|i| i.flatness = 0.3) > s0);
        assert!(up(&|i| i.hf_db = -12.0) > s0);
        assert!(up(&|i| i.integrated_lufs = Some(-10.0)) > s0);
        assert!(up(&|i| i.onset_density = 6.0) > s0);
        assert!(up(&|i| i.loudness_range = Some(16.0)) < s0);
        assert!(up(&|i| i.bpm_confidence = 0.1) < s0);
    }
}
