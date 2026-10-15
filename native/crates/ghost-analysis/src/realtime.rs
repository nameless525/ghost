//! Real-time analysis for visuals: 96 smoothed log bands, a triggered waveform, RMS/peak and
//! a loudness-independent spectral-flux onset value.
//!
//! Everything is allocated in [`RealtimeAnalyzer::new`](crate::realtime::RealtimeAnalyzer::new);
//! `push_interleaved`, `compute` and `reset` never allocate, lock or do I/O (see
//! `tests/realtime_no_alloc.rs`).
//!
//! Spectrum: two Hann-windowed FFTs over the same mono history (multi-resolution). Bass and
//! low-mid bands (where a log band is narrower than a short-FFT bin) come from a ~85 ms FFT
//! (4096 points at 44.1/48 kHz) for frequency resolution; the upper bands come from a ~21 ms
//! FFT (1024 points) so hats and transients flicker crisply instead of being smeared.

use realfft::RealFftPlanner;

use crate::dsp::{db, log_edges, one_pole, BandMap, PowerFft};
use crate::{AnalysisFrame, NUM_BANDS, WAVEFORM_LEN};

/// Lowest / highest band edge.
pub const BAND_LO_HZ: f32 = 30.0;
pub const BAND_HI_HZ: f32 = 16_000.0;

const ATTACK_SEC: f32 = 0.015;
const RELEASE_SEC: f32 = 0.180;

/// Band level (dB re. a full-scale sine, after tilt) that maps to 0 and the span up to 1.
/// The analysis tap sits after loudness normalisation (~-16 LUFS), so this is calibrated for
/// mastered music at that level: loud kick/bass peaks reach ~0.9–1, quiet treble ~0.2–0.3.
const DB_FLOOR: f32 = -72.0;
const DB_SPAN: f32 = 62.0;
/// Gentle high-frequency tilt compensation: music falls ~3–5 dB/octave above the low mids,
/// which would leave the treble bars visually dead.
const TILT_PIVOT_HZ: f32 = 400.0;
const TILT_DB_PER_OCT: f32 = 3.0;
const TILT_MAX_DB: f32 = 15.0;
/// Slight bass trim so sub-bass doesn't pin the leftmost bars at full height.
const BASS_PIVOT_HZ: f32 = 80.0;
const BASS_DB_PER_OCT: f32 = 1.5;

const ONSET_BANDS: usize = 24;
const ONSET_LO_HZ: f32 = 40.0;
/// Running-mean time constant for onset normalisation.
const ONSET_MEAN_SEC: f32 = 1.5;
/// Floor on the running mean (mean dB rise per band per frame), so near-silence can't spike.
const ONSET_MEAN_FLOOR: f32 = 0.35;
/// Spike decay so a hit stays visible for a few frames whatever the call rate.
const ONSET_DECAY_SEC: f32 = 0.05;
/// Below this RMS the onset output is gated (dither and fade tails are not hits).
const ONSET_GATE_DB: f32 = -62.0;

/// How far back (samples) the oscilloscope trigger may look for a rising zero crossing.
const WAVE_SEARCH: usize = 1024;
const WAVE_MAX_CANDIDATES: usize = 24;

pub struct RealtimeAnalyzer {
    sample_rate: u32,
    ring: Box<[f32]>,
    mask: usize,
    /// Next write index into `ring`.
    write: usize,
    /// Samples pushed since the last `compute`.
    fresh: usize,
    long: PowerFft,
    short: PowerFft,
    /// Bands `[0, split)` come from the long FFT, `[split, NUM_BANDS)` from the short one.
    split: usize,
    long_map: BandMap,
    short_map: BandMap,
    onset_map: BandMap,
    frame: Box<[f32]>,
    band_pow: [f32; NUM_BANDS],
    band_offset_db: [f32; NUM_BANDS],
    target: [f32; NUM_BANDS],
    smooth: [f32; NUM_BANDS],
    onset_pow: [f32; ONSET_BANDS],
    onset_cur: [f32; ONSET_BANDS],
    onset_prev: [f32; ONSET_BANDS],
    have_prev: bool,
    have_spectrum: bool,
    flux_mean: f32,
    elapsed: f32,
    onset: f32,
    rms: f32,
    peak: f32,
    wave_prev: [f32; WAVEFORM_LEN],
    have_wave: bool,
    /// The newest `WAVE_SPAN` samples, oldest first (trigger search scratch).
    wave_lin: Box<[f32]>,
}

/// Samples the waveform trigger looks at: the display window plus the search range plus one.
const WAVE_SPAN: usize = WAVEFORM_LEN + WAVE_SEARCH + 1;

