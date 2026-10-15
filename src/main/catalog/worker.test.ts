// The catalog worker's RPC (client.ts ↔ server.ts) over an in-process MessageChannel: the same code
// the worker thread runs, minus the thread. Page requests go worker → main through the fetch
// transport (net/rpc-fetch.ts) and are answered from fixtures.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { CatalogStatus, Settings } from '../../shared/types'
import type { OfflineAnalysisResult } from '../engine/types'
import { errorCode, isNetError, NetError } from '../net/errors'
import type { FetchLike } from '../net/http'
import { RpcEndpoint, transfer } from '../net/rpc'
import { remoteFetch, serveFetch, type WireRequest, type WireResponse } from '../net/rpc-fetch'
import { CatalogClient } from './client'
import { DatabaseSync } from 'node:sqlite'
import { tx } from '../db'
import { CatalogRepo } from './repo'
import { openWorkerDb, serveCatalog, type CatalogServer } from './server'
import { ProviderRegistry } from '../providers'
import type { Provider } from '../providers/types'
import type { ResolveStep, ToolProgress } from './progress'
import { hit, memoryDb, P, seedSmall } from './testing'

const fx = (name: string) => readFileSync(join(__dirname, '../providers/__fixtures__/khinsider', name), 'utf8')
const KH = 'https://downloads.khinsider.com'
const BIRD = 'a-bird-story-linux-macos-windows-gamerip-2014'

async function until(cond: () => boolean | Promise<boolean>, ms = 10_000) {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const analysis: OfflineAnalysisResult = {
  integratedLufs: -12.5,
  loudnessRange: 5,
  truePeakDb: -0.5,
  bpm: 140,
  bpmConfidence: 0.9,
  beats: [0.5, 1],
  downbeats: [0.5],
  kiai: [[30, 60]],
  energy: [0.1, 0.9],
  intensity: 5.5,
  durationMs: 200_000
}

describe('RPC endpoint', () => {
  it('round-trips values, rebuilds NetErrors with their code and prefix, and cancels', async () => {
    const { port1, port2 } = new MessageChannel()
    let cancelled = false
    new RpcEndpoint(port1, {
      add: ([a, b]) => (a as number) + (b as number),
      missing: () => {
        throw new NetError('not_found', 'no album 42', { status: 404, url: 'https://x/' })
      },
      plain: () => {
        throw new Error('[blocked] host says no')
      },
      bytes: () => {
        const b = new Uint8Array([1, 2, 3]).buffer
        return transfer({ b }, [b])
      },
      slow: (_a, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            cancelled = true
            resolve(null)
          })
        })
    })
    const caller = new RpcEndpoint(port2)
    expect(await caller.call('add', [2, 3])).toBe(5)
    const e = (await caller.call('missing').catch((x) => x)) as NetError
    expect(isNetError(e, 'not_found')).toBe(true)
    expect(e.message).toBe('[not_found] no album 42')
    expect(e.status).toBe(404)
    const p = await caller.call('plain').catch((x) => x)
    expect(errorCode(p)).toBe('blocked')
    const got = await caller.call<{ b: ArrayBuffer }>('bytes')
    expect([...new Uint8Array(got.b)]).toEqual([1, 2, 3])
    expect(await caller.call('nope').catch((x) => (x as Error).message)).toMatch(/Unknown method/)
    const ac = new AbortController()
    const slow = caller.call('slow', [], { signal: ac.signal })
    ac.abort()
    expect(await slow.catch((x) => (x as Error).name)).toBe('AbortError')
    await until(() => cancelled)
    port1.close()
    port2.close()
  })
})

