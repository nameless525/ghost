//! JS <-> Rust conversions. Shapes match `src/main/engine/types.ts` exactly (camelCase fields,
//! `type` discriminant on events, `null` for absent values).

use std::collections::HashMap;
use std::path::PathBuf;

use ghost_engine::{
    DeviceInfo, DownloadStatus, EngineEvent, LoopMode, NormalizationMode, OfflineAnalysis, PlaybackState, PositionInfo,
    SourceSpec, TagInfo, TrackInfo, TrackLoad,
};
use napi::bindgen_prelude::*;
use napi::JsValue;
use napi_derive::napi;

// ---------------------------------------------------------------------------------------------
// Inputs

#[napi(object)]
pub struct JsEngineConfig {
    pub cache_dir: String,
    pub cache_max_bytes: f64,
    pub user_agent: String,
}

/// Reads an optional property that may be absent, `undefined` or `null` (TS `x?: T | null`).
fn opt<T: FromNapiValue>(o: &Object, ctx: &str, name: &str) -> Result<Option<T>> {
    o.get::<Option<T>>(name)
        .map(Option::flatten)
        .map_err(|e| invalid(format!("{ctx}.{name}: {}", e.reason)))
}

fn req<T: FromNapiValue>(o: &Object, ctx: &str, name: &str) -> Result<T> {
    opt(o, ctx, name)?.ok_or_else(|| invalid(format!("{ctx}.{name} is required")))
}

unsafe fn as_object<'a>(env: napi::sys::napi_env, v: napi::sys::napi_value, ctx: &str) -> Result<Object<'a>> {
    unsafe { Object::from_napi_value(env, v) }.map_err(|_| invalid(format!("{ctx} must be an object")))
}

/// `EngineSource`: `{ kind: 'http', url, headers?, cacheKey, formatHint? } | { kind: 'file', path, formatHint? }`
pub struct JsEngineSource {
    pub kind: String,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub cache_key: Option<String>,
    pub format_hint: Option<String>,
    pub path: Option<String>,
}

impl FromNapiValue for JsEngineSource {
    unsafe fn from_napi_value(env: napi::sys::napi_env, v: napi::sys::napi_value) -> Result<Self> {
        const C: &str = "source";
        let o = unsafe { as_object(env, v, C)? };
        Ok(JsEngineSource {
            kind: req(&o, C, "kind")?,
            url: opt(&o, C, "url")?,
            headers: opt(&o, C, "headers")?,
            cache_key: opt(&o, C, "cacheKey")?,
            format_hint: opt(&o, C, "formatHint")?,
            path: opt(&o, C, "path")?,
        })
    }
}

/// `EngineTrack`
pub struct JsEngineTrack {
    pub id: String,
    pub source: JsEngineSource,
    pub lufs: Option<f64>,
    pub album_lufs: Option<f64>,
    pub album_key: Option<String>,
    pub expected_duration_ms: Option<f64>,
}

impl FromNapiValue for JsEngineTrack {
    unsafe fn from_napi_value(env: napi::sys::napi_env, v: napi::sys::napi_value) -> Result<Self> {
        const C: &str = "track";
        let o = unsafe { as_object(env, v, C)? };
        Ok(JsEngineTrack {
            id: req(&o, C, "id")?,
            source: req(&o, C, "source")?,
            lufs: opt(&o, C, "lufs")?,
            album_lufs: opt(&o, C, "albumLufs")?,
            album_key: opt(&o, C, "albumKey")?,
            expected_duration_ms: opt(&o, C, "expectedDurationMs")?,
        })
    }
}

/// `TagInfo`
pub struct JsTagInfo {
    pub title: String,
    pub album: String,
    pub album_artist: Option<String>,
    pub artist: Option<String>,
    pub composer: Option<String>,
    pub track_number: Option<u32>,
    pub track_total: Option<u32>,
    pub disc_number: Option<u32>,
    pub year: Option<u32>,
    pub genre: Option<String>,
    pub comment: Option<String>,
    pub cover_url: Option<String>,
    pub replay_gain_track_db: Option<f64>,
    pub replay_gain_track_peak: Option<f64>,
}

