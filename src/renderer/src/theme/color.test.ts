import { describe, expect, it } from 'vitest'
import { accentFamily, hexToRgb, mix, normalizeAccent, oklch, rgbToHex } from './color'

describe('color', () => {
  it('hex round-trips', () => {
    for (const h of ['#ff66aa', '#000000', '#ffffff', '#0f0d17', '#4fe0a0']) expect(rgbToHex(...hexToRgb(h))).toBe(h)
    expect(hexToRgb('#abc')).toEqual([0xaa, 0xbb, 0xcc])
  })
  it('normalizeAccent keeps hue but forces a legible lightness and real chroma', () => {
    const dark = normalizeAccent('#2a0010') // nearly black red
    const beige = normalizeAccent('#e8dcc0') // washed out
    expect(oklch(dark).l).toBeGreaterThanOrEqual(0.67)
    expect(Math.abs(oklch(dark).h - oklch('#2a0010').h)).toBeLessThan(0.15)
    expect(oklch(beige).c).toBeGreaterThanOrEqual(0.12)
    expect(normalizeAccent(null)).toBe('#ff66aa')
    expect(normalizeAccent('not a colour')).toBe('#ff66aa')
  })
  it('mix interpolates endpoints exactly', () => {
    expect(mix('#ff66aa', '#5aa8ff', 0)).toBe('#ff66aa')
    expect(mix('#ff66aa', '#5aa8ff', 1)).toBe('#5aa8ff')
  })
  it('accent ink is dark on light accents, white on saturated ones', () => {
    expect(accentFamily('#ffd23f').ink).toBe('#1a1024')
    expect(accentFamily('#7a2cff').ink).toBe('#ffffff')
  })
})
