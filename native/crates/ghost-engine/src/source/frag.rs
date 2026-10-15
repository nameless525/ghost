//! Fragmented MP4 (`moof` + `mdat` pairs with a `sidx` segment index, as served by YouTube and
//! SoundCloud): index-based seeking.
//!
//! symphonia's MP4 reader finds a seek target in a fragmented file by reading fragment headers
//! one by one from the start, which over HTTP means downloading everything before the target
//! (a chapter one hour into a full-OST video: ~55 MB before the first sound). The `sidx` box at
//! the start of the file lists every fragment's size and duration, so the fragment holding any
//! time is known up front. [`Spliced`] presents "file header + the file from that fragment on"
//! as one stream; symphonia reads it as a fragmented file whose timeline starts at that fragment,
//! and the caller adds the fragment's start time back.

use std::io::{self, Read, Seek, SeekFrom};
use std::sync::Arc;

use symphonia::core::io::MediaSource;

/// Byte source a format reader can be rebuilt over.
pub trait ByteSource: Read + Seek + Send + Sync {}
impl<T: Read + Seek + Send + Sync> ByteSource for T {}

/// Header bytes larger than this (a huge `moov`) mean "not worth it".
const MAX_HEAD: u64 = 8 << 20;
const MAX_SIDX: u64 = 4 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Frag {
    /// File offset of the fragment's `moof`.
    pub offset: u64,
    /// Start time in `timescale` units, counted from the first fragment.
    pub ts: u64,
}

#[derive(Debug)]
pub struct FragIndex {
    /// The file up to the first fragment (`ftyp`, `moov`, `sidx`, ...).
    pub head: Arc<[u8]>,
    pub frags: Vec<Frag>,
    pub timescale: u32,
    pub total_len: u64,
}

