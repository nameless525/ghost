//! Downloads (DESIGN §2): copy from the stream cache when the file is whole, otherwise fetch it
//! through the cache with progress; write to a temp file next to `dest`, tag it with lofty, then
//! rename into place. A new download with an id that is already running replaces the old job.
//!
//! Chip / tracker / game-engine formats (anything `ghost-formats` decodes) and clips are rendered
//! instead: decoded through the same source + loop stage as playback (the current loop settings,
//! Endless counting as Album: 2 loops + 10 s fade), encoded to FLAC, tagged (title / game /
//! author from the file fill in what the caller left empty). The file gets a `.flac` extension;
//! the `Done` event reports the final path. Progress counts PCM bytes rendered against the PCM
//! size of the whole track; the last progress event (before tagging) and `Done` carry the FLAC's
//! real size.
//!
//! Archive entries need the whole archive first: until it is in, progress counts the archive's
//! bytes in the stream cache against the archive's size; then the entry's own phase reports
//! (the entry's size for a saved entry, PCM from 0 for a render).

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use parking_lot::Mutex;

use crate::cache::CacheManager;
use crate::flac::FlacWriter;
use crate::http::Http;
use crate::source::loop_stage::{LoopSettings, LoopStage};
use crate::source::{self, AudioSource, OpenCtx};
use crate::{DownloadOptions, DownloadStatus, EngineEvent, LoopMode, SourceSpec, TagInfo};

/// Renders longer than this are refused (a source that never ends).
const MAX_RENDER_SEC: u64 = 3 * 3600;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

struct Job {
    gen: u64,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Downloads {
    jobs: Arc<Mutex<HashMap<String, Job>>>,
    gen: AtomicU64,
}

/// Emits events only while this job is still the live one for its id.
struct Reporter {
    id: String,
    gen: u64,
    jobs: Arc<Mutex<HashMap<String, Job>>>,
    events: Sender<EngineEvent>,
    last: Instant,
}

impl Reporter {
    fn live(&self) -> bool {
        self.jobs.lock().get(&self.id).is_some_and(|j| j.gen == self.gen)
    }

    fn send(&self, status: DownloadStatus, bytes: u64, total: Option<u64>, path: Option<PathBuf>, error: Option<String>) {
        if self.live() {
            let _ = self.events.send(EngineEvent::Download { download_id: self.id.clone(), status, bytes, total_bytes: total, path, error });
        }
    }

    fn progress(&mut self, bytes: u64, total: Option<u64>, force: bool) {
        if force || self.last.elapsed() >= PROGRESS_INTERVAL {
            self.last = Instant::now();
            self.send(DownloadStatus::Progress, bytes, total, None, None);
        }
    }

    fn finish(&self) {
        let mut jobs = self.jobs.lock();
        if jobs.get(&self.id).is_some_and(|j| j.gen == self.gen) {
            jobs.remove(&self.id);
        }
    }
}

impl Downloads {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        id: String,
        source: SourceSpec,
        dest: PathBuf,
        tags: TagInfo,
        options: DownloadOptions,
        loops: (LoopMode, u32, f32),
        cache: Arc<CacheManager>,
        events: Sender<EngineEvent>,
    ) {
        let gen = self.gen.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some(old) = self.jobs.lock().insert(id.clone(), Job { gen, cancel: cancel.clone() }) {
            // Replaced: the old job stops quietly (its events are suppressed).
            old.cancel.store(true, Ordering::Relaxed);
        }
        let jobs = self.jobs.clone();
        crate::util::spawn_named("ghost-download", move || {
            crate::util::set_low_priority();
            let mut rep = Reporter { id, gen, jobs, events, last: Instant::now() - PROGRESS_INTERVAL };
            // Untrusted streams and tags pass through decoders, taggers and the FLAC encoder: a
            // panic must still end the job with an event.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&source, &dest, &tags, options, loops, &cache, &cancel, &mut rep)))
                .unwrap_or_else(|_| Err("download crashed (malformed source or tags)".to_string()));
            match result {
                Ok(path) => rep.send(DownloadStatus::Done, file_len(&path), Some(file_len(&path)), Some(path), None),
                Err(_) if cancel.load(Ordering::Relaxed) => rep.send(DownloadStatus::Canceled, 0, None, None, None),
                Err(e) => rep.send(DownloadStatus::Error, 0, None, None, Some(e)),
            }
            rep.finish();
        });
    }

