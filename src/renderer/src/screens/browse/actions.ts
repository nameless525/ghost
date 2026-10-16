// What Browse does with a selection: play, queue, download, like, add to playlist, preview.
// Thin wrappers over lib/track-actions so every screen behaves the same.
import type { AlbumDetail, ID, TaskProgress, TrackView } from '@shared/types'
import { ghost } from '../../ghost'
import { playlistSubmenu, trackActions } from '../../lib/track-actions'
import { navigate } from '../../shell/navigation'
import { notify, useNotifications } from '../../shell/notifications'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { useTasks } from '../../state/progress'
import { updateSettings, useSettings } from '../../state/settings'
import { openContextMenu } from '../../ui/ContextMenu'
import { browseModel } from './model'
import { applyQuery } from './query'
import { useBrowse, type SelInfo } from './store'
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

/** The selection's track list when it's at hand and current (a cached one a catalog change made stale isn't). */
function freshDetail(sel: SelInfo): AlbumDetail | null {
  return sel.detail && browseModel.hasDetail(sel.detail.album.id) ? sel.detail : null
}

/**
 * The album a selection acts on: itself, the track's album, or the group's first (signature) album.
 * `onAlbum` hears which album it is before its track list is fetched (for progress bars).
 */
export async function albumOf(sel: SelInfo, onAlbum?: (albumId: ID) => void): Promise<AlbumDetail | null> {
  const fresh = freshDetail(sel)
  if (fresh) return fresh
  const load = (id: ID) => {
    onAlbum?.(id)
    return browseModel.loadDetail(id)
  }
  // out of date: fetched again (the old one still serves if that fails)
  if (sel.detail) return (await load(sel.detail.album.id)) ?? sel.detail
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
  if (freshDetail(sel)) return true
  const id = previewAlbumId(sel)
  return !!id && browseModel.hasDetail(id)
}

/**
 * The album whose track list the wedge wants once the selection rests on it (an album row, or a
 * group under Album grouping), unless it's cached and current: a cached one a catalog change made
 * stale shows meanwhile but is fetched again.
 */
