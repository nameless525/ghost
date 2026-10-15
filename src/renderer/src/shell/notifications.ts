// Notification store: toasts on screen + a history for the notification centre.
//
// Sources: the main process `notify` event, and UI code via `notify({ … })`.
// A notification with an id that's already known UPDATES that card in place (title, body,
// progress, kind, image) and resets its auto-dismiss timer, so progress/streak cards never
// duplicate. A dismissed card comes back when it gets updated, except for in-between progress
// updates (a dismissed download batch stays away until it finishes or fails). While the
// notification centre is open, nothing new is toasted: the centre lists it.
import { create } from 'zustand'
import type { GhostNotification } from '@shared/types'
import { ghost } from '../ghost'
import { sfx } from '../sound'
import { useUI } from '../state/ui'

export interface Toast extends GhostNotification {
  createdAt: number
  /** Bumped on every update; the toast stack restarts the timer when it changes. */
  rev: number
  read: boolean
}

interface NotificationsState {
  /** Cards currently shown in the stack (newest first). */
  toasts: Toast[]
  /** Everything received this session (newest first, max 80). */
  history: Toast[]
  unread: number
  dismiss(id: string): void
  dismissAll(): void
  markAllRead(): void
  clearHistory(): void
}

const MAX_TOASTS = 5
const MAX_HISTORY = 80

export const useNotifications = create<NotificationsState>((set) => ({
  toasts: [],
  history: [],
  unread: 0,
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  dismissAll: () => set({ toasts: [] }),
  markAllRead: () => set((s) => ({ unread: 0, history: s.history.map((h) => (h.read ? h : { ...h, read: true })) })),
  clearHistory: () => set({ history: [], unread: 0 })
}))

let localSeq = 0
/** Cards the user dismissed (or that timed out) since their last update. */
const dismissed = new Set<string>()
useNotifications.subscribe((s, p) => {
  if (s.toasts === p.toasts) return
  const live = new Set(s.toasts.map((t) => t.id))
  for (const t of p.toasts) if (!live.has(t.id)) dismissed.add(t.id)
  if (dismissed.size > MAX_HISTORY * 2) dismissed.delete(dismissed.values().next().value!)
})

/** Show (or update, when `id` matches an existing card) a notification. Returns its id. */
export function notify(n: Omit<GhostNotification, 'id'> & { id?: string }): string {
  const id = n.id ?? `local-${++localSeq}`
  receive({ ...n, id })
  return id
}

function receive(n: GhostNotification): void {
  const now = Date.now()
  const centreOpen = useUI.getState().overlays.notifications
  useNotifications.setState((s) => {
    const existingToast = s.toasts.find((t) => t.id === n.id)
    const existingHist = s.history.find((t) => t.id === n.id)
    const base = existingToast ?? existingHist
    const merged: Toast = base
      ? { ...base, ...n, rev: base.rev + 1, read: centreOpen || base.read }
      : { ...n, createdAt: now, rev: 0, read: centreOpen }
    const interim = n.kind === 'progress' && (n.progress ?? 0) < 1
    const toasts = existingToast
      ? s.toasts.map((t) => (t.id === n.id ? merged : t))
      : centreOpen || (interim && dismissed.has(n.id))
        ? s.toasts
        : [merged, ...s.toasts].slice(0, MAX_TOASTS)
    const history = existingHist ? s.history.map((t) => (t.id === n.id ? merged : t)) : [merged, ...s.history].slice(0, MAX_HISTORY)
    return { toasts, history, unread: base || centreOpen ? s.unread : s.unread + 1 }
  })
  if (useNotifications.getState().toasts.some((t) => t.id === n.id)) dismissed.delete(n.id)
  const isNew = !useNotifications.getState().history.find((t) => t.id === n.id && t.rev > 0)
  if (isNew) sfx.play(n.kind === 'error' ? 'error' : 'notify')
  else if (n.kind === 'success') sfx.play('notify', { volume: 0.6 })
  else if (n.kind === 'error') sfx.play('error')
}

let installed = false

/** Subscribe to main-process notifications. Called once by App. */
export function initNotifications(): () => void {
  if (installed) return () => {}
  installed = true
  const off = ghost().on('notify', receive)
  const offUi = useUI.subscribe((s, p) => {
    if (s.overlays.notifications && !p.overlays.notifications) useNotifications.getState().markAllRead()
  })
  return () => {
    off()
    offUi()
    installed = false
  }
}
