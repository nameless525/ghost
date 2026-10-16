//! Audio sources: anything that yields interleaved f32 frames at its own rate.
//!
//! # Extension point (decoders)
//!
//! The [`AudioSource`] trait (with [`LoopInfo`] / [`LengthHint`]) lives in `ghost-formats` and is
//! re-exported here, so the chiptune / game-engine decoders in that crate implement it directly.
//! [`open`] picks the decoder:
//! 1. `archive_entry` set: the archive (`.zip` / `.7z`) is read whole through the cache,
//!    extracted in memory ([`archive_cache`]) and the entry is opened like a file.
//! 2. `format_hint` / extension / magic bytes ([`ghost_formats::detect`]): libgme (NSF, SPC,
//!    VGZ, ...) and libopenmpt (MOD, XM, IT, ...) get the whole file in memory; vgmstream
//!    (ADX, HCA, BRSTM, FSB, ...) streams through the cache reader.
//! 3. Everything else: symphonia (MP3, FLAC, AAC, Vorbis, WAV, ...; Opus through libopus, see
//!    [`opus`]); vgmstream is the last resort for unknown extensions symphonia can't probe.
//! 4. `clip_start_ms` / `clip_end_ms`: the result is wrapped in a [`clip::ClipStage`].
//!
//! Everything downstream is shared: the [`loop_stage::LoopStage`] applies the engine's
//! [`LoopMode`](crate::LoopMode) to sources that report loop points or a length hint, then the
//! decode worker downmixes to stereo (by the channels' speaker positions, see [`to_stereo`]),
//! resamples to the device rate and feeds the mixer.

pub mod archive_cache;
pub mod clip;
pub mod frag;
pub mod loop_stage;
pub mod opus;
pub mod symphonia_src;

use std::io::Read;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub use ghost_formats::source::{AudioSource, LengthHint, LoopInfo, SourceError, SourceMeta};
pub use ghost_formats::Family;
use ghost_formats::vgmstream::{ByteSource, FileOpener, FsOpener, MemoryOpener, ReadSeekSource, VgmstreamSource};
use ghost_formats::OpenOptions;

use crate::cache::{CacheManager, CacheReader};
use crate::{ArchiveEntryInfo, ArchiveListing, SourceSpec};

/// Whole-file reads for in-memory decoders (chip / tracker files are tiny; this guards against a
/// misdetected multi-gigabyte stream).
const MAX_IN_MEMORY: u64 = 256 * 1024 * 1024;
const PEEK: usize = 4096;
/// Whole-stream reads with a progress callback report after every this many bytes.
const PROGRESS_STEP: u64 = 64 * 1024;

/// Context for opening sources.
pub struct OpenCtx<'a> {
    pub cache: &'a Arc<CacheManager>,
    pub cancel: Arc<AtomicBool>,
    /// Prefer sample-accurate seeking even if it means reading from the start of the stream.
    pub accurate_seek: bool,
    /// Read HTTP sources through background cache readers (never ahead of playback's fetches).
    pub background: bool,
}

impl OpenCtx<'_> {
    /// A cache reader over the HTTP source `spec`, with this context's cancel flag and priority.
    pub fn reader(&self, spec: &SourceSpec) -> Result<CacheReader, SourceError> {
        let cancel = Some(self.cancel.clone());
        let r = if self.background { self.cache.open_background_reader(spec, cancel) } else { self.cache.open_reader(spec, cancel) };
        r.map_err(|e| SourceError::new(e.to_string()))
    }
}

/// An opened source and the `ghost-formats` family that decodes it (`None` = symphonia).
pub struct Opened {
    pub source: Box<dyn AudioSource>,
    pub family: Option<Family>,
}

/// Open a source for `spec` (see the module docs for how the decoder is chosen).
pub fn open(spec: &SourceSpec, ctx: &OpenCtx<'_>) -> Result<Box<dyn AudioSource>, SourceError> {
    open_detailed(spec, ctx).map(|o| o.source)
}

