// Small colour toolkit: hex <-> rgb, OKLab/OKLCH, mixing, accent normalisation.
// Everything here is allocation-light so it can run inside the frame loop.

export type RGB = [number, number, number] // 0..255
export type Lab = [number, number, number] // OKLab L 0..1, a, b

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h.slice(0, 6), 16)
  if (Number.isNaN(n)) return [255, 102, 170]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + ((1 << 24) | (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b)).toString(16).slice(1)
}

export function rgbToNumber(c: RGB | readonly number[]): number {
  return (clamp255(c[0]) << 16) | (clamp255(c[1]) << 8) | clamp255(c[2])
}

/** 'r g b' for use in rgb(var(--x-rgb) / a). */
export const rgbTriplet = (c: RGB | readonly number[]): string => `${clamp255(c[0])} ${clamp255(c[1])} ${clamp255(c[2])}`

export function withAlpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgb(${r} ${g} ${b} / ${a})`
}

// ---- OKLab (Björn Ottosson) -------------------------------------------------

const toLinear = (c: number) => {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
const fromLinear = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

export function rgbToOklab(c: RGB | readonly number[]): Lab {
  const r = toLinear(c[0])
  const g = toLinear(c[1])
  const b = toLinear(c[2])
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

export function oklabToRgb(lab: Lab | readonly number[], out: RGB = [0, 0, 0]): RGB {
  const [L, a, b] = lab
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  out[0] = clamp255(fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s))
  out[1] = clamp255(fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s))
  out[2] = clamp255(fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))
  return out
}

export function oklch(hex: string): { l: number; c: number; h: number } {
  const [L, a, b] = rgbToOklab(hexToRgb(hex))
  return { l: L, c: Math.hypot(a, b), h: Math.atan2(b, a) }
}

export function fromOklch(l: number, c: number, h: number): string {
  const rgb = oklabToRgb([l, c * Math.cos(h), c * Math.sin(h)])
  return rgbToHex(rgb[0], rgb[1], rgb[2])
}

/** Perceptual mix of two hex colours (t=0 → a, t=1 → b). */
export function mix(a: string, b: string, t: number): string {
  const la = rgbToOklab(hexToRgb(a))
  const lb = rgbToOklab(hexToRgb(b))
  const rgb = oklabToRgb([la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, la[2] + (lb[2] - la[2]) * t])
  return rgbToHex(rgb[0], rgb[1], rgb[2])
}

/** Plain sRGB mix on numeric 0xRRGGBB colours (cheap; for per-frame tinting). */
export function mixNumber(a: number, b: number, t: number): number {
  const r = ((a >> 16) & 255) + ((((b >> 16) & 255) - ((a >> 16) & 255)) * t)
  const g = ((a >> 8) & 255) + ((((b >> 8) & 255) - ((a >> 8) & 255)) * t)
  const bl = (a & 255) + (((b & 255) - (a & 255)) * t)
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl)
}

/** WCAG relative luminance 0..1. */
export function luminance(c: RGB | readonly number[]): number {
  const f = (v: number) => toLinear(v)
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}

/** WCAG contrast ratio of two colours, 1..21. */
export function contrast(a: RGB | readonly number[], b: RGB | readonly number[]): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The two inks for text on an accent fill. */
const DARK_INK = '#1a1024'
const LIGHT_INK = '#ffffff'

/**
 * Make an arbitrary art-derived colour usable as a UI accent on our dark base:
 * clamps OKLCH lightness into a readable band and guarantees some chroma so it
 * never reads as grey. Hue is preserved.
 */
export function normalizeAccent(hex: string | null | undefined, fallback = '#ff66aa'): string {
  if (!hex || !/^#?[0-9a-f]{3,8}$/i.test(hex.trim())) return fallback
  const { l, c, h } = oklch(hex.startsWith('#') ? hex : '#' + hex)
  const L = Math.min(0.83, Math.max(0.68, l))
  // near-grey input: hue is meaningless, so keep it neutral-ish but warm it slightly
  const C = c < 0.025 ? 0.06 : Math.min(0.24, Math.max(0.13, c))
  return fromOklch(L, C, h)
}

/**
 * Derived accent family used by the theme. `ink` (text on an accent fill) is whichever of the two
 * inks contrasts more with it: a luminance cut-off put white on the mid-light accents (the default
 * pink: 2.7:1) where the dark ink reads at 6.8:1. Normalised accents always get the dark ink.
 */
export function accentFamily(hex: string): { base: RGB; hi: RGB; lo: RGB; ink: string } {
  const base = hexToRgb(hex)
  const [L, a, b] = rgbToOklab(base)
  const hi = oklabToRgb([Math.min(0.94, L + 0.08), a * 0.85, b * 0.85])
  const lo = oklabToRgb([Math.max(0.3, L - 0.2), a * 1.05, b * 1.05])
  const ink = contrast(base, hexToRgb(DARK_INK)) >= contrast(base, hexToRgb(LIGHT_INK)) ? DARK_INK : LIGHT_INK
  return { base, hi, lo, ink }
}
