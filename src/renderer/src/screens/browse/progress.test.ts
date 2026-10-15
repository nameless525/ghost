import { afterEach, describe, expect, it } from 'vitest'
import type { ExternalProviderId, Progress } from '@shared/types'
import { ESTIMATE_CEIL, progressValue } from '../../ui/progress'
import { albumFallback, ALBUM_EXPECT_MS, importExpectMs, nestSpan, recordSearchMs, resetSearchTimes, SEARCH_EXPECT_MS, searchCaption, searchExpectMs, searchSegments, searchValue } from './progress'

const NAMES: Record<ExternalProviderId, string> = { youtube: 'YouTube', soundcloud: 'SoundCloud', archive: 'Internet Archive', bandcamp: 'Bandcamp' }
const name = (id: ExternalProviderId) => NAMES[id]
const ALL: ExternalProviderId[] = ['youtube', 'soundcloud', 'archive', 'bandcamp']

afterEach(() => resetSearchTimes())

describe('nestSpan', () => {
  const step = (over: Partial<Progress> = {}): Progress => ({ label: 'x', fraction: null, expectMs: null, since: 0, ...over })

  it('places a whole step inside the outer span', () => {
    expect(nestSpan(step(), [0.3, 1]).span).toEqual([0.3, 1])
  })

  it('nests a step that already has its own span', () => {
    const [a, b] = nestSpan(step({ span: [0.65, 1] }), [0.3, 1]).span!
    expect(a).toBeCloseTo(0.3 + 0.7 * 0.65)
    expect(b).toBeCloseTo(1)
  })

  it('keeps the bar value inside the outer span', () => {
    const p = nestSpan(step({ fraction: 0.5 }), [0, 0.3])
    expect(progressValue(p)).toBeCloseTo(0.15)
    expect(progressValue(nestSpan(step({ fraction: 1, span: [0, 0.65] }), [0.3, 1]))).toBeCloseTo(0.3 + 0.7 * 0.65)
  })

  it('keeps the other fields (trackId, wait)', () => {
    const p = nestSpan({ ...step({ wait: 't1#0' }), trackId: 't1' }, [0.3, 1])
    expect(p.trackId).toBe('t1')
    expect(p.wait).toBe('t1#0')
  })
})

describe('album fallback', () => {
  it('estimates from when the fetch started', () => {
    const p = albumFallback(1000)
    expect(p.expectMs).toBe(ALBUM_EXPECT_MS)
    expect(progressValue(p, 1000)).toBe(0)
    expect(progressValue(p, 1000 + ALBUM_EXPECT_MS)!).toBeGreaterThan(0.5)
    expect(progressValue(p, 1000 + 60_000)!).toBeLessThanOrEqual(ESTIMATE_CEIL)
  })
})

describe('external search bar', () => {
  it('has one pending segment per source, estimated on its usual answer time', () => {
    const segs = searchSegments(ALL, {}, 5000)
    expect(segs.map((s) => s.id)).toEqual(ALL)
    expect(segs.every((s) => s.state === 'pending')).toBe(true)
    expect(segs.find((s) => s.id === 'youtube')!.progress.expectMs).toBe(SEARCH_EXPECT_MS.youtube)
    expect(segs.find((s) => s.id === 'archive')!.progress.expectMs).toBe(SEARCH_EXPECT_MS.archive)
    // the fast sources are expected well before the yt-dlp ones
    expect(SEARCH_EXPECT_MS.archive).toBeLessThan(SEARCH_EXPECT_MS.youtube / 4)
  })

  it('fills a source’s share when it answers, failed or not (k of N)', () => {
    const segs = searchSegments(ALL, { archive: 'done', bandcamp: 'failed' }, 0)
    expect(segs.find((s) => s.id === 'archive')!.state).toBe('done')
    expect(segs.find((s) => s.id === 'bandcamp')!.state).toBe('failed')
    // two of four answered: at least half, and the slow pair adds its estimate on top
    expect(searchValue(segs, 0)).toBeCloseTo(0.5)
    const later = searchValue(segs, 8000)
    expect(later).toBeGreaterThan(0.5)
    expect(later).toBeLessThan(0.5 + 0.5 * ESTIMATE_CEIL)
    expect(searchValue(searchSegments(ALL, { youtube: 'done', soundcloud: 'done', archive: 'done', bandcamp: 'done' }, 0))).toBe(1)
  })

  it('never reaches the end before every source answered', () => {
    const segs = searchSegments(ALL, { youtube: 'done', soundcloud: 'done', archive: 'done' }, 0)
    expect(searchValue(segs, 1e9)).toBeLessThan(1)
  })

  it('says who it still waits on and how many answered', () => {
    expect(searchCaption(ALL, {}, name)).toEqual({ label: 'Searching YouTube, SoundCloud, Internet Archive, Bandcamp…', detail: '0 of 4 sources' })
    expect(searchCaption(ALL, { archive: 'done', bandcamp: 'done' }, name)).toEqual({ label: 'Searching YouTube, SoundCloud…', detail: '2 of 4 sources' })
    expect(searchCaption(['youtube'], {}, name).detail).toBe('0 of 1 source')
  })

  it('sums up when finished, naming sources that failed', () => {
    expect(searchCaption(ALL, { youtube: 'done', soundcloud: 'done', archive: 'done', bandcamp: 'done' }, name)).toEqual({ label: 'Searched 4 sources', detail: null })
    expect(searchCaption(ALL, { youtube: 'done', soundcloud: 'failed', archive: 'done', bandcamp: 'done' }, name).detail).toBe('SoundCloud didn’t answer')
    expect(searchCaption(['archive'], { archive: 'done' }, name).label).toBe('Searched Internet Archive')
  })

  it('learns how long a source takes', () => {
    expect(searchExpectMs('youtube')).toBe(SEARCH_EXPECT_MS.youtube)
    for (let i = 0; i < 12; i++) recordSearchMs('youtube', 3000)
    expect(searchExpectMs('youtube')).toBeLessThan(3200)
    expect(searchExpectMs('soundcloud')).toBe(SEARCH_EXPECT_MS.soundcloud)
    recordSearchMs('archive', -5)
    recordSearchMs('archive', Number.NaN)
    expect(searchExpectMs('archive')).toBe(SEARCH_EXPECT_MS.archive)
  })
})

describe('import estimate', () => {
  it('scales SoundCloud sets with their track count', () => {
    expect(importExpectMs({ provider: 'soundcloud', trackCount: 20 })).toBe(20_000)
    expect(importExpectMs({ provider: 'soundcloud', trackCount: 1 })).toBe(1500)
    expect(importExpectMs({ provider: 'soundcloud', trackCount: null })).toBe(8000)
  })

  it('uses fixed estimates for the others', () => {
    expect(importExpectMs({ provider: 'youtube', trackCount: 40 })).toBe(4000)
    expect(importExpectMs({ provider: 'archive', trackCount: 12 })).toBe(1500)
    expect(importExpectMs({ provider: 'bandcamp', trackCount: null })).toBe(1500)
  })
})
