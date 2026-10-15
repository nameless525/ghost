// Progress the catalog reports while someone waits: resolve steps for the player (only for network
// requests a play is blocked on), album track lists, imports and local folder scans ('progress').
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { ExternalAlbumHit, GhostNotification, Settings, TaskProgress } from '../../shared/types'
import { NetError } from '../net/errors'
import { ProviderRegistry } from '../providers'
import { LocalLibrary, LocalProvider } from '../providers/local'
import type { CanonicalTrack, Provider, ProviderAlbum, ProviderCallOptions, SourceCandidate, StreamInfo } from '../providers/types'
import type { CatalogService } from './index'
import type { ResolveStep } from './progress'
import { CatalogRepo } from './repo'
import { createCatalogService } from './service'
import { detail, hit, memoryDb, P, seedSmall } from './testing'

const MB = 1048576
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await sleep(5)
  }
}

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const stream = (provider: string, locator: string): StreamInfo => ({
  provider,
  source: { kind: 'http', url: `https://${provider}.example/${encodeURIComponent(locator)}`, cacheKey: `${provider}:${locator}` },
  format: 'mp3',
  lossless: false,
  bitrateKbps: 320,
  sizeBytes: null,
  expiresAt: null
})

/** KHInsider stand-in: a page request per resolve (optionally held), its album pages from `albums`. */
function fakeKh() {
  const p = {
    id: 'khinsider',
    name: 'KHInsider',
    prefetchStreams: true,
    fail: false,
    calls: 0,
    gate: null as Promise<void> | null,
    albums: new Map<string, ProviderAlbum | Error>(),
    onGetAlbum: null as ((ref: string, opts: ProviderCallOptions) => void) | null,
    async resolveStream(locator: string): Promise<StreamInfo[]> {
      p.calls++
      if (p.gate) await p.gate
      if (p.fail) throw new NetError('http', 'HTTP 500 from downloads.khinsider.com')
      return [stream('khinsider', locator)]
    },
    async getAlbum(ref: string, opts: ProviderCallOptions = {}): Promise<ProviderAlbum> {
      p.onGetAlbum?.(ref, opts)
      const a = p.albums.get(ref)
      if (!a) throw new NetError('not_found', `no album ${ref}`)
      if (a instanceof Error) throw a
      return a
    }
  }
  return p satisfies Provider
}

/** SoundCloud stand-in: a fallback search whose resolve downloads the track (5 MB, reported as it goes). */
function fakeSoundCloud() {
  const p = {
    id: 'soundcloud',
    name: 'SoundCloud',
    findTrackMode: 'fallback' as const,
    searches: 0,
    albums: new Map<string, ProviderAlbum | Error>(),
    async findTrack(t: CanonicalTrack): Promise<SourceCandidate[]> {
      p.searches++
      return [{ provider: 'soundcloud', locator: '42', title: t.title, durationMs: t.durationMs, confidence: 0.8 }]
    },
    async resolveStream(locator: string, opts: ProviderCallOptions = {}): Promise<StreamInfo[]> {
      opts.onBytes?.(1 * MB, 5 * MB)
      await sleep(300)
      opts.onBytes?.(5 * MB, 5 * MB)
      await sleep(300)
      return [{ ...stream('soundcloud', locator), source: { kind: 'file', path: `/cache/sc-${locator}.m4a` }, format: 'm4a' }]
    },
    async getAlbum(ref: string): Promise<ProviderAlbum> {
      const a = p.albums.get(ref)
      if (!a) throw new NetError('not_found', `no set ${ref}`)
      if (a instanceof Error) throw a
      return a
    }
  }
  return p satisfies Provider
}

