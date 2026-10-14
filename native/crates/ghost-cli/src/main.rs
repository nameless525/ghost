//! Headless test harness for the GHOST engine (play / render / analyze from the terminal).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use clap::{Parser, Subcommand};
use ghost_engine::{
    DownloadOptions, DownloadStatus, Engine, EngineConfig, EngineEvent, LoopMode, NormalizationMode, OfflineConfig, SourceExtras,
    SourceSpec, TagInfo, TrackLoad,
};
use serde_json::json;

#[derive(Parser)]
#[command(name = "ghost-cli", about = "GHOST audio engine test harness")]
struct Cli {
    /// Stream cache directory (default: $GHOST_CACHE_DIR or ~/.cache/ghost-cli).
    #[arg(long, global = true)]
    cache_dir: Option<PathBuf>,
    /// Cache size cap in MB.
    #[arg(long, global = true, default_value_t = 2048)]
    cache_mb: u64,
    #[command(subcommand)]
    cmd: Cmd,
}

/// Addressing inside a source (EngineSourceExtras).
#[derive(clap::Args, Clone, Default)]
struct SourceOpts {
    /// Sub-song (0-based) of a multi-song file (NSF, GBS, HES, KSS, FSB bank, module, ...).
    #[arg(long)]
    subsong: Option<u32>,
    /// Entry to play inside a .zip / .7z archive source.
    #[arg(long)]
    entry: Option<String>,
    /// Play only START_MS:END_MS of the stream (either side may be empty).
    #[arg(long)]
    clip: Option<String>,
    /// Format hint (extension or mime type), for URLs without a telling extension.
    #[arg(long)]
    format_hint: Option<String>,
}

impl SourceOpts {
    fn extras(&self) -> Result<SourceExtras, String> {
        let (clip_start_ms, clip_end_ms) = match &self.clip {
            None => (None, None),
            Some(c) => {
                let (a, b) = c.split_once(':').ok_or_else(|| format!("bad --clip {c} (expected START_MS:END_MS)"))?;
                let num = |v: &str| -> Result<Option<u64>, String> {
                    if v.trim().is_empty() {
                        Ok(None)
                    } else {
                        v.trim().parse::<u64>().map(Some).map_err(|e| format!("bad --clip {c}: {e}"))
                    }
                };
                (num(a)?, num(b)?)
            }
        };
        Ok(SourceExtras { clip_start_ms, clip_end_ms, subsong: self.subsong, archive_entry: self.entry.clone() })
    }
}

/// Loop handling for looping formats (chip / tracker / game-engine).
#[derive(clap::Args, Clone)]
struct LoopOpts {
    /// album (loop N times, then fade) | endless | custom.
    #[arg(long, default_value = "album")]
    loop_mode: String,
    /// Loop count for album / custom.
    #[arg(long, default_value_t = 2)]
    loops: u32,
    /// Fade length in seconds.
    #[arg(long, default_value_t = 10.0)]
    fade: f32,
}

impl LoopOpts {
    fn apply(&self, engine: &Engine) -> Result<(), String> {
        let mode = match self.loop_mode.as_str() {
            "album" => LoopMode::Album,
            "endless" => LoopMode::Endless,
            "custom" => LoopMode::Custom,
            m => return Err(format!("unknown --loop-mode {m} (album | endless | custom)")),
        };
        engine.set_loop(mode, self.loops, self.fade);
        Ok(())
    }
}

