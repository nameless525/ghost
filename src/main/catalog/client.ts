// Main-process side of the catalog worker: a CatalogService whose methods are RPCs to the worker
// (./server.ts), plus the main-only services the worker calls back for (page fetches through
// Electron's network stack, the engine's archive lister, art accents). No Electron imports here;
// ./host.ts spawns the worker and plugs those in.
//
// Calls made before a worker is attached (startup) or while it restarts are queued. Methods that
// used to be synchronous are fire-and-forget (recordAnalysis, markSourceFailed, start, stop) or
// async (getAnalysis); a small LRU of analyses recorded or fetched here backs `peekAnalysis` so the
// player can read them synchronously.

import type { ID, Settings, TrackAnalysis } from '../../shared/types'
import type { ArchiveListing, EngineSource, OfflineAnalysisResult } from '../engine/types'
import type { Broadcast } from '../ipc'
import { deserializeError, RpcEndpoint, transfer, type CallContext, type PortLike, type SerializedError } from '../net/rpc'
import type { WireRequest, WireResponse } from '../net/rpc-fetch'
import type { CatalogService } from './index'

export interface CatalogClientOptions {
  broadcast: Broadcast
  /** Run a page request for the worker (main: Electron net.fetch). */
  fetch?: (req: WireRequest, signal: AbortSignal) => Promise<{ res: WireResponse; transfer: ArrayBuffer[] }>
  inspectArchive?: (source: EngineSource) => Promise<ArchiveListing>
  /** Accent colour of a cached cover. */
  accentOf?: (url: string) => Promise<string | null>
  /** The worker failed to build the catalog (DB unreadable, …). */
  onFatal?: (e: Error) => void
  onReady?: () => void
  log?: (msg: string) => void
  /** Analyses kept for peekAnalysis (default 48). */
  analysisCacheSize?: number
  /** Log calls slower than this (ms); 0 = never. */
  slowCallMs?: number
}

export interface CallStats {
  calls: number
  errors: number
  totalMs: number
  maxMs: number
}

const FIRE_AND_FORGET = new Set(['start', 'stop', 'recordAnalysis', 'markSourceFailed'])

/** The TrackAnalysis the catalog will store for an engine result (before its float32 rounding). */
export function analysisOf(r: OfflineAnalysisResult): TrackAnalysis {
  return {
    lufs: r.integratedLufs,
    truePeakDb: r.truePeakDb,
    bpm: r.bpm,
    beats: r.beats,
    downbeats: r.downbeats,
    kiai: r.kiai,
    energy: r.energy,
    intensity: r.intensity
  }
}

class Lru<K, V> {
  private m = new Map<K, V>()
  constructor(private max: number) {}
  has(k: K): boolean {
    return this.m.has(k)
  }
  get(k: K): V | undefined {
    if (!this.m.has(k)) return undefined
    const v = this.m.get(k)!
    this.m.delete(k)
    this.m.set(k, v)
    return v
  }
  set(k: K, v: V): void {
    this.m.delete(k)
    this.m.set(k, v)
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!)
  }
}

interface Queued {
  method: string
  args: unknown[]
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

export class CatalogClient {
  readonly catalog: CatalogService
  private ep: RpcEndpoint | null = null
  private queue: Queued[] = []
  private settings: Settings | null = null
  private started = false
  private ready = false
  private readonly analyses: Lru<ID, TrackAnalysis | null>
  private readonly stats = new Map<string, CallStats>()
  private readonly log: (m: string) => void

  constructor(private readonly opts: CatalogClientOptions) {
    this.log = opts.log ?? ((m) => console.log(`[catalog] ${m}`))
    this.analyses = new Lru(opts.analysisCacheSize ?? 48)
    this.catalog = this.makeProxy()
  }

  /** Connect a (new) worker. Queued calls are sent; settings and `start` are replayed. */
  attach(port: PortLike): void {
    this.ep?.close(new Error('The catalog worker was replaced.'))
    this.ready = false
    this.ep = new RpcEndpoint(port, this.handlers(), {
      broadcast: (event, payload) => {
        try {
          ;(this.opts.broadcast as (e: string, p: unknown) => void)(String(event), payload)
        } catch (e) {
          this.log(`broadcast failed: ${(e as Error).message}`)
        }
      },
      ready: () => {
        this.ready = true
        this.opts.onReady?.()
      },
      fatal: (e) => this.opts.onFatal?.(deserializeError(e as SerializedError))
    })
    if (this.settings) this.ep.notify('settings', this.settings)
    if (this.started) this.fire('start', [])
    const q = this.queue
    this.queue = []
    for (const c of q) this.send(c.method, c.args).then(c.resolve, c.reject)
  }

  /** The worker is gone: fail its in-flight calls (new calls queue until the next attach). */
  detach(reason: Error): void {
    this.ep?.close(reason)
    this.ep = null
    this.ready = false
  }

