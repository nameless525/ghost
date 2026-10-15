//! NEZPlug extended `.m3u` lines, as shipped in joshw / Zophar NSF, GBS, HES, KSS sets:
//!
//! `file.nsf::NSF,track,Title,length,loop,fade,loopcount`
//!
//! Track numbers prefixed with `$` are hexadecimal and 0-based; decimal numbers are 1-based
//! (0-based for KSS), matching libgme's parser. Some sets number decimal tracks from 0 anyway
//! (HCS GBS sets: "DMG-TRA-0.gbs::GBS,0,Title"): a decimal 0 for a file marks its numbering
//! 0-based. Only enough is parsed here to find the line for a given file and sub-song; libgme
//! itself parses the timing fields.
//!
//! The line handed to libgme is rewritten to address the track we matched, unambiguously: its
//! track in hex (which libgme never adjusts), its file name without the characters libgme's
//! parser treats specially. Left alone, libgme can read a different track than we did (it ends
//! the file name at a `,` followed by a digit), including a decimal 0 in a 1-based set, which
//! becomes track -1 and passes libgme's signed range check on its way to the emulator.

use crate::file_name_of;

/// A parsed playlist line (just the addressing part).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub file: String,
    pub kind: String,
    /// Track number as written and whether it was decimal.
    pub track: u32,
    pub decimal: bool,
}

impl Entry {
    /// 0-based raw track in the file.
    pub fn raw_track(&self, zero_based_decimal: bool) -> Option<u32> {
        if self.decimal && !zero_based_decimal {
            self.track.checked_sub(1)
        } else {
            Some(self.track)
        }
    }
}

/// Parse the file/type/track part of a NEZPlug line (`None` for comments and plain m3u lines).
pub fn parse_line(line: &str) -> Option<Entry> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (file, rest) = line.split_once("::")?;
    let (kind, rest) = rest.split_once(',')?;
    let rest = rest.trim_start();
    let field = rest.split(',').next().unwrap_or("").trim();
    let (track, decimal) = if let Some(hex) = field.strip_prefix('$') {
        (u32::from_str_radix(hex, 16).ok()?, false)
    } else {
        (field.parse::<u32>().ok()?, true)
    };
    Some(Entry { file: file.trim().replace('\\', "/"), kind: kind.trim().to_string(), track, decimal })
}

/// Whether some playlist numbers `file`'s decimal tracks from 0 (a decimal track 0 for it).
fn numbers_from_zero(playlists: &[String], want: &str) -> bool {
    playlists.iter().flat_map(|t| t.lines()).filter_map(parse_line).any(|e| e.decimal && e.track == 0 && file_name_of(&e.file).eq_ignore_ascii_case(want))
}

/// `line` for libgme, addressing raw track `track`: the file name stripped of the characters
/// libgme's parser treats specially, and the track field as `$XX` (hex: always 0-based, never
/// adjusted by libgme).
fn libgme_line(line: &str, track: u32) -> Option<String> {
    let (file, rest) = line.split_once("::")?;
    let (kind, rest) = rest.split_once(',')?;
    let file: String = file.trim().chars().filter(|c| !matches!(c, ',' | ':' | '\\')).collect();
    let tail = rest.split_once(',').map(|(_, t)| format!(",{t}")).unwrap_or_default();
    Some(format!("{file}::{},${track:02X}{tail}", kind.trim()))
}

