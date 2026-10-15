//! Audio output: cpal device streams and the offline null sink.
//!
//! The mixer is moved into the output callback. The callback computes the wall-clock time at
//! which its first frame will be heard from cpal's `OutputCallbackInfo` (playback − callback
//! instant = output latency) and passes it to the mixer, which stamps the audible clock.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use crossbeam_channel::Sender;

use crate::clock::Clock;
use crate::mixer::{Mixer, MAX_BLOCK};
use crate::stats::Stats;
use crate::util::epoch_us;
use crate::DeviceInfo;

/// Device error flags set from cpal's error callback.
pub const ERR_REBUILD: u32 = 1;
pub const ERR_XRUN: u32 = 2;

pub struct DeviceChoice {
    pub device: cpal::Device,
    pub config: cpal::SupportedStreamConfig,
    pub id: String,
    pub name: String,
}

pub struct OutputStream {
    _stream: cpal::Stream,
    pub device_id: String,
    pub device_name: String,
}

fn device_id(d: &cpal::Device) -> Option<String> {
    d.id().ok().map(|i| i.to_string())
}

fn device_name(d: &cpal::Device) -> String {
    d.description().map(|desc| desc.name().to_string()).unwrap_or_else(|_| device_id(d).unwrap_or_else(|| "Unknown device".into()))
}

pub fn list_devices() -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let default = host.default_output_device().as_ref().and_then(device_id);
    let mut out = Vec::new();
    if let Ok(devs) = host.output_devices() {
        for d in devs {
            let Some(id) = device_id(&d) else { continue };
            let is_default = default.as_deref() == Some(id.as_str());
            out.push(DeviceInfo { name: device_name(&d), id, is_default });
        }
    }
    out
}

/// Pick the output device: the requested id if present, else the system default.
pub fn choose_device(id: Option<&str>) -> Result<DeviceChoice, String> {
    let host = cpal::default_host();
    let mut device = None;
    if let Some(want) = id {
        if let Ok(devs) = host.output_devices() {
            device = devs.into_iter().find(|d| device_id(d).as_deref() == Some(want));
        }
    }
    let device = match device {
        Some(d) => d,
        None => host.default_output_device().ok_or_else(|| "no output device".to_string())?,
    };
    let config = device.default_output_config().map_err(|e| format!("output config: {e}"))?;
    let id = device_id(&device).unwrap_or_default();
    let name = device_name(&device);
    Ok(DeviceChoice { device, config, id, name })
}

/// Start a stream on `choice`, moving `mixer` into the callback.
pub fn start(choice: DeviceChoice, mixer: Box<Mixer>, clock: Arc<Clock>, err: Arc<AtomicU32>, stats: Arc<Stats>) -> Result<OutputStream, String> {
    let DeviceChoice { device, config, id, name } = choice;
    let rate = config.sample_rate();
    let channels = config.channels();
    // ~20 ms device buffer when the device allows it; latency is compensated anyway.
    let want = (rate / 50).next_power_of_two().clamp(256, 2048);
    let buffer_size = match config.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } if want >= *min && want <= *max => cpal::BufferSize::Fixed(want),
        _ => cpal::BufferSize::Default,
    };
    let stream_config = cpal::StreamConfig { channels, sample_rate: rate, buffer_size };
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => build::<f32>(&device, stream_config, mixer, clock, err, stats),
        cpal::SampleFormat::I16 => build::<i16>(&device, stream_config, mixer, clock, err, stats),
        cpal::SampleFormat::I32 => build::<i32>(&device, stream_config, mixer, clock, err, stats),
        cpal::SampleFormat::U16 => build::<u16>(&device, stream_config, mixer, clock, err, stats),
        other => return Err(format!("unsupported sample format {other:?}")),
    }
    .map_err(|e| format!("build stream: {e}"))?;
    stream.play().map_err(|e| format!("start stream: {e}"))?;
    Ok(OutputStream { _stream: stream, device_id: id, device_name: name })
}

fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut mixer: Box<Mixer>,
    clock: Arc<Clock>,
    err: Arc<AtomicU32>,
    stats: Arc<Stats>,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
{
    let ch = config.channels.max(1) as usize;
    let rate = config.sample_rate.max(1) as u64;
    let mut scratch = vec![0.0f32; MAX_BLOCK * 2];
    let silence = T::from_sample(0.0f32);
    let err_stats = stats.clone();
    let mut registered = false;
    let mut prev_start: Option<Instant> = None;
    // A mixer panic must not unwind into CoreAudio (that aborts the app): go silent and ask the
    // controller to rebuild the stream with a fresh mixer.
    let mut poisoned = false;
    let err_cb = err.clone();
    device.build_output_stream::<T, _, _>(
        config,
        move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
            let started = Instant::now();
            if !registered {
                // CPU accounting for the device's IO thread (never blocks; retried if busy).
                registered = crate::stats::try_register_foreign_thread("ghost-audio-out");
            }
            let ts = info.timestamp();
            let lat_us = ts.playback.checked_duration_since(ts.callback).map(|d| d.as_micros() as u64).unwrap_or(0);
            clock.latency_us.store(lat_us, Ordering::Relaxed);
            let epoch0 = epoch_us() + lat_us;
            let frames = data.len() / ch;
            if poisoned {
                data.fill(silence);
                return;
            }
            let mut off = 0;
            while off < frames {
                let n = (frames - off).min(MAX_BLOCK);
                let rendered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| mixer.render(&mut scratch[..n * 2], epoch0 + off as u64 * 1_000_000 / rate)));
                if rendered.is_err() {
                    poisoned = true;
                    err_cb.fetch_or(ERR_REBUILD, Ordering::Relaxed);
                    data.fill(silence);
                    return;
                }
                let dst = &mut data[off * ch..(off + n) * ch];
                let src = &scratch[..n * 2];
                if mixer.was_quiet() {
                    dst.fill(silence);
                } else if ch == 2 {
                    for (d, s) in dst.as_chunks_mut::<2>().0.iter_mut().zip(src.as_chunks::<2>().0) {
                        d[0] = T::from_sample(s[0]);
                        d[1] = T::from_sample(s[1]);
                    }
                } else if ch == 1 {
                    for (d, s) in dst.iter_mut().zip(src.as_chunks::<2>().0) {
                        *d = T::from_sample((s[0] + s[1]) * 0.5);
                    }
                } else {
                    for (d, s) in dst.chunks_exact_mut(ch).zip(src.as_chunks::<2>().0) {
                        d[0] = T::from_sample(s[0]);
                        d[1] = T::from_sample(s[1]);
                        d[2..].fill(silence);
                    }
                }
                off += n;
            }
            let took = started.elapsed().as_nanos() as u64;
            let period = frames as u64 * 1_000_000_000 / rate;
            stats.record_callback(took, period, prev_start.map(|p| started.duration_since(p).as_nanos() as u64));
            prev_start = Some(started);
        },
        move |e: cpal::Error| {
            let flag = match e.kind() {
                cpal::ErrorKind::Xrun => {
                    Stats::add(&err_stats.xruns, 1);
                    ERR_XRUN
                }
                _ => ERR_REBUILD,
            };
            err.fetch_or(flag, Ordering::Relaxed);
        },
        None,
    )
}

