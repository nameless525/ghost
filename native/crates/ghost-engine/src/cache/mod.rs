//! Sparse on-disk stream cache (DESIGN §5.3).
//!
//! Each remote source is stored as `<sha1(cache_key)>.data` (a sparse file, written chunk by
//! chunk) plus a `.meta` sidecar holding the total size, content type and a bitmap of the 256 KB
//! chunks that are present. A fetcher thread per open entry fills it with bounded HTTP Range
//! requests: chunks a blocked reader is waiting for first, then ~30 s ahead of the read position,
//! then chunks a blocked background reader (a loudness measurement) waits for, then the rest of
//! the file (forward from the read position, then from the start). Servers that
//! ignore Range are filled linearly. Decoders read through [`CacheReader`], an ordinary blocking
//! `Read + Seek`; bytes of the chunk being downloaded are readable as soon as they are on disk,
//! so playback starts after the first few KB rather than the first whole chunk.
//!
//! Least-recently-used entries are evicted (never ones that are open) once the directory grows
//! past `cache_max_bytes`; the directory scan runs on a background thread.

mod fetch;
mod reader;
#[cfg(test)]
mod tests;

pub use reader::CacheReader;

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use parking_lot::{Condvar, Mutex};

use crate::http::Http;
use crate::util::hash_key;
use crate::SourceSpec;

pub const CHUNK_SIZE: u64 = 256 * 1024;
const META_MAGIC: &[u8; 4] = b"GHC1";
/// Bytes to prefetch ahead of the read position (~30 s of 320 kbps audio).
pub const PREFETCH_BYTES: u64 = 1536 * 1024;
/// How long a URL that answered 401/403/404/410 is considered dead (a transient block, e.g. a
/// CDN challenge, may lift; an expired signed URL never does, but by then it was replaced).
pub(crate) const DEAD_URL_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub enum CacheEvent {
    Complete { cache_key: String, path: PathBuf, bytes: u64 },
}

#[derive(Clone, Debug, Default)]
pub struct CacheStats {
    pub dir: PathBuf,
    pub entries: usize,
    pub complete_entries: usize,
    pub bytes: u64,
    pub max_bytes: u64,
    pub open_entries: usize,
}

/// How far an entry has come (see [`Entry::progress`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EntryProgress {
    /// Bytes on disk: complete chunks plus the downloaded prefix of the chunk in flight.
    pub bytes: u64,
    pub total: Option<u64>,
    /// The size / type are known: a response header arrived (now, or on an earlier fetch of this
    /// entry, for one reopened from disk).
    pub connected: bool,
    /// How long a reader blocked on this entry has gone without new bytes (zero when no reader
    /// is blocked). A reader gives up after `CacheManager::stall_timeout` of this.
    pub stalled: Duration,
}

#[derive(Debug)]
pub struct CacheError(pub String);
impl std::fmt::Display for CacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub struct CacheManager {
    dir: PathBuf,
    max_bytes: AtomicU64,
    pub(crate) http: Arc<Http>,
    entries: Mutex<HashMap<String, Weak<Entry>>>,
    subscribers: Mutex<Vec<Sender<CacheEvent>>>,
    /// A reader waiting this long without any progress gives up (recoverable stall error).
    pub(crate) stall_timeout: Duration,
    /// How long a fetcher keeps filling after its last reader went away.
    pub(crate) idle_grace: Duration,
    /// An eviction pass is queued or running (coalesces passes requested while one runs).
    evict_pending: AtomicBool,
}

