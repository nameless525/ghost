// Notification store: toasts on screen + a history for the notification centre.
//
// Sources: the main process `notify` event, and UI code via `notify({ … })`.
// A notification with an id that's already known UPDATES that card in place (title, body,
// progress, kind, image) and resets its auto-dismiss timer, so progress/streak cards never
// duplicate. A dismissed card comes back when it gets updated, except for in-between progress
// updates (a dismissed download batch stays away until it finishes or fails). While the
// notification centre is open, nothing new is toasted: the centre lists it. `ephemeral` ones
// (confirmations like "Added to queue") toast but stay out of the centre and its unread count.
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
    // Confirmations of the user's own actions only toast: the centre (and the bell's count) is for
    // things they might have missed. Queueing a few tracks used to light the bell up with "5".
    const history = existingHist ? s.history.map((t) => (t.id === n.id ? merged : t)) : n.ephemeral ? s.history : [merged, ...s.history].slice(0, MAX_HISTORY)
    return { toasts, history, unread: base || centreOpen || n.ephemeral ? s.unread : s.unread + 1 }
  })
  if (useNotifications.getState().toasts.some((t) => t.id === n.id)) dismissed.delete(n.id)
  const st = useNotifications.getState()
  const isNew = !(st.history.find((t) => t.id === n.id && t.rev > 0) ?? st.toasts.find((t) => t.id === n.id && t.rev > 0))
  if (isNew) sfx.play(n.kind === 'error' ? 'error' : 'notify')
  else if (n.kind === 'success') sfx.play('notify', { volume: 0.6 })
  else if (n.kind === 'error') sfx.play('error')
}

let installed = false

/** "Error invoking remote method 'ghost:invoke': Error: HTTP 404 from …" → "HTTP 404 from …". */
export function cleanIpcError(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:[A-Z]\w*Error|Error):\s*/, '')
    .replace(/^\[\w+\]\s*/, '') // NetError code ("[not_found] …")
    .trim()
}

/**
 * Safety net for fire-and-forget API calls (`void ghost().…()` without a catch): a failure becomes
 * an error card instead of vanishing into the console. Cancellations stay quiet; the same message
 * within 8 s shows once.
 */
function onUnhandled(e: PromiseRejectionEvent): void {
  const r = e.reason as { name?: string; message?: string } | string | undefined
  const raw = typeof r === 'string' ? r : (r?.message ?? '')
  if (!raw || (typeof r === 'object' && r?.name === 'AbortError') || /\babort(?:ed)?\b|cancel(?:l)?ed/i.test(raw)) return
  if (!/remote method/i.test(raw)) return // only app API calls; let other code's rejections be
  e.preventDefault()
  const body = cleanIpcError(raw)
  const now = Date.now()
  if (lastUnhandled && lastUnhandled.body === body && now - lastUnhandled.at < 8000) return
  lastUnhandled = { body, at: now }
  notify({ id: `unhandled-${body.slice(0, 60)}`, kind: 'error', title: 'Something went wrong', body })
}
let lastUnhandled: { body: string; at: number } | null = null

/** Subscribe to main-process notifications. Called once by App. */
export function initNotifications(): () => void {
  if (installed) return () => {}
  installed = true
  const off = ghost().on('notify', receive)
  const offUi = useUI.subscribe((s, p) => {
    if (s.overlays.notifications && !p.overlays.notifications) useNotifications.getState().markAllRead()
  })
  window.addEventListener('unhandledrejection', onUnhandled)
  return () => {
    off()
    offUi()
    window.removeEventListener('unhandledrejection', onUnhandled)
    installed = false
  }
}
