// Context menus for Browse selections (right-click on a row, or the footer's "More" button).
// Tracks and albums use the app-wide menus (lib/track-actions); games and other groups get theirs here.
import { Download, Globe, ListEnd, ListPlus, ListStart, Play } from 'lucide-react'
import { albumMenuItems, trackMenuItems } from '../../lib/track-actions'
import { openContextMenu, type MenuItem } from '../../ui/ContextMenu'
import { addSelectionToPlaylist, downloadSelection, playSelection, queueSelection } from './actions'
import { openSearchOnline } from './query'
import type { SelInfo } from './store'

const ic = (I: typeof Play) => <I size={15} strokeWidth={2} />

function groupMenu(sel: SelInfo, at: { x: number; y: number } | Element, keys: boolean): MenuItem[] {
  const g = sel.group!
  const k = (combo: string) => (keys ? combo : undefined)
  return [
    { heading: g.title },
    { label: g.kind === 'game' ? 'Play soundtrack' : 'Play first album', icon: ic(Play), shortcut: k('Enter'), onSelect: () => void playSelection(sel) },
    { label: 'Play next', icon: ic(ListStart), shortcut: k('Shift+Q'), onSelect: () => void queueSelection(sel, 'next') },
    { label: 'Add to queue', icon: ic(ListEnd), shortcut: k('Q'), onSelect: () => void queueSelection(sel, 'end') },
    { label: 'Add to playlist', icon: ic(ListPlus), shortcut: k('Mod+S'), onSelect: () => void addSelectionToPlaylist(sel, at) },
    { separator: true },
    { label: 'Download', icon: ic(Download), shortcut: k('Mod+D'), onSelect: () => void downloadSelection(sel) },
    { separator: true },
    { label: `Search online for “${g.title}”`, icon: ic(Globe), onSelect: () => openSearchOnline(g.title) }
  ]
}

/**
 * The menu for a selection (a track, an album or a group), at a viewport point or anchored to a
 * control (the footer's "More"). `keys`: show the shortcuts, which act on the selection (so not
 * for a row right-clicked without selecting it).
 */
export function openSelectionMenu(sel: SelInfo, at: { x: number; y: number } | Element, keys = true): void {
  if (sel.track && sel.detail) {
    const ids = sel.detail.tracks.map((t) => t.id)
    openContextMenu(
      at,
      trackMenuItems(sel.track, { keys, playList: { ids, index: Math.max(0, sel.trackIndex), context: { kind: 'album', id: sel.detail.album.id, title: sel.detail.album.title } } })
    )
  } else if (sel.album) {
    openContextMenu(at, albumMenuItems(sel.album.id, sel.album.title, sel.detail?.tracks.map((t) => t.id) ?? null, { keys }))
  } else if (sel.group) openContextMenu(at, groupMenu(sel, at, keys))
}