impl RealtimeAnalyzer {
    pub fn new(sample_rate: u32) -> Self {
        let sr = sample_rate.max(8000);
        // ~85 ms long window: 4096 at 44.1/48 kHz, 8192 at 88.2/96 kHz.
        let long_n = ((sr as f32 * 0.085) as usize).next_power_of_two().clamp(1024, 16384);
        let short_n = long_n / 4;
        let cap = (long_n + WAVEFORM_LEN + WAVE_SEARCH + 1).next_power_of_two();
        let mut planner = RealFftPlanner::<f32>::new();
        let long = PowerFft::new(&mut planner, long_n);
        let short = PowerFft::new(&mut planner, short_n);

        let nyq = sr as f32 * 0.5;
        let hi = BAND_HI_HZ.min(nyq * 0.98);
        let edges = log_edges(NUM_BANDS, BAND_LO_HZ, hi);
        // Short FFT takes over once a band is at least 1.5 of its bins wide.
        let short_bin = sr as f32 / short_n as f32;
        let split = (0..NUM_BANDS).find(|&b| edges[b + 1] - edges[b] >= 1.5 * short_bin).unwrap_or(NUM_BANDS);
        let long_map = BandMap::new(&edges[..=split], long_n, sr);
        let short_map = BandMap::new(&edges[split..], short_n, sr);

        let mut band_offset_db = [0.0f32; NUM_BANDS];
        for (b, off) in band_offset_db.iter_mut().enumerate() {
            let fc = (edges[b] * edges[b + 1]).sqrt();
            let mut t = 0.0;
            if fc > TILT_PIVOT_HZ {
                t += (TILT_DB_PER_OCT * (fc / TILT_PIVOT_HZ).log2()).min(TILT_MAX_DB);
            }
            if fc < BASS_PIVOT_HZ {
                t -= BASS_DB_PER_OCT * (BASS_PIVOT_HZ / fc).log2();
            }
            *off = t;
        }

        let onset_edges = log_edges(ONSET_BANDS, ONSET_LO_HZ, hi);
        let onset_map = BandMap::new(&onset_edges, short_n, sr);

        Self {
            sample_rate,
            ring: vec![0.0; cap].into_boxed_slice(),
            mask: cap - 1,
            write: 0,
            fresh: 0,
            long,
            short,
            split,
            long_map,
            short_map,
            onset_map,
            frame: vec![0.0; long_n].into_boxed_slice(),
            band_pow: [0.0; NUM_BANDS],
            band_offset_db,
            target: [0.0; NUM_BANDS],
            smooth: [0.0; NUM_BANDS],
            onset_pow: [0.0; ONSET_BANDS],
            onset_cur: [0.0; ONSET_BANDS],
            onset_prev: [0.0; ONSET_BANDS],
            have_prev: false,
            have_spectrum: false,
            flux_mean: ONSET_MEAN_FLOOR * 2.0,
            elapsed: 0.0,
            onset: 0.0,
            rms: 0.0,
            peak: 0.0,
            wave_prev: [0.0; WAVEFORM_LEN],
            have_wave: false,
            wave_lin: vec![0.0; WAVE_SPAN].into_boxed_slice(),
        }
    }

    /// Sample rate this analyzer was created for.
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Push interleaved samples (any channel count; mixed to mono internally).
    pub fn push_interleaved(&mut self, samples: &[f32], channels: usize) {
        if channels == 0 {
            return;
        }
        let inv = 1.0 / channels as f32;
        let mut w = self.write;
        let mask = self.mask;
        if channels == 1 {
            for &s in samples {
                self.ring[w] = if s.is_finite() { s } else { 0.0 };
                w = (w + 1) & mask;
            }
        } else {
            for fr in samples.chunks_exact(channels) {
                let m = fr.iter().sum::<f32>() * inv;
                self.ring[w] = if m.is_finite() { m } else { 0.0 };
                w = (w + 1) & mask;
            }
        }
        self.write = w;
        self.fresh = self.fresh.saturating_add(samples.len() / channels);
    }

    /// Compute the latest frame from the most recent samples. `dt_sec` is the time since the
    /// previous call, used for attack/release smoothing.
    pub fn compute(&mut self, dt_sec: f32, out: &mut AnalysisFrame) {
        let dt = if dt_sec.is_finite() { dt_sec.clamp(0.0, 0.5) } else { 0.0 };
        let fresh = self.fresh;
        self.fresh = 0;
        self.elapsed += dt;

        if fresh > 0 || !self.have_spectrum {
            self.analyse_spectrum(fresh, dt);
            self.have_spectrum = true;
        } else {
            // Nothing new arrived since the last call: hold the spectrum, let the onset decay.
            self.onset *= (-dt / ONSET_DECAY_SEC).exp();
        }

        // Fast attack, slow release.
        let a_att = one_pole(dt, ATTACK_SEC);
        let a_rel = one_pole(dt, RELEASE_SEC);
        for ((s, &t), o) in self.smooth.iter_mut().zip(&self.target).zip(out.bands.iter_mut()) {
            let a = if t > *s { a_att } else { a_rel };
            *s += (t - *s) * a;
            *o = *s;
        }

        self.write_waveform(&mut out.waveform);
        out.rms = self.rms;
        out.peak = self.peak;
        out.onset = self.onset;
    }

