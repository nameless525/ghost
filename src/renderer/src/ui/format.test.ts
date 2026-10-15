import { describe, expect, it } from 'vitest'
import { formatSum, formatTime, sumKnown } from './format'

describe('sumKnown / formatSum', () => {
  it('unknown stays unknown, never 0', () => {
    expect(sumKnown([null, undefined])).toBeNull()
    expect(formatSum(sumKnown([null, null]))).toBe('–')
  })
  it('a true zero is shown', () => {
    expect(formatSum(sumKnown([0, 0]))).toBe('0')
  })
  it('partly known totals are marked', () => {
    expect(sumKnown([60000, null, 30000])).toEqual({ total: 90000, partial: true })
    expect(formatSum(sumKnown([60000, null]), formatTime)).toBe('1:00+')
    expect(formatSum(sumKnown([60000, 1000]), formatTime)).toBe('1:01')
  })
})
