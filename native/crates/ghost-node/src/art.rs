//! `processArt` / `artAccent`: the cover-art pipeline (`ghost-art`) behind promises.
//!
//! Work runs on a small dedicated pool (`ghost-art-N`, 2–3 threads), never on the JS thread or
//! libuv's pool (which `fs` and DNS share). The pool starts lazily on the first call, so loading
//! this addon in the renderer preload (for `AnalysisReader`) starts nothing.
//!
//! The JS thread does no per-byte work for the input: the pool reads the caller's Buffer in place
//! through a napi reference (held until the promise settles; callers must not mutate or transfer
//! it meanwhile, which `art-protocol.ts` never does), and a passthrough result hands that same
//! Buffer back as `data`. Only re-encoded output is copied into a V8-owned Buffer (Electron's
//! memory cage forbids external buffers).

// Only reachable through the generated N-API registrations, which test builds don't have.
#![cfg_attr(test, allow(dead_code))]

use std::sync::OnceLock;

use crossbeam_channel::{Receiver, Sender};
use ghost_art::{ArtOptions, ArtOutput, OutFormat};
use napi::bindgen_prelude::*;
use napi_derive::napi;

type Job = Box<dyn FnOnce() + Send + 'static>;

struct Pool {
    tx: Sender<Job>,
}

static POOL: OnceLock<Pool> = OnceLock::new();

/// Worker threads in the pool: 2, or 3 on machines with 8+ cores.
fn pool_size() -> usize {
    match std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) {
        0..=7 => 2,
        _ => 3,
    }
}

fn pool() -> &'static Pool {
    POOL.get_or_init(|| {
        let n = pool_size();
        let (tx, rx) = crossbeam_channel::unbounded::<Job>();
        for i in 0..n {
            let rx: Receiver<Job> = rx.clone();
            let _ = std::thread::Builder::new().name(format!("ghost-art-{i}")).spawn(move || {
                // Covers are user-visible but must never compete with the audio threads.
                #[cfg(target_os = "macos")]
                unsafe {
                    let _ = libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INITIATED, 0);
                }
                // Held for the worker's lifetime: dropping it would unregister the thread.
                let _cpu = ghost_engine::stats::register_thread("ghost-art");
                while let Ok(job) = rx.recv() {
                    job();
                }
            });
        }
        Pool { tx }
    })
}

/// Run `f` on the art pool and settle a promise with its result.
fn spawn<'env, T, F>(env: &'env Env, f: F) -> Result<Object<'env>>
where
    T: ToNapiValue + Send + 'static,
    F: FnOnce() -> std::result::Result<T, String> + Send + 'static,
{
    type Resolver<T> = Box<dyn FnOnce(Env) -> Result<T> + Send>;
    let (deferred, promise) = env.create_deferred::<T, Resolver<T>>()?;
    let job: Job = Box::new(move || {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            Ok(Ok(v)) => deferred.resolve(Box::new(move |_| Ok(v))),
            Ok(Err(e)) => deferred.reject(Error::new(Status::GenericFailure, e)),
            Err(_) => deferred.reject(Error::new(Status::GenericFailure, "art worker panicked".to_string())),
        }
    });
    if let Err(e) = pool().tx.send(job) {
        // Pool threads never exit while the process lives; this is unreachable in practice.
        (e.into_inner())();
    }
    Ok(promise)
}

/// Options for `processArt`. All optional.
#[napi(object)]
pub struct JsArtOptions {
    /// Largest output width in px (default: no limit). Never upscales.
    pub max_width: Option<f64>,
    /// Largest output height in px (default: no limit).
    pub max_height: Option<f64>,
    /// JPEG quality 1–100 (default 85).
    pub quality: Option<f64>,
    /// 'auto' (default: JPEG, or PNG when the image has transparency) | 'jpeg' | 'png' | 'webp' (lossless).
    pub format: Option<String>,
    /// Return the input unchanged when it needs no resize and is at most this many bytes (default 0: always re-encode).
    pub passthrough_max_bytes: Option<f64>,
    /// Compute the accent colour (default true).
    pub accent: Option<bool>,
}

fn dim(v: Option<f64>) -> u32 {
    match v {
        Some(x) if x.is_finite() && x >= 1.0 => x.min(ghost_art::MAX_DIMENSION as f64) as u32,
        _ => 0,
    }
}

