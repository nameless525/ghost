// Manual and smart playlists. Manual playlists store ordered items with stable uids;
// smart playlists store a search query evaluated through the catalog on read.
import { randomUUID } from 'node:crypto'
import type { PlaylistsAPI } from '../../shared/api'
import type { ID, Playlist, PlaylistDetail, PlaylistItem, TrackView } from '../../shared/types'
import { tx } from '../db'
import type { Broadcast } from '../ipc'
import type { Library, LibraryCatalog } from './library'
import { expandHome } from '../downloads/naming'
import { exportPlaylistM3U } from './m3u'

/** Max tracks a smart playlist evaluates to. */
export const SMART_LIMIT = 1000

interface PlaylistRow {
  id: string
  name: string
  description: string | null
  kind: 'manual' | 'smart'
  query: string | null
  created_at: number
  updated_at: number
}

interface ItemRow {
  uid: string
  track_id: string
  position: number
  added_at: number
}

export class PlaylistNotFoundError extends Error {
  constructor(id: string) {
    super(`Playlist not found: ${id}`)
  }
}

export class Playlists implements PlaylistsAPI {
  constructor(
    private readonly lib: Library,
    private readonly catalog: LibraryCatalog,
    private readonly broadcast: Broadcast
  ) {}

  private get db() {
    return this.lib.db
  }

  private row(id: ID): PlaylistRow {
    const r = this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as PlaylistRow | undefined
    if (!r) throw new PlaylistNotFoundError(id)
    return r
  }

  private items(id: ID): ItemRow[] {
    return this.db.prepare('SELECT uid, track_id, position, added_at FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC, rowid ASC').all(id) as unknown as ItemRow[]
  }

  private touch(id: ID): void {
    this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(this.lib.now(), id)
  }

  private changed(id: ID): void {
    this.broadcast('library:changed', { kind: 'playlists', id })
  }

  private async smartIds(query: string | null): Promise<ID[]> {
    if (!query?.trim()) return []
    try {
      return [...new Set(await this.catalog.queryTrackIds(query, SMART_LIMIT))]
    } catch (e) {
      console.warn('[playlists] smart query failed:', query, e)
      return []
    }
  }

  /** Track ids of a playlist in order (smart playlists are evaluated now). */
  async trackIds(id: ID): Promise<ID[]> {
    const r = this.row(id)
    return r.kind === 'smart' ? this.smartIds(r.query) : this.items(id).map((i) => i.track_id)
  }

  private meta(r: PlaylistRow, tracks: TrackView[]): Playlist {
    const covers: string[] = []
    for (const t of tracks) {
      if (t.cover && !covers.includes(t.cover)) covers.push(t.cover)
      if (covers.length === 4) break
    }
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      kind: r.kind,
      query: r.query,
      trackCount: tracks.length,
      durationMs: tracks.reduce((s, t) => s + (t.durationMs ?? 0), 0),
      covers,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }

  private async metaFor(id: ID): Promise<Playlist> {
    const r = this.row(id)
    return this.meta(r, await this.lib.fetchTracks(await this.trackIds(id)))
  }

  // ---------------------------------------------------------------------------
  // PlaylistsAPI

  async list(): Promise<Playlist[]> {
    const rows = this.db.prepare('SELECT * FROM playlists ORDER BY updated_at DESC, created_at DESC').all() as unknown as PlaylistRow[]
    const idsByPl = new Map<ID, ID[]>()
    // Smart playlists' queries go to the catalog worker together, not one round-trip after another.
    const smart = await Promise.all(rows.map((r) => (r.kind === 'smart' ? this.smartIds(r.query) : Promise.resolve([] as ID[]))))
    rows.forEach((r, i) => idsByPl.set(r.id, smart[i]))
    const items = this.db.prepare('SELECT playlist_id, track_id FROM playlist_items ORDER BY playlist_id, position ASC, rowid ASC').all() as { playlist_id: string; track_id: string }[]
    for (const it of items) idsByPl.get(it.playlist_id)?.push(it.track_id)
    const all = [...new Set([...idsByPl.values()].flat())]
    const tracks = new Map((await this.lib.fetchTracks(all)).map((t) => [t.id, t]))
    return rows.map((r) => this.meta(r, (idsByPl.get(r.id) ?? []).map((tid) => tracks.get(tid)).filter((t): t is TrackView => !!t)))
  }

  async get(id: ID): Promise<PlaylistDetail> {
    const r = this.row(id)
    if (r.kind === 'smart') {
      const tracks = await this.lib.fetchTracks(await this.smartIds(r.query))
      const items: PlaylistItem[] = tracks.map((track) => ({ uid: `smart:${track.id}`, track, addedAt: r.updated_at }))
      return { playlist: this.meta(r, tracks), items }
    }
    const rows = this.items(id)
    const tracks = new Map((await this.lib.fetchTracks(rows.map((i) => i.track_id))).map((t) => [t.id, t]))
    const items: PlaylistItem[] = []
    for (const it of rows) {
      const track = tracks.get(it.track_id)
      if (track) items.push({ uid: it.uid, track, addedAt: it.added_at })
    }
    return { playlist: this.meta(r, items.map((i) => i.track)), items }
  }

