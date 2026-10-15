// An in-panel toast with an action button (e.g. "Exported … [Reveal]"). The app-wide toasts
// have no actions, so overlays that need one render <SnackHost/> at the bottom of their body.
import { CircleCheck, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { tween } from '../../motion/tween'
import { sfx } from '../../sound'
import { cx } from '../../ui/util'
import './common.css'

export interface Snack {
  id: number
  /** Which host shows it ('library', 'settings'…). */
  host: string
  icon?: ReactNode
  title: ReactNode
  body?: ReactNode
  action?: { label: string; icon?: ReactNode; onClick: () => void }
  /** ms; default 7000. */
  duration?: number
}

const useSnacks = create<{ current: Snack | null }>(() => ({ current: null }))
let seq = 0

export function showSnack(s: Omit<Snack, 'id'>): void {
  sfx.play('notify', { volume: 0.7 })
  useSnacks.setState({ current: { ...s, id: ++seq } })
}

export function SnackHost({ host }: { host: string }) {
  const current = useSnacks((s) => (s.current?.host === host ? s.current : null))
  const [shown, setShown] = useState<Snack | null>(current)
  const el = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const hovered = useRef(false)

  useEffect(() => {
    if (current) setShown(current)
  }, [current])

  /** Snack whose action already ran (one-shot: a double-click ran Undo twice). */
  const acted = useRef<number | null>(null)

  const dismiss = () => {
    // Only this snack: a newer one arriving mid-exit clears this tween (which fires the callback),
    // and the old unconditional setShown(null) hid the new snack for good.
    const id = shown?.id
    void tween(el.current)
      .clear()
      .fadeOut(160, 'outQuad')
      .moveToY(24, 260, 'outQuint')
      .then(() => {
        setShown((s) => (s?.id === id ? null : s))
        if (useSnacks.getState().current?.id === id) useSnacks.setState({ current: null })
      })
  }

  useLayoutEffect(() => {
    if (!shown || !el.current) return
    tween(el.current).clear().set({ opacity: 0, y: 30, scale: 0.96 }).fadeIn(200, 'outQuad').moveToY(0, 520, 'outQuint').scaleTo(1, 700, 'outElasticHalf')
    const total = shown.duration ?? 7000
    let left = total
    let last = performance.now()
    const iv = window.setInterval(() => {
      const now = performance.now()
      if (!hovered.current) left -= now - last
      last = now
      if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, left / total)})`
      if (left <= 0) {
        window.clearInterval(iv)
        dismiss()
      }
    }, 100)
    return () => window.clearInterval(iv)
  }, [shown?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown) return null
  return (
    <div className="lx-snack-wrap">
      <div ref={el} className="lx-snack" role="status" onPointerEnter={() => (hovered.current = true)} onPointerLeave={() => (hovered.current = false)}>
        <div className="lx-snack__icon">{shown.icon ?? <CircleCheck />}</div>
        <div className="lx-snack__text">
          <div className="lx-snack__title">{shown.title}</div>
          {shown.body && <div className="lx-snack__body">{shown.body}</div>}
        </div>
        {shown.action && (
          <button
            type="button"
            className={cx('lx-snack__action')}
            onPointerEnter={() => sfx.play('hover')}
            onClick={() => {
              if (acted.current === shown.id) return
              acted.current = shown.id
              sfx.play('confirm', { volume: 0.7 })
              shown.action!.onClick()
              dismiss()
            }}
          >
            {shown.action.icon}
            {shown.action.label}
          </button>
        )}
        <button type="button" className="lx-snack__close" aria-label="Dismiss" onClick={dismiss}>
          <X />
        </button>
        <div className="lx-snack__timer">
          <div ref={bar} className="lx-snack__timer-fill" />
        </div>
      </div>
    </div>
  )
}
