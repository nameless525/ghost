//! Decoder tests on synthetic files (exact, always run) and on real rip files when
//! `GHOST_FORMATS_TEST_DIR` points at a folder of them (see `real_files`).

use std::io::Cursor;
use std::sync::Arc;

use ghost_formats::testdata::*;
use ghost_formats::vgmstream::{MemoryOpener, VgmstreamSource};
use ghost_formats::{archive, detect, open_memory, AudioSource, Family, OpenOptions};

fn read_frames(s: &mut dyn AudioSource, frames: usize) -> Vec<f32> {
    let ch = s.channels();
    let mut out = vec![0.0f32; frames * ch];
    let mut done = 0;
    while done < frames {
        let n = s.read(&mut out[done * ch..]).unwrap();
        if n == 0 {
            break;
        }
        done += n;
    }
    out.truncate(done * ch);
    out
}

fn opts(subsong: Option<u32>) -> OpenOptions {
    OpenOptions { subsong, playlists: Vec::new() }
}

#[test]
fn nsf_subsongs_select_different_songs() {
    let nsf = nsf_songs(&[253, 126], "Two Songs");
    assert_eq!(detect(Some("nsf"), &nsf, None), Some(Family::Gme));
    let mut freqs = Vec::new();
    for sub in 0..2 {
        let mut s = open_memory(Family::Gme, nsf.clone(), "two.nsf", &opts(Some(sub))).unwrap();
        let m = s.meta();
        assert_eq!(m.codec, "nsf");
        assert_eq!(m.subsong_count, Some(2));
        assert_eq!(m.subsong, Some(sub));
        assert_eq!(m.album.as_deref(), Some("Two Songs"));
        assert_eq!(s.voice_count(), 5, "{:?}", m.voice_names);
        // No length anywhere: 2:30, then the engine's fade.
        assert_eq!(s.length_hint().unwrap().length, 150 * 44_100);
        assert_eq!(s.length_hint().unwrap().fade, None);
        let a = read_frames(s.as_mut(), 44_100);
        let f = zero_cross_freq(&a[4410 * 2..], 2, 44_100);
        println!("nsf sub-song {sub}: {f:.1} Hz (expected {:.1}), rms {:.3}", nes_pulse_freq([253, 126][sub as usize]), rms(&a));
        assert!(rms(&a) > 0.05);
        freqs.push(f);
        // Muting pulse 1 silences it.
        s.set_voice_mask(1);
        let muted = read_frames(s.as_mut(), 4410);
        assert!(rms(&muted[441 * 2..]) < 0.01, "muted rms {}", rms(&muted));
    }
    assert!((freqs[0] - nes_pulse_freq(253)).abs() < 5.0, "{freqs:?}");
    assert!((freqs[1] - nes_pulse_freq(126)).abs() < 5.0, "{freqs:?}");
    assert!(open_memory(Family::Gme, nsf, "two.nsf", &opts(Some(2))).is_err(), "sub-song out of range");
}

#[test]
fn nezplug_playlist_sets_title_and_length() {
    let nsf = nsf_songs(&[253, 126], "Two Songs");
    let pl = vec!["#TITLE Two Songs\nTwo.nsf::NSF,2,High Note,0:12.500,,3\n".to_string()];
    let s = open_memory(Family::Gme, nsf, "Two.nsf", &OpenOptions { subsong: Some(1), playlists: pl }).unwrap();
    assert_eq!(s.meta().title.as_deref(), Some("High Note"));
    let h = s.length_hint().unwrap();
    assert_eq!(h.length, 12_500 * 44_100 / 1000);
    assert_eq!(h.fade, Some(3 * 44_100));
}

