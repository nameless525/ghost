import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisFrame } from '@shared/types'
import { idleSeconds } from '../../gfx/visualizers/util'
import { RingVisualiser } from './RingVisualiser'

/** A 2D context that records what one frame draws: the bar outlines and their fill. */
function fakeCanvas() {
  const frame = { points: [] as number[], fill: '' }
  const ctx = {
    setTransform() {},
    clearRect() {
      frame.points = []
    },
    beginPath() {},
    moveTo(x: number, y: number) {
      frame.points.push(x, y)
    },
    lineTo(x: number, y: number) {
      frame.points.push(x, y)
    },
    fill() {},
    set fillStyle(v: string) {
      frame.fill = v
    },
    globalCompositeOperation: 'source-over'
  }
  const canvas = { getContext: () => ctx, style: {}, width: 0, height: 0 }
  return { canvas: canvas as unknown as HTMLCanvasElement, frame }
}

const RGB = [255, 200, 230]
const music = { bands: new Float32Array(96).fill(0.5), waveform: new Float32Array(512), rms: 0.4, peak: 0.6, onset: 0.2, positionMs: 0, trackSeq: 1 } as AnalysisFrame

/** How far apart two outlines are (px): the most any point moved. */
const moved = (a: number[], b: number[]) => (a.length === b.length ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : Infinity)

/** Draw frames at 60 fps from `from` for `ms`; returns the outline of the last one. */
function play(ring: RingVisualiser, out: { points: number[] }, from: number, ms: number, o: { f?: AnalysisFrame | null; kiai?: number; pulse?: number; playing?: boolean; reduce: boolean }) {
  for (let now = from; now <= from + ms; now += 16) ring.draw(16, now, o.f ?? null, 100, RGB, o.kiai ?? 0, o.pulse ?? 0, o.playing ?? false, 0, o.reduce)
  return [...out.points]
}

describe('Title ring under Reduce motion', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { devicePixelRatio: 1 })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('holds still while idle: no rotation, no shimmer', () => {
    const { canvas, frame } = fakeCanvas()
    const ring = new RingVisualiser(canvas)
    ring.resize(400)
    // (the shimmer's fade-in when the music stops is still settling: well under a pixel)
    const a = play(ring, frame, 0, 3000, { reduce: true })
    const b = play(ring, frame, 3016, 4000, { reduce: true })
    expect(a.length).toBeGreaterThan(0)
    expect(moved(a, b)).toBeLessThan(0.05)
  })

  it('moves while idle without it', () => {
    const { canvas, frame } = fakeCanvas()
    const ring = new RingVisualiser(canvas)
    ring.resize(400)
    const a = play(ring, frame, 0, 3000, { reduce: false })
    const b = play(ring, frame, 3016, 4000, { reduce: false })
    expect(moved(a, b)).toBeGreaterThan(1)
  })

  it('playing: bars follow the music, but without spin or beat and kiai boosts', () => {
    const { canvas, frame } = fakeCanvas()
    const ring = new RingVisualiser(canvas)
    ring.resize(400)
    const calm = play(ring, frame, 0, 2000, { f: music, playing: true, reduce: true })
    const calmFill = frame.fill
    const loud = play(ring, frame, 2016, 2000, { f: music, playing: true, kiai: 1, pulse: 1.4, reduce: true })
    expect(moved(calm, loud)).toBeLessThan(0.05)
    expect(frame.fill).toBe(calmFill)
    // the same beat and kiai do boost it with motion allowed
    play(ring, frame, 4032, 100, { f: music, playing: true, kiai: 1, pulse: 1.4, reduce: false })
    expect(frame.fill).not.toBe(calmFill)
  })
})

describe('idleSeconds', () => {
  it('stops the idle clock of the Play visualizers under Reduce motion', () => {
    expect(idleSeconds({ now: 12_345, reduce: false })).toBeCloseTo(12.345)
    expect(idleSeconds({ now: 12_345, reduce: true })).toBe(0)
    expect(idleSeconds({ now: 99_999, reduce: true })).toBe(0)
  })
})
