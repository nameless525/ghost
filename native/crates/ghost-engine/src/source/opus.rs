//! Opus for the symphonia source. Symphonia 0.6 demuxes Ogg Opus, WebM / Matroska and MP4
//! Opus tracks but has no Opus decoder: this one decodes their packets with libopus (from
//! `ghost-formats`) and is registered next to symphonia's own codecs.
//!
//! The decoder outputs the channels in symphonia's speaker order (Opus orders surround the
//! Vorbis way) and applies the header's output gain and the packets' end trimming. Pre-skip is
//! the source's job: containers carry it in their timestamps (see `symphonia_src`).

use std::sync::OnceLock;

use ghost_formats::opus::{self, OpusHead};
use symphonia::core::audio::{AsGenericAudioBufferRef, AudioBuffer, AudioMut, AudioSpec, Channels, GenericAudioBufferRef, Position};
use symphonia::core::codecs::audio::well_known::CODEC_ID_OPUS;
use symphonia::core::codecs::audio::{AudioCodecParameters, AudioDecoder, AudioDecoderOptions, FinalizeResult};
use symphonia::core::codecs::registry::{CodecRegistry, RegisterableAudioDecoder, SupportedAudioCodec};
use symphonia::core::codecs::CodecInfo;
use symphonia::core::errors::{decode_error, unsupported_error, Result};
use symphonia::core::packet::PacketRef;

/// Symphonia's codecs plus Opus.
pub(crate) fn codecs() -> &'static CodecRegistry {
    static CODECS: OnceLock<CodecRegistry> = OnceLock::new();
    CODECS.get_or_init(|| {
        let mut r = CodecRegistry::new();
        symphonia::default::register_enabled_codecs(&mut r);
        r.register_audio_decoder::<OpusDecoder>();
        r
    })
}

/// Speaker positions of the Vorbis-order layouts (Opus channel mapping family 1), and the
/// output plane (position order) of each coded-order channel.
fn vorbis_layout(channels: usize) -> Option<(Position, &'static [usize])> {
    use Position as P;
    let (fl, fr, fc, lfe) = (P::FRONT_LEFT, P::FRONT_RIGHT, P::FRONT_CENTER, P::LFE1);
    Some(match channels {
        1 => (fl, &[0]),
        2 => (fl | fr, &[0, 1]),
        3 => (fl | fc | fr, &[0, 2, 1]),
        4 => (fl | fr | P::REAR_LEFT | P::REAR_RIGHT, &[0, 1, 2, 3]),
        5 => (fl | fc | fr | P::REAR_LEFT | P::REAR_RIGHT, &[0, 2, 1, 3, 4]),
        6 => (fl | fc | fr | P::REAR_LEFT | P::REAR_RIGHT | lfe, &[0, 2, 1, 4, 5, 3]),
        7 => (fl | fc | fr | P::SIDE_LEFT | P::SIDE_RIGHT | P::REAR_CENTER | lfe, &[0, 2, 1, 5, 6, 4, 3]),
        8 => (fl | fc | fr | P::SIDE_LEFT | P::SIDE_RIGHT | P::REAR_LEFT | P::REAR_RIGHT | lfe, &[0, 2, 1, 6, 7, 4, 5, 3]),
        _ => return None,
    })
}

pub struct OpusDecoder {
    params: AudioCodecParameters,
    decoder: opus::Decoder,
    gain: f32,
    /// Output plane of each decoded channel.
    planes: Vec<usize>,
    /// One packet, interleaved as libopus writes it.
    pcm: Vec<f32>,
    buf: AudioBuffer<f32>,
    gapless: bool,
}

impl OpusDecoder {
    fn try_new(params: &AudioCodecParameters, opts: &AudioDecoderOptions) -> Result<Self> {
        let head = match params.extra_data.as_deref() {
            Some(extra) => OpusHead::parse(extra),
            None => params.channels.as_ref().and_then(|c| OpusHead::plain(c.count())),
        };
        let Some(head) = head else { return unsupported_error("opus: unsupported or missing header") };
        let Ok(decoder) = opus::Decoder::new(&head) else { return unsupported_error("opus: unsupported channel mapping") };
        let (channels, planes) = match vorbis_layout(head.channels).filter(|_| head.family <= 1) {
            Some((positions, planes)) => (Channels::Positioned(positions), planes.to_vec()),
            None => (Channels::Discrete(head.channels as u16), (0..head.channels).collect()),
        };
        let mut params = params.clone();
        params.with_sample_rate(opus::RATE).with_channels(channels.clone()).with_max_frames_per_packet(opus::MAX_FRAMES as u64);
        Ok(Self {
            params,
            decoder,
            gain: head.gain_factor(),
            planes,
            pcm: vec![0.0; opus::MAX_FRAMES * head.channels],
            buf: AudioBuffer::new(AudioSpec::new(opus::RATE, channels), opus::MAX_FRAMES),
            gapless: opts.gapless,
        })
    }

    fn decode_packet(&mut self, packet: &PacketRef<'_>) -> Result<()> {
        let Ok(n) = self.decoder.decode(packet.data, &mut self.pcm) else { return decode_error("opus: corrupt packet") };
        self.buf.clear();
        self.buf.render_uninit(Some(n));
        let ch = self.planes.len();
        for (c, &p) in self.planes.iter().enumerate() {
            let plane = self.buf.plane_mut(p).expect("one plane per channel");
            for (o, f) in plane.iter_mut().zip(self.pcm.chunks_exact(ch)) {
                *o = f[c] * self.gain;
            }
        }
        if self.gapless {
            self.buf.trim(packet.trim_start.get() as usize, packet.trim_end.get() as usize);
        }
        Ok(())
    }
}

impl AudioDecoder for OpusDecoder {
    fn reset(&mut self) {
        self.decoder.reset();
    }

    fn codec_info(&self) -> &CodecInfo {
        &Self::supported_codecs()[0].info
    }

    fn codec_params(&self) -> &AudioCodecParameters {
        &self.params
    }

    fn decode_ref(&mut self, packet: &PacketRef<'_>) -> Result<GenericAudioBufferRef<'_>> {
        if let Err(e) = self.decode_packet(packet) {
            self.buf.clear();
            return Err(e);
        }
        Ok(self.buf.as_generic_audio_buffer_ref())
    }

    fn finalize(&mut self) -> FinalizeResult {
        FinalizeResult::default()
    }

    fn last_decoded(&self) -> GenericAudioBufferRef<'_> {
        self.buf.as_generic_audio_buffer_ref()
    }
}

impl RegisterableAudioDecoder for OpusDecoder {
    fn try_registry_new(params: &AudioCodecParameters, opts: &AudioDecoderOptions) -> Result<Box<dyn AudioDecoder>> {
        Ok(Box::new(OpusDecoder::try_new(params, opts)?))
    }

    fn supported_codecs() -> &'static [SupportedAudioCodec] {
        &[SupportedAudioCodec { id: CODEC_ID_OPUS, info: CodecInfo { short_name: "opus", long_name: "Opus", profiles: &[] } }]
    }
}
