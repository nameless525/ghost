import { describe, expect, it } from 'vitest'
import { PendingMask } from './pending-mask'

describe('PendingMask', () => {
  it('shows a click until main answers it, even when main kept the mask it had', () => {
    const p = new PendingMask()
    const ticket = p.send(0b100n)
    expect(p.mask).toBe(0b100n)
    // main clamped it to what it already had: no state change comes, the answer alone settles it
    expect(p.answered(ticket)).toBe(true)
    expect(p.mask).toBeNull()
  })

  it('keeps the latest click shown while older answers come in', () => {
    const p = new PendingMask()
    const first = p.send(0b1n)
    const second = p.send(0b11n)
    expect(p.answered(first)).toBe(false)
    expect(p.mask).toBe(0b11n)
    expect(p.answered(second)).toBe(true)
    expect(p.mask).toBeNull()
  })

  it('a new track drops the click, and its late answer changes nothing', () => {
    const p = new PendingMask()
    const ticket = p.send(2n ** 40n)
    expect(p.reset()).toBe(true)
    expect(p.mask).toBeNull()
    expect(p.answered(ticket)).toBe(false)
    expect(p.reset()).toBe(false)
  })
})
