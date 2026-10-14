//! Cover-art pipeline for GHOST's `ghost-art://` protocol, run off the Electron main thread.
//!
//! `process` decodes a JPEG / PNG / WebP / GIF (first frame), applies the EXIF orientation,
//! downscales it with a SIMD convolution resize (never upscales) and re-encodes it: JPEG for
//! opaque images, fast PNG for images with real transparency (logos). Small enough inputs pass
//! through untouched. Optionally it also picks the accent colour from a 48×48 box-filtered copy
//! (`accent_from_pixels`, a port of `src/main/net/accent.ts`).
//!
//! Everything here is synchronous and allocation-heavy; callers run it on worker threads.

use std::fmt;
use std::io::Cursor;
use std::time::Instant;

use fast_image_resize as fr;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};

mod accent;

pub use accent::accent_from_pixels;

/// Edge length of the copy the accent colour is computed from (matches the old TS pipeline).
pub const ACCENT_SIZE: u32 = 48;
/// Inputs larger than this in either dimension are rejected before decoding.
pub const MAX_DIMENSION: u32 = 16_384;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum OutFormat {
    /// JPEG, or PNG when the image has real transparency.
    #[default]
    Auto,
    Jpeg,
    Png,
    /// Lossless WebP (the encoder has no lossy mode).
    Webp,
}

impl OutFormat {
    pub fn parse(s: &str) -> Option<OutFormat> {
        match s.to_ascii_lowercase().as_str() {
            "" | "auto" => Some(OutFormat::Auto),
            "jpeg" | "jpg" => Some(OutFormat::Jpeg),
            "png" => Some(OutFormat::Png),
            "webp" => Some(OutFormat::Webp),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ArtOptions {
    /// Largest output width in px (0 = no limit). Never upscales.
    pub max_width: u32,
    /// Largest output height in px (0 = no limit).
    pub max_height: u32,
    /// JPEG quality 1..=100.
    pub quality: u8,
    pub format: OutFormat,
    /// Return the input bytes unchanged when no resize is needed, the input is JPEG / PNG / WebP /
    /// GIF and at most this many bytes (0 = always re-encode).
    pub passthrough_max_bytes: usize,
    /// Compute the accent colour.
    pub accent: bool,
}

impl Default for ArtOptions {
    fn default() -> Self {
        ArtOptions { max_width: 0, max_height: 0, quality: 85, format: OutFormat::Auto, passthrough_max_bytes: 0, accent: false }
    }
}

/// Microseconds spent in each stage (diagnostics / tests).
#[derive(Clone, Copy, Debug, Default)]
pub struct Timings {
    pub decode_us: u64,
    pub resize_us: u64,
    pub encode_us: u64,
    pub accent_us: u64,
}

#[derive(Clone, Debug)]
pub struct ArtOutput {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub mime: &'static str,
    pub source_width: u32,
    pub source_height: u32,
    pub source_mime: &'static str,
    /// `data` is the input, unchanged.
    pub passthrough: bool,
    /// `[r, g, b]`, or None for greyscale / near-monochrome art (or when not requested).
    pub accent: Option<[u8; 3]>,
    pub timings: Timings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtError {
    /// Not a JPEG / PNG / WebP / GIF.
    Unsupported,
    Decode(String),
    TooLarge(u32, u32),
    Resize(String),
    Encode(String),
}

impl fmt::Display for ArtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ArtError::Unsupported => f.write_str("unsupported image format"),
            ArtError::Decode(e) => write!(f, "image decode failed: {e}"),
            ArtError::TooLarge(w, h) => write!(f, "image too large ({w}x{h})"),
            ArtError::Resize(e) => write!(f, "image resize failed: {e}"),
            ArtError::Encode(e) => write!(f, "image encode failed: {e}"),
        }
    }
}

impl std::error::Error for ArtError {}

/// Image format from the magic bytes (the only thing we trust; headers lie).
pub fn sniff(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.len() >= 3 && bytes[..3] == [0xff, 0xd8, 0xff] {
        Some(ImageFormat::Jpeg)
    } else if bytes.len() >= 8 && bytes[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        Some(ImageFormat::Png)
    } else if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        Some(ImageFormat::Gif)
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageFormat::WebP)
    } else {
        None
    }
}

