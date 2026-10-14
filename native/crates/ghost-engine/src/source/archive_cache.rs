//! Extracted rip-set archives, shared by every track that plays from the same set.
//!
//! A set is decompressed once (7z sets are solid) and kept in memory while it is in use, so
//! consecutive entries of one archive chain gaplessly without re-extracting. Two sets are kept.
//! Fetching runs unlocked (the stream cache shares one download between readers); extraction is
//! serialised so a track and its preloaded successor don't both unpack the same set.

use std::sync::Arc;

use ghost_formats::archive::{self, Extracted};
use parking_lot::Mutex;

use super::{OpenCtx, SourceError};
use crate::SourceSpec;

const KEEP: usize = 2;
/// Archives are read whole; rip sets are far smaller than this.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

static SETS: Mutex<Vec<(String, Arc<Extracted>)>> = Mutex::new(Vec::new());
static EXTRACTING: Mutex<()> = Mutex::new(());

/// Identity of the archive behind `spec` (extras ignored).
fn key_of(spec: &SourceSpec) -> String {
    match spec {
        SourceSpec::File { path, .. } => {
            let m = std::fs::metadata(path).ok();
            let mtime = m.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
            format!("file:{}:{}:{mtime}", path.display(), m.map(|m| m.len()).unwrap_or(0))
        }
        SourceSpec::Http { cache_key, url, .. } => format!("http:{}", if cache_key.is_empty() { url } else { cache_key }),
    }
}

fn lookup(key: &str) -> Option<Arc<Extracted>> {
    let mut sets = SETS.lock();
    let i = sets.iter().position(|(k, _)| k == key)?;
    let e = sets.remove(i);
    let v = e.1.clone();
    sets.push(e);
    Some(v)
}

/// The extracted archive behind `spec`, fetching it through the cache if needed.
pub fn get(spec: &SourceSpec, ctx: &OpenCtx<'_>) -> Result<Arc<Extracted>, SourceError> {
    let key = key_of(spec);
    if let Some(v) = lookup(&key) {
        return Ok(v);
    }
    let data = super::read_all(&spec.base(), ctx, MAX_ARCHIVE_BYTES)?;
    if archive::kind_of(&data).is_none() {
        return Err(SourceError::new(format!("{} is not a zip or 7z archive", super::source_name(spec))));
    }
    let _one_at_a_time = EXTRACTING.lock();
    if let Some(v) = lookup(&key) {
        return Ok(v);
    }
    let set = Arc::new(archive::extract_all(&data)?);
    let mut sets = SETS.lock();
    sets.retain(|(k, _)| *k != key);
    sets.push((key, set.clone()));
    while sets.len() > KEEP {
        sets.remove(0);
    }
    Ok(set)
}
