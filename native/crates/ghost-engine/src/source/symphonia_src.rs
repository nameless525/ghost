//! symphonia-backed source: MP3, FLAC, AAC/M4A, ALAC, Vorbis/Ogg, Opus (libopus, see [`opus`]),
//! WAV/AIFF, MKV/WebM, CAF. Gapless decoding is on, so encoder delay and padding are trimmed by
//! the decoder; Opus pre-skip is trimmed here, by timestamp.
//!
//! Two things keep streamed opens and seeks cheap:
//! - The probe skips trailing-tag detection (ID3v1 / APE at the end of the file), which would
//!   fetch the last chunk of an uncached stream before the first audio; tags are unused here.
//! - Fragmented MP4 with a segment index (`sidx`; YouTube, SoundCloud) seeks through the index:
//!   symphonia would otherwise read every fragment header from the start to find the target,
//!   i.e. download everything before it. The reader is rebuilt over a view of the file that is
//!   the header followed by the target fragment onwards (see [`frag`]).

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, OnceLock};

use symphonia::core::audio::{ChannelLabel, Channels};
use symphonia::core::codecs::audio::well_known::CODEC_ID_OPUS;
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::{Hint, Probe};
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::{TimeBase, Timestamp};

use super::{frag, opus, AudioSource, OpenCtx, SourceError, SourceMeta};
use crate::cache::CacheManager;
use crate::util::extension_of;
use crate::SourceSpec;

/// Every symphonia container format, plus leading ID3v2 tags (so the probe skips them instead of
/// scanning through embedded cover art), but no trailing-tag readers: their anchors make
/// `Probe::probe` read the end of the stream first.
fn probe() -> &'static Probe {
    static PROBE: OnceLock<Probe> = OnceLock::new();
    PROBE.get_or_init(|| {
        use symphonia::default::formats::*;
        let mut p = Probe::default();
        p.register_format::<AdtsReader<'_>>();
        p.register_format::<CafReader<'_>>();
        p.register_format::<FlacReader<'_>>();
        p.register_format::<IsoMp4Reader<'_>>();
        p.register_format::<MpaReader<'_>>();
        p.register_format::<AiffReader<'_>>();
        p.register_format::<WavReader<'_>>();
        p.register_format::<OggReader<'_>>();
        p.register_format::<MkvReader<'_>>();
        p.register_metadata::<symphonia::default::meta::Id3v2Reader<'_>>();
        p
    })
}

/// Leading metadata at least this large is skipped while a stream is still downloading.
const LEAN_MIN_SKIP: u64 = 256 * 1024;

/// Where the bytes come from, so the format reader can be rebuilt over another view of them.
enum Origin {
    Http { cache: Arc<CacheManager>, spec: SourceSpec, cancel: Arc<AtomicBool>, background: bool },
    File(std::path::PathBuf),
    Bytes(Arc<[u8]>),
}

impl Origin {
    fn open(&self) -> Result<Box<dyn frag::ByteSource>, SourceError> {
        Ok(match self {
            Origin::Http { cache, spec, cancel, background } => {
                Box::new(OpenCtx { cache, cancel: cancel.clone(), accurate_seek: false, background: *background }.reader(spec)?)
            }
            Origin::File(p) => Box::new(std::fs::File::open(p).map_err(|e| SourceError::new(format!("open {}: {e}", p.display())))?),
            Origin::Bytes(b) => Box::new(std::io::Cursor::new(SharedBytes(b.clone()))),
        })
    }
}

