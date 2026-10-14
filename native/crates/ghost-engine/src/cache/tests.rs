//! Range cache tests against a local HTTP server.

use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::*;

#[derive(Clone, Copy)]
pub(crate) struct ServerOpts {
    pub range: bool,
    /// Sleep per 16 KB of body sent (throttling).
    pub per_16k_delay: Duration,
    /// Respond 503 to the first N requests.
    pub fail_first: usize,
    /// Never answer (stall) — headers are not sent.
    pub hang: bool,
    pub status: u16,
}

impl Default for ServerOpts {
    fn default() -> Self {
        Self { range: true, per_16k_delay: Duration::ZERO, fail_first: 0, hang: false, status: 200 }
    }
}

pub(crate) struct TestServer {
    pub url: String,
    pub requests: Arc<AtomicUsize>,
    pub range_requests: Arc<AtomicUsize>,
    pub bytes_sent: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

struct Throttled {
    data: Arc<Vec<u8>>,
    pos: usize,
    end: usize,
    delay: Duration,
    sent: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}

impl Read for Throttled {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.stop.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("server stopped"));
        }
        let n = buf.len().min(16 * 1024).min(self.end - self.pos);
        if n == 0 {
            return Ok(0);
        }
        if !self.delay.is_zero() {
            std::thread::sleep(self.delay);
        }
        buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
        self.pos += n;
        self.sent.fetch_add(n, Ordering::Relaxed);
        Ok(n)
    }
}

pub(crate) fn serve(data: Arc<Vec<u8>>, opts: ServerOpts) -> TestServer {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let requests = Arc::new(AtomicUsize::new(0));
    let range_requests = Arc::new(AtomicUsize::new(0));
    let bytes_sent = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (rq, rr, bs, st) = (requests.clone(), range_requests.clone(), bytes_sent.clone(), stop.clone());
    std::thread::spawn(move || {
        let server = Arc::new(server);
        while !st.load(Ordering::Relaxed) {
            let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(50)) else { continue };
            let n = rq.fetch_add(1, Ordering::Relaxed);
            let (data, rr, bs, st) = (data.clone(), rr.clone(), bs.clone(), st.clone());
            std::thread::spawn(move || {
                if opts.hang {
                    while !st.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    return;
                }
                if n < opts.fail_first {
                    let _ = req.respond(tiny_http::Response::empty(503));
                    return;
                }
                if opts.status != 200 {
                    let _ = req.respond(tiny_http::Response::empty(opts.status));
                    return;
                }
                let range = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Range"))
                    .and_then(|h| h.value.as_str().strip_prefix("bytes=").map(str::to_string));
                let len = data.len();
                let ct = tiny_http::Header::from_bytes("Content-Type", "audio/mpeg").unwrap();
                let (status, start, end, extra) = match (opts.range, range) {
                    (true, Some(r)) => {
                        rr.fetch_add(1, Ordering::Relaxed);
                        let (a, b) = r.split_once('-').unwrap();
                        let a: usize = a.parse().unwrap();
                        let b: usize = if b.is_empty() { len - 1 } else { b.parse::<usize>().unwrap().min(len - 1) };
                        if a >= len {
                            let h = tiny_http::Header::from_bytes("Content-Range", format!("bytes */{len}")).unwrap();
                            let _ = req.respond(tiny_http::Response::empty(416).with_header(h));
                            return;
                        }
                        let h = tiny_http::Header::from_bytes("Content-Range", format!("bytes {a}-{b}/{len}")).unwrap();
                        (206, a, b + 1, Some(h))
                    }
                    _ => (200, 0, len, None),
                };
                let body = Throttled { data, pos: start, end, delay: opts.per_16k_delay, sent: bs, stop: st };
                let mut headers = vec![ct];
                headers.extend(extra);
                let resp = tiny_http::Response::new(tiny_http::StatusCode(status), headers, body, Some(end - start), None);
                let _ = req.respond(resp);
            });
        }
    });
    TestServer { url: format!("http://127.0.0.1:{port}/track.mp3"), requests, range_requests, bytes_sent, stop }
}

pub(crate) fn test_data(len: usize, seed: u64) -> Arc<Vec<u8>> {
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    Arc::new(
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (x >> 24) as u8
            })
            .collect(),
    )
}

pub(crate) fn tmp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ghost-cache-test-{name}-{}-{}", std::process::id(), crate::util::epoch_us()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn spec(url: &str, key: &str) -> SourceSpec {
    SourceSpec::Http { url: url.to_string(), headers: vec![], cache_key: key.to_string(), format_hint: None }
}

