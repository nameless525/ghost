//! Cover-art pipeline for GHOST's `ghost-art://` protocol, run off the Electron main thread.
//!
//! `process` decodes a JPEG / PNG / WebP / GIF (first frame), downscales it with a SIMD
//! convolution resize (never upscales), applies the EXIF orientation (after the resize, so only
//! the small copy is rotated) and re-encodes it: JPEG for opaque images, fast PNG for images with
//! real transparency (logos). Small enough inputs pass through untouched. Optionally it also picks
//! the accent colour from a 48×48 box-filtered copy (`accent_from_pixels`, a port of
//! `src/main/net/accent.ts`).
//!
//! Pixels stay in the decoder's layout where possible: greyscale stays 1 channel (a third of the
//! memory / resize / encode work; no accent by definition) and opaque RGBA (every GIF, many PNG /
//! WebP files) stays 4 channels instead of being copied to RGB.
//!
//! Hostile input: dimensions are checked from the header against `MAX_DIMENSION` / `MAX_PIXELS`
//! before any pixel buffer exists, decoder-internal allocations are capped, and nothing here
//! panics on malformed data (the napi wrapper still catches panics, defensively).
//!
//! Everything here is synchronous and allocation-heavy; callers run it on worker threads.

use std::fmt;
use std::io::Cursor;
use std::time::Instant;

use fast_image_resize as fr;
use image::metadata::Orientation;
use image::{ColorType, DynamicImage, ImageBuffer, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};

mod accent;

pub use accent::accent_from_pixels;

/// Edge length of the copy the accent colour is computed from (matches the old TS pipeline).
pub const ACCENT_SIZE: u32 = 48;
/// Inputs larger than this in either dimension are rejected before decoding.
pub const MAX_DIMENSION: u32 = 16_384;
/// Inputs with more pixels than this (16384 × 8192 ≈ 134 MP; a 600 dpi scan of a gatefold LP
/// sleeve is ~104 MP) are rejected from the header. A few-KB PNG / GIF can claim 16384² px:
/// without this one call allocated up to ~3.8 GiB (16-bit RGBA, then 8-bit and RGB copies), and
/// the pool runs three. Now the worst case is ~0.6–0.8 GiB.
pub const MAX_PIXELS: u64 = 16_384 * 8192;
/// Largest decoded buffer we allocate: MAX_PIXELS of RGBA8 (16-bit sources must be smaller).
const MAX_DECODE_BYTES: u64 = MAX_PIXELS * 4;
/// Cap on decoder-internal allocations (PNG ancillary chunks such as a zlib-compressed ICC
/// profile or text, a GIF frame that doesn't match its logical screen): was 1 GiB.
const MAX_DECODER_ALLOC: u64 = 256 * 1024 * 1024;

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

/// Output size for `w`×`h` within the limits (aspect kept, never larger than the input, never 0
/// unless the input is).
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
    // `max(1).min(n.max(1))`, not `clamp(1, n)`: clamp panics when n == 0.
    let tw = ((w as f64 * scale).round() as u32).max(1).min(w.max(1));
    let th = ((h as f64 * scale).round() as u32).max(1).min(h.max(1));
    (tw, th)
}

/// Decoded 8-bit pixels: 1 channel (greyscale), 3 (RGB) or 4 (RGBA; `alpha` says whether any
/// pixel is actually transparent: opaque RGBA is resized without alpha handling, encoded as JPEG
/// straight from RGBA, and never copied to RGB).
struct Pixels {
    width: u32,
    height: u32,
    channels: u8,
    alpha: bool,
    data: Vec<u8>,
}

impl Pixels {
    fn pixel_type(&self) -> fr::PixelType {
        match self.channels {
            1 => fr::PixelType::U8,
            3 => fr::PixelType::U8x3,
            _ => fr::PixelType::U8x4,
        }
    }

    fn from_image(img: DynamicImage) -> Pixels {
        let (width, height) = (img.width(), img.height());
        let color = img.color();
        if color.has_alpha() {
            let data = img.into_rgba8().into_raw();
            // Alpha channel without transparency: treat as opaque (JPEG, cheaper resize).
            let alpha = !data.as_chunks::<4>().0.iter().all(|p| p[3] == 255);
            Pixels { width, height, channels: 4, alpha, data }
        } else if matches!(color, ColorType::L8 | ColorType::L16) {
            Pixels { width, height, channels: 1, alpha: false, data: img.into_luma8().into_raw() }
        } else {
            Pixels { width, height, channels: 3, alpha: false, data: img.into_rgb8().into_raw() }
        }
    }

