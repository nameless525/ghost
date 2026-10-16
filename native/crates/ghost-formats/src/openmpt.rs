//! libopenmpt (0.8.9): MOD/XM/IT/S3M/UMX/MO3/MPTM and ~50 other tracker formats.
//!
//! The module is played with `repeat_count = -1` (loop forever). Its loop is "one pass of the
//! song" (`get_duration_seconds`) followed by a jump back to the restart order/row, whose time
//! `get_time_at_position` reports; that becomes [`LoopInfo`], so the engine's Album mode plays
//! the song twice and fades, Endless keeps the module looping, Custom loops N times. Channels
//! can be muted through the `interactive` extension interface.

use std::ffi::{c_char, c_int, c_void, CString};

use crate::source::{AudioSource, LoopInfo, SourceError, SourceMeta};
use crate::{extension_of, OpenOptions};

#[repr(C)]
struct Module {
    _p: [u8; 0],
}
#[repr(C)]
struct ModuleExt {
    _p: [u8; 0],
}
#[repr(C)]
struct InitialCtl {
    ctl: *const c_char,
    value: *const c_char,
}

type LogFn = Option<unsafe extern "C" fn(*const c_char, *mut c_void)>;
type ErrFn = Option<unsafe extern "C" fn(c_int, *mut c_void) -> c_int>;

#[repr(C)]
#[derive(Default)]
struct Interactive {
    set_current_speed: Option<unsafe extern "C" fn(*mut ModuleExt, i32) -> c_int>,
    set_current_tempo: Option<unsafe extern "C" fn(*mut ModuleExt, i32) -> c_int>,
    set_tempo_factor: Option<unsafe extern "C" fn(*mut ModuleExt, f64) -> c_int>,
    get_tempo_factor: Option<unsafe extern "C" fn(*mut ModuleExt) -> f64>,
    set_pitch_factor: Option<unsafe extern "C" fn(*mut ModuleExt, f64) -> c_int>,
    get_pitch_factor: Option<unsafe extern "C" fn(*mut ModuleExt) -> f64>,
    set_global_volume: Option<unsafe extern "C" fn(*mut ModuleExt, f64) -> c_int>,
    get_global_volume: Option<unsafe extern "C" fn(*mut ModuleExt) -> f64>,
    set_channel_volume: Option<unsafe extern "C" fn(*mut ModuleExt, i32, f64) -> c_int>,
    get_channel_volume: Option<unsafe extern "C" fn(*mut ModuleExt, i32) -> f64>,
    set_channel_mute_status: Option<unsafe extern "C" fn(*mut ModuleExt, i32, c_int) -> c_int>,
    get_channel_mute_status: Option<unsafe extern "C" fn(*mut ModuleExt, i32) -> c_int>,
    set_instrument_mute_status: Option<unsafe extern "C" fn(*mut ModuleExt, i32, c_int) -> c_int>,
    get_instrument_mute_status: Option<unsafe extern "C" fn(*mut ModuleExt, i32) -> c_int>,
    play_note: Option<unsafe extern "C" fn(*mut ModuleExt, i32, i32, f64, f64) -> i32>,
    stop_note: Option<unsafe extern "C" fn(*mut ModuleExt, i32) -> c_int>,
}