pub fn mime_of(f: ImageFormat) -> &'static str {
    match f {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Png => "image/png",
        ImageFormat::Gif => "image/gif",
        ImageFormat::WebP => "image/webp",
        _ => "application/octet-stream",
    }
}

fn us(t: Instant) -> u64 {
    t.elapsed().as_micros() as u64
}

/// Output size for `w`×`h` within the limits (aspect kept, never larger than the input).
pub fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let mut scale = 1.0f64;
    if max_w > 0 && w > max_w {
        scale = scale.min(max_w as f64 / w as f64);
    }
    if max_h > 0 && h > max_h {
        scale = scale.min(max_h as f64 / h as f64);
    }
    if scale >= 1.0 {
        return (w, h);
    }
    let tw = ((w as f64 * scale).round() as u32).clamp(1, w);
    let th = ((h as f64 * scale).round() as u32).clamp(1, h);
    (tw, th)
}

/// Decoded pixels, 8-bit, either RGB (opaque) or RGBA (has real transparency).
struct Pixels {
    width: u32,
    height: u32,
    alpha: bool,
    data: Vec<u8>,
}

impl Pixels {
    fn channels(&self) -> usize {
        if self.alpha {
            4
        } else {
            3
        }
    }

    fn pixel_type(&self) -> fr::PixelType {
        if self.alpha {
            fr::PixelType::U8x4
        } else {
            fr::PixelType::U8x3
        }
    }

    fn from_image(img: DynamicImage) -> Pixels {
        let (width, height) = (img.width(), img.height());
        if img.color().has_alpha() {
            let rgba = img.into_rgba8().into_raw();
            if rgba.as_chunks::<4>().0.iter().all(|p| p[3] == 255) {
                // Alpha channel without transparency: treat as opaque (JPEG, cheaper resize).
                let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
                for p in rgba.as_chunks::<4>().0 {
                    rgb.extend_from_slice(&p[..3]);
                }
                return Pixels { width, height, alpha: false, data: rgb };
            }
            Pixels { width, height, alpha: true, data: rgba }
        } else {
            Pixels { width, height, alpha: false, data: img.into_rgb8().into_raw() }
        }
    }

    /// Resized copy (`algorithm` convolution). `self` is borrowed, so the source survives.
    fn resized(&self, tw: u32, th: u32, filter: fr::FilterType) -> Result<Pixels, ArtError> {
        // fast_image_resize wants a mutable buffer for the source view only to support in-place
        // alpha handling; it does not modify an `Image` source.
        let src = fr::images::ImageRef::new(self.width, self.height, &self.data, self.pixel_type())
            .map_err(|e| ArtError::Resize(e.to_string()))?;
        let mut dst = fr::images::Image::new(tw, th, self.pixel_type());
        let opts = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(filter)).use_alpha(self.alpha);
        fr::Resizer::new().resize(&src, &mut dst, &opts).map_err(|e| ArtError::Resize(e.to_string()))?;
        Ok(Pixels { width: tw, height: th, alpha: self.alpha, data: dst.into_vec() })
    }

    /// RGBA pixels of a 48×48 box-filtered copy (aspect ignored, like the old pipeline).
    fn accent(&self) -> Result<Option<[u8; 3]>, ArtError> {
        let small = if self.width == ACCENT_SIZE && self.height == ACCENT_SIZE {
            None
        } else {
            Some(self.resized(ACCENT_SIZE, ACCENT_SIZE, fr::FilterType::Box)?)
        };
        let p = small.as_ref().unwrap_or(self);
        Ok(accent_from_pixels(&p.data, p.channels()))
    }
}

struct Decoded {
    format: ImageFormat,
    pixels: Pixels,
    icc: Option<Vec<u8>>,
}

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_image_width = Some(MAX_DIMENSION);
    l.max_image_height = Some(MAX_DIMENSION);
    l.max_alloc = Some(1024 * 1024 * 1024);
    l
}