#[test]
fn vgm_loop_points_are_exact_and_the_emulator_wraps_by_itself() {
    // 1 s at 440 Hz, then a 0.5 s 880 Hz + 0.5 s 220 Hz loop body.
    let vgm = vgm_psg(&[(254, 44_100)], &[(127, 22_050), (508, 22_050)]);
    let mut s = open_memory(Family::Gme, vgm.clone(), "t.vgm", &opts(None)).unwrap();
    let l = s.loop_info().expect("loop info");
    assert_eq!((l.start, l.end), (44_100, 88_200));
    assert_eq!(s.duration(), Some(88_200));
    let pass1 = read_frames(s.as_mut(), 88_200);
    // Loop stage wraps here: a no-op for the emulator, which is already back at the loop start.
    assert_eq!(s.seek(l.start).unwrap(), l.start);
    let pass2 = read_frames(s.as_mut(), 44_100);
    let f = |x: &[f32]| zero_cross_freq(x, 2, 44_100);
    let (intro, a1, b1) = (f(&pass1[2205 * 2..44_100 * 2]), f(&pass1[46_305 * 2..66_150 * 2]), f(&pass1[68_355 * 2..88_200 * 2]));
    let (a2, b2) = (f(&pass2[2205 * 2..22_050 * 2]), f(&pass2[24_255 * 2..44_100 * 2]));
    println!("vgm: intro {intro:.1} Hz, body {a1:.1}/{b1:.1} Hz, second pass {a2:.1}/{b2:.1} Hz");
    assert!((intro - psg_freq(254)).abs() < 3.0);
    assert!((a1 - psg_freq(127)).abs() < 3.0 && (a2 - psg_freq(127)).abs() < 3.0);
    assert!((b1 - psg_freq(508)).abs() < 3.0 && (b2 - psg_freq(508)).abs() < 3.0);
    // A real seek into the body lands on the body.
    s.seek(66_150 + 1000).unwrap();
    let x = read_frames(s.as_mut(), 11_025);
    assert!((f(&x) - psg_freq(508)).abs() < 3.0);
    // Gzipped (VGZ) decodes the same.
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut gz, &vgm).unwrap();
    let vgz = gz.finish().unwrap();
    assert_eq!(detect(None, &vgz[..64], None), Some(Family::Gme));
    let s = open_memory(Family::Gme, vgz, "t.vgz", &opts(None)).unwrap();
    assert_eq!(s.loop_info(), Some(l));
    // Without a loop: a finite track, no fade.
    let s = open_memory(Family::Gme, vgm_psg(&[(254, 30_000)], &[]), "n.vgm", &opts(None)).unwrap();
    assert_eq!(s.loop_info(), None);
    assert_eq!(s.length_hint().map(|h| (h.length, h.fade)), Some((30_000, Some(0))));
}

#[test]
fn vgm_silence_plays_as_written() {
    let f = |x: &[f32]| zero_cross_freq(x, 2, 44_100);
    // 0.1 s tone, 8 s of silence, 1 s tone: libgme's silence detection ended the track 6 s into
    // the silence, so the last tone never played.
    let total = 4410 + 8 * 44_100 + 44_100;
    let vgm = vgm_psg(&[(254, 4410), (0, 8 * 44_100), (254, 44_100)], &[]);
    let mut s = open_memory(Family::Gme, vgm, "quiet.vgm", &opts(None)).unwrap();
    let a = read_frames(s.as_mut(), total);
    assert_eq!(a.len(), total * 2, "track ended early");
    let last = &a[(total - 44_100 + 2205) * 2..];
    assert!(rms(last) > 0.05 && (f(last) - psg_freq(254)).abs() < 3.0, "last tone: rms {}, {:.1} Hz", rms(last), f(last));
    // A silent first second: kept (not skipped), so the header's loop points land on the music.
    let vgm = vgm_psg(&[(0, 44_100), (254, 22_050)], &[(127, 22_050)]);
    let mut s = open_memory(Family::Gme, vgm, "late.vgm", &opts(None)).unwrap();
    let l = s.loop_info().unwrap();
    assert_eq!((l.start, l.end), (66_150, 88_200));
    let a = read_frames(s.as_mut(), 88_200);
    assert!(rms(&a[..44_000 * 2]) < 1e-3, "first second rms {}", rms(&a[..44_000 * 2]));
    let (intro, body) = (f(&a[46_305 * 2..66_150 * 2]), f(&a[68_355 * 2..]));
    assert!((intro - psg_freq(254)).abs() < 3.0 && (body - psg_freq(127)).abs() < 3.0, "intro {intro:.1} Hz, body {body:.1} Hz");
    assert_eq!(s.seek(l.start).unwrap(), l.start);
    let again = read_frames(s.as_mut(), 22_050);
    assert!((f(&again[2205 * 2..]) - psg_freq(127)).abs() < 3.0);
}

