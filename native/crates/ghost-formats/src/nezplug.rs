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
//! Lines name files relative to their playlist's folder. For an archive, [`resolve_playlists`]
//! rewrites each line to name the entry it means (the same lookup the catalog uses to build the
//! album: the playlist's folder, then the archive root, then a file name only one entry has, then
//! the only file of that type), so a line only ever describes that file; [`playlist_for`] then
//! compares whole paths, never just file names ("JP/game.nsf" and "US/game.nsf" are two files).
//!
//! The line handed to libgme is rewritten to address the track we matched, unambiguously: its
//! track in hex (which libgme never adjusts), its file name without the characters libgme's
//! parser treats specially. Left alone, libgme can read a different track than we did (it ends
//! the file name at a `,` followed by a digit), including a decimal 0 in a 1-based set, which
//! becomes track -1 and passes libgme's signed range check on its way to the emulator.

/// Formats that hold several songs in one file (a line naming a renamed one of these falls back
/// to the only file of its type).
const MULTI_SONG: &[&str] = &["nsf", "nsfe", "gbs", "hes", "kss", "ay", "sap"];

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

/// `a/./b/../c` → `a/c` (`/` separators); `None` when `..` climbs out of the archive.
fn norm_path(path: &str) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s => out.push(s),
        }
    }
    Some(out.join("/"))
}

/// Whether a line's file names `file` (both relative to the same folder).
fn same_file(line_file: &str, file: &str) -> bool {
    let norm = |p: &str| norm_path(p).unwrap_or_else(|| p.replace('\\', "/")).to_lowercase();
    norm(line_file) == norm(file)
}

/// File name of an archive path (a `#` or `?` in it is part of the name).
fn base_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn ext_of(path: &str) -> Option<String> {
    base_of(path).rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase())
}

/// The one item of `v`, if it has exactly one.
fn only<T>(v: Vec<T>) -> Option<T> {
    if v.len() == 1 {
        v.into_iter().next()
    } else {
        None
    }
}

/// The archive entry a playlist line names (see the module docs); `None` when none, or when the
/// file name it falls back to is shared by several entries.
pub fn entry_for<'a>(file: &str, playlist_path: &str, entries: &[&'a str]) -> Option<&'a str> {
    let dir = &playlist_path[..playlist_path.rfind('/').map_or(0, |i| i + 1)];
    let file = file.replace('\\', "/");
    let tries = if file.starts_with('/') { vec![file.clone()] } else { vec![format!("{dir}{file}"), file.clone()] };
    for want in tries.iter().filter_map(|t| norm_path(t)) {
        if let Some(e) = entries.iter().find(|e| norm_path(e).as_deref() == Some(want.as_str())) {
            return Some(e);
        }
        let lower = want.to_lowercase();
        if let Some(e) = only(entries.iter().copied().filter(|e| norm_path(e).is_some_and(|n| n.to_lowercase() == lower)).collect()) {
            return Some(e);
        }
    }
    let base = base_of(&file).to_lowercase();
    let named: Vec<&'a str> = entries.iter().copied().filter(|e| base_of(e).to_lowercase() == base).collect();
    if !named.is_empty() {
        return only(named);
    }
    let ext = ext_of(&file).filter(|x| MULTI_SONG.contains(&x.as_str()))?;
    only(entries.iter().copied().filter(|e| ext_of(e).as_deref() == Some(ext.as_str())).collect())
}

/// An archive's playlists (`(path, text)`), each line rewritten to name the entry it means
/// (`entries`: the archive's file paths). Lines that name no entry are left as written.
pub fn resolve_playlists(playlists: &[(String, String)], entries: &[&str]) -> Vec<String> {
    playlists
        .iter()
        .map(|(path, text)| {
            let mut out = String::with_capacity(text.len());
            for line in text.lines() {
                let t = line.trim();
                let entry = parse_line(t).and_then(|e| entry_for(&e.file, path, entries));
                match (entry, t.split_once("::")) {
                    (Some(entry), Some((_, rest))) if !entry.contains("::") => {
                        out.push_str(entry);
                        out.push_str("::");
                        out.push_str(rest);
                    }
                    _ => out.push_str(line),
                }
                out.push('\n');
            }
            out
        })
        .collect()
}

