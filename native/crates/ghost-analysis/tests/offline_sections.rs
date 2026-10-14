//! Loudness (EBU R128 reference values), kiai sections, energy curve, intensity sanity and
//! analysis speed.

mod common;

use std::f32::consts::{FRAC_PI_2, FRAC_PI_4, TAU};
use std::time::Instant;

use common::*;
use ghost_analysis::offline::{analyze, loudness, loudness_full};
use ghost_analysis::ENERGY_POINTS;

fn sine_stereo(freq: f32, dbfs: f32, dur: f32, phase: f32) -> Vec<f32> {
    let a = 10f32.powf(dbfs / 20.0);
    (0..secs(dur))
        .flat_map(|i| {
            let x = a * (TAU * freq * i as f32 / SR as f32 + phase).sin();
            [x, x]
        })
        .collect()
}

#[test]
fn ebu_r128_reference_sine() {
    // EBU Tech 3341 case 1: 1 kHz stereo sine at -23 dBFS reads -23.0 LUFS (±0.1).
    let s = sine_stereo(997.0, -23.0, 20.0, 0.0);
    let l = loudness_full(&s, 2, SR);
    let i = l.integrated_lufs.unwrap();
    println!("-23 dBFS stereo sine: {i:.2} LUFS, LRA {:?}, TP {:?}", l.loudness_range, l.true_peak_db);
    assert!((i + 23.0).abs() <= 0.1, "integrated {i}");
    assert!(l.loudness_range.unwrap() < 0.5);
    assert!((l.true_peak_db.unwrap() + 23.0).abs() < 0.3);
    // Fast path agrees: (integrated LUFS, true peak dBTP).
    let (fi, ftp) = loudness(&s, 2, SR);
    assert!((fi.unwrap() - i).abs() < 0.01);
    assert!((ftp.unwrap() - l.true_peak_db.unwrap()).abs() < 0.01);

    // Same sine at -20 dBFS in a single (mono) channel: one channel's worth of power, -23 LUFS.
    let a = 10f32.powf(-20.0 / 20.0);
    let mono: Vec<f32> = (0..secs(20.0)).map(|i| a * (TAU * 997.0 * i as f32 / SR as f32).sin()).collect();
    let (mi, _) = loudness(&mono, 1, SR);
    assert!((mi.unwrap() + 23.01).abs() <= 0.1, "mono {:?}", mi);

    // Level steps are tracked exactly.
    let s = sine_stereo(997.0, -10.0, 20.0, 0.0);
    let (li, _) = loudness(&s, 2, SR);
    assert!((li.unwrap() + 10.0).abs() <= 0.1, "{:?}", li);
}

#[test]
fn true_peak_sees_inter_sample_peaks() {
    // fs/4 sine at 45° phase: every sample sits at 0.707 of the waveform peak (-3 dB), so a
    // sample-peak meter under-reads by 3 dB; a true-peak meter must not.
    let a = 10f32.powf(-6.0 / 20.0);
    let s: Vec<f32> = (0..secs(5.0))
        .flat_map(|i| {
            let x = a * ((i % 4) as f32 * FRAC_PI_2 + FRAC_PI_4).sin();
            [x, x]
        })
        .collect();
    let sample_peak = s.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    let (_, tp) = loudness(&s, 2, SR);
    let tp = tp.unwrap();
    println!("sample peak {:.2} dBFS, true peak {tp:.2} dBTP", 20.0 * sample_peak.log10());
    assert!((20.0 * sample_peak.log10() + 9.03).abs() < 0.1);
    assert!((tp + 6.0).abs() < 0.5, "true peak {tp}");
}

#[test]
fn loudness_of_silence_and_short_input() {
    assert_eq!(loudness(&vec![0.0; 88_200], 2, SR), (None, None));
    assert_eq!(loudness(&[], 2, SR), (None, None));
    assert_eq!(loudness(&[0.5; 10], 0, SR), (None, None));
}

/// Quiet verse (soft half-time kicks, hats, pad), loud dense chorus, quiet verse.
fn quiet_loud_quiet(gain: f32) -> Vec<f32> {
    let dur = 70.0;
    let mut buf = vec![0.0f32; secs(dur)];
    let mut rng = Rng::new(21);
    let bpm = 120.0;
    for (i, &t) in beat_times(bpm, 0.5, dur).iter().enumerate() {
        let loud = (20.0..50.0).contains(&t);
        if loud {
            add_kick(&mut buf, t, 0.7, &mut rng);
            if i % 2 == 1 {
                add_snare(&mut buf, t, 0.45, &mut rng);
            }
            for k in 0..4 {
                add_hat(&mut buf, t + k as f32 * 15.0 / bpm, 0.3, &mut rng);
            }
        } else {
            if i % 2 == 0 {
                add_kick(&mut buf, t, 0.25, &mut rng);
            }
            add_hat(&mut buf, t, 0.1, &mut rng);
        }
    }
    add_tone(&mut buf, 0.0, 20.0, 220.0, 0.06);
    add_tone(&mut buf, 20.0, 30.0, 110.0, 0.25);
    add_tone(&mut buf, 50.0, 20.0, 220.0, 0.06);
    scale(&mut buf, gain);
    to_stereo(&buf)
}

