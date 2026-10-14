//! Minimal WAV I/O (32-bit float and 16-bit PCM) for offline renders and tests.

use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Streaming WAV writer: 32-bit IEEE float, interleaved. Header is patched on `finish`.
pub struct WavWriter<W: Write + Seek> {
    out: W,
    channels: u16,
    frames: u64,
}

impl WavWriter<io::BufWriter<std::fs::File>> {
    pub fn create(path: &Path, rate: u32, channels: u16) -> io::Result<Self> {
        Self::new(io::BufWriter::new(std::fs::File::create(path)?), rate, channels)
    }
}

impl<W: Write + Seek> WavWriter<W> {
    pub fn new(mut out: W, rate: u32, channels: u16) -> io::Result<Self> {
        let block_align = channels as u32 * 4;
        out.write_all(b"RIFF")?;
        out.write_all(&0u32.to_le_bytes())?;
        out.write_all(b"WAVE")?;
        out.write_all(b"fmt ")?;
        out.write_all(&16u32.to_le_bytes())?;
        out.write_all(&3u16.to_le_bytes())?; // IEEE float
        out.write_all(&channels.to_le_bytes())?;
        out.write_all(&rate.to_le_bytes())?;
        out.write_all(&(rate * block_align).to_le_bytes())?;
        out.write_all(&(block_align as u16).to_le_bytes())?;
        out.write_all(&32u16.to_le_bytes())?;
        out.write_all(b"data")?;
        out.write_all(&0u32.to_le_bytes())?;
        Ok(Self { out, channels, frames: 0 })
    }

    pub fn write(&mut self, samples: &[f32]) -> io::Result<()> {
        let mut buf = Vec::with_capacity(samples.len() * 4);
        for s in samples {
            buf.extend_from_slice(&s.to_le_bytes());
        }
        self.out.write_all(&buf)?;
        self.frames += (samples.len() / self.channels as usize) as u64;
        Ok(())
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    pub fn finish(mut self) -> io::Result<W> {
        let data_len = (self.frames * self.channels as u64 * 4).min(u32::MAX as u64 - 36) as u32;
        self.out.seek(SeekFrom::Start(4))?;
        self.out.write_all(&(36 + data_len).to_le_bytes())?;
        self.out.seek(SeekFrom::Start(40))?;
        self.out.write_all(&data_len.to_le_bytes())?;
        self.out.flush()?;
        Ok(self.out)
    }
}

/// Write a whole float WAV file.
pub fn write_f32(path: &Path, rate: u32, channels: u16, samples: &[f32]) -> io::Result<()> {
    let mut w = WavWriter::create(path, rate, channels)?;
    w.write(samples)?;
    w.finish()?;
    Ok(())
}

/// Read a float or 16-bit PCM WAV file → (interleaved f32, channels, rate).
pub fn read(path: &Path) -> io::Result<(Vec<f32>, u16, u32)> {
    let mut b = Vec::new();
    std::fs::File::open(path)?.read_to_end(&mut b)?;
    let bad = || io::Error::new(io::ErrorKind::InvalidData, "not a supported WAV file");
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err(bad());
    }
    let mut p = 12;
    let (mut fmt, mut ch, mut rate, mut bits) = (0u16, 0u16, 0u32, 0u16);
    while p + 8 <= b.len() {
        let id = &b[p..p + 4];
        let len = u32::from_le_bytes(b[p + 4..p + 8].try_into().unwrap()) as usize;
        let body = &b[p + 8..(p + 8 + len).min(b.len())];
        if id == b"fmt " && body.len() >= 16 {
            fmt = u16::from_le_bytes([body[0], body[1]]);
            ch = u16::from_le_bytes([body[2], body[3]]);
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            bits = u16::from_le_bytes([body[14], body[15]]);
        } else if id == b"data" {
            let out = match (fmt, bits) {
                (3, 32) => body.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect(),
                (1, 16) => body.as_chunks::<2>().0.iter().map(|c| i16::from_le_bytes(*c) as f32 / 32768.0).collect(),
                _ => return Err(bad()),
            };
            return Ok((out, ch, rate));
        }
        p += 8 + len + (len & 1);
    }
    Err(bad())
}