pub struct SymphoniaSource {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    rate: u32,
    channels: usize,
    /// WAVE channel mask of the decoder's channels, when it positions them.
    mask: Option<u32>,
    time_base: Option<TimeBase>,
    /// Frames the track's timestamps run ahead of its audio: Ogg Opus counts its pre-skip in
    /// them (symphonia leaves it to the decoder, which can't see it).
    ts_shift: i64,
    /// Frames to decode before a seek target (Opus needs 80 ms to converge).
    preroll: u64,
    /// Decoded, not yet consumed samples (interleaved).
    buf: Vec<f32>,
    buf_pos: usize,
    /// After an accurate seek: drop decoded frames before this frame index.
    skip_until: Option<u64>,
    duration: Option<u64>,
    meta: SourceMeta,
    accurate_seek: bool,
    consecutive_errors: u32,
    ended: bool,
    origin: Origin,
    hint_ext: Option<String>,
    /// Fragment index of a fragmented MP4 (None for everything else).
    frags: Option<Arc<frag::FragIndex>>,
    /// Start of each indexed fragment in codec frames.
    frag_frames: Vec<i64>,
    /// Fragment the current format reader starts at (0 = the whole file).
    frag_start: usize,
    /// Track timestamp (codec frames) of the current reader's first fragment: its timestamps
    /// restart at 0 there.
    frame_offset: i64,
}

fn sym_err(e: SymError) -> SourceError {
    SourceError::new(format!("decode: {e}"))
}

/// Symphonia's channels as a WAVE channel mask (see [`AudioSource::channel_mask`]), when they
/// are speaker positions in mask order.
fn wave_mask(channels: &Channels) -> Option<u32> {
    let mask = match channels {
        Channels::Positioned(p) => u32::try_from(p.bits()).ok()?,
        Channels::Custom(labels) => {
            let mut mask = 0u32;
            for label in labels.iter() {
                let ChannelLabel::Positioned(p) = label else { return None };
                let bit = u32::try_from(p.bits()).ok().filter(|b| b.is_power_of_two())?;
                // Out of mask order (or repeated): the channels can't be described by a mask.
                if bit <= mask {
                    return None;
                }
                mask |= bit;
            }
            mask
        }
        _ => return None,
    };
    // Only the first 18 positions are WAVE's.
    (mask >> 18 == 0).then_some(mask)
}

/// Shared bytes as a symphonia media source (archive entries).
struct SharedBytes(Arc<[u8]>);
impl AsRef<[u8]> for SharedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl SymphoniaSource {
    pub fn open(spec: &SourceSpec, ctx: &OpenCtx<'_>) -> Result<Self, SourceError> {
        type Opened = (Box<dyn MediaSource>, Option<String>, Option<String>, Option<u64>, bool, Origin);
        let (media, hint_ext, mime, byte_len, complete, origin): Opened =
            match spec {
                SourceSpec::File { path, format_hint, .. } => {
                    let f = std::fs::File::open(path).map_err(|e| SourceError::new(format!("open {}: {e}", path.display())))?;
                    let len = f.metadata().ok().map(|m| m.len());
                    let ext = format_hint.clone().or_else(|| extension_of(&path.to_string_lossy()));
                    (Box::new(f), ext, None, len, true, Origin::File(path.clone()))
                }
                SourceSpec::Http { url, format_hint, .. } => {
                    let base = spec.base();
                    let mut reader = ctx.reader(&base)?;
                    // Wait for the first bytes (and with them the size / content type).
                    reader.wait_header().map_err(|e| SourceError::new(e.to_string()))?;
                    let len = reader.total_len();
                    let mime = reader.content_type();
                    let complete = reader.is_complete();
                    let ext = format_hint.clone().or_else(|| extension_of(url));
                    let origin = Origin::Http { cache: ctx.cache.clone(), spec: base, cancel: ctx.cancel.clone(), background: ctx.background };
                    // Still downloading: don't make playback wait for embedded cover art.
                    let lean = match (complete, len) {
                        (false, Some(total)) => frag::lean_head(&mut reader, total, LEAN_MIN_SKIP).map(|v| (v, total)),
                        _ => None,
                    };
                    let media: Box<dyn MediaSource> = match lean {
                        Some(((head, from), total)) => Box::new(frag::Spliced::new(Box::new(reader), head, from, total)),
                        None => Box::new(reader),
                    };
                    (media, ext, mime, len, complete, origin)
                }
            };
        Self::open_media(media, hint_ext, mime, byte_len, ctx.accurate_seek || complete, origin)
    }