/// Offline null sink: drives the same mixer as fast as possible on its own thread, waiting for
/// decoders instead of underrunning, so renders are deterministic. Audio only flows while
/// something plays; the limiter's look-ahead delay is compensated and the stream is trimmed to
/// the exact end of the content (one block is held back until it's known to be needed).
pub struct NullOutput {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl NullOutput {
    pub fn start(mut mixer: Box<Mixer>, block: usize, sink: Sender<Vec<f32>>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let st = stop.clone();
        let block = block.clamp(16, 8192);
        let handle = crate::util::spawn_named("ghost-null-sink", move || {
            let latency = mixer.latency_frames();
            let mut active_since: Option<u64> = None;
            // Rendered but unsent output (interleaved), and stream frames sent this session.
            let mut pending: Vec<f32> = Vec::new();
            let mut skip = 0usize;
            let mut sent: u64 = 0;
            while !st.load(Ordering::Relaxed) {
                mixer.process_commands();
                let active = mixer.is_active();
                if !active {
                    if let Some(start) = active_since.take() {
                        // Flush the limiter delay line, then cut at the end of the content.
                        let mut buf = vec![0.0f32; latency * 2];
                        mixer.render(&mut buf, epoch_us());
                        let k = skip.min(latency);
                        pending.extend_from_slice(&buf[k * 2..]);
                        let content = mixer.content_end().saturating_sub(start).saturating_sub(sent);
                        pending.truncate((content as usize * 2).min(pending.len()));
                        if !pending.is_empty() && sink.send(std::mem::take(&mut pending)).is_err() {
                            break;
                        }
                        pending.clear();
                    }
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                }
                if active_since.is_none() {
                    active_since = Some(mixer.dev_frame());
                    skip = latency;
                    sent = 0;
                    pending.clear();
                }
                if !mixer.offline_ready(block) {
                    std::thread::sleep(Duration::from_micros(200));
                    continue;
                }
                let mut buf = vec![0.0f32; block * 2];
                mixer.render(&mut buf, epoch_us());
                let k = skip.min(block);
                skip -= k;
                pending.extend_from_slice(&buf[k * 2..]);
                // Hold back one block: it may turn out to be padding past the end.
                if pending.len() > block * 4 {
                    let n = pending.len() - block * 2;
                    let out: Vec<f32> = pending.drain(..n).collect();
                    sent += (out.len() / 2) as u64;
                    if sink.send(out).is_err() {
                        break;
                    }
                }
            }
        });
        Self { stop, handle: Some(handle) }
    }
}

impl Drop for NullOutput {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Output-device change notifications (default device switched, device added or removed), so
/// the controller doesn't have to enumerate devices on a timer. On macOS a CoreAudio property
/// listener (registered once per process, never removed) bumps a generation counter and wakes
/// subscribers; elsewhere `watching()` is false and the controller keeps polling.
pub mod device_watch {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};

    use crossbeam_channel::Sender;

    static GENERATION: AtomicU64 = AtomicU64::new(0);
    static SUBSCRIBERS: Mutex<Vec<Sender<()>>> = Mutex::new(Vec::new());

    /// Current change generation (compare with a remembered value).
    pub fn generation() -> u64 {
        GENERATION.load(Ordering::Acquire)
    }

    /// Wake `tx` on every change (dropped receivers are pruned).
    pub fn subscribe(tx: Sender<()>) {
        SUBSCRIBERS.lock().unwrap_or_else(|p| p.into_inner()).push(tx);
    }

    #[allow(dead_code)]
    fn changed() {
        GENERATION.fetch_add(1, Ordering::AcqRel);
        SUBSCRIBERS.lock().unwrap_or_else(|p| p.into_inner()).retain(|tx| !matches!(tx.try_send(()), Err(crossbeam_channel::TrySendError::Disconnected(_))));
    }

    /// Whether change notifications are active (registers the listener on first call).
    pub fn watching() -> bool {
        static OK: OnceLock<bool> = OnceLock::new();
        *OK.get_or_init(register)
    }

    #[cfg(target_os = "macos")]
    fn register() -> bool {
        use std::ffi::c_void;
        #[repr(C)]
        struct Address {
            selector: u32,
            scope: u32,
            element: u32,
        }
        type Listener = extern "C" fn(u32, u32, *const Address, *mut c_void) -> i32;
        #[link(name = "CoreAudio", kind = "framework")]
        extern "C" {
            fn AudioObjectAddPropertyListener(object: u32, address: *const Address, listener: Listener, client: *mut c_void) -> i32;
        }
        extern "C" fn on_change(_: u32, _: u32, _: *const Address, _: *mut c_void) -> i32 {
            // Runs on a CoreAudio notification thread (not the IO thread); must not unwind.
            let _ = std::panic::catch_unwind(changed);
            0
        }
        const SYSTEM_OBJECT: u32 = 1;
        const SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
        let mut ok = true;
        for selector in [u32::from_be_bytes(*b"dev#"), u32::from_be_bytes(*b"dOut")] {
            let addr = Address { selector, scope: SCOPE_GLOBAL, element: 0 };
            // SAFETY: valid address struct and a 'static listener with no client data.
            ok &= unsafe { AudioObjectAddPropertyListener(SYSTEM_OBJECT, &addr, on_change, std::ptr::null_mut()) } == 0;
        }
        ok
    }

    #[cfg(not(target_os = "macos"))]
    fn register() -> bool {
        false
    }
}
