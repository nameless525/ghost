// osu!-style toast stack under the toolbar (right). Cards slide in from the right, restack
// smoothly when others leave, auto-dismiss (hover the stack to pause), and update in place
// when a notification with the same id arrives again (timer resets).
import { CircleAlert, CircleCheck, Info, LoaderCircle, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ticker } from '../motion/ticker'
import { tween } from '../motion/tween'
import { useUI } from '../state/ui'
import { CoverArt } from '../ui/CoverArt'
import { cx } from '../ui/util'
import { useNotifications, type Toast } from './notifications'

const GAP = 8
const OFFSCREEN = 400

function lifetime(t: Toast): number {
  if (t.kind === 'progress' && (t.progress ?? 0) < 1) return Infinity
  if (t.kind === 'error') return 9000
  if (t.kind === 'progress') return 3500
  return 5200
}

interface Item {
  toast: Toast
  leaving: boolean
}

export function ToastStack() {
  const toasts = useNotifications((s) => s.toasts)
  const dismiss = useNotifications((s) => s.dismiss)
  const overlays = useUI((s) => s.overlays)
  const centreOpen = overlays.notifications
  const stack = useRef<HTMLDivElement>(null)
  const [items, setItems] = useState<Item[]>([])
  const els = useRef(new Map<string, HTMLDivElement>())
  const known = useRef(new Set<string>())
  const timers = useRef(new Map<string, { rev: number; left: number; total: number }>())
  const hovered = useRef(false)

  // mirror the store, keeping removed cards around while they animate out
  useEffect(() => {
    setItems((prev) => {
      const ids = new Set(toasts.map((t) => t.id))
      const next: Item[] = toasts.map((t) => ({ toast: t, leaving: false }))
      prev.forEach((p, i) => {
        if (!ids.has(p.toast.id)) next.splice(Math.min(i, next.length), 0, { toast: p.toast, leaving: true })
      })
      return next
    })
  }, [toasts])

  // the notification centre replaces the stack while it's open
  useEffect(() => {
    if (centreOpen) useNotifications.getState().dismissAll()
  }, [centreOpen])

  // slide the whole stack left so it never covers an open right-side panel / the now-playing drop-down
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      let off = 0
      for (const o of ['library', 'downloads'] as const) {
        if (!overlays[o]) continue
        const el = document.querySelector<HTMLElement>(`[data-overlay="${o}"]`)
        if (el) off = Math.max(off, el.offsetWidth)
      }
      if (overlays.nowPlaying) {
        const el = document.querySelector<HTMLElement>('[data-overlay="nowPlaying"]')
        if (el) off = Math.max(off, el.offsetWidth + (parseFloat(el.style.right) || 12) - 4)
      }
      tween(stack.current).moveToX(-off, 520, 'outQuint')
    })
    return () => cancelAnimationFrame(id)
  }, [overlays])

  // layout: stack visible cards top-down with transforms only
  useLayoutEffect(() => {
    let y = 0
    for (const it of items) {
      const el = els.current.get(it.toast.id)
      if (!el) continue
      const h = el.offsetHeight
      if (it.leaving) {
        if (el.dataset.leaving !== '1') {
          el.dataset.leaving = '1'
          const id = it.toast.id
          void tween(el)
            .clear()
            .moveToX(OFFSCREEN, 420, 'outQuint')
            .fadeOut(260, 'outQuad')
            .then(() => {
              known.current.delete(id)
              timers.current.delete(id)
              setItems((l) => l.filter((x) => !(x.leaving && x.toast.id === id)))
            })
        }
        continue
      }
      if (el.dataset.leaving === '1') {
        // dismissed card revived by an update with the same id: cancel the exit, slide back in
        delete el.dataset.leaving
        tween(el).clear()
        known.current.delete(it.toast.id)
      }
      if (!known.current.has(it.toast.id)) {
        known.current.add(it.toast.id)
        tween(el).set({ x: OFFSCREEN, y, opacity: 0 }).fadeIn(220, 'outQuad').moveToX(0, 620, 'outQuint')
      } else {
        tween(el).moveToY(y, 480, 'outQuint')
      }
      y += h + GAP
    }
  }, [items])

  // timers (only tick while cards exist)
  const hasItems = items.some((i) => !i.leaving)
  useEffect(() => {
    if (!hasItems) return
    return ticker.add((dt) => {
      const list = useNotifications.getState().toasts
      for (const t of list) {
        let tm = timers.current.get(t.id)
        const total = lifetime(t)
        if (!tm || tm.rev !== t.rev) {
          tm = { rev: t.rev, left: total, total }
          timers.current.set(t.id, tm)
        }
        const timed = Number.isFinite(tm.left)
        if (!hovered.current && timed) tm.left -= dt
        // the timer bar is the card's last child (no per-frame querySelector); untimed cards
        // (progress) only need it written once
        const bar = els.current.get(t.id)?.lastElementChild as HTMLElement | null | undefined
        if (bar && (timed || bar.dataset.v === undefined)) {
          const f = Number.isFinite(tm.total) ? Math.max(0, tm.left / tm.total) : 0
          const s = f.toFixed(3)
          if (bar.dataset.v !== s) {
            bar.dataset.v = s
            bar.style.transform = `scaleX(${s})`
          }
        }
        if (tm.left <= 0) dismiss(t.id)
      }
    })
  }, [hasItems, dismiss])

  return (
    <div
      ref={stack}
      className="g-toasts"
      onPointerEnter={() => (hovered.current = true)}
      onPointerLeave={() => (hovered.current = false)}
      aria-live="polite"
    >
      {items.map(({ toast: t, leaving }) => (
        <div
          key={t.id}
          ref={(el) => {
            if (el) els.current.set(t.id, el)
            else els.current.delete(t.id)
          }}
          className={cx('g-toast', `g-toast--${t.kind}`, leaving && 'g-toast--leaving')}
          role={t.kind === 'error' ? 'alert' : 'status'}
          onClick={() => dismiss(t.id)}
        >
          <div className="g-toast__edge" />
          <div className="g-toast__icon">
            {t.image ? (
              <CoverArt src={t.image} size={40} radius={8} />
            ) : (
              <span className="g-toast__glyph">
                {t.kind === 'success' ? <CircleCheck /> : t.kind === 'error' ? <CircleAlert /> : t.kind === 'progress' ? <LoaderCircle className="g-toast__spin g-keep-motion" /> : <Info />}
              </span>
            )}
          </div>
          <div className="g-toast__text">
            <div className="g-toast__title">{t.title}</div>
            {t.body && <div className="g-toast__body">{t.body}</div>}
            {t.kind === 'progress' && (
              <div className="g-toast__progress">
                <div className="g-toast__progress-fill" style={{ transform: `scaleX(${Math.max(0, Math.min(1, t.progress ?? 0))})` }} />
              </div>
            )}
          </div>
          <button
            type="button"
            className="g-toast__close"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation()
              dismiss(t.id)
            }}
          >
            <X />
          </button>
          <div className="g-toast__timer" />
        </div>
      ))}
    </div>
  )
}
