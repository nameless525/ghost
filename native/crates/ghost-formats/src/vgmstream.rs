//! libvgmstream (r2117, `libvgmstream.h` API): ADX, HCA, BRSTM/BCSTM/BFSTM, FSB, Wwise, and the
//! hundreds of other game-engine formats it parses natively. Codecs that vgmstream only supports
//! through FFmpeg (XMA, ATRAC3/3plus, AAC, Opus-in-containers, ...), mpg123 (MPEG-in-containers),
//! or other external libraries (ATRAC9, CELT, Speex, G.719) are not built; Vorbis-based formats
//! are (libvorbis is vendored), and so is G.722.1 (vgmstream's own decoder).
//!
//! I/O goes through [`FileOpener`] / [`ByteSource`] callbacks, so a stream can be decoded while it
//! is still downloading into the engine's cache, and companion files (`.txth`, `.awb` next to an
//! `.acb`, ...) resolve inside the same archive or directory.
//!
//! Looped files are opened with `play_forever`, so vgmstream itself wraps from `loop_end` to
//! `loop_start` (sample-exact, with its loop-start decoder snapshot); the seek the engine's loop
//! stage issues at that point is a no-op.

use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Once};

use crate::source::{AudioSource, LoopInfo, SourceError, SourceMeta};
use crate::{extension_of, file_name_of, OpenOptions};

// ------------------------------------------------------------------------------------------- FFI

#[repr(C)]
struct LibStreamfile {
    user_data: *mut c_void,
    read: Option<unsafe extern "C" fn(*mut c_void, *mut u8, i64, c_int) -> c_int>,
    get_size: Option<unsafe extern "C" fn(*mut c_void) -> i64>,
    get_name: Option<unsafe extern "C" fn(*mut c_void) -> *const c_char>,
    open: Option<unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut LibStreamfile>,
    close: Option<unsafe extern "C" fn(*mut LibStreamfile)>,
}

const SFMT_PCM16: c_int = 1;
const SFMT_PCM24: c_int = 2;
const SFMT_PCM32: c_int = 3;
const SFMT_FLOAT: c_int = 4;
/// Largest output sample vgmstream writes (float / 32-bit PCM).
const MAX_SAMPLE_SIZE: usize = 4;

#[repr(C)]
struct Format {
    channels: c_int,
    sample_rate: c_int,
    sample_format: c_int,
    sample_size: c_int,
    channel_layout: u32,
    subsong_index: c_int,
    subsong_count: c_int,
    input_channels: c_int,
    stream_samples: i64,
    loop_start: i64,
    loop_end: i64,
    loop_flag: bool,
    play_forever: bool,
    play_samples: i64,
    stream_bitrate: c_int,
    codec_name: [c_char; 128],
    layout_name: [c_char; 128],
    meta_name: [c_char; 128],
    stream_name: [c_char; 256],
    format_id: c_int,
}

#[repr(C)]
struct Decoder {
    buf: *mut c_void,
    buf_samples: c_int,
    buf_bytes: c_int,
    done: bool,
}

#[repr(C)]
struct Lib {
    priv_: *mut c_void,
    format: *const Format,
    decoder: *mut Decoder,
}

#[repr(C)]
#[derive(Default)]
struct Config {
    disable_config_override: bool,
    allow_play_forever: bool,
    play_forever: bool,
    ignore_loop: bool,
    force_loop: bool,
    really_force_loop: bool,
    ignore_fade: bool,
    loop_count: f64,
    fade_time: f64,
    fade_delay: f64,
    stereo_track: c_int,
    auto_downmix_channels: c_int,
    force_sfmt: c_int,
}

#[repr(C)]
#[derive(Default)]
struct Valid {
    is_extension: bool,
    skip_standard: bool,
    reject_extensionless: bool,
    accept_unknown: bool,
    accept_common: bool,
}

extern "C" {
    fn libvgmstream_init() -> *mut Lib;
    fn libvgmstream_free(lib: *mut Lib);
    fn libvgmstream_setup(lib: *mut Lib, cfg: *mut Config);
    fn libvgmstream_open_stream(lib: *mut Lib, libsf: *mut LibStreamfile, subsong: c_int) -> c_int;
    fn libvgmstream_fill(lib: *mut Lib, buf: *mut c_void, buf_samples: c_int) -> c_int;
    fn libvgmstream_seek(lib: *mut Lib, sample: i64);
    fn libvgmstream_is_valid(filename: *const c_char, cfg: *mut Valid) -> bool;
    fn libvgmstream_set_log(level: c_int, callback: Option<unsafe extern "C" fn(c_int, *const c_char)>);
}

