//! Deterministic mixer tests: voices are pre-filled rings, the mixer is driven block by block.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::*;
use crate::voice::VoiceShared;

const RATE: u32 = 48_000;

fn voice_with(key: u64, bus: Bus, data: &[f32], eof: bool) -> Box<Voice> {
    let cap = (data.len() + 4) & !1;
    let (mut p, c) = rtrb::RingBuffer::new(cap.max(4));
    p.push_entire_slice(data).unwrap();
    let shared = VoiceShared::new(key);
    shared.origin_set.store(true, Ordering::Release);
    if eof {
        shared.end_pos.store((data.len() / 2) as u64, Ordering::Release);
        shared.eof.store(true, Ordering::Release);
    }
    std::mem::forget(p); // keep the producer side "alive" (not abandoned)
    Box::new(Voice::new(key, key as u32, bus, c, shared, 1.0))
}

fn voice(key: u64, data: &[f32], eof: bool) -> Box<Voice> {
    voice_with(key, Bus::Music, data, eof)
}

fn sine(frames: usize, freq: f32, amp: f32, phase0: usize) -> Vec<f32> {
    (0..frames)
        .flat_map(|i| {
            let v = (2.0 * std::f32::consts::PI * freq * (i + phase0) as f32 / RATE as f32).sin() * amp;
            [v, -v]
        })
        .collect()
}

fn mixer(offline: bool) -> (Box<Mixer>, MixerLink, Arc<Clock>) {
    let clock = Arc::new(Clock::new());
    let parts = Mixer::create(RATE, clock.clone(), offline, 0, false);
    (parts.mixer, parts.link, clock)
}

fn send(link: &mut MixerLink, cmd: MixerCmd) {
    assert!(link.cmd.push(cmd).is_ok());
}

fn render(m: &mut Mixer, frames: usize, block: usize) -> Vec<f32> {
    let mut out = vec![0.0; frames * 2];
    let mut off = 0;
    while off < frames {
        let n = block.min(frames - off);
        m.render(&mut out[off * 2..(off + n) * 2], 0);
        off += n;
    }
    out
}

fn events(link: &mut MixerLink) -> Vec<MixerEvent> {
    let mut v = Vec::new();
    while let Ok(e) = link.events.pop() {
        v.push(e);
    }
    v
}

fn max_jump(x: &[f32]) -> f32 {
    // Left channel only.
    x.as_chunks::<2>().0.iter().map(|f| f[0]).collect::<Vec<_>>().windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max)
}

#[test]
fn gapless_is_sample_exact() {
    let (mut m, mut link, _) = mixer(false);
    let total = 48_000 + 777;
    let split = 23_456; // not block-aligned
    let sig = sine(total, 441.0, 0.8, 0);
    send(&mut link, MixerCmd::SetCurrent { voice: Some(voice(1, &sig[..split * 2], true)), fade_frames: 0 });
    send(&mut link, MixerCmd::SetNext(Some(voice(2, &sig[split * 2..], true))));
    send(&mut link, MixerCmd::Play);
    let lat = m.latency_frames();
    let out = render(&mut m, total + lat + 1000, 333);
    for i in 0..total * 2 {
        assert_eq!(out[i + lat * 2], sig[i], "sample {i} differs");
    }
    let ev = events(&mut link);
    assert!(ev.contains(&MixerEvent::Advanced { from: 1, to: 2 }), "{ev:?}");
    assert!(ev.contains(&MixerEvent::Ended(2)), "{ev:?}");
}

#[test]
fn pause_resume_has_no_clicks() {
    let (mut m, mut link, _) = mixer(false);
    let sig = sine(RATE as usize * 3, 997.0, 0.9, 0);
    send(&mut link, MixerCmd::SetCurrent { voice: Some(voice(1, &sig, true)), fade_frames: 0 });
    send(&mut link, MixerCmd::Play);
    let mut out = render(&mut m, 12_345, 256);
    send(&mut link, MixerCmd::Pause);
    let paused = render(&mut m, 4_800, 256);
    // Fully silent after the 8 ms fade (+ limiter latency).
    let tail = &paused[(RATE as usize / 50) * 2..];
    assert!(tail.iter().all(|&s| s == 0.0));
    out.extend_from_slice(&paused);
    send(&mut link, MixerCmd::Play);
    out.extend(render(&mut m, 9_000, 256));
    // The sine's own largest step is 2π·f/fs·A ≈ 0.117; a click would be far larger.
    let slope = 2.0 * std::f32::consts::PI * 997.0 / RATE as f32 * 0.9;
    let j = max_jump(&out);
    assert!(j <= slope * 1.05, "max jump {j} vs slope {slope}");
    assert!(events(&mut link).contains(&MixerEvent::Paused));
}

