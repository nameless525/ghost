//! Engine latency benchmarks (perf audit harness; not part of the app).
//!
//! ```text
//! cargo run --release -p ghost-engine --example bench -- ttfa <src> [opts]   # engine: set_current → first rendered block
//! cargo run --release -p ghost-engine --example bench -- open <src> [opts]   # source path: open → 200 ms decoded (+ --seek-ms)
//! ```
//! Options: `-H "Name: value"` (repeatable), `--runs N`, `--cached` (file fully cached before
//! measuring), `--seek-ms MS` (open: also time a seek the way a decode worker does: re-open +
//! seek + 200 ms), `--next SRC` (ttfa: then switch to SRC on the same engine, warm connection),
//! `--sim RTT_MS:KBPS[:norange]` (serve a local file through a throttled local HTTP server that
//! models connection setup (2 RTT), request latency (1 RTT), TCP slow start and a bandwidth cap).
//!
//! Every run uses a fresh cache directory and a fresh engine / cache manager (cold connection
//! pool) unless noted.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ghost_engine::cache::CacheManager;
use ghost_engine::source::{self, OpenCtx};
use ghost_engine::{Engine, EngineConfig, EngineEvent, NormalizationMode, OfflineConfig, PlaybackState, SourceSpec, TrackLoad};

const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

struct Opts {
    cmd: String,
    src: String,
    headers: Vec<(String, String)>,
    runs: usize,
    cached: bool,
    seek_ms: Option<u64>,
    next: Option<String>,
    sim: Option<(u64, u64, bool)>,
    clip: Option<(u64, Option<u64>)>,
    /// ttfa: keep rendering this long after first audio and report the download/decode margin.
    hold: Option<f64>,
}

fn parse() -> Opts {
    let mut a = std::env::args().skip(1);
    let cmd = a.next().expect("command: ttfa | open");
    let src = a.next().expect("source");
    let mut o = Opts { cmd, src, headers: Vec::new(), runs: 3, cached: false, seek_ms: None, next: None, sim: None, clip: None, hold: None };
    while let Some(k) = a.next() {
        match k.as_str() {
            "-H" => {
                let h = a.next().unwrap();
                let (n, v) = h.split_once(':').expect("-H 'Name: value'");
                o.headers.push((n.trim().to_string(), v.trim().to_string()));
            }
            "--runs" => o.runs = a.next().unwrap().parse().unwrap(),
            "--cached" => o.cached = true,
            "--seek-ms" => o.seek_ms = Some(a.next().unwrap().parse().unwrap()),
            "--next" => o.next = Some(a.next().unwrap()),
            "--clip" => {
                let v = a.next().unwrap();
                let (s, e) = v.split_once(':').unwrap();
                o.clip = Some((s.parse().unwrap(), e.parse().ok()));
            }
            "--hold" => o.hold = Some(a.next().unwrap().parse().unwrap()),
            "--sim" => {
                let v = a.next().unwrap();
                let p: Vec<&str> = v.split(':').collect();
                o.sim = Some((p[0].parse().unwrap(), p[1].parse().unwrap(), p.get(2) == Some(&"norange")));
            }
            other => panic!("unknown option {other}"),
        }
    }
    o
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ghost-bench-{name}-{}-{}", std::process::id(), ghost_engine::util::epoch_us()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn spec(src: &str, headers: &[(String, String)], key_salt: &str, clip: Option<(u64, Option<u64>)>) -> SourceSpec {
    let s = spec_base(src, headers, key_salt);
    match clip {
        Some((a, b)) => s.with_extras(ghost_engine::SourceExtras { clip_start_ms: Some(a), clip_end_ms: b, ..Default::default() }),
        None => s,
    }
}

fn spec_base(src: &str, headers: &[(String, String)], key_salt: &str) -> SourceSpec {
    if src.starts_with("http://") || src.starts_with("https://") {
        let SourceSpec::Http { url, cache_key, format_hint, extras, .. } = SourceSpec::http(src, format!("{src}#{key_salt}")) else { unreachable!() };
        SourceSpec::Http { url, headers: headers.to_vec(), cache_key, format_hint, extras }
    } else {
        SourceSpec::file(src)
    }
}

fn prefill_cache(cache: &Arc<CacheManager>, s: &SourceSpec) {
    if let SourceSpec::Http { .. } = s {
        let mut r = cache.open_reader(s, None).unwrap();
        let mut buf = vec![0u8; 1 << 16];
        while r.read(&mut buf).unwrap() > 0 {}
        drop(r);
        let SourceSpec::Http { cache_key, .. } = s else { unreachable!() };
        let t0 = Instant::now();
        while cache.complete_path(cache_key).is_none() && t0.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.total_cmp(b));
    if v.is_empty() {
        return f64::NAN;
    }
    v[v.len() / 2]
}

