//! JS <-> Rust conversions. Shapes match `src/main/engine/types.ts` exactly (camelCase fields,
//! `type` discriminant on events, `null` for absent values).

use std::collections::HashMap;
use std::path::PathBuf;

use ghost_engine::{
    ArchiveListing, DeviceInfo, DownloadOptions, DownloadStatus, EngineEvent, LoadProgress, LoopMode, NormalizationMode,
    OfflineAnalysis, PlaybackState, PositionInfo, Slot, SourceExtras, SourceSpec, TagInfo, TrackInfo, TrackLoad,
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

/// `EngineSource`: `{ kind: 'http', url, headers?, cacheKey, formatHint? } | { kind: 'file', path, formatHint? }`,
/// both with the optional `EngineSourceExtras` (`clipStartMs`, `clipEndMs`, `subsong`, `archiveEntry`).
pub struct JsEngineSource {
    pub kind: String,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub cache_key: Option<String>,
    pub format_hint: Option<String>,
    pub path: Option<String>,
    pub clip_start_ms: Option<f64>,
    pub clip_end_ms: Option<f64>,
    pub subsong: Option<f64>,
    pub archive_entry: Option<String>,
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
            clip_start_ms: opt(&o, C, "clipStartMs")?,
            clip_end_ms: opt(&o, C, "clipEndMs")?,
            subsong: opt(&o, C, "subsong")?,
            archive_entry: opt(&o, C, "archiveEntry")?,
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
    // Filter after the cast: 1e300 is a finite f64 but an infinite f32.
    v.map(|x| x as f32).filter(|x| x.is_finite())
}

/// Optional non-negative integer field (`NaN`, negatives and fractions are rejected).
fn opt_index(v: Option<f64>, what: &str) -> Result<Option<u64>> {
    match v {
        None => Ok(None),
        Some(x) if x.is_finite() && x >= 0.0 && x.fract() == 0.0 => Ok(Some(x as u64)),
        Some(x) => Err(invalid(format!("source.{what} must be a non-negative integer (got {x})"))),
    }
}

fn extras_from_js(s: &JsEngineSource) -> Result<SourceExtras> {
    let clip_ms = |v: Option<f64>, what: &str| -> Result<Option<u64>> {
        match v {
            None => Ok(None),
            Some(x) if x.is_finite() && x >= 0.0 => Ok(Some(x.round() as u64)),
            Some(x) => Err(invalid(format!("source.{what} must be a non-negative number (got {x})"))),
        }
    };
    let extras = SourceExtras {
        clip_start_ms: clip_ms(s.clip_start_ms, "clipStartMs")?,
        clip_end_ms: clip_ms(s.clip_end_ms, "clipEndMs")?,
        subsong: opt_index(s.subsong, "subsong")?.map(|v| v.min(u32::MAX as u64) as u32),
        archive_entry: s.archive_entry.clone().filter(|e| !e.is_empty()),
    };
    if let (Some(a), Some(b)) = (extras.clip_start_ms, extras.clip_end_ms) {
        if b <= a {
            return Err(invalid(format!("source.clipEndMs ({b}) must be after clipStartMs ({a})")));
        }
    }
    Ok(extras)
}

pub fn source_from_js(s: JsEngineSource) -> Result<SourceSpec> {
    let extras = extras_from_js(&s)?;
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
                extras,
            })
        }
        "file" => {
            let path = s.path.ok_or_else(|| invalid("file source requires `path`"))?;
            Ok(SourceSpec::File {
                path: PathBuf::from(path),
                format_hint: s.format_hint,
                extras,
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

/// `EngineDownloadOptions`: `{ renderFlac?: boolean }`.
pub struct JsDownloadOptions {
    pub render_flac: Option<bool>,
}

impl FromNapiValue for JsDownloadOptions {
    unsafe fn from_napi_value(env: napi::sys::napi_env, v: napi::sys::napi_value) -> Result<Self> {
        const C: &str = "options";
        let o = unsafe { as_object(env, v, C)? };
        Ok(JsDownloadOptions { render_flac: opt(&o, C, "renderFlac")? })
    }
}

impl From<JsDownloadOptions> for DownloadOptions {
    fn from(o: JsDownloadOptions) -> Self {
        DownloadOptions { render_flac: o.render_flac }
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

pub fn slot(s: &str) -> Result<Slot> {
    match s {
        "current" => Ok(Slot::Current),
        "preview" => Ok(Slot::Preview),
        other => Err(invalid(format!("unknown slot '{other}' (expected 'current' | 'preview')"))),
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

/// `ArchiveListing` entries: `{ path, size, head? }`.
#[napi(object)]
pub struct JsArchiveEntry {
    pub path: String,
    pub size: f64,
    pub head: Option<Buffer>,
}

/// `ArchiveListing` playlists: `{ path, text }`.
#[napi(object)]
pub struct JsArchivePlaylist {
    pub path: String,
    pub text: String,
}

/// `ArchiveListing`: `{ entries, playlists }`.
#[napi(object)]
pub struct JsArchiveListing {
    pub entries: Vec<JsArchiveEntry>,
    pub playlists: Vec<JsArchivePlaylist>,
}

impl From<ArchiveListing> for JsArchiveListing {
    fn from(l: ArchiveListing) -> Self {
        JsArchiveListing {
            entries: l.entries.into_iter().map(|e| JsArchiveEntry { path: e.path, size: e.size as f64, head: e.head.map(Buffer::from) }).collect(),
            playlists: l.playlists.into_iter().map(|(path, text)| JsArchivePlaylist { path, text }).collect(),
        }
    }
}

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

/// `EngineLoadProgress` (see `ghost_engine::LoadProgress`).
#[napi(object, use_nullable = true)]
pub struct JsLoadProgress {
    pub id: String,
    pub started: bool,
    pub connected: bool,
    pub bytes: f64,
    pub total_bytes: Option<f64>,
    pub whole_file: bool,
    pub buffered_ms: f64,
    pub target_ms: f64,
    pub stalled_ms: f64,
    pub stall_timeout_ms: f64,
}

impl From<LoadProgress> for JsLoadProgress {
    fn from(p: LoadProgress) -> Self {
        JsLoadProgress {
            id: p.id,
            started: p.started,
            connected: p.connected,
            bytes: p.bytes as f64,
            total_bytes: p.total_bytes.map(|t| t as f64),
            whole_file: p.whole_file,
            buffered_ms: p.buffered_ms as f64,
            target_ms: p.target_ms as f64,
            stalled_ms: p.stalled_ms as f64,
            stall_timeout_ms: p.stall_timeout_ms as f64,
        }
    }
}

/// `EngineCacheProgress`: `{ bytes, totalBytes }`.
#[napi(object, use_nullable = true)]
pub struct JsCacheProgress {
    pub bytes: f64,
    pub total_bytes: Option<f64>,
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
                | EngineEvent::PreviewEnded { .. }
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
                title,
                artist,
                album,
                subsong_count,
                subsong,
                loop_start_ms,
                loop_end_ms,
                voice_count,
                voice_names,
            }) => {
                o.set("type", "trackInfo")?;
                o.set("id", id)?;
                o.set("durationMs", duration_ms.map(|d| d as f64))?;
                o.set("sampleRate", sample_rate)?;
                o.set("channels", channels as u32)?;
                o.set("codec", codec)?;
                o.set("bitrateKbps", bitrate_kbps)?;
                // Additive fields (not in the TS contract yet): only present when known.
                if let Some(v) = title {
                    o.set("title", v)?;
                }
                if let Some(v) = artist {
                    o.set("artist", v)?;
                }
                if let Some(v) = album {
                    o.set("album", v)?;
                }
                if let Some(v) = subsong_count {
                    o.set("subsongCount", v)?;
                }
                if let Some(v) = subsong {
                    o.set("subsong", v)?;
                }
                if let (Some(a), Some(b)) = (loop_start_ms, loop_end_ms) {
                    o.set("loopStartMs", a as f64)?;
                    o.set("loopEndMs", b as f64)?;
                }
                if voice_count > 0 {
                    o.set("voiceCount", voice_count)?;
                    o.set("voiceNames", voice_names)?;
                }
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
            EngineEvent::PreviewEnded { id } => {
                o.set("type", "previewEnded")?;
                o.set("id", id)?;
            }
            _ => {
                o.set("type", "unknown")?;
            }
        }
        Ok(o.raw())
    }
}

/// `GhostEngine.stats()` result (see `ghost_engine::StatsSnapshot`).
#[napi(object, use_nullable = true)]
pub struct JsEngineStats {
    /// The playing track ran out of decoded audio mid-playback (dropout / rebuffer).
    pub underruns: f64,
    /// Device-reported overloads (CoreAudio processor overload).
    pub xruns: f64,
    pub callbacks: f64,
    /// Output callbacks that took more than half their buffer period.
    pub callback_over_budget: f64,
    /// Output callbacks that started more than 1.5 buffer periods after the previous one.
    pub callback_gaps: f64,
    pub callback_max_us: f64,
    pub callback_avg_us: f64,
    pub callback_period_us: f64,
    /// Least decoded audio buffered ahead of the playing track (ms), null until something played.
    pub low_water_ms: Option<f64>,
    /// Times the playing track had less than 500 ms decoded ahead.
    pub low_water_events: f64,
    pub threads: Vec<JsThreadCpu>,
}

#[napi(object)]
pub struct JsThreadCpu {
    pub name: String,
    pub count: u32,
    pub cpu_ms: f64,
}

impl From<ghost_engine::StatsSnapshot> for JsEngineStats {
    fn from(s: ghost_engine::StatsSnapshot) -> Self {
        JsEngineStats {
            underruns: s.underruns as f64,
            xruns: s.xruns as f64,
            callbacks: s.callbacks as f64,
            callback_over_budget: s.callback_over_budget as f64,
            callback_gaps: s.callback_gaps as f64,
            callback_max_us: s.callback_max_us,
            callback_avg_us: s.callback_avg_us,
            callback_period_us: s.callback_period_us,
            low_water_ms: s.low_water_ms,
            low_water_events: s.low_water_events as f64,
            threads: s.threads.into_iter().map(|t| JsThreadCpu { name: t.name, count: t.count, cpu_ms: t.cpu_ms }).collect(),
        }
    }
}
