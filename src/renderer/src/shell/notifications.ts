// Notification store: toasts on screen + a history for the notification centre.
//
// Sources: the main process `notify` event, and UI code via `notify({ … })`.
// A notification with an id that's already known UPDATES that card in place (title, body,
// progress, kind, image) and resets its auto-dismiss timer, so progress/streak cards never
// duplicate. A card that was already dismissed comes back if it gets updated.
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
    const toasts = existingToast ? s.toasts.map((t) => (t.id === n.id ? merged : t)) : [merged, ...s.toasts].slice(0, MAX_TOASTS)
    const history = existingHist ? s.history.map((t) => (t.id === n.id ? merged : t)) : [merged, ...s.history].slice(0, MAX_HISTORY)
    return { toasts, history, unread: base || centreOpen ? s.unread : s.unread + 1 }
  })
  const isNew = !useNotifications.getState().history.find((t) => t.id === n.id && t.rev > 0)
  if (isNew) sfx.play(n.kind === 'error' ? 'error' : 'notify')
  else if (n.kind === 'success') sfx.play('notify', { volume: 0.6 })
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
