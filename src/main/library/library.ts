// Likes, play history, the downloaded-tracks index, and TrackView decoration
// (`liked` / `downloaded` flags). Playlists live in ./playlists.ts.
import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import type { HistoryEntry, ID, Settings, TrackView } from '../../shared/types'
import type { DB } from '../db'
import type { Broadcast } from '../ipc'
import type { CatalogService } from '../catalog'
import { DownloadsRepo } from './downloads-repo'
import { ensureLibrarySchema } from './schema'

/** The slice of the catalog the library needs. */
export type LibraryCatalog = Pick<CatalogService, 'tracks' | 'queryTrackIds' | 'resolveSources'>

export interface LibraryDeps {
  db: DB
  catalog: LibraryCatalog
  broadcast: Broadcast
  getSettings: () => Settings
  now?: () => number
  fileExists?: (path: string) => boolean
}

export type TracksChangedListener = (trackIds: ID[]) => void

export class Library {
  readonly db: DB
  readonly downloads: DownloadsRepo
  private readonly catalog: LibraryCatalog
  private readonly broadcast: Broadcast
  readonly getSettings: () => Settings
  readonly now: () => number
  readonly fileExists: (path: string) => boolean
  private likedSet = new Set<ID>()
  private downloadedMap = new Map<ID, { path: string; at: number }>()
  private listeners = new Set<TracksChangedListener>()

  constructor(deps: LibraryDeps) {
    this.db = deps.db
    this.catalog = deps.catalog
    this.broadcast = deps.broadcast
    this.getSettings = deps.getSettings
    this.now = deps.now ?? Date.now
    this.fileExists = deps.fileExists ?? existsSync
    ensureLibrarySchema(this.db)
    this.downloads = new DownloadsRepo(this.db)
    for (const r of this.db.prepare('SELECT track_id FROM likes').all() as { track_id: string }[]) this.likedSet.add(r.track_id)
    this.downloadedMap = this.downloads.donePaths()
  }

  // ---------------------------------------------------------------------------
  // decoration

  isLiked(trackId: ID): boolean {
    return this.likedSet.has(trackId)
  }

  isDownloaded(trackId: ID): boolean {
    return this.downloadedMap.has(trackId)
  }

  /** Local file for a downloaded track, if it still exists on disk. */
  downloadedPath(trackId: ID): string | null {
    const d = this.downloadedMap.get(trackId)
    if (!d) return null
    return this.fileExists(d.path) ? d.path : null
  }

  decorateOne<T extends TrackView>(t: T): T {
    const liked = this.likedSet.has(t.id)
    const downloaded = this.downloadedMap.has(t.id)
    return t.liked === liked && t.downloaded === downloaded ? t : { ...t, liked, downloaded }
  }

  decorate<T extends TrackView>(tracks: T[]): T[] {
    return tracks.map((t) => this.decorateOne(t))
  }

  /** Fetch tracks in the given order (duplicates kept, unknown ids dropped), decorated. */
  async fetchTracks(ids: ID[]): Promise<TrackView[]> {
    if (ids.length === 0) return []
    const unique = [...new Set(ids)]
    const map = new Map<ID, TrackView>()
    // Chunks in flight together: the worker answers one while this thread takes in the previous.
    const chunks: Promise<TrackView[]>[] = []
    for (let i = 0; i < unique.length; i += 500) chunks.push(this.catalog.tracks(unique.slice(i, i + 500)))
    for (const chunk of await Promise.all(chunks)) for (const t of chunk) map.set(t.id, t)
    const out: TrackView[] = []
    for (const id of ids) {
      const t = map.get(id)
      if (t) out.push(this.decorateOne(t))
    }
    return out
  }

