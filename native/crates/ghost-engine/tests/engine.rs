//! End-to-end engine tests through the public API and the offline null sink.

mod common;

use std::time::Duration;

use common::*;
use ghost_engine::wav;
use ghost_engine::{DownloadStatus, EngineEvent, PlaybackState, SourceSpec, TagInfo};

/// Gapless null test: one continuous sweep split at an arbitrary (non block-aligned) frame into
/// two files; rendering A → B must reproduce the original exactly — no gap, no click.
#[test]
fn gapless_null_test_same_rate() {
    let dir = tmp_dir("gapless");
    let rate = 48_000;
    let total = 3 * rate as usize + 1234;
    let split = 70_001;
    let sig = sweep(rate, total, 40.0, 16_000.0, 0.7);
    let (a, b) = (dir.join("a.wav"), dir.join("b.wav"));
    wav::write_f32(&a, rate, 2, &sig[..split * 2]).unwrap();
    wav::write_f32(&b, rate, 2, &sig[split * 2..]).unwrap();

    let (engine, sink) = offline(&dir, rate);
    engine.set_current(track("a", file(&a)), 0, false);
    engine.set_next(Some(track("b", file(&b))));
    engine.play();
    let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));

    assert_eq!(out.len(), sig.len(), "rendered {} frames, expected {}", out.len() / 2, total);
    let diff = max_abs_diff(&out, &sig);
    println!("gapless same-rate: {} frames, split at {split}, max |diff| = {diff:e}", total);
    assert!(diff <= f32::EPSILON, "max diff {diff}");
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::Advanced { id } if id == "b")), "{evs:?}");
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::Ended { id } if id == "b")));
}

/// Same test through the resampler (44.1 kHz files on a 48 kHz output): A → B must equal the
/// unsplit file rendered the same way. Works because the next track is decoded as a
/// continuation of the current one through the same resampler.
#[test]
fn gapless_null_test_resampled() {
    let dir = tmp_dir("gapless-rs");
    let src_rate = 44_100;
    let total = 3 * src_rate as usize + 777;
    let split = 61_237;
    let sig = sweep(src_rate, total, 40.0, 15_000.0, 0.7);
    let (whole, a, b) = (dir.join("whole.wav"), dir.join("a.wav"), dir.join("b.wav"));
    wav::write_f32(&whole, src_rate, 2, &sig).unwrap();
    wav::write_f32(&a, src_rate, 2, &sig[..split * 2]).unwrap();
    wav::write_f32(&b, src_rate, 2, &sig[split * 2..]).unwrap();

    let (engine, sink) = offline(&dir, 48_000);
    engine.set_current(track("whole", file(&whole)), 0, true);
    let (reference, _) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    drop(engine);

    let (engine, sink) = offline(&dir, 48_000);
    engine.set_current(track("a", file(&a)), 0, false);
    engine.set_next(Some(track("b", file(&b))));
    engine.play();
    let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::Advanced { id } if id == "b")));

    assert_eq!(out.len(), reference.len());
    let diff = max_abs_diff(&out, &reference);
    let junction = (split as f64 * 48_000.0 / src_rate as f64) as usize;
    let lo = (junction - 64) * 2;
    let local = max_abs_diff(&out[lo..lo + 256], &reference[lo..lo + 256]);
    println!("gapless resampled: {} frames out, junction ~{junction}, max |diff| = {diff:e} (around junction {local:e})", out.len() / 2);
    assert!(diff < 1e-5, "resampled gapless differs by {diff}");
}

/// Repeat-one: `set_next` with the same id as the current track loops gaplessly into it.
#[test]
fn repeat_one_same_id_is_gapless() {
    let dir = tmp_dir("repeat");
    let rate = 48_000;
    let sig = sweep(rate, 30_000, 100.0, 2000.0, 0.5);
    let a = dir.join("a.wav");
    wav::write_f32(&a, rate, 2, &sig).unwrap();
    let (engine, sink) = offline(&dir, rate);
    engine.set_current(track("same", file(&a)), 0, false);
    engine.set_next(Some(track("same", file(&a))));
    engine.play();
    let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    let twice: Vec<f32> = sig.iter().chain(sig.iter()).copied().collect();
    assert_eq!(out.len(), twice.len());
    assert_eq!(max_abs_diff(&out, &twice), 0.0);
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::Advanced { id } if id == "same")), "{evs:?}");
}