/// Chunk bitmap plus bookkeeping, guarded by `Entry::state`.
pub(crate) struct State {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub total: Option<u64>,
    pub content_type: Option<String>,
    pub bits: Vec<u64>,
    pub present_count: u64,
    pub complete: bool,
    pub range_ok: Option<bool>,
    /// Chunks blocked readers are waiting for (most urgent first).
    pub demand: Vec<u64>,
    /// Chunks blocked background readers are waiting for: fetched after the read-ahead window,
    /// and never a reason to drop a response (see `CacheManager::open_background_reader`).
    pub bg_demand: Vec<u64>,
    /// The chunk being downloaded right now and how many of its leading bytes are on disk
    /// (readable before the chunk is complete).
    pub partial: Option<(u64, u64)>,
    /// Readers blocked waiting for data (progress notifications are skipped when zero).
    pub waiting: u32,
    /// When the longest-blocked reader started waiting (None while no reader waits). With
    /// `last_progress`, this is the stall clock `progress()` reports.
    pub wait_since: Option<Instant>,
    /// URLs that answered 401/403/404/410, and when: not fetched again for `DEAD_URL_TTL` (a
    /// provider may still hand them out, e.g. a stale preload of an expired YouTube URL), so
    /// callers fail fast and re-resolve instead of hammering a dead link.
    pub dead_urls: Vec<(String, Instant)>,
    pub fatal: Option<String>,
    pub last_error: Option<String>,
    pub fetcher_running: bool,
    pub last_progress: Instant,
    pub progress_gen: u64,
    pub meta_dirty: bool,
    pub last_meta_write: Instant,
    pub last_reader_seen: Instant,
}

impl State {
    pub fn n_chunks(&self) -> Option<u64> {
        self.total.map(|t| t.div_ceil(CHUNK_SIZE))
    }
    pub fn has(&self, c: u64) -> bool {
        let w = (c / 64) as usize;
        w < self.bits.len() && self.bits[w] & (1 << (c % 64)) != 0
    }
    pub fn set(&mut self, c: u64) -> bool {
        let w = (c / 64) as usize;
        if w >= self.bits.len() {
            self.bits.resize(w + 1, 0);
        }
        let m = 1u64 << (c % 64);
        if self.bits[w] & m == 0 {
            self.bits[w] |= m;
            self.present_count += 1;
            true
        } else {
            false
        }
    }
    pub fn all_present(&self) -> bool {
        matches!(self.n_chunks(), Some(n) if self.present_count >= n)
    }
    /// First missing chunk in `[from, to)` (to clamped to the known chunk count).
    pub fn first_missing(&self, from: u64, to: u64) -> Option<u64> {
        let end = match self.n_chunks() {
            Some(n) => to.min(n),
            None => to,
        };
        (from..end).find(|&c| !self.has(c))
    }
    /// Bytes on disk: present chunks (the last one counted at its real length) plus the written
    /// prefix of the chunk being downloaded.
    pub fn bytes_present(&self) -> u64 {
        if self.complete {
            if let Some(t) = self.total {
                return t;
            }
        }
        let mut bytes = self.present_count * CHUNK_SIZE;
        if let Some(n) = self.n_chunks().filter(|&n| n > 0 && self.has(n - 1)) {
            bytes -= n * CHUNK_SIZE - self.total.unwrap_or(0);
        }
        match self.partial {
            Some((c, filled)) if !self.has(c) => bytes += filled,
            _ => {}
        }
        self.total.map_or(bytes, |t| bytes.min(t))
    }
}

pub struct Entry {
    pub key: String,
    pub(crate) data_path: PathBuf,
    meta_path: PathBuf,
    pub(crate) file: File,
    pub(crate) state: Mutex<State>,
    pub(crate) cond: Condvar,
    pub(crate) readers: AtomicUsize,
    /// Latest byte position a reader asked for (prefetch anchor).
    pub(crate) read_hint: AtomicU64,
    pub(crate) shutdown: AtomicBool,
    manager: Weak<CacheManager>,
}