function setup() {
  const clock = { now: Date.now() }
  const now = () => clock.now
  const settings: Settings = defaultSettings('/tmp/ghost-dl')
  const db = memoryDb()
  const repo = new CatalogRepo(db)
  const { albums } = seedSmall(repo)
  const kh = fakeKh()
  const sc = fakeSoundCloud()
  const steps: ResolveStep[] = []
  const events: [string, unknown][] = []
  const svc = createCatalogService(
    { db, broadcast: ((e: string, p: unknown) => events.push([e, p])) as never, getSettings: () => settings, onResolveStep: (s) => steps.push(s) },
    { registry: new ProviderRegistry().register(kh).register(sc), disableEnrichment: true, disableLocalScan: true, now, log: () => {} }
  )
  const progress = (key?: string) => events.filter(([e, p]) => e === 'progress' && (!key || (p as TaskProgress).key === key)).map(([, p]) => p as TaskProgress)
  return { svc, kh, sc, steps, events, progress, albums, repo, db, settings, clock }
}

async function trackOf(svc: CatalogService, albumId: number, title: string) {
  return (await svc.album(String(albumId))).tracks.find((t) => t.title === title)!
}

describe('resolve steps (what a waiting play is blocked on)', () => {
  it('a page request is a step; a cached source, a prefetch and a background refresh are not', async () => {
    const { svc, kh, steps, albums, db } = setup()
    const dirtmouth = await trackOf(svc, albums['hollow-knight-ost'], 'Dirtmouth')
    const hornet = await trackOf(svc, albums['hollow-knight-ost'], 'Hornet')

    await svc.resolveSources(dirtmouth.id)
    expect(steps).toEqual([{ trackId: dirtmouth.id, provider: 'khinsider', providerName: 'KHInsider', kind: 'stream', fraction: null, detail: null }])
    await svc.resolveSources(dirtmouth.id) // cached, current
    expect(steps).toHaveLength(1)

    // Warming a likely next track asks the page in the background: no step.
    svc.warmSources([hornet.id])
    await until(() => kh.calls === 2)
    await sleep(10)
    expect(steps).toHaveLength(1)

    // A stale fallback copy behind a healthy source refreshes in the background: no step for it.
    db.prepare(
      `INSERT INTO sources (track_id, provider, locator, cache_key, path, format, confidence, verified_at, needs_refresh)
       VALUES (?, 'soundcloud', '42', 'file:/cache/sc-42.m4a', '/cache/sc-42.m4a', 'm4a', 0.8, ?, 1)`
    ).run(Number(dirtmouth.id), Date.now())
    const list = await svc.resolveSources(dirtmouth.id)
    expect(list.map((s) => s.provider)).toEqual(['khinsider', 'soundcloud'])
    await until(() => (db.prepare(`SELECT needs_refresh AS n FROM sources WHERE provider = 'soundcloud'`).get() as { n: number }).n === 0)
    expect(steps).toHaveLength(1)
  })

  it('a play joining a prefetch in flight follows its step', async () => {
    const { svc, kh, steps, albums } = setup()
    const hornet = await trackOf(svc, albums['hollow-knight-ost'], 'Hornet')
    let release!: () => void
    kh.gate = new Promise<void>((r) => (release = r))
    svc.warmSources([hornet.id])
    await until(() => kh.calls === 1)
    expect(steps).toEqual([])
    const play = svc.resolveSources(hornet.id)
    await until(() => steps.length === 1)
    expect(steps[0]).toMatchObject({ trackId: hornet.id, provider: 'khinsider', kind: 'stream' })
    release()
    expect((await play).map((s) => s.provider)).toEqual(['khinsider'])
    expect(kh.calls).toBe(1)
  })

  it('a fallback: the failed page, the search, then the download measuring itself', async () => {
    const { svc, kh, sc, steps, albums } = setup()
    const dirtmouth = await trackOf(svc, albums['hollow-knight-ost'], 'Dirtmouth')
    const [ok] = await svc.resolveSources(dirtmouth.id)
    steps.length = 0
    kh.fail = true
    svc.markSourceFailed(dirtmouth.id, (ok.source as { cacheKey: string }).cacheKey, 'HTTP 404')
    const list = await svc.resolveSources(dirtmouth.id)
    expect(list[0].provider).toBe('soundcloud')
    expect(sc.searches).toBe(1)
    expect(steps.map((s) => `${s.provider}:${s.kind}:${s.detail ?? ''}`)).toEqual([
      'khinsider:stream:',
      'soundcloud:search:',
      'soundcloud:stream:',
      'soundcloud:stream:1.0 of 5.0 MB',
      'soundcloud:stream:5.0 of 5.0 MB'
    ])
    expect(steps.at(-2)!.fraction).toBeCloseTo(0.2)
    expect(steps.at(-1)).toMatchObject({ providerName: 'SoundCloud', fraction: 1 })
  })
})

