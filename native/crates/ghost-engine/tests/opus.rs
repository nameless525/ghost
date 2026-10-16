//! Opus through the public source API: packets from the real libopus encoder (linked in through
//! `ghost-formats`), muxed here into Ogg Opus (RFC 7845) and WebM files, decode back to the
//! input: gapless, with the right channels, seekable, and as rendered downloads.

mod common;

use std::ffi::{c_int, c_uchar};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use common::*;
use ghost_engine::cache::CacheManager;
use ghost_engine::source::{self, AudioSource, OpenCtx};
use ghost_engine::{DownloadStatus, EngineEvent, SourceExtras, SourceSpec, TagInfo};
use ghost_formats::testdata::zero_cross_freq;

#[repr(C)]
struct MsEncoder {
    _p: [u8; 0],
}

extern "C" {
    fn opus_multistream_surround_encoder_create(fs: i32, channels: c_int, family: c_int, streams: *mut c_int, coupled: *mut c_int, mapping: *mut c_uchar, application: c_int, error: *mut c_int) -> *mut MsEncoder;
    fn opus_multistream_encode_float(st: *mut MsEncoder, pcm: *const f32, frame_size: c_int, data: *mut c_uchar, max_bytes: i32) -> i32;
    fn opus_multistream_encoder_ctl(st: *mut MsEncoder, request: c_int, ...) -> c_int;
    fn opus_multistream_encoder_destroy(st: *mut MsEncoder);
}

const RATE: u32 = 48_000;
const PACKET: usize = 960;

/// An encoded stream: its OpusHead and 20 ms packets.
struct Encoded {
    head: Vec<u8>,
    pre_skip: usize,
    packets: Vec<Vec<u8>>,
}

/// Encode interleaved `pcm` (Vorbis channel order for more than two channels) at 48 kHz.
fn encode(pcm: &[f32], channels: usize, gain_q8: i16) -> Encoded {
    let family = if channels > 2 { 1 } else { 0 };
    let (mut streams, mut coupled, mut mapping, mut err) = (0, 0, [0u8; 8], 0);
    let enc = unsafe { opus_multistream_surround_encoder_create(RATE as i32, channels as c_int, family, &mut streams, &mut coupled, mapping.as_mut_ptr(), 2049, &mut err) };
    assert!(!enc.is_null() && err == 0, "encoder: {err}");
    let mut lookahead: i32 = 0;
    unsafe {
        opus_multistream_encoder_ctl(enc, 4002, 96_000 * channels as i32); // OPUS_SET_BITRATE
        opus_multistream_encoder_ctl(enc, 4027, &mut lookahead as *mut i32); // OPUS_GET_LOOKAHEAD
    }
    let pre_skip = lookahead as usize;
    // Enough packets to flush the encoder's lookahead.
    let frames = pcm.len() / channels;
    let count = (frames + pre_skip).div_ceil(PACKET);
    let mut padded = pcm.to_vec();
    padded.resize(count * PACKET * channels, 0.0);
    let mut out = vec![0u8; 4000];
    let packets = padded
        .chunks_exact(PACKET * channels)
        .map(|p| {
            let n = unsafe { opus_multistream_encode_float(enc, p.as_ptr(), PACKET as c_int, out.as_mut_ptr(), out.len() as i32) };
            assert!(n > 0, "encode: {n}");
            out[..n as usize].to_vec()
        })
        .collect();
    unsafe { opus_multistream_encoder_destroy(enc) };
    let mut head = b"OpusHead".to_vec();
    head.extend([1, channels as u8]);
    head.extend((pre_skip as u16).to_le_bytes());
    head.extend(RATE.to_le_bytes());
    head.extend(gain_q8.to_le_bytes());
    head.push(family as u8);
    if family != 0 {
        head.extend([streams as u8, coupled as u8]);
        head.extend(&mapping[..channels]);
    }
    Encoded { head, pre_skip, packets }
}

fn ogg_crc(data: &[u8]) -> u32 {
    let mut crc = 0u32;
    for &b in data {
        crc ^= (b as u32) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 { (crc << 1) ^ 0x04C1_1DB7 } else { crc << 1 };
        }
    }
    crc
}

