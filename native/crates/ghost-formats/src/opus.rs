//! libopus (1.6.1): decodes Opus packets. The engine's symphonia source reads the containers
//! (Ogg, WebM / Matroska, MP4) and hands their packets here. Every channel mapping goes through
//! libopus's multistream decoder: mono / stereo, Vorbis-order surround (up to 7.1), discrete.

use std::ffi::{c_char, c_int, c_uchar};

use crate::cstr_opt;
use crate::source::SourceError;

#[repr(C)]
struct MsDecoder {
    _p: [u8; 0],
}

extern "C" {
    fn opus_multistream_decoder_create(fs: i32, channels: c_int, streams: c_int, coupled_streams: c_int, mapping: *const c_uchar, error: *mut c_int) -> *mut MsDecoder;
    fn opus_multistream_decode_float(st: *mut MsDecoder, data: *const c_uchar, len: i32, pcm: *mut f32, frame_size: c_int, decode_fec: c_int) -> c_int;
    fn opus_multistream_decoder_ctl(st: *mut MsDecoder, request: c_int, ...) -> c_int;
    fn opus_multistream_decoder_destroy(st: *mut MsDecoder);
    fn opus_strerror(error: c_int) -> *const c_char;
}

const OPUS_RESET_STATE: c_int = 4028;

/// Opus always decodes at 48 kHz (the header's input rate is only informational).
pub const RATE: u32 = 48_000;
/// Frames in the longest packet (120 ms).
pub const MAX_FRAMES: usize = 5760;
/// Frames to decode before a seek target so the decoder has converged by then (80 ms, RFC 7845).
pub const SEEK_PREROLL: u64 = 3840;

/// The Opus identification header (RFC 7845 §5.1): Ogg Opus's first packet, WebM / Matroska's
/// CodecPrivate; symphonia turns MP4's `dOps` into the same bytes with its big-endian fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpusHead {
    pub channels: usize,
    /// Frames of decoder warm-up at the start of the stream, not part of the audio.
    pub pre_skip: u16,
    /// Output gain, dB in Q7.8.
    pub gain: i16,
    /// 0: mono / stereo; 1: Vorbis channel order (up to 7.1); 255: unpositioned; ...
    pub family: u8,
    pub streams: u8,
    pub coupled: u8,
    /// Coded channel feeding each output channel (255: silent).
    pub mapping: Vec<u8>,
}

impl OpusHead {
    pub fn parse(b: &[u8]) -> Option<Self> {
        if b.len() < 19 || &b[..8] != b"OpusHead" || b[8] >> 4 != 0 {
            return None;
        }
        // Version 0 is MP4's `dOps` (big-endian); Ogg / Matroska headers are version 1.
        let be = b[8] == 0;
        let u16_at = |o: usize| if be { u16::from_be_bytes([b[o], b[o + 1]]) } else { u16::from_le_bytes([b[o], b[o + 1]]) };
        let channels = b[9] as usize;
        let family = b[18];
        let (streams, coupled, mapping) = if family == 0 {
            if !(1..=2).contains(&channels) {
                return None;
            }
            (1, channels as u8 - 1, (0..channels as u8).collect())
        } else {
            let mapping = b.get(21..21 + channels)?;
            let (streams, coupled) = (b[19], b[20]);
            let coded = streams as usize + coupled as usize;
            if channels == 0 || streams == 0 || coupled > streams || coded > 255 || (family == 1 && channels > 8) {
                return None;
            }
            if mapping.iter().any(|&m| m != 255 && m as usize >= coded) {
                return None;
            }
            (streams, coupled, mapping.to_vec())
        };
        Some(Self { channels, pre_skip: u16_at(10), gain: u16_at(16) as i16, family, streams, coupled, mapping })
    }

    /// The header a stream without one (a container that gives only a channel count) implies.
    pub fn plain(channels: usize) -> Option<Self> {
        (1..=2).contains(&channels).then(|| Self {
            channels,
            pre_skip: 0,
            gain: 0,
            family: 0,
            streams: 1,
            coupled: channels as u8 - 1,
            mapping: (0..channels as u8).collect(),
        })
    }

    /// The output gain as a factor.
    pub fn gain_factor(&self) -> f32 {
        10f32.powf(self.gain as f32 / (20.0 * 256.0))
    }
}

fn opus_error(what: &str, code: c_int) -> SourceError {
    SourceError::new(format!("opus: {what}: {}", cstr_opt(unsafe { opus_strerror(code) }).unwrap_or_else(|| code.to_string())))
}

/// A libopus multistream decoder at 48 kHz.
pub struct Decoder {
    st: *mut MsDecoder,
    channels: usize,
}

// The decoder state is only touched through `&mut self`.
unsafe impl Send for Decoder {}
unsafe impl Sync for Decoder {}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe { opus_multistream_decoder_destroy(self.st) };
    }
}

