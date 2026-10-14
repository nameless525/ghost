// Entry of the catalog worker thread (built to out/main/catalogWorker.js, spawned by ./host.ts).
// The whole catalog (SQLite, crawling, HTML parsing, enrichment, local-file scans) runs here so the
// main thread, which also delivers native window input on macOS, never waits on it.
import { writeFileSync } from 'node:fs'
import { Session } from 'node:inspector'
import { parentPort, workerData } from 'node:worker_threads'
import { serveCatalog, type CatalogWorkerData } from './server'

if (!parentPort) throw new Error('The catalog worker must run in a worker thread.')

// Background work is fire-and-forget in places; never let one stray rejection kill the catalog.
process.on('unhandledRejection', (e) => console.error('[catalog] unhandled rejection in the worker:', e))

// Debug: GHOST_CATALOG_PROFILE=<file.cpuprofile>[:seconds] profiles this thread from its start.
const prof = process.env.GHOST_CATALOG_PROFILE
if (prof) {
  const [file, secs] = prof.split(':')
  const s = new Session()
  s.connect()
  s.post('Profiler.enable', () =>
    s.post('Profiler.setSamplingInterval', { interval: 250 }, () =>
      s.post('Profiler.start', () => {
        setTimeout(() => s.post('Profiler.stop', (_e, r) => writeFileSync(file, JSON.stringify((r as { profile: unknown }).profile))), Number(secs || 20) * 1000).unref()
      })
    )
  )
}

serveCatalog(parentPort, workerData as CatalogWorkerData)
