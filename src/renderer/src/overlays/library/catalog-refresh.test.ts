import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_REFRESH_INDEXING_MS, CATALOG_REFRESH_MS, CatalogRefresh } from './catalog-refresh'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** A view like useLive's: reloading calls loading(); `shown` is whether it's on screen. */
function view(shown = true) {
  const v = { shown, reloads: 0, stale: false, refresh: null as unknown as CatalogRefresh }
  v.refresh = new CatalogRefresh(
    () => {
      v.reloads++
      v.stale = false
      v.refresh.loading()
    },
    () => v.shown,
    () => {
      v.stale = true
    }
  )
  v.refresh.loading() // the first load
  return v
}

describe('CatalogRefresh', () => {
  it('reloads a shown smart playlist when the catalog moves past what it loaded', () => {
    const v = view()
    v.refresh.status(4, false) // the first report: the load may predate it
    expect(v.reloads).toBe(1)
    v.refresh.status(4, false) // a progress report, same data
    vi.advanceTimersByTime(CATALOG_REFRESH_MS)
    expect(v.reloads).toBe(1)
    v.refresh.status(5, false) // an import added matching tracks
    expect(v.reloads).toBe(2)
    v.refresh.status(undefined, false) // an older main: nothing to go on
    vi.advanceTimersByTime(CATALOG_REFRESH_MS * 3)
    expect(v.reloads).toBe(2)
  })

  it('throttles: a burst while indexing reloads once now and once when the interval is up', () => {
    const v = view()
    for (let r = 1; r <= 8; r++) v.refresh.status(r, true)
    expect(v.reloads).toBe(1)
    vi.advanceTimersByTime(CATALOG_REFRESH_INDEXING_MS - 1)
    expect(v.reloads).toBe(1)
    vi.advanceTimersByTime(1)
    expect(v.reloads).toBe(2)
    // quiet again: nothing more
    vi.advanceTimersByTime(CATALOG_REFRESH_INDEXING_MS * 4)
    expect(v.reloads).toBe(2)
  })

  it('a hidden view only goes stale (it reloads when shown again)', () => {
    const v = view(false)
    v.refresh.status(7, false)
    expect(v.reloads).toBe(0)
    expect(v.stale).toBe(true)
    // shown again: useLive reloads a stale view, which covers revision 7
    v.shown = true
    v.refresh.loading()
    v.refresh.status(7, false)
    expect(v.reloads).toBe(0)
    // hidden while a throttled reload waits: stale instead
    v.refresh.status(8, false)
    expect(v.reloads).toBe(1)
    v.refresh.status(9, false)
    v.shown = false
    vi.advanceTimersByTime(CATALOG_REFRESH_MS)
    expect(v.reloads).toBe(1)
    expect(v.stale).toBe(true)
  })

  it('a load for another reason meanwhile (a like, a rename) covers what it saw', () => {
    const v = view()
    v.refresh.status(1, false)
    v.refresh.status(2, false)
    v.refresh.loading()
    vi.advanceTimersByTime(CATALOG_REFRESH_MS)
    expect(v.reloads).toBe(1)
    // closed while a reload waits: it never comes
    v.refresh.status(3, false)
    v.refresh.status(4, false)
    v.refresh.dispose()
    vi.advanceTimersByTime(CATALOG_REFRESH_MS)
    expect(v.reloads).toBe(2)
  })
})
