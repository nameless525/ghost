// Persistence for the `downloads` table: the download queue (survives restarts) and the
// record of finished downloads (drives TrackView.downloaded and local-file playback).
import type { DownloadItem, DownloadStatus, ID } from '../../shared/types'
import type { DB } from '../db'

export interface DownloadRecord extends DownloadItem {
  format: string | null
  /** Groups items enqueued together (album/playlist) for aggregate notifications. */
  batch: string | null
  finishedAt: number | null
}

interface Row {
  id: string
  track_id: string
  path: string | null
  format: string | null
  status: string
  bytes: number
  total_bytes: number | null
  error: string | null
  title: string
  game_name: string | null
  album_title: string
  cover: string | null
  batch: string | null
  cleared: number
  created_at: number
  updated_at: number
  finished_at: number | null
}

const ACTIVE: DownloadStatus[] = ['queued', 'resolving', 'downloading', 'tagging']

function fromRow(r: Row): DownloadRecord {
  return {
    id: r.id,
    trackId: r.track_id,
    title: r.title,
    gameName: r.game_name,
    albumTitle: r.album_title,
    cover: r.cover,
    status: r.status as DownloadStatus,
    progress: r.status === 'done' ? 1 : r.total_bytes ? Math.min(1, r.bytes / r.total_bytes) : 0,
    bytes: r.bytes,
    totalBytes: r.total_bytes,
    path: r.path,
    error: r.error,
    createdAt: r.created_at,
    format: r.format,
    batch: r.batch,
    finishedAt: r.finished_at
  }
}

export class DownloadsRepo {
  constructor(private readonly db: DB) {}

  insert(rec: DownloadRecord): void {
    this.db
      .prepare(
        `INSERT INTO downloads (id, track_id, path, format, status, bytes, total_bytes, error, title, game_name, album_title, cover, batch, cleared, created_at, updated_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      .run(rec.id, rec.trackId, rec.path, rec.format, rec.status, rec.bytes, rec.totalBytes, rec.error, rec.title, rec.gameName, rec.albumTitle, rec.cover, rec.batch, rec.createdAt, Date.now(), rec.finishedAt)
  }

  /** Persist the mutable fields of a record. */
  save(rec: DownloadRecord): void {
    this.db
      .prepare(
        `UPDATE downloads SET path = ?, format = ?, status = ?, bytes = ?, total_bytes = ?, error = ?, title = ?, game_name = ?, album_title = ?, cover = ?, updated_at = ?, finished_at = ? WHERE id = ?`
      )
      .run(rec.path, rec.format, rec.status, Math.round(rec.bytes), rec.totalBytes, rec.error, rec.title, rec.gameName, rec.albumTitle, rec.cover, Date.now(), rec.finishedAt, rec.id)
  }

  get(id: ID): DownloadRecord | null {
    const r = this.db.prepare('SELECT * FROM downloads WHERE id = ?').get(id) as Row | undefined
    return r ? fromRow(r) : null
  }

  /** Items shown in the Downloads overlay, newest first. */
  visible(): DownloadRecord[] {
    return (this.db.prepare('SELECT * FROM downloads WHERE cleared = 0 ORDER BY created_at DESC, rowid ASC').all() as unknown as Row[]).map(fromRow)
  }

  /** Items that still need work (resumed on restart), oldest first. */
  unfinished(): DownloadRecord[] {
    const ph = ACTIVE.map(() => '?').join(',')
    return (this.db.prepare(`SELECT * FROM downloads WHERE status IN (${ph}) ORDER BY created_at ASC, rowid ASC`).all(...ACTIVE) as unknown as Row[]).map(fromRow)
  }

  /** Hide finished items from the overlay. Done rows are kept (they record what's downloaded). */
  clearFinished(): void {
    this.db.prepare(`DELETE FROM downloads WHERE status IN ('error', 'canceled')`).run()
    this.db.prepare(`UPDATE downloads SET cleared = 1 WHERE status = 'done'`).run()
  }

  /** Latest finished download path per track. */
  donePaths(): Map<ID, { path: string; at: number }> {
    const rows = this.db
      .prepare(`SELECT track_id, path, COALESCE(finished_at, updated_at) AS at FROM downloads WHERE status = 'done' AND path IS NOT NULL ORDER BY at ASC`)
      .all() as { track_id: string; path: string; at: number }[]
    const out = new Map<ID, { path: string; at: number }>()
    for (const r of rows) out.set(r.track_id, { path: r.path, at: r.at })
    return out
  }

  /** Forget a finished download whose file no longer exists. */
  forgetDone(trackId: ID, path: string): void {
    this.db.prepare(`DELETE FROM downloads WHERE track_id = ? AND path = ? AND status = 'done'`).run(trackId, path)
  }
}
