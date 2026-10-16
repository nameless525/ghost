//! Local files given by a relative path (as the CLI passes them) decode like absolute ones,
//! companion files included. A test binary of its own: it changes the working directory.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use ghost_engine::cache::CacheManager;
use ghost_engine::source::{self, AudioSource, OpenCtx};
use ghost_engine::{SourceExtras, SourceSpec};
use ghost_formats::testdata::*;

fn read_all(s: &mut dyn AudioSource) -> Vec<f32> {
    let mut out = Vec::new();
    let mut buf = vec![0.0f32; 4096 * s.channels()];
    loop {
        let n = s.read(&mut buf).unwrap();
        if n == 0 || out.len() > 1 << 20 {
            break;
        }
        out.extend_from_slice(&buf[..n * s.channels()]);
    }
    out
}

#[test]
fn relative_vgmstream_paths_resolve_once() {
    let root = std::env::temp_dir().join(format!("ghost-it-relpath-{}-{}", std::process::id(), ghost_engine::util::epoch_us()));
    std::fs::create_dir_all(root.join("a")).unwrap();
    // A looped .lwav, and raw PCM described by a .txth companion (two 0.5 s sub-songs).
    let frames = square_frames(32_000, 500.0, 8_000, 12_000);
    std::fs::write(root.join("a/loop.lwav"), wav_pcm16(32_000, &frames, true, Some((2_000, 6_000)))).unwrap();
    let mut raw = Vec::new();
    for f in square_frames(22_050, 441.0, 11_025, 10_000).iter().chain(&square_frames(22_050, 882.0, 11_025, 10_000)) {
        raw.extend_from_slice(&f[0].to_le_bytes());
    }
    std::fs::write(root.join("a/music.raw"), raw).unwrap();
    let txth = "codec = PCM16LE\nchannels = 1\nsample_rate = 22050\nsubsong_count = 2\nchunk_start = 0\nchunk_count = 2\nchunk_size = 22050\nnum_samples = 11025\n";
    std::fs::write(root.join("a/music.raw.txth"), txth).unwrap();

    std::env::set_current_dir(&root).unwrap();
    check_relative_opens(&root);
    std::env::set_current_dir(std::env::temp_dir()).unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

fn check_relative_opens(root: &Path) {
    let cache = CacheManager::new(root.join("cache"), 1 << 20, "ghost-test").unwrap();
    let ctx = OpenCtx { cache: &cache, cancel: Arc::new(AtomicBool::new(false)), accurate_seek: true, background: false };
    let open = |path: &Path, subsong: Option<u32>| {
        let spec = SourceSpec::file(path).with_extras(SourceExtras { subsong, ..Default::default() });
        source::open(&spec, &ctx).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    };
    for rel in ["a/loop.lwav", "./a/loop.lwav"] {
        let mut s = open(Path::new(rel), None);
        let l = s.loop_info().expect("loop points");
        assert_eq!((l.start, l.end), (2_000, 6_000), "{rel}");
        let a = read_all(open(&root.join("a/loop.lwav"), None).as_mut());
        let b = read_all(s.as_mut());
        assert_eq!(a, b, "{rel}");
    }
    for sub in 0..2 {
        let mut s = open(&PathBuf::from("a").join("music.raw"), Some(sub));
        assert_eq!(s.meta().subsong_count, Some(2));
        let x = read_all(s.as_mut());
        assert_eq!(x.len(), 11_025);
        let want = [441.0, 882.0][sub as usize];
        assert!((zero_cross_freq(&x, 1, 22_050) - want).abs() < 3.0, "sub-song {sub}");
    }
}
