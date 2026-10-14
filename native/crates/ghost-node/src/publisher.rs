//! Publisher thread: while audio plays, copies `Engine::analysis_frame` (the frame audible
//! now) into the shared-memory region (see `shm.rs`) at the analysis thread's 200 Hz hop rate.
//! While nothing plays it publishes "no frame", marks the region parked and sleeps in
//! `Engine::wait_analysis` until audio flows again: no polling, no wake-ups when idle or paused.
//! Owned by `GhostEngine`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use ghost_engine::{AnalysisFrame, Engine};

use crate::shm::{ShmWriter, NUM_BANDS, STATE_ACTIVE, STATE_CLOSED, STATE_PARKED, WAVEFORM_LEN};

/// One analysis hop (5 ms): a new frame becomes audible this often.
const PERIOD: Duration = Duration::from_micros(1_000_000 / 200);
/// Upper bound for one idle sleep (the wait is woken by activity / shutdown long before).
const PARK_TIMEOUT: Duration = Duration::from_secs(3600);

/// Set `GHOST_ANALYSIS_SYNTHETIC=1` to publish a generated 120 BPM test signal whenever the
/// engine has no real frame. Lets visualizers be developed (and the channel verified)
/// without audio.
fn synthetic_enabled() -> bool {
    matches!(
        std::env::var("GHOST_ANALYSIS_SYNTHETIC").as_deref(),
        Ok("1") | Ok("true")
    )
}

pub struct Publisher {
    stop: Arc<AtomicBool>,
    engine: Arc<Engine>,
    thread: Option<JoinHandle<()>>,
    path: PathBuf,
}

impl Publisher {
    pub fn start(engine: Arc<Engine>, path: &Path) -> std::io::Result<Publisher> {
        let writer = ShmWriter::create(path)?;
        writer.publish(None);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_t = stop.clone();
        let synthetic = synthetic_enabled();
        let engine_t = engine.clone();
        let thread = std::thread::Builder::new()
            .name("ghost-analysis-shm".into())
            .spawn(move || {
                let engine = engine_t;
                let _cpu = ghost_engine::stats::register_thread("ghost-analysis-shm");
                let mut frame = AnalysisFrame::default();
                let t0 = Instant::now();
                let mut next = Instant::now();
                let mut parked = false;
                while !stop_t.load(Ordering::Acquire) {
                    if engine.analysis_frame(&mut frame) {
                        if parked {
                            writer.set_state(STATE_ACTIVE);
                            parked = false;
                        }
                        writer.publish(Some(&frame));
                    } else if synthetic {
                        synthesize(t0.elapsed().as_secs_f64(), &mut frame);
                        writer.publish(Some(&frame));
                    } else {
                        // Idle / paused: say so once, then sleep until audio flows again.
                        writer.publish(None);
                        writer.set_state(STATE_PARKED);
                        parked = true;
                        engine.wait_analysis(PARK_TIMEOUT, &stop_t);
                        next = Instant::now();
                        continue;
                    }
                    next += PERIOD;
                    let now = Instant::now();
                    if next > now {
                        std::thread::sleep(next - now);
                    } else {
                        next = now; // fell behind (suspend, load): don't try to catch up
                    }
                }
                // Tell mapped readers immediately that nothing is playing any more, and that
                // this region is finished (they reopen the path for a replacement engine).
                writer.publish(None);
                writer.set_state(STATE_CLOSED);
            })?;
        Ok(Publisher {
            stop,
            engine,
            thread: Some(thread),
            path: path.to_path_buf(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Stop the thread and delete the region file. Idempotent.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.engine.wake_analysis_waiters();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl Drop for Publisher {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Deterministic test signal: 120 BPM kick pulses, a slowly sweeping spectrum and a sine scope.
fn synthesize(t: f64, f: &mut AnalysisFrame) {
    let beat = (t * 2.0).fract(); // 0..1 within each beat at 120 BPM
    let pulse = (-(beat * 8.0)).exp() as f32;
    let sweep = (t * 0.25).fract() as f32 * NUM_BANDS as f32;
    for (i, b) in f.bands.iter_mut().enumerate() {
        let x = i as f32;
        let tilt = 1.0 - x / NUM_BANDS as f32 * 0.6;
        let hump = (-(x - sweep).powi(2) / 60.0).exp();
        let ripple = 0.5 + 0.5 * ((t as f32 * 3.0) + x * 0.35).sin();
        let low = if i < 12 { pulse } else { 0.0 };
        *b = (0.25 * tilt * ripple + 0.55 * hump + 0.6 * low).clamp(0.0, 1.0);
    }
    let amp = 0.35 + 0.45 * pulse;
    let phase = (t * 220.0 * std::f64::consts::TAU) as f32;
    for (i, w) in f.waveform.iter_mut().enumerate() {
        let x = i as f32 / WAVEFORM_LEN as f32 * std::f32::consts::TAU * 4.0;
        *w = amp * (x + phase).sin() * (0.8 + 0.2 * (x * 3.0).sin());
    }
    f.rms = amp * 0.7;
    f.peak = amp;
    f.onset = pulse;
    f.position_ms = t * 1000.0;
    f.track_seq = 1;
}