#[test]
fn events_state_trackinfo_and_cache_complete_over_http() {
    let dir = tmp_dir("events");
    let rate = 44_100;
    let sig = sweep(rate, rate as usize * 2, 200.0, 4000.0, 0.5);
    let a = dir.join("a.wav");
    wav::write_f32(&a, rate, 2, &sig).unwrap();
    let srv = serve(std::fs::read(&a).unwrap(), "a.wav", Duration::ZERO, false);
    let (engine, sink) = offline(&dir, 48_000);
    let spec = SourceSpec::Http { url: srv.url.clone(), headers: vec![("X-Test".into(), "1".into())], cache_key: "events-a".into(), format_hint: None, extras: Default::default() };
    engine.set_current(track("t1", spec), 0, true);
    let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    assert_eq!(out.len() / 2, 96_000, "2 s at 48 kHz");
    let states: Vec<PlaybackState> = evs.iter().filter_map(|e| if let EngineEvent::State { state, .. } = e { Some(*state) } else { None }).collect();
    assert_eq!(states.first(), Some(&PlaybackState::Loading), "{states:?}");
    assert!(states.contains(&PlaybackState::Playing));
    assert_eq!(states.last(), Some(&PlaybackState::Idle));
    let info = evs.iter().find_map(|e| if let EngineEvent::TrackInfo(i) = e { Some(i.clone()) } else { None }).expect("no TrackInfo");
    assert_eq!(info.id, "t1");
    assert_eq!(info.sample_rate, 44_100);
    assert_eq!(info.channels, 2);
    assert_eq!(info.duration_ms, Some(2000));
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::CacheComplete { id, cache_key, .. } if id == "t1" && cache_key == "events-a")), "{evs:?}");
    assert!(engine.cache_stats().complete_entries >= 1);
}

#[test]
fn stalled_stream_reports_recoverable_error() {
    let dir = tmp_dir("stall");
    let srv = serve(vec![0u8; 1000], "hang.mp3", Duration::ZERO, true);
    let (engine, _sink) = offline(&dir, 48_000);
    let events = engine.events();
    let spec = SourceSpec::Http { url: srv.url.clone(), headers: vec![], cache_key: "stall".into(), format_hint: None, extras: Default::default() };
    let t0 = std::time::Instant::now();
    engine.set_current(track("s", spec), 0, true);
    loop {
        let e = events.recv_timeout(Duration::from_secs(15)).expect("no error event within 15 s");
        if let EngineEvent::Error { id, recoverable, message } = e {
            assert_eq!(id.as_deref(), Some("s"));
            assert!(recoverable, "{message}");
            let dt = t0.elapsed();
            println!("stall reported after {dt:?}: {message}");
            assert!(dt >= Duration::from_secs(7) && dt < Duration::from_secs(12), "{dt:?}");
            break;
        }
    }
}

#[test]
fn analyze_emits_analysis_for_file() {
    let dir = tmp_dir("analyze");
    let rate = 44_100;
    let sig = sweep(rate, rate as usize * 3, 60.0, 8000.0, 0.5);
    let a = dir.join("a.wav");
    wav::write_f32(&a, rate, 2, &sig).unwrap();
    let (engine, _sink) = offline(&dir, 48_000);
    let events = engine.events();
    engine.analyze("an".into(), file(&a));
    loop {
        match events.recv_timeout(Duration::from_secs(60)).expect("no analysis") {
            EngineEvent::Analysis { id, cache_key, result } => {
                assert_eq!(id, "an");
                assert_eq!(cache_key, None);
                assert_eq!(result.duration_ms, 3000);
                break;
            }
            EngineEvent::Error { message, .. } => panic!("{message}"),
            _ => {}
        }
    }
}