/// Find the playlist line for `file` / `subsong` and return a one-entry playlist (keeping the
/// `#` header comments, which carry the album title and artist) for libgme.
pub fn playlist_for(playlists: &[String], file: &str, subsong: u32, zero_based_decimal: bool) -> Option<String> {
    let want = file_name_of(file);
    // libgme would read this set's decimal tracks as 1-based: detect 0-based numbering ourselves.
    let zero_based_decimal = zero_based_decimal || numbers_from_zero(playlists, want);
    for text in playlists {
        let mut header = String::new();
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with('#') {
                header.push_str(t);
                header.push('\n');
                continue;
            }
            let Some(e) = parse_line(t) else { continue };
            if file_name_of(&e.file).eq_ignore_ascii_case(want) && e.raw_track(zero_based_decimal) == Some(subsong) {
                return Some(format!("{header}{}\n", libgme_line(t, subsong)?));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nezplug_lines() {
        let e = parse_line("Mega Man 2.nsf::NSF,$0C,Dr. Wily Stage 1,1:41,,10,").unwrap();
        assert_eq!(e.file, "Mega Man 2.nsf");
        assert_eq!(e.kind, "NSF");
        assert_eq!(e.raw_track(false), Some(12));
        let e = parse_line("set\\Game.gbs::GBS,3,Title, with comma,2:00,1:00-,5").unwrap();
        assert_eq!(e.file, "set/Game.gbs");
        assert_eq!(e.raw_track(false), Some(2));
        assert_eq!(e.raw_track(true), Some(3));
        assert!(parse_line("# comment").is_none());
        assert!(parse_line("01 Plain.vgz").is_none());
    }

    #[test]
    fn sets_numbered_from_zero() {
        // HCS GBS sets number decimal tracks from 0; libgme reads decimal GBS tracks as 1-based,
        // so the line it gets names the track in hex.
        let master = "DMG-TRA-0.gbs::GBS,0,Title,0:40,,0\nDMG-TRA-0.gbs::GBS,1,A-Type,1:17,,10\n".to_string();
        let pl = vec![master];
        assert_eq!(playlist_for(&pl, "DMG-TRA-0.gbs", 0, false).as_deref(), Some("DMG-TRA-0.gbs::GBS,$00,Title,0:40,,0\n"));
        assert_eq!(playlist_for(&pl, "DMG-TRA-0.gbs", 1, false).as_deref(), Some("DMG-TRA-0.gbs::GBS,$01,A-Type,1:17,,10\n"));
        assert_eq!(playlist_for(&pl, "DMG-TRA-0.gbs", 2, false), None);
        // the 0 may be in another (per-track) playlist of the set
        let pl = vec!["Game.gbs::GBS,0,Title,1:13,,10".to_string(), "Game.gbs::GBS,2,Name,0:36,,10".to_string()];
        assert_eq!(playlist_for(&pl, "Game.gbs", 2, false).as_deref(), Some("Game.gbs::GBS,$02,Name,0:36,,10\n"));
        // KSS is 0-based already: lines pass through unchanged
        let pl = vec!["Game.kss::KSS,0,One,1:00,,5".to_string()];
        assert_eq!(playlist_for(&pl, "Game.kss", 0, true).as_deref(), Some("Game.kss::KSS,$00,One,1:00,,5\n"));
        assert_eq!(libgme_line("a.gbs::GBS,12", 11).as_deref(), Some("a.gbs::GBS,$0B"));
    }

    #[test]
    fn finds_line_for_track() {
        let pl = vec!["#TITLE Game\nGame.nsf::NSF,1,One,1:00,,5\nGame.nsf::NSF,2,Two,2:00,,5\n".to_string()];
        assert_eq!(playlist_for(&pl, "game.NSF", 1, false).as_deref(), Some("#TITLE Game\nGame.nsf::NSF,$01,Two,2:00,,5\n"));
        assert_eq!(playlist_for(&pl, "Game.nsf", 5, false), None);
        assert_eq!(playlist_for(&pl, "Other.nsf", 0, false), None);
    }

    #[test]
    fn line_for_libgme_names_the_validated_track() {
        // libgme would end this file name at ",0" and read decimal track 0, i.e. track -1: the
        // line it gets addresses our track and nothing else.
        let pl = vec!["a,0.nsf::NSF,3,Title,1:00,,5".to_string(), "b.nsf::NSF,99999999999,X".to_string()];
        assert_eq!(playlist_for(&pl, "a,0.nsf", 2, false).as_deref(), Some("a0.nsf::NSF,$02,Title,1:00,,5\n"));
        // The realistic case: a set named "..., <digit>..." (libgme would play track 2 - 1).
        let pl = vec!["Final Fantasy 1, 2 (J).nsf::NSF,5,Title,1:00,,5".to_string()];
        assert_eq!(playlist_for(&pl, "Final Fantasy 1, 2 (J).nsf", 4, false).as_deref(), Some("Final Fantasy 1 2 (J).nsf::NSF,$04,Title,1:00,,5\n"));
        // Not a track number we can represent: no line (libgme would wrap it around).
        assert_eq!(playlist_for(&pl, "b.nsf", 0, false), None);
        assert_eq!(libgme_line("dir\\x:y.ay::AY, $1F ,T", 31).as_deref(), Some("dirxy.ay::AY,$1F,T"));
    }
}
