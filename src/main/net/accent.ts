// Vibrant accent colour from cover art (DESIGN §7.1: "the accent colour comes from the current
// game's art (a vibrant swatch)").
//
// In the app the accent is computed natively, off the main thread, by the art pipeline
// (native/crates/ghost-art, `accent.rs` is a line-for-line port of `extractAccent` below; its
// tests pin the same outputs) while the cover is being decoded anyway (see art-protocol.ts).
// This TS version is the reference implementation: pure pixel math, unit-tested, never fed by
// Electron's nativeImage.

/** `[r, g, b]` (0–255) → '#rrggbb'; null passes through. */
export function accentHex(rgb: readonly [number, number, number] | null | undefined): string | null {
  if (!rgb) return null
  return `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h * 60, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return [r1 + m, g1 + m, b1 + m]
}

const hex = (v: number) =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0')

/**
 * Pick a vibrant, mid-light colour from raw pixels.
 * @param pixels 4 bytes per pixel; `order` says where R/G/B sit (BGRA for Skia-style bitmaps).
 * @returns '#rrggbb', or null for greyscale / near-monochrome art.
 */
export function extractAccent(pixels: Uint8Array, order: 'rgba' | 'bgra' = 'bgra'): string | null {
  const BUCKETS = 24
  const weight = new Float64Array(BUCKETS)
  const sumR = new Float64Array(BUCKETS)
  const sumG = new Float64Array(BUCKETS)
  const sumB = new Float64Array(BUCKETS)
  const ri = order === 'rgba' ? 0 : 2
  const bi = order === 'rgba' ? 2 : 0
  let total = 0
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue
    total++
    const r = pixels[i + ri] / 255
    const g = pixels[i + 1] / 255
    const b = pixels[i + bi] / 255
    const [h, s, l] = rgbToHsl(r, g, b)
    const chroma = Math.max(r, g, b) - Math.min(r, g, b)
    if (chroma < 0.18 || l < 0.12 || l > 0.92) continue
    // Prefer saturated, mid-light pixels.
    const w = chroma * chroma * s * Math.max(0.05, 1 - Math.abs(l - 0.55) * 1.6)
    const k = Math.floor(h / (360 / BUCKETS)) % BUCKETS
    weight[k] += w
    sumR[k] += r * w
    sumG[k] += g * w
    sumB[k] += b * w
  }
  if (!total) return null
  let best = -1
  let bestScore = 0
  let colored = 0
  for (let k = 0; k < BUCKETS; k++) {
    colored += weight[k]
    // Neighbours only rank a bucket; the colour is its own mean, so an empty bucket between two
    // populated ones can't win (on a tie, the bucket with more weight of its own does).
    if (weight[k] <= 0) continue
    const score = weight[k] + 0.5 * (weight[(k + BUCKETS - 1) % BUCKETS] + weight[(k + 1) % BUCKETS])
    if (best < 0 || score > bestScore || (score === bestScore && weight[k] > weight[best])) {
      bestScore = score
      best = k
    }
  }
  // Too little colour overall (greyscale art, tiny specks): no accent.
  if (best < 0 || colored / total < 0.004) return null
  const r = sumR[best] / weight[best]
  const g = sumG[best] / weight[best]
  const b = sumB[best] / weight[best]
  const [h, s, l] = rgbToHsl(r, g, b)
  // Normalise for UI use on a dark background: vivid and readable.
  const [nr, ng, nb] = hslToRgb(h, Math.max(0.55, Math.min(1, s)), Math.max(0.52, Math.min(0.68, l)))
  return `#${hex(nr)}${hex(ng)}${hex(nb)}`
}
