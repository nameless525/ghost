// Shared track/album actions so Browse, Play and Library behave identically:
// play / queue / like / download / add-to-playlist, plus ready-made context-menu item lists.
//
// Menu wording is the app's shared vocabulary, in this order everywhere: Play · Play next ·
// Add to queue · Add to playlist | Like (Liked) · Download (Downloaded) | extras.
// Key hints only with `keys: true`, where those keys really act on what the menu is for (Browse's
// selection, a focused Library track list); elsewhere they'd promise something that doesn't happen.
import { CircleCheck, Download, Heart, ListEnd, ListPlus, ListStart, Play, Plus } from 'lucide-react'
import { create } from 'zustand'
import type { ID, PlayContext, Playlist, TrackView } from '@shared/types'
import { ghost } from '../ghost'
import { notify } from '../shell/notifications'
import type { MenuItem } from '../ui/ContextMenu'
import { promptDialog } from '../ui/Dialog'

// ---------------------------------------------------------------------------
// Playlist cache (for synchronous menus)

interface PlaylistCache {
  playlists: Playlist[]
  loaded: boolean
}
export const usePlaylistCache = create<PlaylistCache>(() => ({ playlists: [], loaded: false }))

let cacheInit = false
export function initPlaylistCache(): void {
  if (cacheInit) return
  cacheInit = true
  // Bursts of changes (reorders, multi-track undo) refetch once; a slower older response never
  // overwrites a newer one.
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const load = () => {
    const my = ++seq
    ghost()
      .library.playlists.list()
      .then((playlists) => my === seq && usePlaylistCache.setState({ playlists, loaded: true }))
      .catch((err: unknown) => console.warn('[playlists] list failed', err))
  }
  load()
  ghost().on('library:changed', (e) => {
    if (e.kind !== 'playlists') return
    clearTimeout(timer)
    timer = setTimeout(load, 80)
  })
}

// ---------------------------------------------------------------------------
// Actions

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** What a notice names: the track (or album / playlist) when given, else "3 tracks". */
const what = (ids: ID[], label?: string) => (label && ids.length === 1 ? label : label ? `${label} · ${plural(ids.length, 'track')}` : plural(ids.length, 'track'))

export const trackActions = {
  play(trackIds: ID[], startIndex = 0, context?: PlayContext) {
    return ghost().player.playTracks(trackIds, startIndex, context)
  },
  playAlbum(albumId: ID, startIndex = 0) {
    return ghost().player.playAlbum(albumId, startIndex)
  },
  /** `label` names what was queued in the notice (a track title, an album). */
  async playNext(trackIds: ID[], label?: string) {
    await ghost().player.enqueue(trackIds, 'next')
    notify({ kind: 'info', title: 'Playing next', body: what(trackIds, label), ephemeral: true })
  },
  async addToQueue(trackIds: ID[], label?: string) {
    await ghost().player.enqueue(trackIds, 'end')
    notify({ kind: 'info', title: 'Added to queue', body: what(trackIds, label), ephemeral: true })
  },
  toggleLike(trackId: ID) {
    return ghost().library.toggleLike(trackId)
  },
  async download(target: { trackIds: ID[] } | { albumId: ID } | { playlistId: ID }) {
    await ghost().downloads.enqueue(target)
  },
  /**
   * Download with a notice, for menus. The downloads service already reports batches (a progress
   * card) and "Already downloaded"; a single new track said nothing at all.
   */
  async downloadWithNotice(target: { trackIds: ID[] } | { albumId: ID } | { playlistId: ID }, single?: { title: string; cover?: string | null }) {
    try {
      await ghost().downloads.enqueue(target)
      if (single) notify({ kind: 'info', title: 'Download queued', body: single.title, image: single.cover ?? null, ephemeral: true })
    } catch (err) {
      notify({ kind: 'error', title: 'Couldn’t start the download', body: err instanceof Error ? err.message : String(err) })
    }
  },
  async addToPlaylist(playlistId: ID, trackIds: ID[]) {
    await ghost().library.playlists.addTracks(playlistId, trackIds)
  },
  async newPlaylistWith(trackIds: ID[]): Promise<Playlist | null> {
    const name = await promptDialog({
      title: 'New playlist',
      label: 'Name',
      defaultValue: '',
      validate: (v) => (v.trim() ? null : 'Enter a name')
    })
    if (!name) return null
    const p = await ghost().library.playlists.create(name.trim(), { trackIds })
    notify({ kind: 'success', title: `Created ${p.name}`, body: plural(trackIds.length, 'track'), ephemeral: true })
    return p
  }
}

// ---------------------------------------------------------------------------
// Context-menu item builders

const ic = (I: typeof Play) => <I size={15} strokeWidth={2} />

/** "Add to playlist" submenu: New playlist… + every manual playlist. */
export function playlistSubmenu(trackIds: ID[]): MenuItem[] {
  initPlaylistCache()
  const manual = usePlaylistCache.getState().playlists.filter((p) => p.kind === 'manual')
  const items: MenuItem[] = [{ label: 'New playlist…', icon: ic(Plus), onSelect: () => void trackActions.newPlaylistWith(trackIds) }]
  if (manual.length) items.push({ separator: true })
  for (const p of manual) items.push({ label: p.name, onSelect: () => void trackActions.addToPlaylist(p.id, trackIds) })
  return items
}

