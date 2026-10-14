//! Small shared helpers: wall-clock time, dB conversion, thread priority.

use std::time::{SystemTime, UNIX_EPOCH};

/// Wall-clock time in microseconds since the Unix epoch.
#[inline]
pub fn epoch_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

/// Wall-clock time in milliseconds since the Unix epoch.
#[inline]
pub fn epoch_ms() -> f64 {
    epoch_us() as f64 / 1000.0
}

/// dB → linear amplitude. Anything at or below -120 dB is treated as silence.
#[inline]
pub fn db_to_lin(db: f32) -> f32 {
    if db <= -120.0 {
        0.0
    } else if db == 0.0 {
        1.0
    } else {
        (db * (std::f32::consts::LN_10 / 20.0)).exp()
    }
}

/// Linear amplitude → dB (floored at -120 dB).
#[inline]
pub fn lin_to_db(lin: f32) -> f32 {
    if lin <= 1e-6 {
        -120.0
    } else {
        20.0 * lin.log10()
    }
}

#[inline]
pub fn ms_to_frames(ms: f64, rate: u32) -> u64 {
    (ms.max(0.0) * rate as f64 / 1000.0).round() as u64
}

#[inline]
pub fn frames_to_ms(frames: u64, rate: u32) -> f64 {
    if rate == 0 {
        0.0
    } else {
        frames as f64 * 1000.0 / rate as f64
    }
}

/// Lower the calling thread's scheduling priority (background analysis / downloads).
pub fn set_low_priority() {
    #[cfg(target_os = "macos")]
    unsafe {
        let _ = libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
    #[cfg(target_os = "linux")]
    unsafe {
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
        let _ = libc::setpriority(libc::PRIO_PROCESS, tid, 10);
    }
}

/// Spawn a named thread, panicking only if the OS refuses to create threads at all.
pub fn spawn_named<F, T>(name: &str, f: F) -> std::thread::JoinHandle<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    std::thread::Builder::new().name(name.to_string()).spawn(f).expect("failed to spawn engine thread")
}

/// Stable short hash used for cache file names.
pub fn hash_key(key: &str) -> String {
    sha1_smol::Sha1::from(key.as_bytes()).digest().to_string()
}

/// Lower-cased file extension of a URL path or file path (no query string), if any.
pub fn extension_of(path_or_url: &str) -> Option<String> {
    let no_query = path_or_url.split(['?', '#']).next().unwrap_or(path_or_url);
    let last = no_query.rsplit('/').next().unwrap_or(no_query);
    let (_, ext) = last.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_roundtrip() {
        assert_eq!(db_to_lin(0.0), 1.0);
        assert!((db_to_lin(-6.0) - 0.501187).abs() < 1e-5);
        assert!((lin_to_db(db_to_lin(-12.5)) + 12.5).abs() < 1e-4);
        assert_eq!(db_to_lin(-200.0), 0.0);
    }

    #[test]
    fn ext() {
        assert_eq!(extension_of("https://x/a/01.%20Foo.mp3?x=1").as_deref(), Some("mp3"));
        assert_eq!(extension_of("/tmp/file.FLAC").as_deref(), Some("flac"));
        assert_eq!(extension_of("https://x/a/noext"), None);
    }
}