#[test]
fn module_loops_whole_song_and_mutes_channels() {
    let m = mod_square();
    assert_eq!(detect(None, &m, Some(m.len() as u64)), Some(Family::Openmpt));
    assert_eq!(detect(Some("mod"), &m, None), Some(Family::Openmpt));
    let mut s = open_memory(Family::Openmpt, m, "sq.mod", &opts(None)).unwrap();
    let l = s.loop_info().unwrap();
    // 64 rows * 6 ticks * 20 ms = 7.68 s at 48 kHz.
    assert_eq!(l.start, 0);
    assert!((l.end as i64 - 368_640).abs() <= 48, "loop end {}", l.end);
    assert_eq!(s.voice_count(), 4);
    assert_eq!(s.meta().title.as_deref(), Some("ghost square"));
    let a = read_frames(s.as_mut(), 48_000);
    assert!(rms(&a) > 0.02, "rms {}", rms(&a));
    // Past the song end the module keeps playing (repeat forever).
    s.seek(l.end).unwrap();
    s.seek(0).unwrap();
    let _ = read_frames(s.as_mut(), l.end as usize);
    assert_eq!(s.seek(l.start).unwrap(), l.start);
    assert!(rms(&read_frames(s.as_mut(), 48_000)) > 0.02);
    s.set_voice_mask(0xF);
    let _ = read_frames(s.as_mut(), 4800);
    assert!(rms(&read_frames(s.as_mut(), 4800)) < 0.002);
    // One song: any other index (including ones that are negative as C ints, -1 being libopenmpt's
    // "all sub-songs") is out of range.
    for sub in [1, i32::MAX as u32, 1 << 31, u32::MAX] {
        assert!(open_memory(Family::Openmpt, mod_square(), "sq.mod", &opts(Some(sub))).is_err(), "sub-song {sub}");
    }
}