    /// Clear history (on seek / track change) so smoothing doesn't smear across tracks.
    pub fn reset(&mut self) {
        self.ring.fill(0.0);
        self.write = 0;
        self.fresh = 0;
        self.target = [0.0; NUM_BANDS];
        self.smooth = [0.0; NUM_BANDS];
        self.onset_prev = [0.0; ONSET_BANDS];
        self.have_prev = false;
        self.have_spectrum = false;
        self.flux_mean = ONSET_MEAN_FLOOR * 2.0;
        self.elapsed = 0.0;
        self.onset = 0.0;
        self.rms = 0.0;
        self.peak = 0.0;
        self.wave_prev = [0.0; WAVEFORM_LEN];
        self.have_wave = false;
    }

    /// Copy the most recent `dst.len()` samples (oldest first) out of the ring.
    fn copy_recent(ring: &[f32], write: usize, mask: usize, dst: &mut [f32]) {
        let n = dst.len();
        let start = write.wrapping_sub(n) & mask;
        let first = (ring.len() - start).min(n);
        dst[..first].copy_from_slice(&ring[start..start + first]);
        if first < n {
            dst[first..].copy_from_slice(&ring[..n - first]);
        }
    }

    fn analyse_spectrum(&mut self, fresh: usize, dt: f32) {
        let long_n = self.long.len();
        let short_n = self.short.len();
        Self::copy_recent(&self.ring, self.write, self.mask, &mut self.frame);

        // Level over the newest samples (at least one short window).
        let win = fresh.clamp(short_n, long_n);
        let mut sum_sq = 0.0f32;
        let mut peak = 0.0f32;
        for &x in &self.frame[long_n - win..] {
            sum_sq += x * x;
            peak = peak.max(x.abs());
        }
        self.rms = (sum_sq / win as f32).sqrt();
        self.peak = peak;

        // Long FFT → low bands, short FFT → high bands + onset bands.
        self.long.process(&self.frame);
        let split = self.split;
        self.long_map.apply(&self.long.power, &mut self.band_pow[..split]);
        self.short.process(&self.frame[long_n - short_n..]);
        self.short_map.apply(&self.short.power, &mut self.band_pow[split..]);

        for b in 0..NUM_BANDS {
            let level = db(self.band_pow[b], 1e-12) + self.band_offset_db[b];
            self.target[b] = ((level - DB_FLOOR) / DB_SPAN).clamp(0.0, 1.0);
        }

        // Spectral flux: half-wave rectified log-magnitude rise against a ±1-band maximum of the
        // previous frame (suppresses vibrato), averaged over bands.
        self.onset_map.apply(&self.short.power, &mut self.onset_pow);
        for (c, &p) in self.onset_cur.iter_mut().zip(&self.onset_pow) {
            *c = db(p, 1e-10);
        }
        let mut raw = 0.0f32;
        if self.have_prev && fresh > 0 {
            let mut flux = 0.0f32;
            for b in 0..ONSET_BANDS {
                let lo = b.saturating_sub(1);
                let hi = (b + 1).min(ONSET_BANDS - 1);
                let mut r = self.onset_prev[lo];
                for k in lo + 1..=hi {
                    r = r.max(self.onset_prev[k]);
                }
                flux += (self.onset_cur[b] - r).max(0.0);
            }
            flux /= ONSET_BANDS as f32;

            // Normalise against an adaptive running mean (measured before this frame so a hit
            // doesn't dilute itself): ~1 at four times the recent average rise.
            let mean = self.flux_mean.max(ONSET_MEAN_FLOOR);
            raw = ((flux / mean - 1.3) / 2.7).clamp(0.0, 1.0);
            let tau = ONSET_MEAN_SEC.min(self.elapsed.max(0.1));
            let a = one_pole(dt.max(1.0 / 240.0), tau);
            self.flux_mean += (flux.min(mean * 8.0) - self.flux_mean) * a;
            if db(self.rms * self.rms, 1e-12) < ONSET_GATE_DB {
                raw = 0.0;
            }
        }
        self.onset_prev = self.onset_cur;
        self.have_prev = true;
        self.onset = raw.max(self.onset * (-dt / ONSET_DECAY_SEC).exp());
    }

