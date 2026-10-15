//! Builds the vendored C/C++ decoders (native/vendor) into static archives with the `cc` crate,
//! so `ghost.node` carries them with no runtime dylib dependencies:
//!
//! | library            | version | licence        | used for                                     |
//! |--------------------|---------|----------------|----------------------------------------------|
//! | libgme             | 0.6.5   | LGPL-2.1+      | NSF/NSFE, SPC, GBS, VGM/VGZ, HES, KSS, AY, SAP, GYM |
//! | vgmstream          | r2117   | ISC-style      | ADX, HCA, BRSTM/BCSTM/BFSTM, FSB, WEM, ...   |
//! | libvorbis + libogg | 1.3.7 / 1.3.5 | BSD-3    | Vorbis-based vgmstream formats (FSB5, Wwise, OGG loops) |
//! | libopenmpt         | 0.8.9   | BSD-3          | MOD/XM/IT/S3M/UMX/MO3/...                    |
//!
//! Sources are release tarballs, trimmed to the library code (no players, plugins or prebuilt
//! binaries). Everything is compiled with optimisation even in dev builds: the emulators are
//! unusably slow at -O0/-O1, and nobody steps through them. A few fixes for crashes and hangs on
//! malformed files are applied to copies at build time ([`GME_PATCHES`]); the tree stays pristine.

use std::path::{Path, PathBuf};

fn vendor() -> PathBuf {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vendor").canonicalize().expect("native/vendor missing");
    // On Windows canonicalize() returns the verbatim `\\?\C:\...` form, which cl.exe can't open.
    match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(s) if !s.starts_with("UNC") => PathBuf::from(s),
        _ => p,
    }
}

fn files_in(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some(ext))
        .collect();
    v.sort();
    v
}

