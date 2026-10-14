//! Real-time analyzer behaviour: band mapping, smoothing, onset, waveform trigger, reset.

mod common;

use std::f32::consts::TAU;

use common::*;
use ghost_analysis::realtime::RealtimeAnalyzer;
use ghost_analysis::{AnalysisFrame, NUM_BANDS, WAVEFORM_LEN};

const FPS: f32 = 120.0;

/// Feed `mono` (as stereo) at 120 fps, calling `f` with each frame.
fn run(sr: u32, mono: &[f32], f: impl FnMut(usize, &AnalysisFrame)) {
    run_at(sr, mono, FPS, f)
}

/// Feed `mono` (as stereo) in hops of `1/fps` seconds.
fn run_at(sr: u32, mono: &[f32], fps: f32, mut f: impl FnMut(usize, &AnalysisFrame)) {
    let mut rt = RealtimeAnalyzer::new(sr);
    let mut frame = AnalysisFrame::default();
    let hop = (sr as f32 / fps) as usize;
    let stereo: Vec<f32> = mono.iter().flat_map(|&x| [x, x]).collect();
    for (i, chunk) in stereo.chunks(hop * 2).enumerate() {
        rt.push_interleaved(chunk, 2);
        rt.compute(1.0 / fps, &mut frame);
        f(i, &frame);
    }
}

fn argmax(b: &[f32]) -> usize {
    b.iter().enumerate().max_by(|x, y| x.1.total_cmp(y.1)).map(|x| x.0).unwrap()
}

#[test]
fn sine_sweep_peak_moves_monotonically_across_bands() {
    for sr in [44_100u32, 48_000] {
        // Exponential sweep 35 Hz → 15 kHz over 12 s at -12 dBFS.
        let dur = 12.0;
        let n = (dur * sr as f32) as usize;
        let (f0, f1) = (35.0f64, 15_000.0f64);
        let k = (f1 / f0).ln() / dur as f64;
        let mono: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 / sr as f64;
                let phase = std::f64::consts::TAU * f0 * ((k * t).exp() - 1.0) / k;
                (0.25 * phase.sin()) as f32
            })
            .collect();
        let mut peaks = Vec::new();
        run(sr, &mono, |i, fr| {
            if i as f32 > 0.15 * FPS {
                peaks.push(argmax(&fr.bands));
            }
        });
        let back_steps = peaks.windows(2).filter(|w| w[1] < w[0]).count();
        println!("{sr} Hz: peak band {} → {}, backward steps {back_steps}", peaks[0], peaks.last().unwrap());
        assert_eq!(back_steps, 0, "peak band moved backwards ({sr} Hz)");
        assert!(peaks[0] <= 6, "starts at band {}", peaks[0]);
        assert!(*peaks.last().unwrap() >= NUM_BANDS - 6, "ends at band {}", peaks.last().unwrap());
        // Every band gets visited (no gaps from sub-bin low bands or the FFT crossover).
        let mut seen = [false; NUM_BANDS];
        for &p in &peaks {
            seen[p] = true;
        }
        let first = peaks[0];
        let last = *peaks.last().unwrap();
        let missing: Vec<usize> = (first..=last).filter(|&b| !seen[b]).collect();
        assert!(missing.len() <= 2, "bands that never peaked: {missing:?}");
    }
}

#[test]
fn low_bands_are_smooth_not_steppy() {
    // A 40 Hz tone lights the lowest bands with a single smooth hump: neighbouring band values
    // differ gradually even though several bands share one FFT bin.
    let sr = 48_000;
    let mono: Vec<f32> = (0..sr as usize).map(|i| 0.3 * (TAU * 40.0 * i as f32 / sr as f32).sin()).collect();
    let mut last = AnalysisFrame::default();
    run(sr, &mono, |_, fr| last = fr.clone());
    let b = &last.bands[..30];
    let max_jump = b.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
    assert!(b.iter().all(|&v| v > 0.0), "empty low band: {b:?}");
    assert!(max_jump < 0.12, "steppy low bands (max jump {max_jump}): {b:?}");
}

