// The catalog worker's side of the RPC (see ./worker.ts, ./client.ts, ./host.ts). Opens its own
// connection to the shared SQLite file, builds the same CatalogService that can run in-process, with
// main-process-only dependencies injected as RPCs:
//   - page fetches (Electron net.fetch; KHInsider's Cloudflare refuses Node's fetch) → 'fetch'
//   - the engine's archive lister → 'inspectArchive'
//   - accents of cached art (the ghost-art protocol) → 'accent'
//   - catalog:status and other events → 'broadcast' (fire-and-forget)
// Settings and newly fetched art are pushed from main ('settings', 'art'); nothing here calls back
// synchronously. Plain JSON APIs (Internet Archive, IGDB, SteamGridDB) use the worker's own fetch
// and yt-dlp runs as a child process of the worker.

import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import type { Settings } from '../../shared/types'
import type { ArchiveListing, EngineSource } from '../engine/types'
import type { Broadcast } from '../ipc'
import { createHttpClient } from '../net/http'
import { RpcEndpoint, serializeError, type Handler, type PortLike } from '../net/rpc'
import { remoteFetch, type WireRequest, type WireResponse } from '../net/rpc-fetch'
import { setSharedYtDlp, YtDlp } from '../tools/ytdlp'
import type { CatalogService } from './index'
import { txStats } from './repo'
import { createCatalogService, type CatalogInternals } from './service'

export interface CatalogWorkerData {
  /** The app database (shared with the main process' library tables; WAL mode). */
  dbPath: string
  /** userData: the HTML cache (<dataDir>/cache/html) and yt-dlp (<dataDir>/bin) live here. */
  dataDir: string
  settings: Settings
}

export interface ServeOptions {
  /** Use this connection instead of opening dbPath (tests). */
  db?: DatabaseSync
  /** Extra service seams (tests): override the RPC-backed defaults. */
  internals?: CatalogInternals
  log?: (msg: string) => void
}

/** How long a bucket aggregation may lag the data (see QueryEngineOptions.bucketStaleMs). */
const BUCKET_STALE_MS = 15_000
const CHECKPOINT_MS = 5 * 60_000

/** Open the worker's connection: WAL, a busy timeout (main writes its library tables concurrently), a bigger page cache. */
export function openWorkerDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536;')
  return db
}

export interface CatalogServer {
  ready: Promise<CatalogService>
  close(): void
}

