//! `processArt` / `artAccent`: the cover-art pipeline (`ghost-art`) behind promises.
//!
//! Work runs on a small dedicated pool (`ghost-art-N`, 2–3 threads), never on the JS thread or
//! libuv's pool (which `fs` and DNS share). The pool starts lazily on the first call, so loading
//! this addon in the renderer preload (for `AnalysisReader`) starts nothing.

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

fn pool() -> &'static Pool {
    POOL.get_or_init(|| {
        let n = match std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) {
            0..=7 => 2,
            _ => 3,
        };
        let (tx, rx) = crossbeam_channel::unbounded::<Job>();
        for i in 0..n {
            let rx: Receiver<Job> = rx.clone();
            let _ = std::thread::Builder::new().name(format!("ghost-art-{i}")).spawn(move || {
                // Covers are user-visible but must never compete with the audio threads.
                #[cfg(target_os = "macos")]
                unsafe {
                    let _ = libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INITIATED, 0);
                }
                ghost_engine::stats::register_thread("ghost-art");
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
/// sourceHeight, sourceMime, ms }`
pub struct JsArtResult(ArtOutput);

impl ToNapiValue for JsArtResult {
    unsafe fn to_napi_value(raw_env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let a = val.0;
        let mut o = Object::new(&env)?;
        // A V8-owned copy: Electron's memory cage forbids external buffers.
        let data = BufferSlice::copy_from(&env, &a.data)?;
        o.set("data", &data)?;
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

/// Accent result: `[r, g, b]` or `null`.
pub struct JsAccent(Option<[u8; 3]>);

impl ToNapiValue for JsAccent {
    unsafe fn to_napi_value(env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
        unsafe { ToNapiValue::to_napi_value(env, val.0.map(|c| c.map(u32::from).to_vec())) }
    }
}

/// `processArt(bytes, opts?)`: decode (JPEG / PNG / WebP / GIF first frame), downscale to fit
/// `maxWidth`/`maxHeight` (never upscales), re-encode (JPEG, or PNG for transparent images) and
/// pick the accent colour, on the art pool. Rejects for corrupt or unsupported input.
#[napi(ts_return_type = "Promise<ArtResult>")]
pub fn process_art<'env>(env: &'env Env, bytes: BufferSlice, opts: Option<JsArtOptions>) -> Result<Object<'env>> {
    let opts = options(opts)?;
    let input = bytes.to_vec();
    spawn(env, move || ghost_art::process(&input, &opts).map(JsArtResult).map_err(|e| e.to_string()))
}

/// `artAccent(bytes)`: accent colour `[r, g, b]` (or `null` for greyscale art), on the art pool.
#[napi(ts_return_type = "Promise<[number, number, number] | null>")]
pub fn art_accent<'env>(env: &'env Env, bytes: BufferSlice) -> Result<Object<'env>> {
    let input = bytes.to_vec();
    spawn(env, move || ghost_art::accent_of(&input).map(JsAccent).map_err(|e| e.to_string()))
}
