//! Per-entry fetcher thread: fills the sparse cache file with bounded HTTP Range requests.
//!
//! - Every request has an end bound (never `bytes=N-`): some CDNs (googlevideo) throttle
//!   open-ended ranges to real time while serving bounded ones at full speed.
//! - Bytes are written to disk (and readers woken) as they arrive, not per 256 KB chunk.
//! - A response is read to its end whenever possible so ureq can pool the connection: the next
//!   request (and the next track from the same host) then skips TCP + TLS setup.
//! - A reader waiting for data outside the current response preempts it, unless finishing the
//!   response is quicker than opening a new connection would be.

use std::io::Read;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::{Entry, State, CHUNK_SIZE, PREFETCH_BYTES};
use crate::http::{classify_status, header_str, parse_content_range, HttpError};

/// Chunks per request when serving a blocked reader (1 MB): small enough that preempting or
/// finishing it is cheap when the reader jumps again (seeks, FLAC binary search).
const DEMAND_RUN: u64 = 4;
/// Chunks per request for read-ahead and background fill (8 MB): few requests per file, still
/// bounded (see the module docs) and short enough to time out a stalled connection.
const FILL_RUN: u64 = 32;
/// Body buffer; data reaches readers in pieces of at most this size.
const BUF: usize = 64 * 1024;

enum Outcome {
    Progress,
    Preempted,
    Idle,
}

struct Job {
    start: u64,
    n: u64,
}

/// What a request was made with (the entry's URL may change while it runs).
struct Snapshot {
    url: String,
    headers: Vec<(String, String)>,
    total: Option<u64>,
    range_ok: Option<bool>,
}

/// Time to the first byte of a response on a fresh connection (connect + TLS + request), the
/// cost of preempting a response. Starts pessimistic, then tracks the slowest recent request.
struct Latency(Duration);

impl Latency {
    fn observe(&mut self, d: Duration) {
        // Fresh connections are the slow ones; reused ones only pull the estimate down slowly.
        self.0 = if d > self.0 { d } else { (self.0 * 7 + d) / 8 };
    }
}