impl FromNapiValue for JsTagInfo {
    unsafe fn from_napi_value(env: napi::sys::napi_env, v: napi::sys::napi_value) -> Result<Self> {
        const C: &str = "tags";
        let o = unsafe { as_object(env, v, C)? };
        Ok(JsTagInfo {
            title: opt(&o, C, "title")?.unwrap_or_default(),
            album: opt(&o, C, "album")?.unwrap_or_default(),
            album_artist: opt(&o, C, "albumArtist")?,
            artist: opt(&o, C, "artist")?,
            composer: opt(&o, C, "composer")?,
            track_number: opt(&o, C, "trackNumber")?,
            track_total: opt(&o, C, "trackTotal")?,
            disc_number: opt(&o, C, "discNumber")?,
            year: opt(&o, C, "year")?,
            genre: opt(&o, C, "genre")?,
            comment: opt(&o, C, "comment")?,
            cover_url: opt(&o, C, "coverUrl")?,
            replay_gain_track_db: opt(&o, C, "replayGainTrackDb")?,
            replay_gain_track_peak: opt(&o, C, "replayGainTrackPeak")?,
        })
    }
}

fn invalid(msg: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, msg.into())
}

/// JS numbers -> non-negative integer milliseconds (NaN/negative -> 0).
pub fn ms(v: f64) -> u64 {
    if v.is_finite() && v > 0.0 {
        v.round() as u64
    } else {
        0
    }
}

fn opt_ms(v: Option<f64>) -> Option<u64> {
    v.filter(|x| x.is_finite() && *x >= 0.0).map(|x| x.round() as u64)
}

fn opt_f32(v: Option<f64>) -> Option<f32> {
    v.filter(|x| x.is_finite()).map(|x| x as f32)
}

pub fn source_from_js(s: JsEngineSource) -> Result<SourceSpec> {
    match s.kind.as_str() {
        "http" => {
            let url = s.url.ok_or_else(|| invalid("http source requires `url`"))?;
            let mut headers: Vec<(String, String)> = s.headers.unwrap_or_default().into_iter().collect();
            headers.sort();
            let cache_key = s.cache_key.filter(|k| !k.is_empty()).unwrap_or_else(|| url.clone());
            Ok(SourceSpec::Http {
                url,
                headers,
                cache_key,
                format_hint: s.format_hint,
            })
        }
        "file" => {
            let path = s.path.ok_or_else(|| invalid("file source requires `path`"))?;
            Ok(SourceSpec::File {
                path: PathBuf::from(path),
                format_hint: s.format_hint,
            })
        }
        other => Err(invalid(format!(
            "unknown source kind '{other}' (expected 'http' or 'file')"
        ))),
    }
}

pub fn track_from_js(t: JsEngineTrack) -> Result<TrackLoad> {
    Ok(TrackLoad {
        id: t.id,
        source: source_from_js(t.source)?,
        lufs: opt_f32(t.lufs),
        album_lufs: opt_f32(t.album_lufs),
        album_key: t.album_key,
        expected_duration_ms: opt_ms(t.expected_duration_ms),
    })
}

pub fn tags_from_js(t: JsTagInfo) -> TagInfo {
    TagInfo {
        title: t.title,
        album: t.album,
        album_artist: t.album_artist,
        artist: t.artist,
        composer: t.composer,
        track_number: t.track_number,
        track_total: t.track_total,
        disc_number: t.disc_number,
        year: t.year,
        genre: t.genre,
        comment: t.comment,
        cover_url: t.cover_url,
        replay_gain_track_db: opt_f32(t.replay_gain_track_db),
        replay_gain_track_peak: opt_f32(t.replay_gain_track_peak),
    }
}