fn ogg_page(seq: u32, flags: u8, granule: u64, packets: &[&[u8]]) -> Vec<u8> {
    let mut lacing = Vec::new();
    for p in packets {
        lacing.extend(std::iter::repeat_n(255u8, p.len() / 255));
        lacing.push((p.len() % 255) as u8);
    }
    let mut page = b"OggS\0".to_vec();
    page.push(flags);
    page.extend(granule.to_le_bytes());
    page.extend(0x6768_6f73u32.to_le_bytes());
    page.extend(seq.to_le_bytes());
    page.extend([0; 4]);
    page.push(lacing.len() as u8);
    page.extend(&lacing);
    for p in packets {
        page.extend_from_slice(p);
    }
    let crc = ogg_crc(&page);
    page[22..26].copy_from_slice(&crc.to_le_bytes());
    page
}

/// Ogg Opus: header pages, then ten packets a page; the last page's granule position ends the
/// stream exactly `frames` after the pre-skip.
fn ogg_opus(e: &Encoded, frames: usize) -> Vec<u8> {
    let mut tags = b"OpusTags".to_vec();
    tags.extend(5u32.to_le_bytes());
    tags.extend(b"ghost");
    tags.extend(0u32.to_le_bytes());
    let mut f = ogg_page(0, 0x02, 0, &[&e.head]);
    f.extend(ogg_page(1, 0, 0, &[&tags]));
    let pages: Vec<&[Vec<u8>]> = e.packets.chunks(10).collect();
    for (k, chunk) in pages.iter().enumerate() {
        let last = k + 1 == pages.len();
        let granule = if last { e.pre_skip + frames } else { (k + 1) * 10 * PACKET };
        let refs: Vec<&[u8]> = chunk.iter().map(|p| p.as_slice()).collect();
        f.extend(ogg_page(k as u32 + 2, if last { 0x04 } else { 0 }, granule as u64, &refs));
    }
    f
}

fn ebml(id: u32, data: &[u8]) -> Vec<u8> {
    let mut v: Vec<u8> = id.to_be_bytes().into_iter().skip_while(|&b| b == 0).collect();
    v.push(0x01);
    v.extend(&(data.len() as u64).to_be_bytes()[1..]);
    v.extend_from_slice(data);
    v
}

fn ebml_uint(id: u32, n: u64) -> Vec<u8> {
    let bytes: Vec<u8> = n.to_be_bytes().into_iter().skip_while(|&b| b == 0).collect();
    ebml(id, if bytes.is_empty() { &[0] } else { &bytes })
}

/// WebM as YouTube serves Opus: 1 ms timestamps, CodecDelay = pre-skip, one cluster of
/// SimpleBlocks (no end trimming).
fn webm_opus(e: &Encoded, channels: usize) -> Vec<u8> {
    let header = [ebml_uint(0x4286, 1), ebml_uint(0x42F7, 1), ebml_uint(0x42F2, 4), ebml_uint(0x42F3, 8), ebml(0x4282, b"webm"), ebml_uint(0x4287, 4), ebml_uint(0x4285, 2)].concat();
    let info = ebml(0x1549_A966, &[ebml_uint(0x2A_D7B1, 1_000_000), ebml(0x4D80, b"ghost"), ebml(0x5741, b"ghost")].concat());
    let audio = ebml(0xE1, &[ebml(0xB5, &(RATE as f64).to_be_bytes()), ebml_uint(0x9F, channels as u64)].concat());
    let track = ebml(
        0xAE,
        &[
            ebml_uint(0xD7, 1),
            ebml_uint(0x73C5, 1),
            ebml_uint(0x83, 2),
            ebml(0x86, b"A_OPUS"),
            ebml(0x63A2, &e.head),
            ebml_uint(0x56AA, (e.pre_skip as u64 * 1_000_000_000).div_ceil(RATE as u64)),
            ebml_uint(0x56BB, 80_000_000),
            audio,
        ]
        .concat(),
    );
    let mut cluster = ebml_uint(0xE7, 0);
    for (k, p) in e.packets.iter().enumerate() {
        let mut block = vec![0x81];
        block.extend(((k * 20) as i16).to_be_bytes());
        block.push(0x80);
        block.extend(p);
        cluster.extend(ebml(0xA3, &block));
    }
    let segment = ebml(0x1853_8067, &[info, ebml(0x1654_AE6B, &track), ebml(0x1F43_B675, &cluster)].concat());
    [ebml(0x1A45_DFA3, &header), segment].concat()
}