pub(super) fn run(entry: Arc<Entry>) {
    // Playback reads block on this thread's progress (cold starts, seeks past the cached range).
    crate::util::set_audio_feed_priority();
    let Some(mgr) = entry.manager() else {
        entry.state.lock().fetcher_running = false;
        return;
    };
    let http = mgr.http.clone();
    let mut attempt: u32 = 0;
    let mut latency = Latency(Duration::from_millis(300));
    loop {
        let (job, snap) = {
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
                Some(j) => (j, Snapshot { url: st.url.clone(), headers: st.headers.clone(), total: st.total, range_ok: st.range_ok }),
                None => {
                    // Nothing missing that we know of (shouldn't happen unless complete).
                    entry.cond.wait_for(&mut st, Duration::from_millis(200));
                    continue;
                }
            }
        };
        // A response that stalls (headers in, then nothing) must not hold the entry: it gives way
        // to a fresh URL, shutdown or the readers leaving as soon as they happen.
        let (e, url, grace) = (entry.clone(), snap.url.clone(), mgr.idle_grace);
        let result = crate::http::interruptible(move || superseded(&e, &url, grace), || fetch(&entry, &http, &mgr, job, &snap, &mut latency));
        {
            // Never leave a stale partial-chunk marker behind (readers would trust it).
            let mut st = entry.state.lock();
            st.partial = None;
        }
        match result {
            Ok(Outcome::Progress) | Ok(Outcome::Preempted) => attempt = 0,
            Ok(Outcome::Idle) => break,
            Err(HttpError::Fatal(m)) => {
                let mut st = entry.state.lock();
                if st.url != snap.url {
                    // The URL was replaced (re-resolved) while this request ran: try the new one.
                    continue;
                }
                if is_dead_status(&m) {
                    st.dead_urls.retain(|(u, _)| *u != snap.url);
                    st.dead_urls.push((snap.url.clone(), Instant::now()));
                }
                st.fatal = Some(m);
                entry.cond.notify_all();
                break;
            }
            Err(HttpError::Transient(m)) => {
                let mut st = entry.state.lock();
                if st.url != snap.url {
                    // Interrupted for (or failed just as there came) a new URL: try that at once.
                    attempt = 0;
                    continue;
                }
                attempt += 1;
                let backoff = Duration::from_millis((125u64 << attempt.min(5)).min(4000));
                st.last_error = Some(m);
                entry.cond.notify_all();
                let until = Instant::now() + backoff;
                while Instant::now() < until && !entry.shutdown.load(Ordering::Relaxed) && st.url == snap.url {
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

/// A request made for `url` is no longer wanted: the entry shuts down, its URL was replaced, or
/// nobody has read it for the idle grace.
fn superseded(entry: &Entry, url: &str, grace: Duration) -> bool {
    if entry.shutdown.load(Ordering::Relaxed) {
        return true;
    }
    let mut st = entry.state.lock();
    if entry.readers.load(Ordering::Acquire) > 0 {
        st.last_reader_seen = Instant::now();
    }
    st.url != url || st.last_reader_seen.elapsed() > grace
}

/// HTTP statuses that mean "this URL is gone" (expired / revoked / removed): a provider must
/// resolve a new one, retrying the same URL can't help.
fn is_dead_status(msg: &str) -> bool {
    matches!(msg, "HTTP 401" | "HTTP 403" | "HTTP 404" | "HTTP 410")
}

/// Pick what to fetch next: demanded chunks, then the prefetch window, then what background
/// readers wait for, then the rest of the file (forward from the read position first: upcoming
/// audio, e.g. the next chapters of a long video, before what was already played or skipped).
fn plan(st: &State, read_hint: u64) -> Option<Job> {
    let n_chunks = st.n_chunks();
    let in_range = |c: u64| n_chunks.is_none_or(|n| c < n);
    let h = read_hint / CHUNK_SIZE;
    let wanted = |list: &[u64]| list.iter().copied().find(|&d| !st.has(d) && in_range(d));
    let (start, max) = match wanted(&st.demand) {
        Some(d) => (d, DEMAND_RUN),
        None => {
            let s = st
                .first_missing(h, h + PREFETCH_BYTES / CHUNK_SIZE + 1)
                .or_else(|| wanted(&st.bg_demand))
                .or_else(|| st.first_missing(h, u64::MAX))
                .or_else(|| st.first_missing(0, h))?;
            (s, FILL_RUN)
        }
    };
    let mut n = 1;
    while n < max && in_range(start + n) && !st.has(start + n) {
        n += 1;
    }
    Some(Job { start, n })
}

/// Record the stream's total size. A different size than the one cached means the file behind
/// the key changed: the cached chunks belong to the old one and are dropped.
fn set_total(entry: &Entry, st: &mut State, total: u64) {
    if st.total == Some(total) {
        return;
    }
    if st.total.is_some() && st.present_count > 0 {
        st.bits.clear();
        st.present_count = 0;
        st.complete = false;
        st.partial = None;
        let _ = entry.file.set_len(0);
    }
    st.total = Some(total);
    st.meta_dirty = true;
    let _ = entry.file.set_len(total);
}

fn fetch(entry: &Arc<Entry>, http: &crate::http::Http, mgr: &super::CacheManager, job: Job, snap: &Snapshot, latency: &mut Latency) -> Result<Outcome, HttpError> {
    let (url, headers) = (&snap.url, &snap.headers);
    if snap.range_ok == Some(false) {
        // Server ignores Range: linear fill of the whole body. No deadline for all of it (it can
        // be long); a stall ends it all the same (`http::IDLE_TIMEOUT`, or `superseded`).
        let resp = http.get(url, headers, None, None)?;
        let status = resp.status().as_u16();
        if status != 200 {
            return Err(classify_status(status));
        }
        return read_body(entry, mgr, resp, 0, None, false, latency.0);
    }
    let start = job.start * CHUNK_SIZE;
    let mut end = start + job.n * CHUNK_SIZE - 1;
    if let Some(t) = snap.total {
        if t == 0 {
            let mut st = entry.state.lock();
            st.complete = true;
            entry.cond.notify_all();
            return Ok(Outcome::Progress);
        }
        end = end.min(t - 1);
    }
    let body_timeout = Duration::from_secs(20 + job.n * 8);
    let t0 = Instant::now();
    let resp = http.get(url, headers, Some((start, Some(end))), Some(body_timeout))?;
    latency.observe(t0.elapsed());
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
                Some((a, b)) if a == start && b >= a => read_body(entry, mgr, resp, job.start, Some(b - a + 1), true, latency.0),
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
            read_body(entry, mgr, resp, 0, None, false, latency.0)
        }
        416 => {
            let total = header_str(&resp, "content-range").and_then(parse_content_range).and_then(|c| c.1);
            let mut st = entry.state.lock();
            match total {
                Some(t) => {
                    set_total(entry, &mut st, t);
                    st.demand.retain(|&d| d * CHUNK_SIZE < t);
                    st.bg_demand.retain(|&d| d * CHUNK_SIZE < t);
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

/// Let ureq see the end of a fully received body so it returns the connection to its pool.
fn finish_body(body: &mut impl Read) {
    let mut probe = [0u8; 1];
    let _ = body.read(&mut probe);
}

/// Stream a response body into consecutive chunks starting at `first_chunk`, publishing each
/// piece as soon as it is on disk. `limit` is the body length for range responses.
#[allow(clippy::too_many_arguments)]
fn read_body(
    entry: &Arc<Entry>,
    mgr: &super::CacheManager,
    resp: crate::http::Response,
    first_chunk: u64,
    limit: Option<u64>,
    preemptible: bool,
    reconnect_cost: Duration,
) -> Result<Outcome, HttpError> {
    let mut body = resp.into_body().into_reader();
    let mut buf = vec![0u8; BUF];
    let mut chunk = first_chunk;
    let mut fill = 0u64;
    let mut received: u64 = 0;
    let last_chunk = limit.map(|l| first_chunk + l.div_ceil(CHUNK_SIZE) - 1);
    let mut first_byte: Option<Instant> = None;
    loop {
        let total = entry.state.lock().total;
        let chunk_len = match total {
            Some(t) => t.saturating_sub(chunk * CHUNK_SIZE).min(CHUNK_SIZE),
            None => CHUNK_SIZE,
        };
        if chunk_len == 0 || fill >= chunk_len {
            return Ok(Outcome::Progress);
        }
        let want = ((chunk_len - fill) as usize).min(BUF);
        let n = match body.read(&mut buf[..want]) {
            Ok(n) => n,
            Err(e) => return Err(HttpError::Transient(format!("read: {e}"))),
        };
        first_byte.get_or_insert_with(Instant::now);
        let eof = n == 0;
        if n > 0 {
            entry.write_at(&buf[..n], chunk * CHUNK_SIZE + fill).map_err(|e| HttpError::Fatal(format!("cache write: {e}")))?;
            fill += n as u64;
            received += n as u64;
        }
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
        let chunk_done = fill == chunk_len || eof;
        let response_done = limit.is_some_and(|l| received >= l);
        let mut st = entry.state.lock();
        if chunk_done {
            if st.total.is_none() && eof {
                set_total(entry, &mut st, chunk * CHUNK_SIZE + fill);
            }
            let was = st.complete;
            entry.mark_chunk(&mut st, chunk);
            st.partial = None;
            entry.cond.notify_all();
            let became = !was && st.complete;
            drop(st);
            entry.after_progress(became);
            if became || eof {
                return Ok(Outcome::Progress);
            }
            if Some(chunk) == last_chunk || response_done {
                finish_body(&mut body);
                return Ok(Outcome::Progress);
            }
            chunk += 1;
            fill = 0;
            st = entry.state.lock();
        } else {
            st.partial = Some((chunk, fill));
            st.last_progress = Instant::now();
            st.progress_gen += 1;
            if st.waiting > 0 {
                entry.cond.notify_all();
            }
        }
        // Re-plan if a reader needs something else, or nobody needs us any more.
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
            let wanted_elsewhere = st.demand.iter().any(|&d| !st.has(d) && outside(d));
            if wanted_elsewhere || (fill == 0 && st.has(chunk)) {
                // Finishing this response keeps the connection; dropping it costs a new one.
                let left = limit.map_or(u64::MAX, |l| l.saturating_sub(received));
                let elapsed = first_byte.map_or(Duration::ZERO, |t| t.elapsed()).as_secs_f64().max(1e-3);
                let rate = received as f64 / elapsed;
                let finish_secs = if rate > 0.0 { left as f64 / rate } else { f64::INFINITY };
                if !wanted_elsewhere || finish_secs > reconnect_cost.as_secs_f64() {
                    return Ok(Outcome::Preempted);
                }
            }
        }
    }
}