    pub fn cancel(&self, id: &str) {
        if let Some(j) = self.jobs.lock().get(id) {
            j.cancel.store(true, Ordering::Relaxed);
        }
    }
}

fn file_len(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// Per-job temp file next to `dest` (unique, so a replaced job can't clobber its successor).
fn temp_path(dest: &Path, gen: u64) -> PathBuf {
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "download".into());
    dest.with_file_name(format!(".{name}.{}-{gen}.ghostpart", std::process::id()))
}

#[allow(clippy::too_many_arguments)]
fn run(
    source: &SourceSpec,
    dest: &Path,
    tags: &TagInfo,
    options: DownloadOptions,
    loops: (LoopMode, u32, f32),
    cache: &Arc<CacheManager>,
    cancel: &Arc<AtomicBool>,
    rep: &mut Reporter,
) -> Result<PathBuf, String> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let ctx = OpenCtx { cache, cancel: cancel.clone(), accurate_seek: true };
    if source.extras().archive_entry.is_some() {
        // Everything below needs the extracted set, i.e. the whole archive: report the archive's
        // bytes while it is fetched instead of sitting at 0 until it is in. (Rendering then
        // reports its own progress from 0.)
        rep.progress(0, None, true);
        source::archive_cache::get_with_progress(source, &ctx, Some(&mut |bytes, total| rep.progress(bytes, total, false))).map_err(|e| e.message)?;
    }
    let render = match options.render_flac {
        Some(r) => r,
        None => source.extras().has_clip() || source::probe_family(source, &ctx).map_err(|e| e.message)?.is_some(),
    };
    if render {
        return render_flac(source, dest, tags, loops, &ctx, rep);
    }
    if let Some(entry) = &source.extras().archive_entry {
        return save_entry(source, entry, dest, tags, &ctx, rep);
    }
    let tmp = temp_path(dest, rep.gen);
    let result = (|| {
        let mut out = File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        let (total, written) = match source {
            SourceSpec::File { path, .. } => {
                let mut f = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
                let total = f.metadata().ok().map(|m| m.len());
                (total, copy(&mut f, &mut out, total, cancel, rep)?)
            }
            SourceSpec::Http { cache_key, .. } => {
                if let Some((path, len)) = cache.complete_path(cache_key) {
                    let mut f = File::open(&path).map_err(|e| format!("open cache: {e}"))?;
                    (Some(len), copy(&mut f, &mut out, Some(len), cancel, rep)?)
                } else {
                    let mut r = cache.open_reader(source, Some(cancel.clone())).map_err(|e| e.to_string())?;
                    r.wait_header().map_err(|e| e.to_string())?;
                    let total = r.total_len();
                    (total, copy(&mut r, &mut out, total, cancel, rep)?)
                }
            }
        };
        out.sync_all().map_err(|e| format!("write: {e}"))?;
        drop(out);
        if let Some(t) = total {
            if written != t {
                return Err(format!("incomplete download: {written} of {t} bytes"));
            }
        }
        // Final progress (bytes == total) before the tagging window.
        rep.progress(written, Some(total.unwrap_or(written)), true);
        if cancel.load(Ordering::Relaxed) {
            return Err("canceled".into());
        }
        // Tagging failures are not fatal: the audio is intact, only metadata is missing.
        let _ = write_tags(&tmp, tags, &cache.http);
        if cancel.load(Ordering::Relaxed) {
            return Err("canceled".into());
        }
        std::fs::rename(&tmp, dest).map_err(|e| format!("move into place: {e}"))?;
        Ok(dest.to_path_buf())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Tag `tmp`, then move it to `dest` (removing `tmp` on failure).
fn finish_file(tmp: &Path, dest: &Path, tags: &TagInfo, http: &Http, cancel: &AtomicBool) -> Result<PathBuf, String> {
    let result = (|| {
        if cancel.load(Ordering::Relaxed) {
            return Err("canceled".to_string());
        }
        // Tagging failures are not fatal: the audio is intact, only metadata is missing.
        let _ = write_tags(tmp, tags, http);
        if cancel.load(Ordering::Relaxed) {
            return Err("canceled".into());
        }
        std::fs::rename(tmp, dest).map_err(|e| format!("move into place: {e}"))?;
        Ok(dest.to_path_buf())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

/// An archive entry saved as-is (`run` has already fetched the archive, reporting its bytes).
fn save_entry(source: &SourceSpec, entry: &str, dest: &Path, tags: &TagInfo, ctx: &OpenCtx<'_>, rep: &mut Reporter) -> Result<PathBuf, String> {
    let set = source::archive_cache::get(source, ctx).map_err(|e| e.message)?;
    let (_, data) = set.find(entry).ok_or_else(|| format!("archive has no entry '{entry}'"))?;
    let tmp = temp_path(dest, rep.gen);
    std::fs::write(&tmp, &data[..]).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("write {}: {e}", tmp.display())
    })?;
    let n = data.len() as u64;
    rep.progress(n, Some(n), true);
    finish_file(&tmp, dest, tags, &ctx.cache.http, &ctx.cancel)
}

/// `dest` with a `.flac` extension (replacing a known audio / chip / archive extension), made
/// unique if that file already exists.
fn flac_dest(dest: &Path) -> PathBuf {
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "download".into());
    let stem = match ghost_formats::extension_of(&name) {
        Some(e) if e == "flac" => return dest.to_path_buf(),
        Some(e)
            if e == "bin"
                || ghost_formats::family_for_extension(&e).is_some()
                || ghost_formats::detect::is_common_extension(&e)
                || ghost_formats::archive::is_archive_extension(&e) =>
        {
            name[..name.len() - e.len() - 1].to_string()
        }
        _ => name,
    };
    let mut p = dest.with_file_name(format!("{stem}.flac"));
    let mut i = 2;
    while p.exists() {
        p = dest.with_file_name(format!("{stem} ({i}).flac"));
        i += 1;
    }
    p
}

/// Decode `source` through the loop stage and encode it to FLAC.
fn render_flac(source: &SourceSpec, dest: &Path, tags: &TagInfo, loops: (LoopMode, u32, f32), ctx: &OpenCtx<'_>, rep: &mut Reporter) -> Result<PathBuf, String> {
    rep.progress(0, None, true);
    let opened = source::open_detailed(source, ctx).map_err(|e| e.message)?;
    let meta = opened.source.meta();
    let mut st = LoopStage::new(opened.source, Arc::new(LoopSettings::fixed(LoopSettings::finite(loops))));
    let rate = st.sample_rate().max(1);
    let ch = st.channels().max(1);
    let out_ch = ch.min(2);
    // Emulators and trackers produce 16-bit audio; decoded lossy/hi-res streams keep 24.
    let bits = if opened.family.is_some() { 16 } else { 24 };
    let bpf = (out_ch * bits / 8) as u64;
    let total = st.duration().map(|f| f * bpf);
    let dest = flac_dest(dest);
    let tmp = temp_path(&dest, rep.gen);
    let result = (|| {
        let mut w = FlacWriter::create(&tmp, rate, out_ch, bits).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        let mut buf = vec![0.0f32; 4096 * ch];
        let mut stereo = Vec::with_capacity(4096 * 2);
        let max_frames = MAX_RENDER_SEC * rate as u64;
        rep.progress(0, total, true);
        loop {
            if ctx.cancel.load(Ordering::Relaxed) {
                return Err("canceled".to_string());
            }
            let n = st.read(&mut buf).map_err(|e| e.message)?;
            if n == 0 {
                break;
            }
            if ch > 2 {
                stereo.clear();
                source::to_stereo(&buf[..n * ch], ch, &mut stereo);
                w.write(&stereo).map_err(|e| format!("write: {e}"))?;
            } else {
                w.write(&buf[..n * ch]).map_err(|e| format!("write: {e}"))?;
            }
            if w.frames() > max_frames {
                return Err(format!("source did not end within {} hours", MAX_RENDER_SEC / 3600));
            }
            rep.progress(w.frames() * bpf, total, false);
        }
        w.finish().map_err(|e| format!("write: {e}"))?;
        // Final progress in real file bytes (bytes == total), like a copy, before tagging.
        let size = file_len(&tmp);
        rep.progress(size, Some(size), true);
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let mut tags = tags.clone();
    if tags.title.is_empty() {
        tags.title = meta.title.clone().unwrap_or_default();
    }
    if tags.album.is_empty() {
        tags.album = meta.album.clone().unwrap_or_default();
    }
    if tags.artist.is_none() {
        tags.artist = meta.artist.clone();
    }
    finish_file(&tmp, &dest, &tags, &ctx.cache.http, &ctx.cancel)
}

fn copy(src: &mut dyn Read, dst: &mut File, total: Option<u64>, cancel: &AtomicBool, rep: &mut Reporter) -> Result<u64, String> {
    let mut buf = vec![0u8; 256 * 1024];
    let mut n_total = 0u64;
    rep.progress(0, total, true);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("canceled".into());
        }
        let n = src.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).map_err(|e| format!("write: {e}"))?;
        n_total += n as u64;
        rep.progress(n_total, total, false);
    }
    Ok(n_total)
}

fn sniff_mime(b: &[u8]) -> lofty::picture::MimeType {
    use lofty::picture::MimeType;
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        MimeType::Jpeg
    } else if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        MimeType::Png
    } else if b.starts_with(b"GIF8") {
        MimeType::Gif
    } else if b.starts_with(b"BM") {
        MimeType::Bmp
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        MimeType::Unknown("image/webp".into())
    } else {
        MimeType::Jpeg
    }
}