#[test]
fn smoothing_has_fast_attack_and_slow_release() {
    let sr = 48_000;
    // 0.5 s silence, 0.5 s 1 kHz tone, 0.5 s silence.
    let mono: Vec<f32> = (0..(1.5 * sr as f32) as usize)
        .map(|i| {
            let t = i as f32 / sr as f32;
            if (0.5..1.0).contains(&t) {
                0.3 * (TAU * 1000.0 * t).sin()
            } else {
                0.0
            }
        })
        .collect();
    let mut series = Vec::new();
    run(sr, &mono, |_, fr| series.push(fr.bands.iter().copied().fold(0.0, f32::max)));
    let at = |t: f32| series[(t * FPS) as usize];
    let full = at(0.95);
    assert!(full > 0.5, "steady level {full}");
    // Attack: within ~40 ms of onset (window fill + 15 ms attack) we're near full height.
    assert!(at(0.55) > 0.85 * full, "attack too slow: {} vs {full}", at(0.55));
    // Release: 100 ms after the tone stops, still clearly visible; after 1/2 s mostly gone.
    assert!(at(1.1) > 0.4 * full, "release too fast: {}", at(1.1));
    assert!(at(1.45) < 0.25 * full, "release too slow: {}", at(1.45));
}

#[test]
fn onset_spikes_on_hits_at_any_loudness() {
    // At display rate (120 Hz) and at the engine's fixed 5 ms analysis hop (200 Hz).
    for fps in [120.0f32, 200.0] {
        for gain_db in [0.0f32, -40.0] {
            let g = 10f32.powf(gain_db / 20.0);
            let dur = 10.0;
            let mut buf = vec![0.0f32; secs(dur)];
            let mut rng = Rng::new(1);
            let hits = beat_times(120.0, 1.0, dur);
            for &t in &hits {
                add_kick(&mut buf, t, 0.7 * g, &mut rng);
                add_hat(&mut buf, t + 0.25, 0.1 * g, &mut rng);
            }
            add_tone(&mut buf, 0.0, dur, 330.0, 0.05 * g); // a sustained pad underneath
            let mut onset = Vec::new();
            run_at(SR, &buf, fps, |_, fr| onset.push(fr.onset));
            let mut on_hit = Vec::new();
            let mut between = Vec::new();
            for &t in hits.iter().filter(|&&t| t > 2.0) {
                let i = (t * fps) as usize;
                on_hit.push(onset[i..i + (0.05 * fps) as usize].iter().copied().fold(0.0, f32::max));
                let j = ((t + 0.12) * fps) as usize;
                between.push(onset[j..j + (0.08 * fps) as usize].iter().copied().fold(0.0, f32::max));
            }
            let min_hit = on_hit.iter().copied().fold(1.0, f32::min);
            let max_between = between.iter().copied().fold(0.0, f32::max);
            println!("{fps} fps, {gain_db} dB: min onset on hits {min_hit:.2}, max between {max_between:.2}");
            assert!(min_hit > 0.6, "{fps} fps {gain_db} dB: weak onset on hits ({min_hit})");
            assert!(max_between < 0.25, "{fps} fps {gain_db} dB: onset between hits ({max_between})");
            assert!(onset.iter().all(|&o| (0.0..=1.0).contains(&o)));
        }
    }
}

#[test]
fn silence_reads_zero() {
    let mono = vec![0.0f32; SR as usize];
    let mut last = AnalysisFrame::default();
    run(SR, &mono, |_, fr| last = fr.clone());
    assert!(last.bands.iter().all(|&b| b == 0.0));
    assert_eq!(last.onset, 0.0);
    assert_eq!(last.rms, 0.0);
    assert_eq!(last.peak, 0.0);
}

