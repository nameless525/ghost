//! Streaming stereo resampler (rubato windowed-sinc) with delay compensation, so a resampled
//! track has exactly `round(frames * ratio)` frames and starts on time (keeps gapless intact).

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, FixedAsync, Indexing, Resampler, SincInterpolationParameters, SincInterpolationType, WindowFunction};

const CHUNK: usize = 1024;
/** Largest exact phase table (sinc points per input sample) before falling back to cubic. */
const MAX_EXACT_PHASES: u32 = 1024;

const fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Windowed-sinc parameters for a fixed ratio. Output sample k sits at input position
/// k·from/to, whose fractional part is always a multiple of 1/(to/gcd): with that many table
/// points per input sample, every position is exactly a table entry. Nearest lookup is then
/// exact polyphase resampling: one dot product per channel instead of cubic's blend of four
/// (2 instead of 6 for stereo), and no interpolation error. 44.1 → 48 kHz needs 160 points, 32 →
/// 48 kHz 3, 48 → 44.1 kHz 147. Rates without a small common factor keep cubic interpolation.
fn sinc_params(from_rate: u32, to_rate: u32) -> SincInterpolationParameters {
    let base = SincInterpolationParameters::new(128, WindowFunction::BlackmanHarris2);
    let phases = to_rate / gcd(from_rate, to_rate).max(1);
    if phases <= MAX_EXACT_PHASES {
        base.oversampling_factor(phases as usize).interpolation(SincInterpolationType::Nearest)
    } else {
        base.oversampling_factor(256).interpolation(SincInterpolationType::Cubic)
    }
}

pub struct StreamResampler {
    inner: Async<f32>,
    ratio: f64,
    in_buf: Vec<f32>,
    in_fill: usize,
    out_buf: Vec<f32>,
    delay_left: usize,
    total_in: u64,
    total_out: u64,
}

impl StreamResampler {
    pub fn new(from_rate: u32, to_rate: u32) -> Result<Self, String> {
        let ratio = to_rate as f64 / from_rate as f64;
        let params = sinc_params(from_rate, to_rate);
        let inner = Async::<f32>::new_sinc(ratio, 1.0, &params, CHUNK, 2, FixedAsync::Input).map_err(|e| e.to_string())?;
        let out_max = inner.output_frames_max();
        let delay = inner.output_delay();
        Ok(Self {
            inner,
            ratio,
            in_buf: vec![0.0; CHUNK * 2],
            in_fill: 0,
            out_buf: vec![0.0; out_max * 2],
            delay_left: delay,
            total_in: 0,
            total_out: 0,
        })
    }

    fn run_chunk(&mut self, valid: usize, out: &mut Vec<f32>) -> Result<(), String> {
        let input = InterleavedSlice::new(&self.in_buf[..], 2, CHUNK).map_err(|e| e.to_string())?;
        let frames_out = self.out_buf.len() / 2;
        let mut output = InterleavedSlice::new_mut(&mut self.out_buf[..], 2, frames_out).map_err(|e| e.to_string())?;
        let indexing = if valid < CHUNK { Some(Indexing::new().partial_len(valid)) } else { None };
        let (_, produced) = self.inner.process_into_buffer(&input, &mut output, indexing.as_ref()).map_err(|e| e.to_string())?;
        let skip = self.delay_left.min(produced);
        self.delay_left -= skip;
        out.extend_from_slice(&self.out_buf[skip * 2..produced * 2]);
        self.total_out += (produced - skip) as u64;
        Ok(())
    }

