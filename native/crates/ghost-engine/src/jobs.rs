//! Small low-priority worker pool for background analysis (full-file loudness, beat grid).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
    pub lufs: Option<f32>,
}

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
    // Analysis runs alongside decoding (on the analysis crate's low-priority pool), chunk by
    // chunk: no whole-track buffer, and results bit-identical to the batch `analyze()`.
    let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        decode_chunks(&source, &cache, cancel.clone(), loops, OfflineAnalyzer::new, |a, chunk| a.push(chunk))
    }))
    .unwrap_or_else(|_| Err("decoder crashed (malformed stream)".into()));
    let mut analyzer = match decoded {
        Ok(a) => a,
        Err(e) => {
            match &loudness_tx {
                // The playing track's own background measurement is best effort: its id is the
                // queue item's, so an error event would read as a playback failure.
                Some(tx) => {
                    let _ = tx.send(Loudness { id: id.clone(), lufs: None });
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
        let _ = tx.send(Loudness { id: id.clone(), lufs: lufs.filter(|l| l.is_finite()) });
    }
    if cancel.load(Ordering::Relaxed) {
        return;
    }
    let result = analyzer.finish();
    let _ = events.send(EngineEvent::Analysis { id, cache_key: cache_key_of(&source), result });
}