#[test]
fn vgmstream_wav_loop_and_txth_companion_with_subsongs() {
    // .lwav with a smpl loop: vgmstream reports it and wraps by itself.
    let frames = square_frames(32_000, 500.0, 64_000, 12_000);
    let lwav = wav_pcm16(32_000, &frames, true, Some((16_000, 48_000)));
    assert_eq!(detect(Some("lwav"), &lwav, None), Some(Family::Vgmstream));
    let mut s = open_memory(Family::Vgmstream, lwav, "loop.lwav", &opts(None)).unwrap();
    assert_eq!(s.sample_rate(), 32_000);
    assert_eq!(s.channels(), 2);
    let l = s.loop_info().unwrap();
    assert_eq!((l.start, l.end), (16_000, 48_000));
    let first = read_frames(s.as_mut(), 48_000);
    assert_eq!(s.seek(16_000).unwrap(), 16_000);
    let again = read_frames(s.as_mut(), 1000);
    let exact = |i: usize| frames[i][0] as f32 / 32768.0;
    assert!((first[100 * 2] - exact(100)).abs() < 1e-4);
    for i in 0..1000 {
        assert!((again[i * 2] - exact(16_000 + i)).abs() < 1e-4, "frame {i} after wrap");
    }

    // Raw PCM + .txth (companion file) with two sub-songs, served from memory like an archive.
    let a = square_frames(22_050, 441.0, 22_050, 10_000);
    let b = square_frames(22_050, 882.0, 22_050, 10_000);
    let mut raw = Vec::new();
    for f in a.iter().chain(&b) {
        raw.extend_from_slice(&f[0].to_le_bytes());
    }
    // Two 1 s sub-songs stored back to back: TXTH "chunks", one per sub-song.
    let txth = "codec = PCM16LE\nchannels = 1\nsample_rate = 22050\nsubsong_count = 2\nchunk_start = 0\nchunk_count = 2\nchunk_size = 44100\nnum_samples = 22050\n";
    let mut opener = MemoryOpener::default();
    opener.insert("set/music.raw", Arc::from(raw));
    opener.insert("set/music.raw.txth", Arc::from(txth.as_bytes().to_vec()));
    let opener = Arc::new(opener);
    assert!(ghost_formats::vgmstream::is_extension_supported("raw"));
    let mut freqs = Vec::new();
    for sub in 0..2 {
        let mut s = VgmstreamSource::open("set/music.raw", opener.clone(), &opts(Some(sub))).unwrap();
        assert_eq!(s.duration(), Some(22_050));
        assert_eq!(s.meta().subsong_count, Some(2));
        let x = read_frames(&mut s, 22_050);
        assert_eq!(x.len(), 22_050);
        freqs.push(zero_cross_freq(&x, 1, 22_050));
    }
    println!("txth sub-songs: {freqs:?} Hz");
    assert!((freqs[0] - 441.0).abs() < 3.0 && (freqs[1] - 882.0).abs() < 3.0);
    // Past the end: rejected with the file's real count (read before the handle is freed; with
    // allocator scribbling, e.g. MallocScribble=1, a read after the free shows a garbage count).
    for sub in [2, 3, (i32::MAX - 1) as u32] {
        let e = VgmstreamSource::open("set/music.raw", opener.clone(), &opts(Some(sub))).err().expect("out of range");
        assert_eq!(e.message, format!("sub-song {sub} out of range (file has 2)"));
    }
    // Indices vgmstream can't represent (1-based C ints) never reach it: no overflow, no wrap to
    // the default sub-song.
    for sub in [i32::MAX as u32, u32::MAX] {
        let e = VgmstreamSource::open("set/music.raw", opener.clone(), &opts(Some(sub))).err().expect("out of range");
        assert_eq!(e.message, format!("sub-song {sub} out of range"));
    }
    // The other early returns release the handle too: a file vgmstream rejects, a missing one.
    let junk = Arc::new(MemoryOpener::single("junk.adx", vec![0x55; 4096]));
    assert!(VgmstreamSource::open("junk.adx", junk.clone(), &opts(None)).is_err());
    assert!(VgmstreamSource::open("missing.adx", junk, &opts(None)).is_err());
}

#[test]
fn seven_zip_sets_extract() {
    let vgm = vgm_psg(&[(254, 4410)], &[]);
    let mut w = sevenz_rust2::ArchiveWriter::new(Cursor::new(Vec::new())).unwrap();
    let names = ["Set/01 Intro.vgm", "Set/Set.m3u"];
    let datas: Vec<Vec<u8>> = vec![vgm.clone(), b"01 Intro.vgm\n".to_vec()];
    w.push_archive_entries(
        names.iter().map(|n| sevenz_rust2::ArchiveEntry::new_file(n)).collect(),
        datas.iter().map(|d| sevenz_rust2::SourceReader::new(Cursor::new(d.clone()))).collect(),
    )
    .unwrap();
    let bytes = w.finish().unwrap().into_inner();
    assert_eq!(archive::kind_of(&bytes), Some(archive::Kind::SevenZ));
    let l = archive::list(&bytes).unwrap();
    assert_eq!(l.iter().map(|e| (e.path.as_str(), e.size)).collect::<Vec<_>>(), vec![("Set/01 Intro.vgm", vgm.len() as u64), ("Set/Set.m3u", 13)]);
    let x = archive::extract_all(&bytes).unwrap();
    assert_eq!(&**x.find("01 intro.vgm").unwrap().1, &vgm[..]);
    assert_eq!(x.playlists(), vec![("Set/Set.m3u".to_string(), "01 Intro.vgm\n".to_string())]);
}