#[derive(clap::Args, Clone)]
struct PlayOpts {
    /// URL or file path.
    src: String,
    #[command(flatten)]
    source: SourceOpts,
    #[command(flatten)]
    looping: LoopOpts,
    /// Preload this as the next track (gapless / crossfade into it).
    #[arg(long)]
    next: Option<String>,
    /// Sub-song of the next track.
    #[arg(long)]
    next_subsong: Option<u32>,
    /// Archive entry of the next track.
    #[arg(long)]
    next_entry: Option<String>,
    /// Clip of the next track (START_MS:END_MS).
    #[arg(long)]
    next_clip: Option<String>,
    /// Mute chip voices: bit i mutes voice i (e.g. 0x3 mutes the first two).
    #[arg(long, value_parser = parse_mask)]
    voice_mask: Option<u64>,
    /// Stop after this many seconds.
    #[arg(long)]
    seconds: Option<f64>,
    #[arg(long, default_value_t = 0)]
    start_ms: u64,
    /// Crossfade length in seconds (0 = gapless).
    #[arg(long, default_value_t = 0.0)]
    crossfade: f32,
    /// Disable loudness normalisation.
    #[arg(long)]
    no_norm: bool,
    /// Master volume in dB.
    #[arg(long, default_value_t = 0.0, allow_negative_numbers = true)]
    volume_db: f32,
    /// Seek during playback: "AT_SEC:TARGET_MS" (repeatable).
    #[arg(long = "seek-at")]
    seek_at: Vec<String>,
    /// Timed actions "AT_SEC:ACTION" (repeatable). Actions: seek=MS, pause, play, stop,
    /// volume=DB, mute, unmute, overlay=on|off, preview=SRC[@START_MS], stop-preview,
    /// device=ID|default, crossfade=SEC, gapless=on|off, next=SRC, skip (play the preloaded next),
    /// voices=MASK (mute chip voices).
    #[arg(long = "at")]
    at: Vec<String>,
    /// Output device id for `play` (see `devices`).
    #[arg(long)]
    device: Option<String>,
    /// Same album key for current and next (disables crossfade, enables album gain).
    #[arg(long)]
    same_album: bool,
}

#[derive(Subcommand)]
enum Cmd {
    /// Play to the default output device, printing events and position every second.
    Play(PlayOpts),
    /// Render through the same mixer into a WAV file using the offline null sink.
    Render {
        #[command(flatten)]
        opts: PlayOpts,
        #[arg(long)]
        out: PathBuf,
        #[arg(long, default_value_t = 48_000)]
        rate: u32,
    },
    /// Offline analysis (loudness, beats, kiai, energy, intensity) as JSON.
    Analyze {
        src: String,
        #[command(flatten)]
        source: SourceOpts,
        #[command(flatten)]
        looping: LoopOpts,
    },
    /// List a .zip / .7z rip set (entries and playlist text) as JSON.
    Inspect {
        /// Archive URL or file path.
        archive: String,
        /// Print the full playlist text (default: first lines only).
        #[arg(long)]
        full: bool,
    },
    /// List output devices.
    Devices,
    /// Download and tag a track (chip / tracker / game-engine formats and clips render to FLAC).
    Download {
        url: String,
        #[command(flatten)]
        source: SourceOpts,
        #[command(flatten)]
        looping: LoopOpts,
        /// Force rendering to FLAC (true) or saving the stream as-is (false).
        #[arg(long)]
        render_flac: Option<bool>,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        title: String,
        #[arg(long)]
        album: String,
        #[arg(long)]
        artist: Option<String>,
        #[arg(long)]
        album_artist: Option<String>,
        #[arg(long)]
        composer: Option<String>,
        #[arg(long)]
        track: Option<u32>,
        #[arg(long)]
        disc: Option<u32>,
        #[arg(long)]
        year: Option<u32>,
        #[arg(long)]
        genre: Option<String>,
        #[arg(long)]
        cover: Option<String>,
    },
    /// Stream cache statistics.
    CacheStats {
        /// Delete all cached streams first.
        #[arg(long)]
        clear: bool,
    },
}

fn cache_dir(cli: &Cli) -> PathBuf {
    cli.cache_dir
        .clone()
        .or_else(|| std::env::var_os("GHOST_CACHE_DIR").map(PathBuf::from))
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
            home.join(".cache").join("ghost-cli")
        })
}

