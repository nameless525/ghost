//! Decode audio files with symphonia and print the offline analysis plus timing.
//!
//! ```text
//! cargo run -p ghost-analysis --release --example analyze_file -- [--rt] [--beats] FILE...
//! ```
//! `--rt` also runs the real-time analyzer over the track at 120 fps and prints per-band means
//! and onset statistics; `--beats` prints every beat time.

use std::fs::File;
use std::path::Path;
use std::time::Instant;

use ghost_analysis::offline::{analyze_detailed, loudness};
use ghost_analysis::realtime::RealtimeAnalyzer;
use ghost_analysis::{AnalysisFrame, NUM_BANDS};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

fn decode(path: &Path) -> Result<(Vec<f32>, usize, u32), String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default())
        .map_err(|e| e.to_string())?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("no audio track")?.clone();
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);
    let mut rate = track.codec_params.sample_rate.unwrap_or(44_100);
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id() != track.id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(audio) => {
                let spec = *audio.spec();
                channels = spec.channels.count();
                rate = spec.rate;
                let b = buf.get_or_insert_with(|| SampleBuffer::new(audio.capacity() as u64, spec));
                if b.capacity() < audio.capacity() {
                    *b = SampleBuffer::new(audio.capacity() as u64, spec);
                }
                b.copy_interleaved_ref(audio);
                out.extend_from_slice(b.samples());
            }
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok((out, channels, rate))
}

fn sparkline(v: &[f32], width: usize) -> String {
    const BARS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let step = v.len() as f32 / width as f32;
    (0..width)
        .map(|i| {
            let a = (i as f32 * step) as usize;
            let b = (((i + 1) as f32 * step) as usize).max(a + 1).min(v.len());
            let m = v[a..b].iter().sum::<f32>() / (b - a) as f32;
            BARS[((m * 7.999) as usize).min(7)]
        })
        .collect()
}

fn fmt_opt(v: Option<f32>, prec: usize) -> String {
    v.map(|x| format!("{x:.prec$}")).unwrap_or_else(|| "-".into())
}