const LOG_LEVEL_NONE: c_int = 100;

fn init_once() {
    static INIT: Once = Once::new();
    INIT.call_once(|| unsafe { libvgmstream_set_log(LOG_LEVEL_NONE, None) });
}

/// True if vgmstream handles this extension (excluding common formats like wav/ogg/mp3).
pub fn is_extension_supported(ext: &str) -> bool {
    init_once();
    let Ok(c) = CString::new(ext) else { return false };
    let mut v = Valid { is_extension: true, reject_extensionless: true, ..Default::default() };
    unsafe { libvgmstream_is_valid(c.as_ptr(), &mut v) }
}

// ------------------------------------------------------------------------------------------- I/O

/// Random-access bytes of one file.
pub trait ByteSource: Send {
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> std::io::Result<usize>;
    fn size(&self) -> u64;
}

/// Opens the main file (by its own name) and companion files vgmstream asks for by name.
pub trait FileOpener: Send + Sync {
    fn open(&self, name: &str) -> Option<Box<dyn ByteSource>>;
}

/// `ByteSource` over any `Read + Seek` (e.g. the engine's cache reader or a `File`).
pub struct ReadSeekSource<R: Read + Seek + Send> {
    inner: R,
    size: u64,
    pos: u64,
}

impl<R: Read + Seek + Send> ReadSeekSource<R> {
    pub fn new(mut inner: R, size: Option<u64>) -> std::io::Result<Self> {
        let size = match size {
            Some(s) => s,
            None => inner.seek(SeekFrom::End(0))?,
        };
        inner.seek(SeekFrom::Start(0))?;
        Ok(Self { inner, size, pos: 0 })
    }
}

impl<R: Read + Seek + Send> ByteSource for ReadSeekSource<R> {
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> std::io::Result<usize> {
        if offset >= self.size {
            return Ok(0);
        }
        if offset != self.pos {
            self.inner.seek(SeekFrom::Start(offset))?;
            self.pos = offset;
        }
        let want = buf.len().min((self.size - offset) as usize);
        let mut got = 0;
        while got < want {
            let n = self.inner.read(&mut buf[got..want])?;
            if n == 0 {
                break;
            }
            got += n;
        }
        self.pos += got as u64;
        Ok(got)
    }
    fn size(&self) -> u64 {
        self.size
    }
}

/// `ByteSource` over shared bytes.
pub struct MemorySource(pub Arc<[u8]>);

impl ByteSource for MemorySource {
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> std::io::Result<usize> {
        let d = &self.0;
        if offset >= d.len() as u64 {
            return Ok(0);
        }
        let o = offset as usize;
        let n = buf.len().min(d.len() - o);
        buf[..n].copy_from_slice(&d[o..o + n]);
        Ok(n)
    }
    fn size(&self) -> u64 {
        self.0.len() as u64
    }
}

/// In-memory files by name (an extracted archive, or a single downloaded file). Lookups ignore
/// case and directory separators style, and fall back to the base name when it is unique.
#[derive(Default)]
pub struct MemoryOpener {
    files: HashMap<String, Arc<[u8]>>,
}

impl MemoryOpener {
    pub fn single(name: &str, data: Vec<u8>) -> Self {
        let mut o = Self::default();
        o.insert(name, Arc::from(data));
        o
    }
    pub fn insert(&mut self, name: &str, data: Arc<[u8]>) {
        self.files.insert(normalize(name), data);
    }
    fn lookup(&self, name: &str) -> Option<Arc<[u8]>> {
        let n = normalize(name);
        if let Some(d) = self.files.get(&n) {
            return Some(d.clone());
        }
        // vgmstream builds companion paths relative to the main file's name; match on the tail.
        let base = file_name_of(&n);
        let mut hits = self.files.iter().filter(|(k, _)| file_name_of(k) == base);
        match (hits.next(), hits.next()) {
            (Some((_, d)), None) => Some(d.clone()),
            _ => None,
        }
    }
}

fn normalize(name: &str) -> String {
    name.replace('\\', "/").trim_start_matches("./").to_lowercase()
}

impl FileOpener for MemoryOpener {
    fn open(&self, name: &str) -> Option<Box<dyn ByteSource>> {
        self.lookup(name).map(|d| Box::new(MemorySource(d)) as Box<dyn ByteSource>)
    }
}

