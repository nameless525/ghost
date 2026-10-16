// Local albums: the albums of the user's music folders (providers/local.ts `localAlbums`) as catalog
// albums of the 'local' provider, so they show up in Browse beside everything else, join games
// through the usual clustering and play from their files (a track's locator is its path, which the
// local provider resolves like any album provider's). Matching remote albums' tracks to local
// files is unchanged: those still play from the file first.
//
// After each folder scan the albums whose files changed are rewritten, and those whose files are all
// gone are withdrawn (flagged gone, as a source's vanished album is). Ids stay stable: an album is
// keyed by its name and artist, a track by its file, and a file whose album changed (retagged) takes
// its track along to the new album, so likes, playlists and history keep pointing at it.

import { LOCAL_ID, localAlbums, type LocalLibrary } from '../providers/local'
import { BACKGROUND_TX_ROWS, timeSlicer, writerPause, type CatalogRepo } from './repo'

/** catalog_meta key: the LOCAL_ALBUMS_VERSION the local albums were last fully written with. */
export const LOCAL_ALBUMS_META = 'local_albums'
/** Bump when localAlbums' grouping changes: the next scan rewrites every local album. */
export const LOCAL_ALBUMS_VERSION = '1'

export interface LocalSyncOptions {
  /** Between albums (default: the background writer pause). */
  pause?: () => Promise<void>
  /** Albums written (and withdrawal batches) so far, of how many. */
  onProgress?: (done: number, total: number) => void
  /** Stop between albums (the next scan rewrites everything). */
  stop?: () => boolean
}

export interface LocalSyncResult {
  written: number
  withdrawn: number
}

/**
 * Bring the catalog's local albums in line with the indexed files, after a scan that read or dropped
 * `changed` paths. Everything is rewritten the first time, after a grouping change, or after a sync
 * that didn't finish. Returns null when there was nothing to do.
 */
export async function syncLocalAlbums(repo: CatalogRepo, lib: LocalLibrary, changed: Iterable<string>, opts: LocalSyncOptions = {}): Promise<LocalSyncResult | null> {
  const full = repo.meta(LOCAL_ALBUMS_META) !== LOCAL_ALBUMS_VERSION
  const paths = new Set(changed)
  if (!full && !paths.size) return null
  const albums = localAlbums(lib.rows())
  const want = new Map(albums.map((a) => [a.ref, a]))
  const live = repo.all<{ id: number; provider_ref: string; gone: number }>(`SELECT id, provider_ref, gone FROM albums WHERE provider = ?`, LOCAL_ID)
  const byRef = new Map(live.map((a) => [a.provider_ref, a]))
  const byId = new Map(live.map((a) => [a.id, a]))
  // Every local album's tracks by file (through the album index: tracks has no locator index).
  const tracksAt = new Map<string, { id: number; album_id: number; removed: number }[]>()
  for (let i = 0; i < live.length; i += 500) {
    const ids = live.slice(i, i + 500).map((a) => a.id)
    for (const t of repo.all<{ id: number; album_id: number; locator: string; removed: number }>(
      `SELECT id, album_id, locator, removed FROM tracks WHERE album_id IN (${ids.map(() => '?').join(',')})`,
      ...ids
    )) {
      let l = tracksAt.get(t.locator)
      if (!l) tracksAt.set(t.locator, (l = []))
      l.push(t)
    }
  }
  const dirty = new Set<string>()
  for (const a of albums) {
    const ex = byRef.get(a.ref)
    if (full || !ex || ex.gone || a.tracks.some((t) => paths.has(t.locator))) dirty.add(a.ref)
  }
  // Albums a changed file left (deleted, or retagged into another album).
  for (const p of paths) {
    for (const t of tracksAt.get(p) ?? []) {
      const ex = byId.get(t.album_id)
      if (ex && want.has(ex.provider_ref)) dirty.add(ex.provider_ref)
    }
  }
  const todo = albums.filter((a) => dirty.has(a.ref))
  const withdraw = live.filter((a) => !a.gone && !want.has(a.provider_ref)).map((a) => a.id)
  const batches = Math.ceil(withdraw.length / BACKGROUND_TX_ROWS)
  const total = todo.length + batches
  if (!total) {
    repo.setMeta(LOCAL_ALBUMS_META, LOCAL_ALBUMS_VERSION)
    return { written: 0, withdrawn: 0 }
  }
  // Until this finishes, a crash or stop leaves the next scan a full rewrite.
  repo.setMeta(LOCAL_ALBUMS_META, null)
  const pause = timeSlicer(opts.pause ?? writerPause)
  let done = 0
  opts.onProgress?.(0, total)
  for (const a of todo) {
    if (opts.stop?.()) return null
    repo.tx(() => {
      const [id] = repo.upsertHits([a], { initial: false })
      // Files that moved here from another local album bring their track (and its id) along.
      const own = new Set(repo.all<{ locator: string }>(`SELECT locator FROM tracks WHERE album_id = ?`, id).map((r) => r.locator))
      for (const t of a.tracks) {
        if (own.has(t.locator)) continue
        const prev = (tracksAt.get(t.locator) ?? []).filter((x) => x.album_id !== id).sort((x, y) => x.removed - y.removed || y.id - x.id)[0]
        if (!prev) continue
        repo.run(`UPDATE tracks SET album_id = ? WHERE id = ?`, id, prev.id)
        prev.album_id = id
      }
      repo.applyAlbumDetail(id, a)
    })
    opts.onProgress?.(++done, total)
    await pause()
  }
  for (let i = 0; i < withdraw.length; i += BACKGROUND_TX_ROWS) {
    if (opts.stop?.()) return null
    withdrawAlbums(repo, withdraw.slice(i, i + BACKGROUND_TX_ROWS))
    opts.onProgress?.(++done, total)
    await pause()
  }
  repo.setMeta(LOCAL_ALBUMS_META, LOCAL_ALBUMS_VERSION)
  return { written: todo.length, withdrawn: withdraw.length }
}

/** Albums whose files are all gone: hidden with their tracks (rows stay, so ids return with the files). */
function withdrawAlbums(repo: CatalogRepo, ids: number[]): void {
  repo.tx(() => {
    const games = new Set<number>()
    for (const id of ids) {
      const g = repo.get<{ game_id: number | null }>(`SELECT game_id FROM albums WHERE id = ?`, id)
      if (g?.game_id != null) games.add(g.game_id)
      repo.run(`UPDATE albums SET gone = 1 WHERE id = ?`, id)
      repo.run(`UPDATE tracks SET removed = 1 WHERE album_id = ? AND removed = 0`, id)
      repo.updateTrackFts(id)
    }
    repo.updateAlbumFts([...ids, ...repo.refreshGames([...games])])
  })
  repo.revision++
}
