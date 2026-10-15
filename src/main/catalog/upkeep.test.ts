// Index upkeep and lookups added in the performance pass: platform names, dropped indexes, FTS
// compaction, re-cluster orphans, game lookups without resident maps, chunked bucket aggregation.
import { describe, expect, it } from 'vitest'
import type { BrowseQuery, GroupBy } from '../../shared/types'
import { clusterKeys } from './normalize'
import { QueryEngine } from './query'
import { CatalogRepo } from './repo'
import { ensureCatalogSchema } from './schema'
import { hit, memoryDb, P, seedSmall } from './testing'

const q = (text: string, group: GroupBy = 'game'): BrowseQuery => ({ text, group, sort: 'title', offset: 0, limit: 50 })

describe('platform filters', () => {
  it('match platforms written after the engine first looked (platform_names follows album writes)', () => {
    const repo = new CatalogRepo(memoryDb())
    const qe = new QueryEngine(repo, () => 'lossless')
    seedSmall(repo)
    expect(qe.browse(q('platform=snes')).groups.map((g) => g.title)).toContain('Chrono Trigger')
    expect(qe.browse(q('platform=wonderswan')).total).toBe(0)
    const ids = repo.upsertHits([hit('gunpey', 'Gunpey Original Soundtrack', 'ost', 1999, [{ slug: 'wonderswan', name: 'WonderSwan' }])], { initial: false })
    repo.assignGames(ids)
    repo.revision++
    expect(qe.browse(q('platform=wonderswan')).groups.map((g) => g.title)).toEqual(['Gunpey'])
    expect(qe.browse(q('platform="wonderswan"', 'album')).total).toBe(1)
  })

  it('an existing catalog fills platform_names once, and unused indexes are dropped', () => {
    const db = memoryDb()
    const repo = new CatalogRepo(db)
    seedSmall(repo)
    db.exec(`DELETE FROM platform_names; CREATE INDEX games_rnd ON games(rnd); CREATE INDEX albums_rnd ON albums(rnd)`)
    ensureCatalogSchema(db)
    const names = repo.all<{ slug: string }>(`SELECT slug FROM platform_names ORDER BY slug`).map((r) => r.slug)
    expect(names).toEqual(repo.all<{ slug: string }>(`SELECT DISTINCT slug FROM album_platforms ORDER BY slug`).map((r) => r.slug))
    expect(repo.all(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('games_rnd', 'albums_rnd')`)).toEqual([])
    expect(new QueryEngine(repo, () => 'lossless').browse(q('platform=genesis')).groups.map((g) => g.title)).toEqual(['Sonic the Hedgehog'])
  })
})

describe('refresh crawls', () => {
  it('an unchanged listing row is only stamped; edited, revived and new ones are reported for clustering', () => {
    const repo = new CatalogRepo(memoryDb())
    const { albums } = seedSmall(repo)
    const h = (ref: string, title: string, extra = {}) => hit(ref, title, 'ost', 1995, [P.snes], extra)
    const before = repo.get<{ title: string; sort_title: string; cover: string | null }>(`SELECT title, sort_title, cover FROM albums WHERE id = ?`, albums['chrono-trigger-osv'])
    const unchanged = hit('chrono-cross-ost', 'Chrono Cross Original Soundtrack', 'ost', 1999, [P.ps1])
    const changed: number[] = []
    const ids = repo.upsertHits([h('chrono-trigger-osv', 'Chrono Trigger Original Sound Version'), unchanged], { initial: false }, changed)
    expect(ids).toEqual([albums['chrono-trigger-osv'], albums['chrono-cross-ost']])
    expect(changed).toEqual([]) // nothing moved (the first keeps its album-page title and cover)
    expect(repo.get(`SELECT title, sort_title, cover FROM albums WHERE id = ?`, albums['chrono-trigger-osv'])).toEqual(before)
    // An edited row, a revived (gone) one and a new one.
    repo.markAlbumError(albums['ys-ost'], 'gone', true)
    const edited = hit('chrono-cross-ost', 'Chrono Cross Original Soundtrack', 'ost', 1999, [P.ps1, P.win])
    const ids2 = repo.upsertHits([edited, hit('ys-ost', 'Ys OST', 'ost', 1987, []), h('new-one', 'New One OST')], { initial: false }, changed)
    expect(changed).toEqual(ids2)
    repo.assignGames(changed)
    expect(repo.get<{ gone: number; platforms: string }>(`SELECT gone, platforms FROM albums WHERE id = ?`, albums['ys-ost'])!.gone).toBe(0)
    expect(JSON.parse(repo.get<{ platforms: string }>(`SELECT platforms FROM albums WHERE id = ?`, albums['chrono-cross-ost'])!.platforms)).toEqual(['PS1', 'Windows'])
    expect(new QueryEngine(repo, () => 'lossless').browse(q('new one')).groups.map((g) => g.title)).toEqual(['New One'])
  })
})

describe('FTS compaction', () => {
  it('merges the segments bulk rewrites leave behind; searches still match; merges again only after regrowth', async () => {
    const repo = new CatalogRepo(memoryDb())
    const { albums } = seedSmall(repo)
    const qe = new QueryEngine(repo, () => 'lossless')
    const ids = Object.values(albums)
    // Many small rewrites, as crawls and re-clusters do.
    for (let i = 0; i < 40; i++) repo.updateAlbumFts(ids)
    const segments = () => repo.get<{ n: number }>(`SELECT COUNT(*) AS n FROM album_fts_data`)!.n
    const before = segments()
    const pauses: number[] = []
    const steps = await repo.compactFts(async () => void pauses.push(1))
    expect(steps).toBeGreaterThan(2)
    expect(pauses.length).toBe(steps - 2) // a pause between steps, not after each table's last
    expect(segments()).toBeLessThan(before)
    expect(qe.browse(q('chrono')).groups.map((g) => g.title)).toEqual(['Chrono Cross', 'Chrono Trigger'])
    expect(qe.browse(q('"decisive battle"')).groups.map((g) => g.title)).toEqual(['Final Fantasy VI'])
    // Merged: nothing to do until the index has grown well past its merged size again.
    expect(await repo.compactFts(async () => {})).toBe(0)
    repo.updateAlbumFts([albums['ys-ost']])
    expect(await repo.compactFts(async () => {})).toBe(0)
    // A crawl's worth of new albums in small transactions.
    const more = Array.from({ length: 400 }, (_, i) => hit(`x${i}`, `Some Game Number ${i} Original Soundtrack`, 'ost', 2000, [P.snes]))
    for (let i = 0; i < more.length; i += 20) repo.assignGames(repo.upsertHits(more.slice(i, i + 20), { initial: false }))
    expect(await repo.compactFts(async () => {})).toBeGreaterThan(1)
    expect(await repo.compactFts(async () => {}, () => false, { force: true })).toBe(2) // one look per table
  })

  it('stops when asked', async () => {
    const repo = new CatalogRepo(memoryDb())
    const { albums } = seedSmall(repo)
    for (let i = 0; i < 40; i++) repo.updateAlbumFts(Object.values(albums))
    let n = 0
    expect(await repo.compactFts(async () => {}, () => ++n > 2)).toBe(2)
  })
})

describe('game clustering without resident maps', () => {
  it('a re-cluster deletes games left without albums', async () => {
    const repo = new CatalogRepo(memoryDb())
    seedSmall(repo)
    repo.run(`INSERT INTO games (norm_key, name, sort_name) VALUES ('orphan', 'Orphan', 'orphan')`)
    const games = repo.counts().games
    await repo.reclusterAll(async () => {})
    expect(repo.get(`SELECT 1 FROM games WHERE norm_key = 'orphan'`)).toBeUndefined()
    expect(repo.counts().games).toBe(games - 1)
    expect(repo.get<{ n: number }>(`SELECT COUNT(*) AS n FROM albums WHERE game_id IS NOT NULL AND game_id NOT IN (SELECT id FROM games)`)!.n).toBe(0)
  })

  it('the key snapshot of a running re-cluster forgets games deleted meanwhile', () => {
    const repo = new CatalogRepo(memoryDb())
    const { albums } = seedSmall(repo)
    const ys = repo.get<{ id: number; norm_key: string }>(`SELECT g.id, g.norm_key FROM games g JOIN albums a ON a.game_id = g.id WHERE a.id = ?`, albums['ys-ost'])!
    const snapshot = new Map([[ys.norm_key, ys.id]])
    ;(repo as unknown as { liveGameCaches: Set<Map<string, number>> }).liveGameCaches.add(snapshot)
    repo.markAlbumError(albums['ys-ost'], 'gone', true) // its only album: the game is deleted
    expect(snapshot.has(ys.norm_key)).toBe(false)
  })

  it('writes landing between re-cluster chunks leave no album pointing at a deleted game', async () => {
    const repo = new CatalogRepo(memoryDb())
    const { albums } = seedSmall(repo)
    let once = false
    await repo.reclusterAll(async () => {
      if (once) return
      once = true
      // Another source's write lands meanwhile: Ys disappears, and its game with it.
      repo.markAlbumError(albums['ys-ost'], 'gone', true)
      repo.upsertHits([hit('ys-ost', 'Ys OST', 'ost', 1987, [])], { initial: false })
    })
    expect(repo.get<{ n: number }>(`SELECT COUNT(*) AS n FROM albums WHERE game_id IS NOT NULL AND game_id NOT IN (SELECT id FROM games)`)!.n).toBe(0)
  })

  it('mergeable albums still fold into a game that has an OST, found through the database', () => {
    const repo = new CatalogRepo(memoryDb())
    seedSmall(repo)
    const [id] = repo.upsertHits([hit('ct-piano', 'Chrono Trigger: Piano Collection', 'arrange', 2020, [])], { initial: false })
    repo.assignGames([id])
    const ct = repo.get<{ id: number }>(`SELECT game_id AS id FROM albums WHERE provider_ref = 'chrono-trigger-osv'`)!.id
    expect(repo.get<{ id: number }>(`SELECT game_id AS id FROM albums WHERE id = ?`, id)!.id).toBe(ct)
  })

  it('clusterKeys looks primaries up instead of copying them', () => {
    const seen: string[] = []
    const keys = clusterKeys([{ id: 1, title: 'Chrono Trigger: Piano Collection', kind: 'arrange' }], {
      has: (k) => {
        seen.push(k)
        return k === 'chrono trigger'
      }
    })
    expect(keys.get(1)).toBe('chrono trigger')
    expect(seen).toContain('chrono trigger')
  })
})

describe('bucket groupings', () => {
  it('prepare() aggregates a missing unfiltered grouping in chunks, shared by concurrent callers', async () => {
    const repo = new CatalogRepo(memoryDb())
    seedSmall(repo)
    const sync = new QueryEngine(repo, () => 'lossless').browse(q('', 'platform'))
    const qe = new QueryEngine(repo, () => 'lossless', { bucketStaleMs: 15_000, bucketChunk: 3 })
    const runs: number[] = []
    const all = repo.all.bind(repo)
    repo.all = ((sql: string, ...p: never[]) => {
      if (sql.includes('GROUP BY ap.slug') && sql.includes('COUNT(*) AS n')) runs.push(1)
      return all(sql, ...p)
    }) as typeof repo.all
    await Promise.all([qe.prepare(q('', 'platform')), qe.prepare(q('', 'platform'))])
    const chunks = runs.length
    expect(chunks).toBeGreaterThan(1) // id ranges of 3 albums
    expect(qe.browse(q('', 'platform'))).toEqual(sync)
    expect(runs.length).toBe(chunks) // served from the cache
    await qe.prepare(q('', 'platform'))
    await qe.prepare(q('chrono', 'platform')) // filtered: computed by browse itself
    expect(runs.length).toBe(chunks)
    repo.all = all
  })
})

describe('prepared statements', () => {
  it('the cache is bounded (one entry per IN-list length otherwise) and evicted statements stay usable', () => {
    const repo = new CatalogRepo(memoryDb())
    seedSmall(repo)
    const held = repo.st(`SELECT COUNT(*) AS n FROM albums`)
    for (let n = 1; n <= 400; n++) repo.all(`SELECT id FROM albums WHERE id IN (${Array.from({ length: n }, () => '?').join(',')})`, ...Array.from({ length: n }, (_, i) => i + 1))
    const size = (repo as unknown as { stmts: Map<string, unknown> }).stmts.size
    expect(size).toBeLessThanOrEqual(300)
    expect((held.get() as { n: number }).n).toBe(12)
    expect(repo.counts().albums).toBe(12)
  })
})

describe('platform list', () => {
  it('slug aliases resolve through the stored names', () => {
    const repo = new CatalogRepo(memoryDb())
    seedSmall(repo)
    const qe = new QueryEngine(repo, () => 'lossless')
    expect(qe.platformSlugs('super nintendo')).toEqual([P.snes.slug])
    expect(qe.platformSlugs('genesis').sort()).toEqual([P.genesis.slug])
  })
})
