//! Game-music formats, archives, clips and FLAC rendering through the public engine API and the
//! offline null sink. Synthetic files have exact, known timing; rendering at the files' own rate
//! (44.1 kHz) avoids resampling, so lengths are checked to the frame.

mod common;

use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use common::*;
use ghost_engine::{wav, DownloadOptions, DownloadStatus, Engine, EngineEvent, LoopMode, OfflineSink, SourceExtras, SourceSpec, TagInfo, TrackInfo};
use ghost_formats::testdata::*;

const RATE: u32 = 44_100;

fn file_with(path: &Path, extras: SourceExtras) -> SourceSpec {
    SourceSpec::file(path).with_extras(extras)
}

fn track_info(evs: &[EngineEvent], id: &str) -> TrackInfo {
    evs.iter().find_map(|e| if let EngineEvent::TrackInfo(i) = e { (i.id == id).then(|| i.clone()) } else { None }).expect("no TrackInfo")
}

/// Collect `frames` frames of output (for sources that never end), then stop.
fn collect_frames(engine: &Engine, sink: &OfflineSink, frames: usize, timeout: Duration) -> (Vec<f32>, Vec<EngineEvent>) {
    let events = engine.events();
    let (mut audio, mut evs) = (Vec::new(), Vec::new());
    let t0 = Instant::now();
    while audio.len() < frames * 2 {
        while let Ok(e) = events.try_recv() {
            evs.push(e);
        }
        if let Ok(b) = sink.blocks.recv_timeout(Duration::from_millis(20)) {
            audio.extend_from_slice(&b);
        }
        assert!(t0.elapsed() < timeout, "render timed out; events: {evs:?}");
    }
    engine.stop();
    while let Ok(e) = events.try_recv() {
        evs.push(e);
    }
    audio.truncate(frames * 2);
    (audio, evs)
}

fn freq(x: &[f32]) -> f64 {
    zero_cross_freq(x, 2, RATE)
}

/// Seconds `a..b` of interleaved stereo at 44.1 kHz.
fn secs(x: &[f32], a: f64, b: f64) -> &[f32] {
    &x[(a * RATE as f64) as usize * 2..(b * RATE as f64) as usize * 2]
}

fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, data) in files {
        w.start_file(*name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// 1 s intro at 440 Hz, then a loop body of 0.5 s 880 Hz + 0.5 s 220 Hz.
fn looped_vgm() -> Vec<u8> {
    vgm_psg(&[(254, 44_100)], &[(127, 22_050), (508, 22_050)])
}

#[test]
fn album_and_custom_loops_match_intro_plus_loops_plus_fade() {
    let dir = tmp_dir("fmt-loops");
    let vgm = dir.join("song.vgm");
    std::fs::write(&vgm, looped_vgm()).unwrap();
    for (mode, count, fade, expect_s) in [(LoopMode::Album, 2, 3.0f32, 1.0 + 2.0 + 3.0), (LoopMode::Custom, 3, 1.5, 1.0 + 3.0 + 1.5)] {
        let (engine, sink) = offline(&dir, RATE);
        engine.set_loop(mode, count, fade);
        engine.set_current(track("v", file(&vgm)), 0, true);
        let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
        let frames = out.len() / 2;
        let info = track_info(&evs, "v");
        println!("{mode:?} x{count} + {fade} s fade: {frames} frames ({:.4} s), track info {:?} ms, loop {:?}..{:?}", frames as f64 / RATE as f64, info.duration_ms, info.loop_start_ms, info.loop_end_ms);
        assert_eq!(frames, (expect_s * RATE as f64) as usize, "intro + {count} loops + fade");
        assert_eq!(info.duration_ms, Some((expect_s * 1000.0) as u64));
        assert_eq!((info.loop_start_ms, info.loop_end_ms), (Some(1000), Some(2000)));
        assert_eq!(info.codec, "vgm");
        assert_eq!(info.voice_count, 4);
        // Intro, then every pass through the body plays 880 Hz then 220 Hz.
        assert!((freq(secs(&out, 0.1, 0.95)) - psg_freq(254)).abs() < 3.0);
        for pass in 0..count as usize {
            let t = 1.0 + pass as f64;
            let (a, b) = (freq(secs(&out, t + 0.05, t + 0.45)), freq(secs(&out, t + 0.55, t + 0.95)));
            assert!((a - psg_freq(127)).abs() < 3.0 && (b - psg_freq(508)).abs() < 3.0, "pass {pass}: {a:.1} / {b:.1} Hz");
        }
        // The fade: full level going in, silent at the end.
        let fade_start = 1.0 + count as f64;
        assert!(rms(secs(&out, fade_start - 0.4, fade_start)) > 0.1);
        assert!(rms(&out[out.len() - 200..]) < 0.01);
    }
}

#[test]
fn endless_keeps_going() {
    let dir = tmp_dir("fmt-endless");
    let (vgm, nsf) = (dir.join("song.vgm"), dir.join("song.nsf"));
    std::fs::write(&vgm, looped_vgm()).unwrap();
    std::fs::write(&nsf, nsf_songs(&[253], "Endless")).unwrap();
    for (src, seconds) in [(&vgm, 12.0), (&nsf, 160.0)] {
        let (engine, sink) = offline(&dir, RATE);
        engine.set_loop(LoopMode::Endless, 2, 10.0);
        engine.set_current(track("e", file(src)), 0, true);
        let (out, evs) = collect_frames(&engine, &sink, (seconds * RATE as f64) as usize, Duration::from_secs(60));
        let info = track_info(&evs, "e");
        let tail = rms(&out[out.len() - RATE as usize * 2..]);
        println!("endless {}: {seconds} s rendered, duration {:?}, last second rms {tail:.3}", src.display(), info.duration_ms);
        assert_eq!(info.duration_ms, None, "endless has no duration");
        assert!(!evs.iter().any(|e| matches!(e, EngineEvent::Ended { .. })));
        // Past where Album mode would have ended (VGM: 13 s; NSF: 2:30 + 10 s), still playing at full level.
        assert!(tail > 0.1);
    }
}

#[test]
fn subsong_and_nezplug_timing_from_an_archive_entry_over_http() {
    let dir = tmp_dir("fmt-archive");
    let nsf = nsf_songs(&[253, 126], "Two Songs");
    let m3u = b"#TITLE Two Songs\nTwo.nsf::NSF,1,Low,0:01.500,,0:00.500\nTwo.nsf::NSF,2,High,0:02,,1\n";
    let set = zip_bytes(&[("Two Songs/Two.nsf", &nsf), ("Two Songs/Two.m3u", m3u), ("Two Songs/song.vgm", &looped_vgm())]);
    let srv = serve(set, "Two%20Songs.zip", Duration::ZERO, false);
    let base = SourceSpec::http(srv.url.clone(), "set:two");

    // inspectArchive: entries and playlist text.
    let (engine, sink) = offline(&dir, RATE);
    let listing = engine.inspect_archive(&base).unwrap();
    let paths: Vec<_> = listing.entries.iter().map(|e| (e.path.as_str(), e.size)).collect();
    assert_eq!(paths, vec![("Two Songs/Two.nsf", nsf.len() as u64), ("Two Songs/Two.m3u", m3u.len() as u64), ("Two Songs/song.vgm", looped_vgm().len() as u64)]);
    assert_eq!(listing.playlists, vec![("Two Songs/Two.m3u".to_string(), String::from_utf8(m3u.to_vec()).unwrap())]);

    // Sub-song 1 = "High": 2 s + 1 s fade from the playlist, 880 Hz.
    let extras = |sub: u32| SourceExtras { subsong: Some(sub), archive_entry: Some("Two Songs/Two.nsf".into()), ..Default::default() };
    engine.set_current(track("hi", base.clone().with_extras(extras(1))), 0, true);
    let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    let info = track_info(&evs, "hi");
    println!("archive entry sub-song 1: {} frames, info {:?} {:?} {:?}", out.len() / 2, info.title, info.subsong, info.duration_ms);
    assert_eq!(out.len() / 2, 3 * RATE as usize);
    assert_eq!(info.title.as_deref(), Some("High"));
    assert_eq!((info.subsong, info.subsong_count), (Some(1), Some(2)));
    assert!((freq(secs(&out, 0.2, 1.9)) - nes_pulse_freq(126)).abs() < 3.0);
    drop(engine);

    // Sub-song 0 = "Low", then the VGM from the same set, chained gaplessly.
    let (engine, sink) = offline(&dir, RATE);
    engine.set_loop(LoopMode::Album, 1, 0.0);
    engine.set_current(track("lo", base.clone().with_extras(extras(0))), 0, false);
    let vgm_entry = SourceExtras { archive_entry: Some("song.vgm".into()), ..Default::default() };
    engine.set_next(Some(track("vgm", base.clone().with_extras(vgm_entry))));
    engine.play();
    let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::Advanced { id } if id == "vgm")), "{evs:?}");
    // Low: 1.5 s + 0.5 s fade; VGM with 1 loop and no fade: 2 s.
    assert_eq!(out.len() / 2, 4 * RATE as usize);
    assert!((freq(secs(&out, 0.2, 1.4)) - nes_pulse_freq(253)).abs() < 3.0);
    assert!((freq(secs(&out, 2.1, 2.9)) - psg_freq(254)).abs() < 3.0);
    // A missing entry is a recoverable error, not a crash.
    let (engine, _sink) = offline(&dir, RATE);
    let events = engine.events();
    engine.set_current(track("x", base.with_extras(SourceExtras { archive_entry: Some("nope.nsf".into()), ..Default::default() })), 0, true);
    let t0 = Instant::now();
    loop {
        if let Ok(EngineEvent::Error { id, message, recoverable }) = events.recv_timeout(Duration::from_secs(5)) {
            assert_eq!(id.as_deref(), Some("x"));
            assert!(recoverable && message.contains("nope.nsf"), "{message}");
            break;
        }
        assert!(t0.elapsed() < Duration::from_secs(10));
    }
}

