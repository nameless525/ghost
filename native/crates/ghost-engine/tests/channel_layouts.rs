//! Multichannel sources downmix to stereo by their real speaker positions (WAVE channel masks),
//! whichever decoder reads them, in playback and in rendered downloads alike.

mod common;

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use common::*;
use ghost_engine::cache::CacheManager;
use ghost_engine::source::{self, AudioSource, OpenCtx};
use ghost_engine::{DownloadStatus, EngineEvent, SourceExtras, SourceSpec, TagInfo};
use ghost_formats::testdata::wav_extensible;

const RATE: u32 = 44_100;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Side {
    Left,
    Right,
    Both,
    Off,
}
use Side::*;

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

/// Which side(s) of interleaved stereo carry sound.
fn side(stereo: &[f32]) -> Side {
    let l = rms(&stereo.iter().step_by(2).copied().collect::<Vec<_>>());
    let r = rms(&stereo.iter().skip(1).step_by(2).copied().collect::<Vec<_>>());
    match (l > 1e-4, r > 1e-4) {
        (true, true) if (l - r).abs() < 0.01 * l => Both,
        (true, false) => Left,
        (false, true) => Right,
        (false, false) => Off,
        _ => panic!("lopsided: left {l}, right {r}"),
    }
}

/// 1 s of a 500 Hz tone in channel `c` alone.
fn isolated(channels: usize, c: usize) -> Vec<i16> {
    (0..RATE as usize)
        .flat_map(|i| {
            let v = (10_000.0 * (std::f32::consts::TAU * 500.0 * i as f32 / RATE as f32).sin()) as i16;
            (0..channels).map(move |k| if k == c { v } else { 0 })
        })
        .collect()
}

fn open(path: &Path, cache: &Arc<CacheManager>, extras: SourceExtras) -> Box<dyn AudioSource> {
    let ctx = OpenCtx { cache, cancel: Arc::new(AtomicBool::new(false)), accurate_seek: true, background: false };
    source::open(&SourceSpec::file(path).with_extras(extras), &ctx).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The whole source, downmixed as playback does.
fn stereo_of(s: &mut dyn AudioSource) -> Vec<f32> {
    let ch = s.channels();
    let mut buf = vec![0.0f32; 4096 * ch];
    let mut out = Vec::new();
    loop {
        let n = s.read(&mut buf).unwrap();
        if n == 0 {
            return out;
        }
        source::to_stereo(&buf[..n * ch], ch, s.channel_mask(), &mut out);
    }
}

#[test]
fn wave_channel_masks_place_every_speaker() {
    let dir = tmp_dir("layouts");
    let cache = CacheManager::new(dir.join("cache"), 1 << 20, "ghost-test").unwrap();
    let cases: &[(&str, u32, &[Side])] = &[
        ("quad", 0x33, &[Left, Right, Left, Right]),
        ("5.0", 0x37, &[Left, Right, Both, Left, Right]),
        ("5.0 (side)", 0x607, &[Left, Right, Both, Left, Right]),
        ("5.1", 0x3F, &[Left, Right, Both, Off, Left, Right]),
        ("7.1", 0x63F, &[Left, Right, Both, Off, Left, Right, Left, Right]),
    ];
    for &(name, mask, sides) in cases {
        let n = sides.len();
        for (c, &want) in sides.iter().enumerate() {
            let wav = wav_extensible(RATE, n as u16, mask, &isolated(n, c));
            // symphonia reads .wav, vgmstream the same bytes as .lwav.
            for ext in ["wav", "lwav"] {
                let path = dir.join(format!("{name} {c}.{ext}"));
                std::fs::write(&path, &wav).unwrap();
                let mut s = open(&path, &cache, SourceExtras::default());
                assert_eq!((s.channels(), s.channel_mask()), (n, Some(mask)), "{name} .{ext}");
                assert_eq!(side(&stereo_of(s.as_mut())), want, "{name} channel {c} (.{ext})");
            }
        }
    }
}

#[test]
fn quad_back_right_plays_and_renders_on_the_right() {
    let dir = tmp_dir("layouts-engine");
    let cache = CacheManager::new(dir.join("cache"), 1 << 20, "ghost-test").unwrap();
    let path = dir.join("quad.wav");
    std::fs::write(&path, wav_extensible(RATE, 4, 0x33, &isolated(4, 3))).unwrap();
    let expected = stereo_of(open(&path, &cache, SourceExtras::default()).as_mut());
    assert_eq!(side(&expected), Right);

    // Playback.
    let (engine, sink) = offline(&dir, RATE);
    engine.set_current(track("q", file(&path)), 0, true);
    let (played, _) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    assert_eq!(side(&played), Right);

    // A rendered download (a clip renders to FLAC) holds the same downmix.
    let clip = SourceExtras { clip_start_ms: Some(0), clip_end_ms: Some(500), ..Default::default() };
    engine.download("q".into(), SourceSpec::file(&path).with_extras(clip), dir.join("out").join("quad.wav"), TagInfo::default());
    let events = engine.events();
    let flac = loop {
        match events.recv_timeout(Duration::from_secs(60)).expect("download event") {
            EngineEvent::Download { status: DownloadStatus::Done, path, .. } => break path.unwrap(),
            EngineEvent::Download { status: DownloadStatus::Error, error, .. } => panic!("render failed: {error:?}"),
            _ => {}
        }
    };
    let mut rendered = open(&flac, &cache, SourceExtras::default());
    assert_eq!(rendered.channels(), 2);
    let rendered = stereo_of(rendered.as_mut());
    assert_eq!(rendered.len(), RATE as usize);
    assert!(rendered.iter().zip(&expected).all(|(a, b)| (a - b).abs() < 1e-5), "render differs from playback's downmix");
}
