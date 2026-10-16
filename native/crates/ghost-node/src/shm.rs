//! Shared-memory analysis channel: the engine (Electron main process) publishes the latest
//! real-time `AnalysisFrame` into a memory-mapped file; the renderer preload maps the same
//! file read-only and copies a consistent snapshot out on every animation frame. No IPC.
//!
//! # File layout (`ghost-analysis-<pid>.shm` in the OS temp dir, little-endian, 4096 bytes)
//!
//! ```text
//! offset  size  field
//! ------  ----  -------------------------------------------------------------------------
//!      0     4  magic        u32   = b"GHSM" (0x4D53_4847). Written LAST (release) at init.
//!      4     4  version      u32   = 1. Bump on any layout change.
//!      8     8  seq          u64   seqlock sequence: odd = write in progress, even = stable.
//!   -- payload (guarded by seq) ------------------------------------------------------------
//!     16   384  bands        [f32; 96]   log-spaced 30 Hz–16 kHz, smoothed, 0..1
//!    400  2048  waveform     [f32; 512]  latest mono samples, -1..1
//!   2448     4  rms          f32
//!   2452     4  peak         f32
//!   2456     4  onset        f32         spectral-flux onset strength, ~0..1
//!   2460     4  (padding)    u32         keeps position_ms 8-byte aligned
//!   2464     8  position_ms  f64         audible (latency-compensated) position of this frame
//!   2472     4  track_seq    u32         increments when the engine's current track changes
//!   2476     4  valid        u32         1 = frame present, 0 = nothing playing / shut down
//!   2480        (end of payload)
//!   -- writer state (outside the seqlock; added compatibly in v1, older writers leave it 0) ---
//!   2480     4  state        u32         0 = legacy (heartbeat only), 1 = active, 2 = parked,
//!                                        3 = closed
//!   2484     4  writer_pid   u32         publishing process
//!   2488        (rest of the 4096-byte file is zero)
//! ```
//!
//! # Protocol (single writer, any number of readers, cross-process)
//!
//! Every word is accessed through atomics (`AtomicU32`/`AtomicU64`, f32/f64 stored as bits)
//! so there are no data races even though readers may observe a write in progress.
//!
//! * Writer: `seq.store(s+1, Relaxed); fence(Release); <payload stores, Relaxed>;
//!   seq.store(s+2, Release)`.
//! * Reader: `s1 = seq.load(Acquire)` (retry if odd); `<payload loads, Relaxed>`;
//!   `fence(Acquire); s2 = seq.load(Relaxed)`; the copy is consistent iff `s1 == s2`.
//!
//! While audio plays, the publisher rewrites the region at ~200 Hz (the analysis hop rate), so
//! `seq` doubles as a heartbeat: a reader that sees `seq` frozen for longer than [`STALE_AFTER`]
//! while the state is `active` treats the region as stale (process hung) and reports none.
//! While nothing plays the publisher writes `valid = 0`, sets `state = parked` and sleeps until
//! audio flows again (no heartbeat, no wake-ups); readers then stay attached as long as the
//! writer process exists. On shutdown it sets `state = closed` before deleting the file, which
//! tells readers to reopen the path (a replacement engine publishes at the same path).

