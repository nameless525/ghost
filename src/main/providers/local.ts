// Local files (DESIGN §6.2 #1): watched folders, matched to catalog tracks by tags.
//
// `LocalLibrary` scans settings.sources.localFolders recursively, reads tags with music-metadata
// and indexes them in `local_files` (owned here). Rescans are incremental: a file is re-read only
// when its mtime or size changed; files that disappeared are dropped. `LocalProvider.findTrack` is a
// cheap DB lookup (album / title keys) scored by title, duration and album match, so the resolver
// asks it on every play; resolveStream returns `{ kind: 'file', path }`.

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { AudioFormat } from '../../shared/types'
import { baseTitle, gameKey, keyOf } from '../catalog/normalize'
import type { DB } from '../db'
import { NetError } from '../net/errors'
import { cleanTrackTitle, combineScore, durationFit, titleSimilarity } from './match'
import type { CanonicalTrack, Provider, ProviderCallOptions, SourceCandidate, StreamInfo } from './types'

export const LOCAL_ID = 'local'

export const LOCAL_DDL = `
CREATE TABLE IF NOT EXISTS local_files (
  path         TEXT PRIMARY KEY,
  root         TEXT NOT NULL,
  mtime_ms     INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  title        TEXT NOT NULL,
  album        TEXT,
  artist       TEXT,
  album_artist TEXT,
  composer     TEXT,
  track_no     INTEGER,
  disc_no      INTEGER,
  duration_ms  INTEGER,
  format       TEXT NOT NULL,
  bitrate      INTEGER,
  lossless     INTEGER NOT NULL DEFAULT 0,
  title_key    TEXT NOT NULL,
  album_key    TEXT,
  scanned_at   INTEGER NOT NULL,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS local_files_title ON local_files(title_key);
CREATE INDEX IF NOT EXISTS local_files_album ON local_files(album_key);
CREATE INDEX IF NOT EXISTS local_files_root ON local_files(root);
`

/** Extensions the engine can decode (symphonia + Opus). */
export const AUDIO_EXTS: Record<string, AudioFormat> = {
  '.mp3': 'mp3',
  '.flac': 'flac',
  '.m4a': 'm4a',
  '.mp4': 'm4a',
  '.aac': 'aac',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.opus': 'opus',
  '.wav': 'wav',
  '.aif': 'wav',
  '.aiff': 'wav'
}

export interface LocalFileRow {
  path: string
  root: string
  mtime_ms: number
  size: number
  title: string
  album: string | null
  artist: string | null
  album_artist: string | null
  composer: string | null
  track_no: number | null
  disc_no: number | null
  duration_ms: number | null
  format: AudioFormat
  bitrate: number | null
  lossless: number
  title_key: string
  album_key: string | null
}

/** What we keep from a tag read (music-metadata's IAudioMetadata, trimmed). */
export interface TagInfo {
  title?: string | null
  album?: string | null
  artist?: string | null
  albumArtist?: string | null
  composer?: string | null
  track?: number | null
  disc?: number | null
  durationMs?: number | null
  bitrateKbps?: number | null
  lossless?: boolean | null
  codec?: string | null
}

export type TagReader = (path: string) => Promise<TagInfo>

/** Default tag reader: music-metadata, covers skipped. Imported lazily (ESM, only needed when scanning). */
export const musicMetadataReader: TagReader = async (path) => {
  const { parseFile } = await import('music-metadata')
  const m = await parseFile(path, { skipCovers: true, duration: false })
  const c = m.common
  return {
    title: c.title ?? null,
    album: c.album ?? null,
    artist: c.artist ?? null,
    albumArtist: c.albumartist ?? null,
    composer: c.composer?.join(', ') ?? null,
    track: c.track?.no ?? null,
    disc: c.disk?.no ?? null,
    durationMs: m.format.duration != null ? Math.round(m.format.duration * 1000) : null,
    bitrateKbps: m.format.bitrate != null ? Math.round(m.format.bitrate / 1000) : null,
    lossless: m.format.lossless ?? null,
    codec: m.format.codec ?? m.format.container ?? null
  }
}

function formatFor(path: string, tags: TagInfo): AudioFormat {
  const codec = (tags.codec ?? '').toLowerCase()
  if (/opus/.test(codec)) return 'opus'
  if (/vorbis/.test(codec)) return 'ogg'
  if (/flac/.test(codec)) return 'flac'
  if (/alac|aac|mp4a/.test(codec)) return 'm4a'
  if (/mpeg.*layer\s*3|mp3/.test(codec)) return 'mp3'
  return AUDIO_EXTS[extname(path).toLowerCase()] ?? 'unknown'
}