pub fn open_detailed(spec: &SourceSpec, ctx: &OpenCtx<'_>) -> Result<Opened, SourceError> {
    let ex = spec.extras();
    if !ex.has_clip() {
        return open_unclipped(spec, ctx);
    }
    // Clips start with a seek that must land exactly (consecutive clips join gaplessly).
    let accurate = OpenCtx { accurate_seek: true, cancel: ctx.cancel.clone(), ..*ctx };
    let o = open_unclipped(spec, &accurate)?;
    let clipped = clip::ClipStage::new(o.source, ex.clip_start_ms.unwrap_or(0), ex.clip_end_ms)?;
    Ok(Opened { source: Box::new(clipped), family: o.family })
}

/// Which `ghost-formats` family would decode `spec` (`None` = symphonia), without opening a
/// decoder. Reads the first bytes (or extracts the archive) when the extension doesn't say.
pub fn probe_family(spec: &SourceSpec, ctx: &OpenCtx<'_>) -> Result<Option<Family>, SourceError> {
    if let Some(entry) = &spec.extras().archive_entry {
        let set = archive_cache::get(spec, ctx)?;
        let (path, data) = set.find(entry).ok_or_else(|| missing_entry(entry))?;
        return Ok(ghost_formats::detect(ghost_formats::extension_of(path).as_deref(), &data[..data.len().min(PEEK)], Some(data.len() as u64)));
    }
    let ext = ext_of(spec);
    if let Some(f) = ext.as_deref().and_then(ghost_formats::family_for_extension) {
        if f != ghost_formats::Family::Openmpt {
            return Ok(Some(f));
        }
    }
    if ext.as_deref().is_some_and(ghost_formats::detect::is_common_extension) {
        return Ok(None);
    }
    let (head, size) = peek(spec, ctx)?;
    Ok(ghost_formats::detect(ext.as_deref(), &head, size))
}

fn missing_entry(entry: &str) -> SourceError {
    SourceError::new(format!("archive has no entry '{entry}'"))
}

/// File name of the stream (path file name, or the URL's last path segment, percent-decoded).
pub(crate) fn source_name(spec: &SourceSpec) -> String {
    match spec {
        SourceSpec::File { path, .. } => path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        SourceSpec::Http { url, .. } => percent_decode(ghost_formats::file_name_of(url.split("://").nth(1).unwrap_or(url))),
    }
}

fn percent_decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Extension used for decoder selection: the format hint when it is an extension, else the
/// file / URL extension.
pub(crate) fn ext_of(spec: &SourceSpec) -> Option<String> {
    let hint = spec.format_hint().map(str::trim).filter(|h| !h.is_empty() && !h.contains('/'));
    match hint {
        Some(h) => Some(h.trim_start_matches('.').to_ascii_lowercase()),
        None => ghost_formats::extension_of(&source_name(spec)),
    }
}

/// First bytes of the stream and its size.
fn peek(spec: &SourceSpec, ctx: &OpenCtx<'_>) -> Result<(Vec<u8>, Option<u64>), SourceError> {
    match spec {
        SourceSpec::File { path, .. } => {
            let mut f = std::fs::File::open(path).map_err(|e| SourceError::new(format!("open {}: {e}", path.display())))?;
            let size = f.metadata().ok().map(|m| m.len());
            let mut head = Vec::with_capacity(PEEK);
            (&mut f).take(PEEK as u64).read_to_end(&mut head).map_err(|e| SourceError::new(format!("read {}: {e}", path.display())))?;
            Ok((head, size))
        }
        SourceSpec::Http { .. } => {
            let mut r = ctx.reader(&spec.base())?;
            r.wait_header().map_err(|e| SourceError::new(e.to_string()))?;
            let size = r.total_len();
            let mut head = Vec::with_capacity(PEEK);
            (&mut r).take(PEEK as u64).read_to_end(&mut head).map_err(|e| SourceError::new(e.to_string()))?;
            Ok((head, size))
        }
    }
}

/// Whether the decoder for `spec` needs the whole file before its first sample (archive entries;
/// libgme / libopenmpt formats), judged from the entry / hint / extension alone (no I/O). A chip
/// file behind an unknown extension is only recognised by content, so it reads `false` here.
pub(crate) fn whole_file_hint(spec: &SourceSpec) -> bool {
    spec.extras().archive_entry.is_some() || matches!(ext_of(spec).as_deref().and_then(ghost_formats::family_for_extension), Some(Family::Gme | Family::Openmpt))
}

