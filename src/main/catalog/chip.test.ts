import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { Settings } from '../../shared/types'
import type { ArchiveListing, EngineSource } from '../engine/types'
import { NetError } from '../net/errors'
import type { HttpClient, PageResult } from '../net/http'
import { ProviderRegistry } from '../providers'
import { ChipProvider, joshwPageSets, joshwSource, parseVgmripsListing, type ChipSet } from '../providers/chip'
import { ChipIndexer } from './chip'
import type { CatalogService } from './index'
import { QueryEngine } from './query'
import { CatalogRepo } from './repo'
import { createCatalogService } from './service'
import { hit, memoryDb, seedSmall } from './testing'

const dir = join(__dirname, '../providers/__fixtures__/chip')
const fx = (name: string) => readFileSync(join(dir, name), 'utf8')
const listing = (name: string) => JSON.parse(fx(`listing-${name}.json`)) as ArchiveListing

function fakeHttp(pages: Record<string, string>): HttpClient & { requests: string[] } {
  const requests: string[] = []
  return {
    requests,
    async pageFetch(url): Promise<PageResult> {
      requests.push(url)
      const v = pages[url]
      if (v === undefined) throw new NetError('not_found', `no fixture for ${url}`)
      return { url, status: 200, html: v, fromCache: false, stale: false, fetchedAt: Date.now() }
    },
    async fetchBytes() {
      throw new Error('not used')
    },
    limiter() {
      throw new Error('not used')
    },
    blockedUntil: () => 0,
    invalidate: async () => {}
  }
}