    /// Resized copy (`filter` convolution). `self` is borrowed, so the source survives.
    fn resized(&self, tw: u32, th: u32, filter: fr::FilterType) -> Result<Pixels, ArtError> {
        let src = fr::images::ImageRef::new(self.width, self.height, &self.data, self.pixel_type())
            .map_err(|e| ArtError::Resize(e.to_string()))?;
        let mut dst = fr::images::Image::new(tw, th, self.pixel_type());
        let opts = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(filter)).use_alpha(self.alpha);
        fr::Resizer::new().resize(&src, &mut dst, &opts).map_err(|e| ArtError::Resize(e.to_string()))?;
        Ok(Pixels { width: tw, height: th, channels: self.channels, alpha: self.alpha, data: dst.into_vec() })
    }

    /// The same pixels with an EXIF orientation applied.
    fn oriented(self, o: Orientation) -> Result<Pixels, ArtError> {
        if o == Orientation::NoTransforms {
            return Ok(self);
        }
        let Pixels { width, height, channels, alpha, data } = self;
        let bad = || ArtError::Decode("pixel buffer size mismatch".into());
        let mut img = match channels {
            1 => DynamicImage::ImageLuma8(ImageBuffer::from_raw(width, height, data).ok_or_else(bad)?),
            3 => DynamicImage::ImageRgb8(ImageBuffer::from_raw(width, height, data).ok_or_else(bad)?),
            _ => DynamicImage::ImageRgba8(ImageBuffer::from_raw(width, height, data).ok_or_else(bad)?),
        };
        img.apply_orientation(o);
        let (width, height) = (img.width(), img.height());
        let data = match img {
            DynamicImage::ImageLuma8(b) => b.into_raw(),
            DynamicImage::ImageRgb8(b) => b.into_raw(),
            DynamicImage::ImageRgba8(b) => b.into_raw(),
            other => other.into_rgba8().into_raw(), // unreachable: orientation keeps the type
        };
        Ok(Pixels { width, height, channels, alpha, data })
    }

    /// Accent colour from a 48×48 box-filtered copy (aspect ignored, like the old pipeline). A
    /// histogram, so the orientation doesn't matter. Greyscale has no accent by definition.
    fn accent(&self) -> Result<Option<[u8; 3]>, ArtError> {
        if self.channels == 1 {
            return Ok(None);
        }
        let small = if self.width == ACCENT_SIZE && self.height == ACCENT_SIZE {
            None
        } else {
            Some(self.resized(ACCENT_SIZE, ACCENT_SIZE, fr::FilterType::Box)?)
        };
        let p = small.as_ref().unwrap_or(self);
        Ok(accent_from_pixels(&p.data, p.channels as usize))
    }
}

struct Decoded {
    format: ImageFormat,
    /// In the stored orientation; `orientation` still has to be applied.
    pixels: Pixels,
    orientation: Orientation,
    icc: Option<Vec<u8>>,
}

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_image_width = Some(MAX_DIMENSION);
    l.max_image_height = Some(MAX_DIMENSION);
    l.max_alloc = Some(MAX_DECODER_ALLOC);
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

/// Rejects empty images and anything over the size caps, from the header alone.
fn check_size(w: u32, h: u32) -> Result<(), ArtError> {
    if w == 0 || h == 0 {
        return Err(ArtError::Decode("empty image".into()));
    }
    if w > MAX_DIMENSION || h > MAX_DIMENSION || w as u64 * h as u64 > MAX_PIXELS {
        return Err(ArtError::TooLarge(w, h));
    }
    Ok(())
}

fn swaps_axes(o: Orientation) -> bool {
    matches!(o, Orientation::Rotate90 | Orientation::Rotate270 | Orientation::Rotate90FlipH | Orientation::Rotate270FlipH)
}

fn oriented_size(w: u32, h: u32, o: Orientation) -> (u32, u32) {
    if swaps_axes(o) {
        (h, w)
    } else {
        (w, h)
    }
}

