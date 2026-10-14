//! Tempo estimation (autocorrelation of the onset envelope with a log-Gaussian tempo prior and
//! octave-error handling), Ellis (2007) dynamic-programming beat tracking, downbeat phase and
//! onset picking.

use rayon::prelude::*;

use super::features::Features;

pub(crate) const MIN_BPM: f32 = 60.0;
pub(crate) const MAX_BPM: f32 = 200.0;
/// Log-Gaussian tempo prior: centre and width (octaves).
const PRIOR_BPM: f32 = 120.0;
const PRIOR_OCTAVES: f32 = 1.0;
/// Octave check: prefer the faster of two octave-related tempi when its prior-weighted
/// autocorrelation is at least this fraction of the slower one's.
const OCTAVE_UP_RATIO: f32 = 0.65;
/// DP transition tightness (Ellis's α): larger = beats stick closer to the global period.
const TIGHTNESS: f32 = 120.0;
/// Below this confidence the beat grid is withheld.
pub(crate) const MIN_CONFIDENCE: f32 = 0.3;

#[derive(Clone, Debug, Default)]
pub(crate) struct BeatResult {
    /// Best tempo estimate even when confidence is low (None if no periodicity at all).
    pub bpm: Option<f32>,
    pub confidence: f32,
    pub beats: Vec<f32>,
    pub downbeats: Vec<f32>,
    pub diag: TempoDiag,
}

#[derive(Clone, Debug, Default)]
pub struct TempoDiag {
    /// Normalised autocorrelation of the onset envelope at the beat period.
    pub acf_peak: f32,
    /// Comb (harmonic-sum) periodicity strength at the beat period.
    pub comb: f32,
    /// Mean onset strength on beats / mean overall.
    pub alignment: f32,
    /// Fraction of ~12 s windows whose local tempo agrees with the global one.
    pub stability: f32,
}

/// Gaussian smoothing (σ in frames), truncated at 3σ, edge-normalised.
pub(crate) fn gauss_smooth(x: &[f32], sigma: f32) -> Vec<f32> {
    if sigma <= 0.0 || x.is_empty() {
        return x.to_vec();
    }
    let r = (3.0 * sigma).ceil() as isize;
    let k: Vec<f32> = (-r..=r).map(|i| (-0.5 * (i as f32 / sigma).powi(2)).exp()).collect();
    let n = x.len() as isize;
    (0..n)
        .into_par_iter()
        .map(|t| {
            let mut s = 0.0;
            let mut w = 0.0;
            for (j, &kv) in k.iter().enumerate() {
                let i = t + j as isize - r;
                if i >= 0 && i < n {
                    s += kv * x[i as usize];
                    w += kv;
                }
            }
            s / w
        })
        .collect()
}

/// Centred moving average over `2·half + 1` frames (edge-truncated).
pub(crate) fn moving_mean(x: &[f32], half: usize) -> Vec<f32> {
    let n = x.len();
    let mut pre = vec![0.0f64; n + 1];
    for i in 0..n {
        pre[i + 1] = pre[i] + x[i] as f64;
    }
    (0..n)
        .map(|t| {
            let a = t.saturating_sub(half);
            let b = (t + half + 1).min(n);
            ((pre[b] - pre[a]) / (b - a) as f64) as f32
        })
        .collect()
}

fn mean(x: &[f32]) -> f32 {
    if x.is_empty() {
        0.0
    } else {
        x.iter().sum::<f32>() / x.len() as f32
    }
}