/// Files on disk. vgmstream names companions after the main file's own name (its directory plus
/// the companion's name), so give the main file as an absolute path; a bare name resolves in `dir`.
pub struct FsOpener {
    pub dir: PathBuf,
}

impl FileOpener for FsOpener {
    fn open(&self, name: &str) -> Option<Box<dyn ByteSource>> {
        let p = Path::new(name);
        let path = if p.is_absolute() { p.to_path_buf() } else { self.dir.join(p) };
        let f = std::fs::File::open(&path).ok()?;
        let size = f.metadata().ok()?.len();
        Some(Box::new(ReadSeekSource::new(std::io::BufReader::with_capacity(64 * 1024, f), Some(size)).ok()?))
    }
}

/// One open streamfile: the byte source, a read cache, and the opener for companions.
struct Sf {
    io: Box<dyn ByteSource>,
    size: u64,
    name: CString,
    opener: Arc<dyn FileOpener>,
    cache: Vec<u8>,
    cache_off: u64,
    cache_len: usize,
}

const SF_CACHE: usize = 64 * 1024;

impl Sf {
    fn read(&mut self, dst: &mut [u8], offset: u64) -> usize {
        let mut done = 0;
        while done < dst.len() {
            let off = offset + done as u64;
            if off >= self.size {
                break;
            }
            let in_cache = off >= self.cache_off && off < self.cache_off + self.cache_len as u64;
            if !in_cache {
                if dst.len() - done >= SF_CACHE {
                    // Large read: straight through.
                    match self.io.read_at(off, &mut dst[done..]) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            done += n;
                            continue;
                        }
                    }
                }
                self.cache.resize(SF_CACHE, 0);
                match self.io.read_at(off, &mut self.cache) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        self.cache_off = off;
                        self.cache_len = n;
                    }
                }
            }
            let start = (off - self.cache_off) as usize;
            let n = (self.cache_len - start).min(dst.len() - done);
            dst[done..done + n].copy_from_slice(&self.cache[start..start + n]);
            done += n;
        }
        done
    }
}

fn new_libsf(io: Box<dyn ByteSource>, name: &str, opener: Arc<dyn FileOpener>) -> *mut LibStreamfile {
    let size = io.size();
    let sf = Box::new(Sf {
        io,
        size,
        name: CString::new(name.replace('\0', "")).unwrap_or_default(),
        opener,
        cache: Vec::new(),
        cache_off: 0,
        cache_len: 0,
    });
    Box::into_raw(Box::new(LibStreamfile {
        user_data: Box::into_raw(sf) as *mut c_void,
        read: Some(sf_read),
        get_size: Some(sf_get_size),
        get_name: Some(sf_get_name),
        open: Some(sf_open),
        close: Some(sf_close),
    }))
}

unsafe extern "C" fn sf_read(user: *mut c_void, dst: *mut u8, offset: i64, length: c_int) -> c_int {
    if user.is_null() || dst.is_null() || length <= 0 || offset < 0 {
        return 0;
    }
    let sf = unsafe { &mut *(user as *mut Sf) };
    let buf = unsafe { std::slice::from_raw_parts_mut(dst, length as usize) };
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sf.read(buf, offset as u64))).unwrap_or(0) as c_int
}

unsafe extern "C" fn sf_get_size(user: *mut c_void) -> i64 {
    if user.is_null() {
        return 0;
    }
    unsafe { (*(user as *mut Sf)).size as i64 }
}

unsafe extern "C" fn sf_get_name(user: *mut c_void) -> *const c_char {
    if user.is_null() {
        return std::ptr::null();
    }
    unsafe { (*(user as *mut Sf)).name.as_ptr() }
}

unsafe extern "C" fn sf_open(user: *mut c_void, filename: *const c_char) -> *mut LibStreamfile {
    if user.is_null() || filename.is_null() {
        return std::ptr::null_mut();
    }
    let sf = unsafe { &*(user as *mut Sf) };
    let Ok(name) = unsafe { CStr::from_ptr(filename) }.to_str() else { return std::ptr::null_mut() };
    let name = name.to_string();
    let opener = sf.opener.clone();
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match opener.open(&name) {
        Some(io) => new_libsf(io, &name, opener.clone()),
        None => std::ptr::null_mut(),
    }))
    .unwrap_or(std::ptr::null_mut())
}

