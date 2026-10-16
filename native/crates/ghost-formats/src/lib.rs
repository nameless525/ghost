//! Game-music decoders for the GHOST engine.
//!
//! Three statically linked C/C++ libraries (see `build.rs` for versions and licences), each
//! wrapped as an [`AudioSource`]:
//! - [`gme`]: libgme. NSF/NSFE, SPC, GBS, VGM/VGZ, HES, KSS, AY, SAP, GYM; sub-songs, voice muting,
//!   NEZPlug `.m3u` timing.
//! - [`vgmstream`]: libvgmstream (new `libvgmstream.h` API). ADX, HCA, BRSTM/BCSTM/BFSTM, FSB,
//!   Wwise, and hundreds more; streamed through caller-provided I/O callbacks.
//! - [`openmpt`]: libopenmpt. MOD/XM/IT/S3M/UMX/MO3 and the other tracker formats.
//!
//! All of them loop natively (the emulators / players keep going past the end of the loop body),
//! so [`AudioSource::seek`] to `loop.start` right after reading up to `loop.end` is a no-op that
//! keeps the audio continuous. Their raw streams are endless: the engine's loop stage turns them
//! into finite tracks (loop count + fade, or [`LengthHint`] + fade) or lets them run forever.
//!
//! [`archive`] lists and extracts `.zip` / `.7z` rip sets in memory, and [`detect`] picks a
//! decoder family from a format hint / extension and the first bytes of a file. [`opus`] wraps
//! libopus (also linked here) for the engine's general-purpose decoder, whose Opus streams
//! symphonia demuxes but can't decode.

pub mod archive;
pub mod detect;
pub mod gme;
pub mod nezplug;
pub mod openmpt;
pub mod opus;
pub mod source;
#[doc(hidden)]
pub mod testdata;
pub mod vgmstream;

pub use detect::{detect, family_for_extension, Family};
pub use source::{AudioSource, LengthHint, LoopInfo, SourceError, SourceMeta};

/// foobar2000's default for chip tracks without a length: 2:30, then the fade.
pub const DEFAULT_LENGTH_MS: u64 = 150_000;

/// Options common to every decoder family.
#[derive(Clone, Debug, Default)]
pub struct OpenOptions {
    /// 0-based sub-song (track inside an NSF/GBS/HES/KSS, stream inside an FSB/AWB bank, ...).
    pub subsong: Option<u32>,
    /// Playlists that may describe this file (NEZPlug `.m3u` text). A line naming this file and
    /// sub-song supplies its title, length, loop and fade.
    pub playlists: Vec<String>,
}

/// Open an in-memory file with the given family. `name` is the file name (its extension matters
/// for formats without magic bytes). Extensions shared between libraries (`.sap`, `.umx`, ...)
/// fall back to vgmstream when the first choice rejects the file.
pub fn open_memory(family: Family, data: Vec<u8>, name: &str, opts: &OpenOptions) -> Result<Box<dyn AudioSource>, SourceError> {
    let open_vgm = |data: Vec<u8>| -> Result<Box<dyn AudioSource>, SourceError> {
        let opener = std::sync::Arc::new(vgmstream::MemoryOpener::single(name, data));
        Ok(Box::new(vgmstream::VgmstreamSource::open(name, opener, opts)?))
    };
    // Keep a copy for the vgmstream fallback only when there can be one (libgme consumes its
    // input; libopenmpt only borrows it).
    let fallback = || extension_of(name).is_some_and(|ext| vgmstream::is_extension_supported(&ext));
    let (err, data) = match family {
        Family::Gme => {
            let spare = fallback().then(|| data.clone());
            match gme::GmeSource::open(data, name, opts) {
                Ok(s) => return Ok(Box::new(s)),
                Err(e) => (e, spare),
            }
        }
        Family::Openmpt => match openmpt::OpenmptSource::open(&data, name, opts) {
            Ok(s) => return Ok(Box::new(s)),
            Err(e) => (e, Some(data)),
        },
        Family::Vgmstream => return open_vgm(data),
    };
    match data {
        Some(data) if fallback() => open_vgm(data).map_err(|_| err),
        _ => Err(err),
    }
}

/// Lower-cased extension of a file name or URL path (no query string), if any.
pub fn extension_of(name: &str) -> Option<String> {
    let no_query = name.split(['?', '#']).next().unwrap_or(name);
    let last = no_query.rsplit(['/', '\\']).next().unwrap_or(no_query);
    let (_, ext) = last.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 8 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// Base file name of a path or URL path.
pub fn file_name_of(path: &str) -> &str {
    let no_query = path.split(['?', '#']).next().unwrap_or(path);
    no_query.rsplit(['/', '\\']).next().unwrap_or(no_query)
}

pub(crate) fn ms_to_frames(ms: u64, rate: u32) -> u64 {
    ms * rate as u64 / 1000
}

pub(crate) fn cstr_opt(p: *const std::ffi::c_char) -> Option<String> {
    if p.is_null() {
        return None;
    }
    let s = unsafe { std::ffi::CStr::from_ptr(p) };
    let s = decode_text(s.to_bytes());
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Decode text of unknown encoding: UTF-8 (BOM stripped), else Shift-JIS when it decodes
/// cleanly and contains kana (Japanese rip sets), else Windows-1252.
pub fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let (s, _, bad) = encoding_rs::SHIFT_JIS.decode(bytes);
    // Latin-1 accents often form valid Shift-JIS pairs too ("Pokémon"); real Japanese has kana.
    if !bad && s.chars().any(|c| ('\u{3040}'..='\u{30FF}').contains(&c)) {
        return s.into_owned();
    }
    encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(extension_of("https://x/a/Game%20(1990).7z?x=1").as_deref(), Some("7z"));
        assert_eq!(extension_of("set/01 Title.NSFE").as_deref(), Some("nsfe"));
        assert_eq!(file_name_of("a/b\\c.spc"), "c.spc");
        assert_eq!(decode_text(b"\xEF\xBB\xBFhi"), "hi");
        assert_eq!(decode_text(&[0x83, 0x8D, 0x83, 0x62, 0x83, 0x4E]), "ロック");
        assert_eq!(decode_text(&[0x43, 0x61, 0x66, 0xE9]), "Café");
        // Latin-1 that happens to be valid Shift-JIS: "Pokémon", "©1989".
        assert_eq!(decode_text(b"Pok\xE9mon"), "Pokémon");
        assert_eq!(decode_text(b"\xA91989"), "©1989");
    }
}