fn download_events(engine: &ghost_engine::Engine, timeout: Duration) -> Vec<EngineEvent> {
    let events = engine.events();
    let mut out = Vec::new();
    let t0 = std::time::Instant::now();
    while t0.elapsed() < timeout {
        if let Ok(e) = events.recv_timeout(Duration::from_millis(100)) {
            let done = matches!(&e, EngineEvent::Download { status: DownloadStatus::Done | DownloadStatus::Error | DownloadStatus::Canceled, .. });
            out.push(e);
            if done {
                // Give a superseded job a moment to (wrongly) report.
                std::thread::sleep(Duration::from_millis(300));
                while let Ok(e) = events.try_recv() {
                    out.push(e);
                }
                break;
            }
        }
    }
    out
}

#[test]
fn download_fetches_tags_and_reports_progress() {
    use lofty::prelude::*;
    let dir = tmp_dir("download");
    let rate = 44_100;
    let sig = sweep(rate, rate as usize * 4, 100.0, 4000.0, 0.5);
    let a = dir.join("src.wav");
    wav::write_f32(&a, rate, 2, &sig).unwrap();
    let bytes = std::fs::read(&a).unwrap();
    let total = bytes.len() as u64;
    let srv = serve(bytes, "src.wav", Duration::from_millis(1), false);
    let (engine, _sink) = offline(&dir, 48_000);
    let dest = dir.join("out").join("Game").join("01 Title.wav");
    let tags = TagInfo {
        title: "Presentiment".into(),
        album: "Chrono Trigger".into(),
        album_artist: Some("Square".into()),
        artist: Some("Yasunori Mitsuda".into()),
        composer: Some("Yasunori Mitsuda".into()),
        track_number: Some(1),
        track_total: Some(64),
        disc_number: Some(1),
        year: Some(1995),
        genre: Some("Game".into()),
        replay_gain_track_db: Some(-5.46),
        replay_gain_track_peak: Some(0.98),
        ..Default::default()
    };
    let spec = SourceSpec::Http { url: srv.url.clone(), headers: vec![], cache_key: "dl".into(), format_hint: None, extras: Default::default() };
    engine.download("d1".into(), spec, dest.clone(), tags);
    let evs = download_events(&engine, Duration::from_secs(30));
    let dl: Vec<_> = evs.iter().filter_map(|e| if let EngineEvent::Download { status, bytes, total_bytes, path, .. } = e { Some((*status, *bytes, *total_bytes, path.clone())) } else { None }).collect();
    let (last_status, _, _, path) = dl.last().cloned().unwrap();
    assert_eq!(last_status, DownloadStatus::Done, "{dl:?}");
    assert_eq!(path.as_deref(), Some(dest.as_path()));
    // Final progress before tagging has bytes == total.
    let progress: Vec<_> = dl.iter().filter(|d| d.0 == DownloadStatus::Progress).collect();
    assert!(progress.len() >= 2);
    assert_eq!(progress.last().unwrap().1, total);
    assert_eq!(progress.last().unwrap().2, Some(total));
    // Tags written; temp file gone.
    let tagged = lofty::read_from_path(&dest).unwrap();
    let tag = tagged.primary_tag().expect("no tag");
    assert_eq!(tag.title().as_deref(), Some("Presentiment"));
    assert_eq!(tag.album().as_deref(), Some("Chrono Trigger"));
    assert_eq!(tag.track(), Some(1));
    assert!(std::fs::read_dir(dest.parent().unwrap()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".ghostpart")));
    // Audio intact.
    let (round, _, _) = wav::read(&dest).unwrap();
    assert_eq!(round.len(), sig.len());
}

