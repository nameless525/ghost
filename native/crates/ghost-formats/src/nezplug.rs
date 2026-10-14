//! NEZPlug extended `.m3u` lines, as shipped in joshw / Zophar NSF, GBS, HES, KSS sets:
//!
//! `file.nsf::NSF,track,Title,length,loop,fade,loopcount`
//!
//! Track numbers prefixed with `$` are hexadecimal and 0-based; decimal numbers are 1-based
//! (0-based for KSS), matching libgme's parser. Only enough is parsed here to find the line for a
//! given file and sub-song; libgme itself parses the timing fields.

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

/// Find the playlist line for `file` / `subsong` and return a one-entry playlist (keeping the
/// `#` header comments, which carry the album title and artist) for libgme.
pub fn playlist_for(playlists: &[String], file: &str, subsong: u32, zero_based_decimal: bool) -> Option<String> {
    let want = file_name_of(file);
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
                return Some(format!("{header}{t}\n"));
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
    fn finds_line_for_track() {
        let pl = vec!["#TITLE Game\nGame.nsf::NSF,1,One,1:00,,5\nGame.nsf::NSF,2,Two,2:00,,5\n".to_string()];
        assert_eq!(playlist_for(&pl, "game.NSF", 1, false).as_deref(), Some("#TITLE Game\nGame.nsf::NSF,2,Two,2:00,,5\n"));
        assert_eq!(playlist_for(&pl, "Game.nsf", 5, false), None);
        assert_eq!(playlist_for(&pl, "Other.nsf", 0, false), None);
    }
}