fn std(x: &[f32]) -> f32 {
    let m = mean(x);
    (x.iter().map(|v| (v - m) * (v - m)).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

/// Linear interpolation into `r` at fractional lag `l` (0 outside).
fn at(r: &[f32], l: f32) -> f32 {
    if l < 0.0 {
        return 0.0;
    }
    let i = l.floor() as usize;
    if i + 1 >= r.len() {
        return 0.0;
    }
    let f = l - i as f32;
    r[i] * (1.0 - f) + r[i + 1] * f
}

/// Normalised autocorrelation (r[0] = 1) for lags `0..=max_lag`, unbiased.
fn autocorr(x: &[f32], max_lag: usize) -> Vec<f32> {
    let n = x.len();
    let max_lag = max_lag.min(n.saturating_sub(1));
    let r: Vec<f32> = (0..=max_lag)
        .into_par_iter()
        .map(|l| {
            let mut s = 0.0f64;
            for t in 0..n - l {
                s += (x[t] * x[t + l]) as f64;
            }
            (s / (n - l) as f64) as f32
        })
        .collect();
    let r0 = r[0].max(1e-12);
    r.into_iter().map(|v| v / r0).collect()
}

fn prior(bpm: f32) -> f32 {
    let o = (bpm / PRIOR_BPM).log2() / PRIOR_OCTAVES;
    (-0.5 * o * o).exp()
}

/// Harmonic-sum periodicity at period `p` (frames): onsets one, two, three and four beats apart.
fn comb(r: &[f32], p: f32) -> f32 {
    (at(r, p) + at(r, 2.0 * p) / 2.0 + at(r, 3.0 * p) / 3.0 + at(r, 4.0 * p) / 4.0) / (1.0 + 0.5 + 1.0 / 3.0 + 0.25)
}

/// Best tempo (BPM) from an onset-envelope autocorrelation, in two stages:
/// 1. the strongest comb periodicity under the log-Gaussian prior;
/// 2. an octave check: move to double tempo when the faster pulse is nearly as periodic as the
///    current one (a pure 174 BPM pulse is equally periodic at 87, but its "off-beats" are as
///    strong as its beats, so 174 is the beat), or to half tempo when the slower pulse is
///    much stronger. Evidence is the autocorrelation peak at the period times the prior.
fn pick_tempo(r: &[f32], fps: f32) -> Option<f32> {
    let period = |bpm: f32| 60.0 * fps / bpm;
    let mut best: Option<(f32, f32)> = None; // (score, bpm)
    let mut bpm = MIN_BPM;
    while bpm <= MAX_BPM {
        let score = prior(bpm) * comb(r, period(bpm)).max(0.0);
        if best.is_none_or(|b| score > b.0) {
            best = Some((score, bpm));
        }
        bpm += 0.05;
    }
    let (score, t1) = best?;
    if score <= 0.0 {
        return None;
    }
    // Autocorrelation peak near a tempo (±2%), and that tempo nudged onto the peak.
    let peak = |c: f32| -> (f32, f32) {
        let mut local = (f32::MIN, c);
        let mut b = c * 0.98;
        while b <= c * 1.02 {
            let v = at(r, period(b));
            if v > local.0 {
                local = (v, b);
            }
            b += 0.05;
        }
        local
    };
    let evidence = |c: f32| -> (f32, f32) {
        let (v, b) = peak(c);
        (v.max(0.0) * prior(b), b)
    };
    let in_range = |c: f32| (MIN_BPM * 0.98..=MAX_BPM * 1.02).contains(&c);
    let (e1, _) = evidence(t1);
    if in_range(2.0 * t1) {
        let (e2, b2) = evidence(2.0 * t1);
        if e2 >= OCTAVE_UP_RATIO * e1 {
            return Some(b2.clamp(MIN_BPM, MAX_BPM));
        }
    }
    if in_range(0.5 * t1) {
        let (eh, bh) = evidence(0.5 * t1);
        if e1 < OCTAVE_UP_RATIO * eh {
            return Some(bh.clamp(MIN_BPM, MAX_BPM));
        }
    }
    Some(t1)
}

/// Refine the period using the autocorrelation peaks at its multiples (parabolic peak
/// interpolation, least-squares slope through the origin).
fn refine_period(r: &[f32], p: f32) -> f32 {
    let mut num = 0.0f32;
    let mut den = 0.0f32;
    let base = at(r, p).max(1e-6);
    for k in 1..=12 {
        let c = k as f32 * p;
        let tol = (1.0 + 0.03 * c).min(0.25 * p).max(1.0);
        let lo = (c - tol).floor().max(1.0) as usize;
        let hi = (c + tol).ceil() as usize;
        if hi + 1 >= r.len() {
            break;
        }
        let (mut bi, mut bv) = (lo, f32::MIN);
        for (i, &v) in r.iter().enumerate().take(hi + 1).skip(lo) {
            if v > bv {
                bv = v;
                bi = i;
            }
        }
        if bv < 0.25 * base || bi == lo || bi == hi {
            continue;
        }
        let (y0, y1, y2) = (r[bi - 1], r[bi], r[bi + 1]);
        let d = y0 - 2.0 * y1 + y2;
        let off = if d < 0.0 { (0.5 * (y0 - y2) / d).clamp(-0.5, 0.5) } else { 0.0 };
        let lag = bi as f32 + off;
        let w = bv.max(0.0);
        num += w * k as f32 * lag;
        den += w * (k * k) as f32;
    }
    if den > 0.0 {
        let q = num / den;
        if (q / p - 1.0).abs() < 0.05 {
            return q;
        }
    }
    p
}

/// Frame level (dB) above which a frame counts as audible: 45 dB under the loud level (95th
/// percentile), but never below -80 dB.
pub(crate) fn active_threshold(f: &Features) -> Option<f32> {
    let mut sorted: Vec<f32> = f.frame_db.clone();
    sorted.sort_by(f32::total_cmp);
    let loud = *sorted.get(((sorted.len().max(1) - 1) as f32 * 0.95) as usize)?;
    (loud > -90.0).then_some((loud - 45.0).max(-80.0))
}

/// Active frame range: from the first to the last audible frame.
pub(crate) fn active_range(f: &Features) -> Option<(usize, usize)> {
    let thr = active_threshold(f)?;
    let a = f.frame_db.iter().position(|&d| d > thr)?;
    let b = f.frame_db.iter().rposition(|&d| d > thr)? + 1;
    (b > a).then_some((a, b))
}

/// Ellis (2007) DP beat tracker: maximise Σ onset(beat) − α·Σ ln(interval/period)².
/// Returns beat positions as fractional frames.
fn dp_beats(local: &[f32], a: usize, b: usize, p: f32) -> Vec<f32> {
    let n = b - a;
    let dmin = ((0.5 * p).round() as usize).max(1);
    let dmax = ((2.0 * p).round() as usize).max(dmin + 1);
    let pen: Vec<f32> = (0..=dmax).map(|d| if d < dmin { f32::NEG_INFINITY } else { -TIGHTNESS * (d as f32 / p).ln().powi(2) }).collect();
    let mut cum = vec![0.0f32; n];
    let mut back = vec![usize::MAX; n];
    for t in 0..n {
        let mut best = f32::NEG_INFINITY;
        let mut arg = usize::MAX;
        if t >= dmin {
            let lo = t.saturating_sub(dmax);
            for tau in lo..=t - dmin {
                let v = cum[tau] + pen[t - tau];
                if v > best {
                    best = v;
                    arg = tau;
                }
            }
        }
        let l = local[a + t];
        if arg != usize::MAX && best > 0.0 {
            cum[t] = l + best;
            back[t] = arg;
        } else {
            cum[t] = l;
        }
    }
    // Last beat: best cumulative score within the final period.
    let tail = n.saturating_sub(p.ceil() as usize);
    let mut t = (tail..n).max_by(|&x, &y| cum[x].total_cmp(&cum[y])).unwrap_or(0);
    let mut beats = Vec::new();
    loop {
        beats.push(t);
        if back[t] == usize::MAX {
            break;
        }
        t = back[t];
    }
    beats.reverse();
    // Sub-frame refinement on the local score peak.
    beats
        .into_iter()
        .map(|t| {
            let g = a + t;
            if g > 0 && g + 1 < local.len() {
                let (y0, y1, y2) = (local[g - 1], local[g], local[g + 1]);
                let d = y0 - 2.0 * y1 + y2;
                if y1 >= y0 && y1 >= y2 && d < 0.0 {
                    return g as f32 + (0.5 * (y0 - y2) / d).clamp(-0.5, 0.5);
                }
            }
            g as f32
        })
        .collect()
}

/// Fraction of overlapping ~12 s windows whose own best period agrees with `p` (or is within a
/// few % of it). Rubato and free-time music scores low; a steady groove scores ~1.
fn stability(oh: &[f32], fps: f32, p: f32) -> f32 {
    let win = (12.0 * fps) as usize;
    let step = (4.0 * fps) as usize;
    if oh.len() < win || step == 0 {
        return 0.5;
    }
    let max_lag = (4.5 * p).ceil() as usize + 2;
    let starts: Vec<usize> = (0..=oh.len() - win).step_by(step).collect();
    let agree: Vec<f32> = starts
        .par_iter()
        .map(|&s| {
            let seg = &oh[s..s + win];
            if std(seg) < 1e-6 {
                return 0.0;
            }
            let r = autocorr(seg, max_lag.min(win / 2));
            // Local best period in a ±25% band around p (ignoring octave choice).
            let lo = 0.75 * p;
            let hi = 1.25 * p;
            let mut best = (f32::MIN, p);
            let mut q = lo;
            while q <= hi {
                let c = comb(&r, q);
                if c > best.0 {
                    best = (c, q);
                }
                q += 0.05;
            }
            if best.0 <= 0.05 {
                return 0.0;
            }
            if (best.1 / p - 1.0).abs() < 0.03 {
                1.0
            } else {
                0.0
            }
        })
        .collect();
    mean(&agree)
}

/// Peak-picked onsets (frame indices) from the smoothed onset envelope.
pub(crate) fn pick_onsets(os: &[f32], fps: f32, active: (usize, usize)) -> Vec<usize> {
    let (a, b) = active;
    if b <= a + 2 {
        return Vec::new();
    }
    let w = ((0.03 * fps).round() as usize).max(1); // ±30 ms local maximum
    let avg = moving_mean(os, (0.5 * fps) as usize);
    let sd = std(&os[a..b]);
    let min_gap = ((0.05 * fps).round() as usize).max(1);
    let mut out: Vec<usize> = Vec::new();
    for t in a.max(1)..b - 1 {
        let v = os[t];
        // Must clear 1.5× the local (±0.5 s) mean plus half a standard deviation of the whole
        // envelope: sparse, clear attacks count, texture fluctuations don't.
        if v <= avg[t] * 1.5 + 0.5 * sd || v < 0.02 {
            continue;
        }
        let lo = t.saturating_sub(w);
        let hi = (t + w + 1).min(os.len());
        if os[lo..hi].iter().any(|&x| x > v) {
            continue;
        }
        if out.last().is_some_and(|&l| t - l < min_gap) {
            continue;
        }
        out.push(t);
    }
    out
}

pub(crate) fn track(f: &Features, os: &[f32], active: Option<(usize, usize)>) -> BeatResult {
    let fps = f.fps;
    let Some((a, b)) = active else {
        return BeatResult::default();
    };
    if ((b - a) as f32) < 6.0 * fps {
        return BeatResult::default();
    }
    // High-pass the envelope (remove the ~3 s local mean) so the autocorrelation sees pulses,
    // not slow swells.
    let trend = moving_mean(os, (1.5 * fps) as usize);
    let oh: Vec<f32> = os.iter().zip(&trend).map(|(x, m)| x - m).collect();
    let seg = &oh[a..b];
    if std(seg) < 1e-6 {
        return BeatResult::default();
    }
    let max_lag = (4.0 * 60.0 / MIN_BPM * fps) as usize + 4; // four beats at the slowest tempo
    let r = autocorr(seg, max_lag);
    let Some(bpm0) = pick_tempo(&r, fps) else {
        return BeatResult::default();
    };
    let p = refine_period(&r, 60.0 * fps / bpm0);
    // DP over a normalised, peak-emphasised local score (Gaussian of width p/32 like Ellis).
    let pos: Vec<f32> = oh.iter().map(|v| v.max(0.0)).collect();
    let sd = std(&pos[a..b]).max(1e-9);
    let norm: Vec<f32> = pos.iter().map(|v| v / sd).collect();
    let local = gauss_smooth(&norm, (p / 32.0).max(0.5));
    let beat_frames = dp_beats(&local, a, b, p);

    // Tempo from the beats themselves: average interval over runs of consistent intervals.
    let mut span = 0.0f32;
    let mut count = 0usize;
    for w in beat_frames.windows(2) {
        let d = w[1] - w[0];
        if (d / p - 1.0).abs() < 0.08 {
            span += d;
            count += 1;
        }
    }
    let period = if count >= 8 { span / count as f32 } else { p };
    let bpm = 60.0 * fps / period;

    // Confidence ingredients.
    let acf_peak = at(&r, p).max(0.0);
    let comb_v = comb(&r, p).max(0.0);
    let on_beats: Vec<f32> = beat_frames
        .iter()
        .map(|&t| {
            let i = t.round() as usize;
            os[i.saturating_sub(1)..(i + 2).min(os.len())].iter().copied().fold(0.0, f32::max)
        })
        .collect();
    let alignment = mean(&on_beats) / mean(&os[a..b]).max(1e-9);
    let stab = stability(&oh[a..b], fps, p);
    let regular = count as f32 / (beat_frames.len().max(2) - 1) as f32;
    let confidence = confidence(acf_peak, comb_v, alignment, stab, regular);

    let mut res = BeatResult {
        bpm: Some(bpm),
        confidence,
        diag: TempoDiag { acf_peak, comb: comb_v, alignment, stability: stab },
        ..Default::default()
    };
    if confidence >= MIN_CONFIDENCE {
        res.beats = beat_frames.iter().map(|&t| f.time_of(t)).collect();
        let phase = downbeat_phase(f, &beat_frames);
        res.downbeats = beat_frames.iter().skip(phase).step_by(4).map(|&t| f.time_of(t)).collect();
    }
    res
}

/// Combine periodicity evidence into 0..1. Calibrated so steady grooves land ≥ 0.6, music with
/// a loose but audible pulse ~0.35–0.6, and ambient / rubato / noise below 0.3.
fn confidence(acf_peak: f32, comb: f32, alignment: f32, stability: f32, regular: f32) -> f32 {
    let periodic = ((comb - 0.03) / 0.22).clamp(0.0, 1.0);
    let peaky = ((acf_peak - 0.03) / 0.25).clamp(0.0, 1.0);
    let aligned = ((alignment - 1.15) / 1.0).clamp(0.0, 1.0);
    let c = 0.35 * periodic + 0.15 * peaky + 0.25 * aligned + 0.25 * stability;
    (c * (0.5 + 0.5 * regular)).clamp(0.0, 1.0)
}

/// Which of the four beat phases carries the downbeat: the one with the most low-frequency
/// onset energy (kick/bass entries), with overall onset strength as a secondary cue.
fn downbeat_phase(f: &Features, beats: &[f32]) -> usize {
    if beats.len() < 8 {
        return 0;
    }
    let lf = &f.flux_lf;
    let all = &f.flux;
    let m_lf = mean(lf).max(1e-9);
    let m_all = mean(all).max(1e-9);
    let mut score = [0.0f32; 4];
    let mut cnt = [0usize; 4];
    for (i, &t) in beats.iter().enumerate() {
        let c = t.round() as usize;
        let lo = c.saturating_sub(2);
        let hi = (c + 3).min(lf.len());
        if lo >= hi {
            continue;
        }
        let l = lf[lo..hi].iter().copied().fold(0.0, f32::max) / m_lf;
        let o = all[lo..hi].iter().copied().fold(0.0, f32::max) / m_all;
        score[i % 4] += l + 0.5 * o;
        cnt[i % 4] += 1;
    }
    (0..4).max_by(|&x, &y| (score[x] / cnt[x].max(1) as f32).total_cmp(&(score[y] / cnt[y].max(1) as f32))).unwrap_or(0)
}
