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
