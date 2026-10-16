import { describe, expect, it } from 'vitest'
import { extractAccent } from './accent'

/** RGBA pixels of the given colours, one per pixel. */
const rgba = (colours: [number, number, number][]) => {
  const px = new Uint8Array(colours.length * 4)
  colours.forEach(([r, g, b], i) => px.set([r, g, b, 255], i * 4))
  return px
}

const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return h * 60
}

/** Fully saturated, mid-light colour of hue `h` degrees. */
const vivid = (h: number): [number, number, number] => {
  const x = 1 - Math.abs(((h / 60) % 2) - 1)
  const sector = Math.floor(h / 60) % 6
  const rgb = [
    [1, x, 0],
    [x, 1, 0],
    [0, 1, x],
    [0, x, 1],
    [x, 0, 1],
    [1, 0, x]
  ][sector]
  return rgb.map((c) => Math.round(c * 255)) as [number, number, number]
}

const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

describe('extractAccent hue buckets', () => {
  it('never takes the colour of an empty bucket that ties its populated neighbours', () => {
    // Orange-red over pink-red: equal weight either side of 0°, nothing in the bucket at 0°.
    const px = rgba(Array.from({ length: 48 * 48 }, (_, i) => (i < 48 * 24 ? [255, 64, 0] : [255, 0, 32])))
    const a = extractAccent(px, 'rgba')
    expect(a).toMatch(/^#[0-9a-f]{6}$/)
    expect(hue(a!) < 20 || hue(a!) > 340).toBe(true)
    // Same as the native port (ghost-art `accent.rs`) on these pixels.
    expect(a).toBe('#ff480a')
  })

  it('picks a populated neighbour for every empty bucket (15° each), across the wrap', () => {
    for (let k = 0; k < 24; k++) {
      const lo = (k + 23) % 24
      const hi = (k + 1) % 24
      const [cLo, cHi] = [lo * 15 + 7.5, hi * 15 + 7.5]
      const a = extractAccent(rgba(Array.from({ length: 100 }, (_, i) => vivid(i % 2 ? cHi : cLo))), 'rgba')
      expect(a, `bucket ${k}`).toMatch(/^#[0-9a-f]{6}$/)
      expect(Math.min(dist(hue(a!), cLo), dist(hue(a!), cHi)), `bucket ${k}`).toBeLessThan(7.5)
    }
  })
})
