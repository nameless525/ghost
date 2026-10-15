// What Browse does with a selection: play, queue, download, like, add to playlist, preview.
// Thin wrappers over lib/track-actions so every screen behaves the same.
import type { AlbumDetail, ID, TrackView } from '@shared/types'
import { ghost } from '../../ghost'
import { playlistSubmenu, trackActions } from '../../lib/track-actions'
import { navigate } from '../../shell/navigation'
import { notify } from '../../shell/notifications'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { useSettings } from '../../state/settings'
import { openContextMenu } from '../../ui/ContextMenu'
import { browseModel } from './model'
import type { SelInfo } from './store'

/** osu!-style "preview point" track: hardest analysed track, else the first one over a minute, else track 1. */
export function signatureIndex(tracks: TrackView[]): number {
  let best = -1
  let bestV = -Infinity
  tracks.forEach((t, i) => {
    const v = t.analysis?.intensity
    if (v != null && Number.isFinite(v) && v > bestV) {
      bestV = v
      best = i
    }
  })
  if (best >= 0) return best
  const long = tracks.findIndex((t) => (t.durationMs ?? 0) > 60_000)
  return long >= 0 ? long : 0
}

/** The album a selection acts on: itself, the track's album, or the group's first (signature) album. */
export async function albumOf(sel: SelInfo): Promise<AlbumDetail | null> {
  if (sel.detail) return sel.detail
  if (sel.album) return browseModel.loadDetail(sel.album.id)
  const g = sel.group
  if (!g) return null
  if (g.kind === 'album') return browseModel.loadDetail(g.key.slice(g.key.indexOf(':') + 1))
  const albums = sel.albums ?? (await browseModel.loadAlbums(g.key))
  const first = albums?.[0]
  return first ? browseModel.loadDetail(first.id) : null
}

/** Track ids a selection stands for (a track, an album's tracks, or the signature album's). */
export async function trackIdsOf(sel: SelInfo): Promise<ID[]> {
  if (sel.track) return [sel.track.id]
  const d = await albumOf(sel)
  return d?.tracks.map((t) => t.id) ?? []
}

// ---------------------------------------------------------------- previews

let previewing: { trackId: ID; albumId: ID } | null = null
let previewSeq = 0

export function previewState(): { trackId: ID; albumId: ID } | null {
  return previewing
}

export function stopPreview(): void {
  previewSeq++
  if (!previewing && !usePlayer.getState().preview) return
  previewing = null
  void ghost()
    .player.stopPreview()
    .catch(() => {})
}

/** The player ended a preview on its own (the queue started playing, the time limit, an error). */
export function previewEnded(trackId: ID): void {
  if (previewing?.trackId === trackId) previewing = null
}

/** Album the selection would preview (so moving within an album doesn't cut the music). */
export function previewAlbumId(sel: SelInfo | null): ID | null {
  if (!sel) return null
  if (sel.album) return sel.album.id
  const g = sel.group
  if (!g) return null
  if (g.kind === 'album') return g.key.slice(g.key.indexOf(':') + 1)
  return sel.albums?.[0]?.id ?? null
}

/** Start previewing the selection's signature track (or the selected track). */
export async function startPreview(sel: SelInfo): Promise<boolean> {
  const seq = ++previewSeq
  const d = await albumOf(sel)
  if (seq !== previewSeq || !d || !d.tracks.length) return false
  const t = sel.track ?? d.tracks[signatureIndex(d.tracks)]
  if (previewing?.trackId === t.id) return true
  const mine = { trackId: t.id, albumId: d.album.id }
  previewing = mine
  let ok = false
  try {
    ok = (await ghost().player.preview(t.id)) !== false
  } catch {
    ok = false
  }
  if (!ok && previewing === mine) previewing = null
  return ok
}

/** Auto-preview allowed? (setting on, and nothing is actually playing: the player would pause it). */
export function canAutoPreview(): boolean {
  if (!useSettings.getState().audio.previewOnSelect) return false
  const st = usePlayer.getState().status
  return st === 'idle' || st === 'paused' || st === 'error'
}