fn track(id: &str, s: SourceSpec) -> TrackLoad {
    TrackLoad { id: id.into(), source: s, lufs: None, album_lufs: None, album_key: None, expected_duration_ms: None }
}

fn ttfa(o: &Opts, src: &str) {
    let mut firsts = Vec::new();
    let mut nexts = Vec::new();
    for run in 0..o.runs {
        let dir = scratch("ttfa");
        let cfg = EngineConfig { cache_dir: dir.join("cache"), cache_max_bytes: 4 << 30, user_agent: UA.into() };
        let s = spec(src, &o.headers, &format!("r{run}"), o.clip);
        if o.cached {
            let cache = CacheManager::new(cfg.cache_dir.clone(), cfg.cache_max_bytes, UA).unwrap();
            prefill_cache(&cache, &s);
        }
        let (engine, sink) = Engine::new_offline(cfg, OfflineConfig { sample_rate: 48_000, block_frames: 512 }).unwrap();
        engine.set_normalization(false, -16.0, NormalizationMode::Auto);
        let events = engine.events();
        std::thread::sleep(Duration::from_millis(50));
        let t0 = Instant::now();
        engine.set_current(track("a", s), 0, true);
        let first = loop {
            if sink.blocks.recv_timeout(Duration::from_millis(1)).is_ok() {
                break t0.elapsed();
            }
            while let Ok(ev) = events.try_recv() {
                if let EngineEvent::Error { message, .. } = ev {
                    panic!("error: {message}");
                }
            }
            assert!(t0.elapsed() < Duration::from_secs(30), "no audio after 30 s");
        };
        let ms = first.as_secs_f64() * 1000.0;
        firsts.push(ms);
        let mut line = format!("run {run}: first audio {ms:.1} ms");
        if let Some(h) = o.hold {
            // Audio rendered vs wall time after the start: < 1x means playback would rebuffer.
            let t1 = Instant::now();
            let mut frames = 0usize;
            let mut buffering = 0;
            while t1.elapsed().as_secs_f64() < h {
                if let Ok(b) = sink.blocks.recv_timeout(Duration::from_millis(5)) {
                    frames += b.len() / 2;
                }
                while let Ok(ev) = events.try_recv() {
                    match ev {
                        EngineEvent::Buffering { buffering: true, .. } => buffering += 1,
                        EngineEvent::Error { message, .. } => panic!("error: {message}"),
                        _ => {}
                    }
                }
            }
            let secs = frames as f64 / 48_000.0;
            line.push_str(&format!(", then {secs:.1} s of audio in {h:.1} s ({:.1}x realtime, {buffering} buffering events)", secs / h));
        }
        if let Some(n) = &o.next {
            // Drain, then switch tracks on the same engine (warm connection / TLS session).
            std::thread::sleep(Duration::from_millis(300));
            while events.try_recv().is_ok() {}
            let s2 = spec(n, &o.headers, &format!("next{run}"), None);
            let t1 = Instant::now();
            engine.set_current(track("b", s2), 0, true);
            let t = loop {
                while sink.blocks.try_recv().is_ok() {}
                match events.recv_timeout(Duration::from_millis(1)) {
                    Ok(EngineEvent::State { state: PlaybackState::Playing, id: Some(id) }) if id == "b" => break t1.elapsed(),
                    Ok(EngineEvent::Error { message, .. }) => panic!("error: {message}"),
                    _ => {}
                }
                assert!(t1.elapsed() < Duration::from_secs(30), "next: no audio after 30 s");
            };
            let ms = t.as_secs_f64() * 1000.0;
            nexts.push(ms);
            line.push_str(&format!(", next track playing after {ms:.1} ms (state event, +≤10 ms poll)"));
        }
        println!("{line}");
        engine.shutdown();
        drop(sink);
        let _ = std::fs::remove_dir_all(&dir);
    }
    println!("ttfa median {:.1} ms{}", median(&mut firsts), if nexts.is_empty() { String::new() } else { format!(", next median {:.1} ms", median(&mut nexts)) });
}

/// Read until `frames` frames are decoded.
fn read_frames(src: &mut dyn ghost_engine::AudioSource, frames: u64) -> u64 {
    let ch = src.channels().max(1);
    let mut buf = vec![0.0f32; 1024 * ch];
    let mut got = 0;
    while got < frames {
        let n = src.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        got += n as u64;
    }
    got
}

