//! Tempo, beat-grid and confidence tests on synthetic drum tracks.

mod common;

use common::*;
use ghost_analysis::offline::analyze;

fn check_click_track(bpm: f32) {
    let (mono, truth) = kick_track(bpm, 60.0, 0.5);
    let a = analyze(&to_stereo(&mono), 2, SR);
    let got = a.bpm.unwrap_or_else(|| panic!("{bpm} BPM: no tempo (confidence {})", a.bpm_confidence));
    let (frac, max_err, mean_err) = match_beats(&truth, &a.beats, 0.020, 1.0);
    println!(
        "{bpm} BPM: got {got:.2}, conf {:.2}, {} beats (truth {}), within 20 ms {:.0}%, max err {:.1} ms, mean {:+.1} ms",
        a.bpm_confidence,
        a.beats.len(),
        truth.len(),
        frac * 100.0,
        max_err * 1e3,
        mean_err * 1e3
    );
    assert!((got - bpm).abs() <= 1.0, "{bpm} BPM: estimated {got}");
    assert!(a.bpm_confidence >= 0.6, "{bpm} BPM: confidence {}", a.bpm_confidence);
    assert!(frac >= 0.98, "{bpm} BPM: only {:.0}% of beats within 20 ms", frac * 100.0);
    assert!(max_err <= 0.020, "{bpm} BPM: max beat error {:.1} ms", max_err * 1e3);
    // No doubled or halved grid.
    let ratio = a.beats.len() as f32 / truth.len() as f32;
    assert!((0.95..=1.05).contains(&ratio), "{bpm} BPM: {} beats for {} true", a.beats.len(), truth.len());
    // Downbeats: every 4th beat.
    assert!((a.downbeats.len() as i32 - a.beats.len() as i32 / 4).abs() <= 1);
}

#[test]
fn click_track_90_bpm() {
    check_click_track(90.0);
}

#[test]
fn click_track_128_bpm() {
    check_click_track(128.0);
}

#[test]
fn click_track_174_bpm() {
    // Octave trap #1: a pure pulse at 174 is just as periodic at 87 BPM, and the tempo prior
    // (centred on 120) slightly favours 87. Its off-beats are as strong as its beats, so the
    // octave check must settle on 174.
    check_click_track(174.0);
}

#[test]
fn octave_trap_eighth_note_hats_stay_at_90() {
    // Octave trap #2: kick + snare backbeat at 90 BPM with quieter hats on every eighth note.
    // The hats make 180 BPM strongly periodic too; the beat is still 90.
    let bpm = 90.0;
    let dur = 60.0;
    let mut buf = vec![0.0f32; secs(dur)];
    let mut rng = Rng::new(3);
    let truth = beat_times(bpm, 0.5, dur);
    for (i, &t) in truth.iter().enumerate() {
        if i % 2 == 0 {
            add_kick(&mut buf, t, 0.7, &mut rng);
        } else {
            add_snare(&mut buf, t, 0.5, &mut rng);
        }
        add_hat(&mut buf, t, 0.25, &mut rng);
        add_hat(&mut buf, t + 30.0 / bpm, 0.18, &mut rng);
    }
    let a = analyze(&to_stereo(&buf), 2, SR);
    let got = a.bpm.expect("tempo");
    println!("eighth-note hats at 90: got {got:.2} (conf {:.2})", a.bpm_confidence);
    assert!((got - bpm).abs() <= 1.0, "estimated {got}");
    let (frac, _, _) = match_beats(&truth, &a.beats, 0.020, 1.0);
    assert!(frac >= 0.95, "beats within 20 ms: {:.0}%", frac * 100.0);
}