    /// Decode an in-memory file (e.g. an MP3 inside a zip set).
    pub fn open_bytes(data: Arc<[u8]>, ext: Option<String>) -> Result<Self, SourceError> {
        let len = data.len() as u64;
        let origin = Origin::Bytes(data.clone());
        Self::open_media(Box::new(std::io::Cursor::new(SharedBytes(data))), ext, None, Some(len), true, origin)
    }

    fn make_format(media: Box<dyn MediaSource>, hint_ext: Option<&str>, mime: Option<&str>) -> Result<Box<dyn FormatReader>, SourceError> {
        let mut hint = Hint::new();
        if let Some(ext) = hint_ext {
            // A format hint may be a mime type or an extension.
            if ext.contains('/') {
                hint.mime_type(ext);
            } else {
                hint.with_extension(ext.trim_start_matches('.'));
            }
        }
        if let Some(m) = mime {
            let m = m.split(';').next().unwrap_or(m).trim();
            if !m.is_empty() && m != "application/octet-stream" {
                hint.mime_type(m);
            }
        }

        let mss = MediaSourceStream::new(media, MediaSourceStreamOptions { buffer_len: 64 * 1024 });
        probe()
            .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
            .map_err(|e| SourceError::new(format!("unsupported or corrupt stream: {e}")))
    }

    fn open_media(
        media: Box<dyn MediaSource>,
        hint_ext: Option<String>,
        mime: Option<String>,
        byte_len: Option<u64>,
        accurate_seek: bool,
        origin: Origin,
    ) -> Result<Self, SourceError> {
        let format = Self::make_format(media, hint_ext.as_deref(), mime.as_deref())?;

        let track = format.default_track(TrackType::Audio).ok_or_else(|| SourceError::new("no audio track"))?;
        let track_id = track.id;
        let params = track
            .codec_params
            .as_ref()
            .and_then(|p| p.audio())
            .ok_or_else(|| SourceError::new("no audio codec parameters"))?
            .clone();
        let time_base = track.time_base;
        let num_frames = track.num_frames;
        let track_duration = track.duration;
        let opus = params.codec == CODEC_ID_OPUS;
        // Ogg Opus timestamps (granule positions) include the pre-skip, which symphonia's Ogg
        // mapper only records as the track's delay; Matroska's are already shifted back by it.
        let ts_shift = if opus && format.format_info().short_name == "ogg" { track.delay.unwrap_or(0) as i64 } else { 0 };

        let dec_opts = AudioDecoderOptions::default().gapless(true);
        let decoder = opus::codecs().make_audio_decoder(&params, &dec_opts).map_err(|e| SourceError::new(format!("unsupported codec: {e}")))?;

        // The decoder's parameters describe its output (Opus decodes at 48 kHz whatever the
        // container says, and positions its channels); the container's fill the gaps.
        let out = decoder.codec_params();
        let rate = out.sample_rate.or(params.sample_rate).unwrap_or(44_100);
        let layout = out.channels.as_ref().or(params.channels.as_ref());
        let channels = layout.map(|c| c.count()).unwrap_or(2).max(1);
        let mask = layout.and_then(wave_mask).filter(|m| m.count_ones() as usize == channels);

        let num_frames = num_frames.map(|n| n.saturating_sub(ts_shift as u64));
        let duration = num_frames.or_else(|| {
            let tb = time_base?;
            let t = tb.calc_duration(track_duration?)?;
            Some((t.as_secs_f64() * rate as f64).round() as u64)
        });
        let bitrate_kbps = match (byte_len, duration) {
            (Some(b), Some(d)) if d > 0 => Some(((b as f64 * 8.0) / (d as f64 / rate as f64) / 1000.0).round() as u32),
            _ => None,
        };
        let meta = SourceMeta { codec: decoder.codec_info().short_name.to_string(), bitrate_kbps, ..Default::default() };
        // Only worth it when seeking needs it, i.e. for fragmented MP4 (cheap: reads the header).
        let frags = if format.format_info().short_name == "isomp4" { origin.open().ok().and_then(frag::FragIndex::read).map(Arc::new) } else { None };

        Ok(Self {
            format,
            decoder,
            track_id,
            rate,
            channels,
            mask,
            time_base,
            ts_shift,
            preroll: if opus { ghost_formats::opus::SEEK_PREROLL } else { 0 },
            buf: Vec::with_capacity(8192),
            buf_pos: 0,
            // Opus starts with its pre-skip: decoder warm-up at negative times.
            skip_until: opus.then_some(0),
            duration,
            meta,
            accurate_seek,
            consecutive_errors: 0,
            ended: false,
            origin,
            hint_ext,
            frags,
            frag_frames: Vec::new(),
            frag_start: 0,
            frame_offset: 0,
        })
        .map(|mut s| {
            s.index_fragments();
            s
        })
    }

