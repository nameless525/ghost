//! Vibrant accent colour from cover-art pixels. A line-for-line port of `extractAccent` in
//! `src/main/net/accent.ts` (DESIGN §7.1): hue-bucketed, weighted toward saturated mid-light
//! pixels, then normalised to read well as a UI accent on the dark plum background.

fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if max == min {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (f64, f64, f64) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (((h % 360.0) + 360.0) % 360.0) / 60.0;
    let x = c * (1.0 - ((hp % 2.0) - 1.0).abs());
    let (r1, g1, b1) = if hp < 1.0 {
        (c, x, 0.0)
    } else if hp < 2.0 {
        (x, c, 0.0)
    } else if hp < 3.0 {
        (0.0, c, x)
    } else if hp < 4.0 {
        (0.0, x, c)
    } else if hp < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    let m = l - c / 2.0;
    (r1 + m, g1 + m, b1 + m)
}

fn to_u8(v: f64) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Pick a vibrant, mid-light colour from interleaved RGB (`channels` = 3) or RGBA (4) pixels.
/// Returns None for greyscale / near-monochrome art. Pixels with alpha < 128 are ignored.
pub fn accent_from_pixels(pixels: &[u8], channels: usize) -> Option<[u8; 3]> {
    const BUCKETS: usize = 24;
    assert!(channels == 3 || channels == 4, "accent_from_pixels: 3 or 4 channels");
    let mut weight = [0f64; BUCKETS];
    let mut sum_r = [0f64; BUCKETS];
    let mut sum_g = [0f64; BUCKETS];
    let mut sum_b = [0f64; BUCKETS];
    let mut total = 0u64;
    for px in pixels.chunks_exact(channels) {
        if channels == 4 && px[3] < 128 {
            continue;
        }
        total += 1;
        let r = px[0] as f64 / 255.0;
        let g = px[1] as f64 / 255.0;
        let b = px[2] as f64 / 255.0;
        let (h, s, l) = rgb_to_hsl(r, g, b);
        let chroma = r.max(g).max(b) - r.min(g).min(b);
        if chroma < 0.18 || !(0.12..=0.92).contains(&l) {
            continue;
        }
        // Prefer saturated, mid-light pixels.
        let w = chroma * chroma * s * (1.0 - (l - 0.55).abs() * 1.6).max(0.05);
        let k = ((h / (360.0 / BUCKETS as f64)).floor() as usize) % BUCKETS;
        weight[k] += w;
        sum_r[k] += r * w;
        sum_g[k] += g * w;
        sum_b[k] += b * w;
    }
    if total == 0 {
        return None;
    }
    let mut best: Option<usize> = None;
    let mut best_score = 0f64;
    let mut colored = 0f64;
    for k in 0..BUCKETS {
        colored += weight[k];
        // Neighbours only rank a bucket; the colour is its own mean, so an empty bucket between
        // two populated ones can't win (on a tie, the bucket with more weight of its own does).
        if weight[k] <= 0.0 {
            continue;
        }
        let score = weight[k] + 0.5 * (weight[(k + BUCKETS - 1) % BUCKETS] + weight[(k + 1) % BUCKETS]);
        if best.is_none_or(|b| score > best_score || (score == best_score && weight[k] > weight[b])) {
            best_score = score;
            best = Some(k);
        }
    }
    // Too little colour overall (greyscale art, tiny specks): no accent.
    let best = best?;
    if colored / (total as f64) < 0.004 {
        return None;
    }
    let r = sum_r[best] / weight[best];
    let g = sum_g[best] / weight[best];
    let b = sum_b[best] / weight[best];
    let (h, s, l) = rgb_to_hsl(r, g, b);
    // Normalise for UI use on a dark background: vivid and readable.
    let (nr, ng, nb) = hsl_to_rgb(h, s.clamp(0.55, 1.0), l.clamp(0.52, 0.68));
    Some([to_u8(nr), to_u8(ng), to_u8(nb)])
}
