//! Small low-priority worker pool for background analysis (full-file loudness, beat grid).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};

use crate::cache::CacheManager;
use crate::decode::decode_chunks;
use crate::{EngineEvent, SourceSpec};

type Job = Box<dyn FnOnce() + Send + 'static>;

pub struct JobPool {
    tx: Sender<Job>,
}

impl JobPool {
    pub fn new(threads: usize) -> Self {
        let (tx, rx) = crossbeam_channel::unbounded::<Job>();
        for i in 0..threads.max(1) {
            let rx: Receiver<Job> = rx.clone();
            crate::util::spawn_named(&format!("ghost-job-{i}"), move || {
                crate::util::set_low_priority();
                while let Ok(job) = rx.recv() {
                    // A panicking job must not take the worker down with it.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                }
            });
        }
        Self { tx }
    }

    pub fn submit(&self, f: impl FnOnce() + Send + 'static) {
        let _ = self.tx.send(Box::new(f));
    }
}

/// Result of a loudness measurement, sent back to the controller.
#[derive(Debug)]
pub struct Loudness {
    pub id: String,
    /// Integrated loudness of the track (None: it couldn't be measured), or, when `interim`, of
    /// the part decoded so far (`secs` of audio) while the rest still downloads.
    pub lufs: Option<f32>,
    pub interim: bool,
    pub secs: f32,
    /// The job was called off (its track was dropped) before it finished.
    pub canceled: bool,
}

/// A measurement that waits on a download reports the loudness so far this often, once it has
/// decoded `INTERIM_MIN_SECS` of audio. A local decode finishes before the first report.
const INTERIM_EVERY: Duration = Duration::from_secs(1);
const INTERIM_MIN_SECS: u64 = 5;

fn cache_key_of(spec: &SourceSpec) -> Option<String> {
    match spec {
        SourceSpec::Http { cache_key, .. } => Some(cache_key.clone()),
        SourceSpec::File { .. } => None,
    }
}

/// Decode the whole source, measure loudness (reported through `loudness_tx`, if given), then run
/// the full offline analysis and emit `EngineEvent::Analysis`.
pub fn analyze_job(
    id: String,
    source: SourceSpec,
    cache: Arc<CacheManager>,
    events: Sender<EngineEvent>,
    loudness_tx: Option<Sender<Loudness>>,
    cancel: Arc<AtomicBool>,
    loops: (crate::LoopMode, u32, f32),
) {
    use ghost_analysis::offline::OfflineAnalyzer;
    let mut reported = Instant::now();
    let interim = |a: &mut OfflineAnalyzer, rate: u64| {
        // Decoding as the stream arrives: the part heard so far already shows a loud track.
        let Some(tx) = &loudness_tx else { return };
        if reported.elapsed() < INTERIM_EVERY || a.frames() < INTERIM_MIN_SECS * rate {
            return;
        }
        reported = Instant::now();
        if let Some(l) = a.loudness_so_far().filter(|l| l.is_finite()) {
            let secs = a.frames() as f32 / rate.max(1) as f32;
            let _ = tx.send(Loudness { id: id.clone(), lufs: Some(l), interim: true, secs, canceled: false });
        }
    };
    // Analysis runs alongside decoding (on the analysis crate's low-priority pool), chunk by
    // chunk: no whole-track buffer, and results bit-identical to the batch `analyze()`.
    let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut interim = interim;
        decode_chunks(&source, &cache, cancel.clone(), loops, |ch, rate| (OfflineAnalyzer::new(ch, rate), rate as u64), |(a, rate), chunk| {
            a.push(chunk);
            interim(a, *rate);
        })
    }))
    .unwrap_or_else(|_| Err("decoder crashed (malformed stream)".into()));
    let (mut analyzer, rate) = match decoded {
        Ok(v) => v,
        Err(e) => {
            match &loudness_tx {
                // The playing track's own background measurement is best effort: its id is the
                // queue item's, so an error event would read as a playback failure.
                Some(tx) => {
                    let _ = tx.send(Loudness { id: id.clone(), lufs: None, interim: false, secs: 0.0, canceled: cancel.load(Ordering::Relaxed) });
                }
                None if !cancel.load(Ordering::Relaxed) => {
                    let _ = events.send(EngineEvent::Error { id: Some(id), message: format!("analysis failed: {e}"), recoverable: true });
                }
                None => {}
            }
            return;
        }
    };
    // The playing track's gain waits on this: ready right after the last chunk (~1 ms), and
    // exactly the value the full analysis reports.
    if let Some(tx) = &loudness_tx {
        let lufs = analyzer.integrated_lufs();
        let secs = analyzer.frames() as f32 / rate.max(1) as f32;
        let _ = tx.send(Loudness { id: id.clone(), lufs: lufs.filter(|l| l.is_finite()), interim: false, secs, canceled: false });
    }
    if cancel.load(Ordering::Relaxed) {
        return;
    }
    let result = analyzer.finish();
    let _ = events.send(EngineEvent::Analysis { id, cache_key: cache_key_of(&source), result });
}