#[test]
fn seek_style_switch_is_click_free() {
    let (mut m, mut link, _) = mixer(false);
    let a = sine(RATE as usize, 300.0, 0.9, 0);
    // Different phase: a hard cut would jump.
    let b = sine(RATE as usize, 300.0, 0.9, 40);
    send(&mut link, MixerCmd::SetCurrent { voice: Some(voice(1, &a, true)), fade_frames: 0 });
    send(&mut link, MixerCmd::Play);
    let mut out = render(&mut m, 10_000, 512);
    let mut vb = voice(2, &b, true);
    vb.fade_in = true;
    send(&mut link, MixerCmd::SetCurrent { voice: Some(vb), fade_frames: 480 });
    out.extend(render(&mut m, 10_000, 512));
    let slope = 2.0 * std::f32::consts::PI * 300.0 / RATE as f32 * 0.9;
    let j = max_jump(&out);
    assert!(j < slope * 3.0, "max jump {j} vs slope {slope}");
}

#[test]
fn volume_ramp_is_smooth() {
    let (mut m, mut link, _) = mixer(false);
    let dc: Vec<f32> = vec![0.5; RATE as usize * 2];
    send(&mut link, MixerCmd::SetCurrent { voice: Some(voice(1, &dc, true)), fade_frames: 0 });
    send(&mut link, MixerCmd::Play);
    render(&mut m, 4800, 512);
    send(&mut link, MixerCmd::SetMaster(crate::util::db_to_lin(-20.0)));
    let out = render(&mut m, 4800, 512);
    let left: Vec<f32> = out.as_chunks::<2>().0.iter().map(|f| f[0]).collect();
    let max_step = left.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
    // 0.45 total change spread over 20 ms (960 frames) → ~0.00047 per frame.
    assert!(max_step < 0.001, "volume step {max_step}");
    assert!((left[4000] - 0.05).abs() < 1e-4, "settled at {}", left[4000]);
    // Monotonic.
    assert!(left.windows(2).all(|w| w[1] <= w[0] + 1e-7));
}

#[test]
fn limiter_holds_ceiling_with_boost() {
    let (mut m, mut link, _) = mixer(false);
    let sig = sine(RATE as usize, 1234.5, 1.0, 0);
    send(&mut link, MixerCmd::SetCurrent { voice: Some(voice(1, &sig, true)), fade_frames: 0 });
    send(&mut link, MixerCmd::SetMaster(crate::util::db_to_lin(6.0)));
    send(&mut link, MixerCmd::Play);
    let out = render(&mut m, RATE as usize, 512);
    let peak = out.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
    let ceiling = crate::util::db_to_lin(LIMITER_CEILING_DB);
    assert!(peak <= ceiling + 1e-6, "peak {peak} > ceiling {ceiling}");
    assert!(peak > ceiling * 0.95, "limiter is over-limiting: {peak}");
}

