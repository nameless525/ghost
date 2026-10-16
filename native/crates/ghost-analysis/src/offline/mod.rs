//! Offline whole-track analysis: EBU R128 loudness, tempo + beat grid, kiai sections, energy
//! curve and intensity stars.
//!
//! Pipeline (`analyze`, or incrementally [`OfflineAnalyzer`](crate::offline::OfflineAnalyzer)
//! while a track is decoded; `analyze` is that analyzer fed one chunk), with the two halves
//! running in parallel on rayon:
//! - loudness: one fused BS.1770 K-weighted pass per channel pair gives integrated loudness and
//!   LRA (bit-identical to `ebur128`) plus the 100 ms momentary / short-term series; true peak
//!   (ebur128's interpolator) runs in parallel time chunks (see `loudness.rs`);
//! - spectral: mono downmix (per chunk) → 46 ms Hann STFT at an ~11.6 ms hop → 40 log bands →
//!   log-compressed spectral flux (onset envelope) → tempo (autocorrelation, log-Gaussian
//!   prior, octave check) → Ellis DP beat tracker → downbeat phase → onset picking.
//!
//! Then the energy curve (momentary loudness), intensity (see `intensity.rs`) and kiai
//! (short-term loudness + onset density with hysteresis; only for tracks ≥ 2.5★) are derived
//! from both.
//!
//! Threads: offline analysis is background work. Called from outside any rayon pool, it runs on
//! this crate's own pool of low-priority workers (`ghost-offline-N`: QoS utility on macOS, nice
//! 10 on Linux, below-normal on Windows), so it only uses otherwise idle CPU and never competes
//! with playback, decoding or the UI. (On the global rayon pool it ran at default priority
//! whatever the caller's priority: worker threads don't inherit it.) Called from inside a rayon
//! pool, e.g. under `ThreadPool::install`, it uses that pool instead, so a host can choose its
//! own threads.

use std::sync::{Arc, Mutex};

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

/// Lower the calling thread's scheduling priority (background-work class).
fn lower_thread_priority() {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
        }
        const QOS_CLASS_UTILITY: u32 = 0x11;
        // SAFETY: plain libSystem call on the current thread.
        unsafe {
            pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0);
        }
    }
    #[cfg(target_os = "linux")]
    {
        extern "C" {
            fn setpriority(which: i32, who: u32, prio: i32) -> i32;
        }
        // Linux nice values are per thread; who = 0 is the calling thread.
        // SAFETY: plain libc call on the current thread.
        unsafe {
            setpriority(0, 0, 10);
        }
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentThread() -> isize;
            fn SetThreadPriority(thread: isize, priority: i32) -> i32;
        }
        const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
        // SAFETY: plain kernel32 calls on the current thread's pseudo-handle.
        unsafe {
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
        }
    }
}

/// Worker cap for the crate's own pool.
const MAX_WORKERS: usize = 4;

/// Run `f` on the caller's rayon pool if there is one, otherwise on this crate's low-priority
/// pool (see the module docs).
fn background<R: Send>(f: impl FnOnce() -> R + Send) -> R {
    if rayon::current_thread_index().is_some() {
        return f();
    }
    match own_pool() {
        Some(p) => p.install(f),
        None => f(),
    }
}

/// The crate's low-priority pool (`None` if its threads could not be started).
fn own_pool() -> Option<&'static rayon::ThreadPool> {
    static POOL: std::sync::OnceLock<Option<rayon::ThreadPool>> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        // A few workers are enough: a stereo track's critical path is one K-weighting pass, and
        // true peak + spectral features finish alongside it on three more threads. More workers
        // only add stealing and wake-ups. `RAYON_NUM_THREADS` still overrides.
        let threads = std::env::var("RAYON_NUM_THREADS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|&n| n > 0)
            .unwrap_or_else(|| std::thread::available_parallelism().map_or(4, |n| n.get().min(MAX_WORKERS)));
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|i| format!("ghost-offline-{i}"))
            .start_handler(|_| lower_thread_priority())
            .build()
            .ok()
    })
    .as_ref()
}

/// Lowest sample rate analysed (see [`OfflineAnalyzer`]); loudness functions return `None` below it.
pub const MIN_SAMPLE_RATE: u32 = loudness::MIN_RATE;

/// Analyse a whole decoded track. `samples` are interleaved f32 at `sample_rate`.
pub fn analyze(samples: &[f32], channels: usize, sample_rate: u32) -> OfflineAnalysis {
    analyze_detailed(samples, channels, sample_rate).0
}