/// Progress callback for whole-stream reads: (bytes in the stream cache, total size).
pub type ReadProgress<'a> = &'a mut dyn FnMut(u64, Option<u64>);

/// The whole stream in memory (through the cache for HTTP sources).
pub(crate) fn read_all(spec: &SourceSpec, ctx: &OpenCtx<'_>, max: u64) -> Result<Vec<u8>, SourceError> {
    read_all_with(spec, ctx, max, None)
}

/// [`read_all`], reporting an HTTP source's arrival to `progress` as it is read.
pub(crate) fn read_all_with(spec: &SourceSpec, ctx: &OpenCtx<'_>, max: u64, mut progress: Option<ReadProgress<'_>>) -> Result<Vec<u8>, SourceError> {
    let too_big = || SourceError::new(format!("file too large to load ({} MB max)", max >> 20));
    match spec {
        SourceSpec::File { path, .. } => {
            let len = std::fs::metadata(path).map_err(|e| SourceError::new(format!("open {}: {e}", path.display())))?.len();
            if len > max {
                return Err(too_big());
            }
            std::fs::read(path).map_err(|e| SourceError::new(format!("read {}: {e}", path.display())))
        }
        SourceSpec::Http { .. } => {
            let mut r = ctx.reader(&spec.base())?;
            r.wait_header().map_err(|e| SourceError::new(e.to_string()))?;
            if r.total_len().is_some_and(|t| t > max) {
                return Err(too_big());
            }
            let mut out = Vec::with_capacity(r.total_len().unwrap_or(0) as usize);
            match progress.as_mut() {
                None => {
                    (&mut r).take(max + 1).read_to_end(&mut out).map_err(|e| SourceError::new(e.to_string()))?;
                }
                Some(report) => loop {
                    // A step at a time, reporting what the cache holds (the fetcher runs ahead).
                    let n = (&mut r).take(PROGRESS_STEP).read_to_end(&mut out).map_err(|e| SourceError::new(e.to_string()))?;
                    let p = r.entry().progress();
                    report(p.bytes, p.total);
                    if n == 0 || out.len() as u64 > max {
                        break;
                    }
                },
            }
            if out.len() as u64 > max {
                return Err(too_big());
            }
            Ok(out)
        }
    }
}

/// NEZPlug playlists next to a file on disk (`*.m3u`, small ones only).
fn sibling_playlists(path: &Path) -> Vec<String> {
    let Some(dir) = path.parent() else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in rd.flatten().take(500) {
        let p = e.path();
        let is_m3u = p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("m3u"));
        if is_m3u && e.metadata().is_ok_and(|m| m.len() < 256 * 1024) {
            if let Ok(b) = std::fs::read(&p) {
                out.push(ghost_formats::decode_text(&b));
            }
        }
    }
    out
}

fn open_unclipped(spec: &SourceSpec, ctx: &OpenCtx<'_>) -> Result<Opened, SourceError> {
    let ex = spec.extras();
    let opts = OpenOptions { subsong: ex.subsong, playlists: Vec::new() };
    if let Some(entry) = &ex.archive_entry {
        return open_archive_entry(spec, entry, ctx, opts);
    }
    let ext = ext_of(spec);
    let name = source_name(spec);
    let common = ext.as_deref().is_some_and(ghost_formats::detect::is_common_extension);
    let family = if common && ex.subsong.is_none() {
        None
    } else {
        let (head, size) = peek(spec, ctx)?;
        ghost_formats::detect(ext.as_deref(), &head, size)
    };
    match family {
        Some(f @ (Family::Gme | Family::Openmpt)) => {
            let data = read_all(spec, ctx, MAX_IN_MEMORY)?;
            let mut opts = opts;
            if let (Family::Gme, SourceSpec::File { path, .. }) = (f, spec) {
                opts.playlists = sibling_playlists(path);
            }
            // The name carries the extension libgme / libopenmpt may need; use the hint's.
            let name = match &ext {
                Some(e) if ghost_formats::extension_of(&name).as_deref() != Some(e.as_str()) => format!("{name}.{e}"),
                _ => name,
            };
            Ok(Opened { source: ghost_formats::open_memory(f, data, &name, &opts)?, family: Some(f) })
        }
        Some(Family::Vgmstream) => Ok(Opened { source: Box::new(open_vgmstream(spec, ctx, &name, ext.as_deref(), &opts)?), family: Some(Family::Vgmstream) }),
        None => match symphonia_src::SymphoniaSource::open(spec, ctx) {
            Ok(s) => Ok(Opened { source: Box::new(s), family: None }),
            Err(e) if !common => {
                // Unknown extension symphonia can't probe: vgmstream sniffs a few formats by content.
                match open_vgmstream(spec, ctx, &name, ext.as_deref(), &opts) {
                    Ok(v) => Ok(Opened { source: Box::new(v), family: Some(Family::Vgmstream) }),
                    Err(_) => Err(e),
                }
            }
            Err(e) => Err(e),
        },
    }
}