/// Real rip files (NSF/SPC/GBS/VGM sets, modules) from `GHOST_FORMATS_TEST_DIR`, if set.
#[test]
fn real_files() {
    let Some(dir) = std::env::var_os("GHOST_FORMATS_TEST_DIR") else {
        println!("GHOST_FORMATS_TEST_DIR not set: skipping real-file checks");
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    let mut checked = 0;
    let mut paths: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
    paths.sort();
    for p in paths {
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        let data = std::fs::read(&p).unwrap();
        let files: Vec<(String, Vec<u8>)> = if archive::kind_of(&data).is_some() {
            archive::extract_all(&data).unwrap().files.into_iter().map(|(n, d)| (n, d.to_vec())).collect()
        } else {
            vec![(name.clone(), data)]
        };
        let playlists: Vec<String> = files.iter().filter(|(n, _)| n.ends_with(".m3u")).map(|(_, d)| ghost_formats::decode_text(d)).collect();
        // First two decodable files per set.
        let mut in_set = 0;
        for (fname, d) in files {
            let ext = ghost_formats::extension_of(&fname);
            let Some(fam) = detect(ext.as_deref(), &d[..d.len().min(4096)], Some(d.len() as u64)) else { continue };
            if in_set == 2 {
                break;
            }
            in_set += 1;
            let t0 = std::time::Instant::now();
            let mut s = open_memory(fam, d, &fname, &OpenOptions { subsong: None, playlists: playlists.clone() }).unwrap_or_else(|e| panic!("{name}/{fname}: {e}"));
            let rate = s.sample_rate();
            let x = read_frames(s.as_mut(), rate as usize * 20);
            let m = s.meta();
            let secs = |f: u64| f as f64 / rate as f64;
            println!(
                "{name} / {fname}: {} {rate} Hz, title {:?}, loop {:?}, hint {:?}, voices {}, 20 s rms {:.3}, decoded in {:?}",
                fam.name(),
                m.title,
                s.loop_info().map(|l| (secs(l.start), secs(l.end))),
                s.length_hint().map(|h| (secs(h.length), h.fade.map(secs))),
                s.voice_count(),
                rms(&x),
                t0.elapsed()
            );
            assert!(rms(&x) > 0.001, "{fname} is silent");
            let len = s.loop_info().map(|l| l.end).or(s.length_hint().map(|h| h.length)).or(s.duration()).unwrap();
            assert!(secs(len) > 1.0 && secs(len) < 3600.0, "{fname}: implausible length {}", secs(len));
            checked += 1;
        }
    }
    println!("checked {checked} real files");
    assert!(checked > 0);
}

#[test]
fn brstm_pcm16_loops_sample_exact() {
    // Distinct L/R ramps so channel order and interleave blocks are checked too.
    let frames: Vec<[i16; 2]> = (0..65_536i32).map(|i| [((i * 7) % 20_000 - 10_000) as i16, ((i * 3) % 16_000 - 8_000) as i16]).collect();
    let brstm = brstm_pcm16(32_000, &frames, 20_000);
    assert_eq!(detect(Some("brstm"), &brstm, None), Some(Family::Vgmstream));
    let mut s = open_memory(Family::Vgmstream, brstm, "bgm.brstm", &opts(None)).unwrap();
    assert_eq!((s.sample_rate(), s.channels()), (32_000, 2));
    let l = s.loop_info().unwrap();
    assert_eq!((l.start, l.end), (20_000, 65_536));
    let a = read_frames(s.as_mut(), 65_536);
    assert_eq!(s.seek(l.start).unwrap(), l.start);
    let b = read_frames(s.as_mut(), 10_000);
    let v = |x: i16| x as f32 / 32768.0;
    for i in (0..65_536).step_by(97) {
        assert_eq!((a[i * 2], a[i * 2 + 1]), (v(frames[i][0]), v(frames[i][1])), "frame {i}");
    }
    for i in 0..10_000 {
        assert_eq!((b[i * 2], b[i * 2 + 1]), (v(frames[20_000 + i][0]), v(frames[20_000 + i][1])), "frame {i} after the wrap");
    }
}

// ------------------------------------------------------------------ malformed files (regressions)

/// Run `f` on its own thread; fail instead of hanging the suite if it doesn't finish in time.
fn within<T: Send + 'static>(secs: u64, what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(std::time::Duration::from_secs(secs)).unwrap_or_else(|_| panic!("{what}: still decoding after {secs} s (hang)"))
}