impl CacheManager {
    pub fn new(dir: PathBuf, max_bytes: u64, user_agent: &str) -> Result<Arc<Self>, CacheError> {
        std::fs::create_dir_all(&dir).map_err(|e| CacheError(format!("create cache dir {}: {e}", dir.display())))?;
        Ok(Arc::new(Self {
            dir,
            max_bytes: AtomicU64::new(max_bytes.max(64 * 1024 * 1024)),
            http: Arc::new(Http::new(user_agent)),
            entries: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            stall_timeout: Duration::from_secs(8),
            idle_grace: Duration::from_secs(5),
            evict_pending: AtomicBool::new(false),
        }))
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(dir: PathBuf, max_bytes: u64, stall: Duration) -> Arc<Self> {
        std::fs::create_dir_all(&dir).unwrap();
        Arc::new(Self {
            dir,
            max_bytes: AtomicU64::new(max_bytes),
            http: Arc::new(Http::new("ghost-test")),
            entries: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            stall_timeout: stall,
            idle_grace: Duration::from_millis(300),
            evict_pending: AtomicBool::new(false),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn subscribe(&self, tx: Sender<CacheEvent>) {
        self.subscribers.lock().push(tx);
    }

    fn publish(&self, ev: CacheEvent) {
        self.subscribers.lock().retain(|tx| tx.send(ev.clone()).is_ok());
    }

    fn paths(&self, key: &str) -> (PathBuf, PathBuf) {
        let h = hash_key(key);
        (self.dir.join(format!("{h}.data")), self.dir.join(format!("{h}.meta")))
    }

    /// Open (or create) the entry for an HTTP source. Updates the entry's URL/headers, since
    /// providers may hand out a fresh URL for the same cache key.
    pub fn entry(self: &Arc<Self>, spec: &SourceSpec) -> Result<Arc<Entry>, CacheError> {
        let SourceSpec::Http { url, headers, cache_key, .. } = spec else {
            return Err(CacheError("not an http source".into()));
        };
        let key = if cache_key.is_empty() { url.clone() } else { cache_key.clone() };
        let mut map = self.entries.lock();
        if let Some(e) = map.get(&key).and_then(Weak::upgrade) {
            let mut st = e.state.lock();
            st.dead_urls.retain(|(_, at)| at.elapsed() < DEAD_URL_TTL);
            if !st.dead_urls.iter().any(|(d, _)| d == url) {
                if st.url != *url && !st.complete {
                    // The fetcher replans for it at once, leaving a request that waits on the old
                    // one; its server may answer ranges differently.
                    st.range_ok = None;
                    e.cond.notify_all();
                }
                st.url = url.clone();
                st.headers = headers.clone();
            }
            let current_dead = st.dead_urls.iter().any(|(d, _)| *d == st.url);
            if st.fatal.is_some() && !st.complete && !current_dead {
                // A new attempt (likely a re-resolved URL) clears a previous fatal error; a URL
                // that already answered 403/404/410 keeps failing fast instead of being retried.
                st.fatal = None;
            }
            drop(st);
            return Ok(e);
        }
        let (data_path, meta_path) = self.paths(&key);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&data_path)
            .map_err(|e| CacheError(format!("open {}: {e}", data_path.display())))?;
        let mut st = State {
            url: url.clone(),
            headers: headers.clone(),
            total: None,
            content_type: None,
            bits: Vec::new(),
            present_count: 0,
            complete: false,
            range_ok: None,
            demand: Vec::new(),
            bg_demand: Vec::new(),
            partial: None,
            waiting: 0,
            wait_since: None,
            dead_urls: Vec::new(),
            fatal: None,
            last_error: None,
            fetcher_running: false,
            last_progress: Instant::now(),
            progress_gen: 0,
            meta_dirty: true,
            last_meta_write: Instant::now(),
            last_reader_seen: Instant::now(),
        };
        if let Some(m) = read_meta(&meta_path) {
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            let valid = m.chunk_size == CHUNK_SIZE as u32 && m.total.is_none_or(|t| len <= t) && (!m.complete || m.total == Some(len));
            if valid {
                st.total = m.total;
                st.content_type = m.content_type;
                st.bits = m.bits;
                st.present_count = st.bits.iter().map(|w| w.count_ones() as u64).sum();
                st.complete = m.complete || st.all_present();
                st.range_ok = if m.complete { None } else { Some(true) };
            } else {
                let _ = file.set_len(0);
            }
        }
        let entry = Arc::new(Entry {
            key: key.clone(),
            data_path,
            meta_path,
            file,
            state: Mutex::new(st),
            cond: Condvar::new(),
            readers: AtomicUsize::new(0),
            read_hint: AtomicU64::new(0),
            shutdown: AtomicBool::new(false),
            manager: Arc::downgrade(self),
        });
        map.insert(key, Arc::downgrade(&entry));
        map.retain(|_, w| w.strong_count() > 0);
        drop(map);
        entry.write_meta();
        // Not on the open path: a scan touches every file in the cache directory.
        self.evict_async();
        Ok(entry)
    }

    /// Blocking reader over an HTTP source (shares the entry with other readers).
    pub fn open_reader(self: &Arc<Self>, spec: &SourceSpec, cancel: Option<Arc<AtomicBool>>) -> Result<CacheReader, CacheError> {
        let entry = self.entry(spec)?;
        Ok(CacheReader::new(entry, self.clone(), cancel, false))
    }

    /// A reader that never competes with playback: it doesn't move the read-ahead window, and
    /// what it waits for is fetched only once that window is in. For work that reads ahead of
    /// the listener (measuring a chapter of a long video while it plays).
    pub fn open_background_reader(self: &Arc<Self>, spec: &SourceSpec, cancel: Option<Arc<AtomicBool>>) -> Result<CacheReader, CacheError> {
        let entry = self.entry(spec)?;
        Ok(CacheReader::new(entry, self.clone(), cancel, true))
    }

    /// Progress of the entry under `cache_key` while it is open (being read or filled, or held
    /// by a playing track); `None` otherwise. Memory only: a map lookup and a few field reads.
    pub fn progress(&self, cache_key: &str) -> Option<EntryProgress> {
        let e = self.entries.lock().get(cache_key).and_then(Weak::upgrade)?;
        Some(e.progress())
    }

    /// Path and size of a fully cached entry.
    pub fn complete_path(&self, cache_key: &str) -> Option<(PathBuf, u64)> {
        if let Some(e) = self.entries.lock().get(cache_key).and_then(Weak::upgrade) {
            let st = e.state.lock();
            return if st.complete { Some((e.data_path.clone(), st.total.unwrap_or(0))) } else { None };
        }
        let (data, meta) = self.paths(cache_key);
        let m = read_meta(&meta)?;
        let len = std::fs::metadata(&data).ok()?.len();
        (m.complete && m.total == Some(len)).then_some((data, len))
    }

    pub fn set_max_bytes(&self, max: u64) {
        self.max_bytes.store(max, Ordering::Relaxed);
    }

    fn open_hashes(&self) -> Vec<String> {
        self.entries
            .lock()
            .values()
            .filter_map(Weak::upgrade)
            .map(|e| e.data_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default())
            .collect()
    }

    /// Every entry: (hash stem, bytes on disk, last use, complete). `complete` (which reads each
    /// `.meta` file) is only filled in when `with_complete` is set.
    fn scan(&self, with_complete: bool) -> Vec<(String, u64, std::time::SystemTime, bool)> {
        let mut out = Vec::new();
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return out };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.extension().and_then(|e| e.to_str()) != Some("meta") {
                continue;
            }
            let Some(stem) = p.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
            let data = self.dir.join(format!("{stem}.data"));
            let size = disk_usage(&data);
            let atime = ent.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            let complete = with_complete && read_meta(&p).is_some_and(|m| m.complete);
            out.push((stem, size, atime, complete));
        }
        out
    }

    /// Run [`evict`](Self::evict) on a background thread (coalesced).
    pub fn evict_async(self: &Arc<Self>) {
        if self.evict_pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let mgr = self.clone();
        crate::util::spawn_named("ghost-cache-evict", move || {
            crate::util::set_low_priority();
            mgr.evict();
            mgr.evict_pending.store(false, Ordering::Release);
        });
    }

    /// Evict least-recently-used entries (not currently open) until under the size cap.
    pub fn evict(&self) {
        let max = self.max_bytes.load(Ordering::Relaxed);
        let mut all = self.scan(false);
        let mut total: u64 = all.iter().map(|e| e.1).sum();
        if total <= max {
            return;
        }
        let open = self.open_hashes();
        all.sort_by_key(|e| e.2);
        for (stem, size, _, _) in all {
            if total <= max {
                break;
            }
            if open.contains(&stem) {
                continue;
            }
            let _ = std::fs::remove_file(self.dir.join(format!("{stem}.meta")));
            let _ = std::fs::remove_file(self.dir.join(format!("{stem}.data")));
            total = total.saturating_sub(size);
        }
    }

    pub fn stats(&self) -> CacheStats {
        let all = self.scan(true);
        CacheStats {
            dir: self.dir.clone(),
            entries: all.len(),
            complete_entries: all.iter().filter(|e| e.3).count(),
            bytes: all.iter().map(|e| e.1).sum(),
            max_bytes: self.max_bytes.load(Ordering::Relaxed),
            open_entries: self.entries.lock().values().filter(|w| w.strong_count() > 0).count(),
        }
    }

    /// Delete every entry that isn't open.
    pub fn clear(&self) {
        let open = self.open_hashes();
        for (stem, ..) in self.scan(false) {
            if !open.contains(&stem) {
                let _ = std::fs::remove_file(self.dir.join(format!("{stem}.meta")));
                let _ = std::fs::remove_file(self.dir.join(format!("{stem}.data")));
            }
        }
    }
}

fn disk_usage(p: &Path) -> u64 {
    let Ok(m) = std::fs::metadata(p) else { return 0 };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        m.blocks() * 512
    }
    #[cfg(not(unix))]
    {
        m.len()
    }
}