describe('fetch transport', () => {
  it('runs requests on the other side and rebuilds the Response; aborts propagate', async () => {
    const { port1, port2 } = new MessageChannel()
    let aborted = false
    const mainFetch: FetchLike = async (url, init) => {
      if (url.endsWith('/hang')) {
        return await new Promise<Response>((_r, reject) =>
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        )
      }
      expect((init as RequestInit & { cache?: string }).cache).toBe('no-store')
      const h = new Headers(init?.headers)
      return new Response(`<p>${h.get('accept')}</p>`, { status: 201, headers: { 'content-type': 'text/html', 'x-test': '1' } })
    }
    new RpcEndpoint(port1, {
      fetch: async ([req], ctx) => {
        const r = await serveFetch(mainFetch, req as WireRequest, ctx.signal)
        return transfer(r.res, r.transfer)
      }
    })
    const worker = new RpcEndpoint(port2)
    const f = remoteFetch((req, o) => worker.call<WireResponse>('fetch', [req], o))
    const res = await f('https://example.test/page', { headers: { Accept: 'text/html' } })
    expect(res.status).toBe(201)
    expect(res.url).toBe('https://example.test/page')
    expect(res.headers.get('x-test')).toBe('1')
    expect(await res.text()).toBe('<p>text/html</p>')
    const ac = new AbortController()
    const hung = f('https://example.test/hang', { signal: ac.signal })
    setTimeout(() => ac.abort(), 20)
    expect(await hung.catch((e) => (e as Error).name)).toBe('AbortError')
    await until(() => aborted)
    port1.close()
    port2.close()
  })
})