/// A v1.50 VGM: SN76489 (+ YM2612 at `ym2612_clock` if non-zero), `cmds` as the command stream,
/// looping back to command offset `loop_at` (relative to the stream start) if given.
fn raw_vgm(cmds: &[u8], total: u32, loop_at: Option<usize>, ym2612_clock: u32) -> Vec<u8> {
    let mut h = vec![0u8; 0x40];
    h[..4].copy_from_slice(b"Vgm ");
    h[0x04..0x08].copy_from_slice(&((0x40 + cmds.len() - 4) as u32).to_le_bytes());
    h[0x08..0x0C].copy_from_slice(&0x150u32.to_le_bytes());
    h[0x0C..0x10].copy_from_slice(&PSG_CLOCK.to_le_bytes());
    h[0x18..0x1C].copy_from_slice(&total.to_le_bytes());
    if let Some(l) = loop_at {
        h[0x1C..0x20].copy_from_slice(&((0x40 + l - 0x1C) as u32).to_le_bytes());
    }
    h[0x2C..0x30].copy_from_slice(&ym2612_clock.to_le_bytes());
    h[0x34..0x38].copy_from_slice(&0x0Cu32.to_le_bytes());
    h.extend_from_slice(cmds);
    h
}

/// Read up to `frames`, stopping at the end of the stream; never fails on decode errors.
fn drain(s: &mut dyn AudioSource, frames: usize) -> usize {
    let mut buf = vec![0f32; 1024 * s.channels()];
    let mut done = 0;
    while done < frames {
        match s.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => done += n,
        }
    }
    done
}

#[test]
fn vgm_loop_that_takes_no_time_ends_instead_of_hanging() {
    // 0.1 s of tone, then a loop offset pointing at the end command itself, or at a loop body
    // with no wait in it: libgme jumped back forever without advancing time.
    let tone = [0x50, 0x90, 0x50, 0x8E, 0x50, 0x0F, 0x61, 0x3A, 0x11]; // period 254, full volume
    let at_end = [&tone[..], &[0x66]].concat();
    let no_wait = [&tone[..], &[0x50, 0x9F, 0x66]].concat(); // the body only mutes the tone
    for vgm in [raw_vgm(&at_end, 4410, Some(tone.len()), 0), raw_vgm(&no_wait, 4410, Some(tone.len()), 0)] {
        let n = within(20, "zero-time VGM loop", move || {
            let mut s = open_memory(Family::Gme, vgm, "loop.vgm", &opts(None)).unwrap();
            drain(s.as_mut(), 44_100 * 3)
        });
        // The tone plays, then the track ends.
        assert!((4410..44_100 * 3).contains(&n), "{n} frames");
    }
}

#[test]
fn vgm_pcm_reads_stay_inside_the_file() {
    // A 4-byte YM2612 PCM bank, a seek to 2 GB past it, then 2000 "write PCM sample + wait"
    // commands: libgme read them from wherever that pointed (SIGSEGV).
    let mut cmds = vec![0x67, 0x66, 0x00, 4, 0, 0, 0, 0x80, 0x90, 0xA0, 0xB0];
    cmds.extend_from_slice(&[0xE0, 0xF0, 0xFF, 0xFF, 0x7F]);
    cmds.extend(std::iter::repeat_n(0x81, 2000));
    cmds.push(0x66);
    let vgm = raw_vgm(&cmds, 2000, None, 7_670_453);
    let n = within(20, "VGM PCM seek", move || {
        let mut s = open_memory(Family::Gme, vgm, "pcm.vgm", &opts(None)).unwrap();
        drain(s.as_mut(), 44_100)
    });
    assert!(n > 0);
}