    /// Feed interleaved stereo frames; resampled frames are appended to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) -> Result<(), String> {
        let mut i = 0;
        while i < input.len() {
            let n = (CHUNK * 2 - self.in_fill).min(input.len() - i);
            self.in_buf[self.in_fill..self.in_fill + n].copy_from_slice(&input[i..i + n]);
            self.in_fill += n;
            i += n;
            if self.in_fill == CHUNK * 2 {
                self.run_chunk(CHUNK, out)?;
                self.in_fill = 0;
            }
        }
        self.total_in += (input.len() / 2) as u64;
        Ok(())
    }

    /// Flush the tail at end of stream so the output length matches the input duration.
    pub fn finish(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
        let expected = (self.total_in as f64 * self.ratio).round() as u64;
        let start_len = out.len();
        let mut guard = 0;
        while self.total_out < expected && guard < 64 {
            let valid = self.in_fill / 2;
            for s in &mut self.in_buf[self.in_fill..] {
                *s = 0.0;
            }
            self.run_chunk(valid, out)?;
            self.in_fill = 0;
            guard += 1;
        }
        if self.total_out > expected {
            let extra = (self.total_out - expected) as usize;
            let keep = out.len().saturating_sub(extra * 2).max(start_len);
            out.truncate(keep);
            self.total_out = expected;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1 s of a 1 kHz sine through `from → to`: exact length, and aligned within a sample.
    fn check(from: u32, to: u32) {
        let mut rs = StreamResampler::new(from, to).unwrap();
        let n = from as usize;
        let input: Vec<f32> =
            (0..n).flat_map(|i| {
                let v = (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / from as f32).sin() * 0.5;
                [v, v]
            }).collect();
        let mut out = Vec::new();
        for c in input.chunks(2 * 777) {
            rs.push(c, &mut out).unwrap();
        }
        rs.finish(&mut out).unwrap();
        assert_eq!(out.len() / 2, to as usize, "{from} -> {to}");
        // Alignment: rubato reports an integer delay; the true one has a fractional part (and with
        // nearest lookup, up to one more sample at some ratios: ≤ 42 µs, inaudible and the same
        // for every track at that ratio). Allow 2.5 samples of offset; the match must be clean.
        let err_at = |shift: f32| {
            let mut err = 0.0f32;
            for i in 2000..(to as usize - 2000) {
                let expect = (2.0 * std::f32::consts::PI * 1000.0 * (i as f32 + shift) / to as f32).sin() * 0.5;
                err = err.max((out[i * 2] - expect).abs());
            }
            err
        };
        // coarse (1/20 sample), then fine (1/200) around the best
        let mut best = (f32::MAX, 0.0f32);
        for s in -50..=50 {
            let e = err_at(s as f32 / 20.0);
            if e < best.0 {
                best = (e, s as f32 / 20.0);
            }
        }
        let centre = best.1;
        for s in -10..=10 {
            let shift = centre + s as f32 / 200.0;
            let e = err_at(shift);
            if e < best.0 {
                best = (e, shift);
            }
        }
        assert!(best.0 < 1e-3, "{from} -> {to}: max error {} at shift {}", best.0, best.1);
    }

    #[test]
    fn length_and_alignment() {
        // exact polyphase at the common source rates, then a ratio that keeps cubic
        for (from, to) in [(44_100, 48_000), (32_000, 48_000), (48_000, 44_100), (22_050, 48_000), (16_000, 48_000), (96_000, 48_000), (11_025, 44_100), (44_100, 47_999)] {
            check(from, to);
        }
        assert_eq!(sinc_params(44_100, 47_999).interpolation, SincInterpolationType::Cubic);
        assert_eq!(sinc_params(44_100, 48_000).oversampling_factor, 160);
    }
}


#[cfg(test)]
mod perf {
    use super::*;

    /// `cargo test --release -p ghost-engine --lib resampler_cost -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn resampler_cost() {
        for (from, to) in [(44_100u32, 48_000u32), (32_000, 48_000), (48_000, 44_100), (96_000, 48_000)] {
            let n = from as usize * 20;
            let input: Vec<f32> = (0..n).flat_map(|i| {
                let v = (i as f32 * 0.0123).sin() * 0.5;
                [v, -v]
            }).collect();
            let mut rs = StreamResampler::new(from, to).unwrap();
            let mut out = Vec::with_capacity(n * 3);
            let t = std::time::Instant::now();
            for c in input.chunks(2048) {
                rs.push(c, &mut out).unwrap();
            }
            let dt = t.elapsed();
            println!("{from} -> {to}: {:.2} ms CPU per second of audio ({:.0}x realtime)", dt.as_secs_f64() * 1000.0 / 20.0, 20.0 / dt.as_secs_f64());
        }
    }
}