fn config(cli: &Cli) -> EngineConfig {
    EngineConfig {
        cache_dir: cache_dir(cli),
        cache_max_bytes: cli.cache_mb * 1024 * 1024,
        user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15".into(),
    }
}

fn parse_mask(s: &str) -> Result<u64, String> {
    let t = s.trim();
    match t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        Some(h) => u64::from_str_radix(h, 16).map_err(|e| e.to_string()),
        None => t.parse::<u64>().map_err(|e| e.to_string()),
    }
}

fn source(s: &str) -> SourceSpec {
    if s.starts_with("http://") || s.starts_with("https://") {
        SourceSpec::http(s, s)
    } else {
        SourceSpec::file(PathBuf::from(s))
    }
}

fn source_with(s: &str, o: &SourceOpts) -> Result<SourceSpec, String> {
    Ok(source(s).with_format_hint(o.format_hint.clone()).with_extras(o.extras()?))
}

fn track(id: &str, s: &str, album: Option<&str>) -> TrackLoad {
    track_spec(id, source(s), album)
}

fn track_spec(id: &str, source: SourceSpec, album: Option<&str>) -> TrackLoad {
    TrackLoad {
        id: id.to_string(),
        source,
        lufs: None,
        album_lufs: None,
        album_key: album.map(str::to_string),
        expected_duration_ms: None,
    }
}

fn next_source(o: &PlayOpts, n: &str) -> Result<SourceSpec, String> {
    let so = SourceOpts { subsong: o.next_subsong, entry: o.next_entry.clone(), clip: o.next_clip.clone(), format_hint: None };
    source_with(n, &so)
}

fn fmt_ms(ms: f64) -> String {
    let s = (ms / 1000.0).max(0.0);
    format!("{}:{:06.3}", (s / 60.0).floor() as u64, s % 60.0)
}

fn describe(ev: &EngineEvent) -> String {
    match ev {
        EngineEvent::State { state, id } => format!("state {state:?} {}", id.as_deref().unwrap_or("-")),
        EngineEvent::Advanced { id } => format!("advanced -> {id}"),
        EngineEvent::Ended { id } => format!("ended {id}"),
        EngineEvent::TrackInfo(i) => {
            let mut s = format!(
                "track-info {} duration={} rate={} ch={} codec={} bitrate={}",
                i.id,
                i.duration_ms.map(|d| fmt_ms(d as f64)).unwrap_or("?".into()),
                i.sample_rate,
                i.channels,
                i.codec,
                i.bitrate_kbps.map(|b| format!("{b}kbps")).unwrap_or("?".into())
            );
            for (k, v) in [("title", &i.title), ("artist", &i.artist), ("album", &i.album)] {
                if let Some(v) = v {
                    s.push_str(&format!(" {k}={v:?}"));
                }
            }
            if let Some(n) = i.subsong_count {
                s.push_str(&format!(" subsong={}/{n}", i.subsong.unwrap_or(0)));
            }
            if let (Some(a), Some(b)) = (i.loop_start_ms, i.loop_end_ms) {
                s.push_str(&format!(" loop={}..{}", fmt_ms(a as f64), fmt_ms(b as f64)));
            }
            if i.voice_count > 0 {
                s.push_str(&format!(" voices={} [{}]", i.voice_count, i.voice_names.join(", ")));
            }
            s
        }
        EngineEvent::Buffering { id, buffering } => format!("buffering {id} {buffering}"),
        EngineEvent::Error { id, message, recoverable } => {
            format!("ERROR {} {message} (recoverable={recoverable})", id.as_deref().unwrap_or("-"))
        }
        EngineEvent::Analysis { id, result, .. } => format!(
            "analysis {id} lufs={:?} bpm={:?} intensity={:?}",
            result.integrated_lufs, result.bpm, result.intensity
        ),
        EngineEvent::CacheComplete { id, bytes, .. } => format!("cache-complete {id} {bytes} bytes"),
        EngineEvent::Download { download_id, status, bytes, total_bytes, path, error } => format!(
            "download {download_id} {status:?} {bytes}/{} {} {}",
            total_bytes.map(|t| t.to_string()).unwrap_or("?".into()),
            path.as_ref().map(|p| p.display().to_string()).unwrap_or_default(),
            error.as_deref().unwrap_or("")
        ),
        EngineEvent::Devices(d) => format!("devices {}", d.len()),
        EngineEvent::PreviewEnded => "preview-ended".into(),
    }
}

