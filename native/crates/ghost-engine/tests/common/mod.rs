#![allow(dead_code)]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ghost_engine::{Engine, EngineConfig, EngineEvent, NormalizationMode, OfflineConfig, OfflineSink, SourceSpec, TrackLoad};

pub fn tmp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ghost-it-{name}-{}-{}", std::process::id(), ghost_engine::util::epoch_us()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

pub fn config(dir: &Path) -> EngineConfig {
    EngineConfig { cache_dir: dir.join("cache"), cache_max_bytes: 1 << 30, user_agent: "ghost-test".into() }
}

/// Exponential sine sweep, L = sin, R = cos (so channels differ), amplitude `amp`.
pub fn sweep(rate: u32, frames: usize, f0: f64, f1: f64, amp: f32) -> Vec<f32> {
    let t_total = frames as f64 / rate as f64;
    let k = (f1 / f0).ln();
    let mut out = Vec::with_capacity(frames * 2);
    for i in 0..frames {
        let t = i as f64 / rate as f64;
        let phase = 2.0 * std::f64::consts::PI * f0 * t_total / k * ((t / t_total * k).exp() - 1.0);
        out.push((phase.sin() as f32) * amp);
        out.push((phase.cos() as f32) * amp);
    }
    out
}

pub fn file(path: &Path) -> SourceSpec {
    SourceSpec::File { path: path.to_path_buf(), format_hint: None }
}

pub fn track(id: &str, source: SourceSpec) -> TrackLoad {
    TrackLoad { id: id.into(), source, lufs: None, album_lufs: None, album_key: None, expected_duration_ms: None }
}

pub fn offline(dir: &Path, rate: u32) -> (Engine, OfflineSink) {
    let (e, s) = Engine::new_offline(config(dir), OfflineConfig { sample_rate: rate, block_frames: 512 }).unwrap();
    e.set_normalization(false, -16.0, NormalizationMode::Auto);
    (e, s)
}

/// Collect rendered audio until the engine reports `Ended` (and the limiter flush arrived).
pub fn collect_until_ended(engine: &Engine, sink: &OfflineSink, timeout: Duration) -> (Vec<f32>, Vec<EngineEvent>) {
    let events = engine.events();
    let mut audio = Vec::new();
    let mut evs = Vec::new();
    let t0 = Instant::now();
    let mut ended: Option<Instant> = None;
    loop {
        while let Ok(e) = events.try_recv() {
            if matches!(e, EngineEvent::Ended { .. }) {
                ended = Some(Instant::now());
            }
            evs.push(e);
        }
        match sink.blocks.recv_timeout(Duration::from_millis(20)) {
            Ok(b) => audio.extend_from_slice(&b),
            Err(_) => {
                if ended.is_some_and(|t| t.elapsed() > Duration::from_millis(300)) {
                    break;
                }
            }
        }
        assert!(t0.elapsed() < timeout, "render timed out; events: {evs:?}");
    }
    (audio, evs)
}

pub fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
}

/// Tiny HTTP file server with Range support; `delay_per_16k` throttles, `hang` never answers.
pub struct Server {
    pub url: String,
    stop: Arc<AtomicBool>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

struct Body {
    data: Arc<Vec<u8>>,
    pos: usize,
    end: usize,
    delay: Duration,
    stop: Arc<AtomicBool>,
}

impl Read for Body {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.stop.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("stopped"));
        }
        let n = buf.len().min(16 * 1024).min(self.end - self.pos);
        if n > 0 && !self.delay.is_zero() {
            std::thread::sleep(self.delay);
        }
        buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

pub fn serve(data: Vec<u8>, name: &str, delay_per_16k: Duration, hang: bool) -> Server {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let stop = Arc::new(AtomicBool::new(false));
    let st = stop.clone();
    let data = Arc::new(data);
    std::thread::spawn(move || {
        while !st.load(Ordering::Relaxed) {
            let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(50)) else { continue };
            let (data, st) = (data.clone(), st.clone());
            std::thread::spawn(move || {
                if hang {
                    while !st.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    return;
                }
                let len = data.len();
                let range = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Range"))
                    .and_then(|h| h.value.as_str().strip_prefix("bytes=").map(str::to_string));
                let (status, start, end, extra) = match range {
                    Some(r) => {
                        let (a, b) = r.split_once('-').unwrap();
                        let a: usize = a.parse().unwrap();
                        let b: usize = if b.is_empty() { len - 1 } else { b.parse::<usize>().unwrap().min(len - 1) };
                        let h = tiny_http::Header::from_bytes("Content-Range", format!("bytes {a}-{b}/{len}")).unwrap();
                        (206, a, b + 1, Some(h))
                    }
                    None => (200, 0, len, None),
                };
                let mut headers = vec![tiny_http::Header::from_bytes("Content-Type", "audio/wav").unwrap()];
                headers.extend(extra);
                let body = Body { data, pos: start, end, delay: delay_per_16k, stop: st };
                let _ = req.respond(tiny_http::Response::new(tiny_http::StatusCode(status), headers, body, Some(end - start), None));
            });
        }
    });
    Server { url: format!("http://127.0.0.1:{port}/{name}"), stop }
}
