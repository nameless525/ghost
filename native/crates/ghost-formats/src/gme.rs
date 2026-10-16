//! libgme (Game_Music_Emu 0.6.5): NSF/NSFE, SPC, GBS, VGM/VGZ, HES, KSS, AY, SAP, GYM.
//!
//! Timing, in order of preference:
//! - VGM loop header: exact intro/loop sample counts (rendered at 44.1 kHz, the VGM clock).
//! - A NEZPlug `.m3u` line for this file + track (rip sets ship them): length, intro/loop, fade.
//! - The file's own tags (NSFE `time`/`fade`, SPC ID666): length + fade.
//! - Nothing: 2:30 + fade (foobar2000's convention).
//!
//! The emulated music loops on its own, so a seek to `loop.start` right after reaching
//! `loop.end` just carries on (see the crate docs).

use std::ffi::{c_char, c_int, c_long, c_void, CString};

use crate::source::{AudioSource, LengthHint, LoopInfo, SourceError, SourceMeta};
use crate::{cstr_opt, extension_of, ms_to_frames, nezplug, OpenOptions, DEFAULT_LENGTH_MS};

#[repr(C)]
struct MusicEmu {
    _p: [u8; 0],
}

#[repr(C)]
struct GmeInfo {
    length: c_int,
    intro_length: c_int,
    loop_length: c_int,
    play_length: c_int,
    fade_length: c_int,
    _i: [c_int; 11],
    system: *const c_char,
    game: *const c_char,
    song: *const c_char,
    author: *const c_char,
    copyright: *const c_char,
    comment: *const c_char,
    dumper: *const c_char,
    _s: [*const c_char; 9],
}

type GmeType = *const c_void;
type GmeErr = *const c_char;

extern "C" {
    fn gme_identify_header(header: *const c_void) -> *const c_char;
    fn gme_identify_extension(path_or_extension: *const c_char) -> GmeType;
    fn gme_new_emu(t: GmeType, sample_rate: c_int) -> *mut MusicEmu;
    fn gme_load_data(emu: *mut MusicEmu, data: *const c_void, size: c_long) -> GmeErr;
    fn gme_load_m3u_data(emu: *mut MusicEmu, data: *const c_void, size: c_long) -> GmeErr;
    fn gme_track_count(emu: *const MusicEmu) -> c_int;
    fn gme_start_track(emu: *mut MusicEmu, index: c_int) -> GmeErr;
    fn gme_play(emu: *mut MusicEmu, count: c_int, out: *mut i16) -> GmeErr;
    fn gme_delete(emu: *mut MusicEmu);
    fn gme_set_autoload_playback_limit(emu: *mut MusicEmu, do_autoload_limit: c_int);
    fn gme_track_ended(emu: *const MusicEmu) -> c_int;
    fn gme_seek_samples(emu: *mut MusicEmu, n: c_int) -> GmeErr;
    fn gme_track_info(emu: *const MusicEmu, out: *mut *mut GmeInfo, track: c_int) -> GmeErr;
    fn gme_free_info(info: *mut GmeInfo);
    fn gme_voice_count(emu: *const MusicEmu) -> c_int;
    fn gme_voice_name(emu: *const MusicEmu, i: c_int) -> *const c_char;
    fn gme_mute_voices(emu: *mut MusicEmu, muting_mask: c_int);
    fn gme_type_extension(t: GmeType) -> *const c_char;
    fn gme_ignore_silence(emu: *mut MusicEmu, ignore: c_int);
}

fn check(err: GmeErr, what: &str) -> Result<(), SourceError> {
    if err.is_null() {
        return Ok(());
    }
    Err(SourceError::new(format!("{what}: {}", cstr_opt(err).unwrap_or_else(|| "error".into()))))
}

/// Extension libgme associates with this header (e.g. "NSF", "SPC"), if any.
pub fn identify_header(head: &[u8]) -> Option<&'static str> {
    if head.len() < 4 {
        return None;
    }
    let p = unsafe { gme_identify_header(head.as_ptr() as *const c_void) };
    if p.is_null() {
        return None;
    }
    let s = unsafe { std::ffi::CStr::from_ptr(p) }.to_str().ok()?;
    (!s.is_empty()).then_some(s)
}