fn options(o: Option<JsArtOptions>) -> Result<ArtOptions> {
    let o = o.unwrap_or(JsArtOptions {
        max_width: None,
        max_height: None,
        quality: None,
        format: None,
        passthrough_max_bytes: None,
        accent: None,
    });
    let format = match o.format.as_deref() {
        None => OutFormat::Auto,
        Some(s) => OutFormat::parse(s).ok_or_else(|| Error::new(Status::InvalidArg, format!("processArt: unknown format {s:?}")))?,
    };
    Ok(ArtOptions {
        max_width: dim(o.max_width),
        max_height: dim(o.max_height),
        quality: o.quality.filter(|q| q.is_finite()).map_or(85, |q| q.clamp(1.0, 100.0) as u8),
        format,
        passthrough_max_bytes: o.passthrough_max_bytes.filter(|b| b.is_finite() && *b > 0.0).map_or(0, |b| b as usize),
        accent: o.accent.unwrap_or(true),
    })
}

/// `{ data: Buffer, width, height, mime, accent: [r, g, b] | null, passthrough, sourceWidth,
/// sourceHeight, sourceMime, ms }`. Carries the input Buffer back to the JS thread: it is the
/// `data` of a passthrough result, and released there (not via a hop from the pool) otherwise.
pub struct JsArtResult {
    out: ArtOutput,
    input: Buffer,
}

impl ToNapiValue for JsArtResult {
    unsafe fn to_napi_value(raw_env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let JsArtResult { out: a, input } = val;
        let mut o = Object::new(&env)?;
        if a.passthrough {
            // Unchanged bytes: the caller's own Buffer object, no copy.
            o.set("data", input)?;
        } else {
            drop(input);
            // A V8-owned copy: Electron's memory cage forbids external buffers.
            let data = BufferSlice::copy_from(&env, &a.data)?;
            o.set("data", &data)?;
        }
        o.set("width", a.width)?;
        o.set("height", a.height)?;
        o.set("mime", a.mime)?;
        o.set("accent", a.accent.map(|c| c.map(u32::from).to_vec()))?;
        o.set("passthrough", a.passthrough)?;
        o.set("sourceWidth", a.source_width)?;
        o.set("sourceHeight", a.source_height)?;
        o.set("sourceMime", a.source_mime)?;
        let t = a.timings;
        o.set("ms", (t.decode_us + t.resize_us + t.encode_us + t.accent_us) as f64 / 1000.0)?;
        Ok(napi::JsValue::raw(&o))
    }
}

/// Accent result: `[r, g, b]` or `null`. Carries the input Buffer so its reference is released
/// on the JS thread.
pub struct JsAccent(Option<[u8; 3]>, Buffer);

impl ToNapiValue for JsAccent {
    unsafe fn to_napi_value(env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
        let JsAccent(accent, input) = val;
        drop(input);
        unsafe { ToNapiValue::to_napi_value(env, accent.map(|c| c.map(u32::from).to_vec())) }
    }
}

/// `processArt(bytes, opts?)`: decode (JPEG / PNG / WebP / GIF first frame), downscale to fit
/// `maxWidth`/`maxHeight` (never upscales), re-encode (JPEG, or PNG for transparent images) and
/// pick the accent colour, on the art pool. Rejects for corrupt or unsupported input.
/// `bytes` is read in place on the pool: don't mutate it until the promise settles.
#[napi(ts_return_type = "Promise<ArtResult>")]
pub fn process_art<'env>(env: &'env Env, bytes: Buffer, opts: Option<JsArtOptions>) -> Result<Object<'env>> {
    let opts = options(opts)?;
    spawn(env, move || {
        let r = ghost_art::process_keeping_input(&bytes, &opts);
        r.map(|out| JsArtResult { out, input: bytes }).map_err(|e| e.to_string())
    })
}

/// `artAccent(bytes)`: accent colour `[r, g, b]` (or `null` for greyscale art), on the art pool.
/// `bytes` is read in place: don't mutate it until the promise settles.
#[napi(ts_return_type = "Promise<[number, number, number] | null>")]
pub fn art_accent<'env>(env: &'env Env, bytes: Buffer) -> Result<Object<'env>> {
    spawn(env, move || {
        let r = ghost_art::accent_of(&bytes);
        r.map(|a| JsAccent(a, bytes)).map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_threads_stay_registered_for_cpu_stats() {
        // Every worker blocks in a job until all of them have one: then all are inside their
        // receive loop, past registration.
        let n = pool_size();
        let all_busy = std::sync::Arc::new(std::sync::Barrier::new(n + 1));
        let (done_tx, done_rx) = crossbeam_channel::unbounded();
        for _ in 0..n {
            let (b, done) = (all_busy.clone(), done_tx.clone());
            pool().tx.send(Box::new(move || {
                b.wait();
                let _ = done.send(());
            }))
            .unwrap();
        }
        all_busy.wait();
        for _ in 0..n {
            done_rx.recv().unwrap();
        }
        let stats = ghost_engine::stats::thread_cpu();
        let art = stats.iter().find(|t| t.name == "ghost-art").expect("ghost-art threads registered");
        assert_eq!(art.count as usize, n, "{stats:?}");
    }
}