/// Timed actions from `--seek-at` and `--at`, sorted by time.
fn parse_actions(o: &PlayOpts) -> Result<Vec<(f64, String)>, String> {
    let mut out = Vec::new();
    for s in &o.seek_at {
        let (a, b) = s.split_once(':').ok_or_else(|| format!("bad --seek-at {s}"))?;
        out.push((a.parse::<f64>().map_err(|e| e.to_string())?, format!("seek={b}")));
    }
    for s in &o.at {
        let (a, b) = s.split_once(':').ok_or_else(|| format!("bad --at {s}"))?;
        out.push((a.parse::<f64>().map_err(|e| e.to_string())?, b.to_string()));
    }
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    Ok(out)
}

fn run_action(engine: &Engine, o: &PlayOpts, action: &str) -> Result<(), String> {
    let (name, arg) = action.split_once('=').map(|(a, b)| (a, Some(b))).unwrap_or((action, None));
    let num = |a: Option<&str>| -> Result<f64, String> { a.ok_or("missing value")?.parse::<f64>().map_err(|e| e.to_string()) };
    let on = |a: Option<&str>| matches!(a, Some("on" | "true" | "1"));
    let album = o.same_album.then_some("cli-album");
    match name {
        "seek" => engine.seek(num(arg)? as u64),
        "pause" => engine.pause(),
        "play" => engine.play(),
        "stop" => engine.stop(),
        "volume" => engine.set_volume_db(num(arg)? as f32),
        "mute" => engine.set_muted(true),
        "unmute" => engine.set_muted(false),
        "overlay" => engine.set_overlay_filter(on(arg)),
        "preview" => {
            let a = arg.ok_or("preview needs a source")?;
            let (src, start) = match a.rsplit_once('@') {
                Some((s, ms)) if ms.chars().all(|c| c.is_ascii_digit()) => (s, ms.parse().unwrap_or(0)),
                _ => (a, 0),
            };
            engine.preview(track("preview", src, None), start);
        }
        "stop-preview" => engine.stop_preview(),
        "device" => engine.set_device(arg.filter(|d| *d != "default").map(str::to_string)),
        "crossfade" => engine.set_crossfade(num(arg)? as f32),
        "gapless" => engine.set_gapless(on(arg)),
        "next" => engine.set_next(Some(track("next", arg.ok_or("next needs a source")?, album))),
        "skip" => {
            let n = o.next.as_deref().ok_or("skip needs --next")?;
            engine.set_current(track_spec("next", next_source(o, n)?, album), 0, true);
        }
        "voices" => engine.set_voice_mask(parse_mask(arg.ok_or("voices needs a mask")?)?),
        other => return Err(format!("unknown action {other}")),
    }
    Ok(())
}

fn setup(engine: &Engine, o: &PlayOpts, autoplay: bool) -> Result<(), String> {
    engine.set_normalization(!o.no_norm, -16.0, NormalizationMode::Auto);
    engine.set_crossfade(o.crossfade);
    engine.set_volume_db(o.volume_db);
    o.looping.apply(engine)?;
    if let Some(m) = o.voice_mask {
        engine.set_voice_mask(m);
    }
    let album = o.same_album.then_some("cli-album");
    engine.set_current(track_spec("current", source_with(&o.src, &o.source)?, album), o.start_ms, autoplay);
    if let Some(n) = &o.next {
        engine.set_next(Some(track_spec("next", next_source(o, n)?, album)));
    }
    Ok(())
}

