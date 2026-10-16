// Local files (DESIGN §6.2 #1): watched folders, matched to catalog tracks by tags.
//
// `LocalLibrary` scans settings.sources.localFolders recursively, reads tags with music-metadata
// and indexes them in `local_files` (owned here). Rescans are incremental: a file is re-read only
// when its mtime or size changed; files that disappeared are dropped, but a folder or file that
// couldn't be read keeps what was known about it. `LocalProvider.findTrack` is a cheap DB lookup
// (album / title keys) scored by title, duration and album match, so the resolver asks it on every
// play; resolveStream returns `{ kind: 'file', path }`. `localAlbums` groups the files into albums
// (album tag + album artist, else their folder), which the catalog lists in Browse (catalog/local.ts).

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import type { AlbumKind, AudioFormat } from '../../shared/types'
import { baseTitle, gameKey, keyOf } from '../catalog/normalize'
import type { DB } from '../db'
import { NetError } from '../net/errors'
import { cleanTrackTitle, combineScore, durationFit, titleSimilarity } from './match'
import type { CanonicalTrack, Provider, ProviderAlbum, ProviderCallOptions, ProviderTrack, SourceCandidate, StreamInfo } from './types'

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

/** A folder (or album) named only for its disc: "CD1", "Disc 2", "Disk 01". */
const DISC_LABEL = /^(?:cd|dis[ck])\s*[-_.]?\s*(\d{1,2})$/i
/** The disc part ending an album or folder name: "… (Disc 2)", "… CD 2", "… [Disc 1 of 3]". */
const DISC_SUFFIX = /\s*[-–—:,]?\s*[([]?\s*\b(?:cd|dis[ck])\s*[-_.]?\s*(\d{1,2})(?:\s*(?:of|\/)\s*\d{1,2})?\s*[)\]]?\s*$/i

function discOf(name: string): number | null {
  const m = DISC_LABEL.exec(name) ?? DISC_SUFFIX.exec(name)
  return m ? Number(m[1]) : null
}

/** The album an untagged file's folder names: "<album>/<file>", or "<album>/CD2/<file>" (disc 2). */
function folderAlbum(path: string, root: string): { album: string | null; disc: number | null } {
  let dir = dirname(path)
  if (resolve(dir) === resolve(root)) return { album: null, disc: null }
  const disc = discOf(basename(dir))
  if (DISC_LABEL.test(basename(dir)) && resolve(dirname(dir)) !== resolve(root)) dir = dirname(dir)
  return { album: basename(dir).replace(/\s*[[(][^)\]]*[)\]]\s*/g, ' ').trim() || null, disc }
}

/** Build a row from a file's tags (missing tags fall back to the file / folder names). */
export function rowFromTags(path: string, root: string, st: { mtimeMs: number; size: number }, tags: TagInfo, now: number): LocalFileRow & { scanned_at: number } {
  const stem = basename(path, extname(path))
  const folder = folderAlbum(path, root)
  const album = tags.album?.trim() || folder.album
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
    disc_no: tags.disc ?? folder.disc,
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
  /** Files read this scan: new ones and changed ones. */
  changedPaths: string[]
  /** Per configured folder: music files found, and how many of them are new. */
  byRoot: { root: string; files: number; added: number }[]
  /** Configured folders that couldn't be read (unplugged drive, typo): what was known is kept. */
  unavailable: string[]
  /** Configured folders with subfolders or files that couldn't be read: what was known under those is kept. */
  incomplete: string[]
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
  /** The filesystem a scan reads (tests stand in for unreadable folders). */
  fs?: LocalFs
}

/** The filesystem calls a scan makes. */
export interface LocalFs {
  readdir(dir: string, opts: { withFileTypes: true }): Promise<Dirent[]>
  stat(path: string): Promise<{ mtimeMs: number; size: number; isDirectory(): boolean }>
}

/** Rows each part of a candidate lookup reads at most. */
const CANDIDATES_MAX = 500