async function until(cond: () => boolean | Promise<boolean>, ms = 10_000) {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const set = (over: Partial<ChipSet> & Pick<ChipSet, 'ref' | 'title'>): ChipSet => ({
  source: 'joshw',
  archiveUrl: `https://${over.ref}`,
  altTitles: [],
  system: { label: 'SNES', platform: { slug: 'nintendo-snes', name: 'SNES' } },
  format: 'SPC',
  year: 1995,
  variant: [],
  sizeBytes: 290_000,
  trackCount: null,
  developers: [],
  publishers: [],
  composers: [],
  cover: null,
  thumb: null,
  ...over
})

describe('ChipIndexer.attach: chip sets become albums on games', () => {
  const db = memoryDb()
  const repo = new CatalogRepo(db)
  seedSmall(repo)
  // the NES Final Fantasy III, so the SNES "Final Fantasy III" (VI) set has two candidates
  repo.assignGames(repo.upsertHits([hit('ff3-nes', 'Final Fantasy III (NES)', 'gamerip', 1990, [{ slug: 'nintendo-nes', name: 'NES' }])], { initial: true }))
  const qe = new QueryEngine(repo, () => 'lossless')
  const indexer = new ChipIndexer({ repo, provider: new ChipProvider({ http: fakeHttp({}) }), onProgress: () => {} })
  const gameOf = (albumId: number) => repo.get<{ id: number; name: string; norm_key: string }>(`SELECT g.id, g.name, g.norm_key FROM albums a JOIN games g ON g.id = a.game_id WHERE a.id = ?`, albumId)!
  let ct = 0
  let mm2 = 0
  let ff = 0

  beforeAll(() => {
    ;[ct, mm2, ff] = indexer.attach([
      set({ ref: 'spc.joshw.info/c/Chrono%20Trigger.7z', title: 'Chrono Trigger' }),
      set({
        ref: 'nsf.joshw.info/m/Mega%20Man%202.7z',
        title: 'Mega Man 2',
        altTitles: ['RockMan 2 - Dr. Wily no Nazo'],
        format: 'NSF',
        year: 1988,
        system: { label: 'NES', platform: { slug: 'nintendo-nes', name: 'NES' } },
        developers: ['Capcom'],
        publishers: ['Capcom']
      }),
      // the title names the NES game, the alternative title the SNES one: the platform decides
      set({ ref: 'spc.joshw.info/f/Final%20Fantasy%20III.7z', title: 'Final Fantasy III', altTitles: ['Final Fantasy VI'], year: 1994 })
    ])
  })

  it('attaches to the existing game by normalised name', () => {
    expect(gameOf(ct).name).toBe('Chrono Trigger')
    expect(repo.album(ct)).toMatchObject({ title: 'Chrono Trigger (SNES SPC rip)', kind: 'gamerip', provider: 'chip', formats: ['chip'], platforms: ['SNES'], year: 1995 })
    const khGame = repo.get<{ game_id: number }>(`SELECT game_id FROM albums WHERE provider_ref = 'chrono-trigger-osv'`)!.game_id
    expect(gameOf(ct).id).toBe(khGame)
    expect(gameOf(ff).name).toBe('Final Fantasy VI')
  })

  it('creates the game when the catalog has none, named after the set', () => {
    const g = gameOf(mm2)
    expect(g).toMatchObject({ name: 'Mega Man 2', norm_key: 'mega man 2' })
    expect(repo.game(g.id)).toMatchObject({ name: 'Mega Man 2', year: 1988, platforms: ['NES'], albumCount: 1 })
    expect(repo.get(`SELECT game_title, format, album_id FROM chip_sets WHERE ref = ?`, 'nsf.joshw.info/m/Mega%20Man%202.7z')).toEqual({ game_title: 'Mega Man 2', format: 'NSF', album_id: mm2 })
  })

  it('shows up in Browse, search (FTS) and the source / kind filters', () => {
    const page = qe.browse({ text: 'mega man 2', group: 'game', sort: 'title', offset: 0, limit: 10 })
    expect(page.groups.map((g) => g.title)).toContain('Mega Man 2')
    const albums = qe.groupAlbums(page.groups.find((g) => g.title === 'Mega Man 2')!.key, { text: '', group: 'game', sort: 'title' })
    expect(albums.map((a) => a.title)).toEqual(['Mega Man 2 (NES NSF rip)'])
    // alternative titles and the type label are searchable
    expect(qe.browse({ text: 'rockman 2', group: 'album', sort: 'title', offset: 0, limit: 10 }).groups.map((g) => g.title)).toEqual(['Mega Man 2 (NES NSF rip)'])
    expect(qe.browse({ text: 'mega man 3', group: 'album', sort: 'title', offset: 0, limit: 10 }).total).toBe(0)
    expect(qe.browse({ text: 'spc rip', group: 'album', sort: 'title', offset: 0, limit: 10 }).total).toBe(2)
    const chipOnly = qe.browse({ text: 'source=chip', group: 'album', sort: 'title', offset: 0, limit: 10 })
    expect(chipOnly.groups.map((g) => g.title).sort()).toEqual(['Chrono Trigger (SNES SPC rip)', 'Final Fantasy III (SNES SPC rip)', 'Mega Man 2 (NES NSF rip)'])
    const chrono = qe.groupAlbums(qe.browse({ text: 'chrono trigger', group: 'game', sort: 'title', offset: 0, limit: 5 }).groups[0].key, { text: '', group: 'game', sort: 'title' })
    expect(chrono.map((a) => a.title)).toContain('Chrono Trigger (SNES SPC rip)')
    expect(qe.browse({ text: 'chrono kind=gamerip', group: 'album', sort: 'title', offset: 0, limit: 10 }).groups.map((g) => g.title)).toContain('Chrono Trigger (SNES SPC rip)')
  })

  it('survives a full re-cluster (pinned) and re-attaching is idempotent', async () => {
    const before = [gameOf(ct).id, gameOf(mm2).id, gameOf(ff).id]
    await repo.reclusterAll(async () => {})
    expect([gameOf(ct).id, gameOf(mm2).id, gameOf(ff).id]).toEqual(before)
    expect(gameOf(ff).name).toBe('Final Fantasy VI')
    const again = indexer.attach([set({ ref: 'spc.joshw.info/c/Chrono%20Trigger.7z', title: 'Chrono Trigger' })])
    expect(again).toEqual([ct])
    expect(repo.all(`SELECT id FROM albums WHERE provider = 'chip'`).length).toBe(3)
    // chip albums never join the art-prefetch queue (opening one downloads the archive)
    expect(repo.get<{ a: number | null }>(`SELECT art_checked_at AS a FROM albums WHERE id = ?`, ct)!.a).not.toBeNull()
  })

  it('indexes whole listing pages', () => {
    const spc = joshwPageSets(joshwSource('spc.joshw.info')!, { path: '/c/', group: null }, fx('joshw-spc-c.html'))
    const ids = indexer.attach(spc.sets)
    expect(ids.length).toBe(76)
    expect(new Set(ids).has(ct)).toBe(false) // a different ref from the hand-made Chrono Trigger set
    const vgm = parseVgmripsListing(fx('vgmrips-latest.html'))
    indexer.attach(vgm.packs.filter((p) => p.playable).map((p) => p.set))
    const road = qe.browse({ text: 'road fighter', group: 'album', sort: 'title', offset: 0, limit: 5 })
    expect(road.groups[0]).toMatchObject({ title: 'Road Fighter (Arcade VGM rip)' })
    expect(qe.browse({ text: 'composer=kodaka', group: 'album', sort: 'title', offset: 0, limit: 5 }).total).toBe(0)
  })
})

describe('Chip index + album detail through the catalog service', () => {
  const settings: Settings = defaultSettings('/tmp/ghost-dl')
  const http = fakeHttp({
    'https://nsf.joshw.info/': '<pre><a href="?C=N;O=D">Name</a>\n<a href="0-9/">0-9/</a>   2026-09-07 00:00    -   \n<a href="m/">m/</a>   2026-10-11 17:51    -   \n<a href="robots.txt">robots.txt</a>  2023-05-25 07:27   26   </pre>',
    'https://nsf.joshw.info/0-9/': '<pre><a href="10-Yard%20Fight%20(1985-04-11)(Irem)(Nintendo)%5bNES%5d.7z">10-Yard Fight (1985-04-11)(Irem)(Nintendo)[NES].7z</a> 2013-07-14 13:29  5.4K</pre>',
    'https://nsf.joshw.info/m/': fx('joshw-nsf-m.html'),
    'https://spc.joshw.info/': fx('joshw-nsf-root.html'),
    'https://spc.joshw.info/0-9/': '<pre></pre>',
    'https://spc.joshw.info/a/': '<pre></pre>',
    'https://vgmrips.net/packs/latest': fx('vgmrips-latest.html')
  })
  const inspected: EngineSource[] = []
  let svc: CatalogService
  const db = memoryDb()

  beforeAll(async () => {
    const provider = new ChipProvider({
      http,
      inspectArchive: async (s) => {
        inspected.push(s)
        return listing(s.kind === 'http' && s.url.includes('nsf.joshw.info') ? 'mm2-nsf' : 'ct-spc')
      }
    })
    svc = createCatalogService(
      { db, broadcast: (() => {}) as never, getSettings: () => settings },
      {
        registry: new ProviderRegistry().register(provider),
        startDelayMs: 0,
        disableEnrichment: true,
        disableLocalScan: true,
        chip: { pageDelayMs: 0, maxPages: 2, hosts: ['nsf.joshw.info', 'spc.joshw.info'] },
        log: () => {}
      }
    )
    svc.start()
    await until(async () => (await svc.status()).albums > 0 && !(await svc.status()).indexing)
  })
  afterAll(() => svc.stop())

  it('crawled the listing pages (capped), politely, and recorded them', async () => {
    const s = await svc.status()
    // NSF '0-9' (1) + 'M' (128) + the playable packs of vgmrips' first page (4); SPC's first two pages are empty
    expect(s.albums).toBe(1 + 128 + 4)
    expect(http.requests).toEqual([
      'https://nsf.joshw.info/',
      'https://nsf.joshw.info/0-9/',
      'https://nsf.joshw.info/m/',
      'https://spc.joshw.info/',
      'https://spc.joshw.info/0-9/',
      'https://spc.joshw.info/a/',
      'https://vgmrips.net/packs/latest',
      'https://vgmrips.net/packs/latest?p=1'
    ])
    expect(db.prepare(`SELECT source, page, items, skipped, error IS NOT NULL AS failed FROM chip_pages ORDER BY source, page`).all()).toEqual([
      { source: 'nsf.joshw.info', page: '/0-9/', items: 1, skipped: 0, failed: 0 },
      { source: 'nsf.joshw.info', page: '/m/', items: 128, skipped: 0, failed: 0 },
      { source: 'spc.joshw.info', page: '/0-9/', items: 0, skipped: 0, failed: 0 },
      { source: 'spc.joshw.info', page: '/a/', items: 0, skipped: 0, failed: 0 },
      { source: 'vgmrips', page: 'latest?p=0', items: 4, skipped: 16, failed: 0 },
      // a page that fails is recorded (and retried on the next pass), the crawl goes on
      { source: 'vgmrips', page: 'latest?p=1', items: 0, skipped: 0, failed: 1 }
    ])
    expect(inspected).toEqual([]) // listings only: no archive is fetched while indexing
    expect((await svc.browse({ text: '10-yard', group: 'game', sort: 'title', offset: 0, limit: 5 })).groups[0]).toMatchObject({ title: '10-Yard Fight', platforms: ['NES'] })
    // a restart doesn't re-read anything (the pass is complete and fresh)
    const n = http.requests.length
    svc.stop()
    svc.start()
    await new Promise((r) => setTimeout(r, 50))
    expect(http.requests.length).toBe(n)
    expect((await svc.status()).indexing).toBe(false)
  })

  it('opening a chip album lists its archive and stores ready-to-play sources with sub-songs', async () => {
    const page = await svc.browse({ text: 'mega man 2 source=chip', group: 'album', sort: 'title', offset: 0, limit: 50 })
    const mm2 = page.groups
    expect(mm2.map((g) => g.title)).toEqual(['Mega Man 2 (NES NSF rip)', 'Mega Man 2 (NES NSF rip, Game Genie)'])
    const albumId = mm2[0].key.split(':')[1]
    const d = await svc.album(albumId)
    const archive = 'https://nsf.joshw.info/m/Mega%20Man%202%20%5bRockMan%202%20-%20Dr.%20Wily%20no%20Nazo%5d%20(1988-12-24)(Capcom)%5bNES%5d.7z'
    const cacheKey = `chip:${archive.slice('https://'.length)}`
    expect(inspected).toEqual([{ kind: 'http', url: archive, cacheKey }])
    expect(d.album).toMatchObject({ title: 'Mega Man 2 (NES NSF rip)', kind: 'gamerip', provider: 'chip', formats: ['chip'], trackCount: 23, composers: ['Manami Matsumae', 'Takashi Tateishi'] })
    expect(d.game?.name).toBe('Mega Man 2')
    expect(d.tracks.length).toBe(23)
    const flash = d.tracks[5]
    expect(flash).toMatchObject({ title: 'Flash Man Stage', number: 6, durationMs: 89_629 })
    expect(flash.source).toMatchObject({ provider: 'chip', format: 'chip', bitrateKbps: null })
    // resolves from the stored source: no provider round-trip; entry, sub-song and cache key intact
    const n = http.requests.length
    const nsf = 'Mega Man 2 [RockMan 2 - Dr. Wily no Nazo] (1988-12-24)(Capcom).nsf'
    const want = { provider: 'chip', format: 'chip', bitrateKbps: null, source: { kind: 'http', url: archive, cacheKey, archiveEntry: nsf, subsong: 5, formatHint: 'nsf' } }
    expect(await svc.resolveSources(flash.id)).toMatchObject([want])
    expect(http.requests.length).toBe(n)
    // after a failure the provider re-resolves from the locator alone, offline
    svc.markSourceFailed(flash.id, cacheKey, 'decode error')
    expect(await svc.resolveSources(flash.id)).toMatchObject([want])
    expect(http.requests.length).toBe(n)
    expect(inspected.length).toBe(1)
    // tracks are searchable once the album is open
    expect((await svc.searchTracks('wood man stage')).map((t) => t.albumTitle)).toContain('Mega Man 2 (NES NSF rip)')
    // a second open is served from the DB
    await svc.album(albumId)
    expect(inspected.length).toBe(1)
  })
})