export function serveCatalog(port: PortLike, data: CatalogWorkerData, opts: ServeOptions = {}): CatalogServer {
  const log = opts.log ?? ((m: string) => console.log(`[catalog] ${m}`))
  let settings = data.settings
  let db: DatabaseSync | null = null
  let service: CatalogService | null = null
  let closed = false
  const artListeners = new Set<(url: string, bytes?: Buffer, accent?: string | null) => void>()

  let resolveReady!: (s: CatalogService) => void
  let rejectReady!: (e: unknown) => void
  const ready = new Promise<CatalogService>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })
  ready.catch(() => {})

  // Debug stats ('__perf'): this thread's event-loop delay and how long each method ran here.
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  const timings = new Map<string, { calls: number; totalMs: number; maxMs: number; over10: number }>()
  const perf = (reset: boolean) => {
    const ms = (ns: number) => Math.round(ns / 1e4) / 100
    const methods: Record<string, { calls: number; avgMs: number; maxMs: number; over10: number }> = {}
    for (const [m, t] of timings) methods[m] = { calls: t.calls, avgMs: Math.round((t.totalMs / t.calls) * 100) / 100, maxMs: Math.round(t.maxMs * 10) / 10, over10: t.over10 }
    const out = { loop: { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) }, methods, tx: { ...txStats } }
    if (reset) {
      loop.reset()
      timings.clear()
      Object.assign(txStats, { count: 0, totalMs: 0, maxMs: 0, over20: 0, over50: 0, slowest: '' })
    }
    return out
  }

  // Any CatalogService method, once the service exists (calls queue until then).
  const handlers = new Proxy({} as Record<string, Handler>, {
    get: (_t, method) => {
      if (typeof method !== 'string') return undefined
      if (method === '__perf') return async (args: unknown[]) => perf(!!args[0])
      return async (args: unknown[]) => {
        const s = await ready
        const fn = (s as unknown as Record<string, unknown>)[method]
        if (typeof fn !== 'function') throw new Error(`Unknown catalog method: ${method}`)
        const t0 = performance.now()
        try {
          return await (fn as (...a: unknown[]) => unknown).apply(s, args)
        } finally {
          // Wall time in the worker (includes awaited network for album pages / sources).
          const dt = performance.now() - t0
          let t = timings.get(method)
          if (!t) timings.set(method, (t = { calls: 0, totalMs: 0, maxMs: 0, over10: 0 }))
          t.calls++
          t.totalMs += dt
          t.maxMs = Math.max(t.maxMs, dt)
          if (dt > 10) t.over10++
        }
      }
    }
  })

  const ep = new RpcEndpoint(port, handlers, {
    settings: (s) => {
      settings = s as Settings
    },
    art: (url, accent) => {
      for (const fn of artListeners) fn(String(url), undefined, accent === undefined ? undefined : (accent as string | null))
    },
    stop: () => close()
  })

  let checkpointTimer: ReturnType<typeof setInterval> | null = null

  function close(): void {
    if (closed) return
    closed = true
    if (checkpointTimer) clearInterval(checkpointTimer)
    loop.disable()
    try {
      service?.stop()
    } catch (e) {
      log(`stop failed: ${(e as Error).message}`)
    }
    if (db && !opts.db) {
      try {
        db.close()
      } catch {
        /* already closed */
      }
    }
    ep.close(new Error('The catalog has shut down.'))
  }

  // Build after the listener is attached (calls arriving meanwhile wait on `ready`).
  setImmediate(() => {
    if (closed) return
    try {
      const t0 = performance.now()
      db = opts.db ?? openWorkerDb(data.dbPath)
      const http = createHttpClient({
        cacheDir: join(data.dataDir, 'ghost-cache', 'html'),
        fetch: remoteFetch((req: WireRequest, o) => ep.call<WireResponse>('fetch', [req], o)),
        log: (m) => console.log(`[http] ${m}`)
      })
      setSharedYtDlp(new YtDlp({ binDir: join(data.dataDir, 'bin'), log: (m) => console.log(`[yt-dlp] ${m}`) }))
      const broadcast = ((event: string, payload: unknown) => ep.notify('broadcast', event, payload)) as Broadcast
      service = createCatalogService(
        {
          db,
          broadcast,
          getSettings: () => settings,
          inspectArchive: (source: EngineSource) => ep.call<ArchiveListing>('inspectArchive', [source])
        },
        {
          http,
          accentOf: (url) => ep.call<string | null>('accent', [url]),
          onArtFetched: (fn) => {
            artListeners.add(fn)
            return () => artListeners.delete(fn)
          },
          // The main process trims the art cache (it owns it).
          trimArtCache: async () => {},
          bucketStaleMs: BUCKET_STALE_MS,
          log,
          ...opts.internals
        }
      )
      // Fold main's small library writes back into the database now and then (main never
      // checkpoints, so a busy WAL can't stall its thread).
      checkpointTimer = setInterval(() => {
        try {
          db?.exec('PRAGMA wal_checkpoint(PASSIVE)')
        } catch {
          /* busy: next time */
        }
      }, CHECKPOINT_MS)
      checkpointTimer.unref?.()
      log(`worker ready in ${Math.round(performance.now() - t0)} ms`)
      resolveReady(service)
      ep.notify('ready')
    } catch (e) {
      log(`failed to start: ${(e as Error)?.stack ?? e}`)
      rejectReady(e)
      ep.notify('fatal', serializeError(e))
    }
  })

  return { ready, close }
}
