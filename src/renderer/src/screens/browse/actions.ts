// What Browse does with a selection: play, queue, download, like, add to playlist, preview.
// Thin wrappers over lib/track-actions so every screen behaves the same.
import type { AlbumDetail, ID, TaskProgress, TrackView } from '@shared/types'
import { ghost } from '../../ghost'
import { playlistSubmenu, trackActions } from '../../lib/track-actions'
import { navigate } from '../../shell/navigation'
import { notify } from '../../shell/notifications'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { useTasks } from '../../state/progress'
import { useSettings } from '../../state/settings'
import { openContextMenu } from '../../ui/ContextMenu'
import { browseModel } from './model'
import type { SelInfo } from './store'
import { beginAction, beginPreview, endAction, endPreview, patchPreview, setActionAlbum, useBrowseWaits, type ActionKind } from './waits'

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

/**
 * The album a selection acts on: itself, the track's album, or the group's first (signature) album.
 * `onAlbum` hears which album it is before its track list is fetched (for progress bars).
 */
export async function albumOf(sel: SelInfo, onAlbum?: (albumId: ID) => void): Promise<AlbumDetail | null> {
  if (sel.detail) return sel.detail
  const load = (id: ID) => {
    onAlbum?.(id)
    return browseModel.loadDetail(id)
  }
  if (sel.album) return load(sel.album.id)
  const g = sel.group
  if (!g) return null
  if (g.kind === 'album') return load(g.key.slice(g.key.indexOf(':') + 1))
  const albums = sel.albums ?? (await browseModel.loadAlbums(g.key))
  const first = albums?.[0]
  return first ? load(first.id) : null
}

/** The selection's track list is at hand: acting on it fetches nothing first. */
export function albumAtHand(sel: SelInfo): boolean {
  if (sel.detail) return true
  const id = previewAlbumId(sel)
  return !!id && browseModel.hasDetail(id)
}

/** Start a wait for an action on `sel` when its album has to be fetched first (Browse shows it); 0 = nothing to wait for. */
function actionWait(kind: ActionKind, sel: SelInfo): number {
  return albumAtHand(sel) ? 0 : beginAction(kind, sel.id, previewAlbumId(sel))
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
  endPreview()
  if (!previewing && !usePlayer.getState().preview) return
  previewing = null
  void ghost()
    .player.stopPreview()
    .catch(() => {})
}

