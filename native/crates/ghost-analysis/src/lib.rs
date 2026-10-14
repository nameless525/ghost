//! GHOST audio analysis: real-time spectrum/onset frames for visuals and offline track
//! analysis (loudness, beat grid, kiai sections, energy curve, intensity stars).
//!
//! Public API is a contract with `ghost-engine`: keep signatures stable, extend additively.

pub const NUM_BANDS: usize = 96;
pub const WAVEFORM_LEN: usize = 512;
pub const ENERGY_POINTS: usize = 512;

/// One real-time frame for the renderer.
#[derive(Clone, Debug)]
pub struct AnalysisFrame {
    /// 96 log-spaced bands 30 Hz–16 kHz, smoothed (fast attack / slow release), 0..1.
    pub bands: [f32; NUM_BANDS],
    /// Most recent mono samples, -1..1.
    pub waveform: [f32; WAVEFORM_LEN],
    pub rms: f32,
    pub peak: f32,
    /// Spectral-flux onset strength, roughly 0..1.
    pub onset: f32,
    /// Audible position this frame corresponds to (filled in by the engine).
    pub position_ms: f64,
    /// Engine track sequence number (filled in by the engine).
    pub track_seq: u32,
}

impl Default for AnalysisFrame {
    fn default() -> Self {
        Self { bands: [0.0; NUM_BANDS], waveform: [0.0; WAVEFORM_LEN], rms: 0.0, peak: 0.0, onset: 0.0, position_ms: 0.0, track_seq: 0 }
    }
}

pub mod realtime {
    use super::AnalysisFrame;

    /// Feed post-gain output samples; call `compute` at display rate (or a fixed hop).
    pub struct RealtimeAnalyzer {
        _sample_rate: u32,
    }

    impl RealtimeAnalyzer {
        pub fn new(sample_rate: u32) -> Self {
            Self { _sample_rate: sample_rate }
        }
        /// Push interleaved samples (any channel count; mixed to mono internally).
        pub fn push_interleaved(&mut self, _samples: &[f32], _channels: usize) {}
        /// Compute the latest frame from the most recent samples. `dt_sec` is the time since the
        /// previous call, used for attack/release smoothing.
        pub fn compute(&mut self, _dt_sec: f32, _out: &mut AnalysisFrame) {}
        /// Clear history (on seek / track change) so smoothing doesn't smear across tracks.
        pub fn reset(&mut self) {}
    }
}

pub mod offline {
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

    /// Analyse a whole decoded track. `samples` are interleaved f32 at `sample_rate`.
    pub fn analyze(_samples: &[f32], _channels: usize, sample_rate: u32) -> OfflineAnalysis {
        let _ = sample_rate;
        OfflineAnalysis::default()
    }

    /// Loudness only (fast path for normalisation before the full analysis is done).
    pub fn loudness(_samples: &[f32], _channels: usize, _sample_rate: u32) -> (Option<f32>, Option<f32>) {
        (None, None)
    }
}