#[test]
fn crossfade_is_equal_power_and_advances() {
    let (mut m, mut link, _) = mixer(false);
    let a: Vec<f32> = vec![0.5; RATE as usize * 2]; // 1 s DC
    let b: Vec<f32> = vec![0.5; RATE as usize * 4];
    let xf = RATE / 2;
    send(&mut link, MixerCmd::SetTransition(Transition::Crossfade(xf)));
    send(&mut link, MixerCmd::SetCurrent { voice: Some(voice(1, &a, true)), fade_frames: 0 });
    send(&mut link, MixerCmd::SetNext(Some(voice(2, &b, true))));
    send(&mut link, MixerCmd::Play);
    let out = render(&mut m, RATE as usize * 2, 512);
    let lat = m.latency_frames();
    // At the crossfade midpoint the equal-power sum of two equal DC signals is √2·0.5·…:
    let mid = (RATE as usize - xf as usize / 2 + lat) * 2;
    let expect = 0.5 * 2.0 * (std::f32::consts::FRAC_PI_4).cos();
    assert!((out[mid] - expect).abs() < 0.01, "mid {} expect {}", out[mid], expect);
    let ev = events(&mut link);
    assert!(ev.contains(&MixerEvent::Advanced { from: 1, to: 2 }), "{ev:?}");
    // Smooth throughout.
    assert!(max_jump(&out[lat * 2..]) < 0.01);
}

#[test]
fn gap_mode_inserts_silence() {
    let (mut m, mut link, _) = mixer(false);
    let a: Vec<f32> = vec![0.25; 4800 * 2];
    let b: Vec<f32> = vec![0.25; 4800 * 2];
    let gap = RATE / 2;
    send(&mut link, MixerCmd::SetTransition(Transition::Gap(gap)));
    send(&mut link, MixerCmd::SetCurrent { voice: Some(voice(1, &a, true)), fade_frames: 0 });
    send(&mut link, MixerCmd::SetNext(Some(voice(2, &b, true))));
    send(&mut link, MixerCmd::Play);
    let lat = m.latency_frames();
    let out = render(&mut m, 4800 + gap as usize + 4800 + lat, 512);
    let l: Vec<f32> = out.as_chunks::<2>().0.iter().map(|f| f[0]).collect();
    assert_eq!(l[lat + 4799], 0.25);
    assert!(l[lat + 4800..lat + 4800 + gap as usize].iter().all(|&s| s == 0.0));
    assert_eq!(l[lat + 4800 + gap as usize], 0.25);
}

#[test]
fn underrun_fades_and_reports() {
    let (mut m, mut link, _) = mixer(false);
    let sig = sine(10_000, 440.0, 0.8, 0);
    // Not EOF: the ring runs dry mid-track.
    send(&mut link, MixerCmd::SetCurrent { voice: Some(voice(1, &sig, false)), fade_frames: 0 });
    send(&mut link, MixerCmd::Play);
    let out = render(&mut m, 20_000, 480);
    let ev = events(&mut link);
    assert!(ev.contains(&MixerEvent::Underrun(1, true)), "{ev:?}");
    let slope = 2.0 * std::f32::consts::PI * 440.0 / RATE as f32 * 0.8;
    assert!(max_jump(&out) < slope * 1.5);
}

/// The counters behind `Engine::load_progress`: short of its prefill, a voice reports what it
/// has against the prefill; after running dry, what came since against the rebuffer amount.
#[test]
fn wait_progress_follows_prefill_and_rebuffer() {
    use crate::voice::{PLAY_REBUFFERING, PLAY_STARTED, PLAY_WAITING};
    let (mut m, mut link, _) = mixer(false);
    let (prefill, rebuffer) = ((PREFILL_SEC * RATE as f32) as u64, (REBUFFER_SEC * RATE as f32) as u64);
    let (mut prod, cons) = rtrb::RingBuffer::new(RATE as usize * 4);
    let shared = VoiceShared::new(1);
    shared.origin_set.store(true, Ordering::Release);
    // What the decode worker does: push frames, then publish the write position.
    let mut written = 0u64;
    let mut feed = |frames: u64| {
        prod.push_entire_slice(&vec![0.25; frames as usize * 2]).unwrap();
        written += frames;
        shared.write_pos.store(written, Ordering::Release);
    };
    let progress = || shared.wait_progress(prefill, rebuffer);

    feed(prefill / 2);
    send(&mut link, MixerCmd::SetCurrent { voice: Some(Box::new(Voice::new(1, 1, Bus::Music, cons, shared.clone(), 1.0))), fade_frames: 0 });
    send(&mut link, MixerCmd::Play);
    render(&mut m, 2048, 512);
    assert_eq!(progress(), (PLAY_WAITING, prefill / 2, prefill));

    feed(prefill);
    render(&mut m, 512, 512);
    assert!(events(&mut link).contains(&MixerEvent::Started(1)));
    assert_eq!(progress(), (PLAY_STARTED, 0, 0), "nothing to wait for while playing");

    // Play past everything that was decoded: the voice runs dry.
    render(&mut m, (prefill * 2) as usize, 512);
    assert!(events(&mut link).contains(&MixerEvent::Underrun(1, true)));
    assert_eq!(progress(), (PLAY_REBUFFERING, 0, rebuffer));
    feed(rebuffer / 3);
    render(&mut m, 512, 512);
    assert_eq!(progress(), (PLAY_REBUFFERING, rebuffer / 3, rebuffer));

    feed(rebuffer);
    render(&mut m, 512, 512);
    assert!(events(&mut link).contains(&MixerEvent::Underrun(1, false)));
    assert_eq!(progress(), (PLAY_STARTED, 0, 0));
}