/// Whether some playlist numbers `file`'s decimal tracks from 0 (a decimal track 0 for it).
fn numbers_from_zero(playlists: &[String], want: &str) -> bool {
    playlists.iter().flat_map(|t| t.lines()).filter_map(parse_line).any(|e| e.decimal && e.track == 0 && same_file(&e.file, want))
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
/// `#` header comments, which carry the album title and artist) for libgme. `file` is the path the
/// lines are written against: the archive entry (lines from [`resolve_playlists`]), or for a file
/// on disk with playlists beside it, its name.
pub fn playlist_for(playlists: &[String], file: &str, subsong: u32, zero_based_decimal: bool) -> Option<String> {
    let want = file;
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
            if same_file(&e.file, want) && e.raw_track(zero_based_decimal) == Some(subsong) {
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
    fn lines_name_the_file_relative_to_their_playlist() {
        let entries = ["JP/game.nsf", "US/game.nsf", "US/extra/x.nsf"];
        let pl = vec![
            ("JP/set.m3u".to_string(), "#TITLE Game (J)\ngame.nsf::NSF,1,JP Opening,1:00\n../US/extra/x.nsf::NSF,1,Extra".to_string()),
            ("US/set.m3u".to_string(), "game.nsf::NSF,1,US Opening,2:00\nUS/game.nsf::NSF,2,US Ending,3:00".to_string()),
            ("set.m3u".to_string(), "game.nsf::NSF,1,Either,4:00\n../game.nsf::NSF,1,Out".to_string()),
        ];
        let r = resolve_playlists(&pl, &entries);
        assert_eq!(r[0], "#TITLE Game (J)\nJP/game.nsf::NSF,1,JP Opening,1:00\nUS/extra/x.nsf::NSF,1,Extra\n");
        assert_eq!(r[1], "US/game.nsf::NSF,1,US Opening,2:00\nUS/game.nsf::NSF,2,US Ending,3:00\n");
        // At the root "game.nsf" could be either file (and "../" leaves the archive): left as
        // written, these lines describe neither.
        assert_eq!(r[2], "game.nsf::NSF,1,Either,4:00\n../game.nsf::NSF,1,Out\n");
        assert_eq!(playlist_for(&r, "US/game.nsf", 0, false).as_deref(), Some("US/game.nsf::NSF,$00,US Opening,2:00\n"));
        assert_eq!(playlist_for(&r, "us/GAME.nsf", 1, false).as_deref(), Some("US/game.nsf::NSF,$01,US Ending,3:00\n"));
        assert_eq!(playlist_for(&r, "JP/game.nsf", 0, false).as_deref(), Some("#TITLE Game (J)\nJP/game.nsf::NSF,$00,JP Opening,1:00\n"));
        // The US playlist's second song is not the JP file's.
        assert_eq!(playlist_for(&r, "JP/game.nsf", 1, false), None);
        // One entry of that name: found by name; the only file of a multi-song type: a renamed one.
        assert_eq!(entry_for("game.nsf", "set.m3u", &["rip/game.nsf"]), Some("rip/game.nsf"));
        assert_eq!(entry_for("Old Name.nsf", "set.m3u", &["rip/game.nsf", "rip/x.spc"]), Some("rip/game.nsf"));
        assert_eq!(entry_for("Old Name.spc", "set.m3u", &["rip/game.nsf", "rip/x.spc"]), None);
        assert_eq!(entry_for("the hustler #05.nsf", "", &["NSF/The Hustler #05.nsf", "NSF/other #05.nsf"]), Some("NSF/The Hustler #05.nsf"));
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