fn cmd_play(cli: &Cli, o: &PlayOpts) -> Result<(), String> {
    let engine = Engine::new(config(cli)).map_err(|e| e.0)?;
    let events = engine.events();
    if let Some(d) = &o.device {
        engine.set_device(Some(d.clone()));
    }
    setup(&engine, o, true)?;
    let t0 = Instant::now();
    let limit = o.seconds.map(Duration::from_secs_f64);
    let mut actions = parse_actions(o)?;
    let mut frame = ghost_engine::AnalysisFrame::default();
    let mut next_tick = Duration::from_secs(1);
    // Clock check: (wall ms, audible position ms) samples of the current contiguous stretch.
    let mut samples: Vec<(f64, f64)> = Vec::new();
    let mut best: Vec<(f64, f64)> = Vec::new();
    let mut ended = false;
    loop {
        let elapsed = t0.elapsed();
        if limit.is_some_and(|l| elapsed >= l) || ended {
            break;
        }
        while actions.first().is_some_and(|a| elapsed.as_secs_f64() >= a.0) {
            let (_, action) = actions.remove(0);
            println!("[{:7.3}] >>> {action}", elapsed.as_secs_f64());
            run_action(&engine, o, &action)?;
        }
        while let Ok(ev) = events.try_recv() {
            println!("[{:7.3}] {}", t0.elapsed().as_secs_f64(), describe(&ev));
            match &ev {
                EngineEvent::Ended { .. } => ended = true,
                EngineEvent::Error { recoverable: false, .. } => ended = true,
                _ => {}
            }
        }
        let p = engine.position();
        if p.playing {
            let sample = (p.at_epoch_ms, p.position_ms);
            if let Some(&(w0, p0)) = samples.last() {
                // A jump (seek / track change) or a stall (device switch) starts a new stretch.
                let (dp, dw) = (sample.1 - p0, sample.0 - w0);
                if (dp - dw).abs() > 250.0 || (dw > 5.0 && !(0.5..=1.5).contains(&(dp / dw))) {
                    if samples.len() > best.len() {
                        best = std::mem::take(&mut samples);
                    }
                    samples.clear();
                }
            }
            samples.push(sample);
        }
        if elapsed >= next_tick {
            next_tick += Duration::from_secs(1);
            let info = engine.output_info();
            println!(
                "[{:7.3}] position {} / {} id={} playing={} (device {} @ {} Hz, latency {:.1} ms + {:.1} ms)",
                elapsed.as_secs_f64(),
                fmt_ms(p.position_ms),
                p.duration_ms.map(|d| fmt_ms(d as f64)).unwrap_or("?".into()),
                p.id.as_deref().unwrap_or("-"),
                p.playing,
                info.device_name,
                info.sample_rate,
                info.device_latency_ms,
                info.engine_latency_ms,
            );
            let st = engine.stats(false);
            println!(
                "          health: underruns {} xruns {} low-water {} (events {}) callbacks {} over-budget {} gaps {} cb avg/max {:.0}/{:.0} µs of {:.0} µs",
                st.underruns,
                st.xruns,
                st.low_water_ms.map(|m| format!("{m:.0} ms")).unwrap_or("-".into()),
                st.low_water_events,
                st.callbacks,
                st.callback_over_budget,
                st.callback_gaps,
                st.callback_avg_us,
                st.callback_max_us,
                st.callback_period_us,
            );
            if engine.analysis_frame(&mut frame) {
                let loud = frame.bands.iter().enumerate().fold((0, 0.0f32), |m, (i, &b)| if b > m.1 { (i, b) } else { m });
                println!(
                    "          analysis @ {} (seq {}): rms {:.3} peak {:.3} onset {:.3} loudest band #{} ({:.2})",
                    fmt_ms(frame.position_ms),
                    frame.track_seq,
                    frame.rms,
                    frame.peak,
                    frame.onset,
                    loud.0,
                    loud.1
                );
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if samples.len() > best.len() {
        best = samples;
    }
    if best.len() > 50 {
        // Least-squares fit position = a + b * wall; report slope and residual jitter.
        let n = best.len() as f64;
        let (w0, _) = best[0];
        let (sx, sy) = best.iter().fold((0.0, 0.0), |acc, &(w, p)| (acc.0 + (w - w0), acc.1 + p));
        let (mx, my) = (sx / n, sy / n);
        let (mut sxx, mut sxy) = (0.0, 0.0);
        for &(w, p) in &best {
            sxx += (w - w0 - mx) * (w - w0 - mx);
            sxy += (w - w0 - mx) * (p - my);
        }
        let b = sxy / sxx;
        let a = my - b * mx;
        let max_res = best.iter().map(|&(w, p)| (p - (a + b * (w - w0))).abs()).fold(0.0, f64::max);
        println!(
            "clock check: {} samples over {:.2} s: audible position advances {:.5} ms per wall ms, max deviation from linear {:.2} ms",
            best.len(),
            (best.last().unwrap().0 - w0) / 1000.0,
            b,
            max_res
        );
    }
    let st = engine.stats(false);
    let wall_ms = t0.elapsed().as_secs_f64() * 1000.0;
    println!(
        "stats: underruns {} xruns {} low-water {} (events {}) callbacks {} over-budget {} gaps {} cb avg/max {:.0}/{:.0} µs of {:.0} µs",
        st.underruns,
        st.xruns,
        st.low_water_ms.map(|m| format!("{m:.0} ms")).unwrap_or("-".into()),
        st.low_water_events,
        st.callbacks,
        st.callback_over_budget,
        st.callback_gaps,
        st.callback_avg_us,
        st.callback_max_us,
        st.callback_period_us,
    );
    for t in &st.threads {
        println!("  thread {:<20} x{:<2} cpu {:8.1} ms ({:.2} % of one core)", t.name, t.count, t.cpu_ms, t.cpu_ms / wall_ms * 100.0);
    }
    engine.stop();
    std::thread::sleep(Duration::from_millis(100));
    engine.shutdown();
    Ok(())
}

fn cmd_render(cli: &Cli, o: &PlayOpts, out: &Path, rate: u32) -> Result<(), String> {
    let (engine, sink) = Engine::new_offline(config(cli), OfflineConfig { sample_rate: rate, block_frames: 512 }).map_err(|e| e.0)?;
    let events = engine.events();
    setup(&engine, o, false)?;
    engine.play();
    let max_frames = o.seconds.map(|s| (s * rate as f64) as u64);
    let mut actions = parse_actions(o)?;
    let mut writer = ghost_engine::wav::WavWriter::create(out, rate, 2).map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    let (mut peak, mut sum_sq, mut n) = (0.0f32, 0.0f64, 0u64);
    let mut ended_at: Option<Instant> = None;
    let mut last_block = Instant::now();
    loop {
        while let Ok(ev) = events.try_recv() {
            let pos = writer.frames() as f64 / rate as f64;
            println!("[render {pos:8.3}s] {}", describe(&ev));
            match ev {
                EngineEvent::Ended { .. } => ended_at = Some(Instant::now()),
                EngineEvent::Error { recoverable, .. } if !recoverable || o.next.is_none() => ended_at = Some(Instant::now()),
                _ => {}
            }
        }
        let now_s = writer.frames() as f64 / rate as f64;
        while actions.first().is_some_and(|a| now_s >= a.0) {
            let (_, action) = actions.remove(0);
            println!("[render {now_s:8.3}s] >>> {action}");
            run_action(&engine, o, &action)?;
        }
        match sink.blocks.recv_timeout(Duration::from_millis(20)) {
            Ok(mut block) => {
                last_block = Instant::now();
                if let Some(m) = max_frames {
                    let left = m.saturating_sub(writer.frames()) as usize;
                    block.truncate(left * 2);
                }
                for s in &block {
                    peak = peak.max(s.abs());
                    sum_sq += (*s as f64) * (*s as f64);
                }
                n += block.len() as u64;
                writer.write(&block).map_err(|e| e.to_string())?;
                if max_frames.is_some_and(|m| writer.frames() >= m) {
                    break;
                }
            }
            Err(_) => {
                // After the end, wait for the limiter flush, then stop.
                if ended_at.is_some_and(|t| t.elapsed() > Duration::from_millis(300)) && last_block.elapsed() > Duration::from_millis(200) {
                    break;
                }
                if last_block.elapsed() > Duration::from_secs(30) {
                    return Err("render stalled for 30 s".into());
                }
            }
        }
    }
    let frames = writer.frames();
    writer.finish().map_err(|e| e.to_string())?;
    let took = t0.elapsed().as_secs_f64();
    let dur = frames as f64 / rate as f64;
    let rms = if n > 0 { (sum_sq / n as f64).sqrt() } else { 0.0 };
    println!(
        "rendered {frames} frames ({}) at {rate} Hz to {} in {took:.2}s ({:.1}x realtime); peak {:.2} dBFS, rms {:.2} dBFS",
        fmt_ms(dur * 1000.0),
        out.display(),
        dur / took.max(1e-6),
        20.0 * (peak.max(1e-9)).log10(),
        20.0 * (rms.max(1e-9)).log10()
    );
    engine.shutdown();
    Ok(())
}

fn cmd_analyze(cli: &Cli, src: &str, so: &SourceOpts, lo: &LoopOpts) -> Result<(), String> {
    let (engine, _sink) = Engine::new_offline(config(cli), OfflineConfig::default()).map_err(|e| e.0)?;
    let events = engine.events();
    let t0 = Instant::now();
    lo.apply(&engine)?;
    engine.analyze("cli".into(), source_with(src, so)?);
    loop {
        match events.recv_timeout(Duration::from_secs(300)) {
            Ok(EngineEvent::Analysis { result: r, cache_key, .. }) => {
                let v = json!({
                    "source": src,
                    "cache_key": cache_key,
                    "seconds_taken": t0.elapsed().as_secs_f64(),
                    "duration_ms": r.duration_ms,
                    "integrated_lufs": r.integrated_lufs,
                    "loudness_range": r.loudness_range,
                    "true_peak_db": r.true_peak_db,
                    "bpm": r.bpm,
                    "bpm_confidence": r.bpm_confidence,
                    "beats": r.beats,
                    "downbeats": r.downbeats,
                    "kiai": r.kiai.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>(),
                    "energy": r.energy,
                    "intensity": r.intensity,
                });
                println!("{}", serde_json::to_string_pretty(&v).unwrap());
                break;
            }
            Ok(EngineEvent::Error { message, .. }) => return Err(message),
            Ok(_) => {}
            Err(_) => return Err("analysis timed out".into()),
        }
    }
    engine.shutdown();
    Ok(())
}

fn cmd_inspect(cli: &Cli, archive: &str, full: bool) -> Result<(), String> {
    let (engine, _sink) = Engine::new_offline(config(cli), OfflineConfig::default()).map_err(|e| e.0)?;
    let t0 = Instant::now();
    let listing = engine.inspect_archive(&source(archive)).map_err(|e| e.0)?;
    let v = json!({
        "archive": archive,
        "seconds_taken": t0.elapsed().as_secs_f64(),
        "entries": listing.entries.iter().map(|e| json!({ "path": e.path, "size": e.size })).collect::<Vec<_>>(),
        "playlists": listing.playlists.iter().map(|(p, t)| {
            let text = if full { t.clone() } else { t.lines().take(3).collect::<Vec<_>>().join("\n") };
            json!({ "path": p, "text": text })
        }).collect::<Vec<_>>(),
    });
    println!("{}", serde_json::to_string_pretty(&v).unwrap());
    engine.shutdown();
    Ok(())
}

fn cmd_devices() {
    let devs = ghost_engine::list_output_devices();
    if devs.is_empty() {
        println!("no output devices");
    }
    for d in devs {
        println!("{} {}  [{}]", if d.is_default { "*" } else { " " }, d.name, d.id);
    }
}

fn cmd_cache_stats(cli: &Cli, clear: bool) -> Result<(), String> {
    let cfg = config(cli);
    let cache = ghost_engine::cache::CacheManager::new(cfg.cache_dir, cfg.cache_max_bytes, &cfg.user_agent).map_err(|e| e.0)?;
    if clear {
        cache.clear();
    }
    let s = cache.stats();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "dir": s.dir.display().to_string(),
            "entries": s.entries,
            "complete_entries": s.complete_entries,
            "bytes": s.bytes,
            "max_bytes": s.max_bytes,
        }))
        .unwrap()
    );
    Ok(())
}