/// Run the real-time analyzer over the track at 120 fps, after normalising it to -16 LUFS the
/// way the engine's analysis tap sees it.
fn run_realtime(samples: &[f32], channels: usize, rate: u32, lufs: Option<f32>) {
    let gain = 10f32.powf((-16.0 - lufs.unwrap_or(-16.0)) / 20.0);
    let samples: Vec<f32> = samples.iter().map(|x| x * gain).collect();
    let samples = &samples[..];
    let mut rt = RealtimeAnalyzer::new(rate);
    let mut frame = AnalysisFrame::default();
    let hop = (rate as usize / 120).max(1);
    let mut sum = [0.0f64; NUM_BANDS];
    let mut maxv = [0.0f32; NUM_BANDS];
    let mut n = 0usize;
    let mut onsets = Vec::new();
    let t0 = Instant::now();
    for chunk in samples.chunks(hop * channels) {
        rt.push_interleaved(chunk, channels);
        rt.compute(1.0 / 120.0, &mut frame);
        for b in 0..NUM_BANDS {
            sum[b] += frame.bands[b] as f64;
            maxv[b] = maxv[b].max(frame.bands[b]);
        }
        onsets.push(frame.onset);
        n += 1;
    }
    let el = t0.elapsed();
    let means: Vec<f32> = sum.iter().map(|s| (*s / n as f64) as f32).collect();
    println!("  realtime: {n} frames in {:.0} ms ({:.1} µs/frame)", el.as_secs_f64() * 1e3, el.as_secs_f64() * 1e6 / n as f64);
    println!("  band means  {}", sparkline(&means, 96));
    println!("  band maxima {}", sparkline(&maxv, 96));
    let groups = [(0, 16), (16, 32), (32, 48), (48, 64), (64, 80), (80, 96)];
    let g: Vec<String> = groups.iter().map(|&(a, b)| format!("{:.2}", means[a..b].iter().sum::<f32>() / (b - a) as f32)).collect();
    println!("  band means by sixths: {}", g.join(" "));
    let mut s = onsets.clone();
    s.sort_by(f32::total_cmp);
    let pct = |q: f32| s[((s.len() - 1) as f32 * q) as usize];
    let spikes = onsets.windows(2).filter(|w| w[1] > 0.5 && w[0] <= 0.5).count();
    println!(
        "  onset p50 {:.2} p90 {:.2} p99 {:.2}; spikes>0.5: {} ({:.2}/s)",
        pct(0.5),
        pct(0.9),
        pct(0.99),
        spikes,
        spikes as f32 / (samples.len() / channels) as f32 * rate as f32
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rt = args.iter().any(|a| a == "--rt");
    let show_beats = args.iter().any(|a| a == "--beats");
    let csv = args.iter().any(|a| a == "--csv");
    if csv {
        println!("name,lufs,lra,tp,bpm,conf,acf,comb,align,stab,dens,flux,hf_flux,lf_flux,flat,hf_db,stars");
    }
    let files: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    if files.is_empty() {
        eprintln!("usage: analyze_file [--rt] [--beats] FILE...");
        std::process::exit(2);
    }
    let mut summary = Vec::new();
    for path in files {
        let path = Path::new(path);
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let t0 = Instant::now();
        let (samples, channels, rate) = match decode(path) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("{name}: decode failed: {e}");
                continue;
            }
        };
        let t_dec = t0.elapsed();
        let t1 = Instant::now();
        let (lufs_fast, tp_fast) = loudness(&samples, channels, rate);
        let t_loud = t1.elapsed();
        let t2 = Instant::now();
        let (a, d) = analyze_detailed(&samples, channels, rate);
        let t_an = t2.elapsed();
        if csv {
            let o = |v: Option<f32>| v.map(|x| x.to_string()).unwrap_or_default();
            println!(
                "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
                name.trim_end_matches(".mp3"),
                o(a.integrated_lufs),
                o(a.loudness_range),
                o(a.true_peak_db),
                o(d.bpm_estimate),
                a.bpm_confidence,
                d.tempo.acf_peak,
                d.tempo.comb,
                d.tempo.alignment,
                d.tempo.stability,
                d.onset_density,
                d.mean_flux,
                d.hf_flux,
                d.lf_flux,
                d.flatness,
                d.hf_db,
                o(a.intensity)
            );
            continue;
        }

        println!("== {name}");
        println!(
            "  {:.1}s {}ch {} Hz | decode {:.0} ms, loudness() {:.0} ms, analyze {:.0} ms",
            a.duration_ms as f32 / 1000.0,
            channels,
            rate,
            t_dec.as_secs_f64() * 1e3,
            t_loud.as_secs_f64() * 1e3,
            t_an.as_secs_f64() * 1e3
        );
        println!(
            "  loudness {} LUFS, LRA {} LU, TP {} dBTP (fast path: {} / {})",
            fmt_opt(a.integrated_lufs, 1),
            fmt_opt(a.loudness_range, 1),
            fmt_opt(a.true_peak_db, 2),
            fmt_opt(lufs_fast, 1),
            fmt_opt(tp_fast, 2)
        );
        println!(
            "  bpm {} (estimate {}), confidence {:.2} [acf {:.2} comb {:.2} align {:.2} stab {:.2}], {} beats, {} downbeats",
            fmt_opt(a.bpm, 2),
            fmt_opt(d.bpm_estimate, 2),
            a.bpm_confidence,
            d.tempo.acf_peak,
            d.tempo.comb,
            d.tempo.alignment,
            d.tempo.stability,
            a.beats.len(),
            a.downbeats.len()
        );
        if show_beats {
            let b: Vec<String> = a.beats.iter().map(|t| format!("{t:.3}")).collect();
            println!("  beats: {}", b.join(" "));
        }
        let k: Vec<String> = a.kiai.iter().map(|(s, e)| format!("{s:.1}–{e:.1}")).collect();
        println!("  kiai: [{}]", k.join(", "));
        println!("  energy {}", sparkline(&a.energy, 96));
        let p = &d.intensity_parts;
        println!(
            "  intensity {}★ | onsets {:.2}/s, flux {:.3}, hf-flux {:.3}, flatness {:.3}, hf {:.1} dB | tempo {:.2} act {:.2} drive {:.2} tex {:.2} bright {:.2} loud {:.2} dens {:.2} dyn {:.2} → raw {:.2}",
            fmt_opt(a.intensity, 2),
            d.onset_density,
            d.mean_flux,
            d.hf_flux,
            d.flatness,
            d.hf_db,
            p.tempo,
            p.activity,
            p.drive,
            p.texture,
            p.brightness,
            p.loudness,
            p.density,
            p.dynamics,
            p.raw
        );
        if rt {
            run_realtime(&samples, channels, rate, a.integrated_lufs);
        }
        summary.push((name, a.intensity, a.bpm, a.bpm_confidence, a.kiai.len(), t_an.as_secs_f64() * 1e3));
    }
    if summary.len() > 1 {
        println!("\n{:<60} {:>6} {:>7} {:>5} {:>4} {:>7}", "track", "stars", "bpm", "conf", "kiai", "ms");
        for (n, s, b, c, k, ms) in summary {
            let n: String = n.chars().take(60).collect();
            println!("{:<60} {:>6} {:>7} {:>5.2} {:>4} {:>7.0}", n, fmt_opt(s, 2), fmt_opt(b, 1), c, k, ms);
        }
    }
}