fn decode_err(e: image::ImageError) -> ArtError {
    match e {
        image::ImageError::Limits(_) => ArtError::Decode(format!("{e}")),
        image::ImageError::Unsupported(_) => ArtError::Unsupported,
        e => ArtError::Decode(e.to_string()),
    }
}

/// Header-only probe: format, oriented size and EXIF orientation.
struct Header {
    format: ImageFormat,
    width: u32,
    height: u32,
    orientation: Orientation,
}

fn open(bytes: &[u8]) -> Result<(ImageFormat, impl ImageDecoder + '_), ArtError> {
    let format = sniff(bytes).ok_or(ArtError::Unsupported)?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits());
    let decoder = reader.into_decoder().map_err(decode_err)?;
    Ok((format, decoder))
}

fn oriented_size(w: u32, h: u32, o: Orientation) -> (u32, u32) {
    match o {
        Orientation::Rotate90 | Orientation::Rotate270 | Orientation::Rotate90FlipH | Orientation::Rotate270FlipH => (h, w),
        _ => (w, h),
    }
}

fn header(bytes: &[u8]) -> Result<Header, ArtError> {
    let (format, mut d) = open(bytes)?;
    let (w, h) = d.dimensions();
    if w > MAX_DIMENSION || h > MAX_DIMENSION {
        return Err(ArtError::TooLarge(w, h));
    }
    let orientation = d.orientation().unwrap_or(Orientation::NoTransforms);
    let (width, height) = oriented_size(w, h, orientation);
    Ok(Header { format, width, height, orientation })
}

fn decode(bytes: &[u8]) -> Result<Decoded, ArtError> {
    let (format, mut d) = open(bytes)?;
    let (w, h) = d.dimensions();
    if w == 0 || h == 0 {
        return Err(ArtError::Decode("empty image".into()));
    }
    if w > MAX_DIMENSION || h > MAX_DIMENSION {
        return Err(ArtError::TooLarge(w, h));
    }
    let orientation = d.orientation().unwrap_or(Orientation::NoTransforms);
    let icc = d.icc_profile().ok().flatten();
    let mut img = DynamicImage::from_decoder(d).map_err(decode_err)?;
    img.apply_orientation(orientation);
    Ok(Decoded { format, pixels: Pixels::from_image(img), icc })
}

fn encode(p: &Pixels, format: OutFormat, quality: u8, icc: Option<&[u8]>) -> Result<(Vec<u8>, &'static str), ArtError> {
    let enc_err = |e: &dyn fmt::Display| ArtError::Encode(e.to_string());
    let format = match format {
        OutFormat::Auto if p.alpha => OutFormat::Png,
        OutFormat::Auto => OutFormat::Jpeg,
        f => f,
    };
    let mut out = Vec::with_capacity((p.width * p.height / 4) as usize + 1024);
    match format {
        OutFormat::Jpeg | OutFormat::Auto => {
            let rgb;
            let (data, ct) = if p.alpha {
                // Composite on black: the renderer's backgrounds are dark.
                rgb = p
                    .data
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .flat_map(|px| {
                        let a = px[3] as u16;
                        [px[0], px[1], px[2]].map(|c| ((c as u16 * a + 127) / 255) as u8)
                    })
                    .collect::<Vec<u8>>();
                (&rgb[..], jpeg_encoder::ColorType::Rgb)
            } else {
                (&p.data[..], jpeg_encoder::ColorType::Rgb)
            };
            if p.width > u16::MAX as u32 || p.height > u16::MAX as u32 {
                return Err(ArtError::TooLarge(p.width, p.height));
            }
            let mut e = jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100));
            e.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_2_0);
            if let Some(icc) = icc {
                let _ = e.add_icc_profile(icc);
            }
            e.encode(data, p.width as u16, p.height as u16, ct).map_err(|e| enc_err(&e))?;
            Ok((out, "image/jpeg"))
        }
        OutFormat::Png => {
            let ct = if p.alpha { image::ExtendedColorType::Rgba8 } else { image::ExtendedColorType::Rgb8 };
            let mut e = image::codecs::png::PngEncoder::new_with_quality(
                &mut out,
                image::codecs::png::CompressionType::Fast,
                image::codecs::png::FilterType::Adaptive,
            );
            if let Some(icc) = icc {
                let _ = e.set_icc_profile(icc.to_vec());
            }
            e.write_image(&p.data, p.width, p.height, ct).map_err(|e| enc_err(&e))?;
            Ok((out, "image/png"))
        }
        OutFormat::Webp => {
            let ct = if p.alpha { image::ExtendedColorType::Rgba8 } else { image::ExtendedColorType::Rgb8 };
            image::codecs::webp::WebPEncoder::new_lossless(&mut out)
                .write_image(&p.data, p.width, p.height, ct)
                .map_err(|e| enc_err(&e))?;
            Ok((out, "image/webp"))
        }
    }
}