#[test]
fn voice_mask_mutes_chip_voices() {
    let dir = tmp_dir("fmt-voices");
    let vgm = dir.join("song.vgm");
    std::fs::write(&vgm, looped_vgm()).unwrap();
    let (engine, sink) = offline(&dir, RATE);
    engine.set_loop(LoopMode::Album, 1, 0.0);
    engine.set_voice_mask(0b1111);
    engine.set_current(track("m", file(&vgm)), 0, true);
    let (out, _) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    assert_eq!(out.len() / 2, 2 * RATE as usize);
    assert!(rms(&out) < 0.001, "all voices muted, rms {}", rms(&out));
    assert_eq!(engine.voice_count(), 0, "idle after the end");
}

/// 10 s 48 kHz sweep: render it whole, then a clip, then two consecutive clips chained.
#[test]
fn clips_match_slices_of_the_full_render_and_chain_gaplessly() {
    let dir = tmp_dir("fmt-clip");
    let rate = 48_000;
    let sig = sweep(rate, rate as usize * 10, 50.0, 12_000.0, 0.6);
    let a = dir.join("ost.wav");
    wav::write_f32(&a, rate, 2, &sig).unwrap();
    // The same audio as FLAC (24-bit), the format most cached rips end up in.
    let f = dir.join("ost.flac");
    let mut w = ghost_engine::flac::FlacWriter::create(&f, rate, 2, 24).unwrap();
    w.write(&sig).unwrap();
    w.finish().unwrap();

    for src in [&a, &f] {
        let (engine, sink) = offline(&dir, rate);
        engine.set_current(track("full", file(src)), 0, true);
        let (full, _) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
        assert_eq!(full.len(), sig.len());
        drop(engine);

        let clip = |s: u64, e: u64| SourceExtras { clip_start_ms: Some(s), clip_end_ms: Some(e), ..Default::default() };
        let (engine, sink) = offline(&dir, rate);
        engine.set_current(track("c", file_with(src, clip(2_500, 6_250))), 0, true);
        let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
        let expect = &full[2_500 * 48 * 2..6_250 * 48 * 2];
        let info = track_info(&evs, "c");
        println!("clip of {}: {} frames, info duration {:?} ms, max |diff| vs full render {:e}", src.display(), out.len() / 2, info.duration_ms, max_abs_diff(&out, expect));
        assert_eq!(out.len(), expect.len());
        assert_eq!(info.duration_ms, Some(3_750));
        assert_eq!(max_abs_diff(&out, expect), 0.0);
        drop(engine);

        // Seeks are relative to the clip.
        let (engine, sink) = offline(&dir, rate);
        engine.set_current(track("c", file_with(src, clip(2_500, 6_250))), 1_000, true);
        let (out, _) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
        let expect = &full[3_500 * 48 * 2..6_250 * 48 * 2];
        assert_eq!(out.len(), expect.len());
        assert_eq!(max_abs_diff(&out[960..], &expect[960..]), 0.0, "after the 10 ms seek fade-in");
        drop(engine);

        // Chapter 1 then chapter 2 of the same file: one continuous stream.
        let (engine, sink) = offline(&dir, rate);
        engine.set_current(track("ch1", file_with(src, clip(1_000, 4_321))), 0, false);
        engine.set_next(Some(track("ch2", file_with(src, clip(4_321, 7_000)))));
        engine.play();
        let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
        assert!(evs.iter().any(|e| matches!(e, EngineEvent::Advanced { id } if id == "ch2")), "{evs:?}");
        let expect = &full[48_000 * 2..7_000 * 48 * 2];
        println!("chained clips: {} frames, max |diff| {:e}", out.len() / 2, max_abs_diff(&out, expect));
        assert_eq!(out.len(), expect.len());
        assert_eq!(max_abs_diff(&out, expect), 0.0);
    }
}