/** P: toggle a preview of the selection, even while music plays. */
export async function togglePreview(sel: SelInfo | null): Promise<void> {
  if (!sel) return
  const albumId = previewAlbumId(sel)
  if (previewing && (sel.track ? previewing.trackId === sel.track.id : previewing.albumId === albumId)) {
    sfx.play('toggleOff', { volume: 0.5 })
    stopPreview()
    return
  }
  sfx.play('toggleOn', { volume: 0.5 })
  await startPreview(sel)
}

// ---------------------------------------------------------------- play / queue / etc.

export async function playSelection(sel: SelInfo | null): Promise<void> {
  if (!sel) return
  stopPreview()
  try {
    if (sel.track) {
      const d = sel.detail ?? (await albumOf(sel))
      const albumId = d?.album.id ?? sel.track.albumId
      const index = d ? Math.max(0, d.tracks.findIndex((t) => t.id === sel.track!.id)) : 0
      await trackActions.playAlbum(albumId, index)
    } else {
      const d = await albumOf(sel)
      if (!d || !d.tracks.length) {
        notify({ kind: 'info', title: 'Nothing to play yet', body: sel.album?.title ?? sel.group?.title })
        return
      }
      await trackActions.playAlbum(d.album.id, 0)
    }
  } catch (err) {
    sfx.play('error')
    notify({ kind: 'error', title: 'Couldn’t start playback', body: err instanceof Error ? err.message : String(err) })
    return
  }
  navigate('play')
}

/** Run an action, turning failures into an error toast. */
async function guarded(title: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    sfx.play('error')
    notify({ kind: 'error', title, body: err instanceof Error ? err.message : String(err) })
  }
}

export async function queueSelection(sel: SelInfo | null, mode: 'next' | 'end'): Promise<void> {
  if (!sel) return
  await guarded('Couldn’t queue that', async () => {
    const ids = await trackIdsOf(sel)
    if (!ids.length) return
    if (mode === 'next') await trackActions.playNext(ids)
    else await trackActions.addToQueue(ids)
  })
}

export async function downloadSelection(sel: SelInfo | null): Promise<void> {
  if (!sel) return
  const title = sel.track?.title ?? sel.album?.title ?? sel.group?.title ?? 'Selection'
  if (sel.track?.downloaded) {
    notify({ kind: 'info', title: 'Already downloaded', body: title })
    return
  }
  await guarded('Couldn’t start the download', async () => {
    if (sel.track) await trackActions.download({ trackIds: [sel.track.id] })
    else {
      const d = await albumOf(sel)
      if (!d) return
      await trackActions.download({ albumId: d.album.id })
    }
    notify({ kind: 'info', title: 'Download queued', body: title, image: sel.track?.cover ?? sel.album?.cover ?? sel.group?.cover ?? null })
  })
}

export async function likeSelection(sel: SelInfo | null): Promise<void> {
  const t = sel?.track
  if (!t) {
    sfx.play('error', { volume: 0.4 })
    notify({ kind: 'info', title: 'Select a track to like it' })
    return
  }
  const liked = !t.liked
  browseModel.patchTrack(t.id, { liked })
  sfx.play(liked ? 'toggleOn' : 'toggleOff', { volume: 0.55 })
  try {
    const now = await trackActions.toggleLike(t.id)
    if (now !== liked) browseModel.patchTrack(t.id, { liked: now })
  } catch {
    browseModel.patchTrack(t.id, { liked: !liked })
  }
}

/** Mod+S / footer: a playlist picker anchored at a point. */
export async function addSelectionToPlaylist(sel: SelInfo | null, at: { x: number; y: number }): Promise<void> {
  if (!sel) return
  const ids = await trackIdsOf(sel)
  if (!ids.length) return
  const title = sel.track?.title ?? sel.album?.title ?? sel.detail?.album.title ?? sel.group?.title ?? ''
  openContextMenu(at, [{ heading: `Add “${title}” to…` }, ...playlistSubmenu(ids)])
}