/// Loudness only (fast path for normalisation before the full analysis is done).
///
/// Returns `(integrated LUFS, true peak dBTP)`: the gain to apply and the headroom it leaves.
/// Both are `None` for silence, input too short to measure (< 400 ms) or sampled below
/// [`MIN_SAMPLE_RATE`].
pub fn loudness(samples: &[f32], channels: usize, sample_rate: u32) -> (Option<f32>, Option<f32>) {
    let l = background(|| loudness::measure(samples, channels, sample_rate, false, false));
    (l.integrated, l.true_peak_db)
}

/// Integrated loudness, loudness range and true peak.
pub fn loudness_full(samples: &[f32], channels: usize, sample_rate: u32) -> Loudness {
    let l = background(|| loudness::measure(samples, channels, sample_rate, false, true));
    Loudness { integrated_lufs: l.integrated, loudness_range: l.lra, true_peak_db: l.true_peak_db }
}

/// [`analyze`] plus the intermediate features.
pub fn analyze_detailed(samples: &[f32], channels: usize, sample_rate: u32) -> (OfflineAnalysis, AnalysisDetails) {
    background(|| analyze_inner(samples, channels, sample_rate))
}

fn analyze_inner(samples: &[f32], channels: usize, sample_rate: u32) -> (OfflineAnalysis, AnalysisDetails) {
    // The whole buffer is one chunk: it is analysed in place (no copy), stages in parallel.
    let mut a = OfflineAnalyzer::new(channels, sample_rate);
    a.push(samples);
    a.finish_detailed()
}

/// Streaming offline analysis: feed the decoded track as it is decoded, in any chunk sizes, then
/// [`finish`](Self::finish). The result is bit-identical to [`analyze`] over the concatenated
/// samples (the batch functions are this analyzer fed one chunk), but only the per-frame
/// features are kept (≈ 1 MB per minute of audio) instead of the whole track.
///
/// Every few seconds of pushed audio are analysed (loudness, true peak and the spectral frames in
/// parallel) on the crate's low-priority pool *while the caller keeps decoding*: `push` only
/// copies, and waits only if the previous batch is still being analysed (one batch in flight).
/// [`integrated_lufs`](Self::integrated_lufs) is ready right after the last push; `finish` does
/// the whole-track work (tempo, beats, sections). Called from inside a rayon pool, everything
/// runs synchronously on that pool instead. A large push (e.g. a whole decoded track) is
/// analysed in place without copying. Dropping the analyzer abandons the analysis (a batch in
/// flight still completes in the background).
///
/// Audio below [`MIN_SAMPLE_RATE`] (4 kHz, where the loudness filter is undefined) is not
/// analysed: the result has its duration, a flat zero energy curve and nothing else.
///
/// ```
/// use ghost_analysis::offline::{analyze, OfflineAnalyzer};
/// let track: Vec<f32> = (0..96_000).map(|i| (i as f32 * 0.01).sin() * 0.3).collect();
/// let mut a = OfflineAnalyzer::new(2, 48_000);
/// for chunk in track.chunks(4096) {
///     a.push(chunk);
/// }
/// assert_eq!(format!("{:?}", a.finish()), format!("{:?}", analyze(&track, 2, 48_000)));
/// ```
pub struct OfflineAnalyzer {
    channels: usize,
    rate: u32,
    /// Whole frames received.
    frames: u64,
    /// Samples of a frame split across pushes.
    partial: Vec<f32>,
    /// Whole frames received but not analysed yet.
    pending: Vec<f32>,
    /// The batch being analysed in the background: hands its buffer back when done (or the
    /// panic it raised).
    inflight: Option<std::sync::mpsc::Receiver<std::thread::Result<Vec<f32>>>>,
    /// A finished batch's buffer, reused for the next one.
    spare: Vec<f32>,
    /// Analyse once this many samples are pending.
    batch: usize,
    /// `None` when the input cannot be analysed (no channels, or below [`MIN_SAMPLE_RATE`]).
    /// Shared with the background batch; batches are analysed strictly in order, one at a time.
    streams: Option<Arc<Mutex<Streams>>>,
}

struct Streams {
    loud: loudness::LoudnessStream,
    feat: features::FeatureStream,
}

impl OfflineAnalyzer {
    /// Seconds of audio collected before a push analyses them.
    const BATCH_SECS: usize = 4;