fn read_exact_at(r: &mut dyn ByteSource, pos: u64, buf: &mut [u8]) -> io::Result<()> {
    r.seek(SeekFrom::Start(pos))?;
    r.read_exact(buf)
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn be64(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

impl FragIndex {
    /// Read the top-level boxes up to the first fragment. `None` unless this is a fragmented MP4
    /// with a single flat `sidx` that matches the file layout.
    pub fn read(mut r: Box<dyn ByteSource>) -> Option<FragIndex> {
        let r = r.as_mut();
        let total = r.seek(SeekFrom::End(0)).ok()?;
        let mut pos = 0u64;
        let mut sidx: Option<(u64, Vec<u8>)> = None;
        let first = loop {
            if pos + 8 > total || pos > MAX_HEAD {
                return None;
            }
            let mut h = [0u8; 16];
            read_exact_at(r, pos, &mut h[..8]).ok()?;
            let size32 = be32(&h, 0)?;
            let kind: [u8; 4] = h[4..8].try_into().ok()?;
            let (size, hdr) = match size32 {
                0 => (total - pos, 8),
                1 => {
                    read_exact_at(r, pos + 8, &mut h[8..16]).ok()?;
                    (be64(&h, 8)?, 16)
                }
                s => (s as u64, 8),
            };
            if size < hdr || pos.checked_add(size)? > total {
                return None;
            }
            match &kind {
                b"moof" => break pos,
                // Media data before any fragment: a regular (indexed) MP4.
                b"mdat" => return None,
                b"sidx" => {
                    if sidx.is_some() || size - hdr > MAX_SIDX {
                        return None;
                    }
                    let mut body = vec![0u8; (size - hdr) as usize];
                    read_exact_at(r, pos + hdr, &mut body).ok()?;
                    sidx = Some((pos + size, body));
                }
                _ => {}
            }
            pos += size;
        };
        let (anchor, body) = sidx?;
        let (timescale, frags) = parse_sidx(&body, anchor)?;
        if frags.len() < 2 || frags[0].offset != first || frags.last()?.offset >= total {
            return None;
        }
        let mut head = vec![0u8; first as usize];
        read_exact_at(r, 0, &mut head).ok()?;
        Some(FragIndex { head: head.into(), frags, timescale, total_len: total })
    }

    /// Index of the last fragment starting at or before `ts - preroll` (timescale units).
    pub fn fragment_for(&self, ts: u64, preroll: u64) -> usize {
        let t = ts.saturating_sub(preroll);
        self.frags.partition_point(|f| f.ts <= t).saturating_sub(1)
    }
}

/// `sidx` (ISO/IEC 14496-12 §8.16.3) body → (timescale, fragments). Offsets are relative to the
/// first byte after the box (`anchor`). Hierarchical indexes (references to other `sidx`
/// boxes) are not supported.
fn parse_sidx(b: &[u8], anchor: u64) -> Option<(u32, Vec<Frag>)> {
    let version = *b.first()?;
    let timescale = be32(b, 8)?;
    let (first_offset, mut p) = match version {
        0 => (be32(b, 16)? as u64, 20),
        1 => (be64(b, 20)?, 28),
        _ => return None,
    };
    if timescale == 0 {
        return None;
    }
    let count = u16::from_be_bytes(b.get(p + 2..p + 4)?.try_into().ok()?) as usize;
    p += 4;
    let mut frags = Vec::with_capacity(count);
    let (mut offset, mut ts) = (anchor.checked_add(first_offset)?, 0u64);
    for _ in 0..count {
        let r = be32(b, p)?;
        let dur = be32(b, p + 4)?;
        if r >> 31 != 0 {
            return None;
        }
        frags.push(Frag { offset, ts });
        offset = offset.checked_add((r & 0x7fff_ffff) as u64)?;
        ts = ts.checked_add(dur as u64)?;
        p += 12;
    }
    Some((timescale, frags))
}

/// Leading metadata that is pointless to download before playback starts: a large ID3v2 tag
/// (cover art) or large FLAC PICTURE / PADDING blocks. Returns the bytes to put in front
/// (rebuilt FLAC metadata, or nothing for MP3) and where the audio begins, or None when there is
/// little to skip. Decoding is unaffected: the decoder never reads that metadata's contents.
pub fn lean_head(r: &mut dyn ByteSource, total: u64, min_skip: u64) -> Option<(Arc<[u8]>, u64)> {
    let mut h = [0u8; 10];
    read_exact_at(r, 0, &mut h).ok()?;
    if &h[..3] == b"ID3" {
        // Syncsafe size; +10 header, +10 footer when flagged.
        if h[6..10].iter().any(|b| b & 0x80 != 0) {
            return None;
        }
        let size = h[6..10].iter().fold(0u64, |a, &b| (a << 7) | b as u64) + 10 + if h[5] & 0x10 != 0 { 10 } else { 0 };
        return (size >= min_skip && size < total).then(|| (Arc::from(Vec::new()), size));
    }
    if &h[..4] != b"fLaC" {
        return None;
    }
    // Kept blocks are copied as they are met, so reads only move forward (the last one, next to
    // the audio, steers the cache's read-ahead).
    let mut pos = 4u64;
    let mut head = b"fLaC".to_vec();
    let mut last_kept: Option<usize> = None;
    let mut skipped = 0u64;
    for _ in 0..128 {
        let mut b = [0u8; 4];
        read_exact_at(r, pos, &mut b).ok()?;
        let (kind, last, len) = (b[0] & 0x7f, b[0] & 0x80 != 0, u32::from_be_bytes([0, b[1], b[2], b[3]]));
        match kind {
            // PICTURE, PADDING: dropped.
            6 | 1 => skipped += 4 + len as u64,
            127 => return None,
            _ => {
                if (head.len() == 4) != (kind == 0) || head.len() as u64 + 4 + len as u64 > MAX_HEAD {
                    // STREAMINFO must come first; oversized metadata isn't worth rebuilding.
                    return None;
                }
                last_kept = Some(head.len());
                head.push(kind);
                head.extend_from_slice(&len.to_be_bytes()[1..]);
                let start = head.len();
                head.resize(start + len as usize, 0);
                read_exact_at(r, pos + 4, &mut head[start..]).ok()?;
            }
        }
        pos += 4 + len as u64;
        if pos > total {
            return None;
        }
        if last {
            if skipped < min_skip {
                return None;
            }
            head[last_kept?] |= 0x80;
            return Some((head.into(), pos));
        }
    }
    None
}

/// A whole byte source as a symphonia media source.
pub struct Plain(pub Box<dyn ByteSource>, pub u64);

impl Read for Plain {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

impl Seek for Plain {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.0.seek(to)
    }
}

impl MediaSource for Plain {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.1)
    }
}

/// `head` followed by the file (`total` bytes) from `from` on, as one seekable stream.
pub struct Spliced {
    inner: Box<dyn ByteSource>,
    head: Arc<[u8]>,
    from: u64,
    total: u64,
    pos: u64,
    /// Inner position, to skip redundant seeks.
    inner_pos: Option<u64>,
}

impl Spliced {
    pub fn new(inner: Box<dyn ByteSource>, head: Arc<[u8]>, from: u64, total: u64) -> Self {
        Self { inner, head, from, total, pos: 0, inner_pos: None }
    }

    fn len(&self) -> u64 {
        self.head.len() as u64 + self.total.saturating_sub(self.from)
    }
}

