// Catalog persistence: listing/album upserts, album → game clustering, FTS maintenance, and the
// row → API object mapping (Album, Game, TrackView). Synchronous (node:sqlite); callers keep
// batches small so the main process never stalls for long.

import type { SQLInputValue, StatementSync } from 'node:sqlite'
import { foldText } from '../../shared/search'
import type { Album, AlbumKind, AudioFormat, Game, Settings, SourceSummary, TrackAnalysis, TrackView } from '../../shared/types'
import type { DB } from '../db'
import type { OfflineAnalysisResult } from '../engine/types'
import type { AlbumHit, PlatformRef, ProviderAlbum, ProviderTrackFile } from '../providers/types'
import { LOSSLESS_FORMATS } from '../providers/types'
import { cleanCredits } from '../providers/credits'
import { ftsFold, GAME_ALIASES, searchAliases, TITLE_ALIASES } from './aliases'
import { baseTitle, clusterKeys, franchiseGuess, gameKey, headKey, keyOf, kindRank, MERGEABLE_KINDS, pickGameName, sortKey } from './normalize'
import { CLUSTER_VERSION, ensureCatalogSchema, FTS_VERSION, recountCatalog, UNKNOWN_INTENSITY, UNKNOWN_LEN, UNKNOWN_YEAR } from './schema'

export type Quality = Settings['sources']['quality']

/**
 * Text as stored in (and queried against) the FTS indexes (see ./aliases). Query terms go through
 * the same function so phrases still line up.
 */
export { ftsFold }

/** An FTS column value: items separated by ' \n ' (so phrases can't span items), space-padded so
 * every word is preceded by a space (lets 2-character terms match as indexed word prefixes). */
export function ftsDoc(items: (string | null | undefined)[]): string {
  const parts = items.map((x) => (x ? ftsFold(x) : '')).filter(Boolean)
  return parts.length ? ` ${parts.join(' \n ')} ` : ''
}

/** A game's searchable names: its name and alternative names plus their aliases (deduplicated). */
export function gameSearchNames(name: string | null, alt: string[]): string[] {
  if (!name) return alt
  const out = new Set<string>([name, ...searchAliases(name, GAME_ALIASES)])
  for (const a of alt) {
    out.add(a)
    for (const x of searchAliases(a, TITLE_ALIASES)) out.add(x)
  }
  return [...out]
}

export function j<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** Preference ladders: earlier = better. */
export const FORMAT_LADDER: Record<Quality, AudioFormat[]> = {
  lossless: ['chip', 'flac', 'wav', 'm4a', 'mp3', 'aac', 'ogg', 'opus', 'unknown'],
  high: ['chip', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav', 'unknown'],
  saver: ['chip', 'opus', 'ogg', 'aac', 'm4a', 'mp3', 'flac', 'wav', 'unknown']
}

export function formatRank(f: AudioFormat, q: Quality): number {
  const i = FORMAT_LADDER[q].indexOf(f)
  return i < 0 ? 99 : i
}

export function estimateKbps(sizeBytes: number | null | undefined, durationMs: number | null | undefined): number | null {
  if (!sizeBytes || !durationMs || durationMs < 1000) return null
  return Math.round((sizeBytes * 8) / durationMs)
}

/** IGDB / SteamGridDB data applied on top of the derived game fields. */
export interface IgdbData {
  id: number
  name: string
  altNames: string[]
  year: number | null
  cover: string | null
  hero: string | null
  franchise: string | null
  platforms: string[]
}
export interface SgdbData {
  id: number
  hero: string | null
  logo: string | null
  cover: string | null
}

interface GameRow {
  id: number
  norm_key: string
  name: string
  sort_name: string
  alt_names: string
  year: number | null
  platforms: string
  franchise: string | null
  franchise_guess: string | null
  cover: string | null
  hero: string | null
  logo: string | null
  accent: string | null
  igdb_json: string | null
  sgdb_json: string | null
  album_count: number
}

export interface TrackRow {
  id: number
  album_id: number
  disc: number
  number: number
  title: string
  title_original: string | null
  duration_ms: number | null
  composers: string
  files: string
  locator: string
  album_title: string
  album_kind: AlbumKind
  album_year: number | null
  album_platforms: string
  album_cover: string | null
  album_composers: string
  album_provider: string
  album_ref: string
  game_id: number | null
  game_name: string | null
  game_year: number | null
  game_cover: string | null
  game_hero: string | null
  game_accent: string | null
  bpm: number | null
  intensity: number | null
  lufs: number | null
}

/** Bump when cleanCredits changes, so stored composer lists are cleaned again (cleanStoredCredits). */
const CREDITS_VERSION = 1

export const TRACK_VIEW_COLUMNS = `
  t.id, t.album_id, t.disc, t.number, t.title, t.title_original, t.duration_ms, t.composers, t.files, t.locator,
  a.title AS album_title, a.kind AS album_kind, a.year AS album_year, a.platforms AS album_platforms,
  a.cover AS album_cover, a.composers AS album_composers, a.provider AS album_provider, a.provider_ref AS album_ref,
  g.id AS game_id, g.name AS game_name, g.year AS game_year, g.cover AS game_cover, g.hero AS game_hero, g.accent AS game_accent,
  an.bpm AS bpm, an.intensity AS intensity, an.lufs AS lufs`
export const TRACK_VIEW_FROM = `
  tracks t JOIN albums a ON a.id = t.album_id
  LEFT JOIN games g ON g.id = a.game_id
  LEFT JOIN analysis an ON an.track_id = t.id`

export const ALBUM_COLUMNS = `a.id, a.game_id, a.title, a.title_original, a.kind, a.year, a.platforms, a.catalog_no, a.composers, a.cover,
  a.track_count, a.total_ms, a.formats, a.provider, a.provider_ref, a.added_at, g.name AS game_name, g.cover AS game_cover`

/** The album columns a listing upsert reads to tell what changed. */
interface ExistingAlbum {
  id: number
  title: string
  title_from_ref: number
  sort_title: string
  kind: AlbumKind
  kind_rank: number
  type_label: string | null
  year: number | null
  sort_year: number
  platforms: string
  catalog_no: string | null
  cover: string | null
  thumb: string | null
  added_at: number | null
  sort_added: number
  detail_at: number | null
  gone: number
  game_id: number | null
}

export interface AlbumRowLite {
  id: number
  game_id: number | null
  title: string
  title_original: string | null
  kind: AlbumKind
  year: number | null
  platforms: string
  catalog_no: string | null
  composers: string
  cover: string | null
  track_count: number | null
  total_ms: number | null
  formats: string
  provider: string
  provider_ref: string
  added_at: number | null
  game_name: string | null
  game_cover: string | null
}

export function toAlbum(r: AlbumRowLite): Album {
  return {
    id: String(r.id),
    gameId: r.game_id != null ? String(r.game_id) : null,
    gameName: r.game_name ?? null,
    title: r.title,
    titleOriginal: r.title_original ?? null,
    kind: r.kind,
    year: r.year ?? null,
    platforms: j<string[]>(r.platforms, []),
    catalogNo: r.catalog_no ?? null,
    composers: j<string[]>(r.composers, []),
    cover: r.cover ?? r.game_cover ?? null,
    trackCount: r.track_count ?? null,
    totalMs: r.total_ms ?? null,
    formats: j<AudioFormat[]>(r.formats, []),
    provider: r.provider,
    providerRef: r.provider_ref,
    addedAt: r.added_at ?? null
  }
}

export function toGame(r: GameRow): Game {
  return {
    id: String(r.id),
    name: r.name,
    altNames: j<string[]>(r.alt_names, []),
    year: r.year ?? null,
    platforms: j<string[]>(r.platforms, []),
    franchise: r.franchise ?? null,
    cover: r.cover ?? null,
    hero: r.hero ?? null,
    logo: r.logo ?? null,
    accent: r.accent ?? null,
    albumCount: r.album_count
  }
}

function f32(values: number[] | null | undefined): Uint8Array | null {
  if (!values || !values.length) return null
  return new Uint8Array(new Float32Array(values).buffer)
}
function unf32(u: unknown): number[] {
  if (!(u instanceof Uint8Array) || u.byteLength < 4) return []
  const copy = u.slice()
  return Array.from(new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4)), (x) => Math.round(x * 1000) / 1000)
}

