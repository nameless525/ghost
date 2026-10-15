//! Look-ahead "true-peak-ish" safety limiter (stereo-linked).
//!
//! Gain computer: per frame, the required gain `g = ceiling / peak`, where `peak` includes a 4x
//! oversampled (8-tap polyphase windowed-sinc) estimate of the inter-sample peaks. A sliding
//! minimum (hold) over `N + K` frames, a release envelope, and an `N`-frame moving average give a
//! smooth gain that is guaranteed to have reached `g` by the time every sample the peak estimate
//! depends on leaves the `N + K - 1`-frame delay line (`N` = look-ahead, `K` = 4 frames the
//! inter-sample estimate lags behind the input). With nothing to limit every stage is exactly
//! 1.0, so the limiter is then a pure delay (bit-transparent).

const RELEASE_SEC: f32 = 0.080;
/// Inter-sample peaks are estimated between x[t-K] and x[t-K+1] from taps x[t-7..=t].
const K: usize = 4;
const TAPS: usize = 8;
const PHASES: usize = 3;

fn isp_coefs() -> [[f32; TAPS]; PHASES] {
    let mut c = [[0.0f32; TAPS]; PHASES];
    for (p, row) in c.iter_mut().enumerate() {
        let frac = (p + 1) as f32 / 4.0;
        // Tap j covers x[t-7+j]; the interpolation point sits at index (TAPS - 1 - K) + frac.
        let center = (TAPS - 1 - K) as f32 + frac;
        let mut sum = 0.0;
        for (j, v) in row.iter_mut().enumerate() {
            let tau = j as f32 - center;
            let sinc = if tau.abs() < 1e-6 { 1.0 } else { (std::f32::consts::PI * tau).sin() / (std::f32::consts::PI * tau) };
            let w = 0.5 + 0.5 * (std::f32::consts::PI * tau / (TAPS as f32 / 2.0 + 0.5)).cos();
            *v = sinc * w;
            sum += *v;
        }
        for v in row.iter_mut() {
            *v /= sum;
        }
    }
    c
}

pub struct Limiter {
    ceiling: f32,
    /// `ceiling / 2`: below this no inter-sample peak can exceed the ceiling.
    half: f32,
    n: usize,
    coefs: [[f32; TAPS]; PHASES],
    // Gain-computer history.
    hold: Box<[f32]>,
    hold_idx: usize,
    hold_non_unity: usize,
    boxf: Box<[f32]>,
    box_idx: usize,
    box_sum: f64,
    box_non_unity: usize,
    env: f32,
    release: f32,
    /// Last TAPS input frames, written twice (`i` and `i + TAPS`) so the window oldest → newest
    /// is always the contiguous `hist[hist_idx..hist_idx + TAPS]`.
    hist: [[f32; 2]; 2 * TAPS],
    hist_idx: usize,
    /// Frames in that window with a sample above `half`.
    loud: usize,
    // Audio delay line (interleaved stereo).
    delay: Box<[f32]>,
    delay_idx: usize,
    /// Smallest gain applied since creation (diagnostics).
    pub min_gain: f32,
}

impl Limiter {
    pub fn new(rate: u32, ceiling_db: f32, lookahead_ms: f32) -> Self {
        let n = ((lookahead_ms / 1000.0) * rate as f32).round().max(4.0) as usize;
        let d = n + K - 1;
        let ceiling = crate::util::db_to_lin(ceiling_db);
        Self {
            ceiling,
            half: ceiling * 0.5,
            n,
            coefs: isp_coefs(),
            hold: vec![1.0; n + K].into_boxed_slice(),
            hold_idx: 0,
            hold_non_unity: 0,
            boxf: vec![1.0; n].into_boxed_slice(),
            box_idx: 0,
            box_sum: n as f64,
            box_non_unity: 0,
            env: 1.0,
            release: 1.0 - (-1.0 / (RELEASE_SEC * rate as f32)).exp(),
            hist: [[0.0; 2]; 2 * TAPS],
            hist_idx: 0,
            loud: 0,
            delay: vec![0.0; d * 2].into_boxed_slice(),
            delay_idx: 0,
            min_gain: 1.0,
        }
    }

    /// Processing latency in frames.
    pub fn latency(&self) -> usize {
        self.n + K - 1
    }

    pub fn ceiling(&self) -> f32 {
        self.ceiling
    }