fn open(path: &Path, cache: &Arc<CacheManager>, extras: SourceExtras) -> Box<dyn AudioSource> {
    let ctx = OpenCtx { cache, cancel: Arc::new(AtomicBool::new(false)), accurate_seek: true, background: false };
    source::open(&SourceSpec::file(path).with_extras(extras), &ctx).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn read_all(s: &mut dyn AudioSource) -> Vec<f32> {
    let mut out = Vec::new();
    let mut buf = vec![0.0f32; 4096 * s.channels()];
    loop {
        let n = s.read(&mut buf).unwrap();
        if n == 0 {
            return out;
        }
        out.extend_from_slice(&buf[..n * s.channels()]);
    }
}

fn channel(x: &[f32], channels: usize, c: usize) -> Vec<f32> {
    x.iter().skip(c).step_by(channels).copied().collect()
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

/// Lag (decoded behind original, in frames) that best lines `decoded` up with `original`, and
/// the signal-to-error ratio there, over `range` of the original.
fn alignment(original: &[f32], decoded: &[f32], range: std::ops::Range<usize>) -> (i64, f32) {
    let mut best = (0i64, f32::MAX);
    for lag in -64i64..=64 {
        let err: f32 = range.clone().map(|t| (decoded[(t as i64 + lag) as usize] - original[t]).powi(2)).sum();
        if err < best.1 {
            best = (lag, err);
        }
    }
    let sig: f32 = range.map(|t| original[t].powi(2)).sum();
    (best.0, 10.0 * (sig / best.1).log10())
}

/// 1 s of stereo: 440 Hz left, 660 Hz right.
fn stereo_tones(frames: usize) -> Vec<f32> {
    (0..frames)
        .flat_map(|i| {
            let t = i as f32 / RATE as f32;
            [0.4 * (std::f32::consts::TAU * 440.0 * t).sin(), 0.3 * (std::f32::consts::TAU * 660.0 * t).sin()]
        })
        .collect()
}

#[test]
fn ogg_opus_decodes_gaplessly_and_seeks() {
    let dir = tmp_dir("opus-ogg");
    let cache = CacheManager::new(dir.join("cache"), 1 << 20, "ghost-test").unwrap();
    let frames = 48_000;
    let pcm = stereo_tones(frames);
    let e = encode(&pcm, 2, 0);
    let path = dir.join("tones.opus");
    std::fs::write(&path, ogg_opus(&e, frames)).unwrap();

    let mut s = open(&path, &cache, SourceExtras::default());
    assert_eq!((s.sample_rate(), s.channels(), s.channel_mask()), (RATE, 2, Some(0x3)));
    assert_eq!(s.meta().codec, "opus");
    assert_eq!(s.duration(), Some(frames as u64));
    let out = read_all(s.as_mut());
    // Pre-skip and end padding trimmed: exactly the input's length, lined up with it.
    assert_eq!(out.len(), pcm.len());
    for c in 0..2 {
        let (orig, dec) = (channel(&pcm, 2, c), channel(&out, 2, c));
        let (lag, snr) = alignment(&orig, &dec, 2_000..frames - 2_000);
        println!("ogg opus channel {c}: lag {lag}, {snr:.1} dB, {:.1} Hz", zero_cross_freq(&dec, 1, RATE));
        assert_eq!(lag, 0, "channel {c}");
        assert!(snr > 20.0, "channel {c}: {snr:.1} dB");
    }

    // A seek lands on the frame asked for (decoded from 80 ms before it).
    let full = out;
    for target in [24_000u64, 4_000, 100] {
        let mut s = open(&path, &cache, SourceExtras::default());
        assert_eq!(s.seek(target).unwrap(), target);
        let mut buf = vec![0.0f32; 4_800 * 2];
        let mut got = 0;
        while got < 4_800 {
            got += s.read(&mut buf[got * 2..]).unwrap();
        }
        let want = &full[target as usize * 2..(target as usize + 4_800) * 2];
        let err = buf.iter().zip(want).map(|(a, b)| (a - b).powi(2)).sum::<f32>();
        let snr = 10.0 * (want.iter().map(|v| v * v).sum::<f32>() / err.max(1e-20)).log10();
        println!("seek to {target}: {snr:.1} dB against sequential decoding");
        // Without the pre-roll the first 100 ms are ~7 dB off; with it the decoder has
        // converged most of the way (the rest of the difference fades within ~0.2 s).
        assert!(snr > 20.0, "seek to {target}: {snr:.1} dB");
    }

    // The header's output gain applies (-6 dB).
    let quiet = encode(&pcm, 2, -6 * 256);
    let qpath = dir.join("quiet.opus");
    std::fs::write(&qpath, ogg_opus(&quiet, frames)).unwrap();
    let q = read_all(open(&qpath, &cache, SourceExtras::default()).as_mut());
    let ratio = rms(&q) / rms(&full);
    assert!((ratio - 10f32.powf(-6.0 / 20.0)).abs() < 0.01, "gain ratio {ratio}");

    // A clip renders to FLAC (a rendered download) with the same audio.
    let (engine, _sink) = offline(&dir, RATE);
    let clip = SourceExtras { clip_start_ms: Some(200), clip_end_ms: Some(700), ..Default::default() };
    engine.download("o".into(), SourceSpec::file(&path).with_extras(clip.clone()), dir.join("out").join("clip.opus"), TagInfo::default());
    let events = engine.events();
    let flac = loop {
        match events.recv_timeout(Duration::from_secs(60)).expect("download event") {
            EngineEvent::Download { status: DownloadStatus::Done, path, .. } => break path.unwrap(),
            EngineEvent::Download { status: DownloadStatus::Error, error, .. } => panic!("render failed: {error:?}"),
            _ => {}
        }
    };
    assert_eq!(flac.extension().unwrap(), "flac");
    let rendered = read_all(open(&flac, &cache, SourceExtras::default()).as_mut());
    let direct = read_all(open(&path, &cache, clip).as_mut());
    assert_eq!(rendered.len(), 24_000 * 2);
    assert!(rendered.iter().zip(&direct).all(|(a, b)| (a - b).abs() < 1e-5), "render differs from playback");
}

#[test]
fn ogg_opus_surround_keeps_its_speakers() {
    let dir = tmp_dir("opus-51");
    let cache = CacheManager::new(dir.join("cache"), 1 << 20, "ghost-test").unwrap();
    // 5.1 in Opus's (Vorbis) order FL FC FR RL RR LFE: a tone on the rear right only.
    let frames = 24_000;
    let pcm: Vec<f32> = (0..frames)
        .flat_map(|i| {
            let v = 0.4 * (std::f32::consts::TAU * 500.0 * i as f32 / RATE as f32).sin();
            [0.0, 0.0, 0.0, 0.0, v, 0.0]
        })
        .collect();
    let e = encode(&pcm, 6, 0);
    let path = dir.join("surround.opus");
    std::fs::write(&path, ogg_opus(&e, frames)).unwrap();
    let mut s = open(&path, &cache, SourceExtras::default());
    // Symphonia's speaker order: FL FR FC LFE RL RR.
    assert_eq!((s.channels(), s.channel_mask()), (6, Some(0x3F)));
    let out = read_all(s.as_mut());
    let levels: Vec<f32> = (0..6).map(|c| rms(&channel(&out, 6, c))).collect();
    println!("5.1 opus channel levels: {levels:?}");
    assert!(levels[5] > 0.2, "{levels:?}");
    assert!(levels[..5].iter().all(|&l| l < levels[5] / 30.0), "{levels:?}");
    let mut stereo = Vec::new();
    source::to_stereo(&out, 6, s.channel_mask(), &mut stereo);
    let (l, r) = (rms(&channel(&stereo, 2, 0)), rms(&channel(&stereo, 2, 1)));
    assert!(r > 0.05 && l < r / 30.0, "downmix left {l}, right {r}");
}

#[test]
fn webm_opus_decodes() {
    let dir = tmp_dir("opus-webm");
    let cache = CacheManager::new(dir.join("cache"), 1 << 20, "ghost-test").unwrap();
    let frames = 48_000;
    let pcm = stereo_tones(frames);
    let e = encode(&pcm, 2, 0);
    let path = dir.join("tones.webm");
    std::fs::write(&path, webm_opus(&e, 2)).unwrap();
    let mut s = open(&path, &cache, SourceExtras::default());
    assert_eq!((s.sample_rate(), s.channels(), s.channel_mask()), (RATE, 2, Some(0x3)));
    assert_eq!(s.meta().codec, "opus");
    let out = read_all(s.as_mut());
    // No end trimming in this container: the encoder's padding stays.
    assert!(out.len() >= pcm.len(), "{} frames", out.len() / 2);
    for c in 0..2 {
        let (orig, dec) = (channel(&pcm, 2, c), channel(&out, 2, c));
        let (lag, snr) = alignment(&orig, &dec, 2_000..frames - 2_000);
        println!("webm opus channel {c}: lag {lag}, {snr:.1} dB");
        // Pre-skip trimmed to WebM's 1 ms timestamp resolution.
        assert!(lag.abs() < 48, "channel {c}: lag {lag}");
        assert!(snr > 20.0, "channel {c}: {snr:.1} dB");
    }
}
