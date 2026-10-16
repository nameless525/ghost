import { describe, expect, it } from 'vitest'
import type { GroupBy, SortBy } from '../../shared/types'
import { QueryEngine } from './query'
import { CatalogRepo } from './repo'
import { hit, memoryDb, P } from './testing'

describe('group albums, paged', () => {
  const db = memoryDb()
  const repo = new CatalogRepo(db)
  const qe = new QueryEngine(repo, () => 'lossless')
  // a platform bucket of 1,234 albums (and one album elsewhere)
  const hits = Array.from({ length: 1234 }, (_, i) => hit(`snes-${i}`, `Super Game ${String(i).padStart(4, '0')} OST`, 'ost', 1990 + (i % 8), [P.snes]))
  repo.assignGames(repo.upsertHits([...hits, hit('ps1-0', 'Other Game OST', 'ost', 1997, [P.ps1])], { initial: true }))
  const q = (text = '', sort: SortBy = 'title', group: GroupBy = 'platform') => ({ text, group, sort })
  const SNES = 'platform:nintendo-snes'

  it('reaches every member of a bucket of more than 1,000 albums, in order, with its total', () => {
    expect(qe.browse({ ...q(), offset: 0, limit: 10 }).groups.find((g) => g.key === SNES)!.albumCount).toBe(1234)
    const ids: string[] = []
    for (let offset = 0; ; ) {
      const page = qe.groupAlbumPage(SNES, q(), offset, 500)
      expect(page).toMatchObject({ total: 1234, offset })
      ids.push(...page.albums.map((a) => a.id))
      offset += page.albums.length
      if (page.albums.length < 500) break
    }
    expect(ids).toHaveLength(1234)
    expect(new Set(ids).size).toBe(1234)
    expect(qe.groupAlbumPage(SNES, q(), 1233, 500).albums.map((a) => a.title)).toEqual(['Super Game 1233 OST'])
    // the same order as one long list
    expect(ids).toEqual(qe.groupAlbumPage(SNES, q(), 0, 5000).albums.map((a) => a.id))
  })

  it('totals follow the query, and a page past the end still says how many there are', () => {
    expect(qe.groupAlbumPage(SNES, q('year=1990'), 0, 50)).toMatchObject({ total: 155, offset: 0 })
    expect(qe.groupAlbumPage(SNES, q('year=1990'), 150, 50).albums).toHaveLength(5)
    expect(qe.groupAlbumPage(SNES, q(), 5000, 50)).toMatchObject({ total: 1234, albums: [] })
    expect(qe.groupAlbumPage('platform:playstation', q(), 0, 50)).toMatchObject({ total: 1, offset: 0 })
  })

  it('pages are bounded, and the unpaged call keeps its first 1,000', () => {
    expect(qe.groupAlbumPage(SNES, q(), -5, 0)).toMatchObject({ offset: 0, total: 1234, albums: [expect.anything()] })
    expect(qe.groupAlbumPage(SNES, q(), 0, 1e9).albums).toHaveLength(1234)
    expect(qe.groupAlbums(SNES, q())).toHaveLength(1000)
  })
})
