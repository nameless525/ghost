//! Streaming FLAC writer on top of `flacenc` (pure Rust): frames are encoded and written as
//! they come, and the STREAMINFO header (total samples, frame sizes, MD5) is patched at the end,
//! so rendering a long track never holds it all in memory.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

use flacenc::bitsink::ByteSink;
use flacenc::component::{BitRepr, Stream};
use flacenc::config;
use flacenc::error::{Verified, Verify};
use flacenc::source::{Context, Fill, FrameBuf};

const BLOCK: usize = 4096;

pub struct FlacWriter {
    out: BufWriter<File>,
    stream: Stream,
    config: Verified<config::Encoder>,
    fb: FrameBuf,
    ctx: Context,
    pending: Vec<i32>,
    channels: usize,
    scale: f32,
    max: i32,
    frame_no: usize,
    frames_written: u64,
}

fn io_err(e: impl std::fmt::Debug) -> std::io::Error {
    std::io::Error::other(format!("flac: {e:?}"))
}

impl FlacWriter {
    /// `bits` is 16 or 24; `channels` 1..=8.
    pub fn create(path: &Path, rate: u32, channels: usize, bits: usize) -> std::io::Result<Self> {
        let mut stream = Stream::new(rate as usize, channels, bits).map_err(io_err)?;
        stream.stream_info_mut().set_block_sizes(BLOCK, BLOCK).map_err(io_err)?;
        // 0 = "unknown" until the end, when the real sizes are patched in.
        stream.stream_info_mut().set_frame_sizes(0, 0).map_err(io_err)?;
        let config = config::Encoder::default().into_verified().map_err(|e| io_err(e.1))?;
        let mut out = BufWriter::with_capacity(1 << 20, File::create(path)?);
        let header = Self::header_bytes(&stream)?;
        out.write_all(&header)?;
        Ok(Self {
            out,
            stream,
            config,
            fb: FrameBuf::with_size(channels, BLOCK).map_err(io_err)?,
            ctx: Context::new(bits, channels),
            pending: Vec::with_capacity(BLOCK * channels),
            channels,
            scale: ((1i64 << (bits - 1)) - 1) as f32,
            max: ((1i64 << (bits - 1)) - 1) as i32,
            frame_no: 0,
            frames_written: 0,
        })
    }

    fn header_bytes(stream: &Stream) -> std::io::Result<Vec<u8>> {
        let mut sink = ByteSink::new();
        stream.write(&mut sink).map_err(io_err)?;
        Ok(sink.into_inner())
    }

    /// Append interleaved float samples (`channels` per frame), clipped to full scale.
    pub fn write(&mut self, samples: &[f32]) -> std::io::Result<()> {
        let (scale, max) = (self.scale, self.max);
        for &s in samples {
            let v = (s * scale).round();
            self.pending.push((v as i32).clamp(-max - 1, max));
            if self.pending.len() == BLOCK * self.channels {
                self.flush_block()?;
            }
        }
        Ok(())
    }

    fn flush_block(&mut self) -> std::io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        self.fb.fill_interleaved(&self.pending).map_err(io_err)?;
        self.ctx.fill_interleaved(&self.pending).map_err(io_err)?;
        let frame = flacenc::encode_fixed_size_frame(&self.config, &self.fb, self.frame_no, self.stream.stream_info()).map_err(io_err)?;
        self.stream.stream_info_mut().update_frame_info(&frame);
        let mut sink = ByteSink::new();
        frame.write(&mut sink).map_err(io_err)?;
        self.out.write_all(sink.as_slice())?;
        self.frames_written += (self.pending.len() / self.channels) as u64;
        self.frame_no += 1;
        self.pending.clear();
        Ok(())
    }

    /// Frames (per-channel samples) written so far.
    pub fn frames(&self) -> u64 {
        self.frames_written + (self.pending.len() / self.channels) as u64
    }

    /// Encode what's left and patch the header.
    pub fn finish(mut self) -> std::io::Result<u64> {
        self.flush_block()?;
        let total = self.frames_written;
        let info = self.stream.stream_info_mut();
        info.set_md5_digest(&self.ctx.md5_digest());
        info.set_total_samples(total as usize);
        // Like libFLAC: a fixed-blocksize stream advertises its block size (the shorter last
        // block doesn't count), unless it is a single short block.
        let bs = if self.frame_no > 1 { BLOCK } else { (total as usize).clamp(16, BLOCK) };
        info.set_block_sizes(bs, bs).map_err(io_err)?;
        let header = Self::header_bytes(&self.stream)?;
        self.out.flush()?;
        let mut f = self.out.into_inner().map_err(|e| e.into_error())?;
        f.seek(SeekFrom::Start(0))?;
        f.write_all(&header)?;
        f.sync_all()?;
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_valid_flac_that_decodes_back() {
        let dir = std::env::temp_dir().join(format!("ghost-flac-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.flac");
        let rate = 44_100;
        let frames = 10_000 + 123;
        let sig: Vec<f32> = (0..frames).flat_map(|i| {
            let v = (i as f32 * 0.05).sin() * 0.5;
            [v, -v]
        }).collect();
        let mut w = FlacWriter::create(&path, rate, 2, 16).unwrap();
        w.write(&sig[..5000]).unwrap();
        w.write(&sig[5000..]).unwrap();
        assert_eq!(w.finish().unwrap(), frames as u64);
        // Decode with symphonia and compare.
        let spec = crate::SourceSpec::file(&path);
        let cache = crate::cache::CacheManager::new(dir.join("c"), 1 << 30, "t").unwrap();
        let ctx = crate::source::OpenCtx { cache: &cache, cancel: Default::default(), accurate_seek: true };
        let mut src = crate::source::open(&spec, &ctx).unwrap();
        assert_eq!(src.duration(), Some(frames as u64));
        let mut out = vec![0.0f32; sig.len() + 100];
        let mut n = 0;
        loop {
            let k = src.read(&mut out[n..]).unwrap();
            if k == 0 {
                break;
            }
            n += k * 2;
        }
        assert_eq!(n, sig.len());
        let err = sig.iter().zip(&out).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(err < 1.0 / 32000.0, "max error {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