impl Decoder {
    pub fn new(head: &OpusHead) -> Result<Self, SourceError> {
        let mut err = 0;
        let st = unsafe {
            opus_multistream_decoder_create(RATE as i32, head.channels as c_int, head.streams as c_int, head.coupled as c_int, head.mapping.as_ptr(), &mut err)
        };
        if st.is_null() || err != 0 {
            if !st.is_null() {
                unsafe { opus_multistream_decoder_destroy(st) };
            }
            return Err(opus_error("unsupported stream", err));
        }
        Ok(Self { st, channels: head.channels })
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Decode one packet into `pcm` (interleaved; room for [`MAX_FRAMES`] frames is always
    /// enough). Returns the frames decoded.
    pub fn decode(&mut self, packet: &[u8], pcm: &mut [f32]) -> Result<usize, SourceError> {
        // An empty packet would ask libopus to conceal a lost one.
        if packet.is_empty() {
            return Err(SourceError::new("opus: empty packet"));
        }
        let frames = (pcm.len() / self.channels).min(MAX_FRAMES);
        let len = i32::try_from(packet.len()).map_err(|_| SourceError::new("opus: packet too large"))?;
        let n = unsafe { opus_multistream_decode_float(self.st, packet.as_ptr(), len, pcm.as_mut_ptr(), frames as c_int, 0) };
        if n < 0 {
            return Err(opus_error("corrupt packet", n));
        }
        Ok(n as usize)
    }

    /// Forget the stream so far (after a seek).
    pub fn reset(&mut self) {
        unsafe { opus_multistream_decoder_ctl(self.st, OPUS_RESET_STATE) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(version: u8, channels: u8, family: u8, table: &[u8]) -> Vec<u8> {
        let mut h = b"OpusHead".to_vec();
        h.extend([version, channels]);
        h.extend(312u16.to_le_bytes());
        h.extend(44_100u32.to_le_bytes());
        h.extend((-256i16).to_le_bytes());
        h.push(family);
        h.extend(table);
        h
    }

    #[test]
    fn headers() {
        let h = OpusHead::parse(&head(1, 2, 0, &[])).unwrap();
        assert_eq!((h.channels, h.pre_skip, h.gain, h.streams, h.coupled, h.mapping.clone()), (2, 312, -256, 1, 1, vec![0, 1]));
        assert!((h.gain_factor() - 10f32.powf(-1.0 / 20.0)).abs() < 1e-6);
        // 5.1, Vorbis order: 4 streams, 2 coupled.
        let h = OpusHead::parse(&head(1, 6, 1, &[4, 2, 0, 4, 1, 2, 3, 5])).unwrap();
        assert_eq!((h.channels, h.streams, h.coupled, h.mapping), (6, 4, 2, vec![0, 4, 1, 2, 3, 5]));
        assert!(Decoder::new(&OpusHead::parse(&head(1, 6, 1, &[4, 2, 0, 4, 1, 2, 3, 5])).unwrap()).is_ok());
        // MP4 `dOps` (version 0): big-endian fields.
        let mut mp4 = head(0, 2, 0, &[]);
        mp4[10..12].copy_from_slice(&312u16.to_be_bytes());
        mp4[16..18].copy_from_slice(&(-256i16).to_be_bytes());
        assert_eq!(OpusHead::parse(&mp4).map(|h| (h.pre_skip, h.gain)), Some((312, -256)));
        // Rejected: bad magic, unknown major version, family 0 with 3 channels, a truncated or
        // out-of-range table, Vorbis order past 8 channels.
        let mut bad = head(1, 2, 0, &[]);
        bad[0] = b'X';
        for b in [bad, head(0x10, 2, 0, &[]), head(1, 3, 0, &[]), head(1, 6, 1, &[4, 2, 0, 4]), head(1, 2, 1, &[1, 0, 0, 1]), head(1, 9, 1, &[9, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8])] {
            assert_eq!(OpusHead::parse(&b), None, "{b:?}");
        }
        assert_eq!(OpusHead::plain(3), None);
    }

    #[test]
    fn corrupt_packets_are_errors() {
        let mut d = Decoder::new(&OpusHead::plain(2).unwrap()).unwrap();
        let mut pcm = vec![0.0f32; MAX_FRAMES * 2];
        assert!(d.decode(&[], &mut pcm).is_err());
        // Code 3 (arbitrary frame count) claiming 63 frames of 120 ms: over the 120 ms limit.
        assert!(d.decode(&[0x1B, 0x3F, 0, 0], &mut pcm).is_err());
        // A one-byte packet is a valid 20 ms of silence (CELT, TOC only).
        assert_eq!(d.decode(&[0xFC], &mut pcm).unwrap(), 960);
        assert!(pcm[..1920].iter().all(|&v| v == 0.0));
        d.reset();
    }
}