/// HTTP streams for vgmstream: the main file re-opens through the cache; no companions.
struct CacheOpener {
    cache: Arc<CacheManager>,
    spec: SourceSpec,
    name: String,
    cancel: Arc<AtomicBool>,
    background: bool,
}

impl FileOpener for CacheOpener {
    fn open(&self, name: &str) -> Option<Box<dyn ByteSource>> {
        if !ghost_formats::file_name_of(name).eq_ignore_ascii_case(ghost_formats::file_name_of(&self.name)) {
            return None;
        }
        let ctx = OpenCtx { cache: &self.cache, cancel: self.cancel.clone(), accurate_seek: false, background: self.background };
        let r = ctx.reader(&self.spec).ok()?;
        r.wait_header().ok()?;
        let size = r.total_len();
        Some(Box::new(ReadSeekSource::new(r, size).ok()?))
    }
}

fn open_vgmstream(spec: &SourceSpec, ctx: &OpenCtx<'_>, name: &str, ext: Option<&str>, opts: &OpenOptions) -> Result<VgmstreamSource, SourceError> {
    match spec {
        SourceSpec::File { path, .. } => {
            // vgmstream names companions (and re-opens) after this name: absolute, so a relative
            // path's directory isn't applied a second time on top of the opener's `dir`.
            let path = std::path::absolute(path).map_err(|e| SourceError::new(format!("open {}: {e}", path.display())))?;
            let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
            let full = path.to_string_lossy().into_owned();
            VgmstreamSource::open(&full, Arc::new(FsOpener { dir }), opts)
        }
        SourceSpec::Http { .. } => {
            // vgmstream picks parsers by extension: make sure the name has the hinted one.
            let name = match ext {
                Some(e) if ghost_formats::extension_of(name).as_deref() != Some(e) => format!("{name}.{e}"),
                _ => name.to_string(),
            };
            let opener = Arc::new(CacheOpener { cache: ctx.cache.clone(), spec: spec.base(), name: name.clone(), cancel: ctx.cancel.clone(), background: ctx.background });
            VgmstreamSource::open(&name, opener, opts)
        }
    }
}

fn open_archive_entry(spec: &SourceSpec, entry: &str, ctx: &OpenCtx<'_>, mut opts: OpenOptions) -> Result<Opened, SourceError> {
    let set = archive_cache::get(spec, ctx)?;
    let (path, data) = set.find(entry).ok_or_else(|| missing_entry(entry))?;
    let path = path.to_string();
    let data = data.clone();
    let ext = ghost_formats::extension_of(&path);
    let family = ghost_formats::detect(ext.as_deref(), &data[..data.len().min(PEEK)], Some(data.len() as u64));
    match family {
        Some(f @ (Family::Gme | Family::Openmpt)) => {
            if f == Family::Gme {
                // Each line names the entry it means, so a line for "US/game.nsf" never describes "JP/game.nsf".
                let m3us: Vec<_> = set.playlists().into_iter().filter(|(p, _)| p.to_ascii_lowercase().ends_with(".m3u")).collect();
                let entries: Vec<&str> = set.files.iter().map(|(p, _)| p.as_str()).collect();
                opts.playlists = ghost_formats::nezplug::resolve_playlists(&m3us, &entries);
            }
            Ok(Opened { source: ghost_formats::open_memory(f, data.to_vec(), &path, &opts)?, family: Some(f) })
        }
        Some(Family::Vgmstream) => {
            // Companion files (.txth, .awb, ...) resolve inside the same archive.
            let mut opener = MemoryOpener::default();
            for (p, d) in &set.files {
                opener.insert(p, d.clone());
            }
            Ok(Opened { source: Box::new(VgmstreamSource::open(&path, Arc::new(opener), &opts)?), family: Some(Family::Vgmstream) })
        }
        None => Ok(Opened { source: Box::new(symphonia_src::SymphoniaSource::open_bytes(data, ext)?), family: None }),
    }
}