impl Entry {
    pub(crate) fn manager(&self) -> Option<Arc<CacheManager>> {
        self.manager.upgrade()
    }

    pub fn is_complete(&self) -> bool {
        self.state.lock().complete
    }

    /// Stop the fetcher promptly (it exits after the chunk in flight).
    pub fn stop(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        let _st = self.state.lock();
        self.cond.notify_all();
    }

    pub fn total(&self) -> Option<u64> {
        self.state.lock().total
    }

    /// Bytes present, size, whether the server answered, and how long a blocked reader has been
    /// starved. A few field reads under the state lock.
    pub fn progress(&self) -> EntryProgress {
        let now = Instant::now();
        let st = self.state.lock();
        let stalled = match st.wait_since {
            // The reader's own stall clock restarts on every byte that arrives (see `CacheReader`).
            Some(since) => now.saturating_duration_since(since.max(st.last_progress)),
            None => Duration::ZERO,
        };
        EntryProgress {
            bytes: st.bytes_present(),
            total: st.total,
            connected: st.total.is_some() || st.range_ok.is_some() || st.complete,
            stalled,
        }
    }

    /// Make sure a fetcher is filling this entry.
    pub(crate) fn ensure_fetcher(self: &Arc<Self>) {
        let mut st = self.state.lock();
        if st.complete || st.fetcher_running || st.fatal.is_some() {
            return;
        }
        st.fetcher_running = true;
        drop(st);
        let e = self.clone();
        crate::util::spawn_named("ghost-fetch", move || fetch::run(e));
    }

