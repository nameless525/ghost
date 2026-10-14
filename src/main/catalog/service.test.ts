import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { CatalogStatus, Settings } from '../../shared/types'
import { NetError } from '../net/errors'
import type { HttpClient, PageResult } from '../net/http'
import { ProviderRegistry } from '../providers'
import { KhinsiderProvider, parseLatestPage } from '../providers/khinsider'
import type { Provider, StreamInfo } from '../providers/types'
import type { CatalogService } from './index'
import { createCatalogService } from './service'
import { memoryDb } from './testing'

const fx = (name: string) => readFileSync(join(__dirname, '../providers/__fixtures__/khinsider', name), 'utf8')
const KH = 'https://downloads.khinsider.com'
const BIRD = 'a-bird-story-linux-macos-windows-gamerip-2014'

function fakeHttp(pages: Record<string, string | Error>): HttpClient & { requests: string[] } {
  const requests: string[] = []
  return {
    requests,
    async pageFetch(url): Promise<PageResult> {
      requests.push(url)
      const v = pages[url]
      if (v instanceof Error) throw v
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

describe('CatalogService end-to-end over fixtures', () => {
  const settings: Settings = defaultSettings('/tmp/ghost-dl')
  const statuses: CatalogStatus[] = []
  const http = fakeHttp({
    [`${KH}/game-soundtracks/browse/A`]: fx('browse-A.html'),
    [`${KH}/`]: fx('latest-home.html'),
    [`${KH}/game-soundtracks/album/${BIRD}`]: fx('album-a-bird-story-gamerip.html'),
    [`${KH}/game-soundtracks/album/${BIRD}/A%2520Bird%2520Story%2520%2528Piano%2529.mp3`]: fx('track-a-bird-story.html'),
    [`${KH}/game-soundtracks/album/a-bloody-night-macos-windows-gamerip-2017`]: fx('album-not-found.html'),
    [`${KH}/game-soundtracks/album/a-blind-legend-original-game-soundtrack-2016`]: new NetError('blocked', 'downloads.khinsider.com is blocking requests')
  })
  let svc: CatalogService

  beforeAll(async () => {
    svc = createCatalogService(
      { db: memoryDb(), broadcast: ((_e: string, p: CatalogStatus) => statuses.push(p)) as never, getSettings: () => settings },
      {
        registry: new ProviderRegistry().register(new KhinsiderProvider(http)),
        startDelayMs: 0,
        crawlPageDelayMs: 0,
        crawlSections: ['latest', 'letter:A'],
        crawlMaxPagesPerSection: 1,
        disableEnrichment: true,
        log: () => {}
      }
    )
    svc.start()
    await until(async () => (await svc.status()).albums > 0 && !(await svc.status()).indexing)
  })
  afterAll(() => svc.stop())

  it('crawled one letter page + latest feed politely and reports status', async () => {
    const s = await svc.status()
    expect(s.indexing).toBe(false)
    expect(s.albums).toBeGreaterThan(550)
    expect(s.games).toBeGreaterThan(400)
    expect(s.games).toBeLessThan(s.albums)
    expect(s.lastIndexedAt).not.toBeNull()
    expect(s.enrichment).toEqual({ igdb: false, steamGridDb: false })
    expect(http.requests.filter((u) => u.includes('/browse/A')).length).toBe(1)
    await until(() => statuses.length > 0)
    expect(statuses.some((x) => x.indexing && x.progress !== null)).toBe(true)
    expect(typeof statuses[statuses.length - 1].revision).toBe('number')
  })

  it('does not recrawl a fresh index on restart', async () => {
    const before = http.requests.length
    svc.stop()
    svc.start()
    await new Promise((r) => setTimeout(r, 50))
    expect((await svc.status()).indexing).toBe(false)
    expect(http.requests.length).toBe(before)
  })

  it('browse returns games; latest-feed albums get real added dates', async () => {
    const page = await svc.browse({ text: 'bird story', group: 'game', sort: 'title', offset: 0, limit: 20 })
    const bird = page.groups.find((g) => g.title === 'A Bird Story')!
    expect(bird.albumCount).toBe(2)
    const recent = await svc.browse({ text: '', group: 'album', sort: 'recent', offset: 0, limit: 5 })
    const newest = parseLatestPage(fx('latest-home.html')).items.filter((i) => i.addedAt === Date.UTC(2026, 9, 14)).map((i) => i.title)
    expect(newest).toContain(recent.groups[0].title)
    const top = await svc.groupAlbums(recent.groups[0].key, { text: '', group: 'album', sort: 'recent' })
    expect(top[0].addedAt).toBe(Date.UTC(2026, 9, 14))
    const albums = await svc.groupAlbums(bird.key, { text: '', group: 'game', sort: 'title' })
    expect(albums.map((a) => a.kind)).toEqual(['ost', 'gamerip'])
  })

  it('album() fetches the album page on first access and returns TrackViews', async () => {
    const page = await svc.browse({ text: 'bird story kind=gamerip', group: 'album', sort: 'title', offset: 0, limit: 5 })
    const albumId = page.groups[0].key.split(':')[1]
    const d = await svc.album(albumId)
    expect(d.album).toMatchObject({ title: 'A Bird Story', kind: 'gamerip', trackCount: 46, formats: ['mp3', 'ogg'], provider: 'khinsider', providerRef: BIRD })
    expect(d.album.addedAt).toBe(Date.UTC(2025, 11, 17))
    expect(d.game?.name).toBe('A Bird Story')
    expect(d.tracks.length).toBe(46)
    expect(d.tracks[0]).toMatchObject({ title: 'A Bird Story (Piano)', number: 1, disc: 1, durationMs: 203_000, liked: false, downloaded: false, albumTitle: 'A Bird Story' })
    // lossless preference, but no FLAC on this album → mp3 by ladder (mp3 before ogg)
    expect(d.tracks[0].source).toMatchObject({ provider: 'khinsider', format: 'mp3', lossless: false })
    // second call is served from the DB
    const n = http.requests.length
    await svc.album(albumId)
    expect(http.requests.length).toBe(n)
    // tracks() keeps the requested order and skips unknown ids
    const ids = [d.tracks[2].id, 'nope', d.tracks[0].id]
    expect((await svc.tracks(ids)).map((t) => t.id)).toEqual([d.tracks[2].id, d.tracks[0].id])
    expect((await svc.albumOf(d.tracks[0].id))?.album.id).toBe(albumId)
    expect(await svc.queryTrackIds('"bird story" piano')).toContain(d.tracks[0].id)
    expect((await svc.searchTracks('piano')).map((t) => t.title)).toContain('A Bird Story (Piano)')
  })

  it('resolveSources: track page → ranked EngineSources, cached, exclude + markSourceFailed', async () => {
    const [t] = await svc.searchTracks('"a bird story (piano)"', 1)
    const n = http.requests.length
    const list = await svc.resolveSources(t.id, { quality: 'lossless' })
    expect(http.requests.length).toBe(n + 1)
    expect(list.map((s) => s.format)).toEqual(['mp3', 'ogg'])
    expect(list[0]).toMatchObject({
      provider: 'khinsider',
      lossless: false,
      confidence: 1,
      source: {
        kind: 'http',
        url: 'https://lambda.vgmtreasurechest.com/soundtracks/a-bird-story-linux-macos-windows-gamerip-2014/xdvqfqdnks/A%20Bird%20Story%20%28Piano%29.mp3',
        cacheKey: 'kh:a-bird-story-linux-macos-windows-gamerip-2014/A Bird Story (Piano).mp3',
        headers: { Referer: 'https://downloads.khinsider.com/' },
        formatHint: 'mp3'
      }
    })
    expect(list[0].bitrateKbps).toBeGreaterThan(100)
    // saver prefers ogg
    expect((await svc.resolveSources(t.id, { quality: 'saver' }))[0].format).toBe('ogg')
    expect(http.requests.length).toBe(n + 1) // cached in `sources`
    // exclude drops a cache key
    const ex = await svc.resolveSources(t.id, { quality: 'lossless', exclude: [list[0].source.kind === 'http' ? list[0].source.cacheKey : ''] })
    expect(ex.map((s) => s.format)).toEqual(['ogg'])
    // a failure demotes the source and forces one re-resolve of the provider
    svc.markSourceFailed(t.id, (list[0].source as { cacheKey: string }).cacheKey, 'HTTP 404')
    const after = await svc.resolveSources(t.id, { quality: 'lossless' })
    expect(http.requests.length).toBe(n + 2)
    expect(after.map((s) => s.format)).toEqual(['ogg', 'mp3'])
    // the TrackView source summary reflects cached sources
    expect((await svc.tracks([t.id]))[0].source?.format).toBe('ogg')
  })

  it('disabled providers are skipped', async () => {
    const [t] = await svc.searchTracks('"a bird story (piano)"', 1)
    settings.sources.disabled = ['khinsider']
    expect(await svc.resolveSources(t.id)).toEqual([])
    settings.sources.disabled = []
  })

  it('a removed album is flagged gone; a blocked fetch surfaces a typed error', async () => {
    const gone = (await svc.browse({ text: 'bloody night', group: 'album', sort: 'title', offset: 0, limit: 5 })).groups[0]
    await expect(svc.album(gone.key.split(':')[1])).rejects.toThrow(/^\[not_found\]/)
    expect((await svc.browse({ text: 'bloody night', group: 'album', sort: 'title', offset: 0, limit: 5 })).total).toBe(0)
    const blocked = (await svc.browse({ text: 'blind legend', group: 'album', sort: 'title', offset: 0, limit: 5 })).groups[0]
    await expect(svc.album(blocked.key.split(':')[1])).rejects.toThrow(/^\[blocked\]/)
  })

  it('recordAnalysis / getAnalysis round-trip and feed intensity sort', async () => {
    const [t] = await svc.searchTracks('"a bird story (piano)"', 1)
    svc.recordAnalysis(t.id, {
      integratedLufs: -15.5,
      loudnessRange: 5,
      truePeakDb: -0.7,
      bpm: 96,
      bpmConfidence: 0.8,
      beats: [0.25, 0.875, 1.5],
      downbeats: [0.25],
      kiai: [
        [12.5, 30],
        [60, 75.25]
      ],
      energy: [0, 0.5, 1],
      intensity: 2.4,
      durationMs: 203_000
    })
    expect(await svc.getAnalysis(t.id)).toEqual({ lufs: -15.5, truePeakDb: expect.closeTo(-0.7, 5), bpm: 96, beats: [0.25, 0.875, 1.5], downbeats: [0.25], kiai: [[12.5, 30], [60, 75.25]], energy: [0, 0.5, 1], intensity: 2.4 })
    expect((await svc.tracks([t.id]))[0].analysis).toEqual({ bpm: 96, intensity: 2.4, lufs: -15.5 })
    expect(await svc.getAnalysis('999999')).toBeNull()
    const top = await svc.browse({ text: '', group: 'game', sort: 'intensity', offset: 0, limit: 1 })
    expect(top.groups[0].title).toBe('A Bird Story')
    expect((await svc.browse({ text: 'intensity>2', group: 'game', sort: 'title', offset: 0, limit: 5 })).groups.map((g) => g.title)).toEqual(['A Bird Story'])
  })

  it('random() picks a group matching the query', async () => {
    const r = await svc.random('bird story')
    expect(r?.groupKey).toMatch(/^game:\d+$/)
    expect(r?.albumId).not.toBeNull()
  })
})

describe('site search while the first crawl is incomplete', () => {
  it('browse() also asks KHInsider search and merges the hits', async () => {
    const settings: Settings = defaultSettings('/tmp/x')
    const http = fakeHttp({
      [`${KH}/game-soundtracks/browse/A`]: new NetError('network', 'offline'),
      [`${KH}/search?search=hollow+knight`]: fx('search-hollow-knight.html')
    })
    const svc = createCatalogService(
      { db: memoryDb(), broadcast: (() => {}) as never, getSettings: () => settings },
      { registry: new ProviderRegistry().register(new KhinsiderProvider(http)), startDelayMs: 0, crawlSections: ['letter:A'], disableEnrichment: true, log: () => {} }
    )
    svc.start()
    await until(async () => (await svc.status()).indexing)
    expect((await svc.browse({ text: 'hollow knight', group: 'game', sort: 'title', offset: 0, limit: 20 })).total).toBe(0)
    await until(async () => (await svc.browse({ text: 'hollow knight', group: 'game', sort: 'title', offset: 0, limit: 20 })).total > 0, 5000)
    const titles = (await svc.browse({ text: 'hollow knight', group: 'game', sort: 'title', offset: 0, limit: 20 })).groups.map((g) => g.title)
    expect(titles).toContain('Hollow Knight')
    expect(titles).toContain('Hollow Knight: Silksong')
    expect(http.requests.filter((u) => u.includes('/search?')).length).toBe(1)
    svc.stop()
  }, 15_000)
})

describe('resolver: more providers plug in by priority', () => {
  it('a search-based provider ranks by settings.sources.order and quality ladder', async () => {
    const settings: Settings = defaultSettings('/tmp/x')
    const http = fakeHttp({
      [`${KH}/game-soundtracks/album/${BIRD}`]: fx('album-a-bird-story-gamerip.html'),
      [`${KH}/game-soundtracks/album/${BIRD}/A%2520Bird%2520Story%2520%2528Piano%2529.mp3`]: fx('track-a-bird-story.html')
    })
    const local: Provider = {
      id: 'local',
      name: 'Local files',
      async findTrack(t) {
        return t.title === 'A Bird Story (Piano)' ? [{ provider: 'local', locator: '/music/bird.flac', title: t.title, durationMs: t.durationMs, confidence: 0.95 }] : []
      },
      async resolveStream(locator): Promise<StreamInfo[]> {
        return [{ provider: 'local', source: { kind: 'file', path: locator }, format: 'flac', lossless: true, bitrateKbps: 900, sizeBytes: 1, expiresAt: null }]
      }
    }
    const db = memoryDb()
    const svc = createCatalogService(
      { db, broadcast: (() => {}) as never, getSettings: () => settings },
      { registry: new ProviderRegistry().register(new KhinsiderProvider(http)).register(local), disableEnrichment: true, log: () => {} }
    )
    // Seed the album through the provider (as the crawler would)
    const { CatalogRepo } = await import('./repo')
    const repo = new CatalogRepo(db)
    const ids = repo.upsertHits([{ provider: 'khinsider', ref: BIRD, title: 'A Bird Story', titleFromRef: false, platforms: [], kind: 'gamerip', typeLabel: 'Gamerip', year: 2014, thumb: null, cover: null, catalogNo: null, addedAt: null }], { initial: true })
    repo.assignGames(ids)
    const d = await svc.album(String(ids[0]))
    const list = await svc.resolveSources(d.tracks[0].id, { quality: 'lossless' })
    expect(list.map((s) => `${s.provider}:${s.format}`)).toEqual(['local:flac', 'khinsider:mp3', 'khinsider:ogg'])
    expect(list[0].source).toEqual({ kind: 'file', path: '/music/bird.flac', formatHint: 'flac' })
    expect(list[0].confidence).toBe(0.95)
    // file sources are keyed 'file:<path>' (the services' convention)
    svc.markSourceFailed(d.tracks[0].id, 'file:/music/bird.flac', 'missing')
    // reorder: khinsider first
    settings.sources.order = ['khinsider', 'local']
    const again = await svc.resolveSources(d.tracks[0].id, { quality: 'lossless' })
    expect(again[again.length - 1].provider).toBe('local')
    expect(again[0].provider).toBe('khinsider')
  })
})

describe('several index sources', () => {
  /** A tiny IndexProvider: one section with `pages` pages of two albums each. */
  function fakeIndex(id: string, titles: string[][], calls: string[]): Provider & { indexSections(): { key: string; label: string }[]; fetchIndexPage(k: string, p: number): Promise<import('../providers/types').IndexPage> } {
    return {
      id,
      name: id.toUpperCase(),
      indexPageDelayMs: 0,
      indexSections: () => [{ key: 'all', label: 'All' }],
      async fetchIndexPage(_k: string, page: number) {
        calls.push(`${id}:${page}`)
        const items = titles[page - 1].map((title) => ({
          provider: id,
          ref: `${id}-${title}`,
          title,
          titleFromRef: false,
          platforms: [],
          kind: 'gamerip' as const,
          typeLabel: null,
          year: null,
          thumb: null,
          cover: null,
          catalogNo: null,
          addedAt: null
        }))
        return { items, page, totalPages: titles.length, totalAlbums: null }
      },
      async resolveStream(): Promise<StreamInfo[]> {
        return []
      }
    } as never
  }

  it('crawls the main source first, then each other source once; re-index re-reads all of them', async () => {
    const calls: string[] = []
    const settings: Settings = defaultSettings('/tmp/ghost-dl')
    const primary = fakeIndex('main', [['Chrono Trigger OST', 'Hollow Knight OST'], ['Ys OST']], calls)
    const extra = fakeIndex('extra', [['Chrono Trigger (Gamerip)', 'Mother 3 (Gamerip)']], calls)
    const muted = fakeIndex('muted', [['Never Crawled']], calls)
    const svc = createCatalogService(
      { db: memoryDb(), broadcast: (() => {}) as never, getSettings: () => ({ ...settings, sources: { ...settings.sources, disabled: ['muted'] } }) },
      { registry: new ProviderRegistry().register(primary).register(extra).register(muted), startDelayMs: 0, crawlPageDelayMs: 0, disableEnrichment: true, chip: false, log: () => {} }
    )
    svc.start()
    await until(() => calls.includes('extra:1'))
    await until(async () => !(await svc.status()).indexing)
    expect(calls).toEqual(['main:1', 'main:2', 'extra:1'])
    const games = await svc.browse({ text: '', group: 'game', sort: 'title', offset: 0, limit: 10 })
    // the second source's Chrono Trigger rip joins the existing game; Mother 3 is new
    expect(games.groups.map((g) => [g.title, g.albumCount])).toEqual([
      ['Chrono Trigger', 2],
      ['Hollow Knight', 1],
      ['Mother 3', 1],
      ['Ys', 1]
    ])
    calls.length = 0
    await svc.reindex()
    await until(() => calls.includes('extra:1'))
    expect(calls).toEqual(['main:1', 'main:2', 'extra:1'])
    svc.stop()
  })
})