/// List an archive source and return its playlists' text (see `Engine::inspect_archive`).
pub fn inspect_archive(spec: &SourceSpec, cache: &Arc<CacheManager>) -> Result<ArchiveListing, SourceError> {
    let ctx = OpenCtx { cache, cancel: Arc::new(AtomicBool::new(false)), accurate_seek: false, background: false };
    let base = spec.base();
    let set = archive_cache::get(&base, &ctx)?;
    Ok(ArchiveListing {
        entries: set.files.iter().map(|(p, d)| ArchiveEntryInfo { path: p.clone(), size: d.len() as u64, head: chip_head(p, d) }).collect(),
        playlists: set.playlists(),
    })
}

/// The start of a multi-song chip file, which says how many songs it holds (NSF / GBS: the
/// 128-byte header; NSFE: chunks anywhere in the file, which is small: whole, up to 1 MiB).
fn chip_head(path: &str, data: &[u8]) -> Option<Vec<u8>> {
    let len = match ghost_formats::extension_of(path).as_deref() {
        Some("nsf" | "gbs") => 128,
        Some("nsfe") if data.len() <= 1 << 20 => data.len(),
        _ => return None,
    };
    Some(data[..data.len().min(len)].to_vec())
}

/// The usual speaker layout (WAVE channel mask) for a channel count when a source doesn't give
/// one, as FLAC, Vorbis, Opus and `WAVEFORMATEXTENSIBLE` define it: L R C, quad, 5.0, 5.1,
/// 6.1 (back centre, sides), 7.1 (backs and sides).
fn default_channel_mask(channels: usize) -> Option<u32> {
    Some(match channels {
        3 => 0x7,
        4 => 0x33,
        5 => 0x37,
        6 => 0x3F,
        7 => 0x70F,
        8 => 0x63F,
        _ => return None,
    })
}

/// Stereo (left, right) gains of the speaker at WAVE channel-mask bit `bit` (ITU-R BS.775 style):
/// front speakers at full level, every other one at -3 dB, each on its own side (centre speakers
/// split equally, left/right-of-centre between their side and the centre); LFE is left out.
fn speaker_gains(bit: u32) -> (f32, f32) {
    use std::f32::consts::FRAC_1_SQRT_2 as C;
    // cos / sin of 22.5°: halfway between a side and the centre, at constant power.
    const NEAR: f32 = 0.923_879_5;
    const FAR: f32 = 0.382_683_43;
    match bit {
        0 => (1.0, 0.0),                // front left
        1 => (0.0, 1.0),                // front right
        2 => (C, C),                    // front centre
        6 => (NEAR, FAR),               // front left of centre
        7 => (FAR, NEAR),               // front right of centre
        4 | 9 | 12 | 15 => (C, 0.0),    // back, side, top front, top back left
        5 | 10 | 14 | 17 => (0.0, C),   // back, side, top front, top back right
        8 | 11 | 13 | 16 => (0.5, 0.5), // back, top, top front, top back centre
        _ => (0.0, 0.0),                // LFE
    }
}

/// Bit numbers of the speakers in `mask`, in channel order.
fn speakers(mut mask: u32) -> impl Iterator<Item = u32> {
    std::iter::from_fn(move || {
        (mask != 0).then(|| {
            let bit = mask.trailing_zeros();
            mask &= mask - 1;
            bit
        })
    })
}