#[test]
fn vgm_with_unusable_chip_clock_is_rejected() {
    // Clock 0 once the dual-chip / variant bits are masked off: the YM2612 core divided by it
    // (an endless loop on ARM). Absurd clocks made it hundreds of times slower than realtime.
    for clock in [0x8000_0000u32, 0xC000_0000, 0x1D61_1F50, 500] {
        let vgm = raw_vgm(&[0x61, 0x44, 0xAC, 0x66], 44_100, None, clock);
        let e = within(20, "VGM FM clock", move || open_memory(Family::Gme, vgm, "fm.vgm", &opts(None)).err()).expect("rejected");
        assert!(e.message.contains("YM2612 clock"), "{e}");
    }
    // An SN76489 at a few Hz: frames of zero clocks, so libgme never produced a sample.
    for psg in [1u32, 10] {
        let mut vgm = raw_vgm(&[0x61, 0x44, 0xAC, 0x66], 44_100, None, 0);
        vgm[0x0C..0x10].copy_from_slice(&psg.to_le_bytes());
        let e = within(20, "VGM PSG clock", move || open_memory(Family::Gme, vgm, "psg.vgm", &opts(None)).err()).expect("rejected");
        assert!(e.message.contains("SN76489 clock"), "{e}");
    }
    // Real clocks (and the dual-chip flag) are fine.
    for clock in [7_670_453u32, 0x4000_0000 | 7_600_489] {
        let vgm = raw_vgm(&[0x61, 0x44, 0xAC, 0x66], 44_100, None, clock);
        assert!(open_memory(Family::Gme, vgm, "fm.vgm", &opts(None)).is_ok());
    }
}

#[test]
fn gbs_code_running_off_the_top_of_memory_wraps() {
    // init: JP $FF80, into zeroed high RAM: NOPs up to $FFFF. The Game Boy core didn't wrap the
    // program counter and fetched opcodes through a page pointer read past its 9-entry table.
    let mut gbs = vec![0u8; 0x70];
    gbs[..3].copy_from_slice(b"GBS");
    gbs[3] = 1; // version
    gbs[4] = 1; // songs
    gbs[5] = 1; // first song
    gbs[6..8].copy_from_slice(&0x0400u16.to_le_bytes()); // load
    gbs[8..10].copy_from_slice(&0x0400u16.to_le_bytes()); // init
    gbs[10..12].copy_from_slice(&0x0403u16.to_le_bytes()); // play
    gbs[12..14].copy_from_slice(&0xFFFEu16.to_le_bytes()); // stack
    gbs.extend_from_slice(&[0xC3, 0x80, 0xFF, 0xC9]); // JP $FF80; play: RET
    let n = within(20, "GBS PC wrap", move || {
        let mut s = open_memory(Family::Gme, gbs, "wrap.gbs", &opts(None)).unwrap();
        drain(s.as_mut(), 44_100 * 3)
    });
    println!("gbs pc wrap: {n} frames");
}

/// A ZXAYEMUL file with one song (init at $8000, one 0x100-byte block at $8000 from `code`).
/// Pointers are big-endian and relative to their own position.
fn ay_file(code: &[u8]) -> Vec<u8> {
    let mut ay = vec![0u8; 0x36];
    ay[..8].copy_from_slice(b"ZXAYEMUL");
    let rel = |ay: &mut Vec<u8>, at: usize, to: usize| ay[at..at + 2].copy_from_slice(&((to as i32 - at as i32) as i16).to_be_bytes());
    rel(&mut ay, 0x0C, 0x34); // author
    rel(&mut ay, 0x0E, 0x34); // misc
    rel(&mut ay, 0x12, 0x14); // song table
    rel(&mut ay, 0x14, 0x34); // song name
    rel(&mut ay, 0x16, 0x18); // song data
    ay[0x18..0x1C].copy_from_slice(&[0, 1, 2, 3]);
    ay[0x1C..0x1E].copy_from_slice(&0x0100u16.to_be_bytes());
    rel(&mut ay, 0x22, 0x26); // points
    rel(&mut ay, 0x24, 0x2C); // blocks
    ay[0x26..0x28].copy_from_slice(&0xF000u16.to_be_bytes()); // stack
    ay[0x28..0x2A].copy_from_slice(&0x8000u16.to_be_bytes()); // init
    ay[0x2C..0x2E].copy_from_slice(&0x8000u16.to_be_bytes()); // block address
    ay[0x2E..0x30].copy_from_slice(&(code.len() as u16).to_be_bytes()); // block length
    rel(&mut ay, 0x30, 0x36); // block data
    ay[0x34] = b'x';
    ay.extend_from_slice(code);
    ay
}

