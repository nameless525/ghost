//! Blocking `Read + Seek` view of a cache entry for decoders.

use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::{CacheManager, Entry, CHUNK_SIZE};

pub struct CacheReader {
    entry: Arc<Entry>,
    mgr: Arc<CacheManager>,
    pos: u64,
    cancel: Option<Arc<AtomicBool>>,
}

impl CacheReader {
    pub(super) fn new(entry: Arc<Entry>, mgr: Arc<CacheManager>, cancel: Option<Arc<AtomicBool>>) -> Self {
        entry.readers.fetch_add(1, Ordering::AcqRel);
        {
            let mut st = entry.state.lock();
            st.last_reader_seen = Instant::now();
        }
        entry.ensure_fetcher();
        Self { entry, mgr, pos: 0, cancel }
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

    /// Block until the first chunk (and with it size / content type) is available.
    pub fn wait_header(&self) -> io::Result<()> {
        self.ensure_chunk(0)
    }

    /// Bytes present so far (for progress reporting).
    pub fn bytes_present(&self) -> u64 {
        let st = self.entry.state.lock();
        let full = st.present_count * CHUNK_SIZE;
        match st.total {
            Some(t) => full.min(t),
            None => full,
        }
    }

    fn canceled(&self) -> bool {
        self.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed))
    }

    /// Wait until chunk `c` is present (or known to be past the end of the file).
    fn ensure_chunk(&self, c: u64) -> io::Result<()> {
        let stall = self.mgr.stall_timeout;
        let mut st = self.entry.state.lock();
        let mut since = Instant::now();
        let mut gen = st.progress_gen;
        let mut demanded = false;
        let result = loop {
            if st.has(c) || st.complete {
                break Ok(());
            }
            if let Some(t) = st.total {
                if c * CHUNK_SIZE >= t {
                    break Ok(());
                }
            }
            if let Some(f) = &st.fatal {
                break Err(io::Error::other(format!("stream failed: {f}")));
            }
            if self.canceled() {
                break Err(io::Error::other("canceled"));
            }
            if !demanded {
                st.demand.retain(|&d| d != c);
                st.demand.insert(0, c);
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
            self.entry.cond.wait_for(&mut st, Duration::from_millis(100));
        };
        if demanded {
            st.demand.retain(|&d| d != c);
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
        self.entry.read_hint.store(self.pos, Ordering::Relaxed);
        let c = self.pos / CHUNK_SIZE;
        self.ensure_chunk(c)?;
        let total = self.entry.total();
        if let Some(t) = total {
            if self.pos >= t {
                return Ok(0);
            }
        }
        let chunk_end = (c + 1) * CHUNK_SIZE;
        let end = total.map_or(chunk_end, |t| t.min(chunk_end));
        let n = (buf.len() as u64).min(end - self.pos) as usize;
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
                    self.ensure_chunk(0)?;
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
