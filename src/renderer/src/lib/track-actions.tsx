// Shared track/album actions so Browse, Play and Library behave identically:
// play / queue / like / download / add-to-playlist, plus ready-made context-menu item lists.
import { Download, Heart, HeartOff, ListEnd, ListPlus, ListStart, Play, Plus } from 'lucide-react'
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

export const trackActions = {
  play(trackIds: ID[], startIndex = 0, context?: PlayContext) {
    return ghost().player.playTracks(trackIds, startIndex, context)
  },
  playAlbum(albumId: ID, startIndex = 0) {
    return ghost().player.playAlbum(albumId, startIndex)
  },
  async playNext(trackIds: ID[]) {
    await ghost().player.enqueue(trackIds, 'next')
    notify({ kind: 'info', title: 'Playing next', body: plural(trackIds.length, 'track') })
  },
  async addToQueue(trackIds: ID[]) {
    await ghost().player.enqueue(trackIds, 'end')
    notify({ kind: 'info', title: 'Added to queue', body: plural(trackIds.length, 'track') })
  },
  toggleLike(trackId: ID) {
    return ghost().library.toggleLike(trackId)
  },
  async download(target: { trackIds: ID[] } | { albumId: ID } | { playlistId: ID }) {
    await ghost().downloads.enqueue(target)
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
    notify({ kind: 'success', title: `Created ${p.name}`, body: plural(trackIds.length, 'track') })
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
}

export function trackMenuItems(track: TrackView, opts: TrackMenuOptions = {}): MenuItem[] {
  const ids = [track.id]
  const items: MenuItem[] = [
    { heading: track.title },
    {
      label: 'Play',
      icon: ic(Play),
      shortcut: 'Enter',
      onSelect: () => void (opts.playList ? trackActions.play(opts.playList.ids, opts.playList.index, opts.playList.context) : trackActions.play(ids))
    },
    { label: 'Play next', icon: ic(ListStart), shortcut: 'Shift+Q', onSelect: () => void trackActions.playNext(ids) },
    { label: 'Add to queue', icon: ic(ListEnd), shortcut: 'Q', onSelect: () => void trackActions.addToQueue(ids) },
    { label: 'Add to playlist', icon: ic(ListPlus), submenu: playlistSubmenu(ids) },
    { separator: true },
    {
      label: track.liked ? 'Unlike' : 'Like',
      icon: ic(track.liked ? HeartOff : Heart),
      shortcut: 'L',
      onSelect: () => void trackActions.toggleLike(track.id)
    },
    {
      label: track.downloaded ? 'Downloaded' : 'Download',
      icon: ic(Download),
      shortcut: 'Mod+D',
      disabled: track.downloaded,
      onSelect: () => void trackActions.download({ trackIds: ids })
    }
  ]
  if (opts.extra?.length) items.push({ separator: true }, ...opts.extra)
  return items
}

/** Menu for many selected tracks at once. */
export function tracksMenuItems(tracks: TrackView[], opts: { extra?: MenuItem[] } = {}): MenuItem[] {
  const ids = tracks.map((t) => t.id)
  const items: MenuItem[] = [
    { heading: plural(tracks.length, 'track') },
    { label: 'Play', icon: ic(Play), onSelect: () => void trackActions.play(ids) },
    { label: 'Play next', icon: ic(ListStart), onSelect: () => void trackActions.playNext(ids) },
    { label: 'Add to queue', icon: ic(ListEnd), onSelect: () => void trackActions.addToQueue(ids) },
    { label: 'Add to playlist', icon: ic(ListPlus), submenu: playlistSubmenu(ids) },
    { separator: true },
    { label: 'Download', icon: ic(Download), onSelect: () => void trackActions.download({ trackIds: ids }) }
  ]
  if (opts.extra?.length) items.push({ separator: true }, ...opts.extra)
  return items
}

export function albumMenuItems(albumId: ID, title: string, trackIds: ID[] | null): MenuItem[] {
  const withTracks = async (fn: (ids: ID[]) => unknown) => {
    const ids = trackIds ?? (await ghost().catalog.album(albumId)).tracks.map((t) => t.id)
    await fn(ids)
  }
  return [
    { heading: title },
    { label: 'Play album', icon: ic(Play), onSelect: () => void trackActions.playAlbum(albumId) },
    { label: 'Play next', icon: ic(ListStart), onSelect: () => void withTracks((ids) => trackActions.playNext(ids)) },
    { label: 'Add to queue', icon: ic(ListEnd), onSelect: () => void withTracks((ids) => trackActions.addToQueue(ids)) },
    {
      label: 'Add to playlist',
      icon: ic(ListPlus),
      submenu: trackIds ? playlistSubmenu(trackIds) : [{ label: 'New playlist…', icon: ic(Plus), onSelect: () => void withTracks((ids) => trackActions.newPlaylistWith(ids)) }]
    },
    { separator: true },
    { label: 'Download album', icon: ic(Download), onSelect: () => void trackActions.download({ albumId }) }
  ]
}