/// Fixes for crashes / hangs on malformed files in the vendored sources, as `(file, [(find,
/// replace)])`. They are applied to a copy under OUT_DIR, so native/vendor stays an untouched
/// release tarball, and each `find` must occur exactly once (a vendor upgrade that moves the code
/// fails the build instead of silently dropping a fix). None of them changes the output for
/// well-formed files.
const GME_PATCHES: &[(&str, &[(&str, &str)])] = &[
    // The CPU cores keep the program counter in a wider integer and never wrap it at 16 bits:
    // code that runs off the top of memory indexes past the 9-entry page table (reading
    // whatever follows as a page pointer: SIGSEGV). Real hardware wraps. (The NES core already
    // uses a uint16_t; HES uses uint_fast16_t, which is only 16 bits wide on some platforms.)
    ("Gb_Cpu.cpp", &[("\tuint8_t const* instr = s.code_map [pc >> page_shift];", "\tpc &= 0xFFFF;\n\tuint8_t const* instr = s.code_map [pc >> page_shift];")]),
    ("Kss_Cpu.cpp", &[("\tuint8_t const* instr = s.read [pc >> page_shift];", "\tpc &= 0xFFFF;\n\tuint8_t const* instr = s.read [pc >> page_shift];")]),
    ("Hes_Cpu.cpp", &[("\tuint8_t const* instr = s.code_map [pc >> page_shift];", "\tpc &= 0xFFFF;\n\tuint8_t const* instr = s.code_map [pc >> page_shift];")]),
    (
        "Ay_Emu.cpp",
        &[
            // get_data()'s bounds check underflows when the block needs more bytes than the whole
            // file holds (`file_size - min_size` < 0, compared as unsigned): a song table or data
            // block claiming more than the file has was accepted, then read past the buffer.
            (
                "\tif ( !offset || uint32_t (pos + offset) > uint32_t (file_size - min_size) )",
                "\tif ( !offset || file_size < min_size || uint32_t (pos + offset) > uint32_t (file_size - min_size) )",
            ),
            // A data block whose data pointer is 0 or out of range: get_data() returns NULL,
            // which was then memcpy'd from.
            (
                "\t\tbyte const* in = get_data( file, blocks, 0 ); blocks += 2;\n",
                "\t\tbyte const* in = get_data( file, blocks, 0 ); blocks += 2;\n\t\tif ( !in )\n\t\t{\n\t\t\tset_warning( \"Missing file data\" );\n\t\t\tbreak;\n\t\t}\n",
            ),
            // The selected AY register was never initialised: a write to the data port before
            // any register select wrote `regs [garbage]` (heap corruption, SIGBUS).
            ("\tcpc_latch     = 0;\n", "\tcpc_latch     = 0;\n\tapu_addr      = 0;\n"),
        ],
    ),
    // A frame of zero clocks (an absurdly low chip clock from the file, e.g. a VGM's SN76489)
    // produces no samples, so play_() looped forever (the assert that caught it is compiled out).
    ("Classic_Emu.cpp", &[("\t\t\tassert( clocks_emulated );\n", "\t\t\tif ( !clocks_emulated )\n\t\t\t\treturn \"Emulation error (empty frame)\";\n")]),
    // The Nuked OPN2 state was allocated uninitialised (OPN2_Reset only runs once a clock is
    // set): value-initialise it, so nothing ever runs on garbage indices.
    ("Ym2612_Nuked.cpp", &[("\timpl = new Ym2612_NukedImpl::ym3438_t;", "\timpl = new Ym2612_NukedImpl::ym3438_t();")]),
    // GYM frames are scanned up to their terminating 0 byte with no end-of-data check: a
    // truncated file (last frame without its 0) was read past the end of the buffer.
    (
        "Gym_Emu.cpp",
        &[
            (
                "\tint cmd;\n\twhile ( (cmd = *p++) != 0 )\n\t{\n\t\tint data = *p++;\n",
                "\tint cmd;\n\twhile ( p < data_end && (cmd = *p++) != 0 )\n\t{\n\t\tif ( data_end - p < (cmd <= 2 ? 2 : 1) )\n\t\t\tbreak;\n\t\tint data = *p++;\n",
            ),
            (
                "\tint cmd;\n\twhile ( (cmd = *pos++) != 0 )\n\t{\n\t\tint data = *pos++;\n",
                "\tint cmd;\n\twhile ( pos < data_end && (cmd = *pos++) != 0 )\n\t{\n\t\tif ( data_end - pos < (cmd <= 2 ? 2 : 1) )\n\t\t{\n\t\t\tpos = data_end;\n\t\t\tbreak;\n\t\t}\n\t\tint data = *pos++;\n",
            ),
        ],
    ),
    // An NSFE whose NEND chunk comes without a DATA chunk loaded "successfully" with the NSF
    // emulator never initialised: playing it ran on uninitialised state (hangs, wild jumps).
    (
        "Nsfe_Emu.cpp",
        &[(
            "\t\t\tcase BLARGG_4CHAR('D','N','E','N'):\n\t\t\t\tcheck( phase == 2 );\n",
            "\t\t\tcase BLARGG_4CHAR('D','N','E','N'):\n\t\t\t\tif ( phase != 2 )\n\t\t\t\t\treturn \"Corrupt file (no DATA chunk)\";\n",
        )],
    ),
    (
        "Vgm_Emu_Impl.cpp",
        &[
            // A loop body that takes no time (loop offset pointing at the end command, or a body
            // without waits) made run_commands spin forever: end the track instead.
            (
                "\tbyte const* pos = this->pos;\n",
                "\tbyte const* pos = this->pos;\n\tbool looped = false;\n\tvgm_time_t loop_time = 0;\n",
            ),
            (
                "\t\tcase cmd_end:\n\t\t\tpos = loop_begin;",
                "\t\tcase cmd_end:\n\t\t\tif ( looped && vgm_time == loop_time ) { pos = data_end; break; }\n\t\t\tlooped = true;\n\t\t\tloop_time = vgm_time;\n\t\t\tpos = loop_begin;",
            ),
            // A disabled FM chip (no clock in the header) still accepted register writes when the
            // FM time came out negative, and that is often: fm_time_offset is only initialised when
            // the file uses FM. A stray YM2612 command in a PSG-only VGM then wrote into a chip
            // that was never reset (uninitialised write-buffer index: heap corruption).
            (
                "\tint count = time - last_time;\n\tif ( count > 0 )\n\t{\n\t\tif ( last_time < 0 )\n\t\t\treturn false;\n",
                "\tif ( last_time < 0 )\n\t\treturn false;\n\tint count = time - last_time;\n\tif ( count > 0 )\n\t{\n",
            ),
            // The PCM bank position comes from the file (0xE0 seeks, 0x8n reads): never read
            // outside the file data.
            (
                "\t\t\t\t\twrite_pcm( vgm_time, *pcm_pos++ );",
                "\t\t\t\t\tif ( pcm_pos >= data && pcm_pos < data_end )\n\t\t\t\t\t\twrite_pcm( vgm_time, *pcm_pos );\n\t\t\t\t\tpcm_pos++;",
            ),
        ],
    ),
];

