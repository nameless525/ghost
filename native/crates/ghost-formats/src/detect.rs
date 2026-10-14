//! Picks the decoder family for a file: format hint / extension first, then magic bytes.

use crate::{gme, openmpt, vgmstream};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Family {
    /// libgme: emulated console sound chips.
    Gme,
    /// libvgmstream: streamed game audio (ADX, HCA, BRSTM, FSB, WEM, ...).
    Vgmstream,
    /// libopenmpt: tracker modules.
    Openmpt,
}

impl Family {
    pub fn name(self) -> &'static str {
        match self {
            Family::Gme => "libgme",
            Family::Vgmstream => "vgmstream",
            Family::Openmpt => "libopenmpt",
        }
    }
}

/// Extensions libgme plays.
pub const GME_EXTENSIONS: &[&str] = &["nsf", "nsfe", "spc", "gbs", "vgm", "vgz", "hes", "kss", "ay", "sap", "gym"];

/// General-purpose formats that stay with the engine's standard decoder even though vgmstream or
/// libopenmpt also accept some of them.
const COMMON: &[&str] = &[
    "wav", "wave", "aif", "aiff", "aifc", "mp3", "mp2", "mp1", "ogg", "oga", "opus", "flac", "m4a", "m4b", "mp4", "aac", "alac", "webm",
    "mkv", "mka", "caf", "wma", "ac3", "weba",
];

/// Archives are never decoded directly.
const ARCHIVES: &[&str] = &["zip", "7z", "rar", "rsn", "lha", "lzh", "gz", "tar"];

/// True for general-purpose audio extensions (decoded by the engine's standard decoder).
pub fn is_common_extension(ext: &str) -> bool {
    COMMON.contains(&ext.trim().trim_start_matches('.').to_ascii_lowercase().as_str())
}

/// Family for a file extension (or a format hint like "nsf" / ".spc"), without looking at data.
pub fn family_for_extension(ext: &str) -> Option<Family> {
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if ext.is_empty() || ext.contains('/') {
        return None;
    }
    if GME_EXTENSIONS.contains(&ext.as_str()) {
        return Some(Family::Gme);
    }
    if COMMON.contains(&ext.as_str()) || ARCHIVES.contains(&ext.as_str()) {
        return None;
    }
    if openmpt::is_extension_supported(&ext) {
        return Some(Family::Openmpt);
    }
    if vgmstream::is_extension_supported(&ext) {
        return Some(Family::Vgmstream);
    }
    None
}

/// Family from content: libgme magic (`NESM`, `NSFE`, `SNES-SPC700`, `GBS`, `Vgm `, gzip'd VGM,
/// `KSCC`/`KSSX`, `HESM`, `ZXAY`, `SAP`, `GYMX`) or a libopenmpt header probe (`IMPM`,
/// `Extended Module`, `SCRM`, `M.K.`, ...).
pub fn sniff(head: &[u8], file_size: Option<u64>, allow_module_probe: bool) -> Option<Family> {
    if gme::identify_header(head).is_some() || head.starts_with(b"SNES-SPC700") {
        return Some(Family::Gme);
    }
    if head.starts_with(&[0x1F, 0x8B]) {
        // VGZ: peek at the decompressed header.
        use std::io::Read;
        let mut inner = [0u8; 4];
        if flate2::read::GzDecoder::new(head).read_exact(&mut inner).is_ok() && &inner == b"Vgm " {
            return Some(Family::Gme);
        }
        return None;
    }
    if allow_module_probe && openmpt::probe(head, file_size) {
        return Some(Family::Openmpt);
    }
    None
}

/// Decide the family for a file with extension / hint `ext` whose first bytes are `head`.
/// `None` means "not a game-music format": the engine's standard decoder takes it.
pub fn detect(ext: Option<&str>, head: &[u8], file_size: Option<u64>) -> Option<Family> {
    let ext = ext.map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase());
    let common = ext.as_deref().is_some_and(|e| COMMON.contains(&e) || ARCHIVES.contains(&e));
    match ext.as_deref().and_then(family_for_extension) {
        Some(Family::Gme) => Some(Family::Gme),
        Some(Family::Openmpt) => {
            // Extensions shared with vgmstream: let the module probe decide.
            let e = ext.as_deref().unwrap_or("");
            if !head.is_empty() && vgmstream::is_extension_supported(e) && !openmpt::probe(head, file_size) {
                Some(Family::Vgmstream)
            } else {
                Some(Family::Openmpt)
            }
        }
        Some(Family::Vgmstream) => sniff(head, file_size, false).or(Some(Family::Vgmstream)),
        None => sniff(head, file_size, !common),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn by_extension() {
        for e in ["nsf", ".SPC", "vgz", "gbs", "hes", "kss", "ay", "sap", "gym", "nsfe"] {
            assert_eq!(family_for_extension(e), Some(Family::Gme), "{e}");
        }
        for e in ["mod", "xm", "it", "s3m", "umx", "mo3", "mptm"] {
            assert_eq!(family_for_extension(e), Some(Family::Openmpt), "{e}");
        }
        for e in ["adx", "hca", "brstm", "bcstm", "bfstm", "fsb", "wem", "xwb", "awb", "acb"] {
            assert_eq!(family_for_extension(e), Some(Family::Vgmstream), "{e}");
        }
        for e in ["mp3", "flac", "ogg", "wav", "opus", "m4a", "7z", "zip", "audio/mpeg", ""] {
            assert_eq!(family_for_extension(e), None, "{e}");
        }
    }

    #[test]
    fn by_magic() {
        let mut nsf = b"NESM\x1a\x01\x05\x01".to_vec();
        nsf.resize(128, 0);
        assert_eq!(detect(None, &nsf, None), Some(Family::Gme));
        let mut spc = b"SNES-SPC700 Sound File Data v0.30".to_vec();
        spc.resize(256, 0);
        assert_eq!(detect(Some("bin"), &spc, None), Some(Family::Gme));
        assert_eq!(detect(None, b"Vgm \x00\x00\x00\x00", None), Some(Family::Gme));
        let mut it = b"IMPM".to_vec();
        it.resize(1024, 0);
        assert_eq!(detect(None, b"ID3\x04\x00\x00\x00\x00\x00\x00", None), None);
        let _ = it;
    }
}
