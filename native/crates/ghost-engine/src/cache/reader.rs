//! Blocking `Read + Seek` view of a cache entry for decoders.

use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::{CacheManager, Entry, State, CHUNK_SIZE};

pub struct CacheReader {
    entry: Arc<Entry>,
    mgr: Arc<CacheManager>,
    pos: u64,
    cancel: Option<Arc<AtomicBool>>,
    /// See [`CacheManager::open_background_reader`].
    background: bool,
}

impl CacheReader {
    pub(super) fn new(entry: Arc<Entry>, mgr: Arc<CacheManager>, cancel: Option<Arc<AtomicBool>>, background: bool) -> Self {
        entry.readers.fetch_add(1, Ordering::AcqRel);
        {
            let mut st = entry.state.lock();
            st.last_reader_seen = Instant::now();
        }
        entry.ensure_fetcher();
        Self { entry, mgr, pos: 0, cancel, background }
    }

    pub fn entry(&self) -> &Arc<Entry> {
        &self.entry
    }

    pub fn total_len(&self) -> Option<u64> {
        self.entry.total()
    }

    pub fn content_type(&self) -> Option<String> {
        self.entry.state.lock().content_type.clone()
    }

    pub fn is_complete(&self) -> bool {
        self.entry.is_complete()
    }

    /// Block until the first bytes (and with them size / content type) are available.
    pub fn wait_header(&self) -> io::Result<()> {
        self.ensure_available(0).map(|_| ())
    }

    /// Bytes present so far (for progress reporting).
    pub fn bytes_present(&self) -> u64 {
        self.entry.state.lock().bytes_present()
    }

    fn canceled(&self) -> bool {
        self.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed))
    }

    /// Wait until bytes at `pos` are on disk; returns how many can be read there without
    /// blocking (0 = end of the stream).
    fn ensure_available(&self, pos: u64) -> io::Result<u64> {
        let stall = self.mgr.stall_timeout;
        let c = pos / CHUNK_SIZE;
        let mut st = self.entry.state.lock();
        if let Some(n) = available_at(&st, pos) {
            return Ok(n);
        }
        let started = Instant::now();
        let mut since = started;
        let mut gen = st.progress_gen;
        let mut demanded = false;
        let result = loop {
            if let Some(n) = available_at(&st, pos) {
                break Ok(n);
            }
            if let Some(f) = &st.fatal {
                break Err(io::Error::other(format!("stream failed: {f}")));
            }
            if self.canceled() {
                break Err(io::Error::other("canceled"));
            }
            if !demanded {
                if self.background {
                    if !st.bg_demand.contains(&c) {
                        st.bg_demand.push(c);
                    }
                } else {
                    st.demand.retain(|&d| d != c);
                    st.demand.insert(0, c);
                }
                demanded = true;
                self.entry.cond.notify_all();
            }
            if !st.fetcher_running {
                drop(st);
                self.entry.ensure_fetcher();
                st = self.entry.state.lock();
                continue;
            }
            if st.progress_gen != gen {
                gen = st.progress_gen;
                since = Instant::now();
            }
            if since.elapsed() > stall {
                let why = st.last_error.clone().unwrap_or_else(|| "no data".into());
                break Err(io::Error::new(io::ErrorKind::TimedOut, format!("stream stalled for {}s ({why})", stall.as_secs())));
            }
            st.wait_since.get_or_insert(started);
            st.waiting += 1;
            self.entry.cond.wait_for(&mut st, Duration::from_millis(100));
            st.waiting -= 1;
        };
        if demanded {
            if self.background {
                st.bg_demand.retain(|&d| d != c);
            } else {
                st.demand.retain(|&d| d != c);
            }
        }
        if st.waiting == 0 {
            st.wait_since = None;
        }
        result
    }
}

impl Drop for CacheReader {
    fn drop(&mut self) {
        let left = self.entry.readers.fetch_sub(1, Ordering::AcqRel) - 1;
        self.entry.cond.notify_all();
        if left == 0 && self.entry.state.lock().meta_dirty {
            // Persist what we have now; the fetcher may keep going for a while.
            self.entry.write_meta();
        }
    }
}

impl Read for CacheReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if !self.background {
            self.entry.read_hint.store(self.pos, Ordering::Relaxed);
        }
        let avail = self.ensure_available(self.pos)?;
        if avail == 0 {
            return Ok(0);
        }
        let n = (buf.len() as u64).min(avail) as usize;
        let got = self.entry.read_at(&mut buf[..n], self.pos)?;
        self.pos += got as u64;
        Ok(got)
    }
}

impl Seek for CacheReader {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let new = match to {
            SeekFrom::Start(p) => p as i64,
            SeekFrom::Current(d) => self.pos as i64 + d,
            SeekFrom::End(d) => {
                if self.entry.total().is_none() {
                    self.ensure_available(0)?;
                }
                let t = self.entry.total().ok_or_else(|| io::Error::other("length unknown"))?;
                t as i64 + d
            }
        };
        if new < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before start"));
        }
        self.pos = new as u64;
        Ok(self.pos)
    }
}

impl symphonia::core::io::MediaSource for CacheReader {
    fn is_seekable(&self) -> bool {
        self.entry.total().is_some()
    }
    fn byte_len(&self) -> Option<u64> {
        self.entry.total()
    }
}

/// Bytes readable at `pos` without waiting: `Some(0)` at/after the end, `None` if the data isn't
/// on disk yet. Within the chunk being downloaded, the prefix already written counts.
fn available_at(st: &State, pos: u64) -> Option<u64> {
    if let Some(t) = st.total {
        if pos >= t {
            return Some(0);
        }
    }
    let c = pos / CHUNK_SIZE;
    let chunk_end = (c + 1) * CHUNK_SIZE;
    let end = st.total.map_or(chunk_end, |t| t.min(chunk_end));
    if st.complete || st.has(c) {
        return Some(end - pos);
    }
    match st.partial {
        Some((pc, filled)) if pc == c && c * CHUNK_SIZE + filled > pos => Some(c * CHUNK_SIZE + filled - pos),
        _ => None,
    }
}
