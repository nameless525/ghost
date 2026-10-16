import { describe, expect, it } from 'vitest'
import { formatTime } from './format'
import { AriaValue } from './Slider'

function fakeEl() {
  const attrs = new Map<string, string>()
  let writes = 0
  const el = {
    setAttribute: (k: string, v: string) => {
      writes++
      attrs.set(k, v)
    },
    removeAttribute: (k: string) => void attrs.delete(k)
  }
  return { el: el as unknown as Element, attrs, writes: () => writes }
}

describe('AriaValue (a live seek bar)', () => {
  const MAX = 180_000

  it('names the current position once there is one', () => {
    const { el, attrs } = fakeEl()
    new AriaValue(() => el).write(83_000, 0, MAX, formatTime)
    expect(attrs.get('aria-valuenow')).toBe('83000')
    expect(attrs.get('aria-valuetext')).toBe(formatTime(83_000))
  })

  it('follows playback at a modest cadence, slower while focused', () => {
    const { el, attrs } = fakeEl()
    const a = new AriaValue(() => el)
    a.write(0, 0, MAX, formatTime, 0)
    /** Play `ms` more in 16 ms frames (the position is the time): when the value changed. */
    let t = 0
    const play = (ms: number, focused: boolean) => {
      const changes: number[] = []
      for (const end = t + ms; t < end; ) {
        t += 16
        const before = attrs.get('aria-valuenow')
        a.poll(t, 0, MAX, formatTime, t, focused)
        if (attrs.get('aria-valuenow') !== before) changes.push(t)
      }
      return changes
    }
    const unfocused = play(3000, false)
    expect(unfocused).toHaveLength(2)
    expect(Number(attrs.get('aria-valuenow'))).toBeGreaterThan(t - 1100)
    // focused, a screen reader speaks every change: far fewer of them
    const focused = play(10_000, true)
    expect(focused).toHaveLength(2)
    expect(focused[1] - focused[0]).toBeGreaterThanOrEqual(5000)
  })

  it('writes the user’s own change at once, and only what changed', () => {
    const { el, attrs, writes } = fakeEl()
    const a = new AriaValue(() => el)
    a.write(10_000, 0, MAX, formatTime, 100)
    const before = writes()
    a.poll(10_000, 0, MAX, formatTime, 5000, false)
    expect(writes()).toBe(before)
    // a keyboard seek right after a poll
    a.write(15_000, 0, MAX, formatTime, 5001)
    expect(attrs.get('aria-valuetext')).toBe(formatTime(15_000))
  })

  it('keeps the value inside the range, and plain numbers without a formatter', () => {
    const { el, attrs } = fakeEl()
    const a = new AriaValue(() => el)
    a.write(5, 0, 1, undefined)
    expect(attrs.get('aria-valuenow')).toBe('1')
    expect(attrs.has('aria-valuetext')).toBe(false)
    a.write(0.123456, 0, 1, (v) => `${Math.round(v * 100)}%`)
    expect(attrs.get('aria-valuenow')).toBe('0.123')
    expect(attrs.get('aria-valuetext')).toBe('12%')
  })
})