fn header(bytes: &[u8]) -> Result<Header, ArtError> {
    let (format, mut d) = open(bytes)?;
    let (w, h) = d.dimensions();
    check_size(w, h)?;
    let orientation = d.orientation().unwrap_or(Orientation::NoTransforms);
    let (width, height) = oriented_size(w, h, orientation);
    Ok(Header { format, width, height, orientation })
}

fn decode(bytes: &[u8]) -> Result<Decoded, ArtError> {
    let (format, mut d) = open(bytes)?;
    let (w, h) = d.dimensions();
    check_size(w, h)?;
    // `into_decoder` + `from_decoder` (unlike `ImageReader::decode`) doesn't hold the main
    // buffer to `max_alloc`; 16-bit sources are 2× the pixels' worth.
    if d.total_bytes() > MAX_DECODE_BYTES {
        return Err(ArtError::TooLarge(w, h));
    }
    let orientation = d.orientation().unwrap_or(Orientation::NoTransforms);
    let icc = d.icc_profile().ok().flatten();
    let img = DynamicImage::from_decoder(d).map_err(decode_err)?;
    Ok(Decoded { format, pixels: Pixels::from_image(img), orientation, icc })
}

/// Whether an ICC profile describes `channels`-channel output: its header's data colour space
/// (bytes 16..20) must be `GRAY` for greyscale and `RGB ` otherwise. A CMYK profile from a print
/// scan (decoded to RGB) or an RGB one on greyscale output would be wrong there (browsers ignore
/// mismatched profiles) and is often far bigger than a thumbnail.
fn icc_fits(icc: &[u8], channels: u8) -> bool {
    let want: &[u8; 4] = if channels == 1 { b"GRAY" } else { b"RGB " };
    icc.get(16..20) == Some(&want[..])
}

/// Opaque RGBA → RGB for the lossless encoders (small: only ever an already-resized image).
fn rgb_of_rgba(rgba: &[u8]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    for p in rgba.as_chunks::<4>().0 {
        rgb.extend_from_slice(&p[..3]);
    }
    rgb
}