extern "C" {
    fn openmpt_module_ext_create_from_memory(
        filedata: *const c_void,
        filesize: usize,
        logfunc: LogFn,
        loguser: *mut c_void,
        errfunc: ErrFn,
        erruser: *mut c_void,
        error: *mut c_int,
        error_message: *mut *const c_char,
        ctls: *const InitialCtl,
    ) -> *mut ModuleExt;
    fn openmpt_module_ext_destroy(m: *mut ModuleExt);
    fn openmpt_module_ext_get_module(m: *mut ModuleExt) -> *mut Module;
    fn openmpt_module_ext_get_interface(m: *mut ModuleExt, id: *const c_char, iface: *mut c_void, size: usize) -> c_int;
    fn openmpt_module_select_subsong(m: *mut Module, subsong: i32) -> c_int;
    fn openmpt_module_get_num_subsongs(m: *mut Module) -> i32;
    fn openmpt_module_set_repeat_count(m: *mut Module, count: i32) -> c_int;
    fn openmpt_module_get_duration_seconds(m: *mut Module) -> f64;
    fn openmpt_module_get_restart_order(m: *mut Module, subsong: i32) -> i32;
    fn openmpt_module_get_restart_row(m: *mut Module, subsong: i32) -> i32;
    fn openmpt_module_get_time_at_position(m: *mut Module, order: i32, row: i32) -> f64;
    fn openmpt_module_set_position_seconds(m: *mut Module, seconds: f64) -> f64;
    fn openmpt_module_read_interleaved_float_stereo(m: *mut Module, rate: i32, count: usize, out: *mut f32) -> usize;
    fn openmpt_module_get_metadata(m: *mut Module, key: *const c_char) -> *const c_char;
    fn openmpt_module_get_num_channels(m: *mut Module) -> i32;
    fn openmpt_module_get_channel_name(m: *mut Module, index: i32) -> *const c_char;
    fn openmpt_free_string(s: *const c_char);
    fn openmpt_is_extension_supported(ext: *const c_char) -> c_int;
    fn openmpt_probe_file_header(
        flags: u64,
        data: *const c_void,
        size: usize,
        filesize: u64,
        logfunc: LogFn,
        loguser: *mut c_void,
        errfunc: ErrFn,
        erruser: *mut c_void,
        error: *mut c_int,
        error_message: *mut *const c_char,
    ) -> c_int;
    fn openmpt_probe_file_header_without_filesize(
        flags: u64,
        data: *const c_void,
        size: usize,
        logfunc: LogFn,
        loguser: *mut c_void,
        errfunc: ErrFn,
        erruser: *mut c_void,
        error: *mut c_int,
        error_message: *mut *const c_char,
    ) -> c_int;
    fn openmpt_log_func_silent(message: *const c_char, user: *mut c_void);
    fn openmpt_error_func_ignore(error: c_int, user: *mut c_void) -> c_int;
}

const PROBE_DEFAULT: u64 = 0x3;
const PROBE_SUCCESS: c_int = 1;
/// Render rate. Trackers synthesise at any rate; 48 kHz matches most output devices.
pub const RATE: u32 = 48_000;

fn owned_string(p: *const c_char) -> Option<String> {
    if p.is_null() {
        return None;
    }
    let s = crate::cstr_opt(p);
    unsafe { openmpt_free_string(p) };
    s
}

pub fn is_extension_supported(ext: &str) -> bool {
    let Ok(c) = CString::new(ext) else { return false };
    unsafe { openmpt_is_extension_supported(c.as_ptr()) != 0 }
}

/// True if libopenmpt recognises `head` (the first bytes of a file) as a module it can play.
pub fn probe(head: &[u8], file_size: Option<u64>) -> bool {
    if head.is_empty() {
        return false;
    }
    let (mut err, mut msg) = (0, std::ptr::null());
    let r = unsafe {
        match file_size {
            Some(sz) => openmpt_probe_file_header(PROBE_DEFAULT, head.as_ptr() as *const c_void, head.len(), sz, Some(openmpt_log_func_silent), std::ptr::null_mut(), Some(openmpt_error_func_ignore), std::ptr::null_mut(), &mut err, &mut msg),
            None => openmpt_probe_file_header_without_filesize(PROBE_DEFAULT, head.as_ptr() as *const c_void, head.len(), Some(openmpt_log_func_silent), std::ptr::null_mut(), Some(openmpt_error_func_ignore), std::ptr::null_mut(), &mut err, &mut msg),
        }
    };
    if !msg.is_null() {
        unsafe { openmpt_free_string(msg) };
    }
    r == PROBE_SUCCESS
}

pub struct OpenmptSource {
    ext: *mut ModuleExt,
    module: *mut Module,
    interactive: Interactive,
    pos: u64,
    loop_info: Option<LoopInfo>,
    duration: Option<u64>,
    meta: SourceMeta,
    channels: usize,
}

// libopenmpt modules are only touched by the owning thread.
unsafe impl Send for OpenmptSource {}

impl Drop for OpenmptSource {
    fn drop(&mut self) {
        unsafe { openmpt_module_ext_destroy(self.ext) };
    }
}

