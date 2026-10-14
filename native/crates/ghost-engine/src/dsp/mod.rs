//! Real-time DSP building blocks. Everything here is allocation-free after construction and is
//! safe to call from the output callback.

pub mod limiter;
pub mod overlay;

use crate::util::db_to_lin;

/// Linear ramp of a scalar (gain) towards a target over N frames. Settled values are exact, so a
/// unity ramp multiplies by exactly 1.0 (keeps the gapless null test bit-exact).
#[derive(Clone, Copy, Debug)]
pub struct Ramp {
    value: f32,
    target: f32,
    step: f32,
    remaining: u32,
}

impl Ramp {
    pub const fn new(value: f32) -> Self {
        Self { value, target: value, step: 0.0, remaining: 0 }
    }

    /// Ramp to `target` over `frames` frames (0 = jump).
    pub fn set(&mut self, target: f32, frames: u32) {
        self.target = target;
        if frames == 0 || self.value == target {
            self.value = target;
            self.remaining = 0;
            self.step = 0.0;
        } else {
            self.step = (target - self.value) / frames as f32;
            self.remaining = frames;
        }
    }

    #[inline]
    pub fn step(&mut self) -> f32 {
        if self.remaining > 0 {
            self.remaining -= 1;
            if self.remaining == 0 {
                self.value = self.target;
            } else {
                self.value += self.step;
            }
        }
        self.value
    }

    #[inline]
    pub fn value(&self) -> f32 {
        self.value
    }
    #[inline]
    pub fn target(&self) -> f32 {
        self.target
    }
    #[inline]
    pub fn is_settled(&self) -> bool {
        self.remaining == 0
    }
}

/// Ramp in the dB domain (perceptually even ducking), yielding linear gain.
#[derive(Clone, Copy, Debug)]
pub struct DbRamp {
    db: Ramp,
    lin: f32,
}

impl DbRamp {
    pub fn new(db: f32) -> Self {
        Self { db: Ramp::new(db), lin: db_to_lin(db) }
    }
    pub fn set(&mut self, db: f32, frames: u32) {
        self.db.set(db, frames);
        if self.db.is_settled() {
            self.lin = db_to_lin(db);
        }
    }
    #[inline]
    pub fn step(&mut self) -> f32 {
        if self.db.is_settled() {
            return self.lin;
        }
        let db = self.db.step();
        self.lin = db_to_lin(db);
        self.lin
    }
    pub fn target_db(&self) -> f32 {
        self.db.target()
    }
    pub fn is_settled(&self) -> bool {
        self.db.is_settled()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Curve {
    Linear,
    /// Raised cosine: zero slope at both ends (micro-fades).
    SCurve,
    /// sin/cos quarter wave: constant power when an in/out pair overlaps (crossfades).
    EqualPower,
}

/// Envelope moving from `from` to `to` over `len` frames along a curve. Idle faders yield `to`.
#[derive(Clone, Copy, Debug)]
pub struct Fader {
    from: f32,
    to: f32,
    len: u32,
    pos: u32,
    curve: Curve,
}

impl Fader {
    pub const fn fixed(value: f32) -> Self {
        Self { from: value, to: value, len: 0, pos: 0, curve: Curve::Linear }
    }

    pub fn new(from: f32, to: f32, len: u32, curve: Curve) -> Self {
        if len == 0 {
            return Self::fixed(to);
        }
        Self { from, to, len, pos: 0, curve }
    }

    /// Start a new fade from the current value.
    pub fn retarget(&mut self, to: f32, len: u32, curve: Curve) {
        *self = Self::new(self.value(), to, len, curve);
    }

    #[inline]
    pub fn value(&self) -> f32 {
        if self.pos >= self.len {
            return self.to;
        }
        let t = self.pos as f32 / self.len as f32;
        self.shape(t)
    }

    #[inline]
    fn shape(&self, t: f32) -> f32 {
        let (a, b) = (self.from, self.to);
        match self.curve {
            Curve::Linear => a + (b - a) * t,
            Curve::SCurve => a + (b - a) * (0.5 - 0.5 * (std::f32::consts::PI * t).cos()),
            Curve::EqualPower => {
                let q = std::f32::consts::FRAC_PI_2 * t;
                if b >= a {
                    a + (b - a) * q.sin()
                } else {
                    b + (a - b) * q.cos()
                }
            }
        }
    }

    /// Value for the current frame, then advance.
    #[inline]
    pub fn step(&mut self) -> f32 {
        if self.pos >= self.len {
            return self.to;
        }
        let v = self.shape(self.pos as f32 / self.len as f32);
        self.pos += 1;
        v
    }

    #[inline]
    pub fn done(&self) -> bool {
        self.pos >= self.len
    }
    pub fn target(&self) -> f32 {
        self.to
    }
}

/// osu!-style OutQuint easing.
#[inline]
pub fn out_quint(t: f32) -> f32 {
    let u = 1.0 - t.clamp(0.0, 1.0);
    1.0 - u * u * u * u * u
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ramp_reaches_target_exactly() {
        let mut r = Ramp::new(1.0);
        r.set(0.25, 100);
        let mut last = 1.0;
        for _ in 0..100 {
            let v = r.step();
            assert!(v <= last + 1e-7);
            last = v;
        }
        assert_eq!(r.value(), 0.25);
        assert!(r.is_settled());
        assert_eq!(Ramp::new(1.0).step(), 1.0);
    }

    #[test]
    fn equal_power_pair_constant_power() {
        let mut out = Fader::new(1.0, 0.0, 1000, Curve::EqualPower);
        let mut inn = Fader::new(0.0, 1.0, 1000, Curve::EqualPower);
        for _ in 0..1000 {
            let (a, b) = (out.step(), inn.step());
            assert!(((a * a + b * b) - 1.0).abs() < 1e-4);
        }
        assert!(out.done() && inn.done());
        assert_eq!(out.value(), 0.0);
        assert_eq!(inn.value(), 1.0);
    }

    #[test]
    fn scurve_is_monotonic() {
        let mut f = Fader::new(0.0, 1.0, 480, Curve::SCurve);
        let mut last = -1.0;
        for _ in 0..480 {
            let v = f.step();
            assert!(v >= last);
            last = v;
        }
        assert_eq!(f.step(), 1.0);
    }
}