    /// Record a completed chunk (called by the fetcher with the state lock held).
    pub(crate) fn mark_chunk(&self, st: &mut State, c: u64) {
        if st.set(c) {
            st.last_progress = Instant::now();
            st.progress_gen += 1;
            st.meta_dirty = true;
        }
        st.demand.retain(|&d| d != c);
        st.bg_demand.retain(|&d| d != c);
        if !st.complete && st.all_present() {
            st.complete = true;
            st.meta_dirty = true;
        }
    }

    /// Called after the fetcher has marked chunks; persists metadata and announces completion.
    pub(crate) fn after_progress(&self, became_complete: bool) {
        let write = {
            let st = self.state.lock();
            st.meta_dirty && (became_complete || st.last_meta_write.elapsed() > Duration::from_secs(1))
        };
        if write {
            self.write_meta();
        }
        if became_complete {
            let total = self.state.lock().total.unwrap_or(0);
            if let Some(m) = self.manager() {
                m.publish(CacheEvent::Complete { cache_key: self.key.clone(), path: self.data_path.clone(), bytes: total });
                m.evict();
            }
        }
    }

    pub(crate) fn write_meta(&self) {
        let (bytes, path) = {
            let mut st = self.state.lock();
            st.meta_dirty = false;
            st.last_meta_write = Instant::now();
            let mut b = Vec::with_capacity(64 + st.bits.len() * 8);
            b.extend_from_slice(META_MAGIC);
            b.push(1);
            b.push(st.complete as u8);
            b.extend_from_slice(&(CHUNK_SIZE as u32).to_le_bytes());
            b.extend_from_slice(&st.total.unwrap_or(u64::MAX).to_le_bytes());
            let ct = st.content_type.clone().unwrap_or_default();
            let ct = &ct.as_bytes()[..ct.len().min(255)];
            b.extend_from_slice(&(ct.len() as u16).to_le_bytes());
            b.extend_from_slice(ct);
            let key = self.key.as_bytes();
            b.extend_from_slice(&(key.len() as u32).to_le_bytes());
            b.extend_from_slice(key);
            b.extend_from_slice(&(st.bits.len() as u32).to_le_bytes());
            for w in &st.bits {
                b.extend_from_slice(&w.to_le_bytes());
            }
            (b, self.meta_path.clone())
        };
        let tmp = path.with_extension("meta.tmp");
        let ok = File::create(&tmp).and_then(|mut f| f.write_all(&bytes)).is_ok();
        if ok {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    /// Positional write into the data file.
    pub(crate) fn write_at(&self, buf: &[u8], offset: u64) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileExt;
            self.file.write_all_at(buf, offset)
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileExt;
            let mut done = 0;
            while done < buf.len() {
                done += self.file.seek_write(&buf[done..], offset + done as u64)?;
            }
            Ok(())
        }
    }

