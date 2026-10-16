// Synchronous analysis-frame reader for the renderer.
// The engine (main process) publishes frames into a memory-mapped file; the preload maps it
// through the same native addon (AnalysisReader only: no engine, no audio, no threads) and
// copies the latest consistent frame out on every read(). No IPC per frame.
// Main passes the addon path and region path as additionalArguments (see preloadArgsFor):
//   --ghost-native=<abs path to ghost.node>  --ghost-shm=<abs path to region file>
// read() never throws: it returns null whenever no fresh frame is available.
//
// readPacked() returns the same frame as ONE Float32Array (PACKED_FRAME layout): crossing the
// context bridge copies every typed array and object it's handed, so one flat array per frame
// is one copy instead of an object plus two arrays. The packing buffer here is reused.
import { createRequire } from 'node:module'
import type { AnalysisAPI } from '../shared/api'
import { packFrame } from '../shared/analysis-pack'
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

const none: AnalysisAPI = { read: () => null, readPacked: () => null }

/** Reused packing buffer (the bridge copies it out on every call anyway). */
let packBuf: Float32Array | undefined

/** Load the addon (the whole engine library, 13+ MB) on the first read, not before the page loads. */
function loadAddon(nativePath: string): ReaderAddon | null {
  try {
    // Runtime require of an absolute path: Vite leaves it alone and the .node is never bundled.
    const addon = createRequire(__filename)(nativePath) as ReaderAddon
    if (typeof addon.AnalysisReader !== 'function') throw new Error('AnalysisReader export missing')
    return addon
  } catch (e) {
    console.warn('[ghost] analysis frames unavailable: cannot load', nativePath, e)
    return null
  }
}

export function createAnalysisReader(): AnalysisAPI {
  const nativePath = argValue('ghost-native')
  const shmPath = argValue('ghost-shm')
  if (!nativePath || !shmPath) return none // NullEngine / web build: no frames

  let addon: ReaderAddon | null | undefined
  let reader: NativeReader | null = null
  let nextOpen = 0

  const read = (): AnalysisFrame | null => {
    if (addon === undefined) addon = loadAddon(nativePath)
    if (!addon) return null
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

  return {
    read,
    readPacked(): Float32Array | null {
      const f = read()
      return f ? (packBuf = packFrame(f, packBuf)) : null
    }
  }
}