#[test]
fn preview_ducks_music_and_ends() {
    let (mut m, mut link, _) = mixer(false);
    let music: Vec<f32> = vec![0.5; RATE as usize * 6];
    let pv: Vec<f32> = vec![0.0; RATE as usize * 6];
    send(&mut link, MixerCmd::SetCurrent { voice: Some(voice(1, &music, true)), fade_frames: 0 });
    send(&mut link, MixerCmd::Play);
    render(&mut m, 4800, 512);
    send(&mut link, MixerCmd::Preview(voice_with(9, Bus::Preview, &pv, true)));
    let out = render(&mut m, RATE as usize, 512);
    let ducked = out[out.len() - 2];
    let expect = 0.5 * crate::util::db_to_lin(PREVIEW_DUCK_DB);
    assert!((ducked - expect).abs() < 1e-3, "ducked {ducked} expect {expect}");
    assert!(events(&mut link).contains(&MixerEvent::PreviewStarted(9)));
    send(&mut link, MixerCmd::StopPreview);
    let out = render(&mut m, RATE as usize, 512);
    assert!(events(&mut link).contains(&MixerEvent::PreviewEnded(9)));
    assert!((out[out.len() - 2] - 0.5).abs() < 1e-3, "unducked {}", out[out.len() - 2]);
}

#[test]
fn preview_auto_stops_after_30s() {
    let (mut m, mut link, _) = mixer(false);
    let pv: Vec<f32> = vec![0.1; RATE as usize * 40 * 2];
    send(&mut link, MixerCmd::Preview(voice_with(5, Bus::Preview, &pv, true)));
    render(&mut m, RATE as usize * 30, 512);
    assert!(!events(&mut link).contains(&MixerEvent::PreviewEnded(5)));
    let out = render(&mut m, RATE as usize * 2, 512);
    assert!(events(&mut link).contains(&MixerEvent::PreviewEnded(5)));
    assert_eq!(out[out.len() - 2], 0.0);
}

#[test]
fn overlay_filter_attenuates_and_returns_transparent() {
    let (mut m, mut link, _) = mixer(false);
    let sig = sine(RATE as usize * 3, 6000.0, 0.5, 0);
    send(&mut link, MixerCmd::SetCurrent { voice: Some(voice(1, &sig, true)), fade_frames: 0 });
    send(&mut link, MixerCmd::Play);
    render(&mut m, 4800, 512);
    send(&mut link, MixerCmd::SetOverlay(true));
    let out = render(&mut m, RATE as usize / 2, 512);
    let last: Vec<f32> = out[out.len() - 2000..].to_vec();
    let peak = last.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
    assert!(peak < 0.01, "6 kHz should be filtered out, peak {peak}");
    send(&mut link, MixerCmd::SetOverlay(false));
    render(&mut m, RATE as usize / 2, 512);
    // Transparent again: output equals input (delayed by the limiter).
    let lat = m.latency_frames();
    let consumed = 4800 + RATE as usize;
    let out = render(&mut m, 2000, 512);
    for i in 0..2000 {
        assert_eq!(out[i * 2], sig[(consumed + i - lat) * 2]);
    }
}

