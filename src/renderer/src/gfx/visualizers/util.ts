// Small per-frame helpers (allocation-free).
import { oklabToRgb, rgbToOklab, type RGB } from '../../theme/color'

/**
 * Packed particle colour (what Particle.tint/alpha compute internally), without going through
 * Color parsing on every write: ABGR, alpha in the top byte.
 */
export function pcolor(rgb: number, alpha: number): number {
  const a = alpha <= 0 ? 0 : alpha >= 1 ? 255 : (alpha * 255) | 0
  const bgr = ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)
  return bgr + (a << 24)
}

const tmpRgb: RGB = [0, 0, 0]
const tmpIn: RGB = [0, 0, 0]

/**
 * Push a colour's chroma (OKLab a/b) by `amount` (1 = unchanged) and lightness by `dl`.
 * Used for the kiai "saturation up".
 */
export function vivid(rgb: number, amount: number, dl = 0): number {
  tmpIn[0] = (rgb >> 16) & 255
  tmpIn[1] = (rgb >> 8) & 255
  tmpIn[2] = rgb & 255
  const lab = rgbToOklab(tmpIn)
  lab[0] = Math.min(0.96, Math.max(0, lab[0] + dl))
  lab[1] *= amount
  lab[2] *= amount
  oklabToRgb(lab, tmpRgb)
  const c = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
  return (c(tmpRgb[0]) << 16) | (c(tmpRgb[1]) << 8) | c(tmpRgb[2])
}
