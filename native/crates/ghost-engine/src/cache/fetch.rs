//! Per-entry fetcher thread: fills the sparse cache file with HTTP Range requests.

use std::io::Read;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::{Entry, State, CHUNK_SIZE, PREFETCH_BYTES};
use crate::http::{classify_status, header_str, parse_content_range, HttpError};

/// Chunks per Range request (2 MB). Bounded so a stalled connection can be timed out and so
/// demand from a seeking reader can preempt a long fill.
const MAX_RUN: u64 = 8;

enum Outcome {
    Progress,
    Preempted,
    Idle,
}

struct Job {
    start: u64,
    n: u64,
}

pub(super) fn run(entry: Arc<Entry>) {
    let Some(mgr) = entry.manager() else {
        entry.state.lock().fetcher_running = false;
        return;
    };
    let http = mgr.http.clone();
    let mut attempt: u32 = 0;
    loop {
        let job = {
            let mut st = entry.state.lock();
            if st.complete || st.fatal.is_some() || entry.shutdown.load(Ordering::Relaxed) {
                break;
            }
            if entry.readers.load(Ordering::Acquire) > 0 {
                st.last_reader_seen = Instant::now();
            } else if st.last_reader_seen.elapsed() > mgr.idle_grace {
                break;
            }
            match plan(&st, entry.read_hint.load(Ordering::Relaxed)) {
                Some(j) => j,
                None => {
                    // Nothing missing that we know of (shouldn't happen unless complete).
                    entry.cond.wait_for(&mut st, Duration::from_millis(200));
                    continue;
                }
            }
        };
        match fetch(&entry, &http, &mgr, job) {
            Ok(Outcome::Progress) | Ok(Outcome::Preempted) => attempt = 0,
            Ok(Outcome::Idle) => break,
            Err(HttpError::Fatal(m)) => {
                let mut st = entry.state.lock();
                st.fatal = Some(m);
                entry.cond.notify_all();
                break;
            }
            Err(HttpError::Transient(m)) => {
                attempt += 1;
                let backoff = Duration::from_millis((250u64 << attempt.min(5)).min(4000));
                let mut st = entry.state.lock();
                st.last_error = Some(m);
                entry.cond.notify_all();
                let until = Instant::now() + backoff;
                while Instant::now() < until && !entry.shutdown.load(Ordering::Relaxed) {
                    entry.cond.wait_until(&mut st, until);
                }
            }
        }
    }
    {
        let mut st = entry.state.lock();
        st.fetcher_running = false;
        entry.cond.notify_all();
    }
    entry.write_meta();
}

/// Pick what to fetch next: demanded chunks, then the prefetch window, then the rest.
fn plan(st: &State, read_hint: u64) -> Option<Job> {
    let n_chunks = st.n_chunks();
    let in_range = |c: u64| n_chunks.is_none_or(|n| c < n);
    let start = st
        .demand
        .iter()
        .copied()
        .find(|&d| !st.has(d) && in_range(d))
        .or_else(|| {
            let h = read_hint / CHUNK_SIZE;
            st.first_missing(h, h + PREFETCH_BYTES / CHUNK_SIZE + 1)
        })
        .or_else(|| st.first_missing(0, u64::MAX))?;
    let mut n = 1;
    while n < MAX_RUN && in_range(start + n) && !st.has(start + n) {
        n += 1;
    }
    Some(Job { start, n })
}

fn set_total(entry: &Entry, st: &mut State, total: u64) {
    if st.total != Some(total) {
        st.total = Some(total);
        st.meta_dirty = true;
        let _ = entry.file.set_len(total);
    }
}