/// `src` with `patches` applied, written under `out` (or `src` itself if there are none).
fn patched(out: &Path, src: &Path, patches: &[(&str, &[(&str, &str)])]) -> PathBuf {
    let name = src.file_name().unwrap().to_string_lossy().into_owned();
    let Some((_, fixes)) = patches.iter().find(|(f, _)| *f == name) else { return src.to_path_buf() };
    // Patches are written with \n line ends; a Windows checkout may have converted them to \r\n.
    let mut text = std::fs::read_to_string(src).unwrap_or_else(|e| panic!("read {}: {e}", src.display())).replace("\r\n", "\n");
    for (find, replace) in fixes.iter() {
        assert_eq!(text.matches(find).count(), 1, "patch for {name} no longer applies: {find:?}");
        text = text.replacen(find, replace, 1);
    }
    std::fs::create_dir_all(out).unwrap();
    let dst = out.join(&name);
    std::fs::write(&dst, text).unwrap();
    dst
}

/// MSVC (Windows) spells the language and codegen flags differently from GCC / Clang.
fn msvc() -> bool {
    std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
}

fn base(cpp: bool) -> cc::Build {
    let mut b = cc::Build::new();
    b.cpp(cpp).opt_level(2).debug(false).warnings(false).extra_warnings(false).pic(true);
    b.flag_if_supported("-w");
    // Release builds of the libraries, as their own build systems make them: libgme is full of
    // `assert`s (some on emulation state that malformed files can reach), and a failed assert
    // aborts the whole process (the Electron app). Decoded output is identical either way.
    b.define("NDEBUG", None);
    b
}