#[test]
fn download_cancel_and_id_reuse() {
    let dir = tmp_dir("dl-cancel");
    let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    let slow = serve(data.clone(), "slow.bin", Duration::from_millis(20), false);
    let (engine, _sink) = offline(&dir, 48_000);
    let dest = dir.join("x.bin");
    let slow_spec = SourceSpec::Http { url: slow.url.clone(), headers: vec![], cache_key: "slow".into(), format_hint: None, extras: Default::default() };

    // Cancel.
    engine.download("c".into(), slow_spec.clone(), dest.clone(), TagInfo::default());
    std::thread::sleep(Duration::from_millis(300));
    engine.cancel_download("c");
    let evs = download_events(&engine, Duration::from_secs(10));
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::Download { status: DownloadStatus::Canceled, .. })), "{evs:?}");
    assert!(!dest.exists());

    // Reuse the id with a different (fast, local) source: only the new job reports.
    let local = dir.join("local.bin");
    std::fs::write(&local, &data[..100_000]).unwrap();
    engine.download("r".into(), slow_spec, dest.clone(), TagInfo::default());
    std::thread::sleep(Duration::from_millis(200));
    engine.download("r".into(), SourceSpec::File { path: local, format_hint: None, extras: Default::default() }, dest.clone(), TagInfo::default());
    let evs = download_events(&engine, Duration::from_secs(10));
    let finals: Vec<_> = evs.iter().filter(|e| matches!(e, EngineEvent::Download { status: DownloadStatus::Done | DownloadStatus::Canceled | DownloadStatus::Error, .. })).collect();
    assert_eq!(finals.len(), 1, "{evs:?}");
    assert!(matches!(finals[0], EngineEvent::Download { status: DownloadStatus::Done, .. }));
    assert_eq!(std::fs::read(&dest).unwrap().len(), 100_000);
}

fn tone(rate: u32, frames: usize, freq: f32, amp: f32) -> Vec<f32> {
    (0..frames)
        .flat_map(|i| {
            let v = (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * amp;
            [v, v]
        })
        .collect()
}

fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

#[test]
fn normalization_track_and_album_gain() {
    let dir = tmp_dir("norm");
    let rate = 48_000;
    let sig = tone(rate, rate as usize, 1000.0, 0.25);
    let a = dir.join("a.wav");
    wav::write_f32(&a, rate, 2, &sig).unwrap();
    for (mode, lufs, album_lufs, expect_db) in [
        (ghost_engine::NormalizationMode::Track, Some(-20.0), Some(-22.0), 4.0f32),
        (ghost_engine::NormalizationMode::Album, Some(-20.0), Some(-22.0), 6.0),
        (ghost_engine::NormalizationMode::Track, None, None, -4.0), // provisional
    ] {
        let (engine, sink) = offline(&dir, rate);
        engine.set_normalization(true, -16.0, mode);
        let mut t = track("n", file(&a));
        t.lufs = lufs;
        t.album_lufs = album_lufs;
        t.album_key = Some("alb".into());
        engine.set_current(t, 0, true);
        let (out, _) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
        // Look at the first 200 ms (before any measurement-driven ramp could start).
        let p = peak(&out[..rate as usize / 5 * 2]);
        let got_db = 20.0 * (p / 0.25).log10();
        println!("normalization {mode:?} lufs={lufs:?}: gain {got_db:.2} dB (expected {expect_db})");
        assert!((got_db - expect_db).abs() < 0.05, "{mode:?}: got {got_db} dB, expected {expect_db}");
    }
}

#[test]
fn crossfade_overlaps_and_same_album_stays_gapless() {
    let dir = tmp_dir("xfade");
    let rate = 48_000;
    let (a, b) = (dir.join("a.wav"), dir.join("b.wav"));
    wav::write_f32(&a, rate, 2, &tone(rate, rate as usize * 2, 300.0, 0.3)).unwrap();
    wav::write_f32(&b, rate, 2, &tone(rate, rate as usize * 2, 500.0, 0.3)).unwrap();
    for (same_album, expect_frames) in [(false, 4 * rate as usize - rate as usize / 2), (true, 4 * rate as usize)] {
        let (engine, sink) = offline(&dir, rate);
        engine.set_crossfade(0.5);
        let mut ta = track("a", file(&a));
        let mut tb = track("b", file(&b));
        if same_album {
            ta.album_key = Some("x".into());
            tb.album_key = Some("x".into());
        }
        engine.set_current(ta, 0, false);
        engine.set_next(Some(tb));
        engine.play();
        let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
        assert!(evs.iter().any(|e| matches!(e, EngineEvent::Advanced { id } if id == "b")));
        assert_eq!(out.len() / 2, expect_frames, "same_album={same_album}");
        // Equal-power: no dip/bump beyond the limiter ceiling, and no clicks.
        assert!(peak(&out) <= ghost_engine::util::db_to_lin(-1.0) + 1e-6);
        let jumps = out.as_chunks::<2>().0.windows(2).map(|w| (w[1][0] - w[0][0]).abs()).fold(0.0f32, f32::max);
        assert!(jumps < 0.05, "max sample jump {jumps}");
    }
}

#[test]
fn skipping_to_preloaded_next_reuses_its_voice() {
    let dir = tmp_dir("promote");
    let rate = 48_000;
    let (a, b) = (dir.join("a.wav"), dir.join("b.wav"));
    let sa = tone(rate, rate as usize * 3, 300.0, 0.3);
    let sb = sweep(rate, rate as usize, 200.0, 3000.0, 0.4);
    wav::write_f32(&a, rate, 2, &sa).unwrap();
    wav::write_f32(&b, rate, 2, &sb).unwrap();
    let (engine, sink) = offline(&dir, rate);
    engine.set_current(track("a", file(&a)), 0, true);
    engine.set_next(Some(track("b", file(&b))));
    // Wait until some of A has been rendered, then skip.
    let first = sink.blocks.recv_timeout(Duration::from_secs(5)).unwrap();
    engine.set_current(track("b", file(&b)), 0, true);
    let (rest, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    let out: Vec<f32> = first.into_iter().chain(rest).collect();
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::Ended { id } if id == "b")), "{evs:?}");
    // B plays from its start, in full; only its first 10 ms overlap A's fade-out.
    let n = out.len();
    let tail = &out[n - sb.len()..];
    assert_eq!(max_abs_diff(&tail[960..], &sb[960..]), 0.0);
    assert!(n < (sa.len() + sb.len()), "A should have been cut short");
}

