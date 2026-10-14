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
//! unusably slow at -O0/-O1, and nobody steps through them.

use std::path::{Path, PathBuf};

fn vendor() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vendor").canonicalize().expect("native/vendor missing")
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

fn base(cpp: bool) -> cc::Build {
    let mut b = cc::Build::new();
    b.cpp(cpp).opt_level(2).debug(false).warnings(false).extra_warnings(false).pic(true);
    b.flag_if_supported("-w");
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
        .define(if gens { "VGM_YM2612_GENS" } else { "VGM_YM2612_NUKED" }, None)
        .flag("-std=c++11")
        .flag("-fwrapv")
        .flag("-fno-exceptions")
        .flag("-fno-rtti");
    let skip = if gens { ["Ym2612_Nuked.cpp", "Ym2612_MAME.cpp"] } else { ["Ym2612_GENS.cpp", "Ym2612_MAME.cpp"] };
    for f in files_in(&gme.join("gme"), "cpp") {
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        // The MAME core is GPL: never built.
        if !skip.contains(&name.as_str()) {
            b.file(f);
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
        ("NDEBUG", None),
    ];
    let mut b = base(true);
    b.include(mpt.join("src")).include(mpt.join("common")).include(&mpt).include(mpt.join("include"));
    for (k, val) in defs {
        b.define(k, *val);
    }
    b.flag("-std=c++17").flag("-fexceptions").flag("-frtti");
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