#[test]
fn random_seeks_match_source() {
    let data = test_data(5 * 1024 * 1024 + 12_345, 1);
    let srv = serve(data.clone(), ServerOpts::default());
    let mgr = CacheManager::new_for_test(tmp_dir("seeks"), 1 << 30, Duration::from_secs(8));
    let mut r = mgr.open_reader(&spec(&srv.url, "seeks"), None).unwrap();
    let mut rng = 12345u64;
    let mut next = || {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        rng
    };
    let mut buf = vec![0u8; 100_000];
    for _ in 0..300 {
        let pos = next() % data.len() as u64;
        let len = (next() % 100_000) as usize + 1;
        r.seek(SeekFrom::Start(pos)).unwrap();
        let mut got = 0;
        while got < len {
            let n = r.read(&mut buf[got..len]).unwrap();
            if n == 0 {
                break;
            }
            got += n;
        }
        let expect = &data[pos as usize..(pos as usize + len).min(data.len())];
        assert_eq!(&buf[..got], expect, "mismatch at {pos}+{len}");
    }
    // Read past the end.
    r.seek(SeekFrom::End(0)).unwrap();
    assert_eq!(r.read(&mut buf).unwrap(), 0);
    assert_eq!(r.total_len(), Some(data.len() as u64));
    assert!(srv.range_requests.load(Ordering::Relaxed) > 0);
}

#[test]
fn missing_chunk_is_prioritised() {
    // 8 MB served at ~16 KB per 2 ms (~8 MB/s): a full linear fill would take ~1 s.
    let data = test_data(8 * 1024 * 1024, 2);
    let srv = serve(data.clone(), ServerOpts { per_16k_delay: Duration::from_millis(2), ..Default::default() });
    let mgr = CacheManager::new_for_test(tmp_dir("prio"), 1 << 30, Duration::from_secs(8));
    let mut r = mgr.open_reader(&spec(&srv.url, "prio"), None).unwrap();
    let mut buf = vec![0u8; 4096];
    r.read_exact(&mut buf).unwrap();
    assert_eq!(&buf[..], &data[..4096]);
    // Seek near the end: should be served by a priority range fetch, long before a linear fill.
    let pos = data.len() as u64 - 100_000;
    let t = Instant::now();
    r.seek(SeekFrom::Start(pos)).unwrap();
    r.read_exact(&mut buf).unwrap();
    let dt = t.elapsed();
    assert_eq!(&buf[..], &data[pos as usize..pos as usize + 4096]);
    assert!(!r.is_complete(), "file shouldn't be complete yet");
    assert!(dt < Duration::from_millis(500), "priority fetch took {dt:?}");
    let sent = srv.bytes_sent.load(Ordering::Relaxed);
    assert!(sent < data.len() * 3 / 4, "fetched {sent} bytes before serving the seek");
}

#[test]
fn background_fill_completes_and_emits_event() {
    let data = test_data(3 * 1024 * 1024 + 7, 3);
    let srv = serve(data.clone(), ServerOpts::default());
    let mgr = CacheManager::new_for_test(tmp_dir("complete"), 1 << 30, Duration::from_secs(8));
    let (tx, rx) = crossbeam_channel::unbounded();
    mgr.subscribe(tx);
    let r = mgr.open_reader(&spec(&srv.url, "complete"), None).unwrap();
    r.wait_header().unwrap();
    // Reader only touched chunk 0; the fetcher should fill the rest on its own.
    let ev = rx.recv_timeout(Duration::from_secs(10)).expect("no completion event");
    let CacheEvent::Complete { cache_key, path, bytes } = ev;
    assert_eq!(cache_key, "complete");
    assert_eq!(bytes, data.len() as u64);
    assert_eq!(std::fs::read(&path).unwrap(), *data);
    assert!(mgr.complete_path("complete").is_some());
}

#[test]
fn server_without_range_fills_linearly() {
    let data = test_data(2 * 1024 * 1024 + 99, 4);
    let srv = serve(data.clone(), ServerOpts { range: false, ..Default::default() });
    let mgr = CacheManager::new_for_test(tmp_dir("norange"), 1 << 30, Duration::from_secs(8));
    let mut r = mgr.open_reader(&spec(&srv.url, "norange"), None).unwrap();
    // Seek forward first: must still work (waits for the linear fill to get there).
    let pos = 1_500_000u64;
    r.seek(SeekFrom::Start(pos)).unwrap();
    let mut buf = vec![0u8; 10_000];
    r.read_exact(&mut buf).unwrap();
    assert_eq!(&buf[..], &data[pos as usize..pos as usize + 10_000]);
    r.seek(SeekFrom::Start(0)).unwrap();
    let mut all = Vec::new();
    r.read_to_end(&mut all).unwrap();
    assert_eq!(all, *data);
    assert_eq!(r.entry().state.lock().range_ok, Some(false));
    assert_eq!(srv.range_requests.load(Ordering::Relaxed), 0);
}

