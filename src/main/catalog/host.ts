// Spawns the catalog worker (out/main/catalogWorker.js, built from ./worker.ts) and connects it to
// the main-process services it needs: Electron's network stack for page requests, the engine's
// archive lister, and the ghost-art protocol (accents, newly fetched covers, cache trimming).
// Main-process only. The worker is restarted if it dies; calls queue meanwhile.

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MessageChannel, Worker } from 'node:worker_threads'
import type { Settings } from '../../shared/types'
import type { ArchiveListing, EngineSource } from '../engine/types'
import type { Broadcast } from '../ipc'
import { artAccent, onArtAccent, trimArtCache } from '../net/art-protocol'
import { electronFetch } from '../net/http'
import { serveFetch } from '../net/rpc-fetch'
import { CatalogClient, type CallStats } from './client'
import type { CatalogService } from './index'
import type { CatalogWorkerData } from './server'

export interface CatalogHostOptions {
  dbPath: string
  /** userData (HTML cache, yt-dlp). */
  dataDir: string
  settings: Settings
  broadcast: Broadcast
  inspectArchive?: (source: EngineSource) => Promise<ArchiveListing>
  /** The catalog can't run (the worker failed to start or keeps crashing). */
  onFatal?: (e: Error) => void
}

export interface CatalogHost {
  catalog: CatalogService
  /** Start the worker. Calls made before this are queued. */
  spawn(): void
  setSettings(s: Settings): void
  callStats(reset?: boolean): Record<string, CallStats & { avgMs: number }>
  dispose(): void
}

const MAX_RESTARTS = 3
const WORKER_FILE = 'catalogWorker.js'

function workerPath(): string | null {
  // Next to the main bundle (out/main/); app.getAppPath() covers code that landed in a chunk elsewhere.
  const here = dirname(fileURLToPath(import.meta.url))
  for (const p of [join(here, WORKER_FILE), join(app.getAppPath(), 'out', 'main', WORKER_FILE)]) if (existsSync(p)) return p
  return null
}

export function createCatalogHost(opts: CatalogHostOptions): CatalogHost {
  let settings = opts.settings
  let worker: Worker | null = null
  let disposed = false
  let restarts = 0
  let fatal = false

  const client = new CatalogClient({
    broadcast: opts.broadcast,
    fetch: (req, signal) => serveFetch(electronFetch, req, signal),
    inspectArchive: opts.inspectArchive,
    accentOf: (url) => artAccent(url),
    onFatal: (e) => {
      fatal = true
      opts.onFatal?.(e)
    },
    onReady: () => {
      restarts = 0
    },
    slowCallMs: process.env.GHOST_PERF_LOG ? 100 : 0
  })

  const spawn = () => {
    if (disposed || worker) return
    const data: CatalogWorkerData = { dbPath: opts.dbPath, dataDir: opts.dataDir, settings }
    const file = process.env.GHOST_CATALOG_INPROCESS ? null : workerPath()
    if (!file) {
      // No worker bundle (a script bundled into one file) or forced: serve the catalog on this
      // thread over an in-process channel. Same code path, but its work blocks the main thread.
      // Loaded lazily: the catalog code (cheerio & co.) otherwise stays out of the main process.
      console.warn('[catalog] running in-process (no worker bundle): expect main-thread stalls')
      const { port1, port2 } = new MessageChannel()
      client.attach(port2)
      port1.unref()
      port2.unref()
      void import('./server').then((m) => m.serveCatalog(port1, data))
      return
    }
    let w: Worker
    try {
      // Not the main process' --inspect/--inspect-brk: the worker would wait for a debugger.
      const execArgv = process.execArgv.filter((a) => !a.startsWith('--inspect'))
      w = new Worker(file, { workerData: data, name: 'ghost-catalog', execArgv })
    } catch (e) {
      console.error('[catalog] could not start the worker:', e)
      client.close(e as Error)
      opts.onFatal?.(e as Error)
      return
    }
    worker = w
    client.attach(w)
    w.on('error', (e) => console.error('[catalog] worker error:', e))
    w.on('exit', (code) => {
      if (worker === w) worker = null
      const reason = new Error(`The catalog stopped unexpectedly (worker exit ${code}).`)
      if (disposed) return client.close(reason)
      client.detach(reason)
      if (fatal) return
      if (restarts++ < MAX_RESTARTS) {
        console.error(`[catalog] worker exited (${code}); restarting`)
        setTimeout(spawn, 300 * restarts).unref()
      } else {
        client.close(reason)
        opts.onFatal?.(reason)
      }
    })
  }

  // Covers fetched by the ghost-art protocol come with their accent (computed off-thread by the art
  // pipeline): forwarded as plain data, the worker fills in game accents without a round-trip.
  const offArt = onArtAccent((url, hex) => client.artFetched(url, hex))
  const trimTimer = setTimeout(() => void trimArtCache().catch(() => {}), 60_000)
  trimTimer.unref()

  // Debug hook for the main-process inspector (`--inspect`): round-trip stats per method.
  ;(globalThis as { __ghostCatalog?: unknown }).__ghostCatalog = {
    stats: (reset?: boolean) => client.callStats(reset),
    worker: (reset?: boolean) => client.workerStats(reset),
    ready: () => client.isReady
  }

  return {
    catalog: client.catalog,
    spawn,
    setSettings: (s) => {
      settings = s
      client.setSettings(s)
    },
    callStats: (reset) => client.callStats(reset),
    dispose: () => {
      if (disposed) return
      disposed = true
      offArt()
      clearTimeout(trimTimer)
      const w = worker
      if (!w) return client.close(new Error('The catalog has shut down.'))
      // Let the worker stop its background work and close the DB, then make sure it's gone.
      client.shutdownWorker()
      setTimeout(() => void w.terminate(), 1500).unref()
    }
  }
}
