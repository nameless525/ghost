//! osu!-style overlay filter on the music bus: a 12 dB/oct low-pass swept 20 kHz → ~500 Hz over
//! 300 ms with OutQuint easing in log-frequency, plus a -2 dB duck. Uses a TPT state-variable
//! filter (Simper/Cytomic), which stays stable and zipper-free under per-sample cutoff changes.
//! When fully open the filter is crossfaded out and bypassed, so it is bit-transparent at rest.

use super::{out_quint, Ramp};
use crate::util::db_to_lin;

const F_OPEN: f32 = 20_000.0;
const F_CLOSED: f32 = 500.0;
const SWEEP_SEC: f32 = 0.300;
const DUCK_DB: f32 = -2.0;
const WET_SEC: f32 = 0.015;
const K: f32 = std::f32::consts::SQRT_2; // 1/Q for Q = 0.7071 (Butterworth)

pub struct OverlayFilter {
    rate: f32,
    active: bool,
    bypass: bool,
    // Sweep state (log-cutoff and duck dB interpolate along the same eased curve).
    ln_from: f32,
    ln_to: f32,
    ln_cur: f32,
    duck_from: f32,
    duck_to: f32,
    duck_cur: f32,
    t: u32,
    len: u32,
    // Cached coefficients for the steady (not sweeping) state.
    a1: f32,
    a2: f32,
    a3: f32,
    duck_lin: f32,
    ic1: [f32; 2],
    ic2: [f32; 2],
    wet: Ramp,
}

impl OverlayFilter {
    pub fn new(rate: u32) -> Self {
        let mut f = Self {
            rate: rate as f32,
            active: false,
            bypass: true,
            ln_from: F_OPEN.ln(),
            ln_to: F_OPEN.ln(),
            ln_cur: F_OPEN.ln(),
            duck_from: 0.0,
            duck_to: 0.0,
            duck_cur: 0.0,
            t: 0,
            len: 0,
            a1: 0.0,
            a2: 0.0,
            a3: 0.0,
            duck_lin: 1.0,
            ic1: [0.0; 2],
            ic2: [0.0; 2],
            wet: Ramp::new(0.0),
        };
        f.update_coefs();
        f
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn set_active(&mut self, active: bool) {
        if active == self.active {
            return;
        }
        self.active = active;
        self.ln_from = self.ln_cur;
        self.ln_to = if active { F_CLOSED.ln() } else { F_OPEN.ln() };
        self.duck_from = self.duck_cur;
        self.duck_to = if active { DUCK_DB } else { 0.0 };
        self.t = 0;
        self.len = (SWEEP_SEC * self.rate) as u32;
        if active {
            if self.bypass {
                self.bypass = false;
                self.ic1 = [0.0; 2];
                self.ic2 = [0.0; 2];
            }
            self.wet.set(1.0, (WET_SEC * self.rate) as u32);
        }
    }

    #[inline]
    fn update_coefs(&mut self) {
        let f = self.ln_cur.exp().min(self.rate * 0.45);
        let g = (std::f32::consts::PI * f / self.rate).tan();
        self.a1 = 1.0 / (1.0 + g * (g + K));
        self.a2 = g * self.a1;
        self.a3 = g * self.a2;
        self.duck_lin = db_to_lin(self.duck_cur);
    }

    /// Process one stereo frame.
    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        if self.bypass {
            return (l, r);
        }
        if self.t < self.len {
            self.t += 1;
            let e = out_quint(self.t as f32 / self.len as f32);
            self.ln_cur = self.ln_from + (self.ln_to - self.ln_from) * e;
            self.duck_cur = self.duck_from + (self.duck_to - self.duck_from) * e;
            self.update_coefs();
            if self.t == self.len && !self.active {
                // Fully open again: fade the filtered path out, then bypass.
                self.wet.set(0.0, (WET_SEC * self.rate) as u32);
            }
        }
        let w = self.wet.step();
        let mut out = [l, r];
        for (c, x) in out.iter_mut().enumerate() {
            let v0 = *x;
            let v3 = v0 - self.ic2[c];
            let v1 = self.a1 * self.ic1[c] + self.a2 * v3;
            let v2 = self.ic2[c] + self.a2 * self.ic1[c] + self.a3 * v3;
            self.ic1[c] = 2.0 * v1 - self.ic1[c];
            self.ic2[c] = 2.0 * v2 - self.ic2[c];
            *x = (v0 + (v2 - v0) * w) * self.duck_lin;
        }
        if !self.active && self.t >= self.len && self.wet.is_settled() && self.wet.value() == 0.0 {
            self.bypass = true;
            self.duck_cur = 0.0;
            self.duck_lin = 1.0;
        }
        (out[0], out[1])
    }

    /// Current cutoff in Hz (diagnostics / tests).
    pub fn cutoff_hz(&self) -> f32 {
        self.ln_cur.exp()
    }
    pub fn is_bypassed(&self) -> bool {
        self.bypass
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms_of_tone(filter: &mut OverlayFilter, freq: f32, frames: usize, rate: f32) -> f32 {
        let mut acc = 0.0;
        for i in 0..frames {
            let x = (2.0 * std::f32::consts::PI * freq * i as f32 / rate).sin() * 0.5;
            let (l, _) = filter.process(x, x);
            acc += l * l;
        }
        (acc / frames as f32).sqrt()
    }

    #[test]
    fn transparent_when_idle() {
        let mut f = OverlayFilter::new(48_000);
        for i in 0..1000 {
            let x = (i as f32 * 0.01).sin();
            assert_eq!(f.process(x, -x), (x, -x));
        }
    }

    #[test]
    fn sweep_attenuates_highs_and_returns_to_bypass() {
        let rate = 48_000.0;
        let mut f = OverlayFilter::new(48_000);
        f.set_active(true);
        // Let the sweep finish.
        rms_of_tone(&mut f, 100.0, 48_000 / 2, rate);
        assert!(f.cutoff_hz() < 520.0);
        let hi = rms_of_tone(&mut f, 5_000.0, 4800, rate);
        let lo = rms_of_tone(&mut f, 100.0, 4800, rate);
        assert!(hi < 0.02, "5 kHz should be heavily attenuated, rms {hi}");
        assert!(lo > 0.25, "100 Hz should pass (with 2 dB duck), rms {lo}");
        f.set_active(false);
        rms_of_tone(&mut f, 100.0, 48_000 / 2, rate);
        assert!(f.is_bypassed());
    }

    #[test]
    fn no_zipper_jumps_during_sweep() {
        // A low tone through the sweep must stay smooth: no sample-to-sample jump much larger
        // than the tone's own slope.
        let rate = 48_000.0;
        let mut f = OverlayFilter::new(48_000);
        f.set_active(true);
        let mut prev = 0.0f32;
        let mut max_jump = 0.0f32;
        for i in 0..(rate as usize / 2) {
            let x = (2.0 * std::f32::consts::PI * 220.0 * i as f32 / rate).sin() * 0.8;
            let (l, _) = f.process(x, x);
            if i > 0 {
                max_jump = max_jump.max((l - prev).abs());
            }
            prev = l;
        }
        let slope = 2.0 * std::f32::consts::PI * 220.0 / rate * 0.8;
        assert!(max_jump < slope * 1.5, "max jump {max_jump} vs slope {slope}");
    }
}
