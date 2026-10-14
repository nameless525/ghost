//! Energy curve (seek-bar density graph) and kiai (high-energy section) detection.

use super::loudness::{SERIES_HOP_SEC, SILENCE_LUFS};
use super::tempo::gauss_smooth;
use crate::ENERGY_POINTS;

/// Loudness span shown by the energy curve below the track's loudest point (LU): the 10th
/// percentile sits just above the bottom, within these limits.
const ENERGY_MIN_SPAN_LU: f32 = 12.0;
const ENERGY_MAX_SPAN_LU: f32 = 30.0;

/// Kiai thresholds as percentiles of the track's own combined-energy distribution.
const KIAI_ENTER_PCT: f32 = 0.75;
const KIAI_EXIT_PCT: f32 = 0.60;
const KIAI_MIN_SEC: f32 = 8.0;
const KIAI_MERGE_GAP_SEC: f32 = 4.0;
/// Track must have at least this much spread (P90 − P10 of combined energy, LU) to have kiai.
const KIAI_MIN_SPREAD: f32 = 2.5;
/// A section must stand this far (LU-equivalent) above the median of the rest of the track.
const KIAI_MIN_CONTRAST: f32 = 2.0;
/// Absolute floor: sections quieter than this (short-term LUFS) are never kiai.
const KIAI_MIN_LUFS: f32 = -30.0;
/// Onset density (onsets/s) a section needs; calm, sparse music doesn't get kiai.
const KIAI_MIN_DENSITY: f32 = 1.5;
/// Tracks rated below this many stars get no kiai sections.
pub(crate) const KIAI_MIN_STARS: f32 = 2.5;
/// Weight of onset density: LU-equivalent per doubling of onsets/s.
const DENSITY_LU_PER_DOUBLING: f32 = 3.0;

fn percentile(sorted: &[f32], q: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let x = q.clamp(0.0, 1.0) * (sorted.len() - 1) as f32;
    let i = x.floor() as usize;
    let j = (i + 1).min(sorted.len() - 1);
    sorted[i] + (sorted[j] - sorted[i]) * (x - i as f32)
}

fn sorted(v: impl IntoIterator<Item = f32>) -> Vec<f32> {
    let mut s: Vec<f32> = v.into_iter().collect();
    s.sort_by(f32::total_cmp);
    s
}

/// `ENERGY_POINTS` values in 0..1 from momentary loudness: power-averaged per point, lightly
/// smoothed, then mapped linearly in LU from `top − span` (0) to the loudest point (1).
pub(crate) fn energy_curve(momentary: &[f32], duration: f32) -> Vec<f32> {
    if momentary.is_empty() || duration <= 0.0 {
        return vec![0.0; ENERGY_POINTS];
    }
    let hop = SERIES_HOP_SEC;
    // Centre time of each momentary (400 ms) block.
    let centre = |i: usize| ((i + 1) as f32 * hop - 0.2).max(0.0);
    let pow: Vec<f32> = momentary.iter().map(|&l| if l <= SILENCE_LUFS + 1.0 { 0.0 } else { 10f32.powf(l / 10.0) }).collect();
    let span = duration / ENERGY_POINTS as f32;
    let mut pts = vec![0.0f32; ENERGY_POINTS];
    let mut idx = 0usize;
    for (j, p) in pts.iter_mut().enumerate() {
        let (t0, t1) = (j as f32 * span, (j + 1) as f32 * span);
        while idx < pow.len() && centre(idx) < t0 {
            idx += 1;
        }
        let mut k = idx;
        let mut s = 0.0;
        let mut c = 0;
        while k < pow.len() && centre(k) < t1 {
            s += pow[k];
            c += 1;
            k += 1;
        }
        *p = if c > 0 {
            s / c as f32
        } else {
            // Points narrower than the 100 ms hop: interpolate.
            let tc = 0.5 * (t0 + t1);
            let x = ((tc + 0.2) / hop - 1.0).clamp(0.0, (pow.len() - 1) as f32);
            let i = x.floor() as usize;
            let i2 = (i + 1).min(pow.len() - 1);
            pow[i] + (pow[i2] - pow[i]) * (x - i as f32)
        };
    }
    let lufs: Vec<f32> = pts.iter().map(|&p| if p > 0.0 { 10.0 * p.log10() } else { SILENCE_LUFS }).collect();
    let lufs = gauss_smooth(&lufs, 1.0);
    let top = lufs.iter().copied().fold(f32::MIN, f32::max);
    if top < -70.0 {
        return vec![0.0; ENERGY_POINTS];
    }
    // Span adapts to the track: compressed tracks still show their shape (≥ 12 LU span),
    // dynamic ones keep quiet passages visible (≤ 30 LU span).
    let audible = sorted(lufs.iter().copied().filter(|&l| l > -70.0));
    let p10 = percentile(&audible, 0.10);
    let span = (top - p10 + 3.0).clamp(ENERGY_MIN_SPAN_LU, ENERGY_MAX_SPAN_LU);
    let floor = top - span;
    lufs.iter().map(|&l| ((l - floor) / span).clamp(0.0, 1.0)).collect()
}

