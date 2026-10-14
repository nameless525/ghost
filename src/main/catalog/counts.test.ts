// Trigger-maintained catalog counts and the seeded 'random' order.
import { describe, expect, it } from 'vitest'
import type { BrowseQuery } from '../../shared/types'
import { QueryEngine, reseedRandom } from './query'
import { CatalogRepo } from './repo'
import { COUNTS_TRIGGERS_DDL, ensureCatalogSchema } from './schema'
import { detail, hit, memoryDb, P, seedSmall } from './testing'
import { franchiseGuess } from './normalize'

function exact(repo: CatalogRepo) {
  const r = repo.get<{ g: number; a: number; t: number }>(
    `SELECT (SELECT COUNT(*) FROM games) AS g, (SELECT COUNT(*) FROM albums WHERE gone = 0) AS a, (SELECT COUNT(*) FROM tracks WHERE removed = 0) AS t`
  )!
  return { games: r.g, albums: r.a, tracks: r.t }
}

describe('maintained counts', () => {
  it('track inserts, gone/removed flips, game deletes and re-clustering', async () => {
    const repo = new CatalogRepo(memoryDb())
    expect(repo.counts()).toEqual({ games: 0, albums: 0, tracks: 0 })
    const { albums } = seedSmall(repo)
    expect(repo.counts()).toEqual(exact(repo))
    expect(repo.counts().tracks).toBe(9)
    // An album page that drops a track.
    const h = hit('hollow-knight-ost', 'Hollow Knight', 'ost', 2017, [P.win, P.switch])
    repo.applyAlbumDetail(albums['hollow-knight-ost'], detail(h, [{ title: 'Dirtmouth', ms: 140_000 }]))
    expect(repo.counts()).toEqual(exact(repo))
    // Gone album (its game disappears), then back.
    repo.markAlbumError(albums['ys-ost'], 'gone', true)
    expect(repo.counts()).toEqual(exact(repo))
    repo.upsertHits([hit('ys-ost', 'Ys OST', 'ost', 1987, [])], { initial: false })
    repo.assignGames([albums['ys-ost']])
    expect(repo.counts()).toEqual(exact(repo))
    await repo.reclusterAll(async () => {})
    expect(repo.counts()).toEqual(exact(repo))
    repo.db.exec(`DELETE FROM tracks WHERE album_id = ${albums['ff6-osv']}`)
    expect(repo.counts()).toEqual(exact(repo))
  })

  it('an existing catalog without the counters is counted once when the schema is ensured', () => {
    const db = memoryDb()
    const repo = new CatalogRepo(db)
    seedSmall(repo)
    // Simulate a database from before the counters existed.
    for (const m of COUNTS_TRIGGERS_DDL.matchAll(/TRIGGER IF NOT EXISTS (\w+)/g)) db.exec(`DROP TRIGGER ${m[1]}`)
    db.exec(`DROP TABLE catalog_counts`)
    db.exec(`UPDATE albums SET gone = 1 WHERE id = (SELECT MIN(id) FROM albums)`)
    ensureCatalogSchema(db)
    expect(repo.counts()).toEqual(exact(repo))
    // And the triggers are live again.
    db.exec(`UPDATE albums SET gone = 0`)
    expect(repo.counts()).toEqual(exact(repo))
  })
})

describe('random sort', () => {
  const repo = new CatalogRepo(memoryDb())
  const batch = Array.from({ length: 300 }, (_, i) => hit(`g${i}`, `Game ${i} Original Soundtrack`, 'ost', 1990 + (i % 30), [P.snes]))
  repo.assignGames(repo.upsertHits(batch, { initial: true }))
  const qe = new QueryEngine(repo, () => 'lossless')
  const q = (group: 'game' | 'album', offset: number, text = ''): BrowseQuery => ({ text, group, sort: 'random', offset, limit: 50 })
  const all = (group: 'game' | 'album', text = '') => {
    const keys: string[] = []
    for (let off = 0; ; off += 50) {
      const p = qe.browse(q(group, off, text))
      keys.push(...p.groups.map((g) => g.key))
      if (off + 50 >= p.total) break
    }
    return keys
  }

  it('pages through a stable permutation of everything, reshuffled per seed', () => {
    for (const group of ['game', 'album'] as const) {
      const a = all(group)
      expect(a.length).toBe(300)
      expect(new Set(a).size).toBe(300)
      expect(all(group)).toEqual(a)
      // Not just id order.
      const sorted = [...a].sort((x, y) => Number(x.split(':')[1]) - Number(y.split(':')[1]))
      expect(a).not.toEqual(sorted)
      reseedRandom()
      const b = all(group)
      expect(new Set(b)).toEqual(new Set(a))
      expect(b).not.toEqual(a)
    }
  })

  it('applies filters and keeps the same relative order', () => {
    const filtered = all('game', 'year=1995')
    expect(filtered.length).toBe(10)
    const everything = all('game')
    expect(filtered).toEqual(everything.filter((k) => filtered.includes(k)))
  })
})

describe('bucket aggregation in chunks', () => {
  it('merges to the same buckets as a single pass (counts, years, art, franchise game counts)', async () => {
    const repo = new CatalogRepo(memoryDb())
    seedSmall(repo)
    const extra = Array.from({ length: 120 }, (_, i) =>
      hit(`x${i}`, `${['Final Fantasy', 'Mega Man', 'Chrono'][i % 3]} ${i} Original Soundtrack`, i % 4 ? 'ost' : 'gamerip', i % 7 ? 1990 + (i % 25) : null, [[P.snes, P.ps1, P.win][i % 3]], i % 5 ? {} : { cover: null, thumb: null })
    )
    repo.assignGames(repo.upsertHits(extra, { initial: true }))
    await repo.refreshFranchises()
    expect(franchiseGuess('Final Fantasy 3')).toBeTruthy()
    const single = new QueryEngine(repo, () => 'lossless')
    const chunked = new QueryEngine(repo, () => 'lossless', { bucketChunk: 7 })
    for (const group of ['platform', 'year', 'composer', 'franchise'] as const) {
      for (const text of ['', 'fantasy']) {
        const q: BrowseQuery = { text, group, sort: 'title', offset: 0, limit: 500 }
        const a = single.browse(q)
        await chunked.warmBuckets(group, text, async () => {})
        const b = chunked.browse(q)
        expect(b).toEqual(a)
        expect(a.total).toBeGreaterThan(0)
      }
    }
  })

  it('serves a stale aggregation while it is recomputed in the background', async () => {
    const repo = new CatalogRepo(memoryDb())
    seedSmall(repo)
    let t = 0
    const qe = new QueryEngine(repo, () => 'lossless', { bucketStaleMs: 1000, now: () => t })
    const q: BrowseQuery = { text: '', group: 'year', sort: 'year', offset: 0, limit: 100 }
    const before = qe.browse(q).total
    repo.assignGames(repo.upsertHits([hit('new-1971', 'Brand New 1971 OST', 'ost', 1971, [])], { initial: false }))
    repo.revision++
    expect(qe.browse(q).total).toBe(before) // within the stale window
    t = 5000
    expect(qe.browse(q).total).toBe(before) // stale, refresh scheduled
    await new Promise((r) => setTimeout(r, 50))
    expect(qe.browse(q).total).toBe(before + 1)
  })
})