/**
 * Pause between the write transactions of background work (crawls). The main process writes its
 * library tables on another connection and, while one of ours is open, sleeps in SQLite's busy
 * handler (retrying after 1, 2, 5, 10… ms): small transactions with real gaps let it in quickly.
 */
export const writerPause = (): Promise<void> => new Promise((r) => setTimeout(r, 8))
/** Rows per write transaction in background work. */
export const BACKGROUND_TX_ROWS = 100
/** Prepared statements kept per connection (see CatalogRepo.st). */
const STATEMENT_CACHE_MAX = 300
/** An FTS index this many times its size after its last merge is merged again (see compactFts). */
export const FTS_REGROWTH = 1.3

/** Call `yieldFn` once `sliceMs` of synchronous work has passed since the last yield. */
export function timeSlicer(yieldFn: () => Promise<void>, sliceMs = 8): () => Promise<void> {
  let last = performance.now()
  return async () => {
    if (performance.now() - last < sliceMs) return
    await yieldFn()
    last = performance.now()
  }
}

/**
 * How long write transactions held the database (debug stats). The main process writes its
 * library tables on another connection and waits (busy_timeout) while one is open, so long ones
 * would stall it: background work keeps them short.
 */
export const txStats = { count: 0, totalMs: 0, maxMs: 0, over20: 0, over50: 0, slowest: '' }
function noteTx(ms: number): void {
  txStats.count++
  txStats.totalMs += ms
  if (ms > txStats.maxMs) {
    txStats.maxMs = Math.round(ms * 10) / 10
    // Which write it was (the callers above tx()).
    txStats.slowest = (new Error().stack ?? '').split('\n').slice(3, 6).map((l) => l.trim().replace(/^at /, '').replace(/ \(.*\)$/, '')).join(' < ')
  }
  if (ms > 20) txStats.over20++
  if (ms > 50) txStats.over50++
}

export class CatalogRepo {
  private stmts = new Map<string, StatementSync>()
  /**
   * norm_key → game id snapshots held by long passes (a full re-cluster), kept valid as games are
   * deleted. Everything else looks games up by their indexed norm_key: no resident ~100k-key maps
   * (and no ~0.25 s synchronous load before the first write after start-up).
   */
  private liveGameCaches = new Set<Map<string, number>>()
  /** Bumped whenever data the UI shows changes (drives 'catalog:status' refreshes). */
  revision = 0

  constructor(
    readonly db: DB,
    private now: () => number = Date.now
  ) {
    ensureCatalogSchema(db)
  }

  // ---------------------------------------------------------------------------
  // plumbing

  /**
   * A prepared statement for this SQL, from a bounded cache (most recently used kept). Unbounded,
   * the cache grew with every IN-list length (1…500 ids, a few KB to ~40 KB of native memory each:
   * 1,200 such statements held ~50 MB). An evicted statement stays valid for whoever holds it.
   */
  st(sql: string): StatementSync {
    let s = this.stmts.get(sql)
    if (s) {
      this.stmts.delete(sql)
      this.stmts.set(sql, s)
      return s
    }
    s = this.db.prepare(sql)
    this.stmts.set(sql, s)
    if (this.stmts.size > STATEMENT_CACHE_MAX) this.stmts.delete(this.stmts.keys().next().value!)
    return s
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.st(sql).all(...params) as T[]
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.st(sql).get(...params) as T | undefined
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.st(sql).run(...params)
  }

