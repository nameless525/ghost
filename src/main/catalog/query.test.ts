import { beforeAll, describe, expect, it } from 'vitest'
import type { BrowseQuery, GroupBy, SortBy } from '../../shared/types'
import type { AlbumHit } from '../providers/types'
import { QueryEngine } from './query'
import { CatalogRepo } from './repo'
import { hit, memoryDb, P, seedSmall } from './testing'

const q = (text: string, group: GroupBy = 'game', sort: SortBy = 'title', offset = 0, limit = 50): BrowseQuery => ({ text, group, sort, offset, limit })

describe('browse on a small seeded catalog', () => {
  const db = memoryDb()
  const repo = new CatalogRepo(db)
  const qe = new QueryEngine(repo, () => 'lossless')
  let albums: Record<string, number>
  let trackIds: Record<string, string>

  beforeAll(() => {
    albums = seedSmall(repo).albums
    trackIds = Object.fromEntries(repo.all<{ id: number; title: string }>(`SELECT id, title FROM tracks`).map((r) => [r.title, String(r.id)]))
    // Analysis for two tracks.
    const base = { integratedLufs: -14, loudnessRange: 6, truePeakDb: -1, bpmConfidence: 0.9, beats: [0.5, 1, 1.5], downbeats: [0.5], kiai: [[10, 20]] as [number, number][], energy: [0.1, 0.5, 1] }
    repo.recordAnalysis(Number(trackIds['Battle with Magus']), { ...base, bpm: 152, intensity: 6.2, durationMs: 172_000 })
    repo.recordAnalysis(Number(trackIds['Peaceful Days']), { ...base, bpm: 80, intensity: 1.4, durationMs: 172_000 })
    repo.recordAnalysis(Number(trackIds['Dancing Mad']), { ...base, bpm: 140, intensity: 7.5, durationMs: 1_060_000 })
  })

  const titles = (text: string, group: GroupBy = 'game', sort: SortBy = 'title') => qe.browse(q(text, group, sort)).groups.map((g) => g.title)

  it('clusters albums into games', () => {
    const page = qe.browse(q(''))
    expect(page.total).toBe(9)
    const ct = page.groups.find((g) => g.title === 'Chrono Trigger')!
    expect(ct).toMatchObject({ kind: 'game', albumCount: 4, year: 1995, subtitle: '1995 · SNES · DS' })
    expect(ct.key).toBe(`game:${ct.gameId}`)
    expect(ct.cover).toBe('https://img.example/chrono-trigger-osv/c.jpg')
    expect(page.groups.map((g) => g.title)).toContain('Hollow Knight: Silksong')
    expect(page.groups.find((g) => g.title === 'Hollow Knight: Silksong')!.cover).toBeNull()
  })

  it('sorts by title (articles ignored), year, recent, random', () => {
    expect(titles('')).toEqual(['Chrono Cross', 'Chrono Trigger', 'Final Fantasy VI', 'Final Fantasy VII', 'Hollow Knight', 'Hollow Knight: Silksong', 'Kirby: Nightmare in Dream Land', 'Sonic the Hedgehog', 'Ys'])
    expect(titles('', 'game', 'year').slice(0, 3)).toEqual(['Ys', 'Sonic the Hedgehog', 'Final Fantasy VI'])
    expect(new Set(titles('', 'game', 'random'))).toEqual(new Set(titles('')))
    // length: games with known total length first (ascending)
    expect(titles('', 'game', 'length')[0]).toBe('Hollow Knight')
    // intensity: analysed games first
    expect(titles('', 'game', 'intensity').slice(0, 2)).toEqual(['Chrono Trigger', 'Final Fantasy VI'])
  })

  it('pagination', () => {
    const a = qe.browse(q('', 'game', 'title', 0, 4))
    const b = qe.browse(q('', 'game', 'title', 4, 4))
    expect(a.total).toBe(9)
    expect(a.groups.length).toBe(4)
    expect(b.offset).toBe(4)
    expect(b.groups[0].title).toBe('Hollow Knight')
  })

  it('free text matches game, album, track titles; case and width insensitive', () => {
    expect(titles('chrono')).toEqual(['Chrono Cross', 'Chrono Trigger'])
    expect(titles('CHRONO trigger')).toEqual(['Chrono Trigger'])
    expect(titles('ｍａｇｕｓ')).toEqual(['Chrono Trigger'])
    expect(titles('dancing mad')).toEqual(['Final Fantasy VI'])
    expect(titles('"decisive battle"')).toEqual(['Final Fantasy VI'])
    expect(titles('battle')).toEqual(['Chrono Trigger', 'Final Fantasy VI'])
    expect(titles('nothing-matches-this')).toEqual([])
  })

  it('Japanese alt titles and diacritics', () => {
    expect(titles('クロノ')).toEqual(['Chrono Trigger'])
    expect(titles('トリガー')).toEqual(['Chrono Trigger'])
  })

  it('short terms fall back to LIKE', () => {
    expect(titles('ys')).toEqual(['Ys'])
    expect(titles('vi')).toEqual(expect.arrayContaining(['Final Fantasy VI', 'Final Fantasy VII']))
  })

  it('exclusions', () => {
    expect(titles('chrono -cross')).toEqual(['Chrono Trigger'])
    expect(titles('-chrono')).not.toContain('Chrono Trigger')
    expect(titles('-ys')).not.toContain('Ys')
  })

  it('filters: platform (names, slugs, aliases), year, kind, composer, game, source', () => {
    expect(titles('platform=snes')).toEqual(['Chrono Trigger', 'Final Fantasy VI'])
    expect(titles('platform="super nintendo"')).toEqual(['Chrono Trigger', 'Final Fantasy VI'])
    expect(titles('platform=ds')).toEqual(['Chrono Trigger'])
    expect(titles('platform=genesis')).toEqual(['Sonic the Hedgehog'])
    expect(titles('platform=megadrive')).toEqual(['Sonic the Hedgehog'])
    expect(titles('platform=nonexistent')).toEqual([])
    expect(titles('platform!=snes')).not.toContain('Final Fantasy VI')
    expect(titles('year<1995')).toEqual(['Final Fantasy VI', 'Sonic the Hedgehog', 'Ys'])
    expect(titles('year=1990s')).toEqual(['Chrono Cross', 'Chrono Trigger', 'Final Fantasy VI', 'Final Fantasy VII', 'Sonic the Hedgehog'])
    expect(titles('year>=2017 year<2020')).toEqual(['Hollow Knight'])
    expect(titles('kind=gamerip')).toEqual(['Chrono Trigger', 'Kirby: Nightmare in Dream Land', 'Sonic the Hedgehog'])
    expect(titles('kind=arrange')).toEqual(['Chrono Trigger'])
    expect(titles('composer=uematsu')).toEqual(['Chrono Trigger', 'Final Fantasy VI'])
    expect(titles('composer="christopher larkin"')).toEqual(['Hollow Knight'])
    expect(titles('composer!=uematsu')).not.toContain('Final Fantasy VI')
    expect(titles('game=chrono')).toEqual(['Chrono Cross', 'Chrono Trigger'])
    expect(titles('source=flac')).toEqual(['Chrono Trigger', 'Final Fantasy VI'])
    expect(titles('source=lossless')).toEqual(['Chrono Trigger', 'Final Fantasy VI'])
    expect(titles('source=khinsider').length).toBe(9)
    expect(titles('source=youtube')).toEqual([])
  })

  it('filters: track-level length, bpm, intensity', () => {
    expect(titles('length>10m')).toEqual(['Final Fantasy VI'])
    expect(titles('length<2:30')).toEqual(['Chrono Trigger', 'Hollow Knight'])
    expect(titles('bpm>=140')).toEqual(['Chrono Trigger', 'Final Fantasy VI'])
    expect(titles('intensity>5 length<4m')).toEqual(['Chrono Trigger'])
    expect(titles('intensity=1.4')).toEqual(['Chrono Trigger'])
    expect(titles('boss platform=snes')).toEqual(['Chrono Trigger'])
  })

  it('liked / downloaded: guarded when the tables are missing, joined when present', () => {
    expect(titles('liked=yes')).toEqual([])
    expect(titles('liked=no').length).toBe(3) // games with fetched tracks
    // services' schema: TEXT track ids
    db.exec(`CREATE TABLE likes (track_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`)
    db.exec(`CREATE TABLE downloads (id TEXT PRIMARY KEY, track_id TEXT NOT NULL, path TEXT, status TEXT NOT NULL)`)
    db.prepare(`INSERT INTO likes VALUES (?, 1)`).run(trackIds['Hornet'])
    db.prepare(`INSERT INTO downloads VALUES ('d1', ?, '/x.flac', 'done')`).run(trackIds['Dancing Mad'])
    db.prepare(`INSERT INTO downloads VALUES ('d2', ?, null, 'queued')`).run(trackIds['Peaceful Days'])
    ;(repo as unknown as { tableCache: Map<string, unknown> }).tableCache.clear()
    expect(titles('liked=yes')).toEqual(['Hollow Knight'])
    expect(titles('downloaded=yes')).toEqual(['Final Fantasy VI'])
    expect(qe.queryTrackIds('liked=yes')).toEqual([trackIds['Hornet']])
    expect(qe.queryTrackIds('downloaded=no platform=snes')).not.toContain(trackIds['Dancing Mad'])
  })

  it('invalid filters are ignored rather than matching nothing', () => {
    expect(titles('year>abc').length).toBe(9)
    expect(titles('platform=').length).toBe(9)
  })

  it('group by album / platform / year / composer / franchise', () => {
    const al = qe.browse(q('chrono trigger', 'album'))
    expect(al.total).toBe(4)
    expect(al.groups[0]).toMatchObject({ kind: 'album', albumCount: 1 })
    expect(al.groups.every((g) => g.key.startsWith('album:'))).toBe(true)

    const pl = qe.browse(q('', 'platform'))
    const snes = pl.groups.find((g) => g.title === 'SNES')!
    expect(snes).toMatchObject({ key: 'platform:nintendo-snes', albumCount: 4, platforms: ['SNES'] })
    expect(qe.groupAlbums(snes.key, { text: '', group: 'platform', sort: 'title' }).length).toBe(4)

    const yr = qe.browse(q('', 'year', 'year'))
    expect(yr.groups[0]).toMatchObject({ key: 'year:1987', title: '1987', year: 1987 })
    expect(qe.browse(q('', 'year', 'title')).groups.map((g) => g.title)[0]).toBe('1987')

    const comp = qe.browse(q('', 'composer'))
    expect(comp.groups.map((g) => g.title)).toEqual(['Christopher Larkin', 'Nobuo Uematsu', 'Yasunori Mitsuda'])
    expect(comp.groups.find((g) => g.title === 'Nobuo Uematsu')!.albumCount).toBe(2)
    expect(qe.groupAlbums('composer:nobuo uematsu', { text: '', group: 'composer', sort: 'year' }).map((a) => a.year)).toEqual([1994, 1995])
  })

  it('franchise buckets from heuristic franchise names', async () => {
    await repo.refreshFranchises()
    repo.updateAlbumFts(Object.values(albums))
    const fr = qe.browse(q('', 'franchise'))
    // "Chrono Trigger" / "Chrono Cross" share no numbered head, so only these two are detected.
    expect(fr.groups.map((g) => g.title)).toEqual(['Final Fantasy', 'Hollow Knight'])
    expect(fr.groups.find((g) => g.title === 'Final Fantasy')!.subtitle).toBe('2 games · 2 albums · since 1994')
    expect(titles('franchise="final fantasy"')).toEqual(['Final Fantasy VI', 'Final Fantasy VII'])
  })

  it('groupAlbums for a game orders OST first, then by year; filters apply', () => {
    const ct = qe.browse(q('chrono trigger')).groups[0]
    const as = qe.groupAlbums(ct.key, { text: '', group: 'game', sort: 'title' })
    expect(as.map((a) => a.kind)).toEqual(['ost', 'gamerip', 'gamerip', 'arrange'])
    expect(as[0]).toMatchObject({ title: 'Chrono Trigger Original Sound Version', gameName: 'Chrono Trigger', trackCount: 4, formats: ['mp3', 'flac'], composers: ['Yasunori Mitsuda', 'Nobuo Uematsu'] })
    expect(as[0].totalMs).toBe(712_000)
    expect(qe.groupAlbums(ct.key, { text: 'kind=gamerip', group: 'game', sort: 'year' }).map((a) => a.year)).toEqual([1995, 2008])
  })

  it('random respects the query', () => {
    for (let i = 0; i < 10; i++) {
      const r = qe.random('platform=snes')!
      expect(r).not.toBeNull()
      const g = repo.game(Number(r.groupKey.split(':')[1]))!
      expect(['Chrono Trigger', 'Final Fantasy VI']).toContain(g.name)
      expect(r.albumId).not.toBeNull()
    }
    expect(qe.random('no such thing anywhere')).toBeNull()
  })

  it('searchTracks ranks matches and fills TrackViews', () => {
    const res = qe.searchTracks('battle')
    expect(res.map((t) => t.title).sort()).toEqual(['Battle with Magus', 'Boss Battle 1', 'The Decisive Battle'])
    const magus = qe.searchTracks('magus')[0]
    expect(magus).toMatchObject({
      title: 'Battle with Magus',
      albumTitle: 'Chrono Trigger Original Sound Version',
      albumKind: 'ost',
      gameName: 'Chrono Trigger',
      year: 1995,
      platforms: ['SNES'],
      cover: 'https://img.example/chrono-trigger-osv/c.jpg',
      composers: ['Yasunori Mitsuda', 'Nobuo Uematsu'],
      liked: false,
      downloaded: false,
      analysis: { bpm: 152, intensity: 6.2, lufs: -14 },
      source: { provider: 'khinsider', format: 'flac', lossless: true, confidence: 1 }
    })
    expect(magus.source!.bitrateKbps).toBe(960)
    expect(qe.searchTracks('battle composer=mitsuda').map((t) => t.title).sort()).toEqual(['Battle with Magus', 'Boss Battle 1'])
    expect(qe.searchTracks('')).toEqual([])
  })

  it('queryTrackIds evaluates smart-playlist queries in album order', () => {
    expect(qe.queryTrackIds('platform=snes intensity>5')).toEqual([trackIds['Battle with Magus'], trackIds['Dancing Mad']])
    expect(qe.queryTrackIds('game="chrono trigger"').length).toBe(4)
    expect(qe.queryTrackIds('kind=gamerip')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Performance: ~80k albums through the real write path.

const WORDS_A = ['Super', 'Final', 'Dragon', 'Shadow', 'Star', 'Mega', 'Crystal', 'Iron', 'Silent', 'Eternal', 'Neon', 'Lost', 'Royal', 'Cyber', 'Wild', 'Dark', 'Golden', 'Hyper', 'Mystic', 'Turbo']
const WORDS_B = ['Quest', 'Fantasy', 'Knight', 'Saga', 'Legends', 'Chronicles', 'Warriors', 'Odyssey', 'Hunter', 'Racer', 'Tactics', 'Arena', 'Frontier', 'Kingdom', 'Story', 'Force', 'Rider', 'Blade', 'Hearts', 'Souls']
const WORDS_C = ['of Time', 'Origins', 'Reborn', 'Zero', 'Revolution', 'Unleashed', 'Rising', 'Remix', 'Ultimate', 'Deluxe', '', '', '', '']
const NUM = ['', ' II', ' III', ' IV', ' 2', ' 3', ' 64', ' DS', ' X', ' 7']
const PLATFORMS = Object.values(P)

function rng(seed: number) {
  return () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296)
}

describe('performance with ~80k albums', () => {
  const N_GAMES = 40_000
  const db = memoryDb()
  const repo = new CatalogRepo(db)
  const qe = new QueryEngine(repo, () => 'lossless')
  let seedMs = 0

  beforeAll(() => {
    const r = rng(42)
    const t0 = performance.now()
    let batch: AlbumHit[] = []
    const flush = () => {
      const ids = repo.upsertHits(batch, { initial: true })
      repo.assignGames(ids)
      batch = []
    }
    for (let g = 0; g < N_GAMES; g++) {
      const name = `${WORDS_A[g % 20]} ${WORDS_B[Math.floor(g / 20) % 20]}${NUM[Math.floor(g / 400) % 10]} ${WORDS_C[Math.floor(g / 4000) % 14]} n${g.toString(36)}`.replace(/\s+/g, ' ').trim()
      const year = 1980 + Math.floor(r() * 46)
      const plats = [PLATFORMS[Math.floor(r() * PLATFORMS.length)], ...(r() < 0.3 ? [PLATFORMS[Math.floor(r() * PLATFORMS.length)]] : [])]
      const uniq = [...new Map(plats.map((p) => [p.slug, p])).values()]
      batch.push(hit(`g${g}-ost`, `${name} Original Soundtrack`, 'ost', year, uniq, r() < 0.1 ? { cover: null, thumb: null } : {}))
      batch.push(hit(`g${g}-rip`, `${name} (Gamerip)`, 'gamerip', year + (r() < 0.2 ? 1 : 0), uniq))
      if (batch.length >= 500) flush()
    }
    flush()
    seedMs = performance.now() - t0
  }, 300_000)

  function time(fn: () => unknown, runs = 7): number {
    fn() // warm up statement cache
    const ts: number[] = []
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      fn()
      ts.push(performance.now() - t0)
    }
    ts.sort((a, b) => a - b)
    return ts[Math.floor(ts.length / 2)]
  }

  it('seeded through the crawl write path', () => {
    const c = repo.counts()
    console.log(`[perf] seeded ${c.albums} albums / ${c.games} games in ${Math.round(seedMs)} ms (${(seedMs / (c.albums / 500)).toFixed(1)} ms per 500-album page)`)
    expect(c.albums).toBe(N_GAMES * 2)
    expect(c.games).toBe(N_GAMES)
  })

  const cases: [string, BrowseQuery][] = [
    ['game, no text, title', q('', 'game', 'title', 0, 60)],
    ['game, no text, deep page', q('', 'game', 'title', 25_000, 60)],
    ['game, sort year', q('', 'game', 'year', 0, 60)],
    ['game, sort recent', q('', 'game', 'recent', 0, 60)],
    ['game, sort random', q('', 'game', 'random', 0, 60)],
    ['game, common word', q('dragon', 'game', 'title', 0, 60)],
    ['game, two words', q('dragon quest', 'game', 'title', 0, 60)],
    ['game, rare word', q('zzqx', 'game', 'title', 0, 60)],
    ['game, short term', q('ds', 'game', 'title', 0, 60)],
    ['game, platform+year', q('platform=snes year<2000', 'game', 'year', 0, 60)],
    ['game, text+kind+platform', q('knight kind=gamerip platform=switch', 'game', 'title', 0, 60)],
    ['game, exclusion', q('dragon -quest', 'game', 'title', 0, 60)],
    ['album, no text', q('', 'album', 'title', 0, 60)],
    ['album, text', q('crystal', 'album', 'recent', 0, 60)],
    ['platform buckets', q('', 'platform', 'title', 0, 60)],
    ['year buckets', q('', 'year', 'year', 0, 60)]
  ]

  it.each(cases)('browse: %s < 30 ms', (_label, query) => {
    const ms = time(() => qe.browse(query))
    const page = qe.browse(query)
    console.log(`[perf] ${_label.padEnd(28)} ${ms.toFixed(2).padStart(7)} ms  total=${page.total}`)
    expect(ms).toBeLessThan(30)
  })

  it('cold bucket aggregations (first page of a non-game grouping, cache empty)', () => {
    for (const group of ['platform', 'year', 'composer', 'franchise'] as GroupBy[]) {
      const ts: number[] = []
      for (let i = 0; i < 3; i++) {
        repo.revision++ // invalidate the bucket cache
        const t0 = performance.now()
        qe.browse(q('', group, 'title', 0, 60))
        ts.push(performance.now() - t0)
      }
      ts.sort((a, b) => a - b)
      console.log(`[perf] cold ${group.padEnd(10)} buckets ${ts[1].toFixed(2)} ms`)
      expect(ts[1]).toBeLessThan(150)
    }
  })

  it('groupAlbums and random are fast', () => {
    const g = qe.browse(q('dragon', 'game', 'title', 0, 1)).groups[0]
    const a = time(() => qe.groupAlbums(g.key, { text: 'dragon', group: 'game', sort: 'title' }))
    const r = time(() => qe.random('platform=snes'))
    console.log(`[perf] groupAlbums ${a.toFixed(2)} ms, random ${r.toFixed(2)} ms`)
    expect(a).toBeLessThan(10)
    expect(r).toBeLessThan(30)
  })

  it('full recluster stays reasonable', async () => {
    const t0 = performance.now()
    await repo.reclusterAll(async () => {})
    const ms = performance.now() - t0
    console.log(`[perf] full recluster of ${repo.counts().albums} albums: ${Math.round(ms)} ms`)
    expect(repo.counts().games).toBe(N_GAMES)
  }, 120_000)
})