/// Convert interleaved `channels`-channel audio to interleaved stereo, appending to `out`.
/// `mask` places the channels ([`AudioSource::channel_mask`]); without a usable one the usual
/// layout for the channel count is assumed (past 7.1, the extra channels alternate left / right
/// at -3 dB).
pub fn to_stereo(input: &[f32], channels: usize, mask: Option<u32>, out: &mut Vec<f32>) {
    match channels {
        0 => {}
        1 => {
            out.reserve(input.len() * 2);
            for &s in input {
                out.push(s);
                out.push(s);
            }
        }
        2 => out.extend_from_slice(input),
        n => {
            const C: f32 = std::f32::consts::FRAC_1_SQRT_2;
            let mask = mask.filter(|m| m.count_ones() as usize == n && m >> 18 == 0).or_else(|| default_channel_mask(n));
            let gains: Vec<(f32, f32)> = match mask {
                Some(m) => speakers(m).map(speaker_gains).collect(),
                None => speakers(0x63F).map(speaker_gains).chain((8..n).map(|i| if i % 2 == 0 { (C, 0.0) } else { (0.0, C) })).collect(),
            };
            // Normalised so a full-scale correlated signal stays <= 1.
            let (sum_l, sum_r) = gains.iter().fold((0.0f32, 0.0f32), |(l, r), g| (l + g.0, r + g.1));
            let norm = 1.0 / sum_l.max(sum_r).max(1.0);
            out.reserve(input.len() / n * 2);
            for f in input.chunks_exact(n) {
                let (mut l, mut r) = (0.0f32, 0.0f32);
                for (&s, &(gl, gr)) in f.iter().zip(&gains) {
                    l += gl * s;
                    r += gr * s;
                }
                out.push(l * norm);
                out.push(r * norm);
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod test_util {
    use super::*;

    /// Deterministic synthetic source for tests: a ramp/sine with optional loop points.
    pub struct ToneSource {
        pub rate: u32,
        pub channels: usize,
        pub len: u64,
        pub pos: u64,
        pub loop_info: Option<LoopInfo>,
    }

    impl ToneSource {
        pub fn sample(&self, frame: u64, ch: usize) -> f32 {
            ((frame as f32) * 0.001 + ch as f32).sin() * 0.5
        }
    }

    impl AudioSource for ToneSource {
        fn sample_rate(&self) -> u32 {
            self.rate
        }
        fn channels(&self) -> usize {
            self.channels
        }
        fn read(&mut self, out: &mut [f32]) -> Result<usize, SourceError> {
            let want = out.len() / self.channels;
            let n = want.min((self.len - self.pos) as usize);
            for i in 0..n {
                for c in 0..self.channels {
                    out[i * self.channels + c] = self.sample(self.pos + i as u64, c);
                }
            }
            self.pos += n as u64;
            Ok(n)
        }
        fn seek(&mut self, frame: u64) -> Result<u64, SourceError> {
            self.pos = frame.min(self.len);
            Ok(self.pos)
        }
        fn duration(&self) -> Option<u64> {
            Some(self.len)
        }
        fn loop_info(&self) -> Option<LoopInfo> {
            self.loop_info
        }
        fn meta(&self) -> SourceMeta {
            SourceMeta { codec: "tone".into(), ..Default::default() }
        }
    }

    #[test]
    fn downmix_layouts() {
        let mut out = Vec::new();
        to_stereo(&[0.5, -0.5], 1, None, &mut out);
        assert_eq!(out, vec![0.5, 0.5, -0.5, -0.5]);
        out.clear();
        to_stereo(&[1.0, 1.0, 1.0, 1.0, 1.0, 1.0], 6, None, &mut out);
        assert!(out[0] <= 1.0 + 1e-6 && out[0] > 0.7);
    }

    /// Stereo (left, right) of a unit impulse in channel `c` alone.
    fn isolated(channels: usize, mask: Option<u32>, c: usize) -> (f32, f32) {
        let mut frame = vec![0.0; channels];
        frame[c] = 1.0;
        let mut out = Vec::new();
        to_stereo(&frame, channels, mask, &mut out);
        (out[0], out[1])
    }

    /// Every speaker lands on its own side (centre ones on both, equally), LFE is left out, and
    /// a full-scale signal on every channel stays within full scale.
    #[test]
    fn downmix_follows_speaker_positions() {
        #[derive(Clone, Copy, Debug, PartialEq)]
        enum Side {
            L,
            R,
            Both,
            Off,
        }
        use Side::*;
        let cases: &[(&str, u32, &[Side])] = &[
            ("3.0", 0x7, &[L, R, Both]),
            ("quad", 0x33, &[L, R, L, R]),
            ("quad (side)", 0x603, &[L, R, L, R]),
            ("3.1", 0xF, &[L, R, Both, Off]),
            ("5.0", 0x37, &[L, R, Both, L, R]),
            ("5.0 (side)", 0x607, &[L, R, Both, L, R]),
            ("5.1", 0x3F, &[L, R, Both, Off, L, R]),
            ("5.1 (side)", 0x60F, &[L, R, Both, Off, L, R]),
            ("6.1", 0x70F, &[L, R, Both, Off, Both, L, R]),
            ("7.1", 0x63F, &[L, R, Both, Off, L, R, L, R]),
            ("7.1 wide", 0xFF, &[L, R, Both, Off, L, R, L, R]),
            ("5.1.4", 0x2D63F, &[L, R, Both, Off, L, R, L, R, L, R, L, R]),
        ];
        for &(name, mask, sides) in cases {
            let n = sides.len();
            // The usual layout for the count also applies without a mask.
            let unmasked = (default_channel_mask(n) == Some(mask)).then_some(None);
            for m in std::iter::once(Some(mask)).chain(unmasked) {
                for (c, &want) in sides.iter().enumerate() {
                    let (l, r) = isolated(n, m, c);
                    assert!(l >= 0.0 && r >= 0.0);
                    let got = if l == 0.0 && r == 0.0 {
                        Off
                    } else if (l - r).abs() < 1e-6 {
                        Both
                    } else if l > r {
                        L
                    } else {
                        R
                    };
                    assert_eq!(got, want, "{name} ({m:?}): channel {c} → ({l}, {r})");
                }
                let mut out = Vec::new();
                to_stereo(&vec![1.0; n], n, m, &mut out);
                let peak = out[0].max(out[1]);
                assert!(peak <= 1.0 + 1e-6 && peak > 0.99, "{name}: full scale → {out:?}");
            }
        }
        // A back-right-only quad signal is entirely on the right.
        let (l, r) = isolated(4, Some(0x33), 3);
        assert!(l == 0.0 && r > 0.4, "({l}, {r})");
        // Without positions: the usual layout for the count (quad, not 3.1; 5.0 keeps both backs).
        assert_eq!(isolated(4, None, 3).0, 0.0);
        assert!(isolated(4, None, 3).1 > 0.0);
        assert!(isolated(5, None, 3).0 > 0.0 && isolated(5, None, 4).1 > 0.0);
        // A mask that doesn't match the channel count is ignored.
        assert_eq!(isolated(4, Some(0x3F), 3), isolated(4, None, 3));
        // Past 7.1 without positions: the extras alternate left / right.
        assert!(isolated(10, None, 8).0 > 0.0 && isolated(10, None, 8).1 == 0.0);
        assert!(isolated(10, None, 9).1 > 0.0 && isolated(10, None, 9).0 == 0.0);
        // 5.1 is unchanged from the fixed L R C LFE Ls Rs downmix it replaces.
        let frame = [0.3f32, -0.2, 0.5, 0.9, 0.1, -0.4];
        let mut out = Vec::new();
        to_stereo(&frame, 6, Some(0x3F), &mut out);
        let c = std::f32::consts::FRAC_1_SQRT_2;
        let norm = 1.0 / (1.0 + c + c);
        assert_eq!(out, vec![(frame[0] + c * frame[2] + c * frame[4]) * norm, (frame[1] + c * frame[2] + c * frame[5]) * norm]);
    }

    #[test]
    fn url_names() {
        let spec = SourceSpec::http("https://x.org/sets/Mega%20Man%202.7z?dl=1", "k");
        assert_eq!(source_name(&spec), "Mega Man 2.7z");
        assert_eq!(ext_of(&spec).as_deref(), Some("7z"));
        assert_eq!(ext_of(&spec.clone().with_format_hint(Some(".NSF".into()))).as_deref(), Some("nsf"));
        assert_eq!(ext_of(&spec.with_format_hint(Some("audio/mpeg".into()))).as_deref(), Some("7z"));
        assert_eq!(percent_decode("a%2x%E3%83%AD%%41é%"), "a%2xロ%Aé%");
    }
}