#[test]
fn position_segments_track_audible_voice() {
    let (mut m, mut link, clock) = mixer(false);
    let a: Vec<f32> = vec![0.1; 10_000 * 2];
    let b: Vec<f32> = vec![0.1; 10_000 * 2];
    send(&mut link, MixerCmd::SetCurrent { voice: Some(voice(1, &a, true)), fade_frames: 0 });
    send(&mut link, MixerCmd::SetNext(Some(voice(2, &b, true))));
    send(&mut link, MixerCmd::Play);
    render(&mut m, 12_000, 1000);
    // Mix frame 10_500 belongs to voice 2 at position 500.
    let s = clock.at_frame(10_500).unwrap();
    assert_eq!(s.voice, 2);
    assert_eq!(s.pos_at_frame(10_500), 500);
    let s = clock.at_frame(9_999).unwrap();
    assert_eq!(s.voice, 1);
    assert_eq!(s.pos_at_frame(9_999), 9_999);
}

#[test]
fn offline_readiness_waits_for_data() {
    let (mut m, mut link, _) = mixer(true);
    let sig: Vec<f32> = vec![0.1; 100 * 2];
    send(&mut link, MixerCmd::SetCurrent { voice: Some(voice(1, &sig, false)), fade_frames: 0 });
    send(&mut link, MixerCmd::Play);
    m.process_commands();
    assert!(m.is_active());
    assert!(!m.offline_ready(512), "only 100 frames buffered and not EOF");
}

/// Render cost of the RT path (perf audit): `cargo test --release -p ghost-engine --lib
/// mixer_render_cost -- --ignored --nocapture`. Prints ns per frame and an output hash, so
/// optimisations can be checked for bit-exactness.
#[test]
#[ignore]
#[cfg(unix)]
fn mixer_render_cost() {
    let frames = RATE as usize * 30;
    let mut x = 0x2545F4914F6CDD1Du64;
    let sig: Vec<f32> = (0..frames)
        .flat_map(|i| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let n = ((x >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 0.3;
            let t = i as f32 / RATE as f32;
            let v = (2.0 * std::f32::consts::PI * 220.0 * t).sin() * 0.45 + (2.0 * std::f32::consts::PI * 3_150.0 * t).sin() * 0.2 + n;
            [v, v * 0.9 - n * 0.5]
        })
        .collect();
    for (name, gain, overlay) in [("plain", 1.0f32, false), ("boosted +12 dB (limiting)", 3.98, false), ("overlay low-pass", 1.0, true), ("plain (again)", 1.0, false)] {
        let (mut m, mut link, _) = mixer(false);
        let mut v = voice(1, &sig, true);
        v.gain = crate::dsp::Ramp::new(gain);
        send(&mut link, MixerCmd::SetCurrent { voice: Some(v), fade_frames: 0 });
        send(&mut link, MixerCmd::SetOverlay(overlay));
        send(&mut link, MixerCmd::Play);
        let mut out = vec![0.0f32; frames * 2];
        let cpu = || {
            let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
            // SAFETY: valid out-pointer.
            unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
            std::time::Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
        };
        // Thread CPU time, best 1024-frame block of each 32 (robust against a busy machine).
        let mut best = std::time::Duration::MAX;
        let mut sum = std::time::Duration::ZERO;
        let mut done = 0;
        while done + 32 * 1024 <= frames {
            let t = cpu();
            for b in 0..32 {
                let at = done + b * 1024;
                m.render(&mut out[at * 2..(at + 1024) * 2], 0);
            }
            let dt = cpu() - t;
            best = best.min(dt / 32);
            sum += dt;
            while link.garbage.pop().is_ok() {}
            while link.events.pop().is_ok() {}
            done += 32 * 1024;
        }
        let dt = best * (done / 1024) as u32;
        let _ = sum;
        let h = out[..done * 2].iter().fold(0xcbf29ce484222325u64, |h, s| (h ^ s.to_bits() as u64).wrapping_mul(0x100000001b3));
        println!("{name:>28}: {:6.1} ns/frame ({:5.1} µs per 1024-frame callback) hash {h:016x}", dt.as_nanos() as f64 / done as f64, dt.as_secs_f64() * 1e6 / (done / 1024) as f64);
    }
}
