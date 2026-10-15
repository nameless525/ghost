//! Rip-set archives (`.zip` from vgmrips / Zophar, `.7z` from joshw), read entirely in memory.
//!
//! Sets are small (kilobytes to a few megabytes), and 7z sets are solid, so the whole archive is
//! decompressed once and entries are served from memory ([`Extracted`]).

use std::io::{Cursor, Read};
use std::sync::Arc;

use crate::source::SourceError;
use crate::{decode_text, extension_of, file_name_of};

/// Refuse to inflate archives beyond this (zip bombs, or a wrong file).
pub const MAX_EXTRACTED_BYTES: u64 = 1 << 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Zip,
    SevenZ,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// Path inside the archive, `/`-separated.
    pub path: String,
    /// Uncompressed size in bytes.
    pub size: u64,
}

/// Archive type from magic bytes.
pub fn kind_of(data: &[u8]) -> Option<Kind> {
    if data.starts_with(b"PK\x03\x04") || data.starts_with(b"PK\x05\x06") {
        Some(Kind::Zip)
    } else if data.starts_with(&[b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C]) {
        Some(Kind::SevenZ)
    } else {
        None
    }
}

/// True for an archive extension we can open.
pub fn is_archive_extension(ext: &str) -> bool {
    matches!(ext.trim_start_matches('.').to_ascii_lowercase().as_str(), "zip" | "7z")
}

/// Playlist / info text shipped in sets (`.m3u`, `.m3u8`, `.txt`).
pub fn is_playlist(path: &str) -> bool {
    matches!(extension_of(path).as_deref(), Some("m3u" | "m3u8" | "txt"))
}

fn err(e: impl std::fmt::Display) -> SourceError {
    SourceError::new(format!("archive: {e}"))
}

fn clean_path(p: &str) -> String {
    p.replace('\\', "/").trim_start_matches("./").trim_start_matches('/').to_string()
}

fn zip_name(raw: &[u8]) -> String {
    clean_path(&decode_text(raw))
}

fn not_archive() -> SourceError {
    SourceError::new("not a zip or 7z archive")
}

/// List the files (not directories) in an archive.
pub fn list(data: &[u8]) -> Result<Vec<Entry>, SourceError> {
    let kind = kind_of(data).ok_or_else(not_archive)?;
    std::panic::catch_unwind(|| list_(data, kind)).unwrap_or_else(|_| Err(err("corrupt archive")))
}

fn list_(data: &[u8], kind: Kind) -> Result<Vec<Entry>, SourceError> {
    match kind {
        Kind::Zip => {
            let mut z = zip::ZipArchive::new(Cursor::new(data)).map_err(err)?;
            let mut out = Vec::with_capacity(z.len());
            for i in 0..z.len() {
                let f = z.by_index_raw(i).map_err(err)?;
                if !f.is_dir() {
                    out.push(Entry { path: zip_name(f.name_raw()), size: f.size() });
                }
            }
            Ok(out)
        }
        Kind::SevenZ => {
            let a = sevenz_rust2::Archive::read(&mut Cursor::new(data), &sevenz_rust2::Password::empty()).map_err(err)?;
            Ok(a.files.iter().filter(|f| !f.is_directory()).map(|f| Entry { path: clean_path(f.name()), size: f.size() }).collect())
        }
    }
}

/// Every file of an archive, decompressed.
#[derive(Clone, Default)]
pub struct Extracted {
    pub files: Vec<(String, Arc<[u8]>)>,
}

impl Extracted {
    /// Find an entry: exact path, then case-insensitive, then a unique base-name match.
    pub fn find(&self, name: &str) -> Option<(&str, &Arc<[u8]>)> {
        let want = clean_path(name);
        if let Some((p, d)) = self.files.iter().find(|(p, _)| *p == want) {
            return Some((p, d));
        }
        let lower = want.to_lowercase();
        if let Some((p, d)) = self.files.iter().find(|(p, _)| p.to_lowercase() == lower) {
            return Some((p, d));
        }
        let base = file_name_of(&lower).to_string();
        let mut hits = self.files.iter().filter(|(p, _)| file_name_of(p).to_lowercase() == base);
        match (hits.next(), hits.next()) {
            (Some((p, d)), None) => Some((p, d)),
            _ => None,
        }
    }

    /// Text of every playlist in the set, decoded.
    pub fn playlists(&self) -> Vec<(String, String)> {
        self.files.iter().filter(|(p, _)| is_playlist(p)).map(|(p, d)| (p.clone(), decode_text(d))).collect()
    }

    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|(_, d)| d.len() as u64).sum()
    }
}

/// Decompress every file in the archive.
///
/// At most [`MAX_EXTRACTED_BYTES`] are inflated in total, counting the bytes actually produced:
/// zip headers can understate an entry's size (a zip bomb inflates far past what it declares),
/// and declared sizes are not trusted for allocations either.
pub fn extract_all(data: &[u8]) -> Result<Extracted, SourceError> {
    let kind = kind_of(data).ok_or_else(not_archive)?;
    // The zip / 7z readers parse untrusted headers: a panic in them must not take the app down.
    std::panic::catch_unwind(|| extract_limited(data, kind, MAX_EXTRACTED_BYTES)).unwrap_or_else(|_| Err(err("corrupt archive")))
}