/// Final status, path, error, and every progress (bytes, total) of one download.
type DownloadOutcome = (DownloadStatus, Option<std::path::PathBuf>, Option<String>, Vec<(u64, Option<u64>)>);

fn wait_download(engine: &Engine) -> DownloadOutcome {
    let events = engine.events();
    let mut progress = Vec::new();
    let t0 = Instant::now();
    loop {
        if let Ok(EngineEvent::Download { status, path, error, bytes, total_bytes, .. }) = events.recv_timeout(Duration::from_millis(100)) {
            if status == DownloadStatus::Progress {
                progress.push((bytes, total_bytes));
            } else {
                return (status, path, error, progress);
            }
        }
        assert!(t0.elapsed() < Duration::from_secs(60), "download timed out");
    }
}

fn decoded_frames(path: &Path, dir: &Path) -> (usize, u32, Vec<f32>) {
    let (engine, sink) = offline(dir, 44_100);
    engine.set_current(track("check", file(path)), 0, true);
    let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(60));
    let info = track_info(&evs, "check");
    assert_eq!(info.codec, "flac");
    (out.len() / 2, info.sample_rate, out)
}

#[test]
fn chip_downloads_render_tagged_flac() {
    use lofty::prelude::*;
    let dir = tmp_dir("fmt-dl");
    let set = dir.join("set.zip");
    let nsf = nsf_songs(&[253, 126], "Two Songs");
    std::fs::write(&set, zip_bytes(&[("Two.nsf", &nsf), ("Two.m3u", b"Two.nsf::NSF,2,High,0:02,,1\n"), ("song.vgm", &looped_vgm())])).unwrap();

    // VGM (inside the zip): Album 2 loops + 3 s fade, caller's tags.
    let (engine, _sink) = offline(&dir, 48_000);
    engine.set_loop(LoopMode::Album, 2, 3.0);
    let dest = dir.join("out").join("01 Song.vgm");
    let tags = TagInfo { title: "Song".into(), album: "Synthetic".into(), track_number: Some(1), ..Default::default() };
    let src = file_with(&set, SourceExtras { archive_entry: Some("song.vgm".into()), ..Default::default() });
    engine.download("d1".into(), src.clone(), dest.clone(), tags);
    let (status, path, error, progress) = wait_download(&engine);
    assert_eq!(status, DownloadStatus::Done, "{error:?}");
    let path = path.unwrap();
    assert_eq!(path, dir.join("out").join("01 Song.flac"));
    assert!(progress.len() >= 2 && progress.last().unwrap().0 == progress.last().unwrap().1.unwrap());
    let tagged = lofty::read_from_path(&path).unwrap();
    let tag = tagged.primary_tag().expect("tagged");
    assert_eq!(tag.title().as_deref(), Some("Song"));
    assert_eq!(tag.album().as_deref(), Some("Synthetic"));
    assert_eq!(tag.track(), Some(1));
    let (frames, rate, audio) = decoded_frames(&path, &dir);
    println!("vgm → {}: {frames} frames at {rate} Hz ({} bytes)", path.display(), std::fs::metadata(&path).unwrap().len());
    assert_eq!((frames, rate), (6 * 44_100, 44_100), "1 s intro + 2 x 1 s loop + 3 s fade");
    assert!((freq(secs(&audio, 1.05, 1.45)) - psg_freq(127)).abs() < 3.0);

    // NSF sub-song: title from the file's playlist when the caller has none; Endless renders as Album.
    engine.set_loop(LoopMode::Endless, 2, 10.0);
    let src = file_with(&set, SourceExtras { archive_entry: Some("Two.nsf".into()), subsong: Some(1), ..Default::default() });
    engine.download("d2".into(), src.clone(), dir.join("out").join("02.nsf"), TagInfo::default());
    let (status, path, error, _) = wait_download(&engine);
    assert_eq!(status, DownloadStatus::Done, "{error:?}");
    let path = path.unwrap();
    let tag = lofty::read_from_path(&path).unwrap();
    assert_eq!(tag.primary_tag().unwrap().title().as_deref(), Some("High"));
    assert_eq!(decoded_frames(&path, &dir).0, 3 * 44_100);

    // renderFlac: false saves the entry as-is.
    engine.download_with("d3".into(), src, dir.join("out").join("raw.nsf"), TagInfo::default(), DownloadOptions { render_flac: Some(false) });
    let (status, path, ..) = wait_download(&engine);
    assert_eq!(status, DownloadStatus::Done);
    assert_eq!(std::fs::read(path.unwrap()).unwrap(), nsf);

    // A clip of a plain WAV renders too.
    let rate = 48_000;
    let w = dir.join("long.wav");
    wav::write_f32(&w, rate, 2, &sweep(rate, rate as usize * 4, 100.0, 5000.0, 0.5)).unwrap();
    let clip = SourceExtras { clip_start_ms: Some(1_000), clip_end_ms: Some(2_500), ..Default::default() };
    engine.download("d4".into(), file_with(&w, clip), dir.join("out").join("chapter.wav"), TagInfo { title: "Chapter".into(), ..Default::default() });
    let (status, path, error, _) = wait_download(&engine);
    assert_eq!(status, DownloadStatus::Done, "{error:?}");
    let path = path.unwrap();
    assert_eq!(path.extension().unwrap(), "flac");
    let (engine2, sink) = offline(&dir, rate);
    engine2.set_current(track("c", file(&path)), 0, true);
    let (out, _) = collect_until_ended(&engine2, &sink, Duration::from_secs(30));
    assert_eq!(out.len() / 2, 72_000);
}