    /// Fragment start times → codec frames (exact when the index and the track share a
    /// timescale, as they do in practice).
    fn index_fragments(&mut self) {
        let Some(ix) = self.frags.clone() else { return };
        let same_scale = self.time_base.is_some_and(|tb| tb.numer.get() == 1 && tb.denom.get() == ix.timescale);
        self.frag_frames = ix
            .frags
            .iter()
            .map(|f| {
                if same_scale {
                    self.ts_to_frame(f.ts as i64)
                } else {
                    (f.ts as f64 * self.rate as f64 / ix.timescale as f64).round() as i64
                }
            })
            .collect();
    }

    /// Rebuild the format reader so it starts at fragment `k` of a fragmented MP4 (0 = the
    /// whole file). The decoder is kept (the caller resets it).
    fn restart_at_fragment(&mut self, k: usize) -> Result<(), SourceError> {
        let Some(ix) = self.frags.clone() else { return Ok(()) };
        let media: Box<dyn MediaSource> = if k == 0 {
            Box::new(frag::Plain(self.origin.open()?, ix.total_len))
        } else {
            Box::new(frag::Spliced::new(self.origin.open()?, ix.head.clone(), ix.frags[k].offset, ix.total_len))
        };
        let format = Self::make_format(media, self.hint_ext.as_deref().or(Some("m4a")), None)?;
        let track = format.default_track(TrackType::Audio).ok_or_else(|| SourceError::new("no audio track"))?;
        self.track_id = track.id;
        self.format = format;
        self.frag_start = k;
        self.frame_offset = self.frag_frames[k];
        Ok(())
    }

    /// Track timestamp → frame index at the codec rate.
    fn ts_to_frame(&self, ts: i64) -> i64 {
        match self.time_base {
            Some(tb) if !(tb.numer.get() == 1 && tb.denom.get() == self.rate) => {
                let secs = ts as f64 * tb.numer.get() as f64 / tb.denom.get() as f64;
                (secs * self.rate as f64).round() as i64
            }
            _ => ts,
        }
    }

    fn frame_to_ts(&self, frame: u64) -> i64 {
        match self.time_base {
            Some(tb) if !(tb.numer.get() == 1 && tb.denom.get() == self.rate) => {
                let secs = frame as f64 / self.rate as f64;
                (secs * tb.denom.get() as f64 / tb.numer.get() as f64).round() as i64
            }
            _ => frame as i64,
        }
    }