#[test]
fn late_next_falls_back_to_standalone_decoder() {
    let dir = tmp_dir("late-next");
    let rate = 48_000;
    let sig = sweep(rate, rate as usize, 100.0, 5000.0, 0.5);
    let split = 12_345;
    let (a, b) = (dir.join("a.wav"), dir.join("b.wav"));
    wav::write_f32(&a, rate, 2, &sig[..split * 2]).unwrap();
    wav::write_f32(&b, rate, 2, &sig[split * 2..]).unwrap();
    let (engine, sink) = offline(&dir, rate);
    engine.set_current(track("a", file(&a)), 0, false);
    // A's worker decodes all of A (it fits in the ring) and finishes before B is attached.
    std::thread::sleep(Duration::from_millis(300));
    engine.set_next(Some(track("b", file(&b))));
    std::thread::sleep(Duration::from_millis(100));
    engine.play();
    let (out, _) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    assert_eq!(out.len(), sig.len());
    assert_eq!(max_abs_diff(&out, &sig), 0.0);
}

#[test]
fn start_offset_is_sample_accurate() {
    let dir = tmp_dir("offset");
    let rate = 48_000;
    let sig = sweep(rate, rate as usize * 2, 100.0, 5000.0, 0.5);
    let a = dir.join("a.wav");
    wav::write_f32(&a, rate, 2, &sig).unwrap();
    let (engine, sink) = offline(&dir, rate);
    engine.set_current(track("a", file(&a)), 1000, true);
    let (out, _) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    let expect = &sig[rate as usize * 2..];
    assert_eq!(out.len(), expect.len());
    // 10 ms fade-in, then exact.
    assert_eq!(max_abs_diff(&out[960..], &expect[960..]), 0.0);
}