pub fn loop_mode(s: &str) -> Result<LoopMode> {
    match s {
        "album" => Ok(LoopMode::Album),
        "endless" => Ok(LoopMode::Endless),
        "custom" => Ok(LoopMode::Custom),
        other => Err(invalid(format!(
            "unknown loop mode '{other}' (expected 'album' | 'endless' | 'custom')"
        ))),
    }
}

pub fn normalization_mode(s: &str) -> Result<NormalizationMode> {
    match s {
        "auto" => Ok(NormalizationMode::Auto),
        "track" => Ok(NormalizationMode::Track),
        "album" => Ok(NormalizationMode::Album),
        other => Err(invalid(format!(
            "unknown normalization mode '{other}' (expected 'auto' | 'track' | 'album')"
        ))),
    }
}

// ---------------------------------------------------------------------------------------------
// Outputs

#[napi(object, use_nullable = true)]
pub struct JsEnginePosition {
    pub id: Option<String>,
    pub position_ms: f64,
    pub duration_ms: Option<f64>,
    pub playing: bool,
    pub at: f64,
}

impl From<PositionInfo> for JsEnginePosition {
    fn from(p: PositionInfo) -> Self {
        JsEnginePosition {
            id: p.id,
            position_ms: p.position_ms,
            duration_ms: p.duration_ms.map(|d| d as f64),
            playing: p.playing,
            at: p.at_epoch_ms,
        }
    }
}

#[napi(object)]
pub struct JsDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

impl From<DeviceInfo> for JsDeviceInfo {
    fn from(d: DeviceInfo) -> Self {
        JsDeviceInfo {
            id: d.id,
            name: d.name,
            is_default: d.is_default,
        }
    }
}

/// `OfflineAnalysisResult`.
#[napi(object, use_nullable = true)]
pub struct JsOfflineAnalysis {
    pub integrated_lufs: Option<f64>,
    pub loudness_range: Option<f64>,
    pub true_peak_db: Option<f64>,
    pub bpm: Option<f64>,
    pub bpm_confidence: f64,
    pub beats: Vec<f64>,
    pub downbeats: Vec<f64>,
    pub kiai: Vec<Vec<f64>>,
    pub energy: Vec<f64>,
    pub intensity: Option<f64>,
    pub duration_ms: f64,
}

/// f32 -> the f64 with the same shortest decimal form (0.1f32 -> 0.1, not 0.10000000149…),
/// so values stored in the DB/UI look like what the analyzer computed.
fn tidy(v: f32) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    v.to_string().parse().unwrap_or(v as f64)
}

fn tidy_opt(v: Option<f32>) -> Option<f64> {
    v.filter(|x| x.is_finite()).map(tidy)
}

impl From<OfflineAnalysis> for JsOfflineAnalysis {
    fn from(a: OfflineAnalysis) -> Self {
        JsOfflineAnalysis {
            integrated_lufs: tidy_opt(a.integrated_lufs),
            loudness_range: tidy_opt(a.loudness_range),
            true_peak_db: tidy_opt(a.true_peak_db),
            bpm: tidy_opt(a.bpm),
            bpm_confidence: tidy(a.bpm_confidence),
            beats: a.beats.into_iter().map(tidy).collect(),
            downbeats: a.downbeats.into_iter().map(tidy).collect(),
            kiai: a.kiai.into_iter().map(|(s, e)| vec![tidy(s), tidy(e)]).collect(),
            energy: a.energy.into_iter().map(tidy).collect(),
            intensity: tidy_opt(a.intensity),
            duration_ms: a.duration_ms as f64,
        }
    }
}

fn state_str(s: PlaybackState) -> &'static str {
    match s {
        PlaybackState::Idle => "idle",
        PlaybackState::Loading => "loading",
        PlaybackState::Playing => "playing",
        PlaybackState::Paused => "paused",
        PlaybackState::Buffering => "buffering",
    }
}

fn download_status_str(s: DownloadStatus) -> &'static str {
    match s {
        DownloadStatus::Progress => "progress",
        DownloadStatus::Done => "done",
        DownloadStatus::Error => "error",
        DownloadStatus::Canceled => "canceled",
    }
}