    /// Fill `out` with the last WAVEFORM_LEN samples, starting at a rising zero crossing so an
    /// oscilloscope drawing is stable. Among recent crossings, prefer the one that best matches
    /// the previously displayed frame (keeps complex waveforms from hopping between triggers).
    fn write_waveform(&mut self, out: &mut [f32; WAVEFORM_LEN]) {
        // `back` = how many samples before the write index a window starts; the sample `back`
        // before the write index is `lin[WAVE_SPAN - back]`.
        let lin = &mut self.wave_lin;
        Self::copy_recent(&self.ring, self.write, self.mask, lin);
        let lin = &*lin;
        let at = |back: usize| lin[WAVE_SPAN - back];
        // Candidates: the newest WAVE_MAX_CANDIDATES rising zero crossings, newest first. Flag
        // every crossing with one vectorisable compare over the search range (`flag[i]` is the
        // crossing `d = WAVE_SEARCH - 1 - i` samples further back), then walk the flags from
        // the newest end eight at a time.
        let base = WAVE_SPAN - WAVEFORM_LEN; // `lin` index of the sample `WAVEFORM_LEN` back
        let x1s = &lin[base + 1 - WAVE_SEARCH..=base];
        let x0s = &lin[base - WAVE_SEARCH..base];
        let mut flag = [0u8; WAVE_SEARCH];
        for ((f, &x0), &x1) in flag.iter_mut().zip(x0s).zip(x1s) {
            *f = ((x0 < 0.0) & (x1 >= 0.0)) as u8;
        }
        let mut cand = [0usize; WAVE_MAX_CANDIDATES];
        let mut found = 0usize;
        let (words, _) = flag.as_chunks::<8>();
        'scan: for (wi, chunk) in words.iter().enumerate().rev() {
            let mut word = u64::from_le_bytes(*chunk);
            while word != 0 {
                let byte = (63 - word.leading_zeros() as usize) / 8;
                cand[found] = WAVE_SEARCH - 1 - (wi * 8 + byte);
                found += 1;
                if found == WAVE_MAX_CANDIDATES {
                    break 'scan;
                }
                word &= !(0xFFu64 << (byte * 8));
            }
        }
        // Scores in candidate order. Correlations run four candidates at a time, and the
        // previous frame's energy is accumulated alongside the first group; every sum keeps the
        // order of a plain one-at-a-time loop, so results are identical to it.
        let mut score = [0.0f32; WAVE_MAX_CANDIDATES];
        let mut correlate = self.have_wave;
        if correlate {
            let prev = &self.wave_prev;
            let win = |d: usize| -> &[f32; WAVEFORM_LEN] { lin[WAVE_SPAN - WAVEFORM_LEN - d..][..WAVEFORM_LEN].try_into().unwrap() };
            let mut prev_energy = -0.0f32;
            let mut k = 0;
            loop {
                let g = (found - k).min(4);
                let w: [&[f32; WAVEFORM_LEN]; 4] =
                    std::array::from_fn(|q| win(cand[(k + q.min(g.max(1) - 1)).min(WAVE_MAX_CANDIDATES - 1)]));
                let mut dot = [0.0f32; 4];
                let mut e = [0.0f32; 4];
                let first = k == 0;
                let mut i = 0;
                while i < WAVEFORM_LEN {
                    let p = prev[i];
                    if first {
                        prev_energy += p * p;
                        prev_energy += prev[i + 1] * prev[i + 1];
                    }
                    for q in 0..4 {
                        let x = w[q][i];
                        dot[q] += x * p;
                        e[q] += x * x;
                    }
                    i += 2;
                }
                let enough = prev_energy > 1e-9; // false for NaN too
                if first && !enough {
                    correlate = false;
                    break;
                }
                for q in 0..g {
                    let recency = -0.15 * cand[k + q] as f32 / WAVE_SEARCH as f32;
                    score[k + q] = dot[q] / ((e[q] * prev_energy * 0.5).sqrt() + 1e-9) + recency;
                }
                k += g;
                if k >= found {
                    break;
                }
            }
        }
        if !correlate {
            for (s, &d) in score.iter_mut().zip(&cand[..found]) {
                let back = WAVEFORM_LEN + d;
                let recency = -0.15 * d as f32 / WAVE_SEARCH as f32;
                *s = (at(back) - at(back + 1)) + recency;
            }
        }
        let mut best_back = WAVEFORM_LEN;
        let mut best_score = f32::NEG_INFINITY;
        for (&s, &d) in score.iter().zip(&cand[..found]) {
            if s > best_score {
                best_score = s;
                best_back = WAVEFORM_LEN + d;
            }
        }
        out.copy_from_slice(&lin[WAVE_SPAN - best_back..][..WAVEFORM_LEN]);
        self.wave_prev = *out;
        self.have_wave = true;
    }
}
