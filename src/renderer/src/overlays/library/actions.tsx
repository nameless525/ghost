// Playlist-level actions (play, shuffle, download, export, duplicate, delete) and their menus.
import { Copy, Download, FileOutput, FolderSearch, ListEnd, ListMusic, ListStart, Pencil, Play, Shuffle, Trash } from 'lucide-react'
import type { ID, Playlist } from '@shared/types'
import { ghost } from '../../ghost'
import { trackActions } from '../../lib/track-actions'
import { notify } from '../../shell/notifications'
import type { MenuItem } from '../../ui/ContextMenu'
import { confirmDialog, promptDialog } from '../../ui/Dialog'
import { plural } from './common'
import { showSnack } from './Snack'

const ic = (I: typeof Play) => <I size={15} strokeWidth={2} />

async function playlistTrackIds(id: ID): Promise<ID[]> {
  return (await ghost().library.playlists.get(id)).items.map((i) => i.track.id)
}

export const playlistActions = {
  async play(p: Pick<Playlist, 'id'>, index = 0) {
    await ghost().player.setShuffle('off')
    await ghost().player.playPlaylist(p.id, index)
  },
  async shuffle(p: Pick<Playlist, 'id' | 'trackCount'>) {
    await ghost().player.setShuffle('on')
    await ghost().player.playPlaylist(p.id, Math.floor(Math.random() * Math.max(1, p.trackCount)))
  },
  async playNext(p: Pick<Playlist, 'id'>) {
    await trackActions.playNext(await playlistTrackIds(p.id))
  },
  async addToQueue(p: Pick<Playlist, 'id'>) {
    await trackActions.addToQueue(await playlistTrackIds(p.id))
  },
  async download(p: Pick<Playlist, 'id' | 'name' | 'trackCount'>) {
    await trackActions.download({ playlistId: p.id })
    notify({ kind: 'info', title: `Downloading ${p.name}`, body: plural(p.trackCount, 'track') })
  },
  async exportM3U(p: Pick<Playlist, 'id' | 'name'>) {
    try {
      const path = await ghost().library.playlists.exportM3U(p.id)
      showSnack({
        host: 'library',
        icon: <FileOutput />,
        title: `Exported ${p.name}`,
        body: <span className="lx-mono">{path}</span>,
        action: { label: 'Reveal', icon: <FolderSearch />, onClick: () => void ghost().system.reveal(path) }
      })
    } catch (err) {
      notify({ kind: 'error', title: 'Export failed', body: String((err as Error)?.message ?? err) })
    }
  },
  async duplicate(p: Pick<Playlist, 'id' | 'name'>): Promise<Playlist> {
    const copy = await ghost().library.playlists.duplicate(p.id)
    notify({ kind: 'success', title: 'Playlist duplicated', body: copy.name })
    return copy
  },
  async rename(p: Pick<Playlist, 'id' | 'name'>): Promise<void> {
    const name = await promptDialog({
      title: 'Rename playlist',
      label: 'Name',
      defaultValue: p.name,
      hue: 'library',
      validate: (v) => (v.trim() ? null : 'Give it a name')
    })
    if (name && name.trim() !== p.name) await ghost().library.playlists.update(p.id, { name: name.trim() })
  },
  /** Asks first. Resolves true when deleted. */
  async remove(p: Pick<Playlist, 'id' | 'name' | 'trackCount' | 'kind'>): Promise<boolean> {
    const ok = await confirmDialog({
      title: `Delete “${p.name}”?`,
      body:
        p.kind === 'smart'
          ? "The saved search goes away. The tracks it matched aren't touched."
          : `The playlist and its order go away (${plural(p.trackCount, 'track')}). The tracks themselves stay in your library, likes and downloads. This can't be undone.`,
      confirmLabel: 'Delete playlist',
      danger: true
    })
    if (!ok) return false
    await ghost().library.playlists.delete(p.id)
    notify({ kind: 'info', title: 'Playlist deleted', body: p.name })
    return true
  }
}

/** Right-click menu for a playlist card / header. */
export function playlistMenuItems(p: Playlist, opts: { onOpen?: () => void; onDeleted?: () => void; onDuplicated?: (copy: Playlist) => void } = {}): MenuItem[] {
  const empty = p.trackCount === 0
  return [
    { heading: p.name },
    { label: 'Play', icon: ic(Play), disabled: empty, onSelect: () => void playlistActions.play(p) },
    { label: 'Shuffle', icon: ic(Shuffle), disabled: empty, onSelect: () => void playlistActions.shuffle(p) },
    { label: 'Play next', icon: ic(ListStart), disabled: empty, onSelect: () => void playlistActions.playNext(p) },
    { label: 'Add to queue', icon: ic(ListEnd), disabled: empty, onSelect: () => void playlistActions.addToQueue(p) },
    { separator: true },
    ...(opts.onOpen ? [{ label: 'Open', icon: ic(ListMusic), shortcut: 'Enter', onSelect: opts.onOpen } as MenuItem] : []),
    { label: 'Rename…', icon: ic(Pencil), onSelect: () => void playlistActions.rename(p) },
    { label: 'Duplicate', icon: ic(Copy), onSelect: () => void playlistActions.duplicate(p).then((c) => opts.onDuplicated?.(c)) },
    { label: 'Download all', icon: ic(Download), disabled: empty, onSelect: () => void playlistActions.download(p) },
    { label: 'Export M3U', icon: ic(FileOutput), onSelect: () => void playlistActions.exportM3U(p) },
    { separator: true },
    { label: 'Delete…', icon: ic(Trash), danger: true, onSelect: () => void playlistActions.remove(p).then((ok) => ok && opts.onDeleted?.()) }
  ]
}