  async create(name: string, opts?: { query?: string; trackIds?: ID[]; description?: string }): Promise<Playlist> {
    const id = randomUUID()
    const now = this.lib.now()
    const query = opts?.query?.trim() || null
    tx(this.db, () => {
      this.db
        .prepare('INSERT INTO playlists (id, name, description, kind, query, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, cleanName(name), opts?.description?.trim() || null, query ? 'smart' : 'manual', query, now, now)
      if (!query && opts?.trackIds?.length) this.insertItems(id, opts.trackIds, 0, now)
    })
    this.changed(id)
    return this.metaFor(id)
  }

  async update(id: ID, patch: { name?: string; description?: string | null; query?: string | null }): Promise<Playlist> {
    const r = this.row(id)
    const now = this.lib.now()
    let materialize: ID[] | null = null
    if (patch.query !== undefined && r.kind === 'smart' && !patch.query?.trim()) {
      // Turning a smart playlist into a manual one keeps what it currently contains.
      materialize = await this.smartIds(r.query)
    }
    tx(this.db, () => {
      if (patch.name !== undefined) this.db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(cleanName(patch.name), id)
      if (patch.description !== undefined) this.db.prepare('UPDATE playlists SET description = ? WHERE id = ?').run(patch.description?.trim() || null, id)
      if (patch.query !== undefined) {
        const q = patch.query?.trim() || null
        if (q) {
          this.db.prepare("UPDATE playlists SET kind = 'smart', query = ? WHERE id = ?").run(q, id)
          this.db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id)
        } else {
          this.db.prepare("UPDATE playlists SET kind = 'manual', query = NULL WHERE id = ?").run(id)
          if (materialize) this.insertItems(id, materialize, 0, now)
        }
      }
      this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, id)
    })
    this.changed(id)
    return this.metaFor(id)
  }

  async delete(id: ID): Promise<void> {
    tx(this.db, () => {
      this.db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id)
      this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
    })
    this.changed(id)
  }

  async duplicate(id: ID): Promise<Playlist> {
    const r = this.row(id)
    const name = `${r.name} (copy)`
    if (r.kind === 'smart') return this.create(name, { query: r.query ?? undefined, description: r.description ?? undefined })
    return this.create(name, { trackIds: this.items(id).map((i) => i.track_id), description: r.description ?? undefined })
  }

  async addTracks(id: ID, trackIds: ID[], position?: number): Promise<void> {
    const r = this.row(id)
    if (r.kind === 'smart') throw new Error('Smart playlists are defined by their search query; edit the query instead.')
    if (!trackIds.length) return
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(id) as { n: number }).n
    const at = position === undefined || position === null ? count : Math.max(0, Math.min(count, Math.floor(position)))
    tx(this.db, () => {
      this.db.prepare('UPDATE playlist_items SET position = position + ? WHERE playlist_id = ? AND position >= ?').run(trackIds.length, id, at)
      this.insertItems(id, trackIds, at, this.lib.now())
      this.touch(id)
    })
    this.changed(id)
    // An insert at a position is an undo (putting removed tracks back), not "Add to playlist":
    // one notice per restored track used to pile up.
    if (position === undefined || position === null)
      this.broadcast('notify', {
        id: `pl-add-${id}-${Date.now().toString(36)}`,
        kind: 'success',
        title: `Added to ${r.name}`,
        body: `${trackIds.length} track${trackIds.length === 1 ? '' : 's'}`,
        ephemeral: true
      })
  }

  async removeItems(id: ID, itemUids: string[]): Promise<void> {
    const r = this.row(id)
    if (r.kind === 'smart') throw new Error('Smart playlists are defined by their search query; edit the query instead.')
    const remove = new Set(itemUids)
    tx(this.db, () => {
      const del = this.db.prepare('DELETE FROM playlist_items WHERE uid = ? AND playlist_id = ?')
      for (const uid of remove) del.run(uid, id)
      this.renumber(id)
      this.touch(id)
    })
    this.changed(id)
  }

  async moveItem(id: ID, from: number, to: number): Promise<void> {
    const r = this.row(id)
    if (r.kind === 'smart') throw new Error('Smart playlists are ordered by their query.')
    const rows = this.items(id)
    if (from < 0 || from >= rows.length) return
    const dest = Math.max(0, Math.min(rows.length - 1, to))
    if (dest === from) return
    const [moved] = rows.splice(from, 1)
    rows.splice(dest, 0, moved)
    tx(this.db, () => {
      const upd = this.db.prepare('UPDATE playlist_items SET position = ? WHERE uid = ?')
      rows.forEach((it, i) => {
        if (it.position !== i) upd.run(i, it.uid)
      })
      this.touch(id)
    })
    this.changed(id)
  }

  async exportM3U(id: ID): Promise<string> {
    const detail = await this.get(id)
    return exportPlaylistM3U({
      name: detail.playlist.name,
      tracks: detail.items.map((i) => i.track),
      dir: expandHome(this.lib.getSettings().library.downloadDir),
      localPath: (tid) => this.lib.downloadedPath(tid),
      resolve: async (tid) => (await this.catalog.resolveSources(tid, { quality: this.lib.getSettings().sources.quality }))[0] ?? null
    })
  }

  // ---------------------------------------------------------------------------

  private insertItems(id: ID, trackIds: ID[], startPos: number, addedAt: number): void {
    const ins = this.db.prepare('INSERT INTO playlist_items (uid, playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?, ?)')
    trackIds.forEach((tid, i) => ins.run(randomUUID(), id, tid, startPos + i, addedAt))
  }

  private renumber(id: ID): void {
    const upd = this.db.prepare('UPDATE playlist_items SET position = ? WHERE uid = ?')
    this.items(id).forEach((it, i) => {
      if (it.position !== i) upd.run(i, it.uid)
    })
  }
}

function cleanName(name: string): string {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim()
  return n.slice(0, 200) || 'Untitled playlist'
}