export function restingAlbum(sel: SelInfo | null): ID | null {
  const g = sel?.group
  const albumId = sel?.album?.id ?? (g?.kind === 'album' ? g.key.slice(g.key.indexOf(':') + 1) : null)
  return albumId && !browseModel.hasDetail(albumId) ? albumId : null
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
/**
 * A preview on its way (its album's track list loading): what it's for, and whether it started on
 * its own (resting on a selection) rather than with P. A selection or query change drops it, and
 * the queue starting drops an automatic one.
 */
let pending: { albumId: ID | null; trackId: ID | null; auto: boolean } | null = null
let previewSeq = 0

export function stopPreview(): void {
  previewSeq++
  pending = null
  endPreview()
  if (!previewing && !usePlayer.getState().preview) return
  previewing = null
  void ghost()
    .player.stopPreview()
    .catch(() => {})
}

/** Drop a preview that's still on its way (nothing audible yet); `autoOnly`: only one that started on its own. */
export function cancelPendingPreview(autoOnly = false): void {
  if (!pending || (autoOnly && !pending.auto)) return
  previewSeq++
  pending = null
  endPreview()
}

/** The selection moved: a preview of another album stops, audible or still on its way. */
export function previewFollowSelection(sel: SelInfo | null): void {
  const albumId = previewAlbumId(sel)
  if ([previewing, pending].some((c) => c && (!albumId || c.albumId !== albumId))) stopPreview()
}

/** A preview of the selection is audible or on its way. */
function previewingSel(sel: SelInfo): boolean {
  const albumId = previewAlbumId(sel)
  return [previewing, pending].some((c) => c && (sel.track ? c.trackId === sel.track.id : c.albumId === albumId))
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

/**
 * Start previewing the selection's signature track (or the selected track). `auto`: on its own
 * (resting on the selection), so only while nothing plays; P's previews may pause the queue.
 */
export async function startPreview(sel: SelInfo, auto = false): Promise<boolean> {
  // Already previewing (or still loading) this: leave it, and its wait, alone.
  if (previewingSel(sel)) return true
  const seq = ++previewSeq
  const intent = { albumId: previewAlbumId(sel), trackId: sel.track?.id ?? null, auto }
  pending = intent
  // The wait shows on the wedge from now until it's audible: the track list (when it has to be
  // fetched), then whatever the player reports in previewLoading.
  const w = beginPreview(sel.id, intent.albumId, intent.trackId)
  const t0 = Date.now()
  const d = await albumOf(sel, (albumId) => {
    intent.albumId = albumId
    patchPreview(w, { albumId })
  })
  if (pending === intent) pending = null
  // Dropped meanwhile (another selection or query, P again), or an automatic one that's no longer
  // allowed (the queue started playing): nothing starts.
  if (seq !== previewSeq || !d || !d.tracks.length || (auto && !canAutoPreview())) {
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

/** P: toggle a preview of the selection, even while music plays (P again while it loads drops it). */
export async function togglePreview(sel: SelInfo | null): Promise<void> {
  if (!sel) return
  if (previewingSel(sel)) {
    sfx.play('toggleOff', { volume: 0.5 })
    stopPreview()
    return
  }
  sfx.play('toggleOn', { volume: 0.5 })
  await startPreview(sel)
}

// ---------------------------------------------------------------- play / queue / etc.

/** Bumps with every play asked for in Browse, and on leaving it: an older play still fetching its album is dropped. */
let playSeq = 0

/** Leaving Browse: a play still fetching its album (or waiting for search results) doesn't start. */
export function cancelPlay(): void {
  playSeq++
}

export async function playSelection(sel: SelInfo | null): Promise<void> {
  if (!sel) return
  const seq = ++playSeq
  stopPreview()
  const w = actionWait('play', sel)
  const onAlbum = (id: ID) => setActionAlbum(w, id)
  try {
    const d = await albumOf(sel, onAlbum)
    // a newer play (or leaving Browse) while the album loaded: this one is moot
    if (seq !== playSeq) return
    if (sel.track) {
      const albumId = d?.album.id ?? sel.track.albumId
      const index = d ? Math.max(0, d.tracks.findIndex((t) => t.id === sel.track!.id)) : 0
      await trackActions.playAlbum(albumId, index)
    } else {
      if (!d || !d.tracks.length) {
        notify({ kind: 'info', title: 'Nothing to play yet', body: sel.album?.title ?? sel.group?.title, ephemeral: true })
        return
      }
      await trackActions.playAlbum(d.album.id, 0)
    }
  } catch (err) {
    if (seq !== playSeq) return
    sfx.play('error')
    notify({ kind: 'error', title: 'Couldn’t start playback', body: err instanceof Error ? err.message : String(err) })
    return
  } finally {
    endAction(w)
  }
  if (seq === playSeq) navigate('play')
}

/**
 * Enter: play the selection of the query as typed. Until that query's results are in, the selection
 * on screen is the previous query's, so this waits for them (running what's typed now), then plays
 * once; nothing found: `searchOnline` looks on the web sources instead (the search box's Enter).
 */
export async function playResult(searchOnline: boolean): Promise<void> {
  const seq = ++playSeq
  applyQuery(true)
  const gen = browseModel.gen
  await browseModel.settled()
  // typed on, played something else or left Browse meanwhile
  if (seq !== playSeq || gen !== browseModel.gen) return
  const sel = useBrowse.getState().sel
  if (browseModel.total && sel) return playSelection(sel)
  const text = browseModel.query.text
  if (searchOnline && text && browseModel.total === 0 && !browseModel.pageError) useBrowse.setState({ externalAuto: text })
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
    // the notice names what was queued: the track, else the album the selection stands for
    let label = sel.track?.title
    let ids = sel.track ? [sel.track.id] : []
    if (!sel.track) {
      const d = await albumOf(sel, (id) => setActionAlbum(w, id))
      ids = d?.tracks.map((t) => t.id) ?? []
      label = d?.album.title
    }
    if (!ids.length) return
    if (mode === 'next') await trackActions.playNext(ids, label)
    else await trackActions.addToQueue(ids, label)
  })
  endAction(w)
}

let downloadSeq = 0

export async function downloadSelection(sel: SelInfo | null): Promise<void> {
  if (!sel) return
  // The shared notices: "Download queued" for one track; an album's batch card (and "Already
  // downloaded") come from the downloads service itself.
  if (sel.track) return trackActions.downloadWithNotice({ trackIds: [sel.track.id] }, { title: sel.track.title, cover: sel.track.cover })
  if (albumAtHand(sel)) {
    const d = await albumOf(sel)
    if (d) await trackActions.downloadWithNotice({ albumId: d.album.id }, d.tracks.length === 1 ? { title: d.tracks[0].title, cover: d.album.cover } : undefined)
    return
  }
  // The album's track list has to be fetched first (a source page, a chiptune set): a progress card
  // right away that follows the fetch, then hands over to the service's batch card.
  const title = sel.album?.title ?? sel.group?.title ?? 'Selection'
  const image = sel.album?.cover ?? sel.group?.cover ?? null
  const id = `browse-download-${++downloadSeq}`
  const w = beginAction('download', sel.id, previewAlbumId(sel))
  notify({ id, kind: 'progress', title: 'Preparing download', body: title, image, ephemeral: true })
  let stop = followAlbum(previewAlbumId(sel), id, title, image)
  try {
    const d = await albumOf(sel, (albumId) => {
      setActionAlbum(w, albumId)
      stop()
      stop = followAlbum(albumId, id, title, image)
    })
    stop()
    if (!d || !d.tracks.length) {
      notify({ id, kind: 'info', title: 'Nothing to download yet', body: title, image, ephemeral: true })
      return
    }
    await trackActions.download({ albumId: d.album.id })
    if (d.tracks.length === 1) notify({ id, kind: 'info', title: 'Download queued', body: d.tracks[0].title, image, ephemeral: true })
    else useNotifications.getState().dismiss(id)
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
    notify({ id, kind: 'progress', title: 'Preparing download', body: `${title} · ${t.label}${t.detail ? ` (${t.detail})` : ''}`, image, progress: t.fraction ?? undefined, ephemeral: true })
  }
  // the fetch may already be running (a preview started it)
  show(useTasks.getState()[key])
  return useTasks.subscribe((s) => show(s[key]))
}

export async function likeSelection(sel: SelInfo | null): Promise<void> {
  const t = sel?.track
  if (!t) {
    sfx.play('error', { volume: 0.4 })
    notify({ kind: 'info', title: 'Select a track to like it', ephemeral: true })
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

/** Alt+J (or clicking the wedge's second title): original ⇄ romanized titles first. */
export function toggleTitles(): void {
  const on = !useSettings.getState().interface.preferOriginalTitles
  sfx.play(on ? 'toggleOn' : 'toggleOff', { volume: 0.55 })
  void updateSettings({ interface: { preferOriginalTitles: on } })
}

/** Mod+S / footer: a playlist picker at a point, or anchored to a control (the footer button). */
export async function addSelectionToPlaylist(sel: SelInfo | null, at: { x: number; y: number } | Element): Promise<void> {
  if (!sel) return
  const ids = await trackIdsOf(sel)
  if (!ids.length) return
  const title = sel.track?.title ?? sel.album?.title ?? sel.detail?.album.title ?? sel.group?.title ?? ''
  openContextMenu(at, [{ heading: `Add “${title}” to…` }, ...playlistSubmenu(ids)])
}