describe('catalog worker (client ↔ server)', () => {
  const settings: Settings = defaultSettings('/tmp/ghost-dl')
  const statuses: CatalogStatus[] = []
  const requests: string[] = []
  const pages: Record<string, string | number> = {
    [`${KH}/game-soundtracks/browse/A`]: fx('browse-A.html'),
    [`${KH}/game-soundtracks/album/${BIRD}`]: fx('album-a-bird-story-gamerip.html'),
    [`${KH}/game-soundtracks/album/a-bloody-night-macos-windows-gamerip-2017`]: 404
  }
  const mainFetch: FetchLike = async (url) => {
    requests.push(url)
    const v = pages[url]
    if (v === undefined || typeof v === 'number') return new Response('gone', { status: typeof v === 'number' ? v : 404 })
    return new Response(v, { status: 200, headers: { 'content-type': 'text/html' } })
  }
  let dir: string
  let client: CatalogClient
  let server: CatalogServer
  let ch: MessageChannel

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghost-worker-test-'))
    ch = new MessageChannel()
    client = new CatalogClient({
      broadcast: ((event: string, payload: CatalogStatus) => {
        if (event === 'catalog:status') statuses.push(payload)
      }) as never,
      fetch: (req, signal) => serveFetch(mainFetch, req, signal),
      log: () => {}
    })
    // Calls made before a worker is attached are queued.
    client.catalog.start()
    server = serveCatalog(
      ch.port1,
      { dbPath: ':memory:', dataDir: dir, settings },
      {
        db: memoryDb(),
        log: () => {},
        internals: { startDelayMs: 0, crawlPageDelayMs: 0, crawlSections: ['letter:A'], crawlMaxPagesPerSection: 1, disableEnrichment: true, disableLocalScan: true, chip: false }
      }
    )
  })

  afterAll(() => {
    server.close()
    client.close(new Error('done'))
    ch.port1.close()
    ch.port2.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('queues calls until attached, then crawls through the main-side fetch', async () => {
    const early = client.catalog.status()
    client.attach(ch.port2)
    expect((await early).enrichment).toEqual({ igdb: false, steamGridDb: false })
    await until(async () => {
      const s = await client.catalog.status()
      return s.albums > 0 && !s.indexing
    })
    expect(requests).toContain(`${KH}/game-soundtracks/browse/A`)
    const st = await client.catalog.status()
    expect(st.games).toBeGreaterThan(0)
    await until(() => statuses.some((s) => s.albums === st.albums && !s.indexing))
    const page = await client.catalog.browse({ text: 'bird story', group: 'game', sort: 'title', offset: 0, limit: 10 })
    expect(page.groups.map((g) => g.title)).toContain('A Bird Story')
  })

  it('opens an album through the transport and propagates typed errors', async () => {
    const page = await client.catalog.browse({ text: 'bird story', group: 'album', sort: 'title', offset: 0, limit: 10 })
    const id = page.groups.find((g) => g.title.startsWith('A Bird Story'))!.key.slice('album:'.length)
    const d = await client.catalog.album(id)
    expect(d.tracks.length).toBeGreaterThan(10)
    expect(d.album.title).toMatch(/A Bird Story/)
    const missing = await client.catalog.album('99999999').catch((e) => e)
    expect(isNetError(missing, 'not_found')).toBe(true)
    expect(missing.message.startsWith('[not_found]')).toBe(true)
    const bloody = (await client.catalog.browse({ text: 'bloody night', group: 'album', sort: 'title', offset: 0, limit: 5 })).groups[0]
    if (bloody) {
      const e = await client.catalog.album(bloody.key.slice('album:'.length)).catch((x) => x)
      expect(errorCode(e)).toBe('not_found')
    }
  })

  it('getAnalysis is async; recordAnalysis is fire-and-forget and visible to peekAnalysis at once', async () => {
    const page = await client.catalog.browse({ text: 'bird story', group: 'album', sort: 'title', offset: 0, limit: 10 })
    const id = page.groups.find((g) => g.title.startsWith('A Bird Story'))!.key.slice('album:'.length)
    const t = (await client.catalog.album(id)).tracks[0]
    expect(client.catalog.peekAnalysis!(t.id)).toBeUndefined()
    expect(await client.catalog.getAnalysis(t.id)).toBeNull()
    expect(client.catalog.peekAnalysis!(t.id)).toBeNull()
    client.catalog.recordAnalysis(t.id, analysis)
    expect(client.catalog.peekAnalysis!(t.id)?.bpm).toBe(140)
    await until(async () => (await client.catalog.tracks([t.id]))[0].analysis?.bpm === 140)
    expect((await client.catalog.tracks([t.id]))[0].analysis).toEqual({ bpm: 140, intensity: 5.5, lufs: -12.5 })
    client.catalog.markSourceFailed(t.id, 'nope', 'test')
  })

  it('settings are pushed to the worker', async () => {
    expect((await client.catalog.status()).enrichment.steamGridDb).toBe(false)
    const next = structuredClone(settings)
    next.keys.steamGridDbKey = 'k'
    client.setSettings(next)
    await until(async () => (await client.catalog.status()).enrichment.steamGridDb)
  })

  it('a dead worker fails in-flight calls and later calls queue for the next one', async () => {
    const { port1, port2 } = new MessageChannel()
    const c = new CatalogClient({ broadcast: (() => {}) as never, log: () => {} })
    c.attach(port2)
    const pending = c.catalog.status() // no server on port1: never answered
    c.detach(new Error('worker exited'))
    expect(await pending.catch((e) => (e as Error).message)).toBe('worker exited')
    const queued = c.catalog.status()
    const s = serveCatalog(port1, { dbPath: ':memory:', dataDir: dir, settings }, { db: memoryDb(), log: () => {}, internals: { disableEnrichment: true, disableLocalScan: true, chip: false } })
    const { port1: a, port2: b } = new MessageChannel()
    // Re-attach to a fresh channel served by a new server.
    const s2 = serveCatalog(a, { dbPath: ':memory:', dataDir: dir, settings }, { db: memoryDb(), log: () => {}, internals: { disableEnrichment: true, disableLocalScan: true, chip: false } })
    c.attach(b)
    expect((await queued).albums).toBe(0)
    s.close()
    s2.close()
    c.close(new Error('done'))
    for (const p of [port1, port2, a, b]) p.close()
  })
})