#[test]
fn kiai_detects_the_loud_middle() {
    let a = analyze(&quiet_loud_quiet(1.0), 2, SR);
    println!("kiai {:?}, lufs {:?}, lra {:?}, {:?}★", a.kiai, a.integrated_lufs, a.loudness_range, a.intensity);
    assert_eq!(a.kiai.len(), 1, "{:?}", a.kiai);
    let (s, e) = a.kiai[0];
    assert!((s - 20.0).abs() <= 2.0 && (e - 50.0).abs() <= 2.0, "kiai {s}..{e}");

    // The energy curve shows the same shape.
    assert_eq!(a.energy.len(), ENERGY_POINTS);
    let at = |t: f32| a.energy[((t / 70.0) * ENERGY_POINTS as f32) as usize];
    assert!(a.energy.iter().all(|e| (0.0..=1.0).contains(e)));
    assert!((a.energy.iter().copied().fold(0.0, f32::max) - 1.0).abs() < 1e-6);
    assert!(at(35.0) > 0.85 && at(10.0) < 0.6 && at(60.0) < 0.6, "{} {} {}", at(10.0), at(35.0), at(60.0));
}

#[test]
fn no_kiai_for_flat_or_quiet_tracks() {
    // Flat: the loud pattern throughout.
    let dur = 60.0;
    let mut buf = vec![0.0f32; secs(dur)];
    let mut rng = Rng::new(4);
    for (i, &t) in beat_times(128.0, 0.5, dur).iter().enumerate() {
        add_kick(&mut buf, t, 0.7, &mut rng);
        if i % 2 == 1 {
            add_snare(&mut buf, t, 0.45, &mut rng);
        }
        add_hat(&mut buf, t + 60.0 / 256.0, 0.3, &mut rng);
    }
    let a = analyze(&to_stereo(&buf), 2, SR);
    assert!(a.kiai.is_empty(), "flat: {:?}", a.kiai);

    // Quiet: same contrast as the kiai test but 40 dB down (around -50 LUFS in the "loud" part).
    let a = analyze(&quiet_loud_quiet(0.01), 2, SR);
    assert!(a.kiai.is_empty(), "quiet: {:?} ({:?} LUFS)", a.kiai, a.integrated_lufs);
}

#[test]
fn intensity_orders_calm_below_intense() {
    // Calm: slow sustained tones, no drums.
    let dur = 60.0;
    let mut calm = vec![0.0f32; secs(dur)];
    for k in 0..12 {
        let f = [220.0, 261.6, 329.6, 293.7][k % 4];
        add_tone(&mut calm, k as f32 * 5.0, 5.5, f, 0.08);
        add_tone(&mut calm, k as f32 * 5.0, 5.5, f * 1.5, 0.05);
    }
    // Intense: 174 BPM kick/snare/sixteenth hats plus a loud bass.
    let mut hot = vec![0.0f32; secs(dur)];
    let mut rng = Rng::new(8);
    for (i, &t) in beat_times(174.0, 0.2, dur).iter().enumerate() {
        add_kick(&mut hot, t, 0.8, &mut rng);
        if i % 2 == 1 {
            add_snare(&mut hot, t, 0.6, &mut rng);
        }
        for k in 0..4 {
            add_hat(&mut hot, t + k as f32 * 15.0 / 174.0, 0.35, &mut rng);
        }
    }
    add_tone(&mut hot, 0.0, dur, 55.0, 0.3);
    let c = analyze(&to_stereo(&calm), 2, SR).intensity.unwrap();
    let h = analyze(&to_stereo(&hot), 2, SR).intensity.unwrap();
    println!("calm {c:.2}★, intense {h:.2}★");
    assert!(c < 2.5, "calm {c}");
    assert!(h > 5.5, "intense {h}");
    assert!((0.0..=10.0).contains(&c) && (0.0..=10.0).contains(&h));
}

#[test]
#[cfg_attr(debug_assertions, ignore = "timing is only meaningful in release builds")]
fn four_minute_track_analyses_in_under_1_5_s() {
    // 4 minutes, 44.1 kHz stereo, with drums, bass and chords so every stage does real work.
    let dur = 240.0;
    let mut buf = vec![0.0f32; secs(dur)];
    let mut rng = Rng::new(99);
    for (i, &t) in beat_times(140.0, 0.3, dur).iter().enumerate() {
        add_kick(&mut buf, t, 0.6, &mut rng);
        if i % 2 == 1 {
            add_snare(&mut buf, t, 0.4, &mut rng);
        }
        add_hat(&mut buf, t + 60.0 / 280.0, 0.2, &mut rng);
    }
    for k in 0..(dur / 2.0) as usize {
        add_tone(&mut buf, k as f32 * 2.0, 2.0, [110.0, 146.8, 130.8, 164.8][k % 4], 0.15);
    }
    let stereo = to_stereo(&buf);
    let _ = analyze(&stereo[..secs(5.0) * 2], 2, SR); // warm up the thread pool
    let t = Instant::now();
    let a = analyze(&stereo, 2, SR);
    let el = t.elapsed().as_secs_f64();
    println!("4-minute analysis: {:.0} ms (bpm {:?}, {} beats)", el * 1e3, a.bpm, a.beats.len());
    assert!(el < 1.5, "took {el:.2} s");
    assert!((a.bpm.unwrap() - 140.0).abs() <= 1.0);
}