unsafe extern "C" fn sf_close(libsf: *mut LibStreamfile) {
    if libsf.is_null() {
        return;
    }
    let b = unsafe { Box::from_raw(libsf) };
    if !b.user_data.is_null() {
        // Drops the caller's ByteSource (e.g. a cache reader): a panic must not unwind into C.
        let sf = unsafe { Box::from_raw(b.user_data as *mut Sf) };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || drop(sf)));
    }
}

// ------------------------------------------------------------------------------------------- source

/// vgmstream's Relic codec runs its FFT in file-scope static scratch variables
/// (`coding/libs/relic_mixfft.c`): two Relic streams decoding at once on different threads would
/// corrupt each other (and index arrays with the other's indices). Their decoding is serialised.
static RELIC: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// An initialised libvgmstream handle, freed on drop: every early return after `libvgmstream_init`
/// releases it, and its format can't be read after it is gone.
struct Handle(*mut Lib);

impl Handle {
    fn format(&self) -> Option<&Format> {
        unsafe { (*self.0).format.as_ref() }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { libvgmstream_free(self.0) };
    }
}

pub struct VgmstreamSource {
    lib: Handle,
    /// Holds [`RELIC`] while decoding.
    relic: bool,
    rate: u32,
    channels: usize,
    /// vgmstream's WAVE channel mask, when the format declares one.
    mask: Option<u32>,
    sfmt: c_int,
    sample_size: usize,
    pos: u64,
    loop_info: Option<LoopInfo>,
    duration: Option<u64>,
    meta: SourceMeta,
    raw: Vec<u8>,
    ended: bool,
}

// libvgmstream state is only touched by the owning thread.
unsafe impl Send for VgmstreamSource {}