/// vgmstream over HTTP: the stream is decoded through the cache reader (no whole-file read), and
/// the format's own loop points drive the loop stage.
#[test]
fn vgmstream_streams_over_http_with_loops() {
    let dir = tmp_dir("fmt-vgm-http");
    let rate = 32_000;
    let frames = square_frames(rate, 500.0, 64_000, 12_000);
    let srv = serve(wav_pcm16(rate, &frames, true, Some((16_000, 48_000))), "music.lwav", Duration::ZERO, false);
    let (engine, sink) = offline(&dir, rate);
    engine.set_loop(LoopMode::Album, 2, 1.0);
    engine.set_current(track("w", SourceSpec::http(srv.url.clone(), "vgm-http")), 0, true);
    let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    let info = track_info(&evs, "w");
    println!("lwav over http: {} frames, codec {}, loop {:?}..{:?} ms", out.len() / 2, info.codec, info.loop_start_ms, info.loop_end_ms);
    assert_eq!(info.codec, "lwav");
    assert_eq!((info.loop_start_ms, info.loop_end_ms), (Some(500), Some(1500)));
    // 0.5 s intro + 2 x 1 s loop + 1 s fade.
    assert_eq!(out.len() / 2, 112_000);
    // Second pass of the body is the body again, sample for sample.
    let body1 = &out[16_000 * 2..48_000 * 2];
    let body2 = &out[48_000 * 2..80_000 * 2];
    assert!(max_abs_diff(body1, body2) < 1e-4);
}

