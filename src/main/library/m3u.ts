// Extended M3U (.m3u8, UTF-8) export. Downloaded tracks point at their local files
// (relative to the playlist when possible), everything else at its best stream URL.
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ID, TrackView } from '../../shared/types'
import type { ResolvedSource } from '../catalog'
import { sanitizeSegment } from '../downloads/naming'
import { writeFileAtomic } from '../settings/store'

export interface M3UEntry {
  durationMs: number | null
  title: string
  artist: string | null
  location: string | null
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

export function renderM3U(name: string, entries: M3UEntry[]): string {
  const lines = ['#EXTM3U', `#PLAYLIST:${oneLine(name)}`]
  for (const e of entries) {
    const secs = e.durationMs && e.durationMs > 0 ? Math.round(e.durationMs / 1000) : -1
    const label = e.artist ? `${oneLine(e.artist)} - ${oneLine(e.title)}` : oneLine(e.title)
    if (!e.location) {
      lines.push(`# unavailable: ${label}`)
      continue
    }
    lines.push(`#EXTINF:${secs},${label}`, e.location)
  }
  return lines.join('\n') + '\n'
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export interface ExportOptions {
  name: string
  tracks: TrackView[]
  dir: string
  localPath: (trackId: ID) => string | null
  resolve: (trackId: ID) => Promise<ResolvedSource | null>
}

/** Writes `<dir>/<name>.m3u8` and returns its path. */
export async function exportPlaylistM3U({ name, tracks, dir, localPath, resolve }: ExportOptions): Promise<string> {
  const file = join(dir, sanitizeSegment(name || 'Playlist') + '.m3u8')
  mkdirSync(dirname(file), { recursive: true })
  const entries = await mapLimit(tracks, 4, async (t): Promise<M3UEntry> => {
    let location: string | null = null
    const local = localPath(t.id)
    if (local) {
      const rel = relative(dirname(file), local)
      location = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : local
    } else {
      try {
        const src = await resolve(t.id)
        if (src) location = src.source.kind === 'http' ? src.source.url : src.source.path
      } catch {
        location = null
      }
    }
    return { durationMs: t.durationMs, title: t.title, artist: t.gameName ?? t.albumTitle ?? null, location }
  })
  writeFileAtomic(file, renderM3U(name, entries))
  return file
}