/// Decode, downscale to fit `opts`, re-encode, and optionally pick the accent colour.
pub fn process(bytes: &[u8], opts: &ArtOptions) -> Result<ArtOutput, ArtError> {
    let mut timings = Timings::default();
    let t = Instant::now();
    let fits = |w: u32, h: u32| fit(w, h, opts.max_width, opts.max_height) == (w, h);
    let passthrough_ok = |len: usize| opts.passthrough_max_bytes > 0 && len <= opts.passthrough_max_bytes;

    // Fast path: small enough, no accent wanted → headers only, no pixel decode.
    if !opts.accent && passthrough_ok(bytes.len()) {
        let h = header(bytes)?;
        if fits(h.width, h.height) && h.orientation == Orientation::NoTransforms {
            timings.decode_us = us(t);
            return Ok(ArtOutput {
                data: bytes.to_vec(),
                width: h.width,
                height: h.height,
                mime: mime_of(h.format),
                source_width: h.width,
                source_height: h.height,
                source_mime: mime_of(h.format),
                passthrough: true,
                accent: None,
                timings,
            });
        }
    }

    let Decoded { format, pixels, icc } = decode(bytes)?;
    timings.decode_us = us(t);
    let (sw, sh) = (pixels.width, pixels.height);
    let (tw, th) = fit(sw, sh, opts.max_width, opts.max_height);

    let t = Instant::now();
    let out_px = if (tw, th) != (sw, sh) { Some(pixels.resized(tw, th, fr::FilterType::Lanczos3)?) } else { None };
    timings.resize_us = us(t);
    let final_px = out_px.as_ref().unwrap_or(&pixels);

    let t = Instant::now();
    let accent = if opts.accent { final_px.accent()? } else { None };
    timings.accent_us = us(t);

    let t = Instant::now();
    // Passthrough keeps the original bytes (and its EXIF orientation, which Chromium applies).
    let (data, mime, passthrough) = if out_px.is_none() && passthrough_ok(bytes.len()) {
        (bytes.to_vec(), mime_of(format), true)
    } else {
        let (d, m) = encode(final_px, opts.format, opts.quality, icc.as_deref())?;
        (d, m, false)
    };
    timings.encode_us = us(t);

    Ok(ArtOutput {
        data,
        width: final_px.width,
        height: final_px.height,
        mime,
        source_width: sw,
        source_height: sh,
        source_mime: mime_of(format),
        passthrough,
        accent,
        timings,
    })
}

/// Accent colour only (decode + 48×48 box downsample + `accent_from_pixels`).
pub fn accent_of(bytes: &[u8]) -> Result<Option<[u8; 3]>, ArtError> {
    let d = decode(bytes)?;
    // Very large images: shrink to ≤ 512 px first (box filter cost scales with the source).
    let p = &d.pixels;
    let (tw, th) = fit(p.width, p.height, 512, 512);
    if (tw, th) != (p.width, p.height) {
        p.resized(tw, th, fr::FilterType::Box)?.accent()
    } else {
        p.accent()
    }
}

/// `#rrggbb` for an accent triple.
pub fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

#[cfg(test)]
mod tests;
