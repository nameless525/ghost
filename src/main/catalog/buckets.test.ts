import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowseQuery, GroupBy } from '../../shared/types'
import { ensureLibrarySchema } from '../library/schema'
import { QueryEngine } from './query'
import { CatalogRepo } from './repo'
import { detail, hit, memoryDb, P, seedSmall } from './testing'

const q = (text: string, group: GroupBy, sort: BrowseQuery['sort'] = 'title'): BrowseQuery => ({ text, group, sort, offset: 0, limit: 100 })

describe('bucket groupings follow likes and downloads written on the main connection', () => {
  // Like the app: the catalog worker and the main process on their own connections to one file.
  let dir: string
  let worker: DatabaseSync
  let main: DatabaseSync
  let repo: CatalogRepo
  let qe: QueryEngine
  let track: (title: string) => string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ghost-buckets-'))
    const file = join(dir, 'ghost.db')
    worker = new DatabaseSync(file)
    worker.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    main = new DatabaseSync(file)
    main.exec('PRAGMA busy_timeout = 5000;')
    ensureLibrarySchema(main)
    repo = new CatalogRepo(worker)
    const { albums } = seedSmall(repo)
    await repo.refreshFranchises()
    repo.updateAlbumFts(Object.values(albums))
    // The app's stale window: library changes must not wait it out.
    qe = new QueryEngine(repo, () => 'lossless', { bucketStaleMs: 15_000, now: () => 0 })
    track = (title) => String(repo.get<{ id: number }>(`SELECT id FROM tracks WHERE title = ?`, title)!.id)
  })

  afterEach(() => {
    worker.close()
    main.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const titles = (text: string, group: GroupBy) => qe.browse(q(text, group)).groups.map((g) => g.title)

  it.each<[GroupBy, string[], string[]]>([
    ['platform', ['Switch', 'Windows'], ['SNES']],
    ['year', ['2017'], ['1994']],
    ['composer', ['Christopher Larkin'], ['Nobuo Uematsu']],
    ['franchise', ['Hollow Knight'], ['Final Fantasy']]
  ])('%s', (group, liked, downloaded) => {
    expect(titles('liked=yes', group)).toEqual([])
    expect(titles('downloaded=yes', group)).toEqual([])
    const unliked = titles('liked=no', group)
    main.prepare(`INSERT INTO likes (track_id, at) VALUES (?, 1)`).run(track('Hornet'))
    main.prepare(`INSERT INTO downloads (id, track_id, path, status, created_at, updated_at) VALUES ('d1', ?, '/x.flac', 'done', 1, 1)`).run(track('Dancing Mad'))
    expect(titles('liked=yes', group)).toEqual(liked)
    expect(titles('downloaded=yes', group)).toEqual(downloaded)
    const key = qe.browse(q('liked=yes', group)).groups[0].key
    expect(qe.groupAlbums(key, { text: 'liked=yes', group, sort: 'title' }).map((a) => a.title)).toEqual(['Hollow Knight'])
    main.prepare(`DELETE FROM likes`).run()
    main.prepare(`UPDATE downloads SET status = 'failed'`).run()
    expect(titles('liked=yes', group)).toEqual([])
    expect(titles('downloaded=yes', group)).toEqual([])
    expect(titles('liked=no', group)).toEqual(unliked)
  })
})

describe('bucketStaleMs', () => {
  it('an aggregation that old is recomputed in the background even when no catalog revision says so', async () => {
    const repo = new CatalogRepo(memoryDb())
    seedSmall(repo)
    let t = 0
    const qe = new QueryEngine(repo, () => 'lossless', { bucketStaleMs: 1000, now: () => t })
    const jobs = (qe as unknown as { bucketJobs: Map<string, Promise<void>> }).bucketJobs
    const opus = q('source=opus', 'platform')
    expect(qe.browse(opus).total).toBe(0)
    // A source resolved for a track (written without a revision bump).
    const hornet = repo.get<{ id: number }>(`SELECT id FROM tracks WHERE title = 'Hornet'`)!.id
    repo.run(`INSERT INTO sources (track_id, provider, locator, cache_key, format, verified_at) VALUES (?, 'youtube', 'v', 'yt:v', 'opus', 0)`, hornet)
    t = 500
    expect(qe.browse(opus).total).toBe(0) // within the window
    expect(jobs.size).toBe(0)
    t = 1500
    expect(qe.browse(opus).total).toBe(0) // served while it is recomputed
    expect(jobs.size).toBe(1)
    await Promise.all(jobs.values())
    expect(qe.browse(opus).groups.map((g) => g.title)).toEqual(['Switch', 'Windows'])
  })
})

describe('Length sort of bucket groupings', () => {
  it('orders by total length, shortest first and unknown last, as games and albums do', () => {
    const repo = new CatalogRepo(memoryDb())
    const qe = new QueryEngine(repo, () => 'lossless')
    const hits = [
      hit('alpha', 'Alpha', 'ost', 1991, [P.snes]),
      hit('beta', 'Beta', 'ost', 1991, [P.snes]),
      hit('gamma', 'Gamma', 'ost', 1992, [P.win]),
      hit('delta', 'Delta', 'ost', 1993, [P.genesis])
    ]
    const ids = repo.upsertHits(hits, { initial: true })
    repo.assignGames(ids)
    const composers = ['Many Albums', 'Many Albums', 'One Album', 'Unknown Length']
    hits.forEach((h, i) => {
      const d = detail(h, [{ title: `${h.title} Theme`, ms: [900_000, 900_000, 5_000, 0][i] }], { composers: [composers[i]] })
      if (i === 3) d.tracks[0].durationMs = null
      repo.applyAlbumDetail(ids[i], d)
    })
    // More albums must not mean longer: SNES has two of 15 minutes, Windows one of 5 seconds.
    expect(qe.browse(q('', 'platform', 'length')).groups.map((g) => g.title)).toEqual(['Windows', 'SNES', 'Genesis'])
    expect(qe.browse(q('', 'year', 'length')).groups.map((g) => g.title)).toEqual(['1992', '1991', '1993'])
    expect(qe.browse(q('', 'composer', 'length')).groups.map((g) => g.title)).toEqual(['One Album', 'Many Albums', 'Unknown Length'])
    expect(qe.browse(q('', 'game', 'length')).groups.map((g) => g.title)).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta'])
  })
})