/// Write tags to an audio file in place (format detected from its contents).
pub fn write_tags(path: &Path, t: &TagInfo, http: &Http) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::picture::{Picture, PictureType};
    use lofty::prelude::*;
    use lofty::tag::Tag;

    let tagged = lofty::probe::Probe::open(path)
        .map_err(|e| e.to_string())?
        .guess_file_type()
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;
    let mut tag = Tag::new(tagged.primary_tag_type());
    if !t.title.is_empty() {
        tag.set_title(t.title.clone());
    }
    if !t.album.is_empty() {
        tag.set_album(t.album.clone());
    }
    if let Some(v) = &t.artist {
        tag.set_artist(v.clone());
    }
    if let Some(v) = &t.album_artist {
        tag.insert_text(ItemKey::AlbumArtist, v.clone());
    }
    if let Some(v) = &t.composer {
        tag.insert_text(ItemKey::Composer, v.clone());
    }
    if let Some(v) = t.track_number {
        tag.set_track(v);
    }
    if let Some(v) = t.track_total {
        tag.set_track_total(v);
    }
    if let Some(v) = t.disc_number {
        tag.set_disk(v);
    }
    if let Some(y) = t.year {
        tag.set_date(lofty::tag::items::Timestamp { year: y.min(9999) as u16, ..Default::default() });
    }
    if let Some(v) = &t.genre {
        tag.set_genre(v.clone());
    }
    if let Some(v) = &t.comment {
        tag.set_comment(v.clone());
    }
    if let Some(g) = t.replay_gain_track_db {
        tag.insert_text(ItemKey::ReplayGainTrackGain, format!("{g:.2} dB"));
    }
    if let Some(p) = t.replay_gain_track_peak {
        tag.insert_text(ItemKey::ReplayGainTrackPeak, format!("{p:.6}"));
    }
    if let Some(url) = &t.cover_url {
        if let Ok(bytes) = http.get_bytes(url, 16 * 1024 * 1024) {
            if !bytes.is_empty() {
                let mime = sniff_mime(&bytes);
                tag.push_picture(Picture::unchecked(bytes).pic_type(PictureType::CoverFront).mime_type(mime).build());
            }
        }
    }
    tag.save_to_path(path, WriteOptions::default()).map_err(|e| e.to_string())
}
