import { describe, expect, it } from 'vitest'
import type { Progress } from '@shared/types'
import { ESTIMATE_CEIL, estimateAt, progressMode, progressPercent, progressPlan, progressValue } from './progress'

const step = (over: Partial<Progress> = {}): Progress => ({ label: 'x', fraction: null, expectMs: null, since: 1000, ...over })

describe('progress math', () => {
  it('classifies measured, estimated and unknown steps', () => {
    expect(progressMode(0.5)).toBe('measured')
    expect(progressMode(null)).toBe('indeterminate')
    expect(progressMode(step({ fraction: 0.2 }))).toBe('measured')
    expect(progressMode(step({ expectMs: 3000 }))).toBe('estimated')
    expect(progressMode(step())).toBe('indeterminate')
    expect(progressMode(step({ expectMs: 0 }))).toBe('indeterminate')
  })

  it('estimates approach the ceiling and never reach it', () => {
    expect(estimateAt(0, 1000)).toBe(0)
    expect(estimateAt(1000, 1000)).toBeGreaterThan(0.6)
    expect(estimateAt(1000, 1000)).toBeLessThan(0.75)
    expect(estimateAt(60_000, 1000)).toBeLessThanOrEqual(ESTIMATE_CEIL)
    expect(estimateAt(500, 1000)).toBeLessThan(estimateAt(900, 1000))
  })

  it('maps a step into its span', () => {
    expect(progressValue(step({ fraction: 0.5, span: [0.6, 1] }))).toBeCloseTo(0.8)
    expect(progressValue(step({ fraction: 2 }))).toBe(1)
    expect(progressValue(step({ expectMs: 1000, since: 0, span: [0, 0.5] }), 1000)).toBeCloseTo(0.5 * estimateAt(1000, 1000))
    expect(progressValue(step())).toBeNull()
  })

  it('shows a percentage only for measured progress', () => {
    expect(progressPercent(step({ fraction: 0.456 }))).toBe(45)
    expect(progressPercent(step({ expectMs: 1000 }))).toBeNull()
  })

  it('plans never move backwards', () => {
    const glide = progressPlan(step({ fraction: 0.3 }), 0.5)!
    expect(glide.frames.map((f) => f.value)).toEqual([0.5, 0.5])
    const est = progressPlan(step({ expectMs: 1000, since: 0 }), 0.4, 100)!
    const values = est.frames.map((f) => f.value)
    expect(values[0]).toBeGreaterThanOrEqual(0.4)
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1])
    expect(values[values.length - 1]).toBeLessThanOrEqual(ESTIMATE_CEIL)
    expect(est.frames[0].offset).toBe(0)
    expect(est.frames[est.frames.length - 1].offset).toBe(1)
    expect(progressPlan(step(), 0.2)).toBeNull()
  })

  it('an estimate picks up where its step already is', () => {
    const p = step({ expectMs: 1000, since: 0, span: [0, 1] })
    const plan = progressPlan(p, 0, 2000)!
    expect(plan.frames[0].value).toBeCloseTo(estimateAt(2000, 1000))
    expect(plan.durationMs).toBe(4000 - 2000)
  })
})
