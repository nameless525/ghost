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
import { baseTitle, clusterKeys, franchiseGuess, gameKey, headKey, keyOf, kindRank, MERGEABLE_KINDS, pickGameName, sortKey } from './normalize'
import { ensureCatalogSchema, UNKNOWN_INTENSITY, UNKNOWN_LEN, UNKNOWN_YEAR } from './schema'

export type Quality = Settings['sources']['quality']

/**
 * Text as stored in (and queried against) the FTS indexes: folded, punctuation → spaces.
 * Query terms go through the same function so phrases still line up.
 */
export function ftsFold(s: string): string {
  return foldText(s)
    .replace(/[^\p{L}\p{N}\p{M}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** An FTS column value: items separated by ' \n ' (so phrases can't span items), space-padded so
 * every word is preceded by a space (lets 2-character terms match as indexed word prefixes). */
export function ftsDoc(items: (string | null | undefined)[]): string {
  const parts = items.map((x) => (x ? ftsFold(x) : '')).filter(Boolean)
  return parts.length ? ` ${parts.join(' \n ')} ` : ''
}

export function j<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

const rand31 = () => Math.floor(Math.random() * 0x7fffffff)

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

export class CatalogRepo {
  private stmts = new Map<string, StatementSync>()
  private gameIdByKey: Map<string, number> | null = null
  private primaryKeys: Set<string> | null = null
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

  st(sql: string): StatementSync {
    let s = this.stmts.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmts.set(sql, s)
    }
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
    this.db.exec('BEGIN')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
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

  counts(): { games: number; albums: number; tracks: number } {
    const r = this.get<{ g: number; a: number; t: number }>(
      `SELECT (SELECT COUNT(*) FROM games) AS g, (SELECT COUNT(*) FROM albums WHERE gone = 0) AS a, (SELECT COUNT(*) FROM tracks WHERE removed = 0) AS t`
    )!
    return { games: r.g, albums: r.a, tracks: r.t }
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
   * Returns the album ids (in input order).
   */
  upsertHits(hits: AlbumHit[], opts: { initial: boolean }): number[] {
    const now = this.now()
    const ids: number[] = []
    this.tx(() => {
      for (const h of hits) {
        const ex = this.get<{ id: number; title: string; title_from_ref: number; detail_at: number | null; cover: string | null; platforms: string; added_at: number | null; catalog_no: string | null }>(
          `SELECT id, title, title_from_ref, detail_at, cover, platforms, added_at, catalog_no FROM albums WHERE provider = ? AND provider_ref = ?`,
          h.provider,
          h.ref
        )
        const platformNames = JSON.stringify(h.platforms.map((p) => p.name))
        if (!ex) {
          const addedAt = h.addedAt ?? (opts.initial ? null : now)
          const r = this.st(
            `INSERT INTO albums (provider, provider_ref, title, title_from_ref, sort_title, kind, kind_rank, type_label, year, sort_year, platforms,
               catalog_no, cover, thumb, added_at, sort_added, first_seen, last_seen, rnd)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
            now,
            rand31()
          )
          const id = Number(r.lastInsertRowid)
          this.writePlatforms(id, h.platforms)
          ids.push(id)
          continue
        }
        const keepTitle = ex.detail_at != null || (h.titleFromRef && !ex.title_from_ref)
        const title = keepTitle ? ex.title : h.title
        const addedAt = h.addedAt ?? ex.added_at
        this.run(
          `UPDATE albums SET title = ?, title_from_ref = ?, sort_title = ?, kind = ?, kind_rank = ?, type_label = ?, year = COALESCE(?, year),
             sort_year = COALESCE(?, year, ${UNKNOWN_YEAR}), platforms = ?, catalog_no = COALESCE(?, catalog_no),
             cover = CASE WHEN detail_at IS NOT NULL AND cover IS NOT NULL THEN cover ELSE COALESCE(?, cover) END,
             thumb = COALESCE(thumb, ?), added_at = ?, sort_added = ?, last_seen = ?, gone = 0
           WHERE id = ?`,
          title,
          keepTitle ? ex.title_from_ref : h.titleFromRef ? 1 : 0,
          sortKey(title),
          h.kind,
          kindRank(h.kind),
          h.typeLabel,
          h.year,
          h.year,
          platformNames,
          h.catalogNo,
          h.cover,
          h.thumb,
          addedAt,
          addedAt ?? 0,
          now,
          ex.id
        )
        if (ex.platforms !== platformNames) this.writePlatforms(ex.id, h.platforms)
        ids.push(ex.id)
      }
    })
    return ids
  }

  private writePlatforms(albumId: number, platforms: PlatformRef[]): void {
    this.run(`DELETE FROM album_platforms WHERE album_id = ?`, albumId)
    for (const p of platforms) {
      this.run(`INSERT OR IGNORE INTO album_platforms(album_id, slug, name, name_fold) VALUES (?, ?, ?, ?)`, albumId, p.slug, p.name, foldText(p.name))
    }
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
    const now = this.now()
    const totalMs = d.tracks.reduce((s, t) => s + (t.durationMs ?? 0), 0) || null
    this.tx(() => {
      const prev = this.get<{ platforms: string; cover: string | null; year: number | null; added_at: number | null }>(`SELECT platforms, cover, year, added_at FROM albums WHERE id = ?`, albumId)
      if (!prev) throw new Error(`album ${albumId} vanished`)
      const platforms = d.platforms.length ? d.platforms : null
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
        JSON.stringify(d.composers),
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
      this.writeComposers(albumId, d.composers)

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
            JSON.stringify(t.composers),
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
            JSON.stringify(t.composers),
            t.locator,
            files
          )
        }
      })
      for (const [loc, id] of existing) if (!seen.has(loc)) this.run(`UPDATE tracks SET removed = 1 WHERE id = ?`, id)
    })
    this.assignGames([albumId])
    this.updateTrackFts(albumId)
    this.revision++
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

  private loadGameMaps(): void {
    if (this.gameIdByKey && this.primaryKeys) return
    this.gameIdByKey = new Map()
    this.primaryKeys = new Set()
    for (const r of this.all<{ id: number; norm_key: string; has_primary: number }>(`SELECT id, norm_key, has_primary FROM games`)) {
      this.gameIdByKey.set(r.norm_key, r.id)
      if (r.has_primary) this.primaryKeys.add(r.norm_key)
    }
  }

  private gameIdFor(key: string, seedTitle: string): number {
    this.loadGameMaps()
    const id = this.gameIdByKey!.get(key)
    if (id != null) return id
    const name = baseTitle(seedTitle) || seedTitle
    const r = this.st(`INSERT INTO games (norm_key, name, sort_name, rnd) VALUES (?, ?, ?, ?)`).run(key, name, sortKey(name), rand31())
    const nid = Number(r.lastInsertRowid)
    this.gameIdByKey!.set(key, nid)
    return nid
  }

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
      this.loadGameMaps()
      const existed = this.gameIdByKey!.has(key)
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
    this.loadGameMaps()
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
        for (const r of rows) if (!MERGEABLE_KINDS.has(r.kind)) this.primaryKeys!.add(r.game_key ?? gameKey(r.title))
        const keys = clusterKeys(rows, this.primaryKeys!)
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
    this.loadGameMaps()
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
            this.gameIdByKey!.delete(g.norm_key)
            this.primaryKeys!.delete(g.norm_key)
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
          if (hasPrimary) this.primaryKeys!.add(g.norm_key)
          else this.primaryKeys!.delete(g.norm_key)
        }
      }
      // Track search documents carry the game name too.
      for (const id of renamed) this.updateTrackFtsForGame(id)
    })
    return ftsDirty
  }

  /**
   * Full re-cluster over every album (end of an index crawl). Yields between chunks so the main
   * process stays responsive.
   */
  async reclusterAll(yieldFn: () => Promise<void> = () => new Promise((r) => setImmediate(r))): Promise<void> {
    const rows = this.all<{ id: number; title: string; kind: AlbumKind; game_id: number | null; game_key: string | null }>(
      `SELECT id, title, kind, game_id, game_key FROM albums WHERE gone = 0`
    )
    const keys = new Map<number, string>()
    const primary = new Set<string>()
    for (let i = 0; i < rows.length; i++) {
      const k = rows[i].game_key ?? gameKey(rows[i].title)
      keys.set(rows[i].id, k)
      if (!MERGEABLE_KINDS.has(rows[i].kind)) primary.add(k)
      if (i % 4000 === 3999) await yieldFn()
    }
    for (const r of rows) {
      if (r.game_key || !MERGEABLE_KINDS.has(r.kind) || primary.has(keys.get(r.id)!)) continue
      const h = headKey(r.title)
      if (h && primary.has(h)) keys.set(r.id, h)
    }
    await yieldFn()
    const moved: number[] = []
    const touched = new Set<number>()
    for (let i = 0; i < rows.length; i += 2000) {
      this.tx(() => {
        for (const r of rows.slice(i, i + 2000)) {
          const gid = this.gameIdFor(keys.get(r.id)!, r.title)
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
    // Orphans (games whose albums all moved away) are deleted by refreshGames.
    for (const r of this.all<{ id: number }>(`SELECT g.id FROM games g WHERE NOT EXISTS (SELECT 1 FROM albums a WHERE a.game_id = g.id AND a.gone = 0)`)) touched.add(r.id)
    const t = [...touched]
    const dirty = new Set<number>(moved)
    for (let i = 0; i < t.length; i += 1000) {
      for (const id of this.refreshGames(t.slice(i, i + 1000))) dirty.add(id)
      await yieldFn()
    }
    for (const id of await this.refreshFranchises(yieldFn)) dirty.add(id)
    const d = [...dirty]
    for (let i = 0; i < d.length; i += 1000) {
      this.updateAlbumFts(d.slice(i, i + 1000))
      await yieldFn()
    }
    this.revision++
  }

  /** Heuristic franchises: a shared head ("Final Fantasy" from "Final Fantasy VI") across ≥2 games. */
  async refreshFranchises(yieldFn: () => Promise<void> = async () => {}): Promise<number[]> {
    const games = this.all<{ id: number; name: string; franchise_guess: string | null; igdb_json: string | null }>(`SELECT id, name, franchise_guess, igdb_json FROM games`)
    const byKey = new Map<string, { ids: number[]; names: Map<string, number> }>()
    const guessOf = new Map<number, string>()
    for (const g of games) {
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
    const changed: number[] = []
    this.tx(() => {
      for (const g of games) {
        const k = guessOf.get(g.id)
        const guess = (k && display.get(k)) || null
        if (guess === g.franchise_guess) continue
        changed.push(g.id)
        const igdbFr = j<IgdbData | null>(g.igdb_json, null)?.franchise ?? null
        this.run(`UPDATE games SET franchise_guess = ?, franchise = ? WHERE id = ?`, guess, igdbFr ?? guess, g.id)
      }
    })
    const albums: number[] = []
    for (let i = 0; i < changed.length; i += 500) {
      const c = changed.slice(i, i + 500)
      for (const r of this.all<{ id: number }>(`SELECT id FROM albums WHERE game_id IN (${c.map(() => '?').join(',')})`, ...c)) albums.push(r.id)
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
            ftsDoc([r.game_name, ...j<string[]>(r.game_alt, [])]),
            ftsDoc([r.title, ...j<string[]>(r.alt_titles, []), r.catalog_no, r.type_label, ...j<string[]>(r.developers, []), ...j<string[]>(r.publishers, [])]),
            ftsDoc(tracksBy.get(r.id) ?? []),
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
      for (const r of rows) {
        del.run(r.id)
        if (r.removed) continue
        const comps = j<string[]>(r.composers, [])
        ins.run(r.id, ftsDoc([r.title]), ftsDoc([r.album_title]), ftsDoc([r.game_name]), ftsDoc(comps.length ? comps : j<string[]>(r.album_composers, [])))
      }
    })
  }

  /** Refresh track FTS rows for every album of a game (after its name changed). */
  updateTrackFtsForGame(gameId: number): void {
    for (const r of this.all<{ id: number }>(`SELECT id FROM albums WHERE game_id = ? AND detail_at IS NOT NULL`, gameId)) this.updateTrackFts(r.id)
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