fn main() {
    let v = vendor();
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    // Build the C/C++ objects for the same minimum macOS as rustc links for (its default is
    // 11.0); otherwise cc picks the SDK version and ld warns about every object.
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") && std::env::var_os("MACOSX_DEPLOYMENT_TARGET").is_none() {
        std::env::set_var("MACOSX_DEPLOYMENT_TARGET", "11.0");
    }
    let gen = out.join("include");
    std::fs::create_dir_all(gen.join("ogg")).unwrap();
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", v.display());

    // ---------------------------------------------------------------- vgmstream (+ libogg/libvorbis)
    std::fs::write(
        gen.join("ogg/config_types.h"),
        "#ifndef __CONFIG_TYPES_H__\n#define __CONFIG_TYPES_H__\n#include <stdint.h>\n\
         typedef int16_t ogg_int16_t;\ntypedef uint16_t ogg_uint16_t;\ntypedef int32_t ogg_int32_t;\n\
         typedef uint32_t ogg_uint32_t;\ntypedef int64_t ogg_int64_t;\ntypedef uint64_t ogg_uint64_t;\n#endif\n",
    )
    .unwrap();
    let ogg = v.join("libogg-1.3.5");
    let vorbis = v.join("libvorbis-1.3.7");
    let vgm = v.join("vgmstream-r2117");
    let src = vgm.join("src");
    let mut b = base(false);
    b.include(&src)
        .include(src.join("base"))
        .include(src.join("coding"))
        .include(src.join("layout"))
        .include(src.join("meta"))
        .include(src.join("util"))
        .include(vgm.join("ext_includes"))
        .include(&gen)
        .include(ogg.join("include"))
        .include(vorbis.join("include"))
        .define("VGM_USE_VORBIS", None)
        // G.722.1 (Namco BNSF, ...) is decoded by code inside vgmstream: no external library.
        .define("VGM_USE_G7221", None)
        .define("VGMSTREAM_VERSION", Some("\"r2117\""))
        // vgmstream's minimp3 (Ubi MPEG) and libopenmpt's minimp3 export the same names.
        .define("mp3dec_init", Some("ghost_vgm_mp3dec_init"))
        .define("mp3dec_decode_frame", Some("ghost_vgm_mp3dec_decode_frame"))
        .define("mp3dec_f32_to_s16", Some("ghost_vgm_mp3dec_f32_to_s16"));
    b.files(files_in(&src, "c"));
    for d in ["base", "coding", "coding/libs", "layout", "meta", "util"] {
        b.files(files_in(&src.join(d), "c"));
    }
    b.compile("ghost_vgmstream");

    // libvorbis after vgmstream: static archives must follow their users for GNU ld.
    let mut b = base(false);
    b.include(&gen).include(ogg.join("include")).include(vorbis.join("include")).include(vorbis.join("lib"));
    b.files(files_in(&ogg.join("src"), "c"));
    for f in files_in(&vorbis.join("lib"), "c") {
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        // Encoder and standalone tools are not needed for decoding.
        if !matches!(name.as_str(), "psytune.c" | "tone.c" | "barkmel.c" | "vorbisenc.c") {
            b.file(f);
        }
    }
    b.compile("ghost_vorbis");

    // ---------------------------------------------------------------- libgme
    let gme = v.join("libgme-0.6.5");
    std::fs::write(
        gen.join("gen_types.h"),
        "#ifndef GME_TYPES_H\n#define GME_TYPES_H\n#define USE_GME_AY\n#define USE_GME_GBS\n#define USE_GME_GYM\n\
         #define USE_GME_HES\n#define USE_GME_KSS\n#define USE_GME_NSF\n#define USE_GME_NSFE\n#define USE_GME_SAP\n\
         #define USE_GME_SPC\n#define USE_GME_VGM\n#endif\n",
    )
    .unwrap();
    // YM2612 (Mega Drive FM): Nuked OPN2 is cycle-accurate (and LGPL) but costs ~30-40x realtime
    // per core, which makes long backward seeks in Genesis VGMs slow; the `ym2612-gens` feature
    // swaps in the much faster, less accurate GENS core (also LGPL).
    let gens = std::env::var_os("CARGO_FEATURE_YM2612_GENS").is_some();
    let mut b = base(true);
    b.include(&gen)
        .include(gme.join("gme"))
        .define("GEN_TYPES_H", None)
        .define("BLARGG_LITTLE_ENDIAN", Some("1"))
        .define(if gens { "VGM_YM2612_GENS" } else { "VGM_YM2612_NUKED" }, None);
    if msvc() {
        // C++14 is MSVC's oldest language mode, and it has no -fwrapv switch.
        b.std("c++14").flag("/GR-");
    } else {
        b.std("c++11").flag("-fwrapv").flag("-fno-exceptions").flag("-fno-rtti");
    }
    let skip = if gens { ["Ym2612_Nuked.cpp", "Ym2612_MAME.cpp"] } else { ["Ym2612_GENS.cpp", "Ym2612_MAME.cpp"] };
    for f in files_in(&gme.join("gme"), "cpp") {
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        // The MAME core is GPL: never built.
        if !skip.contains(&name.as_str()) {
            b.file(patched(&out.join("patched/gme"), &f, GME_PATCHES));
        }
    }
    b.compile("ghost_gme_cpp");
    let mut b = base(false);
    b.include(gme.join("gme/ext")).file(gme.join("gme/ext/emu2413.c"));
    b.compile("ghost_gme_c");

    // ---------------------------------------------------------------- libopenmpt
    let mpt = v.join("libopenmpt-0.8.9");
    let defs: &[(&str, Option<&str>)] = &[
        ("LIBOPENMPT_BUILD", None),
        ("MPT_WITH_MINIZ", None),
        ("MPT_WITH_MINIMP3", None),
        ("MPT_WITH_STBVORBIS", None),
        ("STB_VORBIS_NO_PULLDATA_API", None),
        ("STB_VORBIS_NO_STDIO", None),
    ];
    let mut b = base(true);
    b.include(mpt.join("src")).include(mpt.join("common")).include(&mpt).include(mpt.join("include"));
    for (k, val) in defs {
        b.define(k, *val);
    }
    b.std("c++17");
    if msvc() {
        b.flag("/EHsc").flag("/GR").flag("/bigobj");
    } else {
        b.flag("-fexceptions").flag("-frtti");
    }
    b.files(files_in(&mpt.join("common"), "cpp"));
    b.files(files_in(&mpt.join("soundlib"), "cpp"));
    b.files(files_in(&mpt.join("soundlib/plugins"), "cpp"));
    b.files(files_in(&mpt.join("soundlib/plugins/dmo"), "cpp"));
    b.files(files_in(&mpt.join("sounddsp"), "cpp"));
    for f in ["libopenmpt_c.cpp", "libopenmpt_cxx.cpp", "libopenmpt_impl.cpp", "libopenmpt_ext_impl.cpp"] {
        b.file(mpt.join("libopenmpt").join(f));
    }
    b.compile("ghost_openmpt_cpp");
    let mut b = base(false);
    b.include(mpt.join("include"));
    for (k, val) in defs {
        b.define(k, *val);
    }
    b.file(mpt.join("include/miniz/miniz.c"))
        .file(mpt.join("include/minimp3/minimp3.c"))
        .file(mpt.join("include/stb_vorbis/stb_vorbis.c"));
    b.compile("ghost_openmpt_c");

    println!("cargo:include={}", gen.display());
}