fn encode(p: &Pixels, format: OutFormat, quality: u8, icc: Option<&[u8]>) -> Result<(Vec<u8>, &'static str), ArtError> {
    let enc_err = |e: &dyn fmt::Display| ArtError::Encode(e.to_string());
    let format = match format {
        OutFormat::Auto if p.alpha => OutFormat::Png,
        OutFormat::Auto => OutFormat::Jpeg,
        f => f,
    };
    let icc = icc.filter(|icc| icc_fits(icc, p.channels));
    let mut out = Vec::with_capacity(p.width as usize * p.height as usize / 4 + 1024);
    // Lossless outputs of opaque RGBA drop the constant alpha channel.
    let lossless_rgb;
    let (lossless, lossless_ct) = match (p.channels, p.alpha) {
        (1, _) => (&p.data[..], image::ExtendedColorType::L8),
        (3, _) => (&p.data[..], image::ExtendedColorType::Rgb8),
        (_, true) => (&p.data[..], image::ExtendedColorType::Rgba8),
        (_, false) if format == OutFormat::Png || format == OutFormat::Webp => {
            lossless_rgb = rgb_of_rgba(&p.data);
            (&lossless_rgb[..], image::ExtendedColorType::Rgb8)
        }
        (_, false) => (&p.data[..], image::ExtendedColorType::Rgba8),
    };
    match format {
        OutFormat::Jpeg | OutFormat::Auto => {
            let rgb;
            let (data, ct) = match (p.channels, p.alpha) {
                (1, _) => (&p.data[..], jpeg_encoder::ColorType::Luma),
                (3, _) => (&p.data[..], jpeg_encoder::ColorType::Rgb),
                // Opaque RGBA: the encoder ignores the alpha byte.
                (_, false) => (&p.data[..], jpeg_encoder::ColorType::Rgba),
                (_, true) => {
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
                }
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
            let mut e = image::codecs::png::PngEncoder::new_with_quality(
                &mut out,
                image::codecs::png::CompressionType::Fast,
                image::codecs::png::FilterType::Adaptive,
            );
            if let Some(icc) = icc {
                let _ = e.set_icc_profile(icc.to_vec());
            }
            e.write_image(lossless, p.width, p.height, lossless_ct).map_err(|e| enc_err(&e))?;
            Ok((out, "image/png"))
        }
        OutFormat::Webp => {
            image::codecs::webp::WebPEncoder::new_lossless(&mut out)
                .write_image(lossless, p.width, p.height, lossless_ct)
                .map_err(|e| enc_err(&e))?;
            Ok((out, "image/webp"))
        }
    }
}

/// Decode, downscale to fit `opts`, re-encode, and optionally pick the accent colour.
pub fn process(bytes: &[u8], opts: &ArtOptions) -> Result<ArtOutput, ArtError> {
    process_impl(bytes, opts, true)
}

/// `process`, except that a passthrough result's `data` is left empty: for callers that still
/// hold the input and would only copy it back (the napi wrapper returns the caller's own Buffer).
pub fn process_keeping_input(bytes: &[u8], opts: &ArtOptions) -> Result<ArtOutput, ArtError> {
    process_impl(bytes, opts, false)
}

fn process_impl(bytes: &[u8], opts: &ArtOptions, copy_passthrough: bool) -> Result<ArtOutput, ArtError> {
    let mut timings = Timings::default();
    let t = Instant::now();
    let fits = |w: u32, h: u32| fit(w, h, opts.max_width, opts.max_height) == (w, h);
    let passthrough_ok = |len: usize| opts.passthrough_max_bytes > 0 && len <= opts.passthrough_max_bytes;
    let input = |copy: bool| if copy { bytes.to_vec() } else { Vec::new() };

    // Fast path: small enough, no accent wanted → headers only, no pixel decode.
    if !opts.accent && passthrough_ok(bytes.len()) {
        let h = header(bytes)?;
        if fits(h.width, h.height) && h.orientation == Orientation::NoTransforms {
            timings.decode_us = us(t);
            return Ok(ArtOutput {
                data: input(copy_passthrough),
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

    let Decoded { format, pixels, orientation, icc } = decode(bytes)?;
    timings.decode_us = us(t);
    // Sizes are in display orientation; the pixels are still in stored orientation.
    let (sw, sh) = oriented_size(pixels.width, pixels.height, orientation);
    let (tw, th) = fit(sw, sh, opts.max_width, opts.max_height);
    let resize = (tw, th) != (sw, sh);
    // Passthrough keeps the original bytes (and its EXIF orientation, which Chromium applies).
    let passthrough = !resize && passthrough_ok(bytes.len());

    let t = Instant::now();
    let px = if resize {
        let (rw, rh) = oriented_size(tw, th, orientation);
        let small = pixels.resized(rw, rh, fr::FilterType::Lanczos3)?;
        drop(pixels); // the full-size decode is the biggest buffer: free it before encoding
        small
    } else {
        pixels
    };
    // Rotating after the resize touches the small copy only. Passthrough output keeps the
    // stored orientation, and the accent is a histogram: no need to rotate at all.
    let px = if passthrough { px } else { px.oriented(orientation)? };
    timings.resize_us = us(t);

    let t = Instant::now();
    let accent = if opts.accent { px.accent()? } else { None };
    timings.accent_us = us(t);

    let t = Instant::now();
    let (data, mime) = if passthrough { (input(copy_passthrough), mime_of(format)) } else { encode(&px, opts.format, opts.quality, icc.as_deref())? };
    timings.encode_us = us(t);

    Ok(ArtOutput {
        data,
        width: tw,
        height: th,
        mime,
        source_width: sw,
        source_height: sh,
        source_mime: mime_of(format),
        passthrough,
        accent,
        timings,
    })
}

/// Accent colour only (decode + 48×48 box downsample + `accent_from_pixels`). The same
/// computation as `process` with `accent` on an image that needs no resize.
pub fn accent_of(bytes: &[u8]) -> Result<Option<[u8; 3]>, ArtError> {
    // One box pass straight to 48×48: cheaper than the old two-step (≤ 512 px first, then 48)
    // because the box filter's cost is ~linear in the source either way, and it gives the same
    // answer as `process`.
    decode(bytes)?.pixels.accent()
}

/// `#rrggbb` for an accent triple.
pub fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

#[cfg(test)]
mod tests;
