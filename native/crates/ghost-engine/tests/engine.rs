//! End-to-end engine tests through the public API and the offline null sink.

mod common;

use std::time::{Duration, Instant};

use common::*;
use ghost_engine::wav;
use ghost_engine::{DownloadStatus, EngineEvent, NormalizationMode, PlaybackState, SourceExtras, SourceSpec, TagInfo};

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
    let (out, mut evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    // The render outruns real time, so the cache may finish writing a little after the track ends.
    let cache_done = |evs: &[EngineEvent]| evs.iter().any(|e| matches!(e, EngineEvent::CacheComplete { .. }));
    let (events, t0) = (engine.events(), std::time::Instant::now());
    while !cache_done(&evs) && t0.elapsed() < Duration::from_secs(5) {
        if let Ok(e) = events.recv_timeout(Duration::from_millis(50)) {
            evs.push(e);
        }
    }
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
        // Not measured yet, but its album is: the album's loudness is the better first guess.
        (ghost_engine::NormalizationMode::Track, None, Some(-22.0), 6.0),
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

/// Waits for the `Analysis` event of track `id` (its loudness reached the gain by then).
fn analysis_of(engine: &ghost_engine::Engine, id: &str, timeout: Duration) -> Option<ghost_engine::OfflineAnalysis> {
    let events = engine.events();
    let t0 = Instant::now();
    while t0.elapsed() < timeout {
        if let Ok(EngineEvent::Analysis { id: got, result, .. }) = events.recv_timeout(Duration::from_millis(50)) {
            if got == id {
                return Some(result);
            }
        }
    }
    None
}

#[test]
fn clip_is_measured_without_waiting_for_the_whole_stream() {
    // A chapter of a long video: the stream past 4 MB never arrives (the server refuses ranges
    // starting there), so the file can't complete, but the clip lies in its first 1.2 MB.
    let dir = tmp_dir("clip-measure");
    let rate = 48_000;
    let a = dir.join("long.wav");
    wav::write_f32(&a, rate, 2, &tone(rate, rate as usize * 40, 440.0, 0.1)).unwrap();
    let srv = serve_with(std::fs::read(&a).unwrap(), "long.wav", Duration::ZERO, false, |start| (start >= 4 << 20).then_some(503));
    let (engine, _sink) = offline(&dir, rate);
    engine.set_normalization(true, -16.0, NormalizationMode::Track);
    let extras = SourceExtras { clip_start_ms: Some(1000), clip_end_ms: Some(3000), ..Default::default() };
    let spec = SourceSpec::Http { url: srv.url.clone(), headers: vec![], cache_key: "clip".into(), format_hint: None, extras };
    engine.set_current(track("c", spec), 0, true);
    let a = analysis_of(&engine, "c", Duration::from_secs(30)).expect("the clip was never measured");
    let lufs = a.integrated_lufs.expect("no loudness");
    // A 440 Hz sine at 0.1 in both channels: about −20.7 LUFS.
    assert!((lufs + 20.7).abs() < 1.0, "clip measured at {lufs} LUFS");
}

#[test]
fn loud_stream_is_turned_down_before_it_finishes_downloading() {
    // A very loud track (a 0.9 sine, about −1.6 LUFS) streaming at ~2× real time: the whole
    // file takes ~14 s. It starts at the provisional −4 dB; the measurement running along the
    // download reports it loud after ~1.5 s. The window checked below is rendered ~9–12 s in:
    // before the file's last 4 s arrive (playback can't get ahead of the download), so before
    // the full measurement could exist, and with plenty of slack for a loaded machine.
    let dir = tmp_dir("interim");
    let rate = 48_000;
    let secs = 30;
    let a = dir.join("loud.wav");
    wav::write_f32(&a, rate, 2, &tone(rate, rate as usize * secs, 440.0, 0.9)).unwrap();
    let srv = serve(std::fs::read(&a).unwrap(), "loud.wav", Duration::from_millis(20), false);
    let (engine, sink) = offline(&dir, rate);
    engine.set_normalization(true, -16.0, NormalizationMode::Track);
    let spec = SourceSpec::Http { url: srv.url.clone(), headers: vec![], cache_key: "loud".into(), format_hint: None, extras: Default::default() };
    engine.set_current(track("l", spec), 0, true);
    let (out, _) = collect_until_ended(&engine, &sink, Duration::from_secs(60));
    let at = |s: f32| (s * rate as f32) as usize * 2;
    let start = peak(&out[..at(0.5)]);
    let middle = peak(&out[at(18.0)..at(26.0)]);
    println!("peak at the start {start:.3}, at 18–26 s {middle:.3}");
    assert!((start - 0.9 * ghost_engine::util::db_to_lin(-4.0)).abs() < 0.02, "start {start}");
    // Measured −1.6 LUFS → −14.4 dB; anything near that shows it was turned down mid-download.
    assert!(middle < 0.9 * ghost_engine::util::db_to_lin(-10.0), "still at {middle} 18–26 s in");
}

#[test]
fn preview_is_measured() {
    let dir = tmp_dir("preview-measure");
    let rate = 48_000;
    let a = dir.join("a.wav");
    wav::write_f32(&a, rate, 2, &tone(rate, rate as usize * 3, 440.0, 0.1)).unwrap();
    let (engine, _sink) = offline(&dir, rate);
    engine.set_normalization(true, -16.0, NormalizationMode::Track);
    engine.preview(track("p", file(&a)), 0);
    assert!(analysis_of(&engine, "p", Duration::from_secs(30)).is_some_and(|a| a.integrated_lufs.is_some()), "the preview was never measured");
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
    // A is long enough that the skip lands before the (faster than real time) render reaches its
    // end, even on a heavily loaded machine.
    let sa = tone(rate, rate as usize * 30, 300.0, 0.3);
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
    // 11.5 MB: longer than any one request (a fill asks for up to 8 MB), so whoever opens the
    // stream first (the voice, or the loudness measurement), a later request crosses 1 MB.
    let sig = sweep(rate, rate as usize * 30, 60.0, 8_000.0, 0.5);
    let wavf = dir.join("long.wav");
    wav::write_f32(&wavf, rate, 2, &sig).unwrap();
    let bytes = std::fs::read(&wavf).unwrap();
    let srv = serve_with(bytes.clone(), "long.wav", Duration::ZERO, false, |a| (a >= 1024 * 1024).then_some(403));
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
        let ctx = OpenCtx { cache, cancel: Default::default(), accurate_seek: false, background: false };
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

/// Poll `load_progress(Current)` every 2 ms until `done` returns true for a report (or `timeout`),
/// returning every report seen.
fn poll_load(engine: &ghost_engine::Engine, timeout: Duration, done: impl Fn(&ghost_engine::LoadProgress) -> bool) -> Vec<ghost_engine::LoadProgress> {
    let t0 = std::time::Instant::now();
    let mut seen = Vec::new();
    loop {
        if let Some(p) = engine.load_progress(ghost_engine::Slot::Current) {
            let stop = done(&p);
            seen.push(p);
            if stop {
                return seen;
            }
        }
        assert!(t0.elapsed() < timeout, "load progress never got there: {:?}", seen.last());
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// `load_progress` while an HTTP track starts: the source's size once connected, bytes arriving,
/// decoded audio toward the 200 ms prefill, then started. A local file reads as fully present;
/// paused, it buffers past the prefill without starting.
#[test]
fn load_progress_follows_an_http_start_and_a_paused_file() {
    use ghost_engine::Slot;
    let dir = tmp_dir("loadprog");
    let rate = 44_100;
    let a = dir.join("a.wav");
    wav::write_f32(&a, rate, 2, &sweep(rate, rate as usize * 3, 200.0, 4000.0, 0.5)).unwrap();
    let data = std::fs::read(&a).unwrap();
    let len = data.len() as u64;
    // 16 KB per 40 ms (~400 KB/s, a bit over real time for this 353 KB/s WAV).
    let srv = serve(data, "a.wav", Duration::from_millis(40), false);
    let (engine, _sink) = offline(&dir, 48_000);
    assert_eq!(engine.load_progress(Slot::Current), None);
    engine.set_current(track("h", SourceSpec::http(srv.url.clone(), "loadprog-a")), 0, true);
    let seen = poll_load(&engine, Duration::from_secs(20), |p| p.started);
    assert!(seen.iter().all(|p| p.id == "h" && !p.whole_file && p.stall_timeout_ms == 8_000), "{seen:?}");
    let waiting: Vec<_> = seen.iter().filter(|p| !p.started && p.connected).collect();
    assert!(!waiting.is_empty(), "never saw it waiting: {seen:?}");
    assert!(waiting.iter().all(|p| p.total_bytes == Some(len) && p.bytes <= len && p.target_ms == 200), "{waiting:?}");
    assert!(waiting.iter().any(|p| p.buffered_ms > 0 && p.buffered_ms < 200), "no partial prefill: {waiting:?}");
    assert!(seen.windows(2).all(|w| w[0].bytes <= w[1].bytes), "bytes went backwards");
    let last = seen.last().unwrap();
    assert!(last.started && last.target_ms == 0 && last.bytes > 0, "{last:?}");
    assert_eq!(engine.load_progress(Slot::Preview), None);
    engine.stop();
    let t0 = std::time::Instant::now();
    while engine.load_progress(Slot::Current).is_some() {
        assert!(t0.elapsed() < Duration::from_secs(2), "stopped track still reported");
        std::thread::sleep(Duration::from_millis(5));
    }

    // A local file, paused: everything is present; the ring fills past the prefill, unstarted.
    let size = std::fs::metadata(&a).unwrap().len();
    engine.set_current(track("f", file(&a)), 0, false);
    let seen = poll_load(&engine, Duration::from_secs(10), |p| p.id == "f" && p.buffered_ms >= 1_000);
    let p = seen.last().unwrap();
    assert!(p.connected && p.bytes == size && p.total_bytes == Some(size) && !p.started && p.stalled_ms == 0, "{p:?}");
    engine.play();
    poll_load(&engine, Duration::from_secs(10), |p| p.started);
}

/// Stopping a track whose stream is still arriving leaves it fading out as a tail with a starved
/// ring and a cancelled worker. The offline sink must not wait for frames that will never come:
/// the next track still starts.
#[test]
fn offline_render_continues_after_stopping_a_starved_stream() {
    let dir = tmp_dir("stop-starved");
    let rate = 44_100;
    let a = dir.join("a.wav");
    wav::write_f32(&a, rate, 2, &sweep(rate, rate as usize * 4, 200.0, 4000.0, 0.5)).unwrap();
    // 16 KB per 150 ms (~110 KB/s, a third of real time): the decoder mostly waits on the network,
    // and the render drains whatever arrives at once.
    let srv = serve(std::fs::read(&a).unwrap(), "a.wav", Duration::from_millis(150), false);
    let (engine, _sink) = offline(&dir, 48_000);
    for round in 0..3 {
        engine.set_current(track(&format!("h{round}"), SourceSpec::http(srv.url.clone(), format!("stop-starved-{round}"))), 0, true);
        poll_load(&engine, Duration::from_secs(20), |p| p.started);
        std::thread::sleep(Duration::from_millis(60));
        engine.stop();
        engine.set_current(track(&format!("f{round}"), file(&a)), 0, true);
        poll_load(&engine, Duration::from_secs(5), |p| p.id == format!("f{round}") && p.started);
        engine.stop();
    }
}

/// Before the server answers, `load_progress` says so and runs the stall clock toward the
/// reader's timeout.
#[test]
fn load_progress_reports_a_source_that_does_not_answer() {
    let dir = tmp_dir("loadprog-stall");
    let srv = serve(vec![0u8; 1000], "hang.mp3", Duration::ZERO, true);
    let (engine, _sink) = offline(&dir, 48_000);
    engine.set_current(track("s", SourceSpec::http(srv.url.clone(), "loadprog-stall")), 0, true);
    std::thread::sleep(Duration::from_millis(1200));
    let p = engine.load_progress(ghost_engine::Slot::Current).expect("current track");
    println!("{p:?}");
    assert!(p.id == "s" && !p.started && !p.connected && p.bytes == 0 && p.total_bytes.is_none() && p.buffered_ms == 0, "{p:?}");
    assert!(p.stalled_ms >= 800 && p.stalled_ms < 4_000 && p.stall_timeout_ms == 8_000, "{p:?}");
}

/// What one `load_progress` / `cache_progress` call costs while a track loads (the player polls
/// them ~5×/s during waits). `cargo test --release --test engine load_progress_cost -- --ignored --nocapture`
#[test]
#[ignore]
fn load_progress_cost() {
    let dir = tmp_dir("loadprog-cost");
    let srv = serve(vec![0u8; 4 << 20], "slow.mp3", Duration::from_millis(50), false);
    let (engine, _sink) = offline(&dir, 48_000);
    engine.set_current(track("c", SourceSpec::http(srv.url.clone(), "loadprog-cost")), 0, true);
    poll_load(&engine, Duration::from_secs(10), |p| p.connected);
    let n = 200_000;
    let t0 = std::time::Instant::now();
    for _ in 0..n {
        std::hint::black_box(engine.load_progress(ghost_engine::Slot::Current));
    }
    let load = t0.elapsed() / n;
    let t0 = std::time::Instant::now();
    for _ in 0..n {
        std::hint::black_box(engine.cache_progress("loadprog-cost"));
    }
    let cache = t0.elapsed() / n;
    println!("load_progress: {load:?}/call, cache_progress: {cache:?}/call (fetcher and decoder running)");
}

/// Events (bounded wait) up to and including the first one `done` accepts; rendered audio is
/// drained meanwhile.
fn await_event(events: &crossbeam_channel::Receiver<EngineEvent>, sink: &ghost_engine::OfflineSink, done: impl Fn(&EngineEvent) -> bool) -> Vec<EngineEvent> {
    let t0 = Instant::now();
    let mut seen = Vec::new();
    loop {
        while sink.blocks.try_recv().is_ok() {}
        if let Ok(e) = events.recv_timeout(Duration::from_millis(10)) {
            let stop = done(&e);
            seen.push(e);
            if stop {
                return seen;
            }
        }
        assert!(t0.elapsed() < Duration::from_secs(20), "event never came: {seen:?}");
    }
}

fn is_state(e: &EngineEvent, want: PlaybackState) -> bool {
    matches!(e, EngineEvent::State { state, .. } if *state == want)
}

fn is_info(e: &EngineEvent, id: &str, duration_ms: Option<u64>) -> bool {
    matches!(e, EngineEvent::TrackInfo(i) if i.id == id && i.duration_ms == duration_ms)
}

/// `frames` of rendered audio, and the events meanwhile.
fn render_frames(events: &crossbeam_channel::Receiver<EngineEvent>, sink: &ghost_engine::OfflineSink, frames: usize) -> (Vec<f32>, Vec<EngineEvent>) {
    let t0 = Instant::now();
    let (mut out, mut seen) = (Vec::new(), Vec::new());
    while out.len() < frames * 2 {
        seen.extend(events.try_iter());
        if let Ok(b) = sink.blocks.recv_timeout(Duration::from_millis(20)) {
            out.extend_from_slice(&b);
        }
        assert!(t0.elapsed() < Duration::from_secs(30), "render timed out; events: {seen:?}");
    }
    seen.extend(events.try_iter());
    out.truncate(frames * 2);
    (out, seen)
}

/// Seeking a paused track: its new voice fills up and waits for playback to be requested, which
/// is not buffering. Resumed, it plays at once.
#[test]
fn seeking_while_paused_is_not_buffering() {
    let dir = tmp_dir("paused-seek");
    let rate = 48_000;
    let a = dir.join("a.wav");
    wav::write_f32(&a, rate, 2, &tone(rate, rate as usize * 10, 440.0, 0.3)).unwrap();
    let (engine, sink) = offline(&dir, rate);
    let events = engine.events();
    engine.set_current(track("p", file(&a)), 0, true);
    await_event(&events, &sink, |e| is_state(e, PlaybackState::Playing));
    engine.pause();
    await_event(&events, &sink, |e| is_state(e, PlaybackState::Paused));
    engine.seek(2_000);
    poll_load(&engine, Duration::from_secs(10), |p| !p.started && p.buffered_ms >= 1_000);
    // Long past the 250 ms after which a seek that plays nothing counts as buffering.
    let t0 = Instant::now();
    let mut seen = Vec::new();
    while t0.elapsed() < Duration::from_millis(750) {
        seen.extend(events.recv_timeout(Duration::from_millis(20)));
    }
    assert!(!seen.iter().any(|e| matches!(e, EngineEvent::Buffering { .. } | EngineEvent::State { .. })), "{seen:?}");
    engine.play();
    let seen = await_event(&events, &sink, |e| is_state(e, PlaybackState::Playing));
    assert!(!seen.iter().any(|e| matches!(e, EngineEvent::Buffering { .. })), "{seen:?}");
}

/// The paused current track stays known (id, length) however many previews come and go.
#[test]
fn current_track_outlives_many_previews() {
    let dir = tmp_dir("many-previews");
    let rate = 48_000;
    let (a, p) = (dir.join("a.wav"), dir.join("p.wav"));
    wav::write_f32(&a, rate, 2, &tone(rate, rate as usize * 30, 440.0, 0.3)).unwrap();
    wav::write_f32(&p, rate, 2, &tone(rate, rate as usize / 2, 660.0, 0.3)).unwrap();
    let (engine, sink) = offline(&dir, rate);
    let events = engine.events();
    engine.set_current(track("cur", file(&a)), 0, true);
    await_event(&events, &sink, |e| is_state(e, PlaybackState::Playing));
    engine.pause();
    await_event(&events, &sink, |e| is_state(e, PlaybackState::Paused));
    let before = engine.position();
    assert_eq!(before.id.as_deref(), Some("cur"), "{before:?}");
    for i in 0..70 {
        engine.preview(track(&format!("p{i}"), file(&p)), 0);
    }
    engine.stop_preview();
    await_event(&events, &sink, |e| matches!(e, EngineEvent::PreviewEnded { id } if id == "p69"));
    let after = engine.position();
    assert_eq!((after.id.as_deref(), after.duration_ms, after.playing), (Some("cur"), Some(30_000), false), "{after:?}");
    assert!(after.position_ms >= before.position_ms, "{before:?} {after:?}");
    engine.play();
    await_event(&events, &sink, |e| is_state(e, PlaybackState::Playing));
    assert_eq!(engine.position().id.as_deref(), Some("cur"));
}

/// Poll the live analysis (bounded) until a frame satisfies `want`.
fn analysis_where(engine: &ghost_engine::Engine, want: impl Fn(&ghost_engine::AnalysisFrame) -> bool) -> ghost_engine::AnalysisFrame {
    let t0 = Instant::now();
    let mut f = ghost_engine::AnalysisFrame::default();
    loop {
        if engine.analysis_frame(&mut f) && want(&f) {
            return f;
        }
        assert!(t0.elapsed() < Duration::from_secs(10), "no such analysis frame; last: rms {} seq {}", f.rms, f.track_seq);
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// A preview heard on its own, with nothing else loaded or with the queue paused under it,
/// drives the live analysis under its own identity; the queue's position stays where it was.
#[test]
fn preview_alone_drives_the_live_analysis() {
    let dir = tmp_dir("preview-frames");
    let rate = 48_000;
    let (a, p1, p2) = (dir.join("a.wav"), dir.join("p1.wav"), dir.join("p2.wav"));
    wav::write_f32(&a, rate, 2, &tone(rate, rate as usize * 30, 440.0, 0.3)).unwrap();
    wav::write_f32(&p1, rate, 2, &tone(rate, rate as usize * 3, 660.0, 0.3)).unwrap();
    wav::write_f32(&p2, rate, 2, &tone(rate, rate as usize * 3, 880.0, 0.3)).unwrap();

    let (engine, _sink) = offline(&dir, rate);
    engine.preview(track("p1", file(&p1)), 0);
    let cancel = std::sync::atomic::AtomicBool::new(false);
    assert!(engine.wait_analysis(Duration::from_secs(10), &cancel), "no live analysis for a preview alone");
    analysis_where(&engine, |f| f.rms > 0.01 && f.track_seq != 0);
    drop(engine);

    let (engine, sink) = offline(&dir, rate);
    let events = engine.events();
    engine.set_current(track("cur", file(&a)), 0, true);
    await_event(&events, &sink, |e| is_state(e, PlaybackState::Playing));
    let queue = analysis_where(&engine, |f| f.rms > 0.01 && f.track_seq != 0).track_seq;
    engine.pause();
    await_event(&events, &sink, |e| is_state(e, PlaybackState::Paused));
    engine.preview(track("p1", file(&p1)), 0);
    let first = analysis_where(&engine, |f| f.rms > 0.01 && ![0, queue].contains(&f.track_seq)).track_seq;
    let held = engine.position();
    assert_eq!((held.id.as_deref(), held.playing), (Some("cur"), false), "{held:?}");
    engine.preview(track("p2", file(&p2)), 0);
    analysis_where(&engine, |f| f.rms > 0.01 && ![0, queue, first].contains(&f.track_seq));
    let still = engine.position();
    assert_eq!((still.id, still.position_ms), (held.id, held.position_ms), "the queue's position moved");
}

/// Offline gapless where the first track is shorter than one output block: the render waits for
/// the next track (still arriving here) instead of padding that block with silence, at any block size.
#[test]
fn offline_gapless_with_a_first_track_shorter_than_a_block() {
    let dir = tmp_dir("short-first");
    let rate = 48_000;
    let sig = sweep(rate, 100 + rate as usize, 100.0, 4000.0, 0.5);
    let (a, b) = (dir.join("a.wav"), dir.join("b.wav"));
    wav::write_f32(&a, rate, 2, &sig[..100 * 2]).unwrap();
    wav::write_f32(&b, rate, 2, &sig[100 * 2..]).unwrap();
    // ~3 MB/s: the next track takes a while to reach its prefill.
    let srv = serve(std::fs::read(&b).unwrap(), "b.wav", Duration::from_millis(5), false);
    for block in [64, 512, 4096, 8192] {
        let (engine, sink) = ghost_engine::Engine::new_offline(config(&dir), ghost_engine::OfflineConfig { sample_rate: rate, block_frames: block }).unwrap();
        engine.set_normalization(false, -16.0, NormalizationMode::Auto);
        engine.set_current(track("a", file(&a)), 0, false);
        engine.set_next(Some(track("b", SourceSpec::http(srv.url.clone(), format!("short-first-{block}")))));
        engine.play();
        let (out, _) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
        assert_eq!(out.len(), sig.len(), "block {block}");
        assert_eq!(max_abs_diff(&out, &sig), 0.0, "block {block}");
    }
}

/// The synthetic looping VGM of the format tests: an intro, then a two-tone loop body.
fn looped_vgm(path: &std::path::Path, intro: u32, half_body: u32) {
    std::fs::write(path, ghost_formats::testdata::vgm_psg(&[(254, intro)], &[(127, half_body), (508, half_body)])).unwrap();
}

/// Album → Endless while the track is loaded: its length is reported gone, and it plays on past
/// the old end without crossfading into the queued track.
#[test]
fn switching_to_endless_drops_the_old_end() {
    let dir = tmp_dir("loop-endless");
    let rate = 44_100;
    let (vgm, next) = (dir.join("song.vgm"), dir.join("next.wav"));
    looped_vgm(&vgm, 44_100, 22_050);
    wav::write_f32(&next, rate, 2, &tone(rate, rate as usize * 3, 300.0, 0.3)).unwrap();
    let (engine, sink) = offline(&dir, rate);
    let events = engine.events();
    engine.set_crossfade(1.0);
    engine.set_current(track("v", file(&vgm)), 0, false);
    engine.set_next(Some(track("n", file(&next))));
    // Album: 1 s intro + 2 loops + 10 s fade.
    await_event(&events, &sink, |e| is_info(e, "v", Some(13_000)));
    engine.set_loop(ghost_engine::LoopMode::Endless, 2, 10.0);
    await_event(&events, &sink, |e| is_info(e, "v", None));
    engine.play();
    let (out, evs) = render_frames(&events, &sink, rate as usize * 16);
    assert!(!evs.iter().any(|e| matches!(e, EngineEvent::Advanced { .. } | EngineEvent::Ended { .. })), "{evs:?}");
    assert!(ghost_formats::testdata::rms(&out[out.len() - rate as usize * 2..]) > 0.05, "faded out");
    assert_eq!(engine.position().id.as_deref(), Some("v"));
}

/// Endless → Custom before playing: the reported length and where the crossfade into the next
/// track starts both follow the new plan.
#[test]
fn loop_changes_set_the_length_and_the_crossfade_point() {
    let dir = tmp_dir("loop-custom");
    let rate = 44_100;
    let (vgm, next) = (dir.join("song.vgm"), dir.join("next.wav"));
    looped_vgm(&vgm, 44_100, 22_050);
    wav::write_f32(&next, rate, 2, &tone(rate, rate as usize * 3, 300.0, 0.3)).unwrap();
    let (engine, sink) = offline(&dir, rate);
    let events = engine.events();
    engine.set_loop(ghost_engine::LoopMode::Endless, 2, 10.0);
    engine.set_crossfade(1.0);
    engine.set_current(track("v", file(&vgm)), 0, false);
    engine.set_next(Some(track("n", file(&next))));
    await_event(&events, &sink, |e| is_info(e, "v", None));
    engine.set_loop(ghost_engine::LoopMode::Custom, 3, 1.5);
    await_event(&events, &sink, |e| is_info(e, "v", Some(5_500)));
    engine.play();
    let (out, evs) = collect_until_ended(&engine, &sink, Duration::from_secs(30));
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::Advanced { id } if id == "n")), "{evs:?}");
    // 1 s intro + 3 loops + 1.5 s fade, then the 3 s track, overlapping by 1 s.
    assert_eq!(out.len() / 2, 330_750);
}

/// A short plan was decoded to its end (it is all in the ring) when Endless is chosen: the track
/// is taken up again where it is, and plays on.
#[test]
fn switching_to_endless_after_the_end_was_decoded_plays_on() {
    let dir = tmp_dir("loop-decoded");
    let rate = 44_100;
    let vgm = dir.join("short.vgm");
    // 0.5 s intro + one 0.5 s loop, no fade: 1 s, well inside the 2 s ring.
    looped_vgm(&vgm, 22_050, 11_025);
    let (engine, sink) = offline(&dir, rate);
    let events = engine.events();
    engine.set_loop(ghost_engine::LoopMode::Album, 1, 0.0);
    engine.set_current(track("v", file(&vgm)), 0, false);
    await_event(&events, &sink, |e| is_info(e, "v", Some(1_000)));
    poll_load(&engine, Duration::from_secs(10), |p| p.buffered_ms >= 1_000);
    engine.set_loop(ghost_engine::LoopMode::Endless, 1, 0.0);
    await_event(&events, &sink, |e| is_info(e, "v", None));
    engine.play();
    let (out, evs) = render_frames(&events, &sink, rate as usize * 4);
    assert!(!evs.iter().any(|e| matches!(e, EngineEvent::Ended { .. })), "{evs:?}");
    assert!(ghost_formats::testdata::rms(&out[out.len() - rate as usize..]) > 0.05, "silent after the old end");
}

/// Renders that end at the same file name: concurrent jobs (different source extensions, the same
/// FLAC name), a FLAC already there, and a destination that is already `.flac`. Each job gets a
/// file of its own, reported in its `Done`, and the existing file is left alone.
#[test]
fn concurrent_renders_never_share_or_replace_a_file() {
    use lofty::prelude::*;
    let dir = tmp_dir("dl-collide");
    let rate = 44_100;
    let src = dir.join("src.wav");
    wav::write_f32(&src, rate, 2, &tone(rate, rate as usize * 3, 440.0, 0.3)).unwrap();
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    let existing = out.join("Song.flac");
    std::fs::write(&existing, b"someone else's").unwrap();
    let (engine, _sink) = offline(&dir, 48_000);
    let events = engine.events();
    let jobs = [("a", "Song.wav", 0, 900), ("b", "Song.mp3", 1_000, 1_500), ("c", "Song.flac", 2_000, 2_300)];
    for (id, name, from, to) in jobs {
        let clip = SourceExtras { clip_start_ms: Some(from), clip_end_ms: Some(to), ..Default::default() };
        engine.download(id.into(), file(&src).with_extras(clip), out.join(name), TagInfo::default());
    }
    let mut done = std::collections::HashMap::new();
    let t0 = Instant::now();
    while done.len() < jobs.len() {
        assert!(t0.elapsed() < Duration::from_secs(30), "downloads unfinished: {done:?}");
        if let Ok(EngineEvent::Download { download_id, status, path, error, .. }) = events.recv_timeout(Duration::from_millis(50)) {
            if status != DownloadStatus::Progress {
                assert_eq!(status, DownloadStatus::Done, "{download_id}: {error:?}");
                done.insert(download_id, path.expect("Done without a path"));
            }
        }
    }
    assert_eq!(std::fs::read(&existing).unwrap(), b"someone else's", "an existing file was replaced");
    let mut paths: Vec<_> = done.values().cloned().collect();
    paths.sort();
    paths.dedup();
    assert_eq!(paths.len(), jobs.len(), "two jobs reported the same file: {done:?}");
    for (id, _, from, to) in jobs {
        let p = &done[id];
        assert!(p != &existing && p.parent() == Some(out.as_path()) && p.extension().is_some_and(|e| e == "flac"), "{id}: {p:?}");
        let ms = lofty::read_from_path(p).unwrap().properties().duration().as_millis() as u64;
        assert_eq!(ms, to - from, "{id}: {p:?} holds another render");
    }
}