export interface TrackMenuOptions {
  /** Tracks to play when "Play" is chosen (defaults to just this track). */
  playList?: { ids: ID[]; index: number; context?: PlayContext }
  /** Extra items appended after a separator (e.g. "Remove from playlist"). */
  extra?: MenuItem[]
  /** Show key hints (Enter, Shift+Q, Q, L, Mod+D): only where those keys act on this track. */
  keys?: boolean
}

/** "Like", or "Liked" (checked; choosing it again removes the like). */
export function likeItem(liked: boolean, onSelect: () => void, shortcut?: string): MenuItem {
  return liked
    ? { label: 'Liked', icon: <Heart size={15} strokeWidth={2} fill="currentColor" />, checked: true, shortcut, onSelect }
    : { label: 'Like', icon: ic(Heart), checked: false, shortcut, onSelect }
}

/** "Download", or a disabled "Downloaded" once the file is on disk. */
export function downloadItem(downloaded: boolean, onSelect: () => void, shortcut?: string): MenuItem {
  return downloaded ? { label: 'Downloaded', icon: ic(CircleCheck), disabled: true } : { label: 'Download', icon: ic(Download), shortcut, onSelect }
}

export function trackMenuItems(track: TrackView, opts: TrackMenuOptions = {}): MenuItem[] {
  const ids = [track.id]
  const k = (combo: string) => (opts.keys ? combo : undefined)
  const items: MenuItem[] = [
    { heading: track.title },
    {
      label: 'Play',
      icon: ic(Play),
      shortcut: k('Enter'),
      onSelect: () => void (opts.playList ? trackActions.play(opts.playList.ids, opts.playList.index, opts.playList.context) : trackActions.play(ids))
    },
    { label: 'Play next', icon: ic(ListStart), shortcut: k('Shift+Q'), onSelect: () => void trackActions.playNext(ids, track.title) },
    { label: 'Add to queue', icon: ic(ListEnd), shortcut: k('Q'), onSelect: () => void trackActions.addToQueue(ids, track.title) },
    { label: 'Add to playlist', icon: ic(ListPlus), submenu: playlistSubmenu(ids) },
    { separator: true },
    likeItem(track.liked, () => void trackActions.toggleLike(track.id), k('L')),
    downloadItem(track.downloaded, () => void trackActions.downloadWithNotice({ trackIds: ids }, { title: track.title, cover: track.cover }), k('Mod+D'))
  ]
  if (opts.extra?.length) items.push({ separator: true }, ...opts.extra)
  return items
}

/** Menu for many selected tracks at once. */
export function tracksMenuItems(tracks: TrackView[], opts: { extra?: MenuItem[]; keys?: boolean } = {}): MenuItem[] {
  const ids = tracks.map((t) => t.id)
  const k = (combo: string) => (opts.keys ? combo : undefined)
  const items: MenuItem[] = [
    { heading: plural(tracks.length, 'track') },
    { label: 'Play', icon: ic(Play), onSelect: () => void trackActions.play(ids) },
    { label: 'Play next', icon: ic(ListStart), shortcut: k('Shift+Q'), onSelect: () => void trackActions.playNext(ids) },
    { label: 'Add to queue', icon: ic(ListEnd), shortcut: k('Q'), onSelect: () => void trackActions.addToQueue(ids) },
    { label: 'Add to playlist', icon: ic(ListPlus), submenu: playlistSubmenu(ids) },
    { separator: true },
    downloadItem(
      tracks.every((t) => t.downloaded),
      () => void trackActions.downloadWithNotice({ trackIds: ids }),
      k('Mod+D')
    )
  ]
  if (opts.extra?.length) items.push({ separator: true }, ...opts.extra)
  return items
}

export function albumMenuItems(albumId: ID, title: string, trackIds: ID[] | null, opts: { keys?: boolean } = {}): MenuItem[] {
  const withTracks = async (fn: (ids: ID[]) => unknown) => {
    const ids = trackIds ?? (await ghost().catalog.album(albumId)).tracks.map((t) => t.id)
    await fn(ids)
  }
  const k = (combo: string) => (opts.keys ? combo : undefined)
  return [
    { heading: title },
    { label: 'Play', icon: ic(Play), shortcut: k('Enter'), onSelect: () => void trackActions.playAlbum(albumId) },
    { label: 'Play next', icon: ic(ListStart), shortcut: k('Shift+Q'), onSelect: () => void withTracks((ids) => trackActions.playNext(ids, title)) },
    { label: 'Add to queue', icon: ic(ListEnd), shortcut: k('Q'), onSelect: () => void withTracks((ids) => trackActions.addToQueue(ids, title)) },
    {
      label: 'Add to playlist',
      icon: ic(ListPlus),
      submenu: trackIds ? playlistSubmenu(trackIds) : [{ label: 'New playlist…', icon: ic(Plus), onSelect: () => void withTracks((ids) => trackActions.newPlaylistWith(ids)) }]
    },
    { separator: true },
    { label: 'Download', icon: ic(Download), shortcut: k('Mod+D'), onSelect: () => void trackActions.downloadWithNotice({ albumId }) }
  ]
}