describe('task progress', () => {
  it('opening an album without its track list: a step with the source’s typical time, then done; learned per source', async () => {
    const { svc, kh, progress, albums, clock } = setup()
    const id = albums['chrono-cross-ost']
    kh.albums.set('chrono-cross-ost', detail(hit('chrono-cross-ost', 'Chrono Cross Original Soundtrack', 'ost', 1999, [P.ps1]), [{ title: 'Scars of Time', ms: 200_000 }]))
    let opts: ProviderCallOptions | null = null
    kh.onGetAlbum = (_ref, o) => {
      opts = o
      clock.now += 2900 // a slow page
    }
    const d = await svc.album(String(id))
    expect(d.tracks).toHaveLength(1)
    expect(opts).toMatchObject({ priority: 0, progressKey: `album:${id}` })
    const p = progress(`album:${id}`)
    expect(p).toHaveLength(2)
    expect(p[0]).toMatchObject({ label: 'Loading tracks from KHInsider', fraction: null, expectMs: 900 })
    expect(p[1]).toMatchObject({ done: true })
    // Cached now: no bar.
    await svc.album(String(id))
    expect(progress(`album:${id}`)).toHaveLength(2)
    // The next KHInsider album expects what this one took (weighted).
    const ff7 = albums['ff7-ost']
    kh.albums.set('ff7-ost', detail(hit('ff7-ost', 'Final Fantasy VII Original Soundtrack', 'ost', 1997, [P.ps1]), [{ title: 'Prelude', ms: 100_000 }]))
    await svc.album(String(ff7))
    expect(progress(`album:${ff7}`)[0].expectMs).toBe(1500)
  })

  it('a failed album page still ends its bar', async () => {
    const { svc, kh, progress, albums } = setup()
    const id = albums['ys-ost']
    kh.albums.set('ys-ost', new NetError('http', 'HTTP 503 from downloads.khinsider.com'))
    await expect(svc.album(String(id))).rejects.toThrow(/503/)
    const p = progress(`album:${id}`)
    expect(p.map((x) => !!x.done)).toEqual([false, true])
  })

  it('a chiptune set’s first step leaves room for its download (main reports it under the same key)', async () => {
    const db = memoryDb()
    const repo = new CatalogRepo(db)
    const [id] = repo.upsertHits([hit('vgmrips.net/packs/pack/sonic', 'Sonic the Hedgehog', 'gamerip', 1991, [P.genesis], { provider: 'chip' })], { initial: false })
    let key: string | undefined
    const chip: Provider = {
      id: 'chip',
      name: 'Chiptune rips',
      async resolveStream() {
        return []
      },
      async getAlbum(ref, o) {
        key = o?.progressKey
        return detail(hit(ref, 'Sonic the Hedgehog', 'gamerip', 1991, [P.genesis], { provider: 'chip' }), [{ title: 'Green Hill Zone', ms: 120_000 }])
      }
    }
    const events: TaskProgress[] = []
    const svc = createCatalogService(
      { db, broadcast: ((e: string, p: unknown) => e === 'progress' && events.push(p as TaskProgress)) as never, getSettings: () => defaultSettings('/tmp/ghost-dl') },
      { registry: new ProviderRegistry().register(chip), disableEnrichment: true, disableLocalScan: true, log: () => {} }
    )
    await svc.album(String(id))
    expect(key).toBe(`album:${id}`)
    expect(events[0]).toMatchObject({ key: `album:${id}`, label: 'Opening the chiptune set', span: [0, 0.1] })
    expect(events.at(-1)).toMatchObject({ done: true })
  })

  it('an import: a step sized by the source and its track count, done also on failure', async () => {
    const { svc, sc, progress } = setup()
    const set: ExternalAlbumHit = { provider: 'soundcloud', ref: 'someone/sets/hollow-knight', title: 'Hollow Knight OST', subtitle: null, cover: null, trackCount: 12, totalMs: null, url: 'https://soundcloud.com/someone/sets/hollow-knight', score: 0.9 }
    sc.albums.set(set.ref, detail(hit(set.ref, 'Hollow Knight OST', 'ost', null, [], { provider: 'soundcloud' }), [{ title: 'Dirtmouth', ms: 120_000 }]))
    await svc.importExternal(set)
    const key = 'import:soundcloud:someone/sets/hollow-knight'
    expect(progress(key)).toEqual([
      expect.objectContaining({ key, label: 'Importing from SoundCloud', fraction: null, expectMs: 3000 + 12 * 1000 }),
      expect.objectContaining({ key, done: true })
    ])
    const broken = { ...set, ref: 'someone/sets/gone' }
    await expect(svc.importExternal(broken)).rejects.toThrow(/no set/)
    expect(progress('import:soundcloud:someone/sets/gone').map((p) => !!p.done)).toEqual([false, true])
  })
})

