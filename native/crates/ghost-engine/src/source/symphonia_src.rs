//! symphonia-backed source: MP3, FLAC, AAC/M4A, ALAC, Vorbis/Ogg, WAV/AIFF, MKV/WebM, CAF.
//! Gapless decoding is on, so encoder delay and padding are trimmed by the decoder.

use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::{TimeBase, Timestamp};

use super::{AudioSource, OpenCtx, SourceError, SourceMeta};
use crate::util::extension_of;
use crate::SourceSpec;

pub struct SymphoniaSource {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    rate: u32,
    channels: usize,
    time_base: Option<TimeBase>,
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
}

fn sym_err(e: SymError) -> SourceError {
    SourceError::new(format!("decode: {e}"))
}

/// Shared bytes as a symphonia media source (archive entries).
struct SharedBytes(std::sync::Arc<[u8]>);
impl AsRef<[u8]> for SharedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl SymphoniaSource {
    pub fn open(spec: &SourceSpec, ctx: &OpenCtx<'_>) -> Result<Self, SourceError> {
        type Opened = (Box<dyn MediaSource>, Option<String>, Option<String>, Option<u64>, bool);
        let (media, hint_ext, mime, byte_len, complete): Opened =
            match spec {
                SourceSpec::File { path, format_hint, .. } => {
                    let f = std::fs::File::open(path).map_err(|e| SourceError::new(format!("open {}: {e}", path.display())))?;
                    let len = f.metadata().ok().map(|m| m.len());
                    let ext = format_hint.clone().or_else(|| extension_of(&path.to_string_lossy()));
                    (Box::new(f), ext, None, len, true)
                }
                SourceSpec::Http { url, format_hint, .. } => {
                    let reader = ctx.cache.open_reader(&spec.base(), Some(ctx.cancel.clone())).map_err(|e| SourceError::new(e.to_string()))?;
                    // Wait for the first bytes (and with them the size / content type).
                    reader.wait_header().map_err(|e| SourceError::new(e.to_string()))?;
                    let len = reader.total_len();
                    let mime = reader.content_type();
                    let complete = reader.is_complete();
                    let ext = format_hint.clone().or_else(|| extension_of(url));
                    (Box::new(reader), ext, mime, len, complete)
                }
            };
        Self::open_media(media, hint_ext, mime, byte_len, ctx.accurate_seek || complete)
    }

    /// Decode an in-memory file (e.g. an MP3 inside a zip set).
    pub fn open_bytes(data: std::sync::Arc<[u8]>, ext: Option<String>) -> Result<Self, SourceError> {
        let len = data.len() as u64;
        Self::open_media(Box::new(std::io::Cursor::new(SharedBytes(data))), ext, None, Some(len), true)
    }

    fn open_media(media: Box<dyn MediaSource>, hint_ext: Option<String>, mime: Option<String>, byte_len: Option<u64>, accurate_seek: bool) -> Result<Self, SourceError> {
        let mut hint = Hint::new();
        if let Some(ext) = &hint_ext {
            // A format hint may be a mime type or an extension.
            if ext.contains('/') {
                hint.mime_type(ext);
            } else {
                hint.with_extension(ext.trim_start_matches('.'));
            }
        }
        if let Some(m) = &mime {
            let m = m.split(';').next().unwrap_or(m).trim();
            if !m.is_empty() && m != "application/octet-stream" {
                hint.mime_type(m);
            }
        }

        let mss = MediaSourceStream::new(media, MediaSourceStreamOptions { buffer_len: 64 * 1024 });
        let format = symphonia::default::get_probe()
            .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
            .map_err(|e| SourceError::new(format!("unsupported or corrupt stream: {e}")))?;

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

        let dec_opts = AudioDecoderOptions::default().gapless(true);
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&params, &dec_opts)
            .map_err(|e| SourceError::new(format!("unsupported codec: {e}")))?;

        let rate = params.sample_rate.or(decoder.codec_params().sample_rate).unwrap_or(44_100);
        let channels =
            params.channels.as_ref().or(decoder.codec_params().channels.as_ref()).map(|c| c.count()).unwrap_or(2).max(1);

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

        Ok(Self {
            format,
            decoder,
            track_id,
            rate,
            channels,
            time_base,
            buf: Vec::with_capacity(8192),
            buf_pos: 0,
            skip_until: None,
            duration,
            meta,
            accurate_seek,
            consecutive_errors: 0,
            ended: false,
        })
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
            let first_frame = self.ts_to_frame(packet.pts.get().saturating_add(packet.trim_start.get() as i64));
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
        let ts = Timestamp::new(self.frame_to_ts(frame));
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
        let required = self.ts_to_frame(seeked.required_ts.get()).max(0) as u64;
        let actual = self.ts_to_frame(seeked.actual_ts.get()).max(0) as u64;
        if mode == SeekMode::Accurate || actual <= required {
            // Decode forward from the packet boundary and drop frames up to the target.
            self.skip_until = Some(required);
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