impl Read for Spliced {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let head = self.head.len() as u64;
        if self.pos < head {
            let n = ((head - self.pos) as usize).min(buf.len());
            buf[..n].copy_from_slice(&self.head[self.pos as usize..self.pos as usize + n]);
            self.pos += n as u64;
            return Ok(n);
        }
        let at = self.from + (self.pos - head);
        if self.inner_pos != Some(at) {
            self.inner.seek(SeekFrom::Start(at))?;
        }
        let n = self.inner.read(buf)?;
        self.pos += n as u64;
        self.inner_pos = Some(at + n as u64);
        Ok(n)
    }
}

impl Seek for Spliced {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let new = match to {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::Current(d) => self.pos as i128 + d as i128,
            SeekFrom::End(d) => self.len() as i128 + d as i128,
        };
        if new < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before start"));
        }
        self.pos = new as u64;
        Ok(self.pos)
    }
}

impl MediaSource for Spliced {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(body);
        v
    }

    /// ftyp + moov + sidx + 3 × (moof + mdat), fragment durations 100/200/300 at timescale 1000.
    fn sample() -> (Vec<u8>, Vec<u64>) {
        let mut f = bx(b"ftyp", b"M4A isom");
        f.extend(bx(b"moov", &[7u8; 40]));
        let frags: Vec<Vec<u8>> = (0..3u8).map(|i| [bx(b"moof", &[i; 20]), bx(b"mdat", &vec![i; 100 + i as usize * 50])].concat()).collect();
        let mut sidx = vec![0u8, 0, 0, 0];
        sidx.extend(1u32.to_be_bytes()); // reference id
        sidx.extend(1000u32.to_be_bytes()); // timescale
        sidx.extend(0u32.to_be_bytes()); // earliest presentation time
        sidx.extend(0u32.to_be_bytes()); // first offset
        sidx.extend([0u8, 0]);
        sidx.extend(3u16.to_be_bytes());
        for (i, fr) in frags.iter().enumerate() {
            sidx.extend((fr.len() as u32).to_be_bytes());
            sidx.extend(((i as u32 + 1) * 100).to_be_bytes());
            sidx.extend(0x9000_0000u32.to_be_bytes());
        }
        f.extend(bx(b"sidx", &sidx));
        let mut offsets = Vec::new();
        for fr in &frags {
            offsets.push(f.len() as u64);
            f.extend(fr);
        }
        (f, offsets)
    }

    #[test]
    fn index_and_splice() {
        let (file, offsets) = sample();
        let ix = FragIndex::read(Box::new(io::Cursor::new(file.clone()))).unwrap();
        assert_eq!(ix.timescale, 1000);
        assert_eq!(ix.frags.iter().map(|f| f.offset).collect::<Vec<_>>(), offsets);
        assert_eq!(ix.frags.iter().map(|f| f.ts).collect::<Vec<_>>(), vec![0, 100, 300]);
        assert_eq!(&ix.head[..], &file[..offsets[0] as usize]);
        assert_eq!(ix.fragment_for(0, 0), 0);
        assert_eq!(ix.fragment_for(299, 0), 1);
        assert_eq!(ix.fragment_for(300, 0), 2);
        assert_eq!(ix.fragment_for(320, 50), 1);
        let ix = Arc::new(ix);
        let mut sp = Spliced::new(Box::new(io::Cursor::new(file.clone())), ix.head.clone(), offsets[2], ix.total_len);
        let mut all = Vec::new();
        sp.read_to_end(&mut all).unwrap();
        let expect = [&file[..offsets[0] as usize], &file[offsets[2] as usize..]].concat();
        assert_eq!(all, expect);
        assert_eq!(sp.byte_len(), Some(expect.len() as u64));
        sp.seek(SeekFrom::Start(ix.head.len() as u64 + 3)).unwrap();
        let mut b = [0u8; 5];
        sp.read_exact(&mut b).unwrap();
        assert_eq!(&b[..], &expect[ix.head.len() + 3..ix.head.len() + 8]);
    }

    #[test]
    fn rejects_non_fragmented_and_corrupt() {
        let mut plain = bx(b"ftyp", b"M4A isom");
        plain.extend(bx(b"moov", &[0u8; 16]));
        plain.extend(bx(b"mdat", &[0u8; 64]));
        assert!(FragIndex::read(Box::new(io::Cursor::new(plain))).is_none());
        let (mut file, _) = sample();
        // Box size pointing past the end.
        file[3] = 0xff;
        file[2] = 0xff;
        assert!(FragIndex::read(Box::new(io::Cursor::new(file))).is_none());
        assert!(FragIndex::read(Box::new(io::Cursor::new(Vec::new()))).is_none());
        let (file, _) = sample();
        for cut in [10, 30, 70, 120] {
            assert!(FragIndex::read(Box::new(io::Cursor::new(file[..cut].to_vec()))).is_none());
        }
    }
}
