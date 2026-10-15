import { afterAll, describe, expect, it, vi } from 'vitest'
import { perfActive, perfMark, perfStats, setPerfFocus, startMainPerf } from './perf'

describe('main perf diagnostics', () => {
  const log = process.env.GHOST_PERF_LOG
  delete process.env.GHOST_PERF_LOG
  afterAll(() => {
    setPerfFocus(false)
    if (log !== undefined) process.env.GHOST_PERF_LOG = log
  })

  it('records milestones relative to process start', () => {
    const ms = perfMark('test:mark')
    const s = perfStats()
    expect(s.marks.at(-1)).toEqual({ name: 'test:mark', ms })
    expect(s.timeOrigin).toBeGreaterThan(0)
  })

  it('stall detectors (timers that wake the process) only run with focus or right after stats were read', () => {
    startMainPerf()
    setPerfFocus(true)
    expect(perfActive()).toBe(true)
    setPerfFocus(false)
    // stats were just read in the previous test: measuring keeps them on for a while
    expect(perfActive()).toBe(true)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000)
      setPerfFocus(false)
      expect(perfActive()).toBe(false) // backgrounded and nobody measuring: no wakeups
      setPerfFocus(true)
      expect(perfActive()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
