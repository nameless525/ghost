// Extended M3U (.m3u8, UTF-8) export. Downloaded tracks point at their local files
// (relative to the playlist when possible), everything else at its best stream URL that other
// players can open as-is.
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ID, TrackView } from '../../shared/types'
import type { ResolvedSource } from '../catalog'
import type { EngineSource } from '../engine/types'
import { sanitizeSegment } from '../downloads/naming'
import { writeFileAtomic } from '../settings/store'

export interface M3UEntry {
  durationMs: number | null
  title: string
  artist: string | null
  location: string | null
  /** Why there is no location (a comment line in the file); default "unavailable". */
  missing?: string
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

export function renderM3U(name: string, entries: M3UEntry[]): string {
  const lines = ['#EXTM3U', `#PLAYLIST:${oneLine(name)}`]
  for (const e of entries) {
    const secs = e.durationMs && e.durationMs > 0 ? Math.round(e.durationMs / 1000) : -1
    const label = e.artist ? `${oneLine(e.artist)} - ${oneLine(e.title)}` : oneLine(e.title)
    if (!e.location) {
      lines.push(`# ${e.missing ?? 'unavailable'}: ${label}`)
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
  /** The track's sources, best first. */
  resolve: (trackId: ID) => Promise<ResolvedSource[]>
}

export interface ExportResult {
  path: string
  /** Tracks left out because only the engine can play their sources: downloading them fixes that. */
  needDownload: number
}

/**
 * Part of a longer file (a chapter of a full-OST stream, an entry in an archive, a sub-song of a
 * multi-song chip file): another player given the file would play something else.
 */
const addressed = (s: EngineSource) => s.clipStartMs != null || s.clipEndMs != null || s.archiveEntry != null || s.subsong != null

/** Writes `<dir>/<name>.m3u8`. */
export async function exportPlaylistM3U({ name, tracks, dir, localPath, resolve }: ExportOptions): Promise<ExportResult> {
  const file = join(dir, sanitizeSegment(name || 'Playlist') + '.m3u8')
  mkdirSync(dirname(file), { recursive: true })
  let needDownload = 0
  const entries = await mapLimit(tracks, 4, async (t): Promise<M3UEntry> => {
    const entry: M3UEntry = { durationMs: t.durationMs, title: t.title, artist: t.gameName ?? t.albumTitle ?? null, location: null }
    const local = localPath(t.id)
    if (local) {
      const rel = relative(dirname(file), local)
      return { ...entry, location: rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : local }
    }
    let sources: ResolvedSource[] = []
    try {
      sources = await resolve(t.id)
    } catch {
      return entry
    }
    const src = sources.find((s) => !addressed(s.source))
    if (src) return { ...entry, location: src.source.kind === 'http' ? src.source.url : src.source.path }
    if (!sources.length) return entry
    needDownload++
    return { ...entry, missing: 'part of a longer file, download it to include it' }
  })
  writeFileAtomic(file, renderM3U(name, entries))
  return { path: file, needDownload }
}