fn open_bench(o: &Opts, src: &str) {
    let (mut t_open, mut t_first, mut t_seek) = (Vec::new(), Vec::new(), Vec::new());
    for run in 0..o.runs {
        let dir = scratch("open");
        let cache = CacheManager::new(dir.join("cache"), 4 << 30, UA).unwrap();
        let s = spec(src, &o.headers, &format!("r{run}"), o.clip);
        if o.cached {
            prefill_cache(&cache, &s);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let ctx = OpenCtx { cache: &cache, cancel: cancel.clone(), accurate_seek: false, background: false };
        let t0 = Instant::now();
        let mut a = source::open(&s, &ctx).unwrap_or_else(|e| panic!("open: {}", e.message));
        let opened = t0.elapsed();
        let rate = a.sample_rate();
        read_frames(a.as_mut(), rate as u64 / 5);
        let first = t0.elapsed();
        let mut line = format!(
            "run {run}: open {:.1} ms, +200 ms decoded at {:.1} ms ({} Hz {} ch, dur {:?} s)",
            opened.as_secs_f64() * 1000.0,
            first.as_secs_f64() * 1000.0,
            rate,
            a.channels(),
            a.duration().map(|d| d / rate.max(1) as u64)
        );
        t_open.push(opened.as_secs_f64() * 1000.0);
        t_first.push(first.as_secs_f64() * 1000.0);
        if let Some(ms) = o.seek_ms {
            // What a seek costs a decode worker: a fresh open through the (shared) cache, the
            // seek, then 200 ms of audio.
            let t1 = Instant::now();
            let mut b = source::open(&s, &ctx).unwrap();
            let reopened = t1.elapsed();
            let reached = b.seek(ms * rate as u64 / 1000).unwrap();
            let seeked = t1.elapsed();
            read_frames(b.as_mut(), rate as u64 / 5);
            let done = t1.elapsed();
            line.push_str(&format!(
                "; seek to {ms} ms (landed {:.0} ms): reopen {:.1} + seek {:.1} + 200 ms {:.1} = {:.1} ms",
                reached as f64 * 1000.0 / rate as f64,
                reopened.as_secs_f64() * 1000.0,
                (seeked - reopened).as_secs_f64() * 1000.0,
                (done - seeked).as_secs_f64() * 1000.0,
                done.as_secs_f64() * 1000.0
            ));
            t_seek.push(done.as_secs_f64() * 1000.0);
        }
        println!("{line}");
        cancel.store(true, Ordering::Relaxed);
        drop(a);
        let _ = std::fs::remove_dir_all(&dir);
    }
    println!(
        "open median {:.1} ms, first 200 ms median {:.1} ms{}",
        median(&mut t_open),
        median(&mut t_first),
        if t_seek.is_empty() { String::new() } else { format!(", seek median {:.1} ms", median(&mut t_seek)) }
    );
}

/// Decode 20 s (from `--seek-ms`, if given) and print a hash of the samples, for comparing
/// decode paths bit for bit (e.g. a local file against the same file streamed).
fn hash_bench(o: &Opts, src: &str) {
    let dir = scratch("hash");
    let cache = CacheManager::new(dir.join("cache"), 4 << 30, UA).unwrap();
    let s = spec(src, &o.headers, "hash", o.clip);
    let ctx = OpenCtx { cache: &cache, cancel: Arc::new(AtomicBool::new(false)), accurate_seek: false, background: false };
    let mut a = source::open(&s, &ctx).unwrap_or_else(|e| panic!("open: {}", e.message));
    let rate = a.sample_rate() as u64;
    let mut landed = 0;
    if let Some(ms) = o.seek_ms {
        landed = a.seek(ms * rate / 1000).unwrap();
    }
    let ch = a.channels().max(1);
    let mut buf = vec![0.0f32; 4096 * ch];
    let (mut h, mut frames) = (0xcbf29ce484222325u64, 0u64);
    while frames < rate * 20 {
        let n = a.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        for v in &buf[..n * ch] {
            h = (h ^ v.to_bits() as u64).wrapping_mul(0x100000001b3);
        }
        frames += n as u64;
    }
    println!("hash {h:016x} frames {frames} landed {landed} dur {:?}", a.duration());
    let _ = std::fs::remove_dir_all(&dir);
}

// ------------------------------------------------------------------------------------------------
// Throttled local HTTP/1.1 server

struct Sim {
    data: Arc<Vec<u8>>,
    rtt: Duration,
    /// Bytes per second cap.
    bw: f64,
    range: bool,
    conns: AtomicU64,
    reqs: AtomicU64,
    bytes: AtomicU64,
}

fn sim_serve(sim: Arc<Sim>) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let sim = sim.clone();
            std::thread::spawn(move || sim_conn(sim, s));
        }
    });
    port
}

