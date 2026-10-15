// What Browse is waiting on before anything audible or visible happens, for its progress bars: a
// selection action (play / queue / download) fetching its album first, a preview (the album's track
// list, then the stream), revealing an imported album. The store only changes when a wait starts,
// moves to its next step or ends; the bars themselves animate on their own (ui/progress.ts).
import { useRef } from 'react'
import { create } from 'zustand'
import type { ID, TaskProgress } from '@shared/types'

export type ActionKind = 'play' | 'next' | 'end' | 'download'

export interface ActionWait {
  seq: number
  kind: ActionKind
  /** SelInfo.id of the selection it acts on (the wedge shows it while that stays selected). */
  selId: string
  /** The album being fetched, once known. */
  albumId: ID | null
  since: number
}

export interface PreviewWait {
  seq: number
  selId: string
  /** The album the preview comes from, once known. */
  albumId: ID | null
  /** The track to preview, once the album's track list is in. */
  trackId: ID | null
  since: number
  /** 'album': fetching the album's track list; 'stream': player.preview() was called. */
  phase: 'album' | 'stream'
  /** The track list had to be fetched first (it then takes the start of the bar). */
  albumStep: boolean
}

export interface RevealWait {
  title: string
  since: number
}

export interface BrowseWaits {
  action: ActionWait | null
  preview: PreviewWait | null
  reveal: RevealWait | null
}

export const useBrowseWaits = create<BrowseWaits>(() => ({ action: null, preview: null, reveal: null }))

let seq = 0

/** Start an action's wait. Returns its seq (pass it to updateAction / endAction). */
export function beginAction(kind: ActionKind, selId: string, albumId: ID | null): number {
  const s = ++seq
  useBrowseWaits.setState({ action: { seq: s, kind, selId, albumId, since: Date.now() } })
  return s
}

export function setActionAlbum(s: number, albumId: ID): void {
  const a = useBrowseWaits.getState().action
  if (a?.seq === s && a.albumId !== albumId) useBrowseWaits.setState({ action: { ...a, albumId } })
}

export function endAction(s: number): void {
  if (useBrowseWaits.getState().action?.seq === s) useBrowseWaits.setState({ action: null })
}

export function beginPreview(selId: string, albumId: ID | null, trackId: ID | null): number {
  const s = ++seq
  useBrowseWaits.setState({ preview: { seq: s, selId, albumId, trackId, since: Date.now(), phase: 'album', albumStep: false } })
  return s
}

export function patchPreview(s: number, patch: Partial<Omit<PreviewWait, 'seq'>>): void {
  const p = useBrowseWaits.getState().preview
  if (p?.seq === s) useBrowseWaits.setState({ preview: { ...p, ...patch } })
}

/** End the preview wait `s` (or whichever is running, without `s`). */
export function endPreview(s?: number): void {
  const p = useBrowseWaits.getState().preview
  if (p && (s === undefined || p.seq === s)) useBrowseWaits.setState({ preview: null })
}

export function beginReveal(title: string): void {
  useBrowseWaits.setState({ reveal: { title, since: Date.now() } })
}

export function endReveal(): void {
  if (useBrowseWaits.getState().reveal) useBrowseWaits.setState({ reveal: null })
}

/**
 * A ProgressBar waitKey for a task key that can run again (a second folder scan): it changes when
 * a run starts after the previous one finished, so the new run's bar starts from 0.
 */
export function useRunKey(task: Pick<TaskProgress, 'done'> | null): number {
  const r = useRef({ n: 0, idle: true })
  const running = !!task && !task.done
  if (running && r.current.idle) r.current.n++
  r.current.idle = !running
  return r.current.n
}

/**
 * A ProgressBar waitKey for a measured value that may start over (a catalog index run, a source's
 * crawl): bars never move back within one key, so a new key when the value drops or a run starts.
 */
export function useRestartKey(active: boolean, value: number | null | undefined): number {
  const r = useRef({ n: 0, active: false, last: 0 })
  const v = value ?? 0
  if (active && (!r.current.active || v < r.current.last - 0.01)) r.current.n++
  r.current.active = active
  if (active) r.current.last = v
  return r.current.n
}