/// Read one entry, counting it against the remaining budget (`left`).
fn read_entry(r: &mut dyn Read, declared: u64, left: &mut u64) -> std::io::Result<Vec<u8>> {
    // Pre-allocate what the header declares, within reason (a lie only costs a regrow).
    let mut buf = Vec::with_capacity(declared.min(*left).min(MAX_PREALLOC) as usize);
    // One byte past the budget tells "exactly at the limit" from "over it".
    r.take(*left + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > *left {
        return Err(std::io::Error::other("too large uncompressed"));
    }
    *left -= buf.len() as u64;
    Ok(buf)
}

/// Largest up-front allocation for one entry.
const MAX_PREALLOC: u64 = 64 << 20;

fn extract_limited(data: &[u8], kind: Kind, limit: u64) -> Result<Extracted, SourceError> {
    let mut out = Extracted::default();
    let mut left = limit;
    match kind {
        Kind::Zip => {
            let mut z = zip::ZipArchive::new(Cursor::new(data)).map_err(err)?;
            let declared = (0..z.len()).filter_map(|i| z.by_index_raw(i).ok().map(|f| f.size())).fold(0u64, u64::saturating_add);
            if declared > limit {
                return Err(err("too large"));
            }
            for i in 0..z.len() {
                let mut f = z.by_index(i).map_err(err)?;
                if f.is_dir() {
                    continue;
                }
                let name = zip_name(f.name_raw());
                let size = f.size();
                let buf = read_entry(&mut f, size, &mut left).map_err(|e| err(format!("{name}: {e}")))?;
                out.files.push((name, Arc::from(buf)));
            }
        }
        Kind::SevenZ => {
            let mut r = sevenz_rust2::ArchiveReader::new(Cursor::new(data), sevenz_rust2::Password::empty()).map_err(err)?;
            let declared = r.archive().files.iter().map(|f| f.size()).fold(0u64, u64::saturating_add);
            if declared > limit {
                return Err(err("too large"));
            }
            r.for_each_entries(|entry, reader| {
                if entry.is_directory() {
                    return Ok(true);
                }
                let buf = read_entry(reader, entry.size(), &mut left)?;
                out.files.push((clean_path(entry.name()), Arc::from(buf)));
                Ok(true)
            })
            .map_err(err)?;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).unwrap();
            std::io::Write::write_all(&mut w, data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn zip_list_and_extract() {
        let z = zip_bytes(&[("Set/01 Intro.vgz", b"abc"), ("Set/Set.m3u", b"01 Intro.vgz\r\n"), ("Set/info.txt", b"Game\n")]);
        assert_eq!(kind_of(&z), Some(Kind::Zip));
        let l = list(&z).unwrap();
        assert_eq!(l.len(), 3);
        assert_eq!(l[0], Entry { path: "Set/01 Intro.vgz".into(), size: 3 });
        let x = extract_all(&z).unwrap();
        assert_eq!(&**x.find("set/01 intro.VGZ").unwrap().1, b"abc");
        assert_eq!(&**x.find("01 Intro.vgz").unwrap().1, b"abc");
        assert!(x.find("nope.vgz").is_none());
        let pl = x.playlists();
        assert_eq!(pl.len(), 2);
        assert_eq!(pl[0].1, "01 Intro.vgz\r\n");
    }

    #[test]
    fn extraction_is_bounded_by_bytes_produced_not_declared() {
        let big = vec![0u8; 100_000];
        let z = zip_bytes(&[("a.bin", &big), ("b.bin", &big)]);
        assert_eq!(extract_limited(&z, Kind::Zip, 200_000).unwrap().total_bytes(), 200_000);
        assert!(extract_limited(&z, Kind::Zip, 199_999).is_err());
        // A zip bomb: headers claiming 1 KB per entry (the deflate streams still produce 100 KB).
        let mut bomb = z.clone();
        let (real, fake) = (100_000u32.to_le_bytes(), 1_000u32.to_le_bytes());
        let mut patched = 0;
        for i in 0..bomb.len() - 4 {
            if bomb[i..i + 4] == real {
                bomb[i..i + 4].copy_from_slice(&fake);
                patched += 1;
            }
        }
        assert_eq!(patched, 4, "local + central header of each entry");
        assert_eq!(list(&bomb).unwrap()[0].size, 1_000);
        // The zip reader itself doesn't stop at the declared size...
        assert_eq!(extract_limited(&bomb, Kind::Zip, 1 << 20).unwrap().total_bytes(), 200_000);
        // ...so the budget counts what is actually inflated.
        let e = extract_limited(&bomb, Kind::Zip, 150_000).err().expect("inflated past the limit");
        assert!(e.message.contains("too large"), "{e}");
    }

    #[test]
    fn rejects_non_archives() {
        assert!(list(b"NESM\x1a").is_err());
        assert!(extract_all(b"").is_err());
    }
}
