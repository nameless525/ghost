//! Stream-cache bookkeeping costs with a populated cache directory (perf audit harness).
//! `cargo run --release -p ghost-engine --example cachebench -- [entries]`
use std::io::Read;
use std::time::Instant;

use ghost_engine::cache::CacheManager;
use ghost_engine::SourceSpec;

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(2000);
    let dir = std::env::temp_dir().join(format!("ghost-cachebench-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // A local "server" isn't needed: entries are created through the manager with a dead URL,
    // then given data files so they count towards the size.
    {
        let mgr = CacheManager::new(dir.clone(), 1 << 40, "bench").unwrap();
        for i in 0..n {
            let spec = SourceSpec::http(format!("http://127.0.0.1:9/{i}.mp3"), format!("k{i}"));
            let e = mgr.entry(&spec).unwrap();
            drop(e);
        }
    }
    for p in std::fs::read_dir(&dir).unwrap().flatten() {
        if p.path().extension().is_some_and(|e| e == "data") {
            std::fs::write(p.path(), vec![1u8; 64 * 1024]).unwrap();
        }
    }
    let mgr = CacheManager::new(dir.clone(), 1 << 40, "bench").unwrap();
    let t = Instant::now();
    let s = mgr.stats();
    println!("{} entries, {} MB: stats() (full scan incl. .meta reads, what every open used to do via evict) {:.1} ms", s.entries, s.bytes >> 20, t.elapsed().as_secs_f64() * 1000.0);
    let t = Instant::now();
    mgr.evict();
    println!("evict() (size + mtime scan only) {:.1} ms", t.elapsed().as_secs_f64() * 1000.0);
    let t = Instant::now();
    let spec = SourceSpec::http("http://127.0.0.1:9/new.mp3", "new");
    let e = mgr.entry(&spec).unwrap();
    println!("entry() for a new key (eviction now runs in the background) {:.2} ms", t.elapsed().as_secs_f64() * 1000.0);
    drop(e);
    let t = Instant::now();
    let p = mgr.complete_path("k5");
    println!("complete_path() lookup of a closed entry {:.3} ms ({p:?})", t.elapsed().as_secs_f64() * 1000.0);
    let _ = std::io::stdin().take(0).read(&mut [0u8; 0]);
    std::thread::sleep(std::time::Duration::from_millis(300));
    let _ = std::fs::remove_dir_all(&dir);
}