/** The player ended a preview on its own (the queue started playing, the time limit, an error). */
export function previewEnded(trackId: ID): void {
  if (previewing?.trackId === trackId) previewing = null
  const w = useBrowseWaits.getState().preview
  if (w?.trackId === trackId) endPreview(w.seq)
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
  // Already previewing (or still loading) this: leave it, and its wait, alone.
  const cur = previewing
  if (cur && (sel.track ? cur.trackId === sel.track.id : cur.albumId === previewAlbumId(sel))) return true
  const seq = ++previewSeq
  // The wait shows on the wedge from now until it's audible: the track list (when it has to be
  // fetched), then whatever the player reports in previewLoading.
  const w = beginPreview(sel.id, previewAlbumId(sel), sel.track?.id ?? null)
  const t0 = Date.now()
  const d = await albumOf(sel, (albumId) => patchPreview(w, { albumId }))
  if (seq !== previewSeq || !d || !d.tracks.length) {
    endPreview(w)
    return false
  }
  const t = sel.track ?? d.tracks[signatureIndex(d.tracks)]
  if (previewing?.trackId === t.id) {
    endPreview(w)
    return true
  }
  const mine = { trackId: t.id, albumId: d.album.id }
  previewing = mine
  patchPreview(w, { phase: 'stream', trackId: t.id, albumId: d.album.id, albumStep: Date.now() - t0 > 150 })
  let ok = false
  try {
    ok = (await ghost().player.preview(t.id)) !== false
  } catch {
    ok = false
  }
  if (!ok) {
    endPreview(w)
    if (previewing === mine) previewing = null
  }
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
  const w = actionWait('play', sel)
  const onAlbum = (id: ID) => setActionAlbum(w, id)
  try {
    if (sel.track) {
      const d = sel.detail ?? (await albumOf(sel, onAlbum))
      const albumId = d?.album.id ?? sel.track.albumId
      const index = d ? Math.max(0, d.tracks.findIndex((t) => t.id === sel.track!.id)) : 0
      await trackActions.playAlbum(albumId, index)
    } else {
      const d = await albumOf(sel, onAlbum)
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
  } finally {
    endAction(w)
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
  const w = sel.track ? 0 : actionWait(mode, sel)
  await guarded('Couldn’t queue that', async () => {
    const ids = sel.track ? [sel.track.id] : ((await albumOf(sel, (id) => setActionAlbum(w, id)))?.tracks.map((t) => t.id) ?? [])
    if (!ids.length) return
    if (mode === 'next') await trackActions.playNext(ids)
    else await trackActions.addToQueue(ids)
  })
  endAction(w)
}

let downloadSeq = 0

export async function downloadSelection(sel: SelInfo | null): Promise<void> {
  if (!sel) return
  const title = sel.track?.title ?? sel.album?.title ?? sel.group?.title ?? 'Selection'
  if (sel.track?.downloaded) {
    notify({ kind: 'info', title: 'Already downloaded', body: title })
    return
  }
  const image = sel.track?.cover ?? sel.album?.cover ?? sel.group?.cover ?? null
  if (sel.track || albumAtHand(sel)) {
    await guarded('Couldn’t start the download', async () => {
      if (sel.track) await trackActions.download({ trackIds: [sel.track.id] })
      else {
        const d = await albumOf(sel)
        if (!d) return
        await trackActions.download({ albumId: d.album.id })
      }
      notify({ kind: 'info', title: 'Download queued', body: title, image })
    })
    return
  }
  // The album's track list has to be fetched first (a source page, a chiptune set): a progress card
  // right away that follows the fetch and becomes the "Download queued" notice.
  const id = `browse-download-${++downloadSeq}`
  const w = beginAction('download', sel.id, previewAlbumId(sel))
  notify({ id, kind: 'progress', title: 'Preparing download', body: title, image })
  let stop = followAlbum(previewAlbumId(sel), id, title, image)
  try {
    const d = await albumOf(sel, (albumId) => {
      setActionAlbum(w, albumId)
      stop()
      stop = followAlbum(albumId, id, title, image)
    })
    stop()
    if (!d || !d.tracks.length) {
      notify({ id, kind: 'info', title: 'Nothing to download yet', body: title, image })
      return
    }
    await trackActions.download({ albumId: d.album.id })
    notify({ id, kind: 'info', title: 'Download queued', body: title, image })
  } catch (err) {
    sfx.play('error')
    notify({ id, kind: 'error', title: 'Couldn’t start the download', body: err instanceof Error ? err.message : String(err), image })
  } finally {
    stop()
    endAction(w)
  }
}

/** Mirror an album fetch's task progress ('album:<id>') on the progress card `id` until stopped. */
function followAlbum(albumId: ID | null, id: string, title: string, image: string | null): () => void {
  if (!albumId) return () => {}
  const key = `album:${albumId}`
  let last: TaskProgress | undefined
  const show = (t: TaskProgress | undefined) => {
    if (t === last) return
    last = t
    if (!t || t.done) return
    // measured (a chiptune set's bytes) fills the card's bar; otherwise it sweeps
    notify({ id, kind: 'progress', title: 'Preparing download', body: `${title} · ${t.label}${t.detail ? ` (${t.detail})` : ''}`, image, progress: t.fraction ?? undefined })
  }
  // the fetch may already be running (a preview started it)
  show(useTasks.getState()[key])
  return useTasks.subscribe((s) => show(s[key]))
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