/** Key for album → game matching: "Hollow Knight (Original Soundtrack)" → "hollow knight". */
export function albumKeyOf(album: string | null | undefined): string | null {
  if (!album?.trim()) return null
  return gameKey(album) || null
}

/** Build a row from a file's tags (missing tags fall back to the file / folder names). */
export function rowFromTags(path: string, root: string, st: { mtimeMs: number; size: number }, tags: TagInfo, now: number): LocalFileRow & { scanned_at: number } {
  const stem = basename(path, extname(path))
  const folder = basename(dirname(path))
  const album = tags.album?.trim() || (resolve(dirname(path)) !== resolve(root) ? folder.replace(/\s*[[(][^)\]]*[)\]]\s*/g, ' ').trim() : null) || null
  const title = tags.title?.trim() || cleanTrackTitle(stem.replace(/_/g, ' '), { names: [album], numbered: /^\d{1,3}\s/.test(stem) })
  const format = formatFor(path, tags)
  const lossless = tags.lossless ?? (format === 'flac' || format === 'wav')
  return {
    path,
    root,
    mtime_ms: Math.round(st.mtimeMs),
    size: st.size,
    title,
    album,
    artist: tags.artist?.trim() || null,
    album_artist: tags.albumArtist?.trim() || null,
    composer: tags.composer?.trim() || null,
    track_no: tags.track ?? (/^(\d{1,3})\b/.exec(stem) ? Number(/^(\d{1,3})\b/.exec(stem)![1]) : null),
    disc_no: tags.disc ?? null,
    duration_ms: tags.durationMs ?? null,
    format,
    bitrate: tags.bitrateKbps ?? (tags.durationMs ? Math.round((st.size * 8) / tags.durationMs) : null),
    lossless: lossless ? 1 : 0,
    title_key: keyOf(title),
    album_key: albumKeyOf(album),
    scanned_at: now
  }
}

export interface ScanResult {
  roots: string[]
  files: number
  added: number
  updated: number
  removed: number
  errors: number
  removedPaths: string[]
  /** Per configured folder: music files found, and how many of them are new. */
  byRoot: { root: string; files: number; added: number }[]
  /** Configured folders that couldn't be read (unplugged drive, typo): what was known is kept. */
  unavailable: string[]
  ms: number
}

/**
 * How far a scan is: walking the folders (music files found so far), then reading the tags of new
 * and changed files, then done (also after a failure).
 */
export type ScanProgress = { phase: 'walk'; found: number } | { phase: 'tags'; done: number; total: number } | { phase: 'done' }

export interface ScanOptions {
  onProgress?: (p: ScanProgress) => void
}

export interface LocalLibraryOptions {
  readTags?: TagReader
  now?: () => number
  log?: (msg: string) => void
  /** Stop descending after this many files per scan (runaway roots like "/"). */
  maxFiles?: number
}

export class LocalLibrary {
  private readonly readTags: TagReader
  private readonly now: () => number
  private readonly log: (msg: string) => void
  private scanning: Promise<ScanResult> | null = null
  private queued: { folders: string[]; opts: ScanOptions } | null = null
  private next: Promise<ScanResult> | null = null

  constructor(
    readonly db: DB,
    opts: LocalLibraryOptions = {}
  ) {
    this.readTags = opts.readTags ?? musicMetadataReader
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
    this.maxFiles = opts.maxFiles ?? 250_000
    db.exec(LOCAL_DDL)
  }