  /** Re-entrant transaction. */
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    const t0 = performance.now()
    // IMMEDIATE: take the write lock up front. A deferred transaction that read first can't be
    // upgraded once the main process (another connection) has committed meanwhile, and SQLite
    // fails that with SQLITE_BUSY without waiting (busy_timeout doesn't apply).
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    } finally {
      noteTx(performance.now() - t0)
    }
  }

  private tableCache = new Map<string, { at: number; has: boolean; cols: Set<string> }>()
  /** Whether another module's table exists (likes/downloads), cached for a few seconds. */
  tableInfo(name: string): { has: boolean; cols: Set<string> } {
    const c = this.tableCache.get(name)
    if (c && this.now() - c.at < 5000) return c
    const cols = new Set(this.all<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, name).map((r) => r.name))
    const v = { at: this.now(), has: cols.size > 0, cols }
    this.tableCache.set(name, v)
    return v
  }

  /** Catalog sizes, maintained by triggers (no table walk; see COUNTS_TRIGGERS_DDL). */
  counts(): { games: number; albums: number; tracks: number } {
    const out = { games: 0, albums: 0, tracks: 0 }
    for (const r of this.all<{ k: string; n: number }>(`SELECT k, n FROM catalog_counts`)) if (r.k in out) out[r.k as keyof typeof out] = r.n
    return out
  }

  /** Albums per source (maintained by triggers too). */
  albumsPerSource(): Map<string, number> {
    return new Map(this.all<{ k: string; n: number }>(`SELECT substr(k, 8) AS k, n FROM catalog_counts WHERE k LIKE 'albums:%' AND n > 0`).map((r) => [r.k, r.n]))
  }

  /** Recompute the maintained counts from the tables (one full count). */
  recount(): void {
    this.tx(() => recountCatalog(this.db))
  }

  meta(key: string): string | null {
    return this.get<{ value: string }>(`SELECT value FROM catalog_meta WHERE key = ?`, key)?.value ?? null
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.run(`DELETE FROM catalog_meta WHERE key = ?`, key)
    else this.run(`INSERT INTO catalog_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
  }

  // ---------------------------------------------------------------------------
  // listings

  /**
   * Upsert albums seen in a provider listing. New albums get `added_at` = now unless this is the
   * initial crawl (then unknown until the album page or the "latest" feed tells us).
   * Returns the album ids (in input order). `changed` collects the ids whose clustering or search
   * text may have moved (new, edited or never clustered albums): a refresh crawl re-reads ~135k
   * listing rows that are nearly all unchanged, and those only get their last_seen stamped.
   */
  upsertHits(hits: AlbumHit[], opts: { initial: boolean }, changed?: number[]): number[] {
    const now = this.now()
    const ids: number[] = []
    this.tx(() => {
      for (const h of hits) {
        const ex = this.get<ExistingAlbum>(
          `SELECT id, title, title_from_ref, sort_title, kind, kind_rank, type_label, year, sort_year, platforms, catalog_no, cover, thumb, added_at,
                  sort_added, detail_at, gone, game_id
           FROM albums WHERE provider = ? AND provider_ref = ?`,
          h.provider,
          h.ref
        )
        const platformNames = JSON.stringify(h.platforms.map((p) => p.name))
        if (!ex) {
          const addedAt = h.addedAt ?? (opts.initial ? null : now)
          const r = this.st(
            `INSERT INTO albums (provider, provider_ref, title, title_from_ref, sort_title, kind, kind_rank, type_label, year, sort_year, platforms,
               catalog_no, cover, thumb, added_at, sort_added, first_seen, last_seen)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            h.provider,
            h.ref,
            h.title,
            h.titleFromRef ? 1 : 0,
            sortKey(h.title),
            h.kind,
            kindRank(h.kind),
            h.typeLabel,
            h.year,
            h.year ?? UNKNOWN_YEAR,
            platformNames,
            h.catalogNo,
            h.cover,
            h.thumb,
            addedAt,
            addedAt ?? 0,
            now,
            now
          )
          const id = Number(r.lastInsertRowid)
          this.writePlatforms(id, h.platforms)
          ids.push(id)
          changed?.push(id)
          continue
        }
        const keepTitle = ex.detail_at != null || (h.titleFromRef && !ex.title_from_ref)
        const title = keepTitle ? ex.title : h.title
        const addedAt = h.addedAt ?? ex.added_at
        // The row as the update below would leave it.
        const next = {
          title,
          title_from_ref: keepTitle ? ex.title_from_ref : h.titleFromRef ? 1 : 0,
          sort_title: sortKey(title),
          kind: h.kind,
          kind_rank: kindRank(h.kind),
          type_label: h.typeLabel,
          year: h.year ?? ex.year,
          sort_year: h.year ?? ex.year ?? UNKNOWN_YEAR,
          platforms: platformNames,
          catalog_no: h.catalogNo ?? ex.catalog_no,
          cover: ex.detail_at != null && ex.cover != null ? ex.cover : (h.cover ?? ex.cover),
          thumb: ex.thumb ?? h.thumb,
          added_at: addedAt,
          sort_added: addedAt ?? 0
        }
        ids.push(ex.id)
        if (ex.gone === 0 && (Object.keys(next) as (keyof typeof next)[]).every((k) => next[k] === ex[k])) {
          this.run(`UPDATE albums SET last_seen = ? WHERE id = ?`, now, ex.id)
          if (ex.game_id == null) changed?.push(ex.id)
          continue
        }
        this.run(
          `UPDATE albums SET title = ?, title_from_ref = ?, sort_title = ?, kind = ?, kind_rank = ?, type_label = ?, year = ?, sort_year = ?, platforms = ?,
             catalog_no = ?, cover = ?, thumb = ?, added_at = ?, sort_added = ?, last_seen = ?, gone = 0
           WHERE id = ?`,
          next.title,
          next.title_from_ref,
          next.sort_title,
          next.kind,
          next.kind_rank,
          next.type_label,
          next.year,
          next.sort_year,
          next.platforms,
          next.catalog_no,
          next.cover,
          next.thumb,
          next.added_at,
          next.sort_added,
          now,
          ex.id
        )
        if (ex.platforms !== platformNames) this.writePlatforms(ex.id, h.platforms)
        changed?.push(ex.id)
      }
    })
    return ids
  }

  /** upsertHits in small transactions with pauses between them (background crawls). */
  async upsertHitsPaced(hits: AlbumHit[], opts: { initial: boolean }, pause: () => Promise<void> = writerPause, changed?: number[]): Promise<number[]> {
    const ids: number[] = []
    for (let i = 0; i < hits.length; i += BACKGROUND_TX_ROWS) {
      if (i) await pause()
      for (const id of this.upsertHits(hits.slice(i, i + BACKGROUND_TX_ROWS), opts, changed)) ids.push(id)
    }
    return ids
  }

  /** assignGames in small transactions with pauses between them (background crawls). */
  async assignGamesPaced(albumIds: number[], pause: () => Promise<void> = writerPause): Promise<void> {
    for (let i = 0; i < albumIds.length; i += BACKGROUND_TX_ROWS) {
      if (i) await pause()
      this.assignGames(albumIds.slice(i, i + BACKGROUND_TX_ROWS))
    }
  }

  private writePlatforms(albumId: number, platforms: PlatformRef[]): void {
    this.run(`DELETE FROM album_platforms WHERE album_id = ?`, albumId)
    for (const p of platforms) {
      const fold = foldText(p.name)
      this.run(`INSERT OR IGNORE INTO album_platforms(album_id, slug, name, name_fold) VALUES (?, ?, ?, ?)`, albumId, p.slug, p.name, fold)
      // Platform filters resolve names against this short list, not a scan of every album's platforms.
      this.run(`INSERT OR IGNORE INTO platform_names(slug, name_fold) VALUES (?, ?)`, p.slug, fold)
    }
  }

  /**
   * Once per CREDITS_VERSION: clean composer credits stored before cleanCredits existed (some
   * KHInsider "Composed by" fields held arrangers or bare headings like "Arranged :"). Only rows
   * that can be affected are read. Returns how many albums and tracks changed.
   */
  cleanStoredCredits(): number {
    if (this.meta('credits_version') === String(CREDITS_VERSION)) return 0
    const suspect = `(composers LIKE '%by%' OR composers LIKE '%:%' OR composers LIKE '%：%' OR composers LIKE '%rrang%' OR composers LIKE '%yric%' OR composers LIKE '%erform%')`
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
    let n = 0
    this.tx(() => {
      for (const r of this.all<{ id: number; composers: string }>(`SELECT id, composers FROM albums WHERE ${suspect}`)) {
        const before = j<string[]>(r.composers, [])
        const after = cleanCredits(before)
        if (same(before, after)) continue
        this.run(`UPDATE albums SET composers = ? WHERE id = ?`, JSON.stringify(after), r.id)
        this.writeComposers(r.id, after)
        n++
      }
      for (const r of this.all<{ id: number; composers: string }>(`SELECT id, composers FROM tracks WHERE ${suspect}`)) {
        const before = j<string[]>(r.composers, [])
        const after = cleanCredits(before)
        if (same(before, after)) continue
        this.run(`UPDATE tracks SET composers = ? WHERE id = ?`, JSON.stringify(after), r.id)
        n++
      }
      this.setMeta('credits_version', String(CREDITS_VERSION))
    })
    return n
  }

  private writeComposers(albumId: number, names: string[]): void {
    this.run(`DELETE FROM album_composers WHERE album_id = ?`, albumId)
    for (const n of names) this.run(`INSERT OR IGNORE INTO album_composers(album_id, name_fold, name) VALUES (?, ?, ?)`, albumId, foldText(n), n)
  }

  albumIdByRef(provider: string, ref: string): number | null {
    return this.get<{ id: number }>(`SELECT id FROM albums WHERE provider = ? AND provider_ref = ?`, provider, ref)?.id ?? null
  }

  // ---------------------------------------------------------------------------
  // album detail

  applyAlbumDetail(albumId: number, d: ProviderAlbum): void {
    // One transaction for the album, its tracks, its game and both search documents (one commit on
    // the album-open path, and never a half-applied album).
    this.tx(() => {
      this.writeAlbumDetail(albumId, d)
      this.assignGames([albumId])
      this.updateTrackFts(albumId)
    })
    this.revision++
  }

  private writeAlbumDetail(albumId: number, d: ProviderAlbum): void {
    const now = this.now()
    const totalMs = d.tracks.reduce((s, t) => s + (t.durationMs ?? 0), 0) || null
    const prev = this.get<{ platforms: string; cover: string | null; year: number | null; added_at: number | null }>(`SELECT platforms, cover, year, added_at FROM albums WHERE id = ?`, albumId)
    if (!prev) throw new Error(`album ${albumId} vanished`)
    const platforms = d.platforms.length ? d.platforms : null
    // Composers only, whatever the source put in its credits field (see providers/credits.ts).
    const composers = cleanCredits(d.composers)
    const year = d.year ?? prev.year
    const addedAt = d.addedAt ?? prev.added_at
    this.run(
      `UPDATE albums SET title = ?, title_from_ref = 0, sort_title = ?, title_original = ?, alt_titles = ?, kind = ?, kind_rank = ?, type_label = ?,
         year = ?, sort_year = ?, platforms = COALESCE(?, platforms), catalog_no = COALESCE(?, catalog_no), developers = ?, publishers = ?,
         composers = ?, cover = COALESCE(?, cover), thumb = COALESCE(?, thumb), images = ?, formats = ?, sizes = ?, track_count = ?,
         total_ms = ?, sort_len = ?, description = ?, ext_id = ?, added_at = ?, sort_added = ?, detail_at = ?, detail_error = NULL,
         art_checked_at = ?, gone = 0
       WHERE id = ?`,
      d.title,
      sortKey(d.title),
      d.titleOriginal,
      JSON.stringify(d.altTitles),
      d.kind,
      kindRank(d.kind),
      d.typeLabel,
      year,
      year ?? UNKNOWN_YEAR,
      platforms ? JSON.stringify(platforms.map((p) => p.name)) : null,
      d.catalogNo,
      JSON.stringify(d.developers),
      JSON.stringify(d.publishers),
      JSON.stringify(composers),
      d.cover,
      d.thumb,
      JSON.stringify(d.images),
      JSON.stringify(d.formats),
      JSON.stringify(d.totalSizes),
      d.tracks.length,
      totalMs,
      totalMs ?? UNKNOWN_LEN,
      d.description,
      d.externalId,
      addedAt,
      addedAt ?? 0,
      now,
      now,
      albumId
    )
    if (platforms) this.writePlatforms(albumId, platforms)
    this.writeComposers(albumId, composers)

    const existing = new Map(this.all<{ id: number; locator: string }>(`SELECT id, locator FROM tracks WHERE album_id = ?`, albumId).map((r) => [r.locator, r.id]))
    const seen = new Set<string>()
    d.tracks.forEach((t, i) => {
      seen.add(t.locator)
      const files = JSON.stringify(t.files)
      const id = existing.get(t.locator)
      if (id != null) {
        this.run(
          `UPDATE tracks SET disc = ?, number = ?, position = ?, title = ?, duration_ms = COALESCE(?, duration_ms), composers = ?, files = ?, removed = 0 WHERE id = ?`,
          t.disc,
          t.number,
          i,
          t.title,
          t.durationMs,
          JSON.stringify(cleanCredits(t.composers)),
          files,
          id
        )
      } else {
        this.run(
          `INSERT INTO tracks (album_id, disc, number, position, title, duration_ms, composers, locator, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          albumId,
          t.disc,
          t.number,
          i,
          t.title,
          t.durationMs,
          JSON.stringify(cleanCredits(t.composers)),
          t.locator,
          files
        )
      }
    })
    for (const [loc, id] of existing) if (!seen.has(loc)) this.run(`UPDATE tracks SET removed = 1 WHERE id = ?`, id)
  }

  markAlbumError(albumId: number, error: string, gone = false): void {
    this.run(`UPDATE albums SET detail_error = ?, art_checked_at = ?, gone = CASE WHEN ? THEN 1 ELSE gone END WHERE id = ?`, error.slice(0, 500), this.now(), gone ? 1 : 0, albumId)
    if (gone) {
      const g = this.get<{ game_id: number | null }>(`SELECT game_id FROM albums WHERE id = ?`, albumId)
      if (g?.game_id != null) this.refreshGames([g.game_id])
      this.revision++
    }
  }

  // ---------------------------------------------------------------------------
  // clustering

  /** The id of the game with this key, creating it (named after `seedTitle`) when there is none. */
  private gameIdFor(key: string, seedTitle: string, cache?: Map<string, number>): number {
    const id = cache?.get(key) ?? this.get<{ id: number }>(`SELECT id FROM games WHERE norm_key = ?`, key)?.id
    if (id != null) return id
    const name = baseTitle(seedTitle) || seedTitle
    const nid = Number(this.st(`INSERT INTO games (norm_key, name, sort_name) VALUES (?, ?, ?)`).run(key, name, sortKey(name)).lastInsertRowid)
    cache?.set(key, nid)
    return nid
  }

  /** Keys of games that have an OST or gamerip (mergeable albums fold into those). */
  private readonly primaryGames = { has: (key: string): boolean => !!this.get(`SELECT 1 AS x FROM games WHERE norm_key = ? AND has_primary = 1`, key) }

  /**
   * The norm_key of an existing game called `name` (its key, display name or an alternative name),
   * or null. `scanAltNames: false` skips the alternative-name scan (a table scan; bulk matching).
   */
  findGameKey(name: string, opts: { scanAltNames?: boolean } = {}): string | null {
    const k = gameKey(name)
    const nk = keyOf(name)
    if (!k && !nk) return null
    const direct = this.get<{ norm_key: string }>(`SELECT norm_key FROM games WHERE norm_key IN (?, ?) ORDER BY album_count DESC LIMIT 1`, k, nk)
    if (direct) return direct.norm_key
    for (const g of this.all<{ norm_key: string; name: string; alt_names: string }>(`SELECT norm_key, name, alt_names FROM games WHERE sort_name IN (?, ?) LIMIT 20`, sortKey(name), sortKey(baseTitle(name)))) {
      if (keyOf(g.name) === nk || keyOf(g.name) === k) return g.norm_key
    }
    if (opts.scanAltNames === false) return null
    // Alternative names (IGDB alt names, other album titles): a substring prefilter, then exact keys.
    const needle = `%${name.replace(/[%_]/g, ' ').trim()}%`
    for (const g of this.all<{ norm_key: string; alt_names: string }>(`SELECT norm_key, alt_names FROM games WHERE alt_names LIKE ? ORDER BY album_count DESC LIMIT 50`, needle)) {
      if (j<string[]>(g.alt_names, []).some((a) => keyOf(a) === nk || keyOf(a) === k)) return g.norm_key
    }
    return null
  }

  /**
   * Pin an album to a game by name: the existing game with that name, else a new one called
   * `gameName`. The album keeps that game through re-clustering. Returns the game id.
   */
  pinAlbumToGame(albumId: number, gameName: string): number {
    const name = gameName.trim()
    if (!name) throw new Error('empty game name')
    const key = this.findGameKey(name) ?? (gameKey(name) || keyOf(name) || foldText(name))
    let gid = 0
    this.tx(() => {
      const existed = !!this.get(`SELECT 1 AS x FROM games WHERE norm_key = ?`, key)
      gid = this.gameIdFor(key, name)
      if (!existed) this.run(`UPDATE games SET name = ?, sort_name = ? WHERE id = ?`, name, sortKey(name), gid)
      this.run(`UPDATE albums SET game_key = ? WHERE id = ?`, key, albumId)
    })
    this.assignGames([albumId])
    return gid
  }

  /** Incrementally (re)assign games for these albums, refresh the affected games and FTS docs. */
  assignGames(albumIds: number[]): void {
    if (!albumIds.length) return
    const touched = new Set<number>()
    const ftsDirty = new Set<number>(albumIds)
    this.tx(() => {
      for (let i = 0; i < albumIds.length; i += 500) {
        const chunk = albumIds.slice(i, i + 500)
        const rows = this.all<{ id: number; title: string; kind: AlbumKind; game_id: number | null; game_key: string | null }>(
          `SELECT id, title, kind, game_id, game_key FROM albums WHERE id IN (${chunk.map(() => '?').join(',')})`,
          ...chunk
        )
        // Primary (non-mergeable) albums in this batch count before the mergeable ones look for a head.
        const batchPrimary = new Set<string>()
        for (const r of rows) if (!MERGEABLE_KINDS.has(r.kind)) batchPrimary.add(r.game_key ?? gameKey(r.title))
        const keys = clusterKeys(rows, { has: (k) => batchPrimary.has(k) || this.primaryGames.has(k) })
        // Imported albums are pinned to the game they were imported into.
        for (const r of rows) if (r.game_key) keys.set(r.id, r.game_key)
        for (const r of rows) {
          const key = keys.get(r.id)!
          const gid = this.gameIdFor(key, r.title)
          if (r.game_id !== gid) {
            this.run(`UPDATE albums SET game_id = ? WHERE id = ?`, gid, r.id)
            if (r.game_id != null) touched.add(r.game_id)
          }
          touched.add(gid)
        }
      }
      for (const id of this.refreshGames([...touched])) ftsDirty.add(id)
    })
    this.updateAlbumFts([...ftsDirty])
  }

  /**
   * Recompute derived game fields from their albums (+ IGDB/SGDB overlays). Deletes empty games.
   * Returns album ids whose FTS document needs updating because game-level text changed.
   */
  refreshGames(gameIds: number[]): number[] {
    const ftsDirty: number[] = []
    const renamed: number[] = []
    if (!gameIds.length) return ftsDirty
    this.tx(() => {
      for (let i = 0; i < gameIds.length; i += 400) {
        const chunk = gameIds.slice(i, i + 400)
        const ph = chunk.map(() => '?').join(',')
        const games = new Map(this.all<GameRow>(`SELECT * FROM games WHERE id IN (${ph})`, ...chunk).map((g) => [g.id, g]))
        const albums = this.all<{
          id: number
          game_id: number
          title: string
          alt_titles: string
          kind: AlbumKind
          year: number | null
          cover: string | null
          platforms: string
          sort_added: number
          total_ms: number | null
          intensity: number | null
          game_key: string | null
        }>(
          `SELECT id, game_id, title, alt_titles, kind, year, cover, platforms, sort_added, total_ms, intensity, game_key FROM albums
           WHERE game_id IN (${ph}) AND gone = 0 ORDER BY kind_rank, sort_year, id`,
          ...chunk
        )
        const byGame = new Map<number, typeof albums>()
        for (const a of albums) {
          let l = byGame.get(a.game_id)
          if (!l) byGame.set(a.game_id, (l = []))
          l.push(a)
        }
        for (const id of chunk) {
          const g = games.get(id)
          if (!g) continue
          const as = byGame.get(id) ?? []
          if (!as.length) {
            this.run(`DELETE FROM games WHERE id = ?`, id)
            for (const c of this.liveGameCaches) c.delete(g.norm_key)
            continue
          }
          const igdb = j<IgdbData | null>(g.igdb_json, null)
          const sgdb = j<SgdbData | null>(g.sgdb_json, null)
          // Pinned (imported) albums don't name the game: upload titles are too noisy.
          const named = as.filter((a) => !a.game_key)
          const derived = named.length ? pickGameName(named) : ''
          const name = igdb?.name || derived || g.name
          const nameKey = keyOf(name)
          const alt: string[] = []
          const altKeys = new Set([nameKey])
          const pushAlt = (n: string | null | undefined) => {
            if (!n) return
            const k = keyOf(n)
            if (k && !altKeys.has(k)) {
              altKeys.add(k)
              alt.push(n)
            }
          }
          for (const n of igdb?.altNames ?? []) pushAlt(n)
          pushAlt(derived)
          for (const a of named) {
            pushAlt(baseTitle(a.title))
            for (const t of j<string[]>(a.alt_titles, [])) pushAlt(baseTitle(t))
          }
          const years = as.map((a) => a.year).filter((y): y is number => y != null)
          if (igdb?.year) years.push(igdb.year)
          const year = years.length ? Math.min(...years) : null
          const platformCount = new Map<string, number>()
          for (const a of as) for (const p of j<string[]>(a.platforms, [])) platformCount.set(p, (platformCount.get(p) ?? 0) + 1)
          const platforms = [...platformCount.entries()].sort((x, y) => y[1] - x[1]).map(([p]) => p)
          // Prefer the official soundtrack's art (OST > gamerip > anything), earliest release first,
          // so fan arrangements don't become the face of the game.
          const coverRank = (k: string) => (k === 'ost' ? 0 : k === 'gamerip' ? 1 : k === 'single' ? 3 : 2)
          const albumCover =
            as
              .filter((a) => a.cover)
              .sort((x, y) => coverRank(x.kind) - coverRank(y.kind) || (x.year ?? 9999) - (y.year ?? 9999))[0]?.cover ?? null
          const cover = igdb?.cover ?? sgdb?.cover ?? albumCover
          const hero = sgdb?.hero ?? igdb?.hero ?? null
          const logo = sgdb?.logo ?? null
          const franchise = igdb?.franchise ?? g.franchise_guess ?? null
          const totals = as.map((a) => a.total_ms).filter((x): x is number => x != null)
          const totalMs = totals.length ? totals.reduce((s, x) => s + x, 0) : null
          const ints = as.map((a) => a.intensity).filter((x): x is number => x != null)
          const intensity = ints.length ? ints.reduce((s, x) => s + x, 0) / ints.length : null
          const addedAt = Math.max(...as.map((a) => a.sort_added))
          const hasPrimary = as.some((a) => !MERGEABLE_KINDS.has(a.kind)) ? 1 : 0
          const altJson = JSON.stringify(alt.slice(0, 16))
          if (name !== g.name || altJson !== g.alt_names || franchise !== g.franchise) for (const a of as) ftsDirty.push(a.id)
          if (name !== g.name) renamed.push(id)
          this.run(
            `UPDATE games SET name = ?, sort_name = ?, alt_names = ?, year = ?, sort_year = ?, platforms = ?, franchise = ?, cover = ?, hero = ?, logo = ?,
               accent = CASE WHEN cover IS ? THEN accent ELSE NULL END, album_count = ?, has_primary = ?, added_at = ?, total_ms = ?, sort_len = ?,
               intensity = ?, sort_intensity = ?
             WHERE id = ?`,
            name,
            sortKey(name),
            altJson,
            year,
            year ?? UNKNOWN_YEAR,
            JSON.stringify(platforms),
            franchise,
            cover,
            hero,
            logo,
            cover,
            as.length,
            hasPrimary,
            addedAt,
            totalMs,
            totalMs ?? UNKNOWN_LEN,
            intensity,
            intensity ?? UNKNOWN_INTENSITY,
            id
          )
        }
      }
      // Track search documents carry the game name too.
      for (const id of renamed) this.updateTrackFtsForGame(id)
    })
    return ftsDirty
  }

  /**
   * Full re-cluster over every album (end of an index crawl). Runs in the catalog worker; reads are
   * paged and every loop is time-sliced (`yieldFn` at least every few ms) so Browse requests keep
   * being answered, and write transactions stay small so the main process' library writes (another
   * connection) never wait long for the lock.
   */
  async reclusterAll(yieldFn: () => Promise<void> = writerPause): Promise<void> {
    // Crawls of several sources can end together: one full pass at a time, the later one sees all
    // of the earlier one's writes.
    const run = this.reclusterQueue.then(() => this.reclusterOnce(yieldFn))
    this.reclusterQueue = run.catch(() => {})
    return run
  }
  private reclusterQueue: Promise<void> = Promise.resolve()

  private async reclusterOnce(yieldFn: () => Promise<void>): Promise<void> {
    const slice = timeSlicer(yieldFn)
    type Row = { id: number; title: string; kind: AlbumKind; game_id: number | null; game_key: string | null }
    const rows: Row[] = []
    for (let after = 0; ; ) {
      const page = this.all<Row>(`SELECT id, title, kind, game_id, game_key FROM albums WHERE gone = 0 AND id > ? ORDER BY id LIMIT 5000`, after)
      for (const r of page) rows.push(r)
      if (page.length < 5000) break
      after = page[page.length - 1].id
      await slice()
    }
    const keys = new Map<number, string>()
    const primary = new Set<string>()
    for (let i = 0; i < rows.length; i++) {
      const k = rows[i].game_key ?? gameKey(rows[i].title)
      keys.set(rows[i].id, k)
      if (!MERGEABLE_KINDS.has(rows[i].kind)) primary.add(k)
      if ((i & 255) === 255) await slice()
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if ((i & 255) === 255) await slice()
      if (r.game_key || !MERGEABLE_KINDS.has(r.kind) || primary.has(keys.get(r.id)!)) continue
      const h = headKey(r.title)
      if (h && primary.has(h)) keys.set(r.id, h)
    }
    await yieldFn()
    // Every game by key, read in pages (kept in step with deletions while it lives, see refreshGames).
    const idByKey = new Map<string, number>()
    const allGames: number[] = []
    this.liveGameCaches.add(idByKey)
    const moved: number[] = []
    const touched = new Set<number>()
    const used = new Set<number>()
    try {
      for (let after = 0; ; ) {
        const page = this.all<{ id: number; norm_key: string }>(`SELECT id, norm_key FROM games WHERE id > ? ORDER BY id LIMIT 5000`, after)
        for (const g of page) {
          idByKey.set(g.norm_key, g.id)
          allGames.push(g.id)
        }
        if (page.length < 5000) break
        after = page[page.length - 1].id
        await slice()
      }
      for (let i = 0; i < rows.length; i += 1000) {
        this.tx(() => {
          for (const r of rows.slice(i, i + 1000)) {
            const gid = this.gameIdFor(keys.get(r.id)!, r.title, idByKey)
            used.add(gid)
            if (r.game_id !== gid) {
              this.run(`UPDATE albums SET game_id = ? WHERE id = ?`, gid, r.id)
              moved.push(r.id)
              if (r.game_id != null) touched.add(r.game_id)
              touched.add(gid)
            }
          }
        })
        await yieldFn()
      }
    } finally {
      this.liveGameCaches.delete(idByKey)
    }
    // Orphans (games whose albums all moved away, or that were left empty) are deleted by
    // refreshGames, which checks each candidate's albums itself (a crawl may have added some meanwhile).
    for (let i = 0; i < allGames.length; i++) {
      if (!used.has(allGames[i])) touched.add(allGames[i])
      if ((i & 4095) === 4095) await slice()
    }
    await yieldFn()
    const t = [...touched]
    const dirty = new Set<number>(moved)
    for (let i = 0; i < t.length; i += 400) {
      for (const id of this.refreshGames(t.slice(i, i + 400))) dirty.add(id)
      await yieldFn()
    }
    for (const id of await this.refreshFranchises(yieldFn)) dirty.add(id)
    const d = [...dirty]
    for (let i = 0; i < d.length; i += 400) {
      this.updateAlbumFts(d.slice(i, i + 400))
      await yieldFn()
    }
    this.setMeta('cluster_version', String(CLUSTER_VERSION))
    this.revision++
    await this.compactFts(yieldFn)
  }

  /** Heuristic franchises: a shared head ("Final Fantasy" from "Final Fantasy VI") across ≥2 games. */
  async refreshFranchises(yieldFn: () => Promise<void> = async () => {}): Promise<number[]> {
    const slice = timeSlicer(yieldFn)
    type Row = { id: number; name: string; franchise_guess: string | null; igdb_json: string | null }
    const games: Row[] = []
    for (let after = 0; ; ) {
      const page = this.all<Row>(`SELECT id, name, franchise_guess, igdb_json FROM games WHERE id > ? ORDER BY id LIMIT 5000`, after)
      for (const g of page) games.push(g)
      if (page.length < 5000) break
      after = page[page.length - 1].id
      await slice()
    }
    const byKey = new Map<string, { ids: number[]; names: Map<string, number> }>()
    const guessOf = new Map<number, string>()
    for (let i = 0; i < games.length; i++) {
      if ((i & 255) === 255) await slice()
      const g = games[i]
      const guess = franchiseGuess(g.name)
      if (!guess) continue
      const k = keyOf(guess)
      if (k.length < 3) continue
      guessOf.set(g.id, k)
      let e = byKey.get(k)
      if (!e) byKey.set(k, (e = { ids: [], names: new Map() }))
      e.ids.push(g.id)
      e.names.set(guess, (e.names.get(guess) ?? 0) + 1)
    }
    await yieldFn()
    const display = new Map<string, string>()
    for (const [k, e] of byKey) {
      if (e.ids.length < 2) continue
      const best = [...e.names.entries()].sort((a, b) => {
        const shout = (s: string) => (s === s.toUpperCase() && /\p{L}{3}/u.test(s) ? 1 : 0)
        return shout(a[0]) - shout(b[0]) || b[1] - a[1] || a[0].length - b[0].length
      })[0][0]
      display.set(k, best)
    }
    const changed: { id: number; guess: string | null; franchise: string | null }[] = []
    for (let i = 0; i < games.length; i++) {
      if ((i & 255) === 255) await slice()
      const g = games[i]
      const k = guessOf.get(g.id)
      const guess = (k && display.get(k)) || null
      if (guess === g.franchise_guess) continue
      const igdbFr = j<IgdbData | null>(g.igdb_json, null)?.franchise ?? null
      changed.push({ id: g.id, guess, franchise: igdbFr ?? guess })
    }
    for (let i = 0; i < changed.length; i += 1000) {
      this.tx(() => {
        for (const c of changed.slice(i, i + 1000)) this.run(`UPDATE games SET franchise_guess = ?, franchise = ? WHERE id = ?`, c.guess, c.franchise, c.id)
      })
      await yieldFn()
    }
    const albums: number[] = []
    for (let i = 0; i < changed.length; i += 500) {
      const c = changed.slice(i, i + 500).map((x) => x.id)
      for (const r of this.all<{ id: number }>(`SELECT id FROM albums WHERE game_id IN (${c.map(() => '?').join(',')})`, ...c)) albums.push(r.id)
      await slice()
    }
    return albums
  }

  // ---------------------------------------------------------------------------
  // full-text search documents

  updateAlbumFts(albumIds: number[]): void {
    if (!albumIds.length) return
    this.tx(() => {
      for (let i = 0; i < albumIds.length; i += 400) {
        const chunk = albumIds.slice(i, i + 400)
        const ph = chunk.map(() => '?').join(',')
        const rows = this.all<{
          id: number
          title: string
          alt_titles: string
          catalog_no: string | null
          type_label: string | null
          developers: string
          publishers: string
          composers: string
          gone: number
          game_name: string | null
          game_alt: string | null
          franchise: string | null
        }>(
          `SELECT a.id, a.title, a.alt_titles, a.catalog_no, a.type_label, a.developers, a.publishers, a.composers, a.gone,
                  g.name AS game_name, g.alt_names AS game_alt, g.franchise AS franchise
           FROM albums a LEFT JOIN games g ON g.id = a.game_id WHERE a.id IN (${ph})`,
          ...chunk
        )
        const tracksBy = new Map<number, string[]>()
        const trackComposers = new Map<number, string[]>()
        for (const t of this.all<{ album_id: number; title: string; composers: string }>(
          `SELECT album_id, title, composers FROM tracks WHERE album_id IN (${ph}) AND removed = 0 ORDER BY position`,
          ...chunk
        )) {
          let l = tracksBy.get(t.album_id)
          if (!l) tracksBy.set(t.album_id, (l = []))
          l.push(t.title)
          const tc = j<string[]>(t.composers, [])
          if (tc.length) trackComposers.set(t.album_id, [...(trackComposers.get(t.album_id) ?? []), ...tc])
        }
        const plat = new Map<number, string[]>()
        for (const p of this.all<{ album_id: number; slug: string; name: string }>(`SELECT album_id, slug, name FROM album_platforms WHERE album_id IN (${ph})`, ...chunk)) {
          let l = plat.get(p.album_id)
          if (!l) plat.set(p.album_id, (l = []))
          l.push(p.name, p.slug)
        }
        const del = this.st(`DELETE FROM album_fts WHERE rowid = ?`)
        const ins = this.st(`INSERT INTO album_fts(rowid, game, album, tracks, composers, franchise, platforms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        for (const r of rows) {
          del.run(r.id)
          if (r.gone) continue
          ins.run(
            r.id,
            ftsDoc(gameSearchNames(r.game_name, j<string[]>(r.game_alt, []))),
            ftsDoc([r.title, ...searchAliases(r.title, TITLE_ALIASES), ...j<string[]>(r.alt_titles, []), r.catalog_no, r.type_label, ...j<string[]>(r.developers, []), ...j<string[]>(r.publishers, [])]),
            ftsDoc((tracksBy.get(r.id) ?? []).flatMap((t) => [t, ...searchAliases(t)])),
            ftsDoc([...j<string[]>(r.composers, []), ...(trackComposers.get(r.id) ?? [])]),
            ftsDoc([r.franchise]),
            ftsDoc(plat.get(r.id) ?? [])
          )
        }
      }
    })
  }

  updateTrackFts(albumId: number): void {
    this.tx(() => {
      const rows = this.all<{ id: number; title: string; removed: number; composers: string; album_title: string; album_composers: string; game_name: string | null }>(
        `SELECT t.id, t.title, t.removed, t.composers, a.title AS album_title, a.composers AS album_composers, g.name AS game_name
         FROM tracks t JOIN albums a ON a.id = t.album_id LEFT JOIN games g ON g.id = a.game_id WHERE t.album_id = ?`,
        albumId
      )
      const del = this.st(`DELETE FROM track_fts WHERE rowid = ?`)
      const ins = this.st(`INSERT INTO track_fts(rowid, title, album, game, composers) VALUES (?, ?, ?, ?, ?)`)
      const first = rows[0]
      const albumDoc = first ? ftsDoc([first.album_title, ...searchAliases(first.album_title, TITLE_ALIASES)]) : ''
      const gameDoc = first ? ftsDoc(gameSearchNames(first.game_name, [])) : ''
      for (const r of rows) {
        del.run(r.id)
        if (r.removed) continue
        const comps = j<string[]>(r.composers, [])
        ins.run(r.id, ftsDoc([r.title, ...searchAliases(r.title)]), albumDoc, gameDoc, ftsDoc(comps.length ? comps : j<string[]>(r.album_composers, [])))
      }
    })
  }

  /** Refresh track FTS rows for every album of a game (after its name changed). */
  updateTrackFtsForGame(gameId: number): void {
    for (const r of this.all<{ id: number }>(`SELECT id FROM albums WHERE game_id = ? AND detail_at IS NOT NULL`, gameId)) this.updateTrackFts(r.id)
  }

  /**
   * Merge each FTS index into one segment, a little at a time (FTS5 'merge' steps of `pages` pages,
   * one short write transaction each, `pause` between them), when it has grown well past its size
   * after the last merge. Bulk rewrites (crawls, re-clusters, a search-index rebuild) leave segments
   * full of superseded entries that FTS5's automerge never folds away: on a 135k-album catalog a
   * merge shrinks album_fts from ~95 MB to ~53 MB and makes typical searches 2-5x faster (25x on a
   * cold cache). A merge rewrites the whole index (~50 MB, ~1-2 s of background work), so it waits
   * until the index (its %_idx rows, a cheap proxy for its pages) is FTS_REGROWTH times its merged
   * size, unless `force`. Returns the merge steps taken; `stop()` interrupts (the next run carries on).
   */
  async compactFts(pause: () => Promise<void> = writerPause, stop: () => boolean = () => false, opts: { force?: boolean; pages?: number } = {}): Promise<number> {
    let steps = 0
    const changes = this.st(`SELECT total_changes() AS n`)
    for (const table of ['album_fts', 'track_fts']) {
      const size = () => this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}_idx`)!.n
      const merged = Number(this.meta(`${table}:merged_size`) ?? 0)
      // (+16: an index of a few pages may double from one small write.)
      if (!opts.force && merged > 0 && size() <= merged * FTS_REGROWTH + 16) continue
      for (;;) {
        if (stop()) return steps
        const before = (changes.get() as { n: number }).n
        this.tx(() => this.run(`INSERT INTO ${table}(${table}, rank) VALUES ('merge', ?)`, -(opts.pages ?? 100)))
        steps++
        // Fewer than two rows changed: nothing was left to merge (the FTS5 documentation's test).
        if ((changes.get() as { n: number }).n - before < 2) break
        await pause()
      }
      this.setMeta(`${table}:merged_size`, String(Math.max(1, size())))
    }
    return steps
  }

  /** True when the FTS documents were written by an older search-text format (see FTS_VERSION). */
  ftsStale(): boolean {
    return this.meta('fts_version') !== String(FTS_VERSION)
  }

  /**
   * Rewrite every FTS document in small transactions (after the search-text format changed).
   * Returns false if `stop()` interrupted it; the next run starts over.
   */
  async rebuildFts(pause: () => Promise<void> = writerPause, stop: () => boolean = () => false): Promise<boolean> {
    if (!this.get(`SELECT 1 FROM albums LIMIT 1`)) {
      this.setMeta('fts_version', String(FTS_VERSION))
      return true
    }
    const albums = this.all<{ id: number }>(`SELECT id FROM albums WHERE gone = 0 ORDER BY id`).map((r) => r.id)
    for (let i = 0; i < albums.length; i += 250) {
      if (stop()) return false
      this.updateAlbumFts(albums.slice(i, i + 250))
      await pause()
    }
    const withTracks = this.all<{ id: number }>(`SELECT DISTINCT album_id AS id FROM tracks WHERE removed = 0`).map((r) => r.id)
    for (let i = 0; i < withTracks.length; i++) {
      if (stop()) return false
      this.updateTrackFts(withTracks[i])
      if (i % 20 === 19) await pause()
    }
    this.setMeta('fts_version', String(FTS_VERSION))
    await this.compactFts(pause, stop, { force: true })
    return true
  }

  // ---------------------------------------------------------------------------
  // reads

  game(gameId: number): Game | null {
    const r = this.get<GameRow>(`SELECT * FROM games WHERE id = ?`, gameId)
    return r ? toGame(r) : null
  }

  gameRow(gameId: number): GameRow | undefined {
    return this.get<GameRow>(`SELECT * FROM games WHERE id = ?`, gameId)
  }

  album(albumId: number): Album | null {
    const r = this.get<AlbumRowLite>(`SELECT ${ALBUM_COLUMNS} FROM albums a LEFT JOIN games g ON g.id = a.game_id WHERE a.id = ?`, albumId)
    return r ? toAlbum(r) : null
  }

  albumState(albumId: number): { id: number; provider: string; provider_ref: string; game_id: number | null; detail_at: number | null; cover: string | null; gone: number } | undefined {
    return this.get(`SELECT id, provider, provider_ref, game_id, detail_at, cover, gone FROM albums WHERE id = ?`, albumId)
  }

  trackRows(where: string, params: SQLInputValue[], orderLimit = ''): TrackRow[] {
    return this.all<TrackRow>(`SELECT ${TRACK_VIEW_COLUMNS} FROM ${TRACK_VIEW_FROM} WHERE ${where} ${orderLimit}`, ...params)
  }

  /** Map track rows to TrackViews (liked/downloaded false; services decorate). */
  toTrackViews(rows: TrackRow[], quality: Quality): TrackView[] {
    if (!rows.length) return []
    const sources = new Map<number, { provider: string; format: AudioFormat; lossless: number; bitrate: number | null; confidence: number; failures: number; size_bytes: number | null }[]>()
    for (let i = 0; i < rows.length; i += 500) {
      const ids = rows.slice(i, i + 500).map((r) => r.id)
      for (const s of this.all<{ track_id: number; provider: string; format: AudioFormat; lossless: number; bitrate: number | null; confidence: number; failures: number; size_bytes: number | null }>(
        `SELECT track_id, provider, format, lossless, bitrate, confidence, failures, size_bytes FROM sources WHERE track_id IN (${ids.map(() => '?').join(',')})`,
        ...ids
      )) {
        let l = sources.get(s.track_id)
        if (!l) sources.set(s.track_id, (l = []))
        l.push(s)
      }
    }
    return rows.map((r) => {
      const trackComposers = j<string[]>(r.composers, [])
      let source: SourceSummary | null = null
      const cached = sources.get(r.id)
      if (cached?.length) {
        const best = [...cached].sort((a, b) => (a.failures > 0 ? 1 : 0) - (b.failures > 0 ? 1 : 0) || formatRank(a.format, quality) - formatRank(b.format, quality))[0]
        source = {
          provider: best.provider,
          format: best.format,
          lossless: !!best.lossless,
          bitrateKbps: best.bitrate ?? (best.format === 'chip' ? null : estimateKbps(best.size_bytes, r.duration_ms)),
          confidence: best.confidence
        }
      } else {
        const files = j<ProviderTrackFile[]>(r.files, [])
        const best = [...files].sort((a, b) => formatRank(a.format, quality) - formatRank(b.format, quality))[0]
        if (best) {
          source = {
            provider: r.album_provider,
            format: best.format,
            lossless: LOSSLESS_FORMATS.has(best.format),
            bitrateKbps: best.format === 'chip' ? null : estimateKbps(best.sizeBytes, r.duration_ms),
            confidence: 1
          }
        }
      }
      return {
        id: String(r.id),
        albumId: String(r.album_id),
        disc: r.disc,
        number: r.number,
        title: r.title,
        titleOriginal: r.title_original ?? null,
        durationMs: r.duration_ms ?? null,
        composers: trackComposers.length ? trackComposers : j<string[]>(r.album_composers, []),
        albumTitle: r.album_title,
        albumKind: r.album_kind,
        gameId: r.game_id != null ? String(r.game_id) : null,
        gameName: r.game_name ?? null,
        year: r.album_year ?? r.game_year ?? null,
        platforms: j<string[]>(r.album_platforms, []),
        cover: r.album_cover ?? r.game_cover ?? null,
        hero: r.game_hero ?? null,
        accent: r.game_accent ?? null,
        liked: false,
        downloaded: false,
        source,
        analysis: r.bpm != null || r.intensity != null || r.lufs != null ? { bpm: r.bpm, intensity: r.intensity, lufs: r.lufs } : null
      }
    })
  }

  // ---------------------------------------------------------------------------
  // analysis

  recordAnalysis(trackId: number, a: OfflineAnalysisResult, cacheKey: string | null = null): void {
    this.tx(() => {
      this.run(
        `INSERT INTO analysis (track_id, cache_key, lufs, lra, true_peak, bpm, bpm_confidence, intensity, duration_ms, beats, downbeats, kiai, energy, analyzed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(track_id) DO UPDATE SET cache_key = excluded.cache_key, lufs = excluded.lufs, lra = excluded.lra, true_peak = excluded.true_peak,
           bpm = excluded.bpm, bpm_confidence = excluded.bpm_confidence, intensity = excluded.intensity, duration_ms = excluded.duration_ms,
           beats = excluded.beats, downbeats = excluded.downbeats, kiai = excluded.kiai, energy = excluded.energy, analyzed_at = excluded.analyzed_at`,
        trackId,
        cacheKey,
        a.integratedLufs,
        a.loudnessRange,
        a.truePeakDb,
        a.bpm,
        a.bpmConfidence,
        a.intensity,
        a.durationMs,
        f32(a.beats),
        f32(a.downbeats),
        f32(a.kiai.flat()),
        f32(a.energy),
        this.now()
      )
      if (a.durationMs > 0) this.run(`UPDATE tracks SET duration_ms = ? WHERE id = ? AND duration_ms IS NULL`, Math.round(a.durationMs), trackId)
      const t = this.get<{ album_id: number }>(`SELECT album_id FROM tracks WHERE id = ?`, trackId)
      if (t) {
        const avg = this.get<{ v: number | null }>(
          `SELECT AVG(an.intensity) AS v FROM tracks t JOIN analysis an ON an.track_id = t.id WHERE t.album_id = ? AND t.removed = 0 AND an.intensity IS NOT NULL`,
          t.album_id
        )?.v
        this.run(`UPDATE albums SET intensity = ?, sort_intensity = ? WHERE id = ?`, avg ?? null, avg ?? UNKNOWN_INTENSITY, t.album_id)
        const g = this.get<{ game_id: number | null }>(`SELECT game_id FROM albums WHERE id = ?`, t.album_id)
        if (g?.game_id != null) this.refreshGames([g.game_id])
      }
    })
    this.revision++
  }

  getAnalysis(trackId: number): TrackAnalysis | null {
    const r = this.get<{
      lufs: number | null
      true_peak: number | null
      bpm: number | null
      intensity: number | null
      beats: Uint8Array | null
      downbeats: Uint8Array | null
      kiai: Uint8Array | null
      energy: Uint8Array | null
    }>(`SELECT lufs, true_peak, bpm, intensity, beats, downbeats, kiai, energy FROM analysis WHERE track_id = ?`, trackId)
    if (!r) return null
    const k = unf32(r.kiai)
    const kiai: [number, number][] = []
    for (let i = 0; i + 1 < k.length; i += 2) kiai.push([k[i], k[i + 1]])
    return {
      lufs: r.lufs,
      truePeakDb: r.true_peak,
      bpm: r.bpm,
      beats: unf32(r.beats),
      downbeats: unf32(r.downbeats),
      kiai,
      energy: unf32(r.energy).map((x) => Math.round(x * 10000) / 10000),
      intensity: r.intensity
    }
  }
}