    /// Largest 4x-oversampled inter-sample estimate over the current window (or `peak`).
    #[inline]
    fn isp_peak(&self, mut peak: f32) -> f32 {
        let win: &[[f32; 2]; TAPS] = self.hist[self.hist_idx..self.hist_idx + TAPS].try_into().unwrap();
        for row in &self.coefs {
            let (mut al, mut ar) = (0.0f32, 0.0f32);
            for (f, c) in win.iter().zip(row) {
                al += f[0] * c;
                ar += f[1] * c;
            }
            peak = peak.max(al.abs()).max(ar.abs());
        }
        peak
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let i = self.hist_idx;
        let old = self.hist[i];
        if old[0].abs() > self.half || old[1].abs() > self.half {
            self.loud -= 1;
        }
        self.hist[i] = [l, r];
        self.hist[i + TAPS] = [l, r];
        self.hist_idx = if i + 1 == TAPS { 0 } else { i + 1 };
        let mut peak = l.abs().max(r.abs());
        if l.abs() > self.half || r.abs() > self.half {
            self.loud += 1;
        }
        // Only bother with the oversampled estimate when it could matter: a loud sample in the
        // window, or a gain reduction still being held.
        if self.loud > 0 || self.hold_non_unity > 0 {
            peak = self.isp_peak(peak);
        }
        let g = if peak > self.ceiling { self.ceiling / peak } else { 1.0 };

        // Sliding minimum over the hold window.
        let old = self.hold[self.hold_idx];
        if old != 1.0 {
            self.hold_non_unity -= 1;
        }
        if g != 1.0 {
            self.hold_non_unity += 1;
        }
        self.hold[self.hold_idx] = g;
        self.hold_idx = if self.hold_idx + 1 == self.hold.len() { 0 } else { self.hold_idx + 1 };
        // (A plain scan beats a monotonic deque here: ~76 values, vectorised, branch-free.)
        let h = if self.hold_non_unity == 0 { 1.0 } else { self.hold.iter().copied().fold(1.0f32, f32::min) };

        // Instant attack, exponential release (never above the hold value).
        if h <= self.env {
            self.env = h;
        } else {
            self.env += (h - self.env) * self.release;
            if h - self.env < 1e-6 {
                self.env = h;
            }
        }

        // Moving average over N frames.
        let old = self.boxf[self.box_idx];
        if old != 1.0 {
            self.box_non_unity -= 1;
        }
        if self.env != 1.0 {
            self.box_non_unity += 1;
        }
        self.box_sum += self.env as f64 - old as f64;
        self.boxf[self.box_idx] = self.env;
        self.box_idx = if self.box_idx + 1 == self.n { 0 } else { self.box_idx + 1 };
        let gain = if self.box_non_unity == 0 {
            self.box_sum = self.n as f64;
            1.0
        } else {
            (self.box_sum / self.n as f64) as f32
        };
        if gain < self.min_gain {
            self.min_gain = gain;
        }

        // Delay line.
        let i = self.delay_idx * 2;
        let (dl, dr) = (self.delay[i], self.delay[i + 1]);
        self.delay[i] = l;
        self.delay[i + 1] = r;
        self.delay_idx = if i + 2 == self.delay.len() { 0 } else { self.delay_idx + 1 };
        (dl * gain, dr * gain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The original implementation, kept to prove the optimised one bit-exact.
    #[allow(dead_code)]
    pub(super) struct RefLimiter {
        ceiling: f32,
        n: usize,
        coefs: [[f32; TAPS]; PHASES],
        // Gain-computer history.
        hold: Box<[f32]>,
        hold_idx: usize,
        hold_non_unity: usize,
        boxf: Box<[f32]>,
        box_idx: usize,
        box_sum: f64,
        box_non_unity: usize,
        env: f32,
        release: f32,
        // Last TAPS input frames (ring) for the inter-sample-peak estimate.
        hist: [[f32; 2]; TAPS],
        hist_idx: usize,
        // Audio delay line (interleaved stereo).
        delay: Box<[f32]>,
        delay_idx: usize,
        /// Smallest gain applied since creation (diagnostics).
        pub(super) min_gain: f32,
    }
    
    #[allow(dead_code)]
    impl RefLimiter {
        pub(super) fn new(rate: u32, ceiling_db: f32, lookahead_ms: f32) -> Self {
            let n = ((lookahead_ms / 1000.0) * rate as f32).round().max(4.0) as usize;
            let d = n + K - 1;
            Self {
                ceiling: crate::util::db_to_lin(ceiling_db),
                n,
                coefs: isp_coefs(),
                hold: vec![1.0; n + K].into_boxed_slice(),
                hold_idx: 0,
                hold_non_unity: 0,
                boxf: vec![1.0; n].into_boxed_slice(),
                box_idx: 0,
                box_sum: n as f64,
                box_non_unity: 0,
                env: 1.0,
                release: 1.0 - (-1.0 / (RELEASE_SEC * rate as f32)).exp(),
                hist: [[0.0; 2]; TAPS],
                hist_idx: 0,
                delay: vec![0.0; d * 2].into_boxed_slice(),
                delay_idx: 0,
                min_gain: 1.0,
            }
        }
    
        /// Processing latency in frames.
        pub(super) fn latency(&self) -> usize {
            self.n + K - 1
        }
    
        pub(super) fn ceiling(&self) -> f32 {
            self.ceiling
        }
    
        #[inline]
        pub(super) fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
            self.hist[self.hist_idx] = [l, r];
            self.hist_idx = (self.hist_idx + 1) % TAPS;
            let mut peak = l.abs().max(r.abs());
            // Only bother with the oversampled estimate when it could matter.
            if peak > self.ceiling * 0.5 || self.hold_non_unity > 0 {
                for row in &self.coefs {
                    let (mut al, mut ar) = (0.0f32, 0.0f32);
                    for (j, c) in row.iter().enumerate() {
                        let f = self.hist[(self.hist_idx + j) % TAPS];
                        al += f[0] * c;
                        ar += f[1] * c;
                    }
                    peak = peak.max(al.abs()).max(ar.abs());
                }
            } else {
                // Cheap bound on the recent history so we don't miss a peak that was registered
                // by the full estimate on the previous samples.
                for f in &self.hist {
                    if f[0].abs() > self.ceiling * 0.5 || f[1].abs() > self.ceiling * 0.5 {
                        for row in &self.coefs {
                            let (mut al, mut ar) = (0.0f32, 0.0f32);
                            for (j, c) in row.iter().enumerate() {
                                let f = self.hist[(self.hist_idx + j) % TAPS];
                                al += f[0] * c;
                                ar += f[1] * c;
                            }
                            peak = peak.max(al.abs()).max(ar.abs());
                        }
                        break;
                    }
                }
            }
            let g = if peak > self.ceiling { self.ceiling / peak } else { 1.0 };
    
            // Sliding minimum over the hold window.
            let old = self.hold[self.hold_idx];
            if old != 1.0 {
                self.hold_non_unity -= 1;
            }
            if g != 1.0 {
                self.hold_non_unity += 1;
            }
            self.hold[self.hold_idx] = g;
            self.hold_idx = (self.hold_idx + 1) % self.hold.len();
            let h = if self.hold_non_unity == 0 { 1.0 } else { self.hold.iter().copied().fold(1.0f32, f32::min) };
    
            // Instant attack, exponential release (never above the hold value).
            if h <= self.env {
                self.env = h;
            } else {
                self.env += (h - self.env) * self.release;
                if h - self.env < 1e-6 {
                    self.env = h;
                }
            }
    
            // Moving average over N frames.
            let old = self.boxf[self.box_idx];
            if old != 1.0 {
                self.box_non_unity -= 1;
            }
            if self.env != 1.0 {
                self.box_non_unity += 1;
            }
            self.box_sum += self.env as f64 - old as f64;
            self.boxf[self.box_idx] = self.env;
            self.box_idx = (self.box_idx + 1) % self.n;
            let gain = if self.box_non_unity == 0 {
                self.box_sum = self.n as f64;
                1.0
            } else {
                (self.box_sum / self.n as f64) as f32
            };
            if gain < self.min_gain {
                self.min_gain = gain;
            }
    
            // Delay line.
            let i = self.delay_idx * 2;
            let (dl, dr) = (self.delay[i], self.delay[i + 1]);
            self.delay[i] = l;
            self.delay[i + 1] = r;
            self.delay_idx = (self.delay_idx + 1) % (self.delay.len() / 2);
            (dl * gain, dr * gain)
        }
    }

    #[test]
    fn matches_reference_bit_for_bit() {
        for &rate in &[44_100u32, 48_000, 96_000] {
            for &boost in &[0.3f32, 1.0, 2.0, 8.0] {
                let mut a = Limiter::new(rate, -1.0, 1.5);
                let mut b = RefLimiter::new(rate, -1.0, 1.5);
                let mut x = 0x9E3779B97F4A7C15u64 ^ rate as u64 ^ boost.to_bits() as u64;
                for i in 0..rate as usize * 2 {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    let noise = (x >> 40) as f32 / (1u64 << 24) as f32 - 0.5;
                    // Bursts, silence and tones so every path (idle, ISP, hold, release) runs.
                    let env = match (i / 3000) % 4 { 0 => 0.0, 1 => 0.2, 2 => 1.0, _ => 0.6 };
                    let t = i as f32 / rate as f32;
                    let l = ((2.0 * std::f32::consts::PI * 997.0 * t).sin() * 0.7 + noise * 0.3) * env * boost;
                    let r = (noise * 0.9 - (2.0 * std::f32::consts::PI * 5_003.0 * t).cos() * 0.4) * env * boost;
                    let (p, q) = (a.process(l, r), b.process(l, r));
                    assert!(p.0.to_bits() == q.0.to_bits() && p.1.to_bits() == q.1.to_bits(), "rate {rate} boost {boost} frame {i}: {p:?} vs {q:?}");
                }
                assert_eq!(a.min_gain.to_bits(), b.min_gain.to_bits());
            }
        }
    }

    /// 4x oversampled peak estimate (windowed-sinc interpolation) of a mono signal.
    fn true_peak(x: &[f32]) -> f32 {
        let mut peak = 0.0f32;
        for i in 8..x.len() - 8 {
            for k in 0..4 {
                let frac = k as f32 / 4.0;
                let mut acc = 0.0;
                for j in -7i32..=8 {
                    let t = j as f32 - frac;
                    let sinc = if t.abs() < 1e-6 { 1.0 } else { (std::f32::consts::PI * t).sin() / (std::f32::consts::PI * t) };
                    let w = 0.5 + 0.5 * (std::f32::consts::PI * t / 8.5).cos();
                    acc += x[(i as i32 + j) as usize] * sinc * w;
                }
                peak = peak.max(acc.abs());
            }
        }
        peak
    }

    #[test]
    fn transparent_below_ceiling() {
        let mut lim = Limiter::new(48_000, -1.0, 1.5);
        let d = lim.latency();
        let input: Vec<f32> = (0..10_000).map(|i| (i as f32 * 0.031).sin() * 0.8).collect();
        let mut out = Vec::new();
        for &x in &input {
            out.push(lim.process(x, -x).0);
        }
        for i in d..input.len() {
            assert_eq!(out[i], input[i - d]);
        }
    }

    #[test]
    fn ceiling_holds_on_boosted_full_scale() {
        for &rate in &[44_100u32, 48_000] {
            let mut lim = Limiter::new(rate, -1.0, 1.5);
            let ceiling = lim.ceiling();
            let boost = crate::util::db_to_lin(6.0);
            // Full-scale sine sweep + square-ish bursts, boosted by +6 dB.
            let n = rate as usize * 2;
            let mut out = Vec::with_capacity(n);
            for i in 0..n {
                let t = i as f32 / rate as f32;
                let f = 60.0 + 9_000.0 * t / 2.0;
                // Full-scale sweep plus a full-scale two-tone burst every third 4000-frame block.
                let x = (2.0 * std::f32::consts::PI * f * t).sin();
                let x = if (i / 4000) % 3 == 0 {
                    0.5 * x + 0.5 * (2.0 * std::f32::consts::PI * 7_919.0 * t).sin()
                } else {
                    x
                };
                out.push(lim.process(x * boost, x * boost).0);
            }
            let sample_peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
            assert!(sample_peak <= ceiling + 1e-6, "rate {rate}: sample peak {sample_peak} > {ceiling}");
            let tp = true_peak(&out);
            let tp_db = 20.0 * tp.log10();
            assert!(tp_db < -0.5, "rate {rate}: true peak {tp_db:.2} dBTP too high");
            eprintln!("rate {rate}: sample peak {:.2} dBFS, true peak {tp_db:.2} dBTP", 20.0 * sample_peak.log10());
            assert!(lim.min_gain < 0.5);
        }
    }
}