    /// `channels`: interleaved channel count of every pushed chunk; `sample_rate` in Hz.
    pub fn new(channels: usize, sample_rate: u32) -> Self {
        let streams = (channels > 0 && sample_rate >= MIN_SAMPLE_RATE).then(|| {
            Arc::new(Mutex::new(Streams {
                loud: loudness::LoudnessStream::new(channels, sample_rate, true, true),
                feat: features::FeatureStream::new(channels, sample_rate),
            }))
        });
        let batch = (sample_rate as usize * Self::BATCH_SECS).max(4096) * channels;
        Self {
            channels,
            rate: sample_rate,
            frames: 0,
            partial: Vec::new(),
            pending: Vec::new(),
            inflight: None,
            spare: Vec::new(),
            batch,
            streams,
        }
    }

    /// Append interleaved samples. Any length: a frame may be split across pushes. Returns
    /// immediately unless a batch is due while the previous one is still being analysed.
    pub fn push(&mut self, interleaved: &[f32]) {
        let ch = self.channels;
        if ch == 0 || interleaved.is_empty() {
            return;
        }
        let mut x = interleaved;
        if !self.partial.is_empty() {
            let take = (ch - self.partial.len()).min(x.len());
            self.partial.extend_from_slice(&x[..take]);
            x = &x[take..];
            if self.partial.len() < ch {
                return;
            }
            let frame = std::mem::take(&mut self.partial);
            self.queue(&frame);
            self.partial = frame;
            self.partial.clear();
        }
        let whole = x.len() - x.len() % ch;
        self.queue(&x[..whole]);
        self.partial.extend_from_slice(&x[whole..]);
    }

    /// Integrated loudness (LUFS) of the audio *analysed* so far, if measurable: a provisional
    /// value for a track still being decoded. Cheap (it may wait for the batch being analysed),
    /// but it trails the pushes by up to a few seconds since pushes are analysed in batches.
    pub fn loudness_so_far(&self) -> Option<f32> {
        self.streams.as_ref().and_then(|s| lock(s).loud.integrated_so_far())
    }

    /// Integrated loudness (LUFS) of everything pushed so far. After the last push this is
    /// exactly [`OfflineAnalysis::integrated_lufs`] as `finish` (and [`analyze`]) will report it,
    /// available before the tempo / section work of `finish`: it only analyses the frames still
    /// buffered (at most a few seconds) and sums the last gating blocks. Pushing may continue
    /// afterwards; the final result is unaffected.
    pub fn integrated_lufs(&mut self) -> Option<f32> {
        self.flush();
        self.loudness_so_far()
    }

    /// Whole frames received so far.
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Analyse the rest and return the result; an incomplete trailing frame is ignored.
    pub fn finish(self) -> OfflineAnalysis {
        self.finish_detailed().0
    }

    /// [`finish`](Self::finish) plus the intermediate features (see [`analyze_detailed`]).
    pub fn finish_detailed(mut self) -> (OfflineAnalysis, AnalysisDetails) {
        self.flush();
        let (frames, sample_rate) = (self.frames as usize, self.rate);
        let duration_ms = if sample_rate > 0 { frames as u64 * 1000 / sample_rate as u64 } else { 0 };
        let out = OfflineAnalysis { duration_ms, energy: vec![0.0; ENERGY_POINTS], ..Default::default() };
        match self.streams.take() {
            Some(streams) if frames > 0 => {
                // No batch is in flight any more, so this is the only reference.
                let streams = Arc::try_unwrap(streams).ok().expect("no batch in flight").into_inner().unwrap_or_else(|p| p.into_inner());
                background(|| finish_analysis(streams, frames, sample_rate, out))
            }
            _ => (out, AnalysisDetails::default()),
        }
    }

    /// Analyse everything pushed so far (whole frames) and wait for it.
    fn flush(&mut self) {
        self.wait();
        if !self.pending.is_empty() {
            let p = std::mem::take(&mut self.pending);
            self.analyse(&p);
            self.pending = p;
            self.pending.clear();
        }
    }

    /// Wait for the batch in flight, reusing its buffer; re-raise its panic, if any.
    fn wait(&mut self) {
        if let Some(rx) = self.inflight.take() {
            match rx.recv() {
                Ok(Ok(buf)) => self.spare = buf,
                Ok(Err(panic)) => std::panic::resume_unwind(panic),
                Err(_) => {}
            }
        }
    }