/// Gunzip VGZ data (and any other gzip-wrapped chip file).
pub fn gunzip_if_needed(data: Vec<u8>) -> Result<Vec<u8>, SourceError> {
    if !data.starts_with(&[0x1F, 0x8B]) {
        return Ok(data);
    }
    use std::io::Read;
    let mut out = Vec::with_capacity(data.len() * 4);
    flate2::read::MultiGzDecoder::new(&data[..])
        .take(256 * 1024 * 1024)
        .read_to_end(&mut out)
        .map_err(|e| SourceError::new(format!("vgz: {e}")))?;
    Ok(out)
}

/// Exact VGM timing in 44.1 kHz samples: (total, loop samples if it loops).
fn vgm_timing(data: &[u8]) -> Option<(u64, Option<u64>)> {
    if data.len() < 0x24 || &data[..4] != b"Vgm " {
        return None;
    }
    let u32_at = |o: usize| u32::from_le_bytes(data[o..o + 4].try_into().unwrap()) as u64;
    let total = u32_at(0x18);
    let loop_offset = u32_at(0x1C);
    let loop_samples = u32_at(0x20);
    if total == 0 {
        // A header without a length (broken rip): fall back to the default play time rather
        // than a zero-length track.
        return None;
    }
    let looped = (loop_offset != 0 && loop_samples > 0 && loop_samples <= total).then_some(loop_samples);
    Some((total, looped))
}

/// Largest FM chip clock accepted in a VGM header. Real chips run at 3.58 (YM2413) and 7.67 MHz
/// (YM2612); the cycle-accurate YM2612 core's cost grows with the clock.
const MAX_VGM_FM_CLOCK: u32 = 16_000_000;

/// Smallest SN76489 clock accepted in a VGM header (real chips: 3-4 MHz). Below ~30 Hz libgme's
/// frames are zero clocks long and produce no samples.
const MIN_VGM_PSG_CLOCK: u32 = 10_000;

/// Reject VGM headers whose chip clocks libgme can't emulate: a YM2612 clock that is zero after
/// the flag bits are masked off makes the Nuked core's resampler divide by zero (a hang on ARM,
/// SIGFPE on x86), an absurd one runs it hundreds of times slower than realtime, and a PSG clock
/// of a few Hz stalls the emulator. (0 means "chip absent", or the default clock for the PSG.)
fn check_vgm_clocks(data: &[u8]) -> Result<(), SourceError> {
    if data.len() < 0x30 || &data[..4] != b"Vgm " {
        return Ok(());
    }
    let psg = u32::from_le_bytes(data[0x0C..0x10].try_into().unwrap());
    if psg != 0 && psg < MIN_VGM_PSG_CLOCK {
        return Err(SourceError::new(format!("vgm: implausible SN76489 clock ({psg} Hz)")));
    }
    for (offset, chip) in [(0x10, "YM2413"), (0x2C, "YM2612")] {
        let raw = u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap());
        let clock = raw & 0x3FFF_FFFF; // bit 30: dual chip, bit 31: chip variant
        if raw != 0 && !(1_000_000..=MAX_VGM_FM_CLOCK).contains(&clock) {
            return Err(SourceError::new(format!("vgm: implausible {chip} clock ({clock} Hz)")));
        }
    }
    Ok(())
}

/// Whether libgme's info gives `track` its own length or loop (a playlist line, NSFE / SPC tags):
/// the same fields [`GmeSource::open`] times the track by.
fn has_timing(emu: *mut MusicEmu, track: c_int) -> bool {
    let mut info: *mut GmeInfo = std::ptr::null_mut();
    if !unsafe { gme_track_info(emu, &mut info, track) }.is_null() || info.is_null() {
        return false;
    }
    let i = unsafe { &*info };
    let timed = (i.loop_length > 0 && i.intro_length >= 0) || i.length > 0;
    unsafe { gme_free_info(info) };
    timed
}

/// Furthest frame `gme_seek_samples` can reach (`2 * frame` must fit a C int).
const MAX_SEEK_FRAME: u64 = (c_int::MAX / 2) as u64;

pub struct GmeSource {
    emu: *mut MusicEmu,
    track: c_int,
    rate: u32,
    pos: u64,
    loop_info: Option<LoopInfo>,
    hint: Option<LengthHint>,
    duration: Option<u64>,
    meta: SourceMeta,
    voices: usize,
    mask: u64,
    buf: Vec<i16>,
    ended: bool,
}

// The emulator is only ever touched by the thread that owns the source.
unsafe impl Send for GmeSource {}

impl Drop for GmeSource {
    fn drop(&mut self) {
        unsafe { gme_delete(self.emu) };
    }
}