describe('progress for the player crosses the worker boundary', () => {
  it('resolve steps and the yt-dlp install reach main; an archive listing carries its progress key', async () => {
    const steps: ResolveStep[] = []
    const tools: ToolProgress[] = []
    const inspected: unknown[][] = []
    const c = new CatalogClient({
      broadcast: (() => {}) as never,
      log: () => {},
      onResolveStep: (s) => steps.push(s)
    })
    // The worker's side, served for real: a play resolving through a page request.
    const db = memoryDb()
    seedSmall(new CatalogRepo(db))
    const kh: Provider = {
      id: 'khinsider',
      name: 'KHInsider',
      async resolveStream(locator) {
        return [{ provider: 'khinsider', source: { kind: 'http', url: `https://kh.example/${locator}`, cacheKey: `kh:${locator}` }, format: 'mp3', lossless: false, bitrateKbps: 320, sizeBytes: null, expiresAt: null }]
      }
    }
    const { port1, port2 } = new MessageChannel()
    const settings = defaultSettings('/tmp/ghost-dl')
    const dir = mkdtempSync(join(tmpdir(), 'ghost-worker-progress-'))
    const s = serveCatalog(port1, { dbPath: ':memory:', dataDir: dir, settings }, { db, log: () => {}, internals: { registry: new ProviderRegistry().register(kh), disableEnrichment: true, disableLocalScan: true, chip: false } })
    c.attach(port2)
    const track = db.prepare(`SELECT id FROM tracks WHERE title = 'Dirtmouth'`).get() as { id: number }
    await c.catalog.resolveSources(String(track.id))
    await until(() => steps.length === 1)
    expect(steps[0]).toEqual({ trackId: String(track.id), provider: 'khinsider', providerName: 'KHInsider', kind: 'stream', fraction: null, detail: null })
    s.close()
    c.close(new Error('done'))
    port1.close()
    port2.close()
    rmSync(dir, { recursive: true, force: true })

    // The notes and the archive call as the worker sends them.
    const { port1: w, port2: m } = new MessageChannel()
    const c2 = new CatalogClient({ broadcast: (() => {}) as never, log: () => {}, onToolProgress: (p) => tools.push(p), inspectArchive: async (...args) => (inspected.push(args), { entries: [] }) as never })
    c2.attach(m)
    const worker = new RpcEndpoint(w)
    worker.notify('toolProgress', { tool: 'yt-dlp', fraction: 0.5, detail: 'One-time download · 17.0 of 34.0 MB', done: false })
    const source = { kind: 'http', url: 'https://vgmrips.net/files/x.zip', cacheKey: 'chip:x' }
    await worker.call('inspectArchive', [source, { progressKey: 'album:3' }])
    await worker.call('inspectArchive', [source])
    await until(() => tools.length === 1)
    expect(tools[0]).toMatchObject({ tool: 'yt-dlp', fraction: 0.5 })
    expect(inspected).toEqual([[source, { progressKey: 'album:3' }], [source]])
    c2.close(new Error('done'))
    w.close()
    m.close()
  })
})

describe('two connections on one file (worker + main)', () => {
  it('worker transactions take the write lock up front; main writes wait instead of failing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghost-2conn-'))
    try {
      const file = join(dir, 'ghost.db')
      const worker = openWorkerDb(file)
      const repo = new CatalogRepo(worker)
      const main = new DatabaseSync(file)
      main.exec('PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS likes (track_id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
      // A read-then-write catalog transaction while main commits in between: with a deferred BEGIN
      // the upgrade would fail with SQLITE_BUSY (no busy wait). IMMEDIATE holds the lock: main is
      // the one that has to wait (here: fails at once, busy_timeout 0).
      repo.tx(() => {
        repo.get(`SELECT COUNT(*) FROM albums`)
        expect(() => main.prepare(`INSERT INTO likes VALUES ('1', 1)`).run()).toThrow(/locked|busy/i)
        repo.upsertHits([hit('x', 'X OST', 'ost', 2000, [P.snes])], { initial: true })
      })
      // And the other way round: main's transaction helper is IMMEDIATE too.
      tx(main, () => {
        main.prepare(`INSERT INTO likes VALUES ('2', 1)`).run()
      })
      // Cross-connection reads: the catalog sees main's library tables.
      expect(repo.get<{ n: number }>(`SELECT COUNT(*) AS n FROM likes`)!.n).toBe(1)
      expect(repo.counts().albums).toBe(1)
      main.close()
      worker.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