#[test]
fn octave_trap_backbeat_at_120_not_60() {
    // Kick on 1 and 3, snare on 2 and 4: the bar-level pattern repeats at 60 BPM per half bar,
    // but the beat is 120.
    let bpm = 120.0;
    let dur = 45.0;
    let mut buf = vec![0.0f32; secs(dur)];
    let mut rng = Rng::new(11);
    let truth = beat_times(bpm, 1.0, dur);
    for (i, &t) in truth.iter().enumerate() {
        if i % 2 == 0 {
            add_kick(&mut buf, t, 0.8, &mut rng);
        } else {
            add_snare(&mut buf, t, 0.45, &mut rng);
        }
    }
    let a = analyze(&to_stereo(&buf), 2, SR);
    let got = a.bpm.expect("tempo");
    println!("backbeat at 120: got {got:.2} (conf {:.2})", a.bpm_confidence);
    assert!((got - bpm).abs() <= 1.0, "estimated {got}");
}

#[test]
fn tempo_holds_at_48k_and_mono() {
    // Same 128 BPM track resampled by construction at 48 kHz (re-synthesised), mono input.
    let sr = 48_000u32;
    let bpm = 128.0;
    let dur = 40.0;
    let n = (dur * sr as f32) as usize;
    let mut buf = vec![0.0f32; n];
    let p = 60.0 / bpm;
    let mut k = 0;
    while (0.5 + k as f32 * p) < dur - 0.5 {
        let i0 = ((0.5 + k as f32 * p) * sr as f32) as usize;
        for i in 0..(0.2 * sr as f32) as usize {
            if i0 + i >= n {
                break;
            }
            let t = i as f32 / sr as f32;
            buf[i0 + i] += 0.7 * (-t / 0.08).exp() * (std::f32::consts::TAU * 60.0 * t).sin();
        }
        k += 1;
    }
    let a = analyze(&buf, 1, sr);
    let got = a.bpm.expect("tempo");
    assert!((got - bpm).abs() <= 1.0, "estimated {got}");
}

#[test]
fn white_noise_has_low_confidence_and_no_beats() {
    let mut rng = Rng::new(42);
    let mono: Vec<f32> = (0..secs(40.0)).map(|_| 0.1 * rng.next()).collect();
    let a = analyze(&to_stereo(&mono), 2, SR);
    println!("noise: bpm {:?} conf {:.2} beats {}", a.bpm, a.bpm_confidence, a.beats.len());
    assert!(a.bpm_confidence < 0.3, "confidence {}", a.bpm_confidence);
    assert!(a.beats.is_empty());
    assert!(a.downbeats.is_empty());
    assert!(a.bpm.is_none());
}

#[test]
fn slowly_swelling_noise_has_no_beats() {
    // Ambient-like: noise with slow, irregular amplitude swells and no pulse.
    let mut rng = Rng::new(9);
    let n = secs(60.0);
    let mono: Vec<f32> = (0..n)
        .map(|i| {
            let t = i as f32 / SR as f32;
            let env = 0.5 + 0.3 * (t * 0.37).sin() + 0.2 * (t * 0.113 + 1.0).sin();
            0.1 * env * rng.next()
        })
        .collect();
    let a = analyze(&to_stereo(&mono), 2, SR);
    println!("swells: bpm {:?} conf {:.2}", a.bpm, a.bpm_confidence);
    assert!(a.beats.is_empty(), "conf {}", a.bpm_confidence);
}

#[test]
fn silence_gives_empty_analysis() {
    let mono = vec![0.0f32; secs(10.0)];
    let a = analyze(&to_stereo(&mono), 2, SR);
    assert_eq!(a.duration_ms, 10_000);
    assert!(a.beats.is_empty() && a.downbeats.is_empty() && a.kiai.is_empty());
    assert_eq!(a.bpm, None);
    assert_eq!(a.bpm_confidence, 0.0);
    assert_eq!(a.integrated_lufs, None);
    assert_eq!(a.true_peak_db, None);
    assert_eq!(a.intensity, None);
    assert_eq!(a.energy.len(), ghost_analysis::ENERGY_POINTS);
    assert!(a.energy.iter().all(|&e| e == 0.0));
}