impl GmeSource {
    pub fn open(data: Vec<u8>, name: &str, opts: &OpenOptions) -> Result<Self, SourceError> {
        let data = gunzip_if_needed(data)?;
        check_vgm_clocks(&data)?;
        // Some cores fill process-wide tables on first use without synchronisation (emu2413's
        // `initializeTables`, Nuked OPN2's chip type): build emulators one at a time.
        static OPEN: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
        let _one_at_a_time = OPEN.lock();
        let ext = extension_of(name).unwrap_or_default();
        let ext_c = CString::new(ext.as_str()).unwrap_or_default();
        let mut ty = unsafe { gme_identify_extension(ext_c.as_ptr()) };
        if ty.is_null() {
            if let Some(h) = identify_header(&data) {
                let h = CString::new(h).unwrap();
                ty = unsafe { gme_identify_extension(h.as_ptr()) };
            }
        }
        if ty.is_null() {
            return Err(SourceError::new("not a libgme format"));
        }
        let ty_ext = cstr_opt(unsafe { gme_type_extension(ty) }).unwrap_or_default().to_ascii_lowercase();
        // SPC's DSP runs at 32 kHz: render natively. VGM timing is defined at 44.1 kHz.
        let rate: u32 = if ty_ext == "spc" { 32_000 } else { 44_100 };
        let emu = unsafe { gme_new_emu(ty, rate as c_int) };
        if emu.is_null() {
            return Err(SourceError::new("libgme: out of memory"));
        }
        let mut src = GmeSource {
            emu,
            track: 0,
            rate,
            pos: 0,
            loop_info: None,
            hint: None,
            duration: None,
            meta: SourceMeta::default(),
            voices: 0,
            mask: 0,
            buf: Vec::new(),
            ended: false,
        };
        check(unsafe { gme_load_data(emu, data.as_ptr() as *const c_void, data.len() as c_long) }, "libgme load")?;
        let raw_count = unsafe { gme_track_count(emu) }.max(1) as u32;
        let subsong = opts.subsong.unwrap_or(0);
        if subsong >= raw_count {
            return Err(SourceError::new(format!("sub-song {subsong} out of range (file has {raw_count})")));
        }
        src.track = subsong as c_int;

        // A NEZPlug playlist line for exactly this track: load just that line, so the emulator's
        // track 0 is our sub-song and its info carries the playlist's name and timing.
        unsafe { gme_set_autoload_playback_limit(emu, 0) };
        let zero_based_decimal = ty_ext == "kss";
        // libgme skips up to 2 s of leading silence and ends a track after 6 s of it. A track the
        // engine times (VGM header, playlist line, tags) is timed from its true start and may hold
        // long quiet passages, so it plays as written; an untimed one keeps libgme's detection,
        // the only end a short jingle has.
        let vgm = vgm_timing(&data);
        let ignore_silence = |track: c_int| unsafe { gme_ignore_silence(emu, (vgm.is_some() || has_timing(emu, track)) as c_int) };
        let mut started = false;
        if let Some(m3u) = nezplug::playlist_for(&opts.playlists, name, subsong, zero_based_decimal) {
            let ok = unsafe { gme_load_m3u_data(emu, m3u.as_ptr() as *const c_void, m3u.len() as c_long) }.is_null() && unsafe { gme_track_count(emu) } >= 1;
            if ok {
                ignore_silence(0);
            }
            if ok && unsafe { gme_start_track(emu, 0) }.is_null() {
                src.track = 0;
                started = true;
            } else {
                // Unusable playlist: reload without it and play the raw track.
                check(unsafe { gme_load_data(emu, data.as_ptr() as *const c_void, data.len() as c_long) }, "libgme load")?;
                unsafe { gme_set_autoload_playback_limit(emu, 0) };
            }
        }
        if !started {
            ignore_silence(src.track);
            check(unsafe { gme_start_track(emu, src.track) }, "libgme start")?;
        }

        let mut info: *mut GmeInfo = std::ptr::null_mut();
        check(unsafe { gme_track_info(emu, &mut info, src.track) }, "libgme info")?;
        let (length, intro, loop_len, fade) = unsafe {
            let i = &*info;
            src.meta = SourceMeta {
                codec: if ty_ext.is_empty() { "gme".into() } else { ty_ext.clone() },
                bitrate_kbps: None,
                title: cstr_opt(i.song),
                artist: cstr_opt(i.author),
                album: cstr_opt(i.game),
                system: cstr_opt(i.system),
                copyright: cstr_opt(i.copyright),
                comment: cstr_opt(i.comment),
                subsong_count: (raw_count > 1).then_some(raw_count),
                subsong: Some(subsong),
                voice_names: Vec::new(),
            };
            let r = (i.length, i.intro_length, i.loop_length, i.fade_length);
            gme_free_info(info);
            r
        };
        let ms = |v: c_int| ms_to_frames(v.max(0) as u64, rate);

        if let Some((total, looped)) = vgm {
            match looped {
                Some(l) => src.loop_info = Some(LoopInfo { start: total - l, end: total }),
                None => src.hint = Some(LengthHint { length: total, fade: Some(0) }),
            }
            src.duration = Some(total);
        } else if loop_len > 0 && intro >= 0 {
            let li = LoopInfo { start: ms(intro), end: ms(intro) + ms(loop_len) };
            src.loop_info = Some(li);
            src.duration = Some(li.end);
        } else if length > 0 {
            src.hint = Some(LengthHint { length: ms(length), fade: (fade >= 0).then(|| ms(fade)) });
        } else {
            src.hint = Some(LengthHint { length: ms_to_frames(DEFAULT_LENGTH_MS, rate), fade: None });
        }

        src.voices = unsafe { gme_voice_count(emu) }.max(0) as usize;
        src.meta.voice_names = (0..src.voices).map(|i| cstr_opt(unsafe { gme_voice_name(emu, i as c_int) }).unwrap_or_else(|| format!("Voice {}", i + 1))).collect();
        Ok(src)
    }