fn path_str(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

/// An `EngineEvent` on its way to JS; becomes a plain object of the TS `EngineEvent` union.
pub struct JsEvent(pub EngineEvent);

impl JsEvent {
    /// Events the TS union has no shape for (a newer engine variant) are dropped.
    pub fn is_known(ev: &EngineEvent) -> bool {
        matches!(
            ev,
            EngineEvent::State { .. }
                | EngineEvent::Advanced { .. }
                | EngineEvent::Ended { .. }
                | EngineEvent::TrackInfo(_)
                | EngineEvent::Buffering { .. }
                | EngineEvent::Error { .. }
                | EngineEvent::Analysis { .. }
                | EngineEvent::CacheComplete { .. }
                | EngineEvent::Download { .. }
                | EngineEvent::Devices(_)
                | EngineEvent::PreviewEnded
        )
    }
}

impl ToNapiValue for JsEvent {
    unsafe fn to_napi_value(raw_env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
        let env = Env::from_raw(raw_env);
        let mut o = Object::new(&env)?;
        #[allow(unreachable_patterns)]
        match val.0 {
            EngineEvent::State { state, id } => {
                o.set("type", "state")?;
                o.set("state", state_str(state))?;
                o.set("id", id)?;
            }
            EngineEvent::Advanced { id } => {
                o.set("type", "advanced")?;
                o.set("id", id)?;
            }
            EngineEvent::Ended { id } => {
                o.set("type", "ended")?;
                o.set("id", id)?;
            }
            EngineEvent::TrackInfo(TrackInfo {
                id,
                duration_ms,
                sample_rate,
                channels,
                codec,
                bitrate_kbps,
            }) => {
                o.set("type", "trackInfo")?;
                o.set("id", id)?;
                o.set("durationMs", duration_ms.map(|d| d as f64))?;
                o.set("sampleRate", sample_rate)?;
                o.set("channels", channels as u32)?;
                o.set("codec", codec)?;
                o.set("bitrateKbps", bitrate_kbps)?;
            }
            EngineEvent::Buffering { id, buffering } => {
                o.set("type", "buffering")?;
                o.set("id", id)?;
                o.set("buffering", buffering)?;
            }
            EngineEvent::Error {
                id,
                message,
                recoverable,
            } => {
                o.set("type", "error")?;
                o.set("id", id)?;
                o.set("message", message)?;
                o.set("recoverable", recoverable)?;
            }
            EngineEvent::Analysis { id, cache_key, result } => {
                o.set("type", "analysis")?;
                o.set("id", id)?;
                o.set("cacheKey", cache_key)?;
                o.set("result", JsOfflineAnalysis::from(result))?;
            }
            EngineEvent::CacheComplete {
                id,
                cache_key,
                path,
                bytes,
            } => {
                o.set("type", "cacheComplete")?;
                o.set("id", id)?;
                o.set("cacheKey", cache_key)?;
                o.set("path", path_str(path))?;
                o.set("bytes", bytes as f64)?;
            }
            EngineEvent::Download {
                download_id,
                status,
                bytes,
                total_bytes,
                path,
                error,
            } => {
                o.set("type", "download")?;
                o.set("downloadId", download_id)?;
                o.set("status", download_status_str(status))?;
                o.set("bytes", bytes as f64)?;
                o.set("totalBytes", total_bytes.map(|b| b as f64))?;
                if let Some(p) = path {
                    o.set("path", path_str(p))?;
                }
                if let Some(e) = error {
                    o.set("error", e)?;
                }
            }
            EngineEvent::Devices(devices) => {
                o.set("type", "devices")?;
                o.set(
                    "devices",
                    devices.into_iter().map(JsDeviceInfo::from).collect::<Vec<_>>(),
                )?;
            }
            EngineEvent::PreviewEnded => {
                o.set("type", "previewEnded")?;
            }
            _ => {
                o.set("type", "unknown")?;
            }
        }
        Ok(o.raw())
    }
}