    /// Decode the next packet into `buf`. Returns false at end of stream.
    fn decode_next(&mut self) -> Result<bool, SourceError> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => return Ok(false),
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(false),
                Err(SymError::ResetRequired) => return Ok(false),
                Err(SymError::DecodeError(_)) => {
                    self.consecutive_errors += 1;
                    if self.consecutive_errors > 64 {
                        return Err(SourceError::new("too many consecutive demux errors"));
                    }
                    continue;
                }
                Err(e) => return Err(sym_err(e)),
            };
            if packet.track_id != self.track_id {
                continue;
            }
            let first_frame = self.ts_to_frame(packet.pts.get().saturating_add(packet.trim_start.get() as i64)) + self.frame_offset - self.ts_shift;
            match self.decoder.decode(&packet) {
                Ok(audio) => {
                    self.consecutive_errors = 0;
                    let frames = audio.frames();
                    if frames == 0 {
                        continue;
                    }
                    let ch = audio.num_planes().max(1);
                    self.buf.clear();
                    self.buf_pos = 0;
                    if ch == self.channels {
                        audio.copy_to_vec_interleaved::<f32>(&mut self.buf);
                    } else {
                        // Channel count changed mid-stream: remap to the announced layout.
                        let mut tmp: Vec<f32> = Vec::new();
                        audio.copy_to_vec_interleaved::<f32>(&mut tmp);
                        for f in tmp.chunks_exact(ch) {
                            for c in 0..self.channels {
                                self.buf.push(f[c.min(ch - 1)]);
                            }
                        }
                    }
                    if let Some(target) = self.skip_until {
                        let target = target as i64;
                        let end = first_frame + frames as i64;
                        if end <= target {
                            self.buf.clear();
                            continue;
                        }
                        if first_frame < target {
                            self.buf_pos = ((target - first_frame) as usize * self.channels).min(self.buf.len());
                        }
                        self.skip_until = None;
                    }
                    return Ok(true);
                }
                Err(SymError::DecodeError(_)) | Err(SymError::IoError(_)) => {
                    // Undecodable packet: skip it.
                    self.consecutive_errors += 1;
                    if self.consecutive_errors > 64 {
                        return Err(SourceError::new("too many consecutive decode errors"));
                    }
                    continue;
                }
                Err(SymError::ResetRequired) => return Ok(false),
                Err(e) => return Err(sym_err(e)),
            }
        }
    }
}

impl AudioSource for SymphoniaSource {
    fn sample_rate(&self) -> u32 {
        self.rate
    }
    fn channels(&self) -> usize {
        self.channels
    }
    fn channel_mask(&self) -> Option<u32> {
        self.mask
    }

    fn read(&mut self, out: &mut [f32]) -> Result<usize, SourceError> {
        let ch = self.channels;
        let want = out.len() / ch * ch;
        let mut filled = 0;
        while filled < want {
            if self.buf_pos >= self.buf.len() {
                if self.ended || !self.decode_next()? {
                    self.ended = true;
                    break;
                }
                continue;
            }
            let n = (want - filled).min(self.buf.len() - self.buf_pos);
            out[filled..filled + n].copy_from_slice(&self.buf[self.buf_pos..self.buf_pos + n]);
            self.buf_pos += n;
            filled += n;
        }
        Ok(filled / ch)
    }

    fn seek(&mut self, frame: u64) -> Result<u64, SourceError> {
        let mode = if self.accurate_seek { SeekMode::Accurate } else { SeekMode::Coarse };
        if !self.frag_frames.is_empty() {
            // Start the reader at the fragment holding the target, minus a little pre-roll, so
            // encoder-delay trimming at the new start never reaches the target.
            let t = frame as i64 - self.rate as i64 / 4;
            let k = self.frag_frames.partition_point(|&f| f <= t).saturating_sub(1);
            if k != self.frag_start {
                self.restart_at_fragment(k)?;
            }
        }
        // Land the pre-roll early, then decode up to the target.
        let from = frame.saturating_sub(self.preroll);
        let local = (from as i64 - self.frame_offset + self.ts_shift).max(0) as u64;
        let ts = Timestamp::new(self.frame_to_ts(local));
        let seeked = match self.format.seek(mode, SeekTo::Timestamp { ts, track_id: self.track_id }) {
            Ok(s) => s,
            Err(SymError::SeekError(_)) if frame > 0 => {
                // Out of range (e.g. past the end): treat as end of stream.
                self.ended = true;
                self.buf.clear();
                self.buf_pos = 0;
                return Ok(frame);
            }
            Err(e) => return Err(sym_err(e)),
        };
        self.decoder.reset();
        self.buf.clear();
        self.buf_pos = 0;
        self.ended = false;
        let required = (self.ts_to_frame(seeked.required_ts.get()) + self.frame_offset - self.ts_shift).max(0) as u64;
        let actual = (self.ts_to_frame(seeked.actual_ts.get()) + self.frame_offset - self.ts_shift).max(0) as u64;
        let target = required + (frame - from);
        if mode == SeekMode::Accurate || actual <= target {
            // Decode forward from the packet boundary and drop frames up to the target.
            self.skip_until = Some(target);
            Ok(frame)
        } else {
            // Coarse seek landed past the target: start there and report it.
            self.skip_until = None;
            Ok(actual)
        }
    }