fn fetch(entry: &Arc<Entry>, http: &crate::http::Http, mgr: &super::CacheManager, job: Job) -> Result<Outcome, HttpError> {
    let (url, headers, total, range_ok) = {
        let st = entry.state.lock();
        (st.url.clone(), st.headers.clone(), st.total, st.range_ok)
    };
    if range_ok == Some(false) {
        // Server ignores Range: linear fill of the whole body.
        let resp = http.get(&url, &headers, None, None)?;
        let status = resp.status().as_u16();
        if status != 200 {
            return Err(classify_status(status));
        }
        return read_body(entry, mgr, resp, 0, None, false);
    }
    let start = job.start * CHUNK_SIZE;
    let mut end = start + job.n * CHUNK_SIZE - 1;
    if let Some(t) = total {
        if t == 0 {
            let mut st = entry.state.lock();
            st.complete = true;
            entry.cond.notify_all();
            return Ok(Outcome::Progress);
        }
        end = end.min(t - 1);
    }
    let body_timeout = Duration::from_secs(20 + job.n * 8);
    let resp = http.get(&url, &headers, Some((start, Some(end))), Some(body_timeout))?;
    let status = resp.status().as_u16();
    let ct = header_str(&resp, "content-type").map(str::to_string);
    match status {
        206 => {
            let cr = header_str(&resp, "content-range").and_then(parse_content_range);
            let (range, total) = cr.unwrap_or((None, None));
            {
                let mut st = entry.state.lock();
                st.range_ok = Some(true);
                if ct.is_some() {
                    st.content_type = ct;
                }
                if let Some(t) = total {
                    set_total(entry, &mut st, t);
                }
            }
            match range {
                Some((a, b)) if a == start => read_body(entry, mgr, resp, job.start, Some(b - a + 1), true),
                _ => Err(HttpError::Transient("unexpected Content-Range".into())),
            }
        }
        200 => {
            // Range ignored: the body is the whole file from byte 0.
            let len = resp.body().content_length();
            {
                let mut st = entry.state.lock();
                st.range_ok = Some(false);
                if ct.is_some() {
                    st.content_type = ct;
                }
                if let Some(t) = len {
                    set_total(entry, &mut st, t);
                }
            }
            read_body(entry, mgr, resp, 0, None, false)
        }
        416 => {
            let total = header_str(&resp, "content-range").and_then(parse_content_range).and_then(|c| c.1);
            let mut st = entry.state.lock();
            match total {
                Some(t) => {
                    set_total(entry, &mut st, t);
                    st.demand.retain(|&d| d * CHUNK_SIZE < t);
                    let became = !st.complete && st.all_present();
                    if became {
                        st.complete = true;
                    }
                    entry.cond.notify_all();
                    drop(st);
                    entry.after_progress(became);
                    Ok(Outcome::Progress)
                }
                None => Err(HttpError::Fatal("HTTP 416".into())),
            }
        }
        s => Err(classify_status(s)),
    }
}

/// Stream a response body into consecutive chunks starting at `first_chunk`.
fn read_body(
    entry: &Arc<Entry>,
    mgr: &super::CacheManager,
    resp: crate::http::Response,
    first_chunk: u64,
    limit: Option<u64>,
    preemptible: bool,
) -> Result<Outcome, HttpError> {
    let mut body = resp.into_body().into_reader();
    let mut buf = vec![0u8; CHUNK_SIZE as usize];
    let mut chunk = first_chunk;
    let mut fill = 0usize;
    let mut received: u64 = 0;
    let last_chunk = limit.map(|l| first_chunk + l.div_ceil(CHUNK_SIZE) - 1);
    loop {
        let total = entry.state.lock().total;
        let chunk_len = match total {
            Some(t) => (t.saturating_sub(chunk * CHUNK_SIZE)).min(CHUNK_SIZE) as usize,
            None => CHUNK_SIZE as usize,
        };
        if chunk_len == 0 {
            return Ok(Outcome::Progress);
        }
        let n = match body.read(&mut buf[fill..chunk_len]) {
            Ok(n) => n,
            Err(e) => return Err(HttpError::Transient(format!("read: {e}"))),
        };
        received += n as u64;
        fill += n;
        let eof = n == 0;
        if eof && fill == 0 {
            if total.is_none() {
                // Unknown-length body ended on a chunk boundary.
                let mut st = entry.state.lock();
                set_total(entry, &mut st, chunk * CHUNK_SIZE);
                let became = !st.complete && st.all_present();
                if became {
                    st.complete = true;
                }
                entry.cond.notify_all();
                drop(st);
                entry.after_progress(became);
            }
            return Ok(Outcome::Progress);
        }
        if eof && total.is_some() && fill < chunk_len {
            return Err(HttpError::Transient("connection closed early".into()));
        }
        if fill == chunk_len || eof {
            entry.write_at(&buf[..fill], chunk * CHUNK_SIZE).map_err(|e| HttpError::Fatal(format!("cache write: {e}")))?;
            let became = {
                let mut st = entry.state.lock();
                if st.total.is_none() && eof {
                    set_total(entry, &mut st, chunk * CHUNK_SIZE + fill as u64);
                }
                let was = st.complete;
                entry.mark_chunk(&mut st, chunk);
                entry.cond.notify_all();
                !was && st.complete
            };
            entry.after_progress(became);
            if became || eof {
                return Ok(Outcome::Progress);
            }
            if Some(chunk) == last_chunk || limit.is_some_and(|l| received >= l) {
                return Ok(Outcome::Progress);
            }
            chunk += 1;
            fill = 0;
            // Re-plan if a reader needs something else, or nobody needs us any more.
            let mut st = entry.state.lock();
            if entry.shutdown.load(Ordering::Relaxed) {
                return Ok(Outcome::Idle);
            }
            if entry.readers.load(Ordering::Acquire) > 0 {
                st.last_reader_seen = Instant::now();
            } else if st.last_reader_seen.elapsed() > mgr.idle_grace {
                return Ok(Outcome::Idle);
            }
            if preemptible {
                let outside = |d: u64| d < chunk || last_chunk.is_some_and(|l| d > l);
                if st.demand.iter().any(|&d| !st.has(d) && outside(d)) || st.has(chunk) {
                    return Ok(Outcome::Preempted);
                }
            }
        }
    }
}