    fn apply_mask(&mut self) {
        let m = (self.mask & ((1u64 << self.voices.min(31)) - 1)) as c_int;
        unsafe { gme_mute_voices(self.emu, m) };
    }
}

impl AudioSource for GmeSource {
    fn sample_rate(&self) -> u32 {
        self.rate
    }
    fn channels(&self) -> usize {
        2
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, SourceError> {
        if self.ended {
            return Ok(0);
        }
        let frames = (out.len() / 2).min(4096);
        if frames == 0 {
            return Ok(0);
        }
        // Grow-only scratch buffer: reads of varying size don't re-zero it each time.
        if self.buf.len() < frames * 2 {
            self.buf.resize(frames * 2, 0);
        }
        let buf = &mut self.buf[..frames * 2];
        check(unsafe { gme_play(self.emu, buf.len() as c_int, buf.as_mut_ptr()) }, "libgme")?;
        for (o, &s) in out.iter_mut().zip(buf.iter()) {
            *o = s as f32 * (1.0 / 32768.0);
        }
        self.pos += frames as u64;
        if unsafe { gme_track_ended(self.emu) } != 0 {
            self.ended = true;
        }
        Ok(frames)
    }

    fn seek(&mut self, frame: u64) -> Result<u64, SourceError> {
        if let Some(l) = self.loop_info {
            if frame == l.start && self.pos == l.end && !self.ended {
                // Natural wrap: the music driver is already playing the loop body again.
                self.pos = frame;
                return Ok(frame);
            }
        }
        // libgme counts positions in (stereo) samples in a C int: clamp to the last whole frame
        // it can address (an odd count would swap the channels).
        let frame = frame.min(MAX_SEEK_FRAME);
        check(unsafe { gme_seek_samples(self.emu, (frame * 2) as c_int) }, "libgme seek")?;
        self.apply_mask();
        self.pos = frame;
        self.ended = unsafe { gme_track_ended(self.emu) } != 0;
        Ok(frame)
    }

    fn duration(&self) -> Option<u64> {
        self.duration
    }
    fn loop_info(&self) -> Option<LoopInfo> {
        self.loop_info
    }
    fn length_hint(&self) -> Option<LengthHint> {
        self.hint
    }
    fn meta(&self) -> SourceMeta {
        self.meta.clone()
    }
    fn voice_count(&self) -> usize {
        self.voices
    }
    fn set_voice_mask(&mut self, mask: u64) {
        self.mask = mask;
        self.apply_mask();
        if self.pos == 0 && !self.ended {
            // start_track may already have rendered the first block (skipping leading silence);
            // render it again muted, so a track that starts muted is muted from its first sample.
            let _ = unsafe { gme_start_track(self.emu, self.track) };
            self.apply_mask();
        }
    }
}
