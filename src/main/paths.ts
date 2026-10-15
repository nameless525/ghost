import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/** All app data lives under userData (e.g. ~/Library/Application Support/GHOST). */
export function dataDir(...parts: string[]): string {
  const dir = join(app.getPath('userData'), ...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const paths = {
  db: () => join(dataDir(), 'ghost.db'),
  // Not "cache": on case-insensitive macOS volumes that is the same folder as Chromium's own
  // `Cache/`, and the two caches' housekeeping must never touch each other's files.
  cache: () => dataDir('ghost-cache', 'audio'),
  htmlCache: () => dataDir('ghost-cache', 'html'),
  art: () => dataDir('art'),
  logs: () => dataDir('logs'),
  defaultDownloads: () => join(app.getPath('music'), 'GHOST')
}

/**
 * Persist V8's compiled code for the modules Node loads in the catalog worker (its bundle plus
 * cheerio & co.) and the renderer's preload, so later launches skip compiling them: the catalog
 * worker answers its first calls ~40 % sooner. Node reads NODE_COMPILE_CACHE when a thread or
 * process starts, so this must run before the worker and the window are created. Entries are
 * keyed by the file's content (stale code is never used); `GHOST_NO_COMPILE_CACHE=1` turns it off.
 */
export function enableWorkerCompileCache(): void {
  if (process.env.NODE_COMPILE_CACHE || process.env.GHOST_NO_COMPILE_CACHE) return
  process.env.NODE_COMPILE_CACHE = join(app.getPath('userData'), 'ghost-cache', 'v8')
}

/**
 * One-time cleanup of the pre-0.2 cache location (`<userData>/cache`, shared with Chromium's
 * `Cache/` on macOS): removes only GHOST's own files — engine `<hash>.data/.meta` entries and the
 * `html/` page cache — and leaves Chromium's `Cache_Data/` alone. Runs in the background.
 */
export async function migrateLegacyCache(): Promise<void> {
  const { readdir, rm, unlink } = await import('node:fs/promises')
  const legacy = join(app.getPath('userData'), 'cache')
  let names: string[]
  try {
    names = await readdir(legacy)
  } catch {
    return
  }
  for (const n of names) {
    if (/^[0-9a-f]{12,64}\.(data|meta)$/i.test(n)) await unlink(join(legacy, n)).catch(() => {})
    else if (n === 'html') await rm(join(legacy, n), { recursive: true, force: true }).catch(() => {})
  }
}