/// A rip set big enough to watch arrive: an NSF plus 1.5 MB of incompressible filler.
fn big_set(nsf: &[u8]) -> Vec<u8> {
    let mut x = 0x9E37_79B9_7F4A_7C15u64;
    let filler: Vec<u8> = (0..1536 * 1024)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect();
    zip_bytes(&[("Set/Song.nsf", nsf), ("Set/filler.bin", &filler)])
}

/// The whole archive is fetched before an archive entry can do anything: `inspect_archive`
/// (through `cache_progress`), downloads and playback (`load_progress`) all report the archive's
/// bytes against its size while it arrives, instead of nothing.
#[test]
fn archive_fetches_report_progress() {
    let dir = tmp_dir("fmt-archive-progress");
    let nsf = nsf_songs(&[253], "Song");
    let set = big_set(&nsf);
    let len = set.len() as u64;
    // 16 KB per 7 ms (~2.3 MB/s): most of a second per fetch. One key per phase: each fetches anew.
    let srv = serve(set, "Set.zip", Duration::from_millis(7), false);
    let (engine, sink) = offline(&dir, RATE);
    let engine = std::sync::Arc::new(engine);
    let mid = |b: u64, t: Option<u64>| t == Some(len) && b > 0 && b < len;

    // inspectArchive: cache_progress under the archive source's cache key while it runs.
    assert_eq!(engine.cache_progress("set:inspect"), None);
    let base = SourceSpec::http(srv.url.clone(), "set:inspect");
    let inspect = {
        let (engine, base) = (engine.clone(), base.clone());
        std::thread::spawn(move || engine.inspect_archive(&base))
    };
    let mut seen = Vec::new();
    while !inspect.is_finished() {
        seen.extend(engine.cache_progress("set:inspect"));
        std::thread::sleep(Duration::from_millis(10));
    }
    let listing = inspect.join().unwrap().unwrap();
    assert_eq!(listing.entries.len(), 2);
    assert!(seen.iter().any(|&(b, t)| mid(b, t)), "no progress while inspecting: {seen:?}");
    assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0), "{seen:?}");

    // Download of an entry as-is: archive bytes / archive size, then the entry's size.
    let entry = SourceExtras { archive_entry: Some("Set/Song.nsf".into()), ..Default::default() };
    let src = SourceSpec::http(srv.url.clone(), "set:download").with_extras(entry.clone());
    engine.download_with("d".into(), src, dir.join("out").join("Song.nsf"), TagInfo::default(), DownloadOptions { render_flac: Some(false) });
    let (status, path, error, progress) = wait_download(&engine);
    assert_eq!(status, DownloadStatus::Done, "{error:?}");
    assert_eq!(std::fs::read(path.unwrap()).unwrap(), nsf);
    println!("archive download progress: {progress:?}");
    assert!(progress.iter().any(|&(b, t)| mid(b, t)), "no archive progress: {progress:?}");
    assert_eq!(progress.last(), Some(&(nsf.len() as u64, Some(nsf.len() as u64))));

    // Playback: a whole-file wait on the archive's bytes, then the track starts.
    engine.set_current(track("e", SourceSpec::http(srv.url.clone(), "set:play").with_extras(entry)), 0, true);
    let t0 = Instant::now();
    let mut seen = Vec::new();
    loop {
        if let Some(p) = engine.load_progress(ghost_engine::Slot::Current) {
            let started = p.started;
            seen.push(p);
            if started {
                break;
            }
        }
        while sink.blocks.try_recv().is_ok() {}
        assert!(t0.elapsed() < Duration::from_secs(20), "never started: {:?}", seen.last());
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(seen.iter().all(|p| p.id == "e" && p.whole_file), "{seen:?}");
    assert!(seen.iter().any(|p| !p.started && mid(p.bytes, p.total_bytes)), "no archive progress: {seen:?}");
    assert_eq!(seen.last().unwrap().bytes, len, "the archive is whole by the time it plays");
}