    pub(crate) fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileExt;
            self.file.read_at(buf, offset)
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileExt;
            self.file.seek_read(buf, offset)
        }
    }
}

impl Drop for Entry {
    fn drop(&mut self) {
        let dirty = self.state.get_mut().meta_dirty;
        if dirty {
            self.write_meta();
        }
    }
}

struct Meta {
    complete: bool,
    chunk_size: u32,
    total: Option<u64>,
    content_type: Option<String>,
    bits: Vec<u64>,
}

fn read_meta(path: &Path) -> Option<Meta> {
    let mut b = Vec::new();
    File::open(path).ok()?.read_to_end(&mut b).ok()?;
    let mut p = 0usize;
    let mut take = |n: usize| -> Option<&[u8]> {
        let s = b.get(p..p + n)?;
        p += n;
        Some(s)
    };
    if take(4)? != META_MAGIC {
        return None;
    }
    let _ver = take(1)?[0];
    let complete = take(1)?[0] != 0;
    let chunk_size = u32::from_le_bytes(take(4)?.try_into().ok()?);
    let total = u64::from_le_bytes(take(8)?.try_into().ok()?);
    let ct_len = u16::from_le_bytes(take(2)?.try_into().ok()?) as usize;
    let ct = String::from_utf8_lossy(take(ct_len)?).into_owned();
    let key_len = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
    take(key_len)?;
    let n = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
    let mut bits = Vec::with_capacity(n);
    for _ in 0..n {
        bits.push(u64::from_le_bytes(take(8)?.try_into().ok()?));
    }
    Some(Meta {
        complete,
        chunk_size,
        total: (total != u64::MAX).then_some(total),
        content_type: (!ct.is_empty()).then_some(ct),
        bits,
    })
}