fn main() {
    let cli = Cli::parse();
    let res = match &cli.cmd {
        Cmd::Play(o) => cmd_play(&cli, o),
        Cmd::Render { opts, out, rate } => cmd_render(&cli, opts, out, *rate),
        Cmd::Analyze { src, source, looping } => cmd_analyze(&cli, src, source, looping),
        Cmd::Inspect { archive, full } => cmd_inspect(&cli, archive, *full),
        Cmd::Devices => {
            cmd_devices();
            Ok(())
        }
        Cmd::Download { url, source, looping, render_flac, out, title, album, artist, album_artist, composer, track, disc, year, genre, cover } => {
            let tags = TagInfo {
                title: title.clone(),
                album: album.clone(),
                album_artist: album_artist.clone(),
                artist: artist.clone(),
                composer: composer.clone(),
                track_number: *track,
                disc_number: *disc,
                year: *year,
                genre: genre.clone(),
                cover_url: cover.clone(),
                ..Default::default()
            };
            cmd_download(&cli, url, source, looping, *render_flac, out, tags)
        }
        Cmd::CacheStats { clear } => cmd_cache_stats(&cli, *clear),
    };
    if let Err(e) = res {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

#[allow(clippy::too_many_arguments)]
fn cmd_download(cli: &Cli, url: &str, so: &SourceOpts, lo: &LoopOpts, render_flac: Option<bool>, out: &Path, tags: TagInfo) -> Result<(), String> {
    let (engine, _sink) = Engine::new_offline(config(cli), OfflineConfig::default()).map_err(|e| e.0)?;
    let events = engine.events();
    let t0 = Instant::now();
    lo.apply(&engine)?;
    engine.download_with("cli-dl".into(), source_with(url, so)?, out.to_path_buf(), tags, DownloadOptions { render_flac });
    loop {
        match events.recv_timeout(Duration::from_secs(120)) {
            Ok(EngineEvent::Download { status, bytes, total_bytes, path, error, .. }) => {
                let pct = total_bytes.map(|t| format!(" ({:.0}%)", bytes as f64 * 100.0 / t.max(1) as f64)).unwrap_or_default();
                println!("[{:6.2}] {status:?} {bytes}/{}{pct}", t0.elapsed().as_secs_f64(), total_bytes.map(|t| t.to_string()).unwrap_or("?".into()));
                match status {
                    DownloadStatus::Done => {
                        println!("saved to {}", path.unwrap_or_default().display());
                        break;
                    }
                    DownloadStatus::Error => return Err(error.unwrap_or_default()),
                    DownloadStatus::Canceled => return Err("canceled".into()),
                    DownloadStatus::Progress => {}
                }
            }
            Ok(_) => {}
            Err(_) => return Err("download timed out".into()),
        }
    }
    engine.shutdown();
    Ok(())
}
