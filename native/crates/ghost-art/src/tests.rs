use std::io::Cursor;
use std::time::Instant;

use super::*;

/// Deterministic xorshift noise so synthetic images compress like photos, not flat fills.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u8 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 24) as u8
    }
}

/// Smooth gradient + noise, RGB.
fn photo(w: u32, h: u32) -> Vec<u8> {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut v = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            let n = rng.next() as u32 % 24;
            v.push(((x * 200 / w) + n) as u8);
            v.push(((y * 180 / h) + n) as u8);
            v.push((((x + y) * 120 / (w + h)) + 60 + n) as u8);
        }
    }
    v
}

fn jpeg(w: u32, h: u32, rgb: &[u8], exif: Option<&[u8]>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut e = jpeg_encoder::Encoder::new(&mut out, 90);
    if let Some(x) = exif {
        e.add_exif_metadata(x).unwrap();
    }
    e.encode(rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb).unwrap();
    out
}

fn png(w: u32, h: u32, data: &[u8], alpha: bool) -> Vec<u8> {
    let mut out = Vec::new();
    let ct = if alpha { image::ExtendedColorType::Rgba8 } else { image::ExtendedColorType::Rgb8 };
    image::codecs::png::PngEncoder::new(&mut out).write_image(data, w, h, ct).unwrap();
    out
}

fn fill(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
    let mut v = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            v.extend_from_slice(&f(x, y));
        }
    }
    v
}

/// Decode an output buffer back (independently of the pipeline) to check it.
fn redecode(bytes: &[u8]) -> DynamicImage {
    image::load_from_memory(bytes).expect("output decodes")
}

