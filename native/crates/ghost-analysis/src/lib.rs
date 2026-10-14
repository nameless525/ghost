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

/// Real-time analysis (`RealtimeAnalyzer`): feed post-gain output samples; call `compute` at
/// display rate (or a fixed hop). Allocation-free after `new`. See `src/realtime.rs`.
pub mod realtime;

/// Offline whole-track analysis (`analyze`, `loudness`, `OfflineAnalysis`). See
/// `src/offline/mod.rs`.
pub mod offline;

mod dsp;