    fn duration(&self) -> Option<u64> {
        self.duration
    }

    fn meta(&self) -> SourceMeta {
        self.meta.clone()
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

    fn full(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
        let mut b = vec![version];
        b.extend_from_slice(&flags.to_be_bytes()[1..]);
        b.extend_from_slice(body);
        bx(kind, &b)
    }

    /// A fragmented MP4 of 16-bit stereo PCM (`sowt`) with a `sidx`: `frags` fragments of
    /// `per` frames. Returns the file and the interleaved samples.
    fn fmp4(rate: u32, frags: usize, per: usize) -> (Vec<u8>, Vec<i16>) {
        let u32b = |v: u32| v.to_be_bytes().to_vec();
        let matrix: Vec<u8> = [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000].iter().flat_map(|v| v.to_be_bytes()).collect();
        let mut mvhd = [u32b(0), u32b(0), u32b(rate), u32b(0), u32b(0x0001_0000)].concat();
        mvhd.extend([1, 0]);
        mvhd.extend([0u8; 10]);
        mvhd.extend(&matrix);
        mvhd.extend([0u8; 24]);
        mvhd.extend(u32b(2));
        let mut tkhd = [u32b(0), u32b(0), u32b(1), u32b(0), u32b(0)].concat();
        tkhd.extend([0u8; 8]);
        tkhd.extend([0, 0, 0, 0, 1, 0, 0, 0]);
        tkhd.extend(&matrix);
        tkhd.extend([0u8; 8]);
        let mut mdhd = [u32b(0), u32b(0), u32b(rate), u32b(0)].concat();
        mdhd.extend([0x55, 0xc4, 0, 0]);
        let mut hdlr = u32b(0);
        hdlr.extend(b"soun");
        hdlr.extend([0u8; 12]);
        hdlr.push(0);
        let mut sowt = vec![0u8; 6];
        sowt.extend([0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
        sowt.extend([0, 2, 0, 16, 0, 0, 0, 0]);
        sowt.extend(u32b(rate << 16));
        let stsd = full(b"stsd", 0, 0, &[u32b(1), bx(b"sowt", &sowt)].concat());
        let stbl = bx(b"stbl", &[stsd, full(b"stts", 0, 0, &u32b(0)), full(b"stsc", 0, 0, &u32b(0)), full(b"stsz", 0, 0, &[u32b(0), u32b(0)].concat()), full(b"stco", 0, 0, &u32b(0))].concat());
        let dinf = bx(b"dinf", &full(b"dref", 0, 0, &[u32b(1), full(b"url ", 0, 1, &[])].concat()));
        let minf = bx(b"minf", &[full(b"smhd", 0, 0, &[0, 0, 0, 0]), dinf, stbl].concat());
        let mdia = bx(b"mdia", &[full(b"mdhd", 0, 0, &mdhd), full(b"hdlr", 0, 0, &hdlr), minf].concat());
        let trak = bx(b"trak", &[full(b"tkhd", 0, 3, &tkhd), mdia].concat());
        let mvex = bx(b"mvex", &full(b"trex", 0, 0, &[u32b(1), u32b(1), u32b(0), u32b(0), u32b(0)].concat()));
        let moov = bx(b"moov", &[full(b"mvhd", 0, 0, &mvhd), trak, mvex].concat());
        let mut f = bx(b"ftyp", &[b"iso6".to_vec(), u32b(0), b"iso6dash".to_vec()].concat());
        f.extend(moov);
        let mut samples = Vec::new();
        let mut fr = Vec::new();
        for k in 0..frags {
            let pcm: Vec<i16> = (0..per * 2).map(|i| ((((k * per * 2 + i) * 37) % 60_000) as i32 - 30_000) as i16).collect();
            samples.extend(&pcm);
            let data: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
            let tfhd = full(b"tfhd", 0, 0x02_0018, &[u32b(1), u32b(1), u32b(4)].concat());
            let tfdt = full(b"tfdt", 1, 0, &((k * per) as u64).to_be_bytes());
            // trun data offset = moof size + mdat header; trun is the last box, so compute after.
            let trun_len = 8 + 4 + 8;
            let traf_len = 8 + tfhd.len() + tfdt.len() + trun_len;
            let moof_len = 8 + 16 + traf_len;
            let trun = full(b"trun", 0, 0x01, &[u32b(per as u32), u32b((moof_len + 8) as u32)].concat());
            let traf = bx(b"traf", &[tfhd, tfdt, trun].concat());
            let moof = bx(b"moof", &[full(b"mfhd", 0, 0, &u32b(k as u32 + 1)), traf].concat());
            assert_eq!(moof.len(), moof_len);
            fr.push([moof, bx(b"mdat", &data)].concat());
        }
        let mut sidx = [u32b(1), u32b(rate), u32b(0), u32b(0)].concat();
        sidx.extend([0, 0]);
        sidx.extend((frags as u16).to_be_bytes());
        for x in &fr {
            sidx.extend(u32b(x.len() as u32));
            sidx.extend(u32b(per as u32));
            sidx.extend(u32b(0x9000_0000));
        }
        f.extend(full(b"sidx", 0, 0, &sidx));
        for x in fr {
            f.extend(x);
        }
        (f, samples)
    }

    #[test]
    fn fragmented_mp4_seeks_through_the_index() {
        let (rate, frags, per) = (8_000u32, 12, 1_000);
        let (file, samples) = fmp4(rate, frags, per);
        let data: Arc<[u8]> = file.into();
        let mut src = SymphoniaSource::open_bytes(data.clone(), Some("m4a".into())).unwrap();
        assert_eq!(src.frag_frames.len(), frags, "fragment index not built");
        // Sequential decode matches the PCM.
        let mut all = Vec::new();
        let mut buf = vec![0.0f32; 2 * 777];
        loop {
            let n = src.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            all.extend_from_slice(&buf[..n * 2]);
        }
        assert_eq!(all.len(), samples.len());
        let want = |i: usize| samples[i] as f32 / 32768.0;
        assert!((all[12_345] - want(12_345)).abs() < 1e-6);
        // Seeks land exactly, from a reader restarted at the right fragment.
        for &target in &[10u64, 2_500, 5_000, 7_999, 11_000, 3_100, 0] {
            let mut s = SymphoniaSource::open_bytes(data.clone(), Some("m4a".into())).unwrap();
            assert_eq!(s.seek(target).unwrap(), target);
            let k = s.frag_start;
            let expect_k = ((target as i64 - rate as i64 / 4).max(0) as usize / per).min(frags - 1);
            assert_eq!(k, expect_k, "target {target}");
            let n = s.read(&mut buf).unwrap();
            assert!(n > 0);
            for i in 0..n * 2 {
                assert_eq!(buf[i], all[target as usize * 2 + i], "target {target} sample {i}");
            }
        }
    }
}