#[test]
fn analysis_frames_follow_playback() {
    let dir = tmp_dir("frames");
    let rate = 48_000;
    let a = dir.join("a.wav");
    wav::write_f32(&a, rate, 2, &tone(rate, rate as usize, 440.0, 0.5)).unwrap();
    let (engine, sink) = offline(&dir, rate);
    let mut f = ghost_engine::AnalysisFrame::default();
    assert!(!engine.analysis_frame(&mut f), "no frame before playback");
    engine.set_current(track("a", file(&a)), 0, true);
    let (_out, _) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    assert!(engine.analysis_frame(&mut f), "frame expected right after playback");
    assert!(f.track_seq > 0);
    assert!(f.position_ms > 900.0 && f.position_ms <= 1000.0, "position {}", f.position_ms);
    std::thread::sleep(Duration::from_millis(1300));
    assert!(!engine.analysis_frame(&mut f), "idle for >1 s should report no frame");
}

#[test]
fn download_embeds_cover_art() {
    use lofty::prelude::*;
    let dir = tmp_dir("cover");
    let rate = 44_100;
    let a = dir.join("src.wav");
    wav::write_f32(&a, rate, 2, &tone(rate, 4410, 440.0, 0.2)).unwrap();
    let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0];
    jpeg.extend(std::iter::repeat_n(0x55u8, 2000));
    jpeg.extend([0xFF, 0xD9]);
    let cover = serve(jpeg.clone(), "cover.jpg", Duration::ZERO, false);
    let (engine, _sink) = offline(&dir, 48_000);
    let dest = dir.join("tagged.wav");
    let tags = TagInfo { title: "T".into(), album: "A".into(), cover_url: Some(cover.url.clone()), ..Default::default() };
    engine.download("cv".into(), file(&a), dest.clone(), tags);
    let evs = download_events(&engine, Duration::from_secs(20));
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::Download { status: DownloadStatus::Done, .. })), "{evs:?}");
    let tagged = lofty::read_from_path(&dest).unwrap();
    let tag = tagged.primary_tag().unwrap();
    assert_eq!(tag.pictures().len(), 1);
    assert_eq!(tag.pictures()[0].data(), &jpeg[..]);
}

#[test]
fn engine_handle_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<ghost_engine::Engine>();
    assert_send_sync::<ghost_engine::OfflineSink>();
}

/// An expiring URL (YouTube-style) that starts answering 403 mid-stream must surface as a
/// recoverable error carrying the status, so the player can re-resolve it; a fresh URL for the
/// same cache key then plays on.
#[test]
fn url_expiring_mid_stream_reports_http_status() {
    let dir = tmp_dir("expire");
    let rate = 48_000;
    let sig = sweep(rate, rate as usize * 12, 60.0, 8_000.0, 0.5);
    let wavf = dir.join("long.wav");
    wav::write_f32(&wavf, rate, 2, &sig).unwrap();
    let bytes = std::fs::read(&wavf).unwrap();
    let srv = serve_with(bytes.clone(), "long.wav", Duration::from_millis(1), false, |a| (a >= 1024 * 1024).then_some(403));
    let (engine, sink) = offline(&dir, rate);
    let events = engine.events();
    let spec = SourceSpec::Http { url: srv.url.clone(), headers: vec![], cache_key: "expire".into(), format_hint: None, extras: Default::default() };
    engine.set_current(track("x", spec), 0, true);
    let t0 = std::time::Instant::now();
    let message = loop {
        while sink.blocks.try_recv().is_ok() {}
        match events.recv_timeout(Duration::from_millis(20)) {
            Ok(EngineEvent::Error { id, recoverable, message }) => {
                assert_eq!(id.as_deref(), Some("x"));
                assert!(recoverable, "{message}");
                break message;
            }
            _ => assert!(t0.elapsed() < Duration::from_secs(10), "no error event"),
        }
    };
    assert!(message.contains("HTTP 403"), "{message}");
    // Re-resolved: same cache key, new URL.
    let fresh = serve(bytes, "long.wav", Duration::ZERO, false);
    let spec = SourceSpec::Http { url: fresh.url.clone(), headers: vec![], cache_key: "expire".into(), format_hint: None, extras: Default::default() };
    engine.set_current(track("x2", spec), 5_000, true);
    let t1 = std::time::Instant::now();
    loop {
        while sink.blocks.try_recv().is_ok() {}
        match events.recv_timeout(Duration::from_millis(20)) {
            Ok(EngineEvent::State { state: PlaybackState::Playing, id: Some(id) }) if id == "x2" => break,
            Ok(EngineEvent::Error { message, .. }) => panic!("fresh URL failed: {message}"),
            _ => assert!(t1.elapsed() < Duration::from_secs(10), "fresh URL never played"),
        }
    }
}