    /// Whole frames.
    fn queue(&mut self, frames: &[f32]) {
        self.frames += (frames.len() / self.channels) as u64;
        if self.streams.is_none() || frames.is_empty() {
            return;
        }
        let batch = self.batch;
        if !self.pending.is_empty() && self.pending.len() + frames.len() >= batch {
            self.dispatch();
        }
        if self.pending.is_empty() && frames.len() >= batch {
            // Large chunk (e.g. a whole track): analyse it in place.
            self.wait();
            self.analyse(frames);
        } else {
            self.pending.extend_from_slice(frames);
            if self.pending.len() >= batch {
                self.dispatch();
            }
        }
    }

    /// Hand the pending batch to the low-priority pool and return (after the previous batch, if
    /// still running, has finished). Synchronous when already on a rayon pool.
    fn dispatch(&mut self) {
        self.wait();
        let Some(streams) = self.streams.clone() else { return };
        let pool = match own_pool() {
            Some(p) if rayon::current_thread_index().is_none() => p,
            _ => {
                let p = std::mem::take(&mut self.pending);
                self.analyse(&p);
                self.pending = p;
                self.pending.clear();
                return;
            }
        };
        let batch = std::mem::replace(&mut self.pending, std::mem::take(&mut self.spare));
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        pool.spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut s = lock(&streams);
                let Streams { loud, feat } = &mut *s;
                rayon::join(|| loud.push(&batch), || feat.push(&batch));
            }));
            drop(streams);
            let _ = tx.send(r.map(|()| {
                let mut b = batch;
                b.clear();
                b
            }));
        });
        self.inflight = Some(rx);
    }

    /// Analyse whole frames now, on the calling thread's pool or the crate's.
    fn analyse(&mut self, frames: &[f32]) {
        if let Some(s) = &self.streams {
            let mut s = lock(s);
            let Streams { loud, feat } = &mut *s;
            background(|| {
                rayon::join(|| loud.push(frames), || feat.push(frames));
            });
        }
    }
}

fn lock(s: &Mutex<Streams>) -> std::sync::MutexGuard<'_, Streams> {
    s.lock().unwrap_or_else(|p| p.into_inner())
}