fn sim_conn(sim: Arc<Sim>, s: TcpStream) {
    sim.conns.fetch_add(1, Ordering::Relaxed);
    let _ = s.set_nodelay(true);
    // TCP + TLS handshakes.
    std::thread::sleep(sim.rtt * 2);
    let mut cwnd: f64 = 14_600.0;
    let mut r = BufReader::new(s.try_clone().unwrap());
    let mut w = s;
    loop {
        let mut range: Option<(u64, Option<u64>)> = None;
        let mut line = String::new();
        if r.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        loop {
            let mut h = String::new();
            if r.read_line(&mut h).unwrap_or(0) == 0 {
                return;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                if k.eq_ignore_ascii_case("range") && sim.range {
                    if let Some(spec) = v.trim().strip_prefix("bytes=") {
                        let (a, b) = spec.split_once('-').unwrap();
                        range = Some((a.parse().unwrap(), b.parse().ok()));
                    }
                }
            }
        }
        sim.reqs.fetch_add(1, Ordering::Relaxed);
        let len = sim.data.len() as u64;
        // Request → first byte.
        std::thread::sleep(sim.rtt);
        let (status, start, end) = match range {
            Some((a, _)) if a >= len => {
                let _ = write!(w, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\n\r\n");
                continue;
            }
            Some((a, b)) => (206, a, b.unwrap_or(len - 1).min(len - 1)),
            None => (200, 0, len - 1),
        };
        let mut head = format!("HTTP/1.1 {status} X\r\nContent-Type: audio/mpeg\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n", end - start + 1);
        if status == 206 {
            head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
        }
        head.push_str("\r\n");
        if w.write_all(head.as_bytes()).is_err() {
            return;
        }
        // Body: per RTT round send min(cwnd, bw * rtt) bytes; cwnd doubles each round (slow start).
        let mut pos = start;
        let rtt = sim.rtt.as_secs_f64().max(0.001);
        while pos <= end {
            let round = (cwnd.min(sim.bw * rtt) as u64).max(1460);
            let t_round = Instant::now();
            let round_end = (pos + round).min(end + 1);
            // Spread the round over the RTT in 4 KB writes.
            let total = round_end - pos;
            let mut sent = 0;
            while pos < round_end {
                let n = (round_end - pos).min(4096);
                if w.write_all(&sim.data[pos as usize..(pos + n) as usize]).is_err() {
                    return;
                }
                sim.bytes.fetch_add(n, Ordering::Relaxed);
                pos += n;
                sent += n;
                let due = Duration::from_secs_f64(rtt * sent as f64 / total as f64);
                if let Some(d) = due.checked_sub(t_round.elapsed()) {
                    std::thread::sleep(d);
                }
            }
            cwnd = (cwnd * 2.0).min(sim.bw * rtt * 1.5);
        }
    }
}

fn main() {
    let o = parse();
    let mut src = o.src.clone();
    let mut next = o.next.clone();
    let mut sim = None;
    if let Some((rtt, kbps, norange)) = o.sim {
        let data = Arc::new(std::fs::read(&o.src).expect("--sim serves a local file"));
        let s = Arc::new(Sim {
            data,
            rtt: Duration::from_millis(rtt),
            bw: kbps as f64 * 1000.0 / 8.0,
            range: !norange,
            conns: AtomicU64::new(0),
            reqs: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
        });
        let port = sim_serve(s.clone());
        let name = std::path::Path::new(&o.src).file_name().unwrap().to_string_lossy().replace(' ', "%20");
        src = format!("http://127.0.0.1:{port}/{name}");
        if next.is_some() {
            next = Some(format!("http://127.0.0.1:{port}/next-{name}"));
        }
        sim = Some(s);
    }
    let o = Opts { next, ..o };
    match o.cmd.as_str() {
        "ttfa" => ttfa(&o, &src),
        "open" => open_bench(&o, &src),
        "hash" => hash_bench(&o, &src),
        c => panic!("unknown command {c}"),
    }
    if let Some(s) = sim {
        println!(
            "sim server: {} connections, {} requests, {} KB sent",
            s.conns.load(Ordering::Relaxed),
            s.reqs.load(Ordering::Relaxed),
            s.bytes.load(Ordering::Relaxed) / 1024
        );
    }
    std::process::exit(0);
}