#[test]
fn degenerate_inputs_do_not_panic() {
    assert_eq!(analyze(&[], 2, SR).duration_ms, 0);
    assert_eq!(analyze(&[0.1, 0.2, 0.3], 0, SR).duration_ms, 0);
    let short = vec![0.3f32; 1000];
    let a = analyze(&short, 2, SR);
    assert_eq!(a.energy.len(), ghost_analysis::ENERGY_POINTS);
    let nan = vec![f32::NAN; secs(2.0) * 2];
    let a = analyze(&nan, 2, SR);
    assert!(a.energy.iter().all(|e| e.is_finite()));
}

#[test]
fn unusual_sample_rates_do_not_panic() {
    // Below ~5.6 kHz the 2.5–12 kHz brightness band is empty; that used to panic (bad slice).
    for rate in [1_000u32, 4_000, 5_000, 5_512, 8_000, 11_025, 192_000, 384_000] {
        let x: Vec<f32> = (0..rate as usize * 8).map(|i| 0.3 * (i as f32 * 0.07).sin() * if i % 4000 < 400 { 1.0 } else { 0.3 }).collect();
        let a = analyze(&to_stereo(&x), 2, rate);
        assert_eq!(a.energy.len(), ghost_analysis::ENERGY_POINTS, "{rate} Hz");
        // (Below ~3.4 kHz the BS.1770 shelf filter is above Nyquist: no loudness, as in ebur128.)
        assert!(rate < 4_000 || a.integrated_lufs.is_some(), "{rate} Hz");
    }
}

#[test]
fn non_finite_samples_do_not_erase_loudness() {
    // One bad sample used to poison the loudness filters: no LUFS, LRA, energy curve or
    // intensity for the rest of the track (and one inf removed the true peak).
    let (mono, _) = kick_track(128.0, 30.0, 0.5);
    let clean = analyze(&to_stereo(&mono), 2, SR);
    let mut dirty = to_stereo(&mono);
    dirty[1001] = f32::NAN;
    dirty[50_000] = f32::INFINITY;
    dirty[90_001] = f32::NEG_INFINITY;
    let a = analyze(&dirty, 2, SR);
    let (lc, la) = (clean.integrated_lufs.unwrap(), a.integrated_lufs.expect("integrated loudness"));
    assert!((lc - la).abs() < 0.05, "{lc} vs {la}");
    assert!(a.loudness_range.is_some() && a.true_peak_db.is_some() && a.intensity.is_some());
    let diff = a.energy.iter().zip(&clean.energy).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
    assert!(diff < 0.05, "energy curve differs by {diff}");
    assert!((a.bpm.unwrap() - clean.bpm.unwrap()).abs() < 0.01);
}

#[test]
fn downbeat_phase_follows_the_accent() {
    // 120 BPM, accented kick every 4th beat starting at beat 2 (0-based), soft hats otherwise.
    let bpm = 120.0;
    let dur = 40.0;
    let mut buf = vec![0.0f32; secs(dur)];
    let mut rng = Rng::new(5);
    let truth = beat_times(bpm, 0.5, dur);
    for (i, &t) in truth.iter().enumerate() {
        if i % 4 == 2 {
            add_kick(&mut buf, t, 0.9, &mut rng);
        }
        add_hat(&mut buf, t, 0.3, &mut rng);
        add_snare(&mut buf, t, 0.08, &mut rng);
    }
    let a = analyze(&to_stereo(&buf), 2, SR);
    assert!(!a.downbeats.is_empty(), "conf {}", a.bpm_confidence);
    let accents: Vec<f32> = truth.iter().skip(2).step_by(4).copied().collect();
    let (frac, _, _) = match_beats(&accents, &a.downbeats, 0.03, 1.0);
    assert!(frac >= 0.9, "downbeats on accents: {:.0}%", frac * 100.0);
}
