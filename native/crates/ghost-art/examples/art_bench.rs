//! Timing / memory harness for the art pipeline (a dev tool, not a test).
//!
//! ```text
//! cargo run --release -p ghost-art --example art_bench -- gen <dir>              # add synthetic inputs to <dir>
//! cargo run --release -p ghost-art --example art_bench -- run <dir> [--save <out>] [--filter s] [--threads N]
//! cargo run --release -p ghost-art --example art_bench -- compare <outA> <outB>  # PSNR + accent diff of two saved runs
//! ```
//!
//! `run` mirrors the calls `src/main/net/art-protocol.ts` makes: `base` (storeBase: ≤ 1600 px,
//! passthrough ≤ 1.5 MB, accent), `vN` (loadVariant: bucket N, no accent) and `accent`
//! (`artAccent` on the same bytes). Times are best-of-N; `peak` is the heap high-water mark of one
//! call above what was live before it (a counting global allocator).

use std::alloc::{GlobalAlloc, Layout, System};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use ghost_art::{accent_of, hex, process, ArtOptions};

struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            let now = CUR.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(l) };
        if !p.is_null() {
            let now = CUR.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        CUR.fetch_sub(l.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, new) };
        if !q.is_null() {
            if new > l.size() {
                let now = CUR.fetch_add(new - l.size(), Ordering::Relaxed) + (new - l.size());
                PEAK.fetch_max(now, Ordering::Relaxed);
            } else {
                CUR.fetch_sub(l.size() - new, Ordering::Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static A: Counting = Counting;

/// Heap high-water mark of `f` above the bytes live before it, in bytes.
fn peak_of<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let before = CUR.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    let v = f();
    (v, PEAK.load(Ordering::Relaxed).saturating_sub(before))
}

/// Best-of-N wall time in ms (min is the most stable statistic on a busy machine), after a warm-up.
fn best_ms<T>(mut f: impl FnMut() -> T) -> (f64, T) {
    let mut best = (f64::INFINITY, f());
    let start = Instant::now();
    let mut n = 0;
    while n < 5 || (start.elapsed().as_secs_f64() < 0.4 && n < 60) {
        let t = Instant::now();
        let v = f();
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        if ms < best.0 {
            best = (ms, v);
        }
        n += 1;
    }
    best
}

fn base_opts() -> ArtOptions {
    ArtOptions { max_width: 1600, max_height: 3200, quality: 85, passthrough_max_bytes: 1_500_000, accent: true, ..Default::default() }
}

fn variant_opts(b: u32) -> ArtOptions {
    ArtOptions { max_width: b, max_height: b * 2, quality: 85, ..Default::default() }
}

fn ext(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    }
}

fn inputs(dir: &Path, filter: Option<&str>) -> Vec<(String, Vec<u8>)> {
    let mut v: Vec<_> = std::fs::read_dir(dir)
        .expect("corpus dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && ghost_art::sniff(&std::fs::read(p).unwrap_or_default()).is_some())
        .filter(|p| filter.is_none_or(|f| p.file_name().unwrap().to_string_lossy().contains(f)))
        .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap()))
        .collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

fn run(dir: &Path, save: Option<&Path>, filter: Option<&str>) {
    if let Some(s) = save {
        std::fs::create_dir_all(s).unwrap();
    }
    let mut accents = String::new();
    println!(
        "{:<26} {:>9} {:>7} {:>9} | {:>8} {:>7} {:>7} {:>7} {:>7} | {:>8} {:>9} {:>8}",
        "input", "src", "KB", "scenario", "total", "decode", "resize", "accent", "encode", "peak MB", "out", "out KB"
    );
    for (name, bytes) in inputs(dir, filter) {
        let base = match process(&bytes, &base_opts()) {
            Ok(o) => o,
            Err(e) => {
                println!("{name:<26} error: {e}");
                continue;
            }
        };
        let src = format!("{}x{}", base.source_width, base.source_height);
        let mut scen: Vec<(String, ArtOptions)> = vec![("base".into(), base_opts())];
        for b in [1024u32, 512, 256, 128] {
            if base.source_width > b || base.source_height > 2 * b {
                scen.push((format!("v{b}"), variant_opts(b)));
            }
        }
        for (label, o) in &scen {
            let (out, peak) = peak_of(|| process(&bytes, o).unwrap());
            // Best-of-N total; the stage breakdown is from that same call.
            let (ms, best) = best_ms(|| process(&bytes, o).unwrap());
            let t = best.timings;
            println!(
                "{name:<26} {src:>9} {:>7} {label:>9} | {ms:>8.2} {:>7.2} {:>7.2} {:>7.2} {:>7.2} | {:>8.1} {:>9} {:>8}{}",
                bytes.len() / 1024,
                t.decode_us as f64 / 1000.0,
                t.resize_us as f64 / 1000.0,
                t.accent_us as f64 / 1000.0,
                t.encode_us as f64 / 1000.0,
                peak as f64 / 1048576.0,
                format!("{}x{}", out.width, out.height),
                out.data.len() / 1024,
                if out.passthrough { " pt" } else { "" },
            );
            if let Some(s) = save {
                std::fs::write(s.join(format!("{name}.{label}.{}", ext(out.mime))), &out.data).unwrap();
                accents.push_str(&format!("{name} {label} {}\n", out.accent.map_or("none".into(), hex)));
            }
        }
        let (a, peak) = peak_of(|| accent_of(&bytes).unwrap());
        let (ms, _) = best_ms(|| accent_of(&bytes).unwrap());
        println!(
            "{name:<26} {src:>9} {:>7} {:>9} | {ms:>8.2} {:>7} {:>7} {:>7} {:>7} | {:>8.1} {:>9} {:>8}",
            bytes.len() / 1024,
            "accent",
            "",
            "",
            "",
            "",
            peak as f64 / 1048576.0,
            a.map_or("none".into(), hex),
            ""
        );
        accents.push_str(&format!("{name} accent_of {}\n", a.map_or("none".into(), hex)));
    }
    if let Some(s) = save {
        std::fs::write(s.join("accents.txt"), accents).unwrap();
    }
}

/// All inputs' `base` calls on `threads` threads at once, `rounds` times: throughput and peak heap.
fn throughput(dir: &Path, threads: usize, filter: Option<&str>) {
    let inputs = std::sync::Arc::new(inputs(dir, filter));
    let rounds = 4;
    let ((), peak) = peak_of(|| {
        let t = Instant::now();
        let hs: Vec<_> = (0..threads)
            .map(|i| {
                let inputs = inputs.clone();
                std::thread::spawn(move || {
                    let mut n = 0;
                    for r in 0..rounds {
                        for (k, (_, b)) in inputs.iter().enumerate() {
                            if (k + r) % threads == i {
                                let _ = process(b, &base_opts());
                                n += 1;
                            }
                        }
                    }
                    n
                })
            })
            .collect();
        let n: usize = hs.into_iter().map(|h| h.join().unwrap()).sum();
        let s = t.elapsed().as_secs_f64();
        println!("{threads} threads: {n} base calls in {:.0} ms = {:.1} images/s", s * 1000.0, n as f64 / s);
    });
    println!("peak heap {:.1} MB", peak as f64 / 1048576.0);
}

fn psnr(a: &image::DynamicImage, b: &image::DynamicImage) -> f64 {
    let (a, b) = (a.to_rgba8(), b.to_rgba8());
    let mut se = 0f64;
    for (x, y) in a.as_raw().iter().zip(b.as_raw()) {
        let d = *x as f64 - *y as f64;
        se += d * d;
    }
    let mse = se / a.as_raw().len() as f64;
    if mse == 0.0 {
        f64::INFINITY
    } else {
        10.0 * (255.0f64 * 255.0 / mse).log10()
    }
}

fn compare(a: &Path, b: &Path) {
    let mut names: Vec<PathBuf> = std::fs::read_dir(a).unwrap().filter_map(|e| e.ok().map(|e| e.path())).collect();
    names.sort();
    let mut worst = f64::INFINITY;
    for pa in names {
        let n = pa.file_name().unwrap().to_string_lossy().into_owned();
        if n == "accents.txt" {
            continue;
        }
        let pb = b.join(&n);
        let (Ok(da), Ok(db)) = (std::fs::read(&pa), std::fs::read(&pb)) else {
            println!("{n:<44} missing in {}", b.display());
            continue;
        };
        let (ia, ib) = (image::load_from_memory(&da).unwrap(), image::load_from_memory(&db).unwrap());
        if (ia.width(), ia.height()) != (ib.width(), ib.height()) {
            println!("{n:<44} size {}x{} vs {}x{}", ia.width(), ia.height(), ib.width(), ib.height());
            continue;
        }
        let p = psnr(&ia, &ib);
        worst = worst.min(p);
        println!("{n:<44} PSNR {p:>6.2} dB   {:>7} → {:>7} bytes{}", da.len(), db.len(), if da == db { "  (identical)" } else { "" });
    }
    println!("worst PSNR {worst:.2} dB");
    let read = |p: &Path| std::fs::read_to_string(p.join("accents.txt")).unwrap_or_default();
    let (ta, tb) = (read(a), read(b));
    let mut diffs = 0;
    for (la, lb) in ta.lines().zip(tb.lines()) {
        if la != lb {
            diffs += 1;
            println!("accent: {la}  →  {lb}");
        }
    }
    println!("{diffs} accent differences of {}", ta.lines().count());
}

/// Synthetic extras: progressive / 4:4:4 / CMYK / greyscale / EXIF-rotated JPEGs, a static GIF and
/// a lossless WebP, all derived from the first large JPEG in the directory.
fn gen(dir: &Path) {
    let src = inputs(dir, Some("sonoma_3000.jpg")).pop().expect("needs sonoma_3000.jpg in the corpus").1;
    let img = image::load_from_memory(&src).unwrap().to_rgb8();
    let (w, h) = (img.width(), img.height());
    let enc = |name: &str, f: &dyn Fn(&mut jpeg_encoder::Encoder<&mut Vec<u8>>), data: &[u8], ct: jpeg_encoder::ColorType| {
        let mut out = Vec::new();
        let mut e = jpeg_encoder::Encoder::new(&mut out, 90);
        f(&mut e);
        e.encode(data, w as u16, h as u16, ct).unwrap();
        std::fs::write(dir.join(name), out).unwrap();
    };
    enc("syn_progressive_3000.jpg", &|e| e.set_progressive(true), img.as_raw(), jpeg_encoder::ColorType::Rgb);
    enc("syn_444_3000.jpg", &|e| e.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_4_4), img.as_raw(), jpeg_encoder::ColorType::Rgb);
    let cmyk: Vec<u8> = img.as_raw().as_chunks::<3>().0.iter().flat_map(|p| {
        let k = 255 - p[0].max(p[1]).max(p[2]);
        [255 - p[0] - k, 255 - p[1] - k, 255 - p[2] - k, k].map(|c| 255 - c)
    }).collect();
    enc("syn_cmyk_3000.jpg", &|_| {}, &cmyk, jpeg_encoder::ColorType::Cmyk);
    let grey: Vec<u8> = img.as_raw().as_chunks::<3>().0.iter().map(|p| ((p[0] as u32 * 3 + p[1] as u32 * 6 + p[2] as u32) / 10) as u8).collect();
    enc("syn_grey_3000.jpg", &|_| {}, &grey, jpeg_encoder::ColorType::Luma);
    let exif: [u8; 26] = [b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
    enc("syn_rot90_3000.jpg", &|e| e.add_exif_metadata(&exif).unwrap(), img.as_raw(), jpeg_encoder::ColorType::Rgb);

    let small = image::imageops::resize(&img, 1000, 1000, image::imageops::FilterType::Triangle);
    let mut gif = Vec::new();
    {
        let mut e = image::codecs::gif::GifEncoder::new_with_speed(&mut gif, 30);
        e.encode_frame(image::Frame::new(image::DynamicImage::ImageRgb8(small.clone()).to_rgba8())).unwrap();
    }
    std::fs::write(dir.join("syn_static_1000.gif"), gif).unwrap();
    let mid = image::imageops::resize(&img, 1500, 1500, image::imageops::FilterType::Triangle);
    let mut webp = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
        .encode(mid.as_raw(), 1500, 1500, image::ExtendedColorType::Rgb8)
        .unwrap();
    std::fs::write(dir.join("syn_lossless_1500.webp"), webp).unwrap();
    println!("wrote synthetic inputs to {}", dir.display());
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str);
    match args.first().map(String::as_str) {
        Some("gen") => gen(Path::new(&args[1])),
        Some("run") => {
            let dir = Path::new(&args[1]);
            match flag("--threads").map(|t| t.parse::<usize>().unwrap()) {
                Some(n) => throughput(dir, n, flag("--filter")),
                None => run(dir, flag("--save").map(Path::new), flag("--filter")),
            }
        }
        Some("compare") => compare(Path::new(&args[1]), Path::new(&args[2])),
        _ => eprintln!("usage: art_bench gen <dir> | run <dir> [--save <out>] [--filter s] [--threads N] | compare <a> <b>"),
    }
}
