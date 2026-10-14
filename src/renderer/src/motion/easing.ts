// The full Penner easing set, named like osu!framework's `Easing` enum (OutQuint is the
// house default). Every function maps t∈[0,1] → progress (may overshoot for Back/Elastic).

export type EasingFn = (t: number) => number

const { PI, sin, cos, pow, sqrt } = Math
const c1 = 1.70158
const c2 = c1 * 1.525
const c3 = c1 + 1
const c4 = (2 * PI) / 3
const c5 = (2 * PI) / 4.5

function outBounce(t: number): number {
  const n1 = 7.5625
  const d1 = 2.75
  if (t < 1 / d1) return n1 * t * t
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375
  return n1 * (t -= 2.625 / d1) * t + 0.984375
}

export const easings = {
  linear: (t: number) => t,

  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2),

  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - pow(1 - t, 3),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2),

  inQuart: (t: number) => t * t * t * t,
  outQuart: (t: number) => 1 - pow(1 - t, 4),
  inOutQuart: (t: number) => (t < 0.5 ? 8 * t * t * t * t : 1 - pow(-2 * t + 2, 4) / 2),

  inQuint: (t: number) => t * t * t * t * t,
  outQuint: (t: number) => 1 - pow(1 - t, 5),
  inOutQuint: (t: number) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - pow(-2 * t + 2, 5) / 2),

  inSine: (t: number) => 1 - cos((t * PI) / 2),
  outSine: (t: number) => sin((t * PI) / 2),
  inOutSine: (t: number) => -(cos(PI * t) - 1) / 2,

  inExpo: (t: number) => (t === 0 ? 0 : pow(2, 10 * t - 10)),
  outExpo: (t: number) => (t === 1 ? 1 : 1 - pow(2, -10 * t)),
  inOutExpo: (t: number) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? pow(2, 20 * t - 10) / 2 : (2 - pow(2, -20 * t + 10)) / 2,
  /** osu!framework's OutPow10: an even snappier ease-out. */
  outPow10: (t: number) => 1 - pow(1 - t, 10),

  inCirc: (t: number) => 1 - sqrt(1 - t * t),
  outCirc: (t: number) => sqrt(1 - pow(t - 1, 2)),
  inOutCirc: (t: number) => (t < 0.5 ? (1 - sqrt(1 - pow(2 * t, 2))) / 2 : (sqrt(1 - pow(-2 * t + 2, 2)) + 1) / 2),

  inBack: (t: number) => c3 * t * t * t - c1 * t * t,
  outBack: (t: number) => 1 + c3 * pow(t - 1, 3) + c1 * pow(t - 1, 2),
  inOutBack: (t: number) =>
    t < 0.5 ? (pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2 : (pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2,

  inElastic: (t: number) => (t === 0 ? 0 : t === 1 ? 1 : -pow(2, 10 * t - 10) * sin((t * 10 - 10.75) * c4)),
  outElastic: (t: number) => (t === 0 ? 0 : t === 1 ? 1 : pow(2, -10 * t) * sin((t * 10 - 0.75) * c4) + 1),
  /** osu!framework OutElasticHalf: elastic with a single, softer wobble. */
  outElasticHalf: (t: number) => (t === 0 ? 0 : t === 1 ? 1 : pow(2, -10 * t) * sin((0.5 * t - 0.075) * 2 * PI / 0.3) + 1),
  /** osu!framework OutElasticQuarter: barely-there elastic settle. */
  outElasticQuarter: (t: number) => (t === 0 ? 0 : t === 1 ? 1 : pow(2, -10 * t) * sin((0.25 * t - 0.075) * 2 * PI / 0.3) + 1),
  inOutElastic: (t: number) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? -(pow(2, 20 * t - 10) * sin((20 * t - 11.125) * c5)) / 2 : (pow(2, -20 * t + 10) * sin((20 * t - 11.125) * c5)) / 2 + 1,

  inBounce: (t: number) => 1 - outBounce(1 - t),
  outBounce,
  inOutBounce: (t: number) => (t < 0.5 ? (1 - outBounce(1 - 2 * t)) / 2 : (1 + outBounce(2 * t - 1)) / 2)
} satisfies Record<string, EasingFn>

export type EasingName = keyof typeof easings
export type Easing = EasingName | EasingFn

export const DEFAULT_EASING: EasingName = 'outQuint'

export function resolveEasing(e: Easing | undefined): EasingFn {
  if (!e) return easings.outQuint
  return typeof e === 'function' ? e : (easings[e] ?? easings.outQuint)
}

/** CSS cubic-bezier equivalents for the common ones (for CSS transitions). */
export const cssEasing = {
  outQuint: 'cubic-bezier(0.22, 1, 0.36, 1)',
  outExpo: 'cubic-bezier(0.16, 1, 0.3, 1)',
  outCubic: 'cubic-bezier(0.33, 1, 0.68, 1)',
  outQuad: 'cubic-bezier(0.5, 1, 0.89, 1)',
  outBack: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  inOutQuint: 'cubic-bezier(0.83, 0, 0.17, 1)',
  inQuint: 'cubic-bezier(0.64, 0, 0.78, 0)',
  inOutSine: 'cubic-bezier(0.37, 0, 0.63, 1)'
} as const

/** Clamp to [0, 1]. */
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Frame-rate independent exponential approach (osu!'s `Interpolation.Damp`).
 * `halfLifeMs` is the time for the remaining distance to halve.
 */
export function damp(current: number, target: number, halfLifeMs: number, dtMs: number): number {
  if (halfLifeMs <= 0) return target
  return target + (current - target) * Math.pow(0.5, dtMs / halfLifeMs)
}
