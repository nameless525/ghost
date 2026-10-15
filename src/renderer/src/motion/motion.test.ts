import { beforeAll, describe, expect, it } from 'vitest'
import { easings } from './easing'
import { Spring } from './spring'

beforeAll(() => {
  const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown }
  g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 8) as unknown as number
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id)
})

const fakeEl = () => ({ style: {} as Record<string, string> }) as unknown as HTMLElement

describe('easings', () => {
  it('every easing maps 0 → 0 and 1 → 1', () => {
    for (const [name, fn] of Object.entries(easings)) {
      expect(fn(0), name).toBeCloseTo(0, 5)
      expect(fn(1), name).toBeCloseTo(1, 5)
    }
  })
  it('outQuint front-loads progress', () => {
    expect(easings.outQuint(0.5)).toBeCloseTo(1 - 0.5 ** 5, 6)
    expect(easings.outQuint(0.2)).toBeGreaterThan(0.6)
  })
  it('outBack overshoots', () => {
    const peak = Math.max(...Array.from({ length: 50 }, (_, i) => easings.outBack(i / 49)))
    expect(peak).toBeGreaterThan(1.05)
  })
})

describe('Spring', () => {
  it('critically damped settles on target without overshoot', () => {
    const s = new Spring({ value: 0, target: 100, frequency: 3, damping: 1 })
    let max = 0
    for (let i = 0; i < 200; i++) max = Math.max(max, s.step(1000 / 120))
    expect(s.value).toBeCloseTo(100, 2)
    expect(max).toBeLessThanOrEqual(100.0001)
    expect(s.atRest).toBe(true)
  })
  it('under-damped overshoots, and is stable with huge dt', () => {
    const s = new Spring({ value: 0, target: 1, frequency: 4, damping: 0.3 })
    let max = 0
    for (let i = 0; i < 400; i++) max = Math.max(max, s.step(16))
    expect(max).toBeGreaterThan(1.2)
    const t = new Spring({ value: 0, target: 1, frequency: 8, damping: 1 })
    t.step(5000)
    expect(Number.isFinite(t.value)).toBe(true)
  })
})

describe('tween', async () => {
  const { tween } = await import('./tween')

  it('set() applies synchronously', () => {
    const el = fakeEl()
    tween(el).set({ opacity: 0, x: 12 })
    expect(el.style.opacity).toBe('0')
    expect(el.style.transform).toBe('translate3d(12px, 0px, 0)')
  })

  it('parallel transforms reach their targets', async () => {
    const el = fakeEl()
    await tween(el).fadeTo(0.5, 40).moveTo(10, 20, 40).scaleTo(1.5, 40)
    expect(el.style.opacity).toBe('0.5')
    expect(el.style.transform).toBe('translate3d(10px, 20px, 0) scale(1.5, 1.5)')
  })

  it('.then() sequences', async () => {
    const el = fakeEl()
    const t0 = performance.now()
    const seen: number[] = []
    await tween(el)
      .moveToX(50, 40)
      .then(() => seen.push(performance.now() - t0))
      .then()
      .moveToX(0, 40)
    expect(seen[0]).toBeGreaterThanOrEqual(35)
    expect(performance.now() - t0).toBeGreaterThanOrEqual(75)
    expect(tween.get(el).x).toBe(0)
  })

  it('re-targeting mid-flight supersedes the running transform', async () => {
    const el = fakeEl()
    void tween(el).moveToX(100, 400)
    await new Promise((r) => setTimeout(r, 60))
    await tween(el).moveToX(-5, 40)
    expect(tween.get(el).x).toBe(-5)
  })

  it('clear() stops and resolves pending awaits', async () => {
    const el = fakeEl()
    const p = tween(el).fadeTo(0, 10_000).finished
    tween.clear(el)
    await expect(p).resolves.toBeUndefined()
  })
})

describe('ticker', async () => {
  const { ticker } = await import('./ticker')

  it('a subscriber added mid-frame neither repeats nor skips the others', async () => {
    const calls: string[] = []
    const offs: (() => void)[] = []
    let added = false
    await new Promise<void>((resolve) => {
      offs.push(
        ticker.add(() => {
          calls.push('a')
          if (!added) {
            added = true
            offs.push(ticker.add(() => calls.push('b'), -10)) // sorts before 'a'
          }
        }, 0)
      )
      offs.push(
        ticker.add(() => {
          calls.push('c')
          if (calls.filter((x) => x === 'c').length === 2) resolve()
        }, 5)
      )
    })
    offs.forEach((off) => off())
    // frame 1: a, c ('b' joins from the next frame); frame 2: b, a, c
    expect(calls).toEqual(['a', 'c', 'b', 'a', 'c'])
  })

  it('maxFps = 0 pauses the loop until raised', async () => {
    let n = 0
    const off = ticker.add(() => n++)
    await new Promise((r) => setTimeout(r, 40))
    ticker.maxFps = 0
    const paused = n
    await new Promise((r) => setTimeout(r, 60))
    expect(n).toBe(paused)
    ticker.maxFps = Infinity
    await new Promise((r) => setTimeout(r, 40))
    expect(n).toBeGreaterThan(paused)
    off()
  })
})