  onTracksChanged(cb: TracksChangedListener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private tracksChanged(ids: ID[]): void {
    for (const l of this.listeners) {
      try {
        l(ids)
      } catch (e) {
        console.error('[library] listener failed:', e)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // likes

  toggleLike(trackId: ID): boolean {
    const liked = !this.likedSet.has(trackId)
    if (liked) {
      this.db.prepare('INSERT OR REPLACE INTO likes (track_id, at) VALUES (?, ?)').run(trackId, this.now())
      this.likedSet.add(trackId)
    } else {
      this.db.prepare('DELETE FROM likes WHERE track_id = ?').run(trackId)
      this.likedSet.delete(trackId)
    }
    this.broadcast('library:changed', { kind: 'likes', id: trackId })
    this.tracksChanged([trackId])
    return liked
  }

  async liked(): Promise<TrackView[]> {
    const ids = (this.db.prepare('SELECT track_id FROM likes ORDER BY at DESC').all() as { track_id: string }[]).map((r) => r.track_id)
    return this.fetchTracks(ids)
  }

  likedIds(): ID[] {
    return [...this.likedSet]
  }

  // ---------------------------------------------------------------------------
  // history

  /** Insert a play; returns the row id so the final ms_played can be updated later. */
  recordPlay(trackId: ID, playedAt: number, msPlayed: number): number {
    const r = this.db.prepare('INSERT INTO history (track_id, played_at, ms_played) VALUES (?, ?, ?)').run(trackId, playedAt, Math.round(msPlayed))
    this.broadcast('library:changed', { kind: 'history', id: trackId })
    return Number(r.lastInsertRowid)
  }

  updatePlay(rowId: number, msPlayed: number): void {
    this.db.prepare('UPDATE history SET ms_played = ? WHERE id = ?').run(Math.round(msPlayed), rowId)
  }

  async history(limit = 100): Promise<HistoryEntry[]> {
    const rows = this.db
      .prepare('SELECT track_id, played_at, ms_played FROM history ORDER BY played_at DESC, id DESC LIMIT ?')
      .all(Math.max(1, Math.min(5000, Math.floor(limit)))) as { track_id: string; played_at: number; ms_played: number }[]
    const tracks = await this.fetchTracks([...new Set(rows.map((r) => r.track_id))])
    const byId = new Map(tracks.map((t) => [t.id, t]))
    const out: HistoryEntry[] = []
    for (const r of rows) {
      const track = byId.get(r.track_id)
      if (track) out.push({ track, playedAt: r.played_at, msPlayed: r.ms_played })
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // downloaded

  /** Called by the download manager when a file has been written. */
  noteDownloaded(trackId: ID, path: string): void {
    this.downloadedMap.set(trackId, { path, at: this.now() })
    this.broadcast('library:changed', { kind: 'downloaded', id: trackId })
    this.tracksChanged([trackId])
  }

  /** Drop the downloaded record for a track whose file disappeared. */
  forgetDownloaded(trackId: ID): void {
    const d = this.downloadedMap.get(trackId)
    if (!d) return
    this.downloads.forgetDone(trackId, d.path)
    this.downloadedMap = this.downloads.donePaths()
    this.broadcast('library:changed', { kind: 'downloaded', id: trackId })
    this.tracksChanged([trackId])
  }

  /**
   * Which of `paths` exist. The real check runs in parallel on libuv's pool: a synchronous stat of
   * every downloaded file, on the thread that also delivers window input, stalled the opening of a
   * Downloaded view of thousands of files (tests inject a synchronous check).
   */
  private async existing(paths: string[]): Promise<boolean[]> {
    if (this.fileExists !== existsSync) return paths.map((p) => this.fileExists(p))
    const out: boolean[] = []
    for (let i = 0; i < paths.length; i += 64) {
      out.push(...(await Promise.all(paths.slice(i, i + 64).map((p) => access(p).then(() => true, () => false)))))
    }
    return out
  }

  async downloaded(): Promise<TrackView[]> {
    const entries = [...this.downloadedMap.entries()].sort((a, b) => b[1].at - a[1].at)
    const exists = await this.existing(entries.map(([, d]) => d.path))
    // Files moved or deleted outside the app: stop claiming they're downloaded. Only entries still
    // current: a download that finished during the checks (or an overlapping call that already
    // pruned) replaced them, and a replacement's own file is checked next time.
    const gone = entries.filter(([id, d], i) => !exists[i] && this.downloadedMap.get(id) === d)
    if (gone.length) {
      this.downloads.batch(() => {
        for (const [id, d] of gone) this.downloads.forgetDone(id, d.path)
      })
      this.downloadedMap = this.downloads.donePaths()
      const ids = gone.map(([id]) => id)
      // One event for the lot: Browse and the library views refetch on it.
      this.broadcast('library:changed', ids.length === 1 ? { kind: 'downloaded', id: ids[0] } : { kind: 'downloaded' })
      this.tracksChanged(ids)
    }
    return this.fetchTracks(entries.filter((_, i) => exists[i]).map(([id]) => id))
  }
}