use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{fence, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ghost_engine::AnalysisFrame;
use memmap2::{Mmap, MmapMut};

pub use ghost_analysis::{NUM_BANDS, WAVEFORM_LEN};

pub const MAGIC: u32 = u32::from_le_bytes(*b"GHSM");
pub const VERSION: u32 = 1;

const OFF_MAGIC: usize = 0;
const OFF_VERSION: usize = 4;
const OFF_SEQ: usize = 8;
const OFF_BANDS: usize = 16;
const OFF_WAVE: usize = OFF_BANDS + NUM_BANDS * 4;
const OFF_RMS: usize = OFF_WAVE + WAVEFORM_LEN * 4;
const OFF_PEAK: usize = OFF_RMS + 4;
const OFF_ONSET: usize = OFF_PEAK + 4;
const OFF_POSITION: usize = OFF_ONSET + 8; // +4 padding
const OFF_TRACK_SEQ: usize = OFF_POSITION + 8;
const OFF_VALID: usize = OFF_TRACK_SEQ + 4;
pub const PAYLOAD_END: usize = OFF_VALID + 4;
const OFF_STATE: usize = PAYLOAD_END;
const OFF_PID: usize = OFF_STATE + 4;
pub const FILE_LEN: usize = 4096;

/// Writer states (`state` word; 0 = a writer that predates it, heartbeat semantics only).
pub const STATE_ACTIVE: u32 = 1;
pub const STATE_PARKED: u32 = 2;
pub const STATE_CLOSED: u32 = 3;
/// How often a reader of a parked region re-checks that the writer process still exists.
const PID_CHECK_EVERY: Duration = Duration::from_secs(2);

const _: () = {
    assert!(OFF_SEQ.is_multiple_of(8));
    assert!(OFF_BANDS == 16 && OFF_WAVE == 400 && OFF_RMS == 2448);
    assert!(OFF_POSITION == 2464 && OFF_POSITION.is_multiple_of(8));
    assert!(PAYLOAD_END == 2480 && OFF_PID + 4 <= FILE_LEN);
};

/// A reader reports the region as stale once `seq` has not moved for this long.
pub const STALE_AFTER: Duration = Duration::from_millis(750);

/// `ghost-analysis-<pid>.shm`; `ghost-analysis-<pid>-<n>.shm` for any additional engine alive
/// at the same time in one process (slot `n`).
pub fn region_path(instance: u32) -> PathBuf {
    let pid = std::process::id();
    let name = if instance == 0 {
        format!("ghost-analysis-{pid}.shm")
    } else {
        format!("ghost-analysis-{pid}-{instance}.shm")
    };
    std::env::temp_dir().join(name)
}

/// Best effort: delete region files left behind by GHOST processes that no longer exist.
pub fn sweep_orphans() {
    let Ok(dir) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let me = std::process::id();
    for entry in dir.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name
            .strip_prefix("ghost-analysis-")
            .and_then(|r| r.strip_suffix(".shm"))
        else {
            continue;
        };
        let Ok(pid) = rest.split('-').next().unwrap_or("").parse::<u32>() else {
            continue;
        };
        if pid != me && !process_alive(pid) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // kill(pid, 0): 0 => exists; EPERM => exists but not ours; ESRCH => gone.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    true // be conservative; the temp dir is cleaned by the OS eventually
}

#[inline]
fn u32_at<'a>(base: *const u8, off: usize) -> &'a AtomicU32 {
    debug_assert!(off.is_multiple_of(4) && off + 4 <= FILE_LEN);
    // SAFETY: `base` is a page-aligned mapping of at least FILE_LEN bytes that outlives every
    // use (callers hold the Mmap); offsets are 4-aligned. Shared memory is only ever touched
    // through atomics.
    unsafe { &*(base.add(off) as *const AtomicU32) }
}

#[inline]
fn u64_at<'a>(base: *const u8, off: usize) -> &'a AtomicU64 {
    debug_assert!(off.is_multiple_of(8) && off + 8 <= FILE_LEN);
    // SAFETY: as above, 8-aligned.
    unsafe { &*(base.add(off) as *const AtomicU64) }
}

/// Single writer. Lives on the publisher thread.
pub struct ShmWriter {
    map: MmapMut,
}

impl ShmWriter {
    pub fn create(path: &Path) -> io::Result<ShmWriter> {
        // Always a fresh inode: truncating a file another process still has mapped would
        // SIGBUS that reader. Readers of a replaced region see its heartbeat stop and reopen.
        match std::fs::remove_file(path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        let file = OpenOptions::new().read(true).write(true).create_new(true).open(path)?;
        file.set_len(FILE_LEN as u64)?;
        // SAFETY: we own the file; other processes only map it read-only and use atomics.
        let map = unsafe { MmapMut::map_mut(&file)? };
        let w = ShmWriter { map };
        let base = w.base();
        u32_at(base, OFF_VERSION).store(VERSION, Ordering::Relaxed);
        u64_at(base, OFF_SEQ).store(0, Ordering::Relaxed);
        u32_at(base, OFF_VALID).store(0, Ordering::Relaxed);
        u32_at(base, OFF_STATE).store(STATE_ACTIVE, Ordering::Relaxed);
        u32_at(base, OFF_PID).store(std::process::id(), Ordering::Relaxed);
        u32_at(base, OFF_MAGIC).store(MAGIC, Ordering::Release);
        Ok(w)
    }

    /// Announce the writer state (`STATE_ACTIVE` / `STATE_PARKED` / `STATE_CLOSED`).
    pub fn set_state(&self, state: u32) {
        u32_at(self.base(), OFF_STATE).store(state, Ordering::Release);
    }

    #[inline]
    fn base(&self) -> *const u8 {
        self.map.as_ptr()
    }

    /// Publish a frame (or "no frame" when `None`). Never blocks, never allocates.
    pub fn publish(&self, frame: Option<&AnalysisFrame>) {
        let base = self.base();
        let seq = u64_at(base, OFF_SEQ);
        let s = seq.load(Ordering::Relaxed); // sole writer
        seq.store(s.wrapping_add(1), Ordering::Relaxed);
        fence(Ordering::Release);
        match frame {
            Some(f) => {
                for (i, v) in f.bands.iter().enumerate() {
                    u32_at(base, OFF_BANDS + i * 4).store(v.to_bits(), Ordering::Relaxed);
                }
                for (i, v) in f.waveform.iter().enumerate() {
                    u32_at(base, OFF_WAVE + i * 4).store(v.to_bits(), Ordering::Relaxed);
                }
                u32_at(base, OFF_RMS).store(f.rms.to_bits(), Ordering::Relaxed);
                u32_at(base, OFF_PEAK).store(f.peak.to_bits(), Ordering::Relaxed);
                u32_at(base, OFF_ONSET).store(f.onset.to_bits(), Ordering::Relaxed);
                u64_at(base, OFF_POSITION).store(f.position_ms.to_bits(), Ordering::Relaxed);
                u32_at(base, OFF_TRACK_SEQ).store(f.track_seq, Ordering::Relaxed);
                u32_at(base, OFF_VALID).store(1, Ordering::Relaxed);
            }
            None => u32_at(base, OFF_VALID).store(0, Ordering::Relaxed),
        }
        seq.store(s.wrapping_add(2), Ordering::Release);
    }
}

/// A consistent snapshot copied out of the region.
pub struct Snapshot {
    pub bands: [f32; NUM_BANDS],
    pub waveform: [f32; WAVEFORM_LEN],
    pub rms: f32,
    pub peak: f32,
    pub onset: f32,
    pub position_ms: f64,
    pub track_seq: u32,
}

impl Default for Snapshot {
    fn default() -> Self {
        Snapshot {
            bands: [0.0; NUM_BANDS],
            waveform: [0.0; WAVEFORM_LEN],
            rms: 0.0,
            peak: 0.0,
            onset: 0.0,
            position_ms: 0.0,
            track_seq: 0,
        }
    }
}

/// Read-only view. Opening one never starts threads or touches the audio engine.
pub struct ShmReader {
    map: Mmap,
    last_seq: u64,
    last_change: Instant,
    last_pid_check: Option<(Instant, bool)>,
}

impl ShmReader {
    pub fn open(path: &Path) -> io::Result<ShmReader> {
        let file = OpenOptions::new().read(true).open(path)?;
        let len = file.metadata()?.len();
        if len < FILE_LEN as u64 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("analysis region too small ({len} bytes)"),
            ));
        }
        // SAFETY: read-only mapping; all accesses are atomic loads.
        let map = unsafe { Mmap::map(&file)? };
        Ok(ShmReader {
            map,
            last_seq: u64::MAX,
            last_change: Instant::now(),
            last_pid_check: None,
        })
    }

    /// Whether the writing process still exists (checked at most every `PID_CHECK_EVERY`).
    fn writer_alive(&mut self) -> bool {
        let now = Instant::now();
        if let Some((at, alive)) = self.last_pid_check {
            if now.duration_since(at) < PID_CHECK_EVERY {
                return alive;
            }
        }
        let pid = u32_at(self.map.as_ptr(), OFF_PID).load(Ordering::Relaxed);
        let alive = pid == 0 || pid == std::process::id() || process_alive(pid);
        self.last_pid_check = Some((now, alive));
        alive
    }

    /// Whether a publisher is actively updating this region (valid header, heartbeat moving).
    /// When false the region is orphaned (engine shut down / replaced) and should be reopened.
    pub fn alive(&mut self) -> bool {
        let base = self.map.as_ptr();
        if u32_at(base, OFF_MAGIC).load(Ordering::Acquire) != MAGIC
            || u32_at(base, OFF_VERSION).load(Ordering::Relaxed) != VERSION
        {
            return false;
        }
        let state = u32_at(base, OFF_STATE).load(Ordering::Acquire);
        if state == STATE_CLOSED {
            return false;
        }
        let s = u64_at(base, OFF_SEQ).load(Ordering::Acquire);
        let now = Instant::now();
        if s != self.last_seq {
            self.last_seq = s;
            self.last_change = now;
            return true;
        }
        if state == STATE_PARKED {
            // Idle publisher: no heartbeat by design.
            return self.writer_alive();
        }
        now.duration_since(self.last_change) <= STALE_AFTER
    }

    /// Copy the latest frame into `out`. Returns false when there is no valid, fresh frame
    /// (wrong magic/version, nothing playing, writer mid-update for too long, or stale).
    pub fn read(&mut self, out: &mut Snapshot) -> bool {
        let base = self.map.as_ptr();
        if u32_at(base, OFF_MAGIC).load(Ordering::Acquire) != MAGIC
            || u32_at(base, OFF_VERSION).load(Ordering::Relaxed) != VERSION
        {
            return false;
        }
        let seq = u64_at(base, OFF_SEQ);
        for attempt in 0..256u32 {
            let s1 = seq.load(Ordering::Acquire);
            if s1 & 1 == 1 {
                if attempt > 32 {
                    std::thread::yield_now();
                } else {
                    std::hint::spin_loop();
                }
                continue;
            }
            let valid = u32_at(base, OFF_VALID).load(Ordering::Relaxed);
            if valid == 1 {
                for (i, v) in out.bands.iter_mut().enumerate() {
                    *v = f32::from_bits(u32_at(base, OFF_BANDS + i * 4).load(Ordering::Relaxed));
                }
                for (i, v) in out.waveform.iter_mut().enumerate() {
                    *v = f32::from_bits(u32_at(base, OFF_WAVE + i * 4).load(Ordering::Relaxed));
                }
                out.rms = f32::from_bits(u32_at(base, OFF_RMS).load(Ordering::Relaxed));
                out.peak = f32::from_bits(u32_at(base, OFF_PEAK).load(Ordering::Relaxed));
                out.onset = f32::from_bits(u32_at(base, OFF_ONSET).load(Ordering::Relaxed));
                out.position_ms = f64::from_bits(u64_at(base, OFF_POSITION).load(Ordering::Relaxed));
                out.track_seq = u32_at(base, OFF_TRACK_SEQ).load(Ordering::Relaxed);
            }
            fence(Ordering::Acquire);
            if seq.load(Ordering::Relaxed) != s1 {
                continue; // torn; retry
            }
            let now = Instant::now();
            if s1 != self.last_seq {
                self.last_seq = s1;
                self.last_change = now;
            } else if now.duration_since(self.last_change) > STALE_AFTER {
                return false;
            }
            return valid == 1;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(k: f32) -> AnalysisFrame {
        let mut f = AnalysisFrame::default();
        for (i, b) in f.bands.iter_mut().enumerate() {
            *b = k + i as f32;
        }
        for (i, w) in f.waveform.iter_mut().enumerate() {
            *w = -k - i as f32;
        }
        f.rms = k;
        f.peak = k * 2.0;
        f.onset = k * 3.0;
        f.position_ms = k as f64 * 1000.5;
        f.track_seq = k as u32;
        f
    }

    #[test]
    fn round_trip_and_validity() {
        let path = std::env::temp_dir().join(format!("ghost-analysis-test-{}.shm", std::process::id()));
        let w = ShmWriter::create(&path).unwrap();
        let mut r = ShmReader::open(&path).unwrap();
        let mut s = Snapshot::default();
        w.publish(None);
        assert!(!r.read(&mut s));
        w.publish(Some(&frame(7.0)));
        assert!(r.read(&mut s));
        assert_eq!(s.bands[95], 7.0 + 95.0);
        assert_eq!(s.waveform[511], -7.0 - 511.0);
        assert_eq!(
            (s.rms, s.peak, s.onset, s.position_ms, s.track_seq),
            (7.0, 14.0, 21.0, 7003.5, 7)
        );
        w.publish(None);
        assert!(!r.read(&mut s));
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn parked_region_stays_alive_without_heartbeat_and_closed_does_not() {
        let path = std::env::temp_dir().join(format!("ghost-analysis-test3-{}.shm", std::process::id()));
        let w = ShmWriter::create(&path).unwrap();
        let mut r = ShmReader::open(&path).unwrap();
        let mut s = Snapshot::default();
        w.publish(None);
        assert!(r.alive());
        // Active writer that stops publishing goes stale…
        r.last_change = Instant::now() - STALE_AFTER - Duration::from_millis(10);
        assert!(!r.alive());
        // …a parked one does not (no heartbeat while idle, by design).
        w.set_state(STATE_PARKED);
        assert!(r.alive());
        assert!(!r.read(&mut s));
        // Waking up: frames flow again.
        w.set_state(STATE_ACTIVE);
        w.publish(Some(&frame(3.0)));
        assert!(r.read(&mut s) && r.alive());
        assert_eq!(s.rms, 3.0);
        // Closed: readers must reopen.
        w.publish(None);
        w.set_state(STATE_CLOSED);
        assert!(!r.alive());
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn concurrent_reads_are_never_torn() {
        let path = std::env::temp_dir().join(format!("ghost-analysis-test2-{}.shm", std::process::id()));
        let w = ShmWriter::create(&path).unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop2 = stop.clone();
        let writer = std::thread::spawn(move || {
            let mut k = 1.0f32;
            while !stop2.load(Ordering::Relaxed) {
                w.publish(Some(&frame(k)));
                k += 1.0;
            }
        });
        let mut r = ShmReader::open(&path).unwrap();
        let mut s = Snapshot::default();
        let mut good = 0;
        let t0 = Instant::now();
        // At least 300 ms of reads, and on until 100 were consistent: against a writer publishing
        // flat out, a busy CI machine lets far fewer through in 300 ms (20 s only guards a hang).
        while (t0.elapsed() < Duration::from_millis(300) || good < 100) && t0.elapsed() < Duration::from_secs(20) {
            if r.read(&mut s) {
                let k = s.rms;
                assert_eq!(s.track_seq, k as u32);
                assert_eq!(s.bands[0], k);
                assert_eq!(s.bands[95], k + 95.0);
                assert_eq!(s.waveform[300], -k - 300.0);
                assert_eq!(s.position_ms, k as f64 * 1000.5);
                good += 1;
            }
        }
        stop.store(true, Ordering::Relaxed);
        writer.join().unwrap();
        assert!(good >= 100, "only {good} consistent reads");
        std::fs::remove_file(&path).unwrap();
    }
}
