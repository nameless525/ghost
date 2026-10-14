//! Downloads (DESIGN §2): copy from the stream cache when the file is whole, otherwise fetch it
//! through the cache with progress; write to a temp file next to `dest`, tag it with lofty, then
//! rename into place. A new download with an id that is already running replaces the old job.

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
use crate::http::Http;
use crate::{DownloadStatus, EngineEvent, SourceSpec, TagInfo};

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
    pub fn start(&self, id: String, source: SourceSpec, dest: PathBuf, tags: TagInfo, cache: Arc<CacheManager>, events: Sender<EngineEvent>) {
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
            match run(&source, &dest, &tags, &cache, &cancel, &mut rep) {
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

fn run(
    source: &SourceSpec,
    dest: &Path,
    tags: &TagInfo,
    cache: &Arc<CacheManager>,
    cancel: &Arc<AtomicBool>,
    rep: &mut Reporter,
) -> Result<PathBuf, String> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
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
