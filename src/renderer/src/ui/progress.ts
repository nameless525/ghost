// How a progress bar moves for a Progress (shared/types.ts): measured steps glide to their value,
// estimated ones ease toward the end of their step over about `expectMs` (never reaching it until
// the step ends), unknown ones sweep. Bars never move backwards within one wait.
//
// The motion runs as a Web Animation on `transform` (or an SVG ring's stroke-dashoffset), so a
// bar costs no JavaScript per frame: we only plan a new animation when the progress changes.
import type { Progress } from '@shared/types'

export type ProgressInput = Progress | number | null | undefined

/** Estimates stop short of their step's end: the last stretch is only ever covered by the step finishing. */
export const ESTIMATE_CEIL = 0.9
/** How fast an estimate approaches its ceiling: at `expectMs` it shows 1 - e^-RATE of it (~75 %). */
const RATE = 1.4
/** Glide to a newly measured value. */
const GLIDE_MS = 320
const GLIDE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

export type ProgressMode = 'measured' | 'estimated' | 'indeterminate'

export function progressMode(p: ProgressInput): ProgressMode {
  if (typeof p === 'number') return Number.isFinite(p) ? 'measured' : 'indeterminate'
  if (!p) return 'indeterminate'
  if (p.fraction != null && Number.isFinite(p.fraction)) return 'measured'
  return p.expectMs != null && p.expectMs > 0 ? 'estimated' : 'indeterminate'
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Share of an estimated step shown `elapsedMs` into it. */
export function estimateAt(elapsedMs: number, expectMs: number): number {
  if (!(expectMs > 0)) return 0
  return ESTIMATE_CEIL * (1 - Math.exp((-RATE * Math.max(0, elapsedMs)) / expectMs))
}

/** The bar value (0..1 of the whole wait) for `p` at `now` (epoch ms), or null when indeterminate. */
export function progressValue(p: ProgressInput, now = Date.now()): number | null {
  const mode = progressMode(p)
  if (mode === 'indeterminate') return null
  if (typeof p === 'number') return clamp01(p)
  const prog = p as Progress
  const [a, b] = prog.span ?? [0, 1]
  const step = mode === 'measured' ? clamp01(prog.fraction!) : estimateAt(now - prog.since, prog.expectMs!)
  return clamp01(a + (b - a) * step)
}

/** A whole-number percentage for captions, only when the progress is measured. */
export function progressPercent(p: ProgressInput): number | null {
  if (progressMode(p) !== 'measured') return null
  const v = progressValue(p)
  return v == null ? null : Math.floor(v * 100)
}

export interface ProgressKeyframe {
  value: number
  offset: number
}

/**
 * Where the bar goes next: keyframes (0..1 values) and a duration. An estimated step follows its
 * exponential approach as a few linear segments (indistinguishable from the curve, and still a
 * compositor animation); a measured one glides to its value.
 */
export function progressPlan(p: ProgressInput, from: number, now = Date.now()): { frames: ProgressKeyframe[]; durationMs: number; easing: string } | null {
  const mode = progressMode(p)
  if (mode === 'indeterminate') return null
  if (mode === 'measured') {
    const to = Math.max(from, progressValue(p, now)!)
    return { frames: [{ value: from, offset: 0 }, { value: to, offset: 1 }], durationMs: GLIDE_MS, easing: GLIDE_EASE }
  }
  const prog = p as Progress
  const [a, b] = prog.span ?? [0, 1]
  const expect = prog.expectMs!
  const t0 = Math.max(0, now - prog.since)
  // Out to 4× the expected time (98 % of the way to the ceiling), then the bar holds.
  const horizon = Math.max(t0 + 200, 4 * expect)
  const n = 8
  const frames: ProgressKeyframe[] = []
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((horizon - t0) * i) / n
    // Never below where the bar already is (an earlier, faster estimate or a measured step).
    frames.push({ value: Math.max(from, clamp01(a + (b - a) * estimateAt(t, expect))), offset: i / n })
  }
  return { frames, durationMs: horizon - t0, easing: 'linear' }
}

/** Something a progress animation drives: a bar fill (scaleX) or an SVG ring arc (dash offset). */
export type ProgressTarget = { el: HTMLElement | SVGElement; kind: 'scaleX' } | { el: SVGElement; kind: 'dash'; circumference: number }

function keyframe(t: ProgressTarget, v: number): Keyframe {
  return t.kind === 'scaleX' ? { transform: `scaleX(${v})` } : { strokeDashoffset: `${t.circumference * (1 - v)}` }
}

/**
 * Drives one bar. `set` re-plans from wherever the bar is now; `reset` starts a new wait at 0;
 * `finish` fills it (the wait is over).
 */
export class ProgressAnimator {
  private anim: Animation | null = null
  private shown = 0

  constructor(private readonly target: ProgressTarget) {}

  /** The value on screen right now (read back from the running animation). */
  current(): number {
    if (!this.anim) return this.shown
    const cs = getComputedStyle(this.target.el)
    if (this.target.kind === 'scaleX') {
      // matrix(a, b, c, d, e, f): a is the x scale
      const m = /matrix\(([^,]+),/.exec(cs.transform)
      return m ? Number(m[1]) : this.shown
    }
    const c = this.target.circumference
    const off = parseFloat(cs.strokeDashoffset)
    return c > 0 && Number.isFinite(off) ? 1 - off / c : this.shown
  }

  private play(frames: ProgressKeyframe[], durationMs: number, easing: string): void {
    const prev = this.anim
    const last = frames[frames.length - 1].value
    this.shown = last
    this.anim = this.target.el.animate(
      frames.map((f) => ({ ...keyframe(this.target, f.value), offset: f.offset })),
      { duration: Math.max(1, durationMs), easing, fill: 'forwards' }
    )
    // Cancel the old one only after the new one holds the property (no one-frame flash to the base style).
    prev?.cancel()
  }

  set(p: ProgressInput): void {
    const from = this.current()
    const plan = progressPlan(p, from)
    if (!plan) return
    this.play(plan.frames, plan.durationMs, plan.easing)
  }

  /** Jump to `v` without animating (a new wait, or a bar that just mounted mid-wait). */
  jump(v: number): void {
    const x = Math.max(0, Math.min(1, v))
    this.play(
      [
        { value: x, offset: 0 },
        { value: x, offset: 1 }
      ],
      1,
      'linear'
    )
  }

  reset(): void {
    this.jump(0)
  }

  finish(): void {
    const from = this.current()
    this.play(
      [
        { value: from, offset: 0 },
        { value: 1, offset: 1 }
      ],
      220,
      GLIDE_EASE
    )
  }

  dispose(): void {
    this.anim?.cancel()
    this.anim = null
  }
}