/// A FLAC still downloading with megabytes of embedded cover art in front of the audio: playback
/// starts without waiting for the artwork, and decodes exactly like the local file.
#[test]
fn streamed_flac_skips_embedded_art() {
    use ghost_engine::source::{self, OpenCtx};
    let dir = tmp_dir("art-flac");
    let rate = 44_100;
    let sig = sweep(rate, rate as usize * 20, 50.0, 10_000.0, 0.5);
    let plain = dir.join("plain.flac");
    let mut w = ghost_engine::flac::FlacWriter::create(&plain, rate, 2, 16).unwrap();
    w.write(&sig).unwrap();
    w.finish().unwrap();
    // Insert a 4 MB PICTURE block after STREAMINFO.
    let f = std::fs::read(&plain).unwrap();
    assert_eq!(&f[..4], b"fLaC");
    let si_len = u32::from_be_bytes([0, f[5], f[6], f[7]]) as usize;
    let si_end = 8 + si_len;
    let mut pic = Vec::new();
    pic.extend(3u32.to_be_bytes());
    pic.extend(10u32.to_be_bytes());
    pic.extend(b"image/jpeg");
    pic.extend(0u32.to_be_bytes());
    pic.extend([0u8; 16]);
    let art = 4 * 1024 * 1024;
    pic.extend((art as u32).to_be_bytes());
    pic.extend((0..art).map(|i| (i * 7 % 251) as u8));
    let mut withart = f[..si_end].to_vec();
    withart[4] &= 0x7f; // STREAMINFO is no longer the last block
    withart.push(6 | (f[4] & 0x80));
    withart.extend(&(pic.len() as u32).to_be_bytes()[1..]);
    withart.extend(&pic);
    withart.extend(&f[si_end..]);
    let local = dir.join("art.flac");
    std::fs::write(&local, &withart).unwrap();

    let decode = |spec: &SourceSpec, cache: &std::sync::Arc<ghost_engine::cache::CacheManager>| {
        let ctx = OpenCtx { cache, cancel: Default::default(), accurate_seek: false };
        let t = std::time::Instant::now();
        let mut s = source::open(spec, &ctx).unwrap_or_else(|e| panic!("{}", e.message));
        let mut buf = vec![0.0f32; 4096];
        let n = s.read(&mut buf).unwrap();
        let first = t.elapsed();
        let mut all = buf[..n * 2].to_vec();
        loop {
            let n = s.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            all.extend_from_slice(&buf[..n * 2]);
        }
        (first, all)
    };
    let cache = ghost_engine::cache::CacheManager::new(dir.join("cache"), 1 << 30, "test").unwrap();
    let (_, want) = decode(&file(&local), &cache);
    // ~3 MB/s: the artwork alone would take well over a second.
    let srv = serve(withart.clone(), "art.flac", Duration::from_millis(5), false);
    let spec = SourceSpec::Http { url: srv.url.clone(), headers: vec![], cache_key: "art".into(), format_hint: None, extras: Default::default() };
    let (first, got) = decode(&spec, &cache);
    assert!(first < Duration::from_millis(800), "first audio after {first:?}");
    assert_eq!(got.len(), want.len());
    assert!(got == want, "streamed decode differs");
}