describe('local folder scans', () => {
  it('a folder the user added: looking for files, reading tags, done, and one notice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ghost-scan-'))
    dirs.push(root)
    const folder = join(root, 'OST Collection')
    mkdirSync(join(folder, 'Hollow Knight'), { recursive: true })
    for (const n of ['01 Enter Hallownest.mp3', '02 Dirtmouth.mp3', '03 Crossroads.flac']) writeFileSync(join(folder, 'Hollow Knight', n), 'x')
    const db = memoryDb()
    const settings: Settings = defaultSettings('/tmp/ghost-dl')
    const lib = new LocalLibrary(db, { readTags: async (p) => ({ title: basename(p) }) })
    const events: [string, unknown][] = []
    const hook: { fn: (() => void) | null } = { fn: null }
    const svc = createCatalogService(
      {
        db,
        broadcast: ((e: string, p: unknown) => events.push([e, p])) as never,
        getSettings: () => settings,
        onSettingsChanged: (fn) => {
          hook.fn = fn
          return () => (hook.fn = null)
        }
      },
      { registry: new ProviderRegistry().register(new LocalProvider(lib)), disableEnrichment: true, startDelayMs: 0, chip: false, log: () => {} }
    )
    svc.start()
    try {
      await sleep(600) // the launch check (no folders: nothing to scan)
      expect(hook.fn).not.toBeNull()
      settings.sources.localFolders = [folder]
      hook.fn!()
      await until(() => events.some(([e]) => e === 'notify'))
      const scan = events.filter(([e, p]) => e === 'progress' && (p as TaskProgress).key === 'scan').map(([, p]) => p as TaskProgress)
      expect(scan[0]).toMatchObject({ label: 'Looking for music files', fraction: null, expectMs: null, span: [0, 0.15] })
      const tags = scan.filter((p) => p.label === 'Reading tags' && !p.done)
      expect(tags[0]).toMatchObject({ detail: '0 of 3 files', fraction: 0, span: [0.15, 1] })
      expect(scan.at(-1)).toMatchObject({ done: true })
      expect(scan.filter((p) => p.done)).toHaveLength(1)
      const notice = events.find(([e]) => e === 'notify')![1] as GhostNotification
      expect(notice).toMatchObject({ id: 'local-scan', kind: 'success', title: 'Added 3 tracks from OST Collection' })
      expect(lib.count()).toBe(3)
      // The same list again: nothing to do.
      const n = events.length
      hook.fn!()
      await sleep(50)
      expect(events.length).toBe(n)
    } finally {
      svc.stop()
    }
    expect(hook.fn).toBeNull()
  })
})
