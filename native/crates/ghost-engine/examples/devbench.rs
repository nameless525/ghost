//! Cost of one output-device enumeration (what the engine controller polls). Perf audit harness.
fn main() {
    let t = std::time::Instant::now();
    let d = ghost_engine::list_output_devices();
    println!("first: {:?} ({} devices)", t.elapsed(), d.len());
    let n = 50;
    let t = std::time::Instant::now();
    for _ in 0..n {
        std::hint::black_box(ghost_engine::list_output_devices());
    }
    println!("steady: {:?} per call", t.elapsed() / n);
}