fn finish_analysis(streams: Streams, frames: usize, sample_rate: u32, mut out: OfflineAnalysis) -> (OfflineAnalysis, AnalysisDetails) {
    let duration = frames as f32 / sample_rate as f32;
    let Streams { loud, feat } = streams;
    let (loud, spectral) = rayon::join(
        || loud.finish(),
        || {
            let f = feat.finish();
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 128 BPM kicks, off-beat hats, a chord pad and a loud, busy middle section.
    fn track(channels: usize, rate: u32, secs: f32, seed: u32) -> Vec<f32> {
        let sr = rate as f32;
        let n = (secs * sr) as usize;
        let mut x = seed;
        let mut noise = move || {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as f32 / u32::MAX as f32 - 0.5
        };
        let mut mono = vec![0.0f32; n];
        let beat = 60.0 / 128.0;
        let mut t = 0.3;
        while t < secs {
            let loud = if t > secs * 0.35 && t < secs * 0.7 { 1.0 } else { 0.3 };
            let i0 = (t * sr) as usize;
            let mut ph = 0.0f32;
            for i in 0..(0.25 * sr) as usize {
                let Some(s) = mono.get_mut(i0 + i) else { break };
                let tt = i as f32 / sr;
                ph += std::f32::consts::TAU * (50.0 + 100.0 * (-tt / 0.03).exp()) / sr;
                *s += loud * 0.7 * (-tt / 0.08).exp() * ph.sin();
            }
            let h0 = ((t + beat / 2.0) * sr) as usize;
            for i in 0..(0.05 * sr) as usize {
                let Some(s) = mono.get_mut(h0 + i) else { break };
                *s += loud * 0.2 * noise() * (-(i as f32 / sr) / 0.015).exp();
            }
            t += beat;
        }
        for (i, s) in mono.iter_mut().enumerate() {
            let tt = i as f32 / sr;
            *s += 0.05 * (std::f32::consts::TAU * 220.0 * tt).sin() + 0.01 * noise();
        }
        mono.iter().flat_map(|&m| (0..channels).map(move |c| m * (1.0 - 0.1 * c as f32))).collect()
    }

    fn streamed(s: &[f32], channels: usize, rate: u32, chunks: &mut dyn FnMut() -> usize, batch_frames: Option<usize>) -> String {
        let mut a = OfflineAnalyzer::new(channels, rate);
        if let Some(b) = batch_frames {
            a.batch = b * channels;
        }
        let mut at = 0;
        while at < s.len() {
            let n = chunks().clamp(1, s.len() - at);
            a.push(&s[at..at + n]);
            at += n;
        }
        format!("{:?}", a.finish_detailed())
    }

    /// Streaming gives exactly the batch result whatever the chunking: chunks of 1 sample, odd
    /// sizes splitting frames, random sizes, and internal analysis batches down to one frame.
    #[test]
    fn streaming_matches_batch_for_any_chunking() {
        let cases = [(2usize, 22_050u32, 20.0f32), (1, 48_000, 7.0), (3, 32_000, 7.5)];
        for (ci, &(channels, rate, secs)) in cases.iter().enumerate() {
            let s = track(channels, rate, secs, 3 + ci as u32);
            let whole = analyze_detailed(&s, channels, rate);
            assert!(whole.0.bpm.is_some() && whole.0.integrated_lufs.is_some(), "{channels}ch {rate}: {:?}", whole.0);
            let whole = format!("{whole:?}");
            let mut rng = 12345u32;
            let mut random = move || {
                rng ^= rng << 13;
                rng ^= rng >> 17;
                rng ^= rng << 5;
                1 + rng as usize % 30_000
            };
            type Run<'a> = (&'a str, &'a mut dyn FnMut() -> usize, Option<usize>);
            let runs: [Run; 6] = [
                ("4096 frames", &mut || 4096 * channels, None),
                ("1001 samples", &mut || 1001, None),
                ("1001 samples, 333-frame batches", &mut || 1001, Some(333)),
                ("random, 1500-frame batches", &mut random, Some(1500)),
                ("5000 frames, 4096-frame batches", &mut || 5000 * channels, Some(4096)),
                ("whole buffer", &mut || usize::MAX, None),
            ];
            for (name, chunks, batch) in runs {
                assert!(streamed(&s, channels, rate, chunks, batch) == whole, "{channels}ch {rate}: {name}");
            }
        }
    }

    /// One-sample pushes analysed one frame at a time (every block, super-block, frame and
    /// normalisation block boundary is crossed mid-stream).
    #[test]
    fn streaming_one_sample_at_a_time() {
        for (channels, rate) in [(1usize, 8_000u32), (2, 8_000)] {
            let s = track(channels, rate, 3.5, 9);
            let whole = format!("{:?}", analyze_detailed(&s, channels, rate));
            assert!(streamed(&s, channels, rate, &mut || 1, Some(1)) == whole, "{channels}ch: 1 sample, 1-frame batches");
            assert!(streamed(&s, channels, rate, &mut || 3, Some(2)) == whole, "{channels}ch: 3 samples, 2-frame batches");
        }
    }

    /// Every published value is finite: below 4 kHz (unstable K-weighting) as the defined
    /// unanalysable result, from batch, streaming and loudness-only calls alike; from 4 kHz up as
    /// a real measurement.
    #[test]
    fn low_sample_rates_publish_only_finite_values() {
        fn all_finite(a: &OfflineAnalysis) -> bool {
            let opt = |v: Option<f32>| v.is_none_or(f32::is_finite);
            [a.integrated_lufs, a.loudness_range, a.true_peak_db, a.bpm, a.intensity].into_iter().all(opt)
                && a.bpm_confidence.is_finite()
                && a.beats.iter().chain(&a.downbeats).chain(&a.energy).all(|v| v.is_finite())
                && a.kiai.iter().all(|(s, e)| s.is_finite() && e.is_finite())
                && a.energy.len() == ENERGY_POINTS
        }
        let streamed_eq_batch = |s: &[f32], rate: u32, what: &str| {
            let mut a = OfflineAnalyzer::new(1, rate);
            for c in s.chunks(1001) {
                a.push(c);
            }
            assert_eq!(format!("{:?}", a.finish()), format!("{:?}", analyze(s, 1, rate)), "{what} at {rate} Hz");
        };
        let sine = |rate: u32| -> Vec<f32> { (0..2 * rate).map(|i| 0.1 * (std::f32::consts::TAU * 100.0 * i as f32 / rate as f32).sin()).collect() };
        for rate in [1_000u32, 2_000, 3_000, 3_999] {
            let s = sine(rate);
            let a = analyze(&s, 1, rate);
            assert!(all_finite(&a), "{rate} Hz: {a:?}");
            assert_eq!((a.integrated_lufs, a.true_peak_db, a.intensity, a.duration_ms), (None, None, None, 2000), "{rate} Hz");
            assert!(a.energy.iter().all(|&e| e == 0.0), "{rate} Hz");
            assert_eq!(loudness_full(&s, 1, rate), Loudness::default(), "{rate} Hz");
            assert_eq!(loudness(&s, 1, rate), (None, None), "{rate} Hz");
            streamed_eq_batch(&s, rate, "sine");
        }
        for rate in [4_000u32, 4_001, 5_512, 8_000] {
            let mut impulse = vec![0.0f32; 2 * rate as usize];
            impulse[rate as usize] = 0.9;
            for (what, s) in [("sine", sine(rate)), ("impulse", impulse), ("silence", vec![0.0; 2 * rate as usize])] {
                let a = analyze(&s, 1, rate);
                assert!(all_finite(&a), "{what} at {rate} Hz: {a:?}");
                let l = loudness_full(&s, 1, rate);
                assert!([l.integrated_lufs, l.loudness_range, l.true_peak_db].into_iter().all(|v| v.is_none_or(f32::is_finite)), "{what} at {rate} Hz: {l:?}");
                assert_eq!(l.integrated_lufs.map(f32::to_bits), a.integrated_lufs.map(f32::to_bits), "{what} at {rate} Hz");
                streamed_eq_batch(&s, rate, what);
            }
            let a = analyze(&sine(rate), 1, rate);
            let lufs = a.integrated_lufs.expect("sine is measured");
            assert!((lufs + 24.5).abs() < 1.0, "{rate} Hz: {lufs} LUFS");
            assert!(a.energy.iter().any(|&e| e > 0.0), "{rate} Hz: flat energy");
        }
    }

    #[test]
    fn analyzer_can_move_between_threads() {
        fn assert_send<T: Send>() {}
        assert_send::<OfflineAnalyzer>();
    }

    #[test]
    fn streaming_edge_cases() {
        // Unanalysable input still reports its duration, like the batch function.
        for (channels, rate, s) in
            [(0usize, 44_100u32, vec![0.1f32; 100]), (2, 500, vec![0.1; 2000]), (2, 44_100, vec![]), (2, 44_100, vec![0.3])]
        {
            let mut a = OfflineAnalyzer::new(channels, rate);
            a.push(&s);
            assert_eq!(format!("{:?}", a.finish()), format!("{:?}", analyze(&s, channels, rate)), "{channels}ch {rate} {}", s.len());
        }
        // Loudness so far is provisional; `integrated_lufs` after the last push is final.
        let s = track(2, 22_050, 12.3, 1);
        let whole = analyze(&s, 2, 22_050);
        let mut a = OfflineAnalyzer::new(2, 22_050);
        assert_eq!(a.loudness_so_far(), None);
        assert_eq!(a.integrated_lufs(), None);
        a.push(&s);
        let so_far = a.loudness_so_far().expect("loudness so far");
        assert!((so_far - whole.integrated_lufs.unwrap()).abs() < 1.0);
        assert_eq!(a.integrated_lufs().map(f32::to_bits), whole.integrated_lufs.map(f32::to_bits));
        assert_eq!(format!("{:?}", a.finish()), format!("{whole:?}"));
    }

    /// The early integrated loudness equals the final one bit for bit for any chunking, and
    /// asking for it mid-stream (which analyses buffered frames early) changes nothing.
    #[test]
    fn integrated_lufs_before_finish_is_exact() {
        for (channels, rate, secs) in [(2usize, 22_050u32, 9.37f32), (1, 48_000, 6.05), (2, 8_000, 3.0), (2, 44_100, 0.2)] {
            let s = track(channels, rate, secs, 2);
            let whole = analyze(&s, channels, rate);
            for chunk in [1usize, 1001, 9_999, 44_100, s.len().max(1)] {
                let mut a = OfflineAnalyzer::new(channels, rate);
                let mut at = 0;
                for c in s.chunks(chunk) {
                    a.push(c);
                    if (at + c.len()) / 30_011 != at / 30_011 {
                        let _ = a.integrated_lufs(); // mid-stream: analyses buffered frames early
                    }
                    at += c.len();
                }
                let early = a.integrated_lufs();
                assert_eq!(early.map(f32::to_bits), whole.integrated_lufs.map(f32::to_bits), "{channels}ch {rate} chunk {chunk}");
                assert_eq!(format!("{:?}", a.finish()), format!("{whole:?}"), "{channels}ch {rate} chunk {chunk}");
            }
        }
    }
}