#[test]
fn transient_errors_are_retried() {
    let data = test_data(600_000, 5);
    let srv = serve(data.clone(), ServerOpts { fail_first: 2, ..Default::default() });
    let mgr = CacheManager::new_for_test(tmp_dir("retry"), 1 << 30, Duration::from_secs(8));
    let mut r = mgr.open_reader(&spec(&srv.url, "retry"), None).unwrap();
    let mut all = Vec::new();
    r.read_to_end(&mut all).unwrap();
    assert_eq!(all, *data);
    assert!(srv.requests.load(Ordering::Relaxed) >= 3);
}

#[test]
fn not_found_fails_fast() {
    let data = test_data(1000, 6);
    let srv = serve(data, ServerOpts { status: 404, ..Default::default() });
    let mgr = CacheManager::new_for_test(tmp_dir("404"), 1 << 30, Duration::from_secs(8));
    let r = mgr.open_reader(&spec(&srv.url, "404"), None).unwrap();
    let t = Instant::now();
    let err = r.wait_header().unwrap_err();
    assert!(err.to_string().contains("404"), "{err}");
    assert!(t.elapsed() < Duration::from_secs(2));
}

#[test]
fn stall_times_out() {
    let data = test_data(1000, 7);
    let srv = serve(data, ServerOpts { hang: true, ..Default::default() });
    let mgr = CacheManager::new_for_test(tmp_dir("stall"), 1 << 30, Duration::from_millis(800));
    let r = mgr.open_reader(&spec(&srv.url, "stall"), None).unwrap();
    let t = Instant::now();
    let err = r.wait_header().unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
    assert!(t.elapsed() >= Duration::from_millis(700) && t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
}

#[test]
fn sparse_entry_survives_reopen() {
    let data = test_data(4 * 1024 * 1024, 8);
    let dir = tmp_dir("reopen");
    let pos = 3 * 1024 * 1024 + 5;
    {
        let srv = serve(data.clone(), ServerOpts { per_16k_delay: Duration::from_millis(5), ..Default::default() });
        let mgr = CacheManager::new_for_test(dir.clone(), 1 << 30, Duration::from_secs(8));
        let mut r = mgr.open_reader(&spec(&srv.url, "reopen"), None).unwrap();
        r.seek(SeekFrom::Start(pos)).unwrap();
        let mut buf = vec![0u8; 1000];
        r.read_exact(&mut buf).unwrap();
        r.entry().stop();
    }
    std::thread::sleep(Duration::from_millis(300));
    // New manager, server that refuses everything: the cached chunk must still be readable.
    let srv = serve(data.clone(), ServerOpts { status: 404, ..Default::default() });
    let mgr = CacheManager::new_for_test(dir, 1 << 30, Duration::from_secs(8));
    let mut r = mgr.open_reader(&spec(&srv.url, "reopen"), None).unwrap();
    r.seek(SeekFrom::Start(pos)).unwrap();
    let mut buf = vec![0u8; 1000];
    r.read_exact(&mut buf).unwrap();
    assert_eq!(&buf[..], &data[pos as usize..pos as usize + 1000]);
    assert_eq!(r.total_len(), Some(data.len() as u64));
}

#[test]
fn lru_eviction_respects_cap_and_open_entries() {
    let dir = tmp_dir("evict");
    let mgr = CacheManager::new_for_test(dir.clone(), 2_000_000, Duration::from_secs(8));
    let datas: Vec<_> = (0..4).map(|i| test_data(900_000, 10 + i)).collect();
    let servers: Vec<_> = datas.iter().map(|d| serve(d.clone(), ServerOpts::default())).collect();
    let mut kept = None;
    for (i, srv) in servers.iter().enumerate() {
        let mut r = mgr.open_reader(&spec(&srv.url, &format!("e{i}")), None).unwrap();
        let mut all = Vec::new();
        r.read_to_end(&mut all).unwrap();
        assert_eq!(all, *datas[i]);
        if i == 0 {
            // Keep the first entry open: it must never be evicted.
            kept = Some(r);
        }
        // Make mtimes distinct for LRU ordering.
        std::thread::sleep(Duration::from_millis(30));
    }
    mgr.evict();
    let stats = mgr.stats();
    assert!(stats.bytes <= 2_000_000 + 1_000_000, "cache holds {} bytes", stats.bytes);
    assert!(mgr.complete_path("e0").is_some(), "open entry was evicted");
    assert!(mgr.complete_path("e3").is_some(), "most recent entry was evicted");
    assert!(mgr.complete_path("e1").is_none(), "LRU entry survived");
    drop(kept);
}