#[test]
fn rms_and_peak() {
    let a = 0.5;
    let mono: Vec<f32> = (0..SR as usize).map(|i| a * (TAU * 441.0 * i as f32 / SR as f32).sin()).collect();
    let mut last = AnalysisFrame::default();
    run(SR, &mono, |_, fr| last = fr.clone());
    assert!((last.rms - a / 2f32.sqrt()).abs() < 0.01, "rms {}", last.rms);
    assert!((last.peak - a).abs() < 0.01, "peak {}", last.peak);
}

#[test]
fn waveform_is_triggered_on_a_rising_zero_crossing_and_stable() {
    // A two-partial wave whose period doesn't divide the frame hop: untriggered, consecutive
    // frames would be drawn at different phases.
    let f = 173.0;
    let mono: Vec<f32> = (0..SR as usize)
        .map(|i| {
            let t = i as f32 / SR as f32;
            0.5 * (TAU * f * t).sin() + 0.2 * (TAU * 2.0 * f * t + 0.7).sin()
        })
        .collect();
    let mut frames: Vec<[f32; WAVEFORM_LEN]> = Vec::new();
    run(SR, &mono, |i, fr| {
        if i > 20 {
            frames.push(fr.waveform);
        }
    });
    for w in &frames {
        assert!(w[0] >= 0.0 && w[0] < 0.1 && w[1] > w[0], "not at a rising zero crossing: {} {}", w[0], w[1]);
    }
    for pair in frames.windows(2) {
        let dot: f32 = pair[0].iter().zip(&pair[1]).map(|(a, b)| a * b).sum();
        let e0: f32 = pair[0].iter().map(|a| a * a).sum();
        let e1: f32 = pair[1].iter().map(|a| a * a).sum();
        let corr = dot / (e0 * e1).sqrt();
        assert!(corr > 0.98, "jittery waveform: correlation {corr}");
    }
}

#[test]
fn reset_clears_state() {
    let mut rt = RealtimeAnalyzer::new(SR);
    let mut frame = AnalysisFrame::default();
    let tone: Vec<f32> = (0..SR as usize).map(|i| 0.5 * (TAU * 440.0 * i as f32 / SR as f32).sin()).collect();
    rt.push_interleaved(&tone, 1);
    rt.compute(0.1, &mut frame);
    assert!(frame.bands.iter().any(|&b| b > 0.3));
    rt.reset();
    rt.compute(1.0 / FPS, &mut frame);
    assert!(frame.bands.iter().all(|&b| b == 0.0));
    assert!(frame.waveform.iter().all(|&x| x == 0.0));
    assert_eq!(frame.onset, 0.0);
    assert_eq!(frame.rms, 0.0);
}

#[test]
fn odd_inputs_are_safe() {
    let mut rt = RealtimeAnalyzer::new(SR);
    let mut frame = AnalysisFrame::default();
    rt.push_interleaved(&[f32::NAN, f32::INFINITY, 0.5, -0.5], 2);
    rt.push_interleaved(&[0.1, 0.2, 0.3], 2); // trailing partial frame ignored
    rt.push_interleaved(&[0.1; 12], 6);
    rt.push_interleaved(&[0.1; 4], 0);
    rt.compute(f32::NAN, &mut frame);
    rt.compute(-1.0, &mut frame);
    rt.compute(100.0, &mut frame);
    rt.compute(0.0, &mut frame); // nothing new since last call
    assert!(frame.bands.iter().all(|b| b.is_finite()));
    assert!(frame.onset.is_finite() && frame.rms.is_finite());
    for sr in [8_000u32, 22_050, 96_000, 192_000] {
        let mut rt = RealtimeAnalyzer::new(sr);
        let x: Vec<f32> = (0..sr as usize / 10).map(|i| (i as f32 * 0.05).sin() * 0.3).collect();
        rt.push_interleaved(&x, 1);
        rt.compute(1.0 / FPS, &mut frame);
        assert!(frame.bands.iter().all(|b| b.is_finite()));
    }
}