fn hue(rgb: [u8; 3]) -> f64 {
    let [r, g, b] = rgb.map(|c| c as f64 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let h = if max == r {
        ((g - b) / d + 6.0) % 6.0
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    h * 60.0
}

fn opts(max_width: u32) -> ArtOptions {
    ArtOptions { max_width, ..Default::default() }
}

#[test]
fn png_decodes_resizes_to_bucket_and_encodes_jpeg() {
    let (w, h) = (1200, 800);
    let src = png(w, h, &photo(w, h), false);
    let out = process(&src, &opts(512)).unwrap();
    assert_eq!((out.width, out.height), (512, 341));
    assert_eq!((out.source_width, out.source_height), (1200, 800));
    assert_eq!(out.mime, "image/jpeg");
    assert_eq!(out.source_mime, "image/png");
    assert!(!out.passthrough);
    assert_eq!(sniff(&out.data), Some(ImageFormat::Jpeg));
    let back = redecode(&out.data);
    assert_eq!((back.width(), back.height()), (512, 341));
    // Content survives: the gradient still runs dark-left to bright-right in red.
    let rgb = back.to_rgb8();
    assert!(rgb.get_pixel(500, 170)[0] as i32 - rgb.get_pixel(10, 170)[0] as i32 > 120);
}

#[test]
fn jpeg_resizes_to_each_bucket_and_never_upscales() {
    let (w, h) = (1000, 1500);
    let src = jpeg(w, h, &photo(w, h), None);
    for bucket in [128u32, 256, 512, 768] {
        let out = process(&src, &opts(bucket)).unwrap();
        assert_eq!(out.width, bucket, "bucket {bucket}");
        assert_eq!(out.height, (bucket as f64 * 1.5).round() as u32);
        let back = redecode(&out.data);
        assert_eq!((back.width(), back.height()), (out.width, out.height));
    }
    // Larger than the source: same size (re-encoded, no passthrough requested).
    let out = process(&src, &opts(1600)).unwrap();
    assert_eq!((out.width, out.height), (1000, 1500));
    assert!(!out.passthrough);
    // Height cap applies too.
    let out = process(&src, &ArtOptions { max_width: 1600, max_height: 600, ..Default::default() }).unwrap();
    assert_eq!((out.width, out.height), (400, 600));
}

#[test]
fn small_inputs_pass_through_untouched() {
    let src = jpeg(300, 300, &photo(300, 300), None);
    let o = ArtOptions { max_width: 1600, passthrough_max_bytes: 1_500_000, ..Default::default() };
    // Header-only path (no accent).
    let out = process(&src, &o).unwrap();
    assert!(out.passthrough);
    assert_eq!(out.data, src);
    assert_eq!((out.width, out.height, out.mime), (300, 300, "image/jpeg"));
    // With the accent: decoded, but the bytes still pass through.
    let out = process(&src, &ArtOptions { accent: true, ..o.clone() }).unwrap();
    assert!(out.passthrough);
    assert_eq!(out.data, src);
    assert!(out.accent.is_some());
    // Over the byte budget: re-encoded.
    let out = process(&src, &ArtOptions { passthrough_max_bytes: 100, ..o }).unwrap();
    assert!(!out.passthrough);
}

#[test]
fn transparent_png_stays_png_with_alpha() {
    let (w, h) = (400, 200);
    let mut rgba = Vec::new();
    for _y in 0..h {
        for x in 0..w {
            rgba.extend_from_slice(&[230, 40, 60, if x < w / 2 { 0 } else { 255 }]);
        }
    }
    let src = png(w, h, &rgba, true);
    let out = process(&src, &ArtOptions { max_width: 200, accent: true, ..Default::default() }).unwrap();
    assert_eq!(out.mime, "image/png");
    assert_eq!((out.width, out.height), (200, 100));
    let back = redecode(&out.data).to_rgba8();
    assert_eq!(back.get_pixel(10, 50)[3], 0);
    assert_eq!(back.get_pixel(190, 50)[3], 255);
    // Transparent pixels are ignored by the accent; the red half wins.
    let a = out.accent.unwrap();
    assert!(hue(a) < 15.0 || hue(a) > 345.0, "{a:?}");

    // An alpha channel that is fully opaque is treated as RGB → JPEG.
    let opaque: Vec<u8> = rgba.as_chunks::<4>().0.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect();
    let out = process(&png(w, h, &opaque, true), &opts(200)).unwrap();
    assert_eq!(out.mime, "image/jpeg");
}

#[test]
fn gif_and_webp_decode() {
    // GIF (first frame) via image's encoder.
    let (w, h) = (64u32, 48u32);
    let rgb = fill(w, h, |_, _| [20, 120, 220]);
    let mut gif = Vec::new();
    {
        let mut e = image::codecs::gif::GifEncoder::new(&mut gif);
        let frame = image::RgbaImage::from_fn(w, h, |x, y| {
            let i = ((y * w + x) * 3) as usize;
            image::Rgba([rgb[i], rgb[i + 1], rgb[i + 2], 255])
        });
        e.encode_frame(image::Frame::new(frame)).unwrap();
    }
    assert_eq!(sniff(&gif), Some(ImageFormat::Gif));
    let out = process(&gif, &ArtOptions { max_width: 32, accent: true, ..Default::default() }).unwrap();
    assert_eq!((out.width, out.height, out.mime), (32, 24, "image/jpeg"));
    let a = out.accent.unwrap();
    assert!((195.0..225.0).contains(&hue(a)), "{a:?}");

    // Lossless WebP round trip through our own encoder.
    let webp = process(&png(w, h, &rgb, false), &ArtOptions { format: OutFormat::Webp, ..Default::default() }).unwrap();
    assert_eq!(webp.mime, "image/webp");
    assert_eq!(sniff(&webp.data), Some(ImageFormat::WebP));
    let out = process(&webp.data, &opts(16)).unwrap();
    assert_eq!((out.width, out.height, out.source_mime), (16, 12, "image/webp"));
}

#[test]
fn exif_orientation_is_applied() {
    // Minimal little-endian TIFF with one IFD entry: Orientation (0x0112) = 6 (rotate 90° CW).
    let exif: [u8; 26] = [
        b'I', b'I', 42, 0, 8, 0, 0, 0, // header, IFD at 8
        1, 0, // one entry
        0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, // tag, SHORT, count 1, value 6
        0, 0, 0, 0, // no next IFD
    ];
    let src = jpeg(200, 100, &photo(200, 100), Some(&exif));
    let out = process(&src, &opts(1600)).unwrap();
    assert_eq!((out.width, out.height), (100, 200));
    let back = redecode(&out.data);
    assert_eq!((back.width(), back.height()), (100, 200));
}

#[test]
fn accent_matches_the_ts_semantics() {
    let n = 100usize;
    let rgba = |f: &dyn Fn(usize) -> [u8; 3]| -> Vec<u8> { (0..n).flat_map(|i| { let [r, g, b] = f(i); [r, g, b, 255] }).collect() };
    // Vivid green specks beat the dominant dark grey background.
    let a = accent_from_pixels(&rgba(&|i| if i % 10 == 0 { [40, 200, 90] } else { [30, 30, 34] }), 4).unwrap();
    assert!(hue(a) > 120.0 && hue(a) < 150.0, "{a:?}");
    // Red.
    let a = accent_from_pixels(&rgba(&|_| [220, 30, 40]), 4).unwrap();
    assert!(hue(a) < 15.0 || hue(a) > 345.0, "{a:?}");
    // Greyscale → none.
    assert_eq!(accent_from_pixels(&rgba(&|i| { let v = (i % 255) as u8; [v, v, v] }), 4), None);
    // Dark blue is brightened for the dark UI.
    let a = accent_from_pixels(&rgba(&|_| [10, 20, 90]), 4).unwrap();
    assert!(*a.iter().max().unwrap() > 150, "{a:?}");
    // Bit-exact with `extractAccent` in src/main/net/accent.ts on the same inputs (values from
    // running the TS implementation).
    let a = accent_from_pixels(&rgba(&|_| [220, 30, 40]), 4).unwrap();
    assert_eq!(hex(a), "#e22831");
    let g = accent_from_pixels(&rgba(&|i| if i % 10 == 0 { [40, 200, 90] } else { [30, 30, 34] }), 4).unwrap();
    assert_eq!(hex(g), "#33d666");
    assert_eq!(hex(accent_from_pixels(&rgba(&|_| [10, 20, 90]), 4).unwrap()), "#233be7");
    // RGB input (3 channels) gives the same answer as RGBA.
    let rgb: Vec<u8> = rgba(&|_| [220, 30, 40]).as_chunks::<4>().0.iter().flat_map(|p| [p[0], p[1], p[2]]).collect();
    assert_eq!(accent_from_pixels(&rgb, 3), Some(a));
}

#[test]
fn accent_through_the_pipeline_for_known_colour_fields() {
    let cases: [([u8; 3], f64); 4] = [([200, 40, 40], 0.0), ([40, 180, 60], 130.0), ([50, 90, 220], 222.0), ([230, 200, 30], 52.0)];
    for (c, want) in cases {
        let (w, h) = (320, 320);
        // 30% colour block on a near-black background.
        let img = fill(w, h, |x, y| if x < 180 && y < 180 { c } else { [18, 14, 22] });
        let src = jpeg(w, h, &img, None);
        let a = accent_of(&src).unwrap().expect("has accent");
        let d = (hue(a) - want).abs();
        assert!(d.min(360.0 - d) < 12.0, "colour {c:?} → {} (hue {:.0}, want {want})", hex(a), hue(a));
        // process(accent) agrees with accent_of on the same (unresized) image.
        let p = process(&src, &ArtOptions { accent: true, ..Default::default() }).unwrap();
        assert_eq!(p.accent, Some(a));
    }
    // Pure greyscale cover → None.
    let grey = jpeg(256, 256, &fill(256, 256, |x, _| [x as u8; 3]), None);
    assert_eq!(accent_of(&grey).unwrap(), None);
}

#[test]
fn corrupt_input_errors_cleanly() {
    assert_eq!(process(b"", &opts(256)).unwrap_err(), ArtError::Unsupported);
    assert_eq!(process(b"<html>not an image</html>", &opts(256)).unwrap_err(), ArtError::Unsupported);
    // Valid magic, garbage body.
    let mut bad = vec![0xff, 0xd8, 0xff, 0xe0];
    bad.extend(std::iter::repeat_n(0x5a, 4000));
    assert!(matches!(process(&bad, &opts(256)), Err(ArtError::Decode(_))), "{:?}", process(&bad, &opts(256)));
    // Truncated PNG / JPEG.
    let p = png(300, 300, &photo(300, 300), false);
    assert!(process(&p[..p.len() / 3], &opts(128)).is_err());
    let j = jpeg(300, 300, &photo(300, 300), None);
    let r = process(&j[..200], &opts(128));
    assert!(r.is_err(), "truncated JPEG header must fail");
    assert!(accent_of(&p[..100]).is_err());
}

#[test]
fn large_jpeg_is_fast() {
    let (w, h) = (4000u32, 4000u32);
    let t = Instant::now();
    let src = jpeg(w, h, &photo(w, h), None);
    let gen_ms = t.elapsed().as_millis();
    let run = |max_width: u32| {
        let t = Instant::now();
        let out = process(&src, &ArtOptions { max_width, max_height: 2400, quality: 85, accent: true, passthrough_max_bytes: 1_500_000, ..Default::default() }).unwrap();
        (t.elapsed(), out)
    };
    let _ = run(1600); // warm up (page faults, CPU feature detection)
    let (dt, out) = run(1600);
    let (dt_thumb, thumb) = run(256);
    eprintln!(
        "4000x4000 JPEG ({} KB, generated in {gen_ms} ms) → {}x{} {} KB in {:.1} ms (decode {:.1} / resize {:.1} / accent {:.1} / encode {:.1} ms); → 256 px in {:.1} ms",
        src.len() / 1024,
        out.width,
        out.height,
        out.data.len() / 1024,
        dt.as_secs_f64() * 1000.0,
        out.timings.decode_us as f64 / 1000.0,
        out.timings.resize_us as f64 / 1000.0,
        out.timings.accent_us as f64 / 1000.0,
        out.timings.encode_us as f64 / 1000.0,
        dt_thumb.as_secs_f64() * 1000.0,
    );
    assert_eq!((out.width, out.height), (1600, 1600));
    assert_eq!((thumb.width, thumb.height), (256, 256));
    assert!(out.accent.is_some());
    // Dependencies are built with opt-level 3 even in test builds; this crate's own loops too
    // in release. Allow some slack for unoptimised builds of this crate.
    let budget_ms = if cfg!(debug_assertions) { 400 } else { 200 };
    assert!(dt.as_millis() < budget_ms, "took {dt:?}");
}

#[test]
fn fit_math() {
    assert_eq!(fit(4000, 3000, 1600, 0), (1600, 1200));
    assert_eq!(fit(1000, 4000, 1600, 2400), (600, 2400));
    assert_eq!(fit(100, 100, 1600, 1600), (100, 100));
    assert_eq!(fit(10_000, 3, 128, 0), (128, 1));
    assert_eq!(OutFormat::parse("JPG"), Some(OutFormat::Jpeg));
    assert_eq!(OutFormat::parse("tiff"), None);
}

/// A GIF whose logical screen is `w`×`h` (no frames). Decoders accept the header alone.
fn gif_header(w: u16, h: u16) -> Vec<u8> {
    let mut v = b"GIF89a".to_vec();
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v.extend_from_slice(&[0, 0, 0, 0x3b]);
    v
}

#[test]
fn zero_sized_images_error_instead_of_panicking() {
    // Header-only fast path (no accent, passthrough allowed): used to reach `fit(2000, 0, ..)`,
    // whose `clamp(1, 0)` panics.
    let o = ArtOptions { max_width: 1600, passthrough_max_bytes: 1_000_000, ..Default::default() };
    for (w, h) in [(2000u16, 0u16), (0, 2000), (0, 0)] {
        let r = std::panic::catch_unwind(|| process(&gif_header(w, h), &o));
        let r = r.unwrap_or_else(|_| panic!("{w}x{h} GIF panicked"));
        assert!(r.is_err(), "{w}x{h} GIF must be rejected: {r:?}");
        assert!(accent_of(&gif_header(w, h)).is_err());
    }
    assert_eq!(fit(2000, 0, 1600, 0), (1600, 1));
    assert_eq!(fit(0, 0, 1600, 1600), (0, 0));
}

/// PNG header (IHDR) claiming `w`×`h` RGBA8 followed by a tiny IDAT: a decompression bomb's shape.
fn png_claiming(w: u32, h: u32) -> Vec<u8> {
    fn chunk(out: &mut Vec<u8>, ty: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(ty);
        out.extend_from_slice(data);
        // CRC-32 (PNG polynomial).
        let mut crc = !0u32;
        for &b in &out[start..] {
            crc ^= b as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
            }
        }
        out.extend_from_slice(&(!crc).to_be_bytes());
    }
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut v, b"IHDR", &ihdr);
    chunk(&mut v, b"IDAT", &[0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
    chunk(&mut v, b"IEND", &[]);
    v
}

#[test]
fn absurd_dimensions_are_rejected_before_allocating() {
    // 16000² RGBA would be a 1 GiB buffer per call (3 GiB with three pool threads) from a 70-byte
    // file. Anything over MAX_PIXELS is refused from the header.
    for (w, h) in [(16_000u32, 16_000u32), (12_000, 12_000), (16_384, 8193)] {
        let src = png_claiming(w, h);
        for accent in [false, true] {
            let r = process(&src, &ArtOptions { max_width: 512, accent, ..Default::default() });
            assert_eq!(r.unwrap_err(), ArtError::TooLarge(w, h), "{w}x{h}");
        }
        assert_eq!(accent_of(&src).unwrap_err(), ArtError::TooLarge(w, h));
    }
    // Over MAX_DIMENSION on one side.
    assert!(process(&png_claiming(20_000, 10), &opts(512)).is_err());
    // A plausible big scan's header is accepted (the truncated body then fails to decode).
    assert!(matches!(process(&png_claiming(6000, 6000), &opts(512)), Err(ArtError::Decode(_))));
}

/// Minimal ICC header: 128 bytes with the data colour space at 16..20 and the `acsp` signature.
fn icc(space: &[u8; 4]) -> Vec<u8> {
    let mut v = vec![0u8; 128];
    v[..4].copy_from_slice(&128u32.to_be_bytes());
    v[12..16].copy_from_slice(b"mntr");
    v[16..20].copy_from_slice(space);
    v[20..24].copy_from_slice(b"XYZ ");
    v[36..40].copy_from_slice(b"acsp");
    v
}

fn icc_of(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut d = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format().unwrap().into_decoder().unwrap();
    d.icc_profile().unwrap()
}

#[test]
fn only_matching_icc_profiles_are_copied() {
    let (w, h) = (600u32, 400u32);
    let rgb = photo(w, h);
    let with_icc = |p: &[u8]| {
        let mut out = Vec::new();
        let mut e = jpeg_encoder::Encoder::new(&mut out, 90);
        e.add_icc_profile(p).unwrap();
        e.encode(&rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb).unwrap();
        out
    };
    // An RGB profile survives the re-encode.
    let out = process(&with_icc(&icc(b"RGB ")), &opts(300)).unwrap();
    assert_eq!(icc_of(&out.data).as_deref().map(|p| &p[16..20]), Some(&b"RGB "[..]));
    // A CMYK profile (print scans; often 0.5–3 MB) describes the source, not our RGB output: it
    // used to be copied into every resized variant, even 128 px thumbnails.
    let out = process(&with_icc(&icc(b"CMYK")), &opts(300)).unwrap();
    assert_eq!(icc_of(&out.data), None);
}

fn exif_orientation(o: u8) -> [u8; 26] {
    [b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, o, 0, 0, 0, 0, 0, 0, 0]
}

#[test]
fn every_exif_orientation_matches_rotate_then_resize() {
    // Asymmetric content: a gradient plus a bright block near the top-left corner.
    let (w, h) = (360u32, 240u32);
    let src_rgb = fill(w, h, |x, y| if x < 60 && y < 40 { [250, 250, 250] } else { [(x * 255 / w) as u8, (y * 255 / h) as u8, 90] });
    for o in 1..=8u8 {
        let src = jpeg(w, h, &src_rgb, Some(&exif_orientation(o)));
        // Reference: decode, orient the full image, then resize (the old order).
        let mut reference = image::load_from_memory(&src).unwrap();
        let orientation = Orientation::from_exif(o).unwrap();
        reference.apply_orientation(orientation);
        let (rw, rh) = (reference.width(), reference.height());
        let (tw, th) = fit(rw, rh, 120, 0);
        let reference = reference.resize_exact(tw, th, image::imageops::FilterType::Lanczos3).to_rgb8();

        let out = process(&src, &opts(120)).unwrap();
        assert_eq!((out.width, out.height), (tw, th), "orientation {o}");
        let got = redecode(&out.data).to_rgb8();
        assert_eq!(got.dimensions(), (tw, th), "orientation {o}");
        let se: f64 = got.as_raw().iter().zip(reference.as_raw()).map(|(a, b)| (*a as f64 - *b as f64).powi(2)).sum();
        let psnr = 10.0 * (255.0f64.powi(2) / (se / got.as_raw().len() as f64)).log10();
        assert!(psnr > 30.0, "orientation {o}: PSNR {psnr:.1} dB against rotate-then-resize");

        // Passthrough (with accent): reports the display size, keeps the bytes (and the EXIF tag).
        let pt = process(&src, &ArtOptions { max_width: 1600, passthrough_max_bytes: 1 << 20, accent: true, ..Default::default() }).unwrap();
        assert!(pt.passthrough);
        assert_eq!((pt.width, pt.height), (rw, rh), "orientation {o}");
        assert_eq!(pt.data, src);
    }
}

#[test]
fn greyscale_stays_one_channel() {
    let (w, h) = (500u32, 300u32);
    let grey: Vec<u8> = (0..w * h).map(|i| ((i % w) * 255 / w) as u8).collect();
    let mut src = Vec::new();
    jpeg_encoder::Encoder::new(&mut src, 90).encode(&grey, w as u16, h as u16, jpeg_encoder::ColorType::Luma).unwrap();
    let out = process(&src, &ArtOptions { max_width: 250, accent: true, ..Default::default() }).unwrap();
    assert_eq!((out.width, out.height, out.mime), (250, 150, "image/jpeg"));
    assert_eq!(out.accent, None);
    let back = redecode(&out.data);
    assert_eq!(back.color(), image::ColorType::L8, "a greyscale JPEG comes back greyscale");
    let l = back.to_luma8();
    assert!((l.get_pixel(125, 75)[0] as i32 - 127).abs() < 6, "{}", l.get_pixel(125, 75)[0]);
    assert!(l.get_pixel(240, 75)[0] > 235 && l.get_pixel(5, 75)[0] < 15);
    assert_eq!(accent_of(&src).unwrap(), None);
    // Lossless outputs too.
    let png = process(&src, &ArtOptions { max_width: 250, format: OutFormat::Png, ..Default::default() }).unwrap();
    assert_eq!(redecode(&png.data).color(), image::ColorType::L8);
    let webp = process(&src, &ArtOptions { max_width: 250, format: OutFormat::Webp, ..Default::default() }).unwrap();
    assert_eq!(redecode(&webp.data).to_luma8().get_pixel(240, 75)[0], png_pixel(&png.data, 240, 75));
}

fn png_pixel(bytes: &[u8], x: u32, y: u32) -> u8 {
    redecode(bytes).to_luma8().get_pixel(x, y)[0]
}

#[test]
fn opaque_rgba_is_encoded_without_an_rgb_copy() {
    // GIFs always decode to RGBA; an opaque one must come out as an ordinary JPEG / RGB PNG.
    let (w, h) = (300u32, 200u32);
    let frame = image::RgbaImage::from_fn(w, h, |x, _| if x < w / 2 { image::Rgba([220, 30, 40, 255]) } else { image::Rgba([30, 60, 220, 255]) });
    let mut gif = Vec::new();
    image::codecs::gif::GifEncoder::new(&mut gif).encode_frame(image::Frame::new(frame)).unwrap();
    let out = process(&gif, &ArtOptions { max_width: 150, accent: true, ..Default::default() }).unwrap();
    assert_eq!((out.width, out.height, out.mime), (150, 100, "image/jpeg"));
    let back = redecode(&out.data).to_rgb8();
    let close = |a: [u8; 3], b: [u8; 3]| a.iter().zip(b).all(|(x, y)| (*x as i32 - y as i32).abs() < 12);
    assert!(close(back.get_pixel(20, 50).0, [220, 30, 40]), "{:?}", back.get_pixel(20, 50));
    assert!(close(back.get_pixel(130, 50).0, [30, 60, 220]), "{:?}", back.get_pixel(130, 50));
    assert!(out.accent.is_some());
    let png = process(&gif, &ArtOptions { max_width: 150, format: OutFormat::Png, ..Default::default() }).unwrap();
    let back = redecode(&png.data);
    assert_eq!(back.color(), image::ColorType::Rgb8, "no constant alpha channel in the PNG");
    assert_eq!(back.to_rgb8().get_pixel(20, 50).0, [220, 30, 40]);
}

#[test]
fn keeping_input_skips_the_passthrough_copy() {
    let src = jpeg(300, 300, &photo(300, 300), None);
    let o = ArtOptions { max_width: 1600, passthrough_max_bytes: 1 << 20, accent: true, ..Default::default() };
    let a = process(&src, &o).unwrap();
    let b = process_keeping_input(&src, &o).unwrap();
    assert!(a.passthrough && b.passthrough);
    assert_eq!(a.data, src);
    assert!(b.data.is_empty());
    assert_eq!((a.width, a.height, a.accent), (b.width, b.height, b.accent));
    // Not a passthrough: identical outputs.
    let o = ArtOptions { max_width: 128, ..o };
    assert_eq!(process(&src, &o).unwrap().data, process_keeping_input(&src, &o).unwrap().data);
}

#[test]
fn accent_of_agrees_with_process_on_large_images() {
    // accent_of used to box-filter large images to ≤ 512 px and then to 48 px, so the colour it
    // stored for older cache entries could differ from what processArt computes for new ones.
    let (w, h) = (1200u32, 900u32);
    let img = fill(w, h, |x, y| if (x / 37 + y / 23) % 5 == 0 { [40 + (x % 200) as u8, 180, 60] } else { [20 + (y % 30) as u8, 16, 24] });
    let src = jpeg(w, h, &img, None);
    let p = process(&src, &ArtOptions { max_width: 1600, passthrough_max_bytes: 1 << 22, accent: true, ..Default::default() }).unwrap();
    assert!(p.passthrough);
    assert!(p.accent.is_some());
    assert_eq!(accent_of(&src).unwrap(), p.accent);
}