export class LocalLibrary {
  private readonly readTags: TagReader
  private readonly now: () => number
  private readonly log: (msg: string) => void
  private readonly fs: LocalFs
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
    this.fs = opts.fs ?? { readdir, stat }
    db.exec(LOCAL_DDL)
  }

  private readonly maxFiles: number

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM local_files`).get() as { n: number }).n
  }

  row(path: string): LocalFileRow | undefined {
    return this.db.prepare(`SELECT * FROM local_files WHERE path = ?`).get(path) as LocalFileRow | undefined
  }

  /** Every indexed file, in path order. */
  rows(): LocalFileRow[] {
    return this.db.prepare(`SELECT * FROM local_files ORDER BY path`).all() as unknown as LocalFileRow[]
  }

  /**
   * Rows that could be this track: those on an album named like its album / game (the same title
   * first, so a huge album can't push it out), then same-titled rows from elsewhere, closest length
   * first (only a convincing length lets those match). Each part is capped on its own, so hundreds
   * of unrelated "Main Theme"s never hide the album's own.
   */
  candidates(t: Pick<CanonicalTrack, 'title' | 'albumTitle' | 'gameName' | 'durationMs'>): LocalFileRow[] {
    const albumKeys = [...new Set([albumKeyOf(t.albumTitle), albumKeyOf(t.gameName), t.gameName ? keyOf(t.gameName) : null, keyOf(t.albumTitle)].filter((k): k is string => !!k))]
    const titleKey = keyOf(t.title)
    const ph = albumKeys.map(() => '?').join(',')
    const onAlbum = albumKeys.length
      ? (this.db.prepare(`SELECT * FROM local_files WHERE album_key IN (${ph}) ORDER BY title_key = ? DESC, path LIMIT ${CANDIDATES_MAX}`).all(...albumKeys, titleKey) as unknown as LocalFileRow[])
      : []
    const named =
      t.durationMs != null
        ? (this.db.prepare(`SELECT * FROM local_files WHERE title_key = ? ORDER BY abs(coalesce(duration_ms, 0) - ?), path LIMIT ${CANDIDATES_MAX}`).all(titleKey, t.durationMs) as unknown as LocalFileRow[])
        : []
    const seen = new Set(onAlbum.map((r) => r.path))
    return [...onAlbum, ...named.filter((r) => !seen.has(r.path))]
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
    const res: ScanResult = { roots, files: 0, added: 0, updated: 0, removed: 0, errors: 0, removedPaths: [], changedPaths: [], byRoot: [], unavailable: [], incomplete: [], ms: 0 }
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
    const plans: { root: string; existing: Map<string, unknown>; seen: Set<string>; todo: Todo[]; truncated: boolean; unread: string[]; files: number }[] = []
    progress({ phase: 'walk', found: 0 })
    for (const root of roots) {
      try {
        if (!(await this.fs.stat(root)).isDirectory()) throw new Error('not a folder')
      } catch (e) {
        // Unplugged drive or a typo: keep what we knew; resolveStream checks files exist.
        this.log(`local folder ${root} unavailable: ${(e as Error).message}`)
        res.unavailable.push(root)
        continue
      }
      const existing = new Map((this.db.prepare(`SELECT path, mtime_ms, size FROM local_files WHERE root = ?`).all(root) as { path: string; mtime_ms: number; size: number }[]).map((r) => [r.path, r]))
      const plan = { root, existing, seen: new Set<string>(), todo: [] as Todo[], truncated: false, unread: [] as string[], files: 0 }
      // A folder or file that vanished while we looked is gone; one we may not read (permissions, a
      // failing drive) is not, and what was known under it stays.
      const unreadable = (path: string, e: unknown) => {
        if (path === root || !isGone(e)) plan.unread.push(path)
      }
      for await (const path of walk(this.fs, root, 24, unreadable)) {
        if (res.files >= this.maxFiles) {
          plan.truncated = true
          break
        }
        let st: { mtimeMs: number; size: number }
        try {
          st = await this.fs.stat(path)
        } catch (e) {
          unreadable(path, e)
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
      if (plan.unread.includes(root)) {
        this.log(`local folder ${root} unavailable: it couldn't be listed`)
        res.unavailable.push(root)
        continue
      }
      if (plan.unread.length) {
        this.log(`local folder ${root}: ${plan.unread.length} folder(s) or file(s) couldn't be read, keeping what was known there`)
        res.incomplete.push(root)
      }
      plans.push(plan)
    }
    // 2. Read the tags of new and changed files, 4 at a time; write in small transactions.
    const total = plans.reduce((n, p) => n + p.todo.length, 0)
    let read = 0
    if (total) progress({ phase: 'tags', done: 0, total })
    for (const { root, existing, seen, todo, truncated, unread, files } of plans) {
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
            res.changedPaths.push(r.path)
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
      // A walk cut short by maxFiles didn't see everything: don't drop what it missed. Nor what is
      // under a folder it couldn't read.
      const gone = [...existing.keys()].filter((p) => !seen.has(p) && !unread.some((u) => p === u || p.startsWith(u.endsWith(sep) ? u : u + sep)))
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

/** A folder or file that isn't there (any more), as opposed to one we may not read. */
function isGone(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function* walk(fs: LocalFs, dir: string, depth: number, onError: (dir: string, e: unknown) => void): AsyncGenerator<string> {
  if (depth < 0) return
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (e) {
    onError(dir, e)
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(fs, p, depth - 1, onError)
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
// Albums

/** "Various Artists" and friends: no one's name. */
const VARIOUS = /^(?:various(?:\s+artists)?|va|v\.\s*a\.?)$/i
const natural = new Intl.Collator('en', { numeric: true })

/** A file's album: its album tag (else its folder) without a disc part, and its disc. */
function albumOfRow(r: LocalFileRow): { title: string; disc: number | null } | null {
  let title = r.album?.trim() || null
  let disc = r.disc_no
  // Files indexed before disc folders were understood carry "CD1" as their album.
  if (title && DISC_LABEL.test(title)) {
    const f = folderAlbum(r.path, r.root)
    title = f.album ?? title
    disc ??= f.disc
  }
  if (!title) return null
  const m = DISC_SUFFIX.exec(title)
  if (m && m.index > 0) {
    title = title.slice(0, m.index).trim()
    disc ??= Number(m[1])
  }
  return { title, disc: disc ?? discOf(basename(dirname(r.path))) }
}

function artistKey(r: LocalFileRow): string {
  const a = r.album_artist?.trim()
  return a && !VARIOUS.test(a) ? keyOf(a) : ''
}

function localKind(title: string): AlbumKind {
  const t = title.toLowerCase()
  if (/\bgame\s*-?\s*rips?\b|\bgamerips?\b/.test(t)) return 'gamerip'
  if (/\bremix/.test(t)) return 'remix'
  if (/\barrange|\bpiano\b|\borchestra/.test(t)) return 'arrange'
  return 'ost'
}

type AlbumEntry = { r: LocalFileRow; title: string; disc: number | null; folder: string }

/** The same disc and track number, or title, in two folders: two copies (a FLAC and an MP3 rip). */
function hasCopies(entries: AlbumEntry[]): boolean {
  const folderOf = new Map<string, string>()
  for (const e of entries) {
    const disc = e.disc ?? 1
    for (const k of [e.r.track_no != null ? `${disc}#${e.r.track_no}` : null, `${disc}:${e.r.title_key}`]) {
      if (k == null) continue
      const f = folderOf.get(k)
      if (f == null) folderOf.set(k, e.folder)
      else if (f !== e.folder) return true
    }
  }
  return false
}

/**
 * Indexed files as albums: grouped by album tag (untagged: their folder) and album artist, discs
 * together ("… (Disc 2)", "CD2/"). Album artists only split albums of one name when they differ,
 * and two copies of an album in different folders stay two albums. Files right in a music folder
 * with no album tag belong to none. A `ref` stays the same across scans while the album's name and
 * artist do; a track's locator is its file.
 */
export function localAlbums(rows: LocalFileRow[]): ProviderAlbum[] {
  const byTitle = new Map<string, AlbumEntry[]>()
  for (const r of rows) {
    const a = albumOfRow(r)
    if (!a) continue
    const k = keyOf(a.title) || a.title.toLowerCase()
    const dir = dirname(r.path)
    let l = byTitle.get(k)
    if (!l) byTitle.set(k, (l = []))
    l.push({ r, ...a, folder: DISC_LABEL.test(basename(dir)) ? dirname(dir) : dir })
  }
  const groups = new Map<string, AlbumEntry[]>()
  const add = (ref: string, e: AlbumEntry) => {
    let l = groups.get(ref)
    if (!l) groups.set(ref, (l = []))
    l.push(e)
  }
  for (const [k, entries] of byTitle) {
    const artists = [...new Set(entries.map((e) => artistKey(e.r)).filter(Boolean))]
    for (const e of entries) add(`${k}|${artists.length > 1 ? artistKey(e.r) : (artists[0] ?? '')}`, e)
  }
  for (const [ref, entries] of [...groups]) {
    if (!hasCopies(entries)) continue
    groups.delete(ref)
    for (const e of entries) add(`${ref}|${e.folder}`, e)
  }
  return [...groups].map(([ref, entries]) => albumFrom(ref, entries))
}

function albumFrom(ref: string, entries: AlbumEntry[]): ProviderAlbum {
  const sorted = [...entries].sort((x, y) => (x.disc ?? 1) - (y.disc ?? 1) || (x.r.track_no ?? 1e9) - (y.r.track_no ?? 1e9) || natural.compare(x.r.path, y.r.path))
  const perDisc = new Map<number, number>()
  const tracks: ProviderTrack[] = sorted.map(({ r, disc }) => {
    const d = disc ?? 1
    const n = (perDisc.get(d) ?? 0) + 1
    perDisc.set(d, n)
    return {
      disc: d,
      number: r.track_no ?? n,
      title: r.title,
      durationMs: r.duration_ms,
      locator: r.path,
      files: [{ format: r.format, sizeBytes: r.size }],
      composers: (r.composer ?? '').split(/\s*[,;]\s*/).filter(Boolean)
    }
  })
  // The album's name as most of its files spell it.
  const spellings = new Map<string, number>()
  for (const e of sorted) spellings.set(e.title, (spellings.get(e.title) ?? 0) + 1)
  const title = [...spellings].sort((a, b) => b[1] - a[1])[0][0]
  const totalSizes: Partial<Record<AudioFormat, number>> = {}
  for (const { r } of sorted) totalSizes[r.format] = (totalSizes[r.format] ?? 0) + r.size
  // Composer tags, else the album artist, else the one artist every file names.
  const albumArtist = sorted.map((e) => e.r.album_artist?.trim()).find((a) => a && !VARIOUS.test(a))
  const artists = [...new Set(sorted.map((e) => e.r.artist?.trim() || ''))]
  const tagged = [...new Set(tracks.flatMap((t) => t.composers))]
  const composers = tagged.length ? tagged : albumArtist ? [albumArtist] : artists.length === 1 && artists[0] && !VARIOUS.test(artists[0]) ? artists : []
  return {
    provider: LOCAL_ID,
    ref,
    title,
    titleFromRef: false,
    platforms: [],
    kind: localKind(title),
    typeLabel: null,
    year: null,
    thumb: null,
    cover: null,
    catalogNo: null,
    addedAt: null,
    altTitles: [],
    titleOriginal: null,
    developers: [],
    publishers: [],
    composers,
    images: [],
    description: null,
    formats: Object.keys(totalSizes) as AudioFormat[],
    totalSizes,
    externalId: null,
    tracks
  }
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
