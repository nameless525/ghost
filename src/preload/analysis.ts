// Synchronous analysis-frame reader for the renderer.
// The engine (main process) publishes frames into a memory-mapped file; the preload maps it
// through the same native addon (AnalysisReader only: no engine, no audio, no threads) and
// copies the latest consistent frame out on every read(). No IPC per frame.
// Main passes the addon path and region path as additionalArguments (see preloadArgsFor):
//   --ghost-native=<abs path to ghost.node>  --ghost-shm=<abs path to region file>
// read() never throws: it returns null whenever no fresh frame is available.
import { createRequire } from 'node:module'
import type { AnalysisAPI } from '../shared/api'
import type { AnalysisFrame } from '../shared/types'

interface NativeReader {
  read(): AnalysisFrame | null
  alive(): boolean
}

interface ReaderAddon {
  AnalysisReader: new (path: string) => NativeReader
}

/** Minimum delay between attempts to (re)open the region. */
const REOPEN_MS = 1000

function argValue(name: string): string | null {
  const prefix = `--${name}=`
  const arg = process.argv.find((a) => a.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : null
}

const none: AnalysisAPI = { read: () => null }

export function createAnalysisReader(): AnalysisAPI {
  const nativePath = argValue('ghost-native')
  const shmPath = argValue('ghost-shm')
  if (!nativePath || !shmPath) return none // NullEngine / web build: no frames

  let addon: ReaderAddon
  try {
    // Runtime require of an absolute path: Vite leaves it alone and the .node is never bundled.
    addon = createRequire(__filename)(nativePath) as ReaderAddon
    if (typeof addon.AnalysisReader !== 'function') throw new Error('AnalysisReader export missing')
  } catch (e) {
    console.warn('[ghost] analysis frames unavailable: cannot load', nativePath, e)
    return none
  }

  let reader: NativeReader | null = null
  let nextOpen = 0

  return {
    read(): AnalysisFrame | null {
      try {
        if (!reader) {
          const now = Date.now()
          if (now < nextOpen) return null
          nextOpen = now + REOPEN_MS
          reader = new addon.AnalysisReader(shmPath) // throws until the engine has created it
        }
        const frame = reader.read()
        if (frame) return frame
        // No frame: either nothing is playing (publisher alive) or the region was orphaned
        // (engine shut down or recreated at the same path) and must be reopened.
        if (!reader.alive()) reader = null
        return null
      } catch {
        reader = null
        return null
      }
    }
  }
}
