//! NEZPlug extended `.m3u` lines, as shipped in joshw / Zophar NSF, GBS, HES, KSS sets:
//!
//! `file.nsf::NSF,track,Title,length,loop,fade,loopcount`
//!
//! Track numbers prefixed with `$` are hexadecimal and 0-based; decimal numbers are 1-based
//! (0-based for KSS), matching libgme's parser. Some sets number decimal tracks from 0 anyway
//! (HCS GBS sets: "DMG-TRA-0.gbs::GBS,0,Title"): a decimal 0 for a file marks its numbering
//! 0-based, and the line handed to libgme then names its track in hex so libgme reads it the same
//! way. Only enough is parsed here to find the line for a given file and sub-song; libgme itself
//! parses the timing fields.

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

/// `line` with its track field replaced by `$XX` (hex, 0-based).
fn with_hex_track(line: &str, track: u32) -> Option<String> {
    let (file, rest) = line.split_once("::")?;
    let (kind, rest) = rest.split_once(',')?;
    let tail = rest.split_once(',').map(|(_, t)| format!(",{t}")).unwrap_or_default();
    Some(format!("{file}::{kind},${track:02X}{tail}"))
}

/// Find the playlist line for `file` / `subsong` and return a one-entry playlist (keeping the
/// `#` header comments, which carry the album title and artist) for libgme.
pub fn playlist_for(playlists: &[String], file: &str, subsong: u32, zero_based_decimal: bool) -> Option<String> {
    let want = file_name_of(file);
    // libgme would read this set's decimal tracks as 1-based: detect 0-based numbering ourselves.
    let detected = !zero_based_decimal && numbers_from_zero(playlists, want);
    let zero_based_decimal = zero_based_decimal || detected;
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
                let line = if detected && e.decimal { with_hex_track(t, subsong).unwrap_or_else(|| t.to_string()) } else { t.to_string() };
                return Some(format!("{header}{line}\n"));
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
        assert_eq!(playlist_for(&pl, "Game.kss", 0, true).as_deref(), Some("Game.kss::KSS,0,One,1:00,,5\n"));
        assert_eq!(with_hex_track("a.gbs::GBS,12", 11).as_deref(), Some("a.gbs::GBS,$0B"));
    }

    #[test]
    fn finds_line_for_track() {
        let pl = vec!["#TITLE Game\nGame.nsf::NSF,1,One,1:00,,5\nGame.nsf::NSF,2,Two,2:00,,5\n".to_string()];
        assert_eq!(playlist_for(&pl, "game.NSF", 1, false).as_deref(), Some("#TITLE Game\nGame.nsf::NSF,2,Two,2:00,,5\n"));
        assert_eq!(playlist_for(&pl, "Game.nsf", 5, false), None);
        assert_eq!(playlist_for(&pl, "Other.nsf", 0, false), None);
    }
}
