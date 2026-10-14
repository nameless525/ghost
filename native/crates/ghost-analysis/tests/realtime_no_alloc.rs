//! Proves the real-time hot path (`push_interleaved`, `compute`, `reset`) never touches the heap
//! once the analyzer is constructed. A counting global allocator records every allocation made
//! by this thread while the hot path runs.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::f32::consts::TAU;

use ghost_analysis::realtime::RealtimeAnalyzer;
use ghost_analysis::AnalysisFrame;

struct Counting;

thread_local! {
    static TRACKING: Cell<bool> = const { Cell::new(false) };
    static COUNT: Cell<usize> = const { Cell::new(0) };
}

fn note() {
    // `try_with` so allocations during thread teardown don't panic.
    let _ = TRACKING.try_with(|t| {
        if t.get() {
            let _ = COUNT.try_with(|c| c.set(c.get() + 1));
        }
    });
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        note();
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        note();
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        note();
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        note();
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn count_allocs(f: impl FnOnce()) -> usize {
    COUNT.with(|c| c.set(0));
    TRACKING.with(|t| t.set(true));
    f();
    TRACKING.with(|t| t.set(false));
    COUNT.with(|c| c.get())
}

#[test]
fn hot_path_does_not_allocate() {
    for sr in [44_100u32, 48_000, 96_000] {
        // Test input prepared up front (allocation here is fine).
        let block = 512usize;
        let stereo: Vec<f32> = (0..sr as usize * 2)
            .flat_map(|i| {
                let t = i as f32 / sr as f32;
                let x = 0.4 * (TAU * 220.0 * t).sin() + 0.2 * (TAU * 3300.0 * t).sin() + if i % 11_025 < 300 { 0.5 } else { 0.0 };
                [x, -x * 0.5]
            })
            .collect();
        let surround = vec![0.1f32; block * 6];

        let mut rt = RealtimeAnalyzer::new(sr);
        let mut frame = AnalysisFrame::default();

        // Sanity check: the allocator really is counting on this thread.
        assert!(count_allocs(|| drop(std::hint::black_box(vec![1u8; 64]))) > 0);

        let n = count_allocs(|| {
            for (i, chunk) in stereo.chunks(block * 2).enumerate() {
                rt.push_interleaved(chunk, 2);
                if i % 3 != 2 {
                    rt.compute(1.0 / 120.0, &mut frame);
                } else {
                    rt.compute(0.0, &mut frame); // repeated call with no new samples
                }
                if i == 40 {
                    rt.reset();
                }
            }
            rt.push_interleaved(&surround, 6);
            rt.push_interleaved(&stereo[..block], 1);
            rt.compute(1.0 / 60.0, &mut frame);
        });
        assert_eq!(n, 0, "{n} heap operations on the real-time hot path at {sr} Hz");
        assert!(frame.bands.iter().any(|&b| b > 0.0));
    }
}
