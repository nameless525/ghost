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
  cache: () => dataDir('cache'),
  art: () => dataDir('art'),
  logs: () => dataDir('logs'),
  defaultDownloads: () => join(app.getPath('music'), 'GHOST')
}