  /** Fail queued calls too (shutting down for good). */
  close(reason: Error): void {
    this.detach(reason)
    for (const c of this.queue) c.reject(reason)
    this.queue = []
  }

  get isReady(): boolean {
    return this.ready
  }

  setSettings(s: Settings): void {
    this.settings = s
    this.ep?.notify('settings', s)
  }

  /** Ask the worker to stop its background work and close its DB connection (shutdown). */
  shutdownWorker(): void {
    this.started = false
    this.ep?.notify('stop')
  }

  /** The art pipeline fetched a cover (optionally with its accent already computed). */
  artFetched(url: string, accent?: string | null): void {
    if (accent === undefined) this.ep?.notify('art', url)
    else this.ep?.notify('art', url, accent)
  }

  /** The worker's own stats: its event-loop delay and per-method run times (debugging). */
  workerStats(reset = false): Promise<unknown> {
    return this.send('__perf', [reset])
  }

  /** Per-method round-trip stats (debugging). */
  callStats(reset = false): Record<string, CallStats & { avgMs: number }> {
    const out: Record<string, CallStats & { avgMs: number }> = {}
    for (const [m, s] of this.stats) out[m] = { ...s, avgMs: s.calls ? Math.round((s.totalMs / s.calls) * 100) / 100 : 0 }
    if (reset) this.stats.clear()
    return out
  }

  // ---------------------------------------------------------------------------

  private handlers() {
    const o = this.opts
    return {
      fetch: async ([req]: unknown[], ctx: CallContext) => {
        if (!o.fetch) throw new Error('No network transport in this process.')
        const r = await o.fetch(req as WireRequest, ctx.signal)
        return transfer(r.res, r.transfer)
      },
      inspectArchive: async ([source]: unknown[]) => {
        if (!o.inspectArchive) throw new Error('The audio engine is unavailable, so chiptune rip sets can’t be opened.')
        return o.inspectArchive(source as EngineSource)
      },
      accent: async ([url]: unknown[]) => (o.accentOf ? o.accentOf(String(url)) : null)
    }
  }

  private send(method: string, args: unknown[]): Promise<unknown> {
    const ep = this.ep
    if (!ep) return new Promise((resolve, reject) => this.queue.push({ method, args, resolve, reject }))
    const t0 = performance.now()
    const p = ep.call(method, args)
    const record = (ok: boolean) => {
      const ms = performance.now() - t0
      let s = this.stats.get(method)
      if (!s) this.stats.set(method, (s = { calls: 0, errors: 0, totalMs: 0, maxMs: 0 }))
      s.calls++
      if (!ok) s.errors++
      s.totalMs += ms
      s.maxMs = Math.max(s.maxMs, Math.round(ms * 10) / 10)
      const slow = this.opts.slowCallMs ?? 0
      if (slow > 0 && ms > slow) this.log(`slow call ${method}: ${Math.round(ms)} ms`)
    }
    p.then(
      () => record(true),
      () => record(false)
    )
    return p
  }

  private fire(method: string, args: unknown[]): void {
    this.send(method, args).catch((e) => this.log(`${method} failed: ${(e as Error)?.message ?? e}`))
  }

  private makeProxy(): CatalogService {
    const call = (method: string) => (...args: unknown[]) => this.send(method, args)
    const known: Partial<CatalogService> = {
      // Not queued while detached: attach() (re)starts a worker's background work once.
      start: () => {
        this.started = true
        if (this.ep) this.fire('start', [])
      },
      stop: () => {
        this.started = false
        if (this.ep) this.fire('stop', [])
      },
      getAnalysis: async (trackId: ID) => {
        if (this.analyses.has(trackId)) return this.analyses.get(trackId)!
        const a = (await this.send('getAnalysis', [trackId])) as TrackAnalysis | null
        // A recordAnalysis may have landed while the request was in flight: keep the newer value.
        if (!this.analyses.has(trackId)) this.analyses.set(trackId, a)
        return this.analyses.get(trackId)!
      },
      peekAnalysis: (trackId: ID) => this.analyses.get(trackId),
      recordAnalysis: (trackId: ID, result: OfflineAnalysisResult) => {
        this.analyses.set(trackId, analysisOf(result))
        this.fire('recordAnalysis', [trackId, result])
      },
      markSourceFailed: (trackId: ID, cacheKey: string, reason: string) => this.fire('markSourceFailed', [trackId, cacheKey, reason])
    }
    // Everything else (including methods added to CatalogService later) is a plain RPC.
    return new Proxy(known, {
      get: (target, key) => {
        if (key in target) return target[key as keyof CatalogService]
        if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined
        if (FIRE_AND_FORGET.has(key)) return (...args: unknown[]) => this.fire(key, args)
        return call(key)
      }
    }) as CatalogService
  }
}
