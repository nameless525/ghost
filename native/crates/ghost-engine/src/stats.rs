//! Engine health counters (underruns, xruns, output-callback load, decode-buffer low water) and
//! per-thread CPU accounting.
//!
//! Counters are plain relaxed atomics written from the RT callback / mixer (no locks, no
//! allocation). CPU accounting keeps a registry of engine threads (by class name); reading it
//! queries the kernel per thread (`thread_info` on macOS, `pthread_getcpuclockid` elsewhere), so
//! the threads themselves pay nothing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// A playing voice with less than this much decoded audio ahead counts as a low-water event.
pub const LOW_WATER_SEC: f32 = 0.5;
/// An output callback taking longer than this fraction of its buffer period is over budget.
pub const CALLBACK_BUDGET: f64 = 0.5;

#[derive(Default)]
pub struct Stats {
    /// The playing voice ran dry mid-playback (audible dropout / rebuffering).
    pub underruns: AtomicU64,
    /// Device-reported overloads (CoreAudio `kAudioDeviceProcessorOverload`, cpal `Xrun`).
    pub xruns: AtomicU64,
    pub callbacks: AtomicU64,
    /// Callbacks that took longer than `CALLBACK_BUDGET` of their buffer period.
    pub callback_over_budget: AtomicU64,
    /// Callbacks that started more than 1.5 buffer periods after the previous one.
    pub callback_gaps: AtomicU64,
    pub callback_max_ns: AtomicU64,
    pub callback_total_ns: AtomicU64,
    pub callback_period_ns: AtomicU64,
    /// Fewest decoded frames ahead of the playing voice (after it first filled), u64::MAX = none.
    pub low_water_frames: AtomicU64,
    /// Times the playing voice dropped below `LOW_WATER_SEC` of decoded audio (edge-triggered).
    pub low_water_events: AtomicU64,
    pub rate: AtomicU64,
}

/// Snapshot returned by `Engine::stats`.
#[derive(Clone, Debug, Default)]
pub struct StatsSnapshot {
    pub underruns: u64,
    pub xruns: u64,
    pub callbacks: u64,
    pub callback_over_budget: u64,
    pub callback_gaps: u64,
    pub callback_max_us: f64,
    pub callback_avg_us: f64,
    pub callback_period_us: f64,
    /// Lowest decoded audio ahead of the playing voice, in ms (None until something played).
    pub low_water_ms: Option<f64>,
    pub low_water_events: u64,
    /// CPU time per thread class since process start (or the class's first thread).
    pub threads: Vec<ThreadCpu>,
}

#[derive(Clone, Debug, Default)]
pub struct ThreadCpu {
    pub name: String,
    /// Live threads of this class.
    pub count: u32,
    /// User + system CPU time, including threads of this class that already exited.
    pub cpu_ms: f64,
}

impl Stats {
    pub fn new() -> Self {
        let s = Stats::default();
        s.low_water_frames.store(u64::MAX, Ordering::Relaxed);
        s
    }

    #[inline]
    pub fn add(c: &AtomicU64, n: u64) {
        c.fetch_add(n, Ordering::Relaxed);
    }

