//! Streaming stereo resampler (rubato windowed-sinc) with delay compensation, so a resampled
//! track has exactly `round(frames * ratio)` frames and starts on time (keeps gapless intact).

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, FixedAsync, Indexing, Resampler, SincInterpolationParameters, SincInterpolationType, WindowFunction};

const CHUNK: usize = 1024;

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
        let params = SincInterpolationParameters::new(128, WindowFunction::BlackmanHarris2)
            .oversampling_factor(256)
            .interpolation(SincInterpolationType::Cubic);
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

    #[test]
    fn length_and_alignment() {
        let from = 44_100;
        let to = 48_000;
        let mut rs = StreamResampler::new(from, to).unwrap();
        // 1 s of a 1 kHz sine.
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
        assert_eq!(out.len() / 2, to as usize);
        // Alignment: rubato reports an integer delay; the true one has a fractional part. Allow
        // up to one sample of offset, and require a clean match at the best offset.
        let mut best = (f32::MAX, 0.0f32);
        for s in -20..=20 {
            let shift = s as f32 / 20.0;
            let mut err = 0.0f32;
            for i in 2000..46_000 {
                let expect = (2.0 * std::f32::consts::PI * 1000.0 * (i as f32 + shift) / to as f32).sin() * 0.5;
                err = err.max((out[i * 2] - expect).abs());
            }
            if err < best.0 {
                best = (err, shift);
            }
        }
        assert!(best.0 < 1e-3, "max error {} at shift {}", best.0, best.1);
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