#[test]
fn ay_blocks_must_lie_inside_the_file() {
    let code = [0xC9; 8];
    let open = |ay: Vec<u8>| within(20, "AY", move || open_memory(Family::Gme, ay, "t.ay", &opts(None)).map(|mut s| drain(s.as_mut(), 44_100)));
    assert!(open(ay_file(&code)).is_ok());
    // A null data pointer: libgme memcpy'd the block from NULL.
    let mut ay = ay_file(&code);
    ay[0x30..0x32].fill(0);
    let n = open(ay);
    println!("ay with a null block: {:?} frames", n.map_err(|e| e.message));
    // A song table claiming more bytes than the whole file: libgme's bounds check underflowed
    // and accepted it, then read the table past the end of the buffer.
    let mut ay = ay_file(&code);
    ay[0x10] = 200; // songs - 1: a 804-byte table in a 62-byte file
    let e = open(ay).expect_err("rejected");
    assert!(e.message.contains("Missing track data"), "{e}");
}

#[test]
fn nsfe_without_data_chunk_is_rejected() {
    // INFO then NEND, no DATA: libgme accepted it and ran the never-loaded NSF emulator.
    let mut nsfe = b"NSFE".to_vec();
    let mut chunk = |tag: &[u8], body: &[u8]| {
        nsfe.extend_from_slice(&(body.len() as u32).to_le_bytes());
        nsfe.extend_from_slice(tag);
        nsfe.extend_from_slice(body);
    };
    chunk(b"INFO", &[0x00, 0x80, 0x00, 0x80, 0x03, 0x80, 0, 0, 1, 0]);
    chunk(b"NEND", &[]);
    let r = within(20, "NSFE without DATA", move || open_memory(Family::Gme, nsfe, "nodata.nsfe", &opts(None)).err());
    assert!(r.as_ref().is_some_and(|e| e.message.contains("DATA")), "{r:?}");
}

#[test]
fn nezplug_line_plays_the_matched_track_when_the_file_name_has_a_comma() {
    // libgme ends a playlist file name at ", <digit>": it read "Set 1, 2.nsf::NSF,3" as track 2
    // and played the wrong song.
    let nsf = nsf_songs(&[253, 126, 80], "Three");
    let pl = vec!["Set 1, 2.nsf::NSF,3,Third,1:00,,5\n".to_string()];
    let mut s = open_memory(Family::Gme, nsf, "Set 1, 2.nsf", &OpenOptions { subsong: Some(2), playlists: pl }).unwrap();
    assert_eq!(s.meta().title.as_deref(), Some("Third"));
    let a = read_frames(s.as_mut(), 22_050);
    let f = zero_cross_freq(&a[4410 * 2..], 2, 44_100);
    assert!((f - nes_pulse_freq(80)).abs() < 5.0, "{f} Hz");
}

#[test]
fn fm_writes_to_a_vgm_without_fm_are_ignored() {
    // SN76489-only header (no YM2612 clock) with YM2612 register writes in the stream: libgme
    // passed them to a chip that was never set up whenever its (uninitialised) FM clock offset
    // made the write time negative. Uninitialised memory is often zero in a fresh process: run
    // with MallocPreScribble=1 (macOS) to make the old crash deterministic.
    let mut cmds = vec![0x50, 0x90, 0x50, 0x8E, 0x50, 0x0F];
    for r in 0..64u8 {
        cmds.extend_from_slice(&[0x52, 0x30 + r, 0x55, 0x53, 0x30 + r, 0x55, 0x61, 0x44, 0x01]);
    }
    cmds.push(0x66);
    let vgm = raw_vgm(&cmds, 64 * 0x144, None, 0);
    for _ in 0..20 {
        let vgm = vgm.clone();
        let n = within(20, "VGM stray FM", move || {
            let mut s = open_memory(Family::Gme, vgm, "stray.vgm", &opts(None)).unwrap();
            drain(s.as_mut(), 44_100)
        });
        assert!(n > 0);
    }
}
