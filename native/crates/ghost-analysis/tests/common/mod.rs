//! Deterministic synthetic test signals.
#![allow(dead_code)]

use std::f32::consts::TAU;

pub const SR: u32 = 44_100;

/// xorshift32 noise in -1..1.
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self(seed.max(1))
    }
    pub fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

pub fn secs(s: f32) -> usize {
    (s * SR as f32) as usize
}

/// Kick drum: pitch-dropping sine (150 → 50 Hz) with a short noise click.
pub fn add_kick(buf: &mut [f32], t: f32, amp: f32, rng: &mut Rng) {
    let i0 = secs(t);
    let n = secs(0.3);
    let mut phase = 0.0f32;
    for i in 0..n {
        let Some(s) = buf.get_mut(i0 + i) else { break };
        let tt = i as f32 / SR as f32;
        let f = 50.0 + 100.0 * (-tt / 0.03).exp();
        phase += TAU * f / SR as f32;
        let body = (-tt / 0.09).exp() * phase.sin();
        let click = if tt < 0.004 { rng.next() * (1.0 - tt / 0.004) * 0.6 } else { 0.0 };
        *s += amp * (body + click);
    }
}

/// Closed hi-hat: high-passed noise burst.
pub fn add_hat(buf: &mut [f32], t: f32, amp: f32, rng: &mut Rng) {
    let i0 = secs(t);
    let n = secs(0.08);
    let mut prev = 0.0;
    for i in 0..n {
        let Some(s) = buf.get_mut(i0 + i) else { break };
        let tt = i as f32 / SR as f32;
        let x = rng.next();
        *s += amp * (x - prev) * 0.5 * (-tt / 0.02).exp();
        prev = x;
    }
}

/// Snare: noise plus a 180 Hz body.
pub fn add_snare(buf: &mut [f32], t: f32, amp: f32, rng: &mut Rng) {
    let i0 = secs(t);
    let n = secs(0.25);
    for i in 0..n {
        let Some(s) = buf.get_mut(i0 + i) else { break };
        let tt = i as f32 / SR as f32;
        *s += amp * (0.6 * rng.next() * (-tt / 0.07).exp() + 0.5 * (TAU * 180.0 * tt).sin() * (-tt / 0.05).exp());
    }
}

/// Sustained sine tone with 10 ms fades.
pub fn add_tone(buf: &mut [f32], t0: f32, dur: f32, freq: f32, amp: f32) {
    let i0 = secs(t0);
    let n = secs(dur);
    let fade = secs(0.01).max(1);
    for i in 0..n {
        let Some(s) = buf.get_mut(i0 + i) else { break };
        let g = (i.min(n - 1 - i) as f32 / fade as f32).min(1.0);
        *s += amp * g * (TAU * freq * i as f32 / SR as f32).sin();
    }
}

/// Beat times from `start` for `dur` seconds at `bpm`.
pub fn beat_times(bpm: f32, start: f32, dur: f32) -> Vec<f32> {
    let p = 60.0 / bpm;
    let n = ((dur - start) / p).floor() as usize;
    (0..n).map(|k| start + k as f32 * p).filter(|&t| t < dur - 0.3).collect()
}

/// Kick on every beat.
pub fn kick_track(bpm: f32, dur: f32, start: f32) -> (Vec<f32>, Vec<f32>) {
    let mut buf = vec![0.0f32; secs(dur)];
    let mut rng = Rng::new(7);
    let beats = beat_times(bpm, start, dur);
    for &t in &beats {
        add_kick(&mut buf, t, 0.7, &mut rng);
    }
    (buf, beats)
}

pub fn to_stereo(mono: &[f32]) -> Vec<f32> {
    mono.iter().flat_map(|&x| [x, x]).collect()
}

pub fn scale(buf: &mut [f32], g: f32) {
    for x in buf {
        *x *= g;
    }
}

/// For each true beat (ignoring the first/last `margin` seconds) the distance to the nearest
/// detected beat. Returns (fraction within `tol`, max error, mean signed error).
pub fn match_beats(truth: &[f32], detected: &[f32], tol: f32, margin: f32) -> (f32, f32, f32) {
    let last = truth.last().copied().unwrap_or(0.0);
    let mut hits = 0usize;
    let mut n = 0usize;
    let mut max_err = 0.0f32;
    let mut sum = 0.0f32;
    for &t in truth.iter().filter(|&&t| t >= margin && t <= last - margin) {
        n += 1;
        let d = detected.iter().map(|&b| b - t).min_by(|a, b| a.abs().total_cmp(&b.abs())).unwrap_or(f32::MAX);
        if d.abs() <= tol {
            hits += 1;
            sum += d;
        }
        max_err = max_err.max(d.abs());
    }
    (hits as f32 / n.max(1) as f32, max_err, sum / hits.max(1) as f32)
}