  private readonly maxFiles: number

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM local_files`).get() as { n: number }).n
  }

  row(path: string): LocalFileRow | undefined {
    return this.db.prepare(`SELECT * FROM local_files WHERE path = ?`).get(path) as LocalFileRow | undefined
  }

  /** Rows that could be this track: same title key, or on an album named like its album / game. */
  candidates(t: Pick<CanonicalTrack, 'title' | 'albumTitle' | 'gameName'>): LocalFileRow[] {
    const albumKeys = [...new Set([albumKeyOf(t.albumTitle), albumKeyOf(t.gameName), t.gameName ? keyOf(t.gameName) : null, keyOf(t.albumTitle)].filter((k): k is string => !!k))]
    const ph = albumKeys.map(() => '?').join(',')
    const sql = `SELECT * FROM local_files WHERE title_key = ?${albumKeys.length ? ` OR album_key IN (${ph})` : ''} LIMIT 500`
    return this.db.prepare(sql).all(keyOf(t.title), ...albumKeys) as unknown as LocalFileRow[]
  }

  /**
   * Scan these folders (incremental by mtime/size). Concurrent calls coalesce: a scan requested
   * while one runs starts right after it with the latest folder list (and options).
   */
  scan(folders: string[], opts: ScanOptions = {}): Promise<ScanResult> {
    if (!this.scanning) {
      const p = this.doScan(folders, opts.onProgress).finally(() => {
        if (this.scanning === p) this.scanning = null
      })
      this.scanning = p
      return p
    }
    this.queued = { folders, opts }
    this.next ??= this.scanning
      .catch(() => undefined)
      .then(() => {
        const q = this.queued ?? { folders, opts }
        this.queued = null
        this.next = null
        return this.scan(q.folders, q.opts)
      })
    return this.next
  }

  private async doScan(folders: string[], onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
    const progress = onProgress ?? (() => {})
    try {
      return await this.scanRoots(folders, progress)
    } finally {
      progress({ phase: 'done' })
    }
  }

  private async scanRoots(folders: string[], progress: (p: ScanProgress) => void): Promise<ScanResult> {
    const t0 = this.now()
    const roots = [...new Set(folders.filter((f) => typeof f === 'string' && f.trim()).map((f) => resolve(f)))]
    const res: ScanResult = { roots, files: 0, added: 0, updated: 0, removed: 0, errors: 0, removedPaths: [], byRoot: [], unavailable: [], ms: 0 }
    // Folders no longer configured.
    const known = (this.db.prepare(`SELECT DISTINCT root FROM local_files`).all() as { root: string }[]).map((r) => r.root)
    for (const r of known) {
      if (roots.includes(r)) continue
      const paths = (this.db.prepare(`SELECT path FROM local_files WHERE root = ?`).all(r) as { path: string }[]).map((x) => x.path)
      this.db.prepare(`DELETE FROM local_files WHERE root = ?`).run(r)
      res.removed += paths.length
      res.removedPaths.push(...paths)
    }
    const upsert = this.db.prepare(
      `INSERT INTO local_files (path, root, mtime_ms, size, title, album, artist, album_artist, composer, track_no, disc_no, duration_ms, format, bitrate, lossless, title_key, album_key, scanned_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET root = excluded.root, mtime_ms = excluded.mtime_ms, size = excluded.size, title = excluded.title, album = excluded.album,
         artist = excluded.artist, album_artist = excluded.album_artist, composer = excluded.composer, track_no = excluded.track_no, disc_no = excluded.disc_no,
         duration_ms = excluded.duration_ms, format = excluded.format, bitrate = excluded.bitrate, lossless = excluded.lossless, title_key = excluded.title_key,
         album_key = excluded.album_key, scanned_at = excluded.scanned_at, error = excluded.error`
    )
    // 1. Walk every folder: what's there, and which files are new or changed.
    type Todo = { path: string; st: { mtimeMs: number; size: number }; isNew: boolean }
    const plans: { root: string; existing: Map<string, unknown>; seen: Set<string>; todo: Todo[]; truncated: boolean; files: number }[] = []
    progress({ phase: 'walk', found: 0 })
    for (const root of roots) {
      try {
        if (!(await stat(root)).isDirectory()) throw new Error('not a folder')
      } catch (e) {
        // Unplugged drive or a typo: keep what we knew; resolveStream checks files exist.
        this.log(`local folder ${root} unavailable: ${(e as Error).message}`)
        res.unavailable.push(root)
        continue
      }
      const existing = new Map((this.db.prepare(`SELECT path, mtime_ms, size FROM local_files WHERE root = ?`).all(root) as { path: string; mtime_ms: number; size: number }[]).map((r) => [r.path, r]))
      const plan = { root, existing, seen: new Set<string>(), todo: [] as Todo[], truncated: false, files: 0 }
      plans.push(plan)
      for await (const path of walk(root, 24)) {
        if (res.files >= this.maxFiles) {
          plan.truncated = true
          break
        }
        let st: { mtimeMs: number; size: number }
        try {
          st = await stat(path)
        } catch {
          continue
        }
        res.files++
        plan.files++
        plan.seen.add(path)
        progress({ phase: 'walk', found: res.files })
        const ex = existing.get(path)
        if (ex && ex.mtime_ms === Math.round(st.mtimeMs) && ex.size === st.size) continue
        plan.todo.push({ path, st, isNew: !ex })
      }
    }
    // 2. Read the tags of new and changed files, 4 at a time; write in small transactions.
    const total = plans.reduce((n, p) => n + p.todo.length, 0)
    let read = 0
    if (total) progress({ phase: 'tags', done: 0, total })
    for (const { root, existing, seen, todo, truncated, files } of plans) {
      let added = 0
      for (let i = 0; i < todo.length; i += 32) {
        const batch = todo.slice(i, i + 32)
        const rows = await mapLimit(batch, 4, async (f) => {
          try {
            return { f, row: rowFromTags(f.path, root, f.st, await this.readTags(f.path), this.now()), error: null as string | null }
          } catch (e) {
            res.errors++
            return { f, row: rowFromTags(f.path, root, f.st, {}, this.now()), error: (e as Error).message.slice(0, 300) }
          }
        })
        this.db.exec('BEGIN IMMEDIATE')
        try {
          for (const { f, row: r, error } of rows) {
            upsert.run(r.path, r.root, r.mtime_ms, r.size, r.title, r.album, r.artist, r.album_artist, r.composer, r.track_no, r.disc_no, r.duration_ms, r.format, r.bitrate, r.lossless, r.title_key, r.album_key, r.scanned_at, error)
            if (f.isNew) added++
            else res.updated++
          }
          this.db.exec('COMMIT')
        } catch (e) {
          this.db.exec('ROLLBACK')
          throw e
        }
        read += batch.length
        progress({ phase: 'tags', done: read, total })
        await new Promise((r) => setImmediate(r))
      }
      res.added += added
      res.byRoot.push({ root, files, added })
      // A walk cut short by maxFiles didn't see everything: don't drop what it missed.
      const gone = [...existing.keys()].filter((p) => !seen.has(p))
      if (gone.length && !truncated) {
        const del = this.db.prepare(`DELETE FROM local_files WHERE path = ?`)
        this.db.exec('BEGIN IMMEDIATE')
        for (const p of gone) del.run(p)
        this.db.exec('COMMIT')
        res.removed += gone.length
        res.removedPaths.push(...gone)
      }
    }
    res.ms = this.now() - t0
    return res
  }
}

async function* walk(dir: string, depth: number): AsyncGenerator<string> {
  if (depth < 0) return
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p, depth - 1)
    else if ((e.isFile() || e.isSymbolicLink()) && AUDIO_EXTS[extname(e.name).toLowerCase()]) yield p
    // Symlinked directories are not followed (no loops).
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

// ---------------------------------------------------------------------------
// Matching + provider

export interface LocalMatch extends SourceCandidate {
  albumMatch: boolean
}

/** Score local files against a canonical track. */
export function matchLocal(rows: LocalFileRow[], t: Pick<CanonicalTrack, 'title' | 'albumTitle' | 'gameName' | 'durationMs'>): LocalMatch[] {
  const keys = new Set([albumKeyOf(t.albumTitle), albumKeyOf(t.gameName), t.gameName ? keyOf(t.gameName) : null, keyOf(t.albumTitle), keyOf(baseTitle(t.albumTitle))].filter(Boolean))
  const out: LocalMatch[] = []
  for (const r of rows) {
    const title = titleSimilarity(t.title, r.title, { context: [t.gameName, t.albumTitle, r.album] })
    if (title < 0.6) continue
    const albumMatch = !!r.album_key && keys.has(r.album_key)
    const duration = durationFit(t.durationMs, r.duration_ms)
    // A same-named track on some other album ("Main Theme") needs a convincing duration.
    if (!albumMatch && (t.durationMs == null || duration < 0.5)) continue
    const confidence = combineScore({ title, duration, trust: albumMatch ? 1 : 0.4, quality: r.lossless ? 1 : 0.7, penalties: [] })
    if (confidence < 0.6) continue
    out.push({ provider: LOCAL_ID, locator: r.path, title: r.title, durationMs: r.duration_ms, confidence, albumMatch })
  }
  return out.sort((a, b) => b.confidence - a.confidence)
}

export class LocalProvider implements Provider {
  readonly id = LOCAL_ID
  readonly name = 'Local files'
  /** A DB lookup: cheap enough to ask on every play. */
  readonly findTrackMode = 'always' as const
  /** Streams are built from the locator (no request). */
  readonly streamsFromLocator = true

  constructor(readonly library: LocalLibrary) {}

  async findTrack(t: CanonicalTrack, _opts?: ProviderCallOptions): Promise<SourceCandidate[]> {
    return matchLocal(this.library.candidates(t), t)
      .slice(0, 3)
      .map(({ provider, locator, title, durationMs, confidence }) => ({ provider, locator, title, durationMs, confidence }))
  }

  async resolveStream(locator: string, _opts?: ProviderCallOptions): Promise<StreamInfo[]> {
    let st: { size: number; isFile(): boolean }
    try {
      st = await stat(locator)
    } catch {
      throw new NetError('not_found', `local file is gone: ${locator}`)
    }
    if (!st.isFile()) throw new NetError('not_found', `not a file: ${locator}`)
    const r = this.library.row(locator)
    const format = r?.format ?? AUDIO_EXTS[extname(locator).toLowerCase()] ?? 'unknown'
    return [
      {
        provider: LOCAL_ID,
        source: { kind: 'file', path: locator, formatHint: format },
        format,
        lossless: r ? !!r.lossless : format === 'flac' || format === 'wav',
        bitrateKbps: r?.bitrate ?? null,
        sizeBytes: st.size,
        expiresAt: null
      }
    ]
  }
}
