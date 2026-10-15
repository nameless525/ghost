//! Engine CPU per thread class while idle / paused / playing muted (perf audit harness).
//! `cargo run --release -p ghost-engine --example idle -- <idle|paused|playing> [file] [secs]`
//! Uses the real output device; playing is muted (no sound).
use std::time::{Duration, Instant};

use ghost_engine::{Engine, EngineConfig, NormalizationMode, SourceSpec, TrackLoad};

fn main() {
    let mut a = std::env::args().skip(1);
    let mode = a.next().unwrap_or_else(|| "idle".into());
    let file = a.next();
    let secs: f64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(20.0);
    let dir = std::env::temp_dir().join(format!("ghost-idle-{}", std::process::id()));
    let e = Engine::new(EngineConfig { cache_dir: dir.join("cache"), cache_max_bytes: 1 << 30, user_agent: "bench".into() }).unwrap();
    e.set_muted(true);
    e.set_normalization(true, -16.0, NormalizationMode::Auto);
    if mode != "idle" {
        let f = file.expect("file");
        e.set_current(TrackLoad { id: "t".into(), source: SourceSpec::file(f), lufs: None, album_lufs: None, album_key: None, expected_duration_ms: None }, 0, mode == "playing");
    }
    // Let start-up work (device open, analysis of the file) settle, then measure.
    std::thread::sleep(Duration::from_secs(3));
    let before = e.stats(true);
    let t = Instant::now();
    println!("pid {} measuring {mode} for {secs} s", std::process::id());
    std::thread::sleep(Duration::from_secs_f64(secs));
    let after = e.stats(false);
    let wall = t.elapsed().as_secs_f64();
    let mut total = 0.0;
    for th in &after.threads {
        let b = before.threads.iter().find(|x| x.name == th.name).map_or(0.0, |x| x.cpu_ms);
        let d = th.cpu_ms - b;
        total += d;
        if d > 0.0005 * wall * 1000.0 {
            println!("  {:<22} x{:<2} {:7.3} ms/s", th.name, th.count, d / wall);
        }
    }
    println!("total engine threads: {:.3} ms/s ({:.3} % of one core); callbacks {} (avg {:.1} µs, max {:.1} µs of {:.0} µs) underruns {}", total / wall, total / wall / 10.0, after.callbacks, after.callback_avg_us, after.callback_max_us, after.callback_period_us, after.underruns);
    e.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}