fn c_text(buf: &[c_char]) -> Option<String> {
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    let s = crate::decode_text(&bytes);
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

impl VgmstreamSource {
    /// Open `name` through `opener` (which must also serve `name` itself for re-opens).
    pub fn open(name: &str, opener: Arc<dyn FileOpener>, opts: &OpenOptions) -> Result<Self, SourceError> {
        init_once();
        // vgmstream subsongs are 1-based (0 = default) C ints.
        let subsong = match opts.subsong {
            None => 0,
            Some(s) => s.checked_add(1).and_then(|s| c_int::try_from(s).ok()).ok_or_else(|| SourceError::new(format!("sub-song {s} out of range")))?,
        };
        let io = opener.open(name).ok_or_else(|| SourceError::new(format!("vgmstream: cannot open {name}")))?;
        let raw = unsafe { libvgmstream_init() };
        if raw.is_null() {
            return Err(SourceError::new("vgmstream: init failed"));
        }
        let lib = Handle(raw);
        // Native sample format (16-bit for most codecs, float for a few): converted here exactly
        // like the rest of the engine does (vgmstream's own s16→float scales by 1/32767).
        let mut cfg = Config { allow_play_forever: true, play_forever: true, loop_count: 1.0, ..Default::default() };
        unsafe { libvgmstream_setup(lib.0, &mut cfg) };
        let libsf = new_libsf(io, name, opener);
        let r = unsafe { libvgmstream_open_stream(lib.0, libsf, subsong) };
        // vgmstream re-opens what it needs; the initial streamfile is ours to close.
        unsafe { sf_close(libsf) };
        let f = match lib.format() {
            Some(f) if r >= 0 => f,
            _ => return Err(SourceError::new(format!("vgmstream: unsupported or corrupt file ({})", file_name_of(name)))),
        };
        if !matches!(f.sample_format, SFMT_PCM16 | SFMT_PCM24 | SFMT_PCM32 | SFMT_FLOAT) || !(1..=MAX_SAMPLE_SIZE as c_int).contains(&f.sample_size) {
            return Err(SourceError::new(format!("vgmstream: unsupported sample format {}", f.sample_format)));
        }
        // A file without sub-songs (count 0) or with one only has sub-song 0.
        let count = f.subsong_count.max(1) as u32;
        if let Some(s) = opts.subsong.filter(|&s| s >= count) {
            return Err(SourceError::new(format!("sub-song {s} out of range (file has {count})")));
        }
        let rate = f.sample_rate.max(1) as u32;
        let channels = f.channels.max(1) as usize;
        let mask = (f.channel_layout != 0).then_some(f.channel_layout);
        let stream = f.stream_samples.max(0) as u64;
        let loop_info = (f.play_forever && f.loop_flag && f.loop_end > f.loop_start && f.loop_start >= 0)
            .then_some(LoopInfo { start: f.loop_start as u64, end: f.loop_end as u64 });
        let ext = extension_of(name).unwrap_or_else(|| "vgmstream".into());
        let meta = SourceMeta {
            codec: ext,
            bitrate_kbps: (f.stream_bitrate > 0).then_some((f.stream_bitrate / 1000) as u32),
            title: c_text(&f.stream_name),
            system: c_text(&f.meta_name),
            comment: c_text(&f.codec_name),
            subsong_count: (f.subsong_count > 1).then_some(f.subsong_count as u32),
            subsong: (f.subsong_count > 1).then(|| (f.subsong_index.max(1) - 1) as u32),
            ..Default::default()
        };
        let duration = Some(loop_info.map_or(stream, |l| stream.max(l.end)));
        let sample_size = f.sample_size as usize;
        let relic = c_text(&f.codec_name).is_some_and(|c| c.starts_with("Relic"));
        let sfmt = f.sample_format;
        Ok(Self { lib, relic, rate, channels, mask, sfmt, sample_size, pos: 0, loop_info, duration, meta, raw: Vec::new(), ended: false })
    }
}

impl AudioSource for VgmstreamSource {
    fn sample_rate(&self) -> u32 {
        self.rate
    }
    fn channels(&self) -> usize {
        self.channels
    }
    fn channel_mask(&self) -> Option<u32> {
        self.mask
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, SourceError> {
        if self.ended {
            return Ok(0);
        }
        let ch = self.channels;
        let frames = (out.len() / ch).min(4096);
        if frames == 0 {
            return Ok(0);
        }
        let ss = self.sample_size;
        // Room for the widest sample vgmstream writes, whatever the format claims (grow-only, so
        // reads of varying size don't re-zero it each time).
        if self.raw.len() < frames * ch * MAX_SAMPLE_SIZE {
            self.raw.resize(frames * ch * MAX_SAMPLE_SIZE, 0);
        }
        let _relic = self.relic.then(|| RELIC.lock());
        let r = unsafe { libvgmstream_fill(self.lib.0, self.raw.as_mut_ptr() as *mut c_void, frames as c_int) };
        if r < 0 {
            return Err(SourceError::new("vgmstream: decode error"));
        }
        let dec = unsafe { &*(*self.lib.0).decoder };
        let got = (dec.buf_samples.max(0) as usize).min(frames);
        if dec.done {
            self.ended = true;
        }
        let n = got * ch;
        match (self.sfmt, ss) {
            (SFMT_FLOAT, 4) => {
                for (o, b) in out[..n].iter_mut().zip(self.raw.as_chunks::<4>().0) {
                    *o = f32::from_le_bytes(*b);
                }
            }
            (_, 2) => {
                for (o, b) in out[..n].iter_mut().zip(self.raw.as_chunks::<2>().0) {
                    *o = i16::from_le_bytes(*b) as f32 / 32768.0;
                }
            }
            (_, 3) => {
                for (o, b) in out[..n].iter_mut().zip(self.raw.as_chunks::<3>().0) {
                    *o = (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0;
                }
            }
            (SFMT_PCM24, _) => {
                // 24-bit samples in 32-bit containers.
                for (o, b) in out[..n].iter_mut().zip(self.raw.as_chunks::<4>().0) {
                    *o = ((i32::from_le_bytes(*b) << 8) >> 8) as f32 / 8_388_608.0;
                }
            }
            _ => {
                for (o, b) in out[..n].iter_mut().zip(self.raw.as_chunks::<4>().0) {
                    *o = i32::from_le_bytes(*b) as f32 / 2_147_483_648.0;
                }
            }
        }
        self.pos += got as u64;
        Ok(got)
    }

    fn seek(&mut self, frame: u64) -> Result<u64, SourceError> {
        if let Some(l) = self.loop_info {
            if frame == l.start && self.pos == l.end && !self.ended {
                // vgmstream already wrapped (play_forever): keep decoding.
                self.pos = frame;
                return Ok(frame);
            }
        }
        let frame = frame.min(i64::MAX as u64);
        let _relic = self.relic.then(|| RELIC.lock());
        unsafe { libvgmstream_seek(self.lib.0, frame as i64) };
        self.pos = frame;
        self.ended = self.loop_info.is_none() && self.duration.is_some_and(|d| frame >= d);
        Ok(frame)
    }

    fn duration(&self) -> Option<u64> {
        self.duration
    }
    fn loop_info(&self) -> Option<LoopInfo> {
        self.loop_info
    }
    fn meta(&self) -> SourceMeta {
        self.meta.clone()
    }
}