impl OpenmptSource {
    pub fn open(data: &[u8], name: &str, opts: &OpenOptions) -> Result<Self, SourceError> {
        let (mut err, mut msg) = (0, std::ptr::null());
        let ext = unsafe {
            openmpt_module_ext_create_from_memory(
                data.as_ptr() as *const c_void,
                data.len(),
                Some(openmpt_log_func_silent),
                std::ptr::null_mut(),
                Some(openmpt_error_func_ignore),
                std::ptr::null_mut(),
                &mut err,
                &mut msg,
                std::ptr::null(),
            )
        };
        let why = owned_string(msg);
        if ext.is_null() {
            return Err(SourceError::new(format!("libopenmpt: {}", why.unwrap_or_else(|| "not a module".into()))));
        }
        let module = unsafe { openmpt_module_ext_get_module(ext) };
        let mut src = OpenmptSource {
            ext,
            module,
            interactive: Interactive::default(),
            pos: 0,
            loop_info: None,
            duration: None,
            meta: SourceMeta::default(),
            channels: 0,
        };
        let count = unsafe { openmpt_module_get_num_subsongs(module) }.max(1);
        let requested = opts.subsong.unwrap_or(0);
        // Checked: a u32 past i32::MAX would turn negative, and -1 selects all sub-songs.
        let subsong = match i32::try_from(requested) {
            Ok(s) if s < count => s,
            _ => return Err(SourceError::new(format!("sub-song {requested} out of range (module has {count})"))),
        };
        if unsafe { openmpt_module_select_subsong(module, subsong) } == 0 {
            return Err(SourceError::new(format!("libopenmpt: cannot select sub-song {subsong}")));
        }
        unsafe { openmpt_module_set_repeat_count(module, -1) };
        let rate = RATE as f64;
        let dur = unsafe { openmpt_module_get_duration_seconds(module) };
        if dur.is_finite() && dur > 0.0 {
            let end = (dur * rate).round() as u64;
            let order = unsafe { openmpt_module_get_restart_order(module, subsong) };
            let row = unsafe { openmpt_module_get_restart_row(module, subsong) };
            let restart = if order >= 0 && row >= 0 { unsafe { openmpt_module_get_time_at_position(module, order, row) } } else { 0.0 };
            let start = if restart.is_finite() && restart >= 0.0 && restart < dur { (restart * rate).round() as u64 } else { 0 };
            if end > start {
                src.loop_info = Some(LoopInfo { start, end });
            }
            src.duration = Some(end);
        }
        let iface_id = CString::new("interactive").unwrap();
        let got = unsafe {
            openmpt_module_ext_get_interface(ext, iface_id.as_ptr(), &mut src.interactive as *mut Interactive as *mut c_void, std::mem::size_of::<Interactive>())
        };
        if got == 0 {
            src.interactive = Interactive::default();
        }
        let meta_key = |k: &str| {
            let c = CString::new(k).unwrap();
            owned_string(unsafe { openmpt_module_get_metadata(module, c.as_ptr()) })
        };
        src.channels = unsafe { openmpt_module_get_num_channels(module) }.max(0) as usize;
        let voice_names = if src.interactive.set_channel_mute_status.is_some() {
            (0..src.channels)
                .map(|i| owned_string(unsafe { openmpt_module_get_channel_name(module, i as i32) }).unwrap_or_else(|| format!("Channel {}", i + 1)))
                .collect()
        } else {
            Vec::new()
        };
        src.meta = SourceMeta {
            codec: meta_key("type").or_else(|| extension_of(name)).unwrap_or_else(|| "module".into()).to_ascii_lowercase(),
            title: meta_key("title"),
            artist: meta_key("artist"),
            system: meta_key("type_long"),
            comment: meta_key("tracker"),
            subsong_count: (count > 1).then_some(count as u32),
            subsong: Some(subsong as u32),
            voice_names,
            ..Default::default()
        };
        Ok(src)
    }
}

impl AudioSource for OpenmptSource {
    fn sample_rate(&self) -> u32 {
        RATE
    }
    fn channels(&self) -> usize {
        2
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, SourceError> {
        let frames = out.len() / 2;
        if frames == 0 {
            return Ok(0);
        }
        let n = unsafe { openmpt_module_read_interleaved_float_stereo(self.module, RATE as i32, frames, out.as_mut_ptr()) };
        self.pos += n as u64;
        Ok(n)
    }

    fn seek(&mut self, frame: u64) -> Result<u64, SourceError> {
        if let Some(l) = self.loop_info {
            if frame == l.start && self.pos == l.end {
                // The module has jumped back to its restart position on its own.
                self.pos = frame;
                return Ok(frame);
            }
        }
        let reached = unsafe { openmpt_module_set_position_seconds(self.module, frame as f64 / RATE as f64) };
        let reached = if reached.is_finite() && reached >= 0.0 { (reached * RATE as f64).round() as u64 } else { frame };
        // Row-granular seeks may land slightly early; report where we really are.
        self.pos = reached;
        Ok(reached)
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
    fn voice_count(&self) -> usize {
        if self.interactive.set_channel_mute_status.is_some() {
            self.channels.min(64)
        } else {
            0
        }
    }
    fn set_voice_mask(&mut self, mask: u64) {
        if let Some(f) = self.interactive.set_channel_mute_status {
            for ch in 0..self.channels.min(64) {
                unsafe { f(self.ext, ch as i32, ((mask >> ch) & 1) as c_int) };
            }
        }
    }
}