    /// RT-safe: record one output callback.
    #[inline]
    pub fn record_callback(&self, took_ns: u64, period_ns: u64, since_prev_ns: Option<u64>) {
        self.callbacks.fetch_add(1, Ordering::Relaxed);
        self.callback_total_ns.fetch_add(took_ns, Ordering::Relaxed);
        self.callback_max_ns.fetch_max(took_ns, Ordering::Relaxed);
        self.callback_period_ns.store(period_ns, Ordering::Relaxed);
        if took_ns as f64 > period_ns as f64 * CALLBACK_BUDGET {
            self.callback_over_budget.fetch_add(1, Ordering::Relaxed);
        }
        if since_prev_ns.is_some_and(|d| d > period_ns + period_ns / 2 + 1_000_000) {
            self.callback_gaps.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn snapshot(&self, reset: bool) -> StatsSnapshot {
        let take = |c: &AtomicU64| if reset { c.swap(0, Ordering::Relaxed) } else { c.load(Ordering::Relaxed) };
        let callbacks = take(&self.callbacks);
        let total = take(&self.callback_total_ns);
        let max = take(&self.callback_max_ns);
        let low = if reset { self.low_water_frames.swap(u64::MAX, Ordering::Relaxed) } else { self.low_water_frames.load(Ordering::Relaxed) };
        let rate = self.rate.load(Ordering::Relaxed).max(1);
        StatsSnapshot {
            underruns: take(&self.underruns),
            xruns: take(&self.xruns),
            callbacks,
            callback_over_budget: take(&self.callback_over_budget),
            callback_gaps: take(&self.callback_gaps),
            callback_max_us: max as f64 / 1000.0,
            callback_avg_us: if callbacks > 0 { total as f64 / callbacks as f64 / 1000.0 } else { 0.0 },
            callback_period_us: self.callback_period_ns.load(Ordering::Relaxed) as f64 / 1000.0,
            low_water_ms: (low != u64::MAX).then(|| low as f64 * 1000.0 / rate as f64),
            low_water_events: take(&self.low_water_events),
            threads: thread_cpu(),
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Per-thread CPU accounting

struct Entry {
    class: &'static str,
    handle: sys::Handle,
}

#[derive(Default)]
struct Registry {
    live: Vec<Entry>,
    /// CPU ns of threads that exited, per class.
    exited: HashMap<&'static str, u64>,
}

fn registry() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// Unregisters the calling thread on drop, keeping its CPU time in the class total.
pub struct ThreadGuard {
    handle: Option<sys::Handle>,
    class: &'static str,
}

impl Drop for ThreadGuard {
    fn drop(&mut self) {
        let Some(h) = self.handle.take() else { return };
        let ns = sys::self_cpu_ns().unwrap_or(0);
        let mut r = registry().lock().unwrap_or_else(|p| p.into_inner());
        r.live.retain(|e| !e.handle.same(&h));
        *r.exited.entry(self.class).or_default() += ns;
    }
}

/// Register the calling thread under `class` for CPU accounting until it exits. Threads that
/// live as long as the process can ignore the guard (`std::mem::forget` or keep it to the end).
pub fn register_thread(class: &'static str) -> ThreadGuard {
    let Some(h) = sys::current() else { return ThreadGuard { handle: None, class } };
    let mut r = registry().lock().unwrap_or_else(|p| p.into_inner());
    r.live.retain(|e| !e.handle.same(&h));
    r.live.push(Entry { class, handle: h.clone() });
    // Keep spare room so `try_register_foreign_thread` (called on the audio IO thread) never
    // reallocates.
    if r.live.capacity() - r.live.len() < 4 {
        r.live.reserve(16);
    }
    ThreadGuard { handle: Some(h), class }
}

/// Register a thread we don't control the lifetime of (the audio device's IO thread). Never
/// blocks and never allocates: gives up if the registry is busy or full (the caller retries
/// later). Returns true when done.
pub fn try_register_foreign_thread(class: &'static str) -> bool {
    let Some(h) = sys::current() else { return true };
    let Ok(mut r) = registry().try_lock() else { return false };
    if !r.live.iter().any(|e| e.handle.same(&h)) {
        if r.live.len() == r.live.capacity() {
            return false;
        }
        r.live.push(Entry { class, handle: h });
    }
    true
}

/// CPU time per thread class (dead foreign threads are dropped from the registry).
pub fn thread_cpu() -> Vec<ThreadCpu> {
    let mut r = registry().lock().unwrap_or_else(|p| p.into_inner());
    let mut by: Vec<ThreadCpu> = Vec::new();
    let mut add = |class: &str, ns: u64, live: u32| match by.iter_mut().find(|t| t.name == class) {
        Some(t) => {
            t.cpu_ms += ns as f64 / 1e6;
            t.count += live;
        }
        None => by.push(ThreadCpu { name: class.to_string(), count: live, cpu_ms: ns as f64 / 1e6 }),
    };
    let mut dead = Vec::new();
    for (i, e) in r.live.iter().enumerate() {
        match e.handle.cpu_ns() {
            Some(ns) => add(e.class, ns, 1),
            None => dead.push(i),
        }
    }
    for (class, ns) in &r.exited {
        add(class, *ns, 0);
    }
    for i in dead.into_iter().rev() {
        r.live.swap_remove(i);
    }
    by.sort_by(|a, b| a.name.cmp(&b.name));
    by
}

#[cfg(target_os = "macos")]
mod sys {
    /// Mach thread port plus the kernel's never-reused thread id (guards against port reuse).
    #[derive(Clone)]
    pub struct Handle {
        port: libc::mach_port_t,
        tid: u64,
    }

    impl Handle {
        pub fn same(&self, o: &Handle) -> bool {
            self.tid == o.tid
        }

        pub fn cpu_ns(&self) -> Option<u64> {
            // SAFETY: plain mach calls with correctly sized out-buffers; a stale port just fails.
            unsafe {
                let mut id: libc::thread_identifier_info = std::mem::zeroed();
                let mut n = (std::mem::size_of::<libc::thread_identifier_info>() / std::mem::size_of::<libc::integer_t>()) as libc::mach_msg_type_number_t;
                let kr = libc::thread_info(self.port, libc::THREAD_IDENTIFIER_INFO as _, &mut id as *mut _ as libc::thread_info_t, &mut n);
                if kr != libc::KERN_SUCCESS || id.thread_id != self.tid {
                    return None;
                }
                basic_cpu_ns(self.port)
            }
        }
    }

    unsafe fn basic_cpu_ns(port: libc::mach_port_t) -> Option<u64> {
        let mut info: libc::thread_basic_info = unsafe { std::mem::zeroed() };
        let mut n = libc::THREAD_BASIC_INFO_COUNT;
        let kr = unsafe { libc::thread_info(port, libc::THREAD_BASIC_INFO as _, &mut info as *mut _ as libc::thread_info_t, &mut n) };
        if kr != libc::KERN_SUCCESS {
            return None;
        }
        let t = |v: libc::time_value_t| v.seconds as u64 * 1_000_000_000 + v.microseconds as u64 * 1000;
        Some(t(info.user_time) + t(info.system_time))
    }

    pub fn current() -> Option<Handle> {
        // SAFETY: querying the calling thread.
        unsafe {
            let port = libc::pthread_mach_thread_np(libc::pthread_self());
            let mut tid = 0u64;
            if libc::pthread_threadid_np(libc::pthread_self(), &mut tid) != 0 {
                return None;
            }
            Some(Handle { port, tid })
        }
    }

    pub fn self_cpu_ns() -> Option<u64> {
        // SAFETY: the calling thread's own port is valid.
        unsafe { basic_cpu_ns(libc::pthread_mach_thread_np(libc::pthread_self())) }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod sys {
    #[derive(Clone)]
    pub struct Handle {
        clock: libc::clockid_t,
        tid: u64,
    }

    fn clock_ns(c: libc::clockid_t) -> Option<u64> {
        let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        // SAFETY: valid out-pointer.
        (unsafe { libc::clock_gettime(c, &mut ts) } == 0).then(|| ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64)
    }

    impl Handle {
        pub fn same(&self, o: &Handle) -> bool {
            self.tid == o.tid
        }
        pub fn cpu_ns(&self) -> Option<u64> {
            // A clock id of an exited thread fails (or, rarely, reads a reused id: tolerated).
            clock_ns(self.clock)
        }
    }

    pub fn current() -> Option<Handle> {
        let mut clock: libc::clockid_t = 0;
        // SAFETY: the calling thread.
        let ok = unsafe { libc::pthread_getcpuclockid(libc::pthread_self(), &mut clock) } == 0;
        ok.then(|| Handle { clock, tid: unsafe { libc::pthread_self() } as u64 })
    }

    pub fn self_cpu_ns() -> Option<u64> {
        clock_ns(libc::CLOCK_THREAD_CPUTIME_ID)
    }
}

#[cfg(windows)]
mod sys {
    use std::ffi::c_void;
    use std::sync::Arc;

    type Raw = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> Raw;
        fn GetCurrentThread() -> Raw;
        fn GetCurrentThreadId() -> u32;
        fn DuplicateHandle(src_process: Raw, src: Raw, dst_process: Raw, dst: *mut Raw, access: u32, inherit: i32, options: u32) -> i32;
        fn GetThreadTimes(thread: Raw, creation: *mut FileTime, exit: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn GetExitCodeThread(thread: Raw, code: *mut u32) -> i32;
        fn CloseHandle(h: Raw) -> i32;
    }
    const DUPLICATE_SAME_ACCESS: u32 = 2;
    const STILL_ACTIVE: u32 = 259;

    /// A real (duplicated) thread handle, closed when the last clone of its `Handle` goes.
    struct Owned(Raw);
    // SAFETY: a kernel handle value; the calls made with it are thread-safe.
    unsafe impl Send for Owned {}
    unsafe impl Sync for Owned {}
    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: this handle is ours and closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    #[derive(Clone)]
    pub struct Handle {
        h: Arc<Owned>,
        tid: u32,
    }

    /// User + kernel time of a thread in ns (FILETIME counts 100 ns).
    fn times_ns(h: Raw) -> Option<u64> {
        let (mut c, mut e, mut k, mut u) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
        // SAFETY: a valid thread handle and out-pointers.
        if unsafe { GetThreadTimes(h, &mut c, &mut e, &mut k, &mut u) } == 0 {
            return None;
        }
        let ns = |t: &FileTime| ((t.high as u64) << 32 | t.low as u64) * 100;
        Some(ns(&k) + ns(&u))
    }

    impl Handle {
        pub fn same(&self, o: &Handle) -> bool {
            self.tid == o.tid
        }
        pub fn cpu_ns(&self) -> Option<u64> {
            // As on the other platforms, an exited thread reads as gone (its handle would still answer).
            let mut code = 0u32;
            // SAFETY: a valid thread handle and out-pointer.
            if unsafe { GetExitCodeThread(self.h.0, &mut code) } == 0 || code != STILL_ACTIVE {
                return None;
            }
            times_ns(self.h.0)
        }
    }

    pub fn current() -> Option<Handle> {
        let mut h: Raw = std::ptr::null_mut();
        // SAFETY: turns the calling thread's pseudo-handle into a real one that we own.
        let ok = unsafe { DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &mut h, 0, 0, DUPLICATE_SAME_ACCESS) } != 0;
        // SAFETY: no preconditions.
        ok.then(|| Handle { h: Arc::new(Owned(h)), tid: unsafe { GetCurrentThreadId() } })
    }

    pub fn self_cpu_ns() -> Option<u64> {
        // SAFETY: the calling thread's pseudo-handle is always valid.
        times_ns(unsafe { GetCurrentThread() })
    }
}

#[cfg(not(any(unix, windows)))]
mod sys {
    #[derive(Clone)]
    pub struct Handle;
    impl Handle {
        pub fn same(&self, _o: &Handle) -> bool {
            false
        }
        pub fn cpu_ns(&self) -> Option<u64> {
            None
        }
    }
    pub fn current() -> Option<Handle> {
        None
    }
    pub fn self_cpu_ns() -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_cpu_counts_live_and_exited_threads() {
        let busy = |ms: u64| {
            let t = std::time::Instant::now();
            let mut x = 0u64;
            while t.elapsed().as_millis() < ms as u128 {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
            }
            std::hint::black_box(x);
        };
        // 60 ms of work: Windows counts thread time in ~15.6 ms scheduler ticks.
        std::thread::spawn(move || {
            let _g = register_thread("test-exited");
            busy(60);
        })
        .join()
        .unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
        let h = std::thread::spawn(move || {
            let _g = register_thread("test-live");
            busy(60);
            ready_tx.send(()).unwrap();
            let _ = rx.recv();
        });
        ready_rx.recv().unwrap();
        let t = thread_cpu();
        let exited = t.iter().find(|t| t.name == "test-exited").unwrap();
        let live = t.iter().find(|t| t.name == "test-live").unwrap();
        assert_eq!((exited.count, live.count), (0, 1));
        assert!(exited.cpu_ms > 15.0 && live.cpu_ms > 15.0, "{t:?}");
        tx.send(()).unwrap();
        h.join().unwrap();
        let t = thread_cpu();
        assert_eq!(t.iter().find(|t| t.name == "test-live").unwrap().count, 0);
    }

    #[test]
    fn callback_accounting() {
        let s = Stats::new();
        s.rate.store(48_000, Ordering::Relaxed);
        s.record_callback(1_000_000, 10_000_000, None);
        s.record_callback(6_000_000, 10_000_000, Some(10_000_000));
        s.record_callback(1_000_000, 10_000_000, Some(17_000_000));
        s.low_water_frames.fetch_min(24_000, Ordering::Relaxed);
        let snap = s.snapshot(true);
        assert_eq!((snap.callbacks, snap.callback_over_budget, snap.callback_gaps), (3, 1, 1));
        assert_eq!(snap.callback_max_us, 6000.0);
        assert!((snap.callback_avg_us - 2666.67).abs() < 0.1);
        assert_eq!(snap.low_water_ms, Some(500.0));
        let again = s.snapshot(false);
        assert_eq!((again.callbacks, again.low_water_ms), (0, None));
    }
}