/// Detect kiai sections from short-term (3 s) loudness and onset density, using hysteresis
/// thresholds relative to the track's own distribution. Section edges are snapped to a nearby
/// downbeat (or beat) when a beat grid exists.
pub(crate) fn kiai(
    short_term: &[f32],
    momentary: &[f32],
    onset_times: &[f32],
    duration: f32,
    beats: &[f32],
    downbeats: &[f32],
) -> Vec<(f32, f32)> {
    let hop = SERIES_HOP_SEC;
    let n = short_term.len();
    if n < (2.0 * KIAI_MIN_SEC / hop) as usize {
        return Vec::new();
    }
    // Short-term value i covers [(i+1)·hop − 3, (i+1)·hop]; centre it.
    let centre = |i: usize| ((i + 1) as f32 * hop - 1.5).max(0.0);

    // Onset density (onsets/s) in the same 3 s windows.
    let density: Vec<f32> = (0..n)
        .map(|i| {
            let c = centre(i);
            let lo = onset_times.partition_point(|&t| t < c - 1.5);
            let hi = onset_times.partition_point(|&t| t < c + 1.5);
            (hi - lo) as f32 / 3.0
        })
        .collect();
    let active: Vec<usize> = (0..n).filter(|&i| short_term[i] > -70.0).collect();
    if active.len() < (2.0 * KIAI_MIN_SEC / hop) as usize {
        return Vec::new();
    }
    let med_d = percentile(&sorted(active.iter().map(|&i| density[i])), 0.5);
    // Combined energy in LU-equivalents: loudness plus a bonus/penalty for busier/sparser
    // passages than the track's median.
    let comb: Vec<f32> = (0..n)
        .map(|i| {
            let d = DENSITY_LU_PER_DOUBLING * ((density[i] + 0.5) / (med_d + 0.5)).log2();
            short_term[i] + d.clamp(-6.0, 6.0)
        })
        .collect();
    let dist = sorted(active.iter().map(|&i| comb[i]));
    let p10 = percentile(&dist, 0.10);
    let p90 = percentile(&dist, 0.90);
    if p90 - p10 < KIAI_MIN_SPREAD {
        return Vec::new(); // flat track
    }
    let enter = percentile(&dist, KIAI_ENTER_PCT);
    let exit = percentile(&dist, KIAI_EXIT_PCT);

    // Hysteresis.
    let mut raw: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    for (i, &c) in comb.iter().enumerate() {
        match start {
            None if c > enter => start = Some(i),
            Some(s) if c < exit => {
                raw.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        raw.push((s, n));
    }
    // Merge short gaps, then drop short sections.
    let gap = (KIAI_MERGE_GAP_SEC / hop) as usize;
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (s, e) in raw {
        match merged.last_mut() {
            Some(last) if s - last.1 < gap => last.1 = e,
            _ => merged.push((s, e)),
        }
    }
    let min_len = (KIAI_MIN_SEC / hop) as usize;
    let in_any = |i: usize, secs: &[(usize, usize)]| secs.iter().any(|&(s, e)| i >= s && i < e);
    merged.retain(|&(s, e)| e - s >= min_len);
    let rest = sorted(active.iter().copied().filter(|&i| !in_any(i, &merged)).map(|i| comb[i]));
    let rest_med = if rest.is_empty() { p10 } else { percentile(&rest, 0.5) };
    merged.retain(|&(s, e)| {
        let len = (e - s) as f32;
        let m_comb = comb[s..e].iter().sum::<f32>() / len;
        let m_lufs = 10.0 * (short_term[s..e].iter().map(|&l| 10f32.powf(l / 10.0)).sum::<f32>() / len).log10();
        let m_dens = density[s..e].iter().sum::<f32>() / len;
        m_comb - rest_med >= KIAI_MIN_CONTRAST && m_lufs >= KIAI_MIN_LUFS && m_dens >= KIAI_MIN_DENSITY
    });

    // The 3 s windows blur the edges by ~1.5 s: move each edge to the sharpest loudness step
    // nearby (momentary loudness), then onto a downbeat (or beat) when there is a grid.
    let snap = |t: f32| -> f32 {
        let near = |grid: &[f32], tol: f32| {
            grid.iter().copied().filter(|g| (g - t).abs() <= tol).min_by(|x, y| (x - t).abs().total_cmp(&(y - t).abs()))
        };
        near(downbeats, 0.5).or_else(|| near(beats, 0.5)).unwrap_or(t)
    };
    let mut out: Vec<(f32, f32)> = Vec::new();
    for (s, e) in merged {
        let t0 = snap(refine_edge(momentary, centre(s), true)).clamp(0.0, duration);
        let t1 = if e >= n { duration } else { snap(refine_edge(momentary, centre(e), false)).clamp(0.0, duration) };
        match out.last_mut() {
            // Refined edges can close a gap: merge again.
            Some(last) if t0 - last.1 < KIAI_MERGE_GAP_SEC => last.1 = last.1.max(t1),
            _ => out.push((t0, t1)),
        }
    }
    out.retain(|(a, b)| b - a >= KIAI_MIN_SEC);
    out
}

/// Time within ±3 s of `t` where momentary loudness steps up (`rising`) or down the most,
/// comparing the mean over the 1.5 s after with the 1.5 s before.
fn refine_edge(momentary: &[f32], t: f32, rising: bool) -> f32 {
    let hop = SERIES_HOP_SEC;
    let n = momentary.len();
    if n < 40 {
        return t;
    }
    // Momentary block i covers [(i+1)·hop − 0.4, (i+1)·hop]; centre at (i+1)·hop − 0.2.
    let idx = |time: f32| -> isize { ((time + 0.2) / hop).round() as isize - 1 };
    let mean = |a: isize, b: isize| -> Option<f32> {
        let (a, b) = (a.max(0) as usize, (b.max(0) as usize).min(n));
        (b > a).then(|| momentary[a..b].iter().map(|&l| l.max(-70.0)).sum::<f32>() / (b - a) as f32)
    };
    let w = (1.5 / hop) as isize;
    let mut best = (f32::MIN, t);
    let mut c = t - 3.0;
    while c <= t + 3.0 {
        let i = idx(c);
        if let (Some(before), Some(after)) = (mean(i - w, i), mean(i, i + w)) {
            let step = if rising { after - before } else { before - after };
            if step > best.0 {
                best = (step, c);
            }
        }
        c += hop;
    }
    if best.0 > 1.0 {
        best.1
    } else {
        t
    }
}
