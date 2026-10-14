// Overlay panels (Library, Settings, Downloads, Now Playing, Notifications).
//
// The host owns the chrome: slide-in panel with the overlay's hue, backdrop dim for modal
// overlays, focus trap, Esc / click-outside to close, open/close whooshes, mutual exclusion,
// and the music low-pass (ghost().player.setOverlayFilter) while a modal overlay is open.
// Contents are lazy components from src/renderer/src/overlays/*/index.tsx (OverlayProps).
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type LazyExoticComponent } from 'react'
import { ghost } from '../ghost'
import { tween } from '../motion/tween'
import { sfx } from '../sound'
import { anyModalOverlay, useUI, type OverlayId } from '../state/ui'
import { HUES } from '../theme'
import { LoadingRing } from '../ui/LoadingRing'
import { cx, hueStyle, useFocusTrap } from '../ui/util'
import { ErrorBoundary } from './ErrorBoundary'
import { KeyScopeContext, registerKeybinding, type KeyScopeValue } from './keys'
import type { OverlayPhase, OverlayProps } from './types'

type Side = 'left' | 'right' | 'drop'

interface OverlayDef {
  side: Side
  /** Modal overlays dim the screen, mute-filter the music and are mutually exclusive. */
  modal: boolean
  hue: keyof typeof HUES | null
  /** CSS width. */
  width: string
  label: string
  load: LazyExoticComponent<ComponentType<OverlayProps>>
}

export const OVERLAYS: Record<OverlayId, OverlayDef> = {
  library: { side: 'right', modal: true, hue: 'library', width: 'clamp(560px, 50vw, 900px)', label: 'Library', load: lazy(() => import('../overlays/library')) },
  downloads: { side: 'right', modal: true, hue: 'downloads', width: 'clamp(400px, 32vw, 520px)', label: 'Downloads', load: lazy(() => import('../overlays/downloads')) },
  settings: { side: 'left', modal: true, hue: 'settings', width: 'clamp(500px, 38vw, 660px)', label: 'Settings', load: lazy(() => import('../overlays/settings')) },
  nowPlaying: { side: 'drop', modal: false, hue: null, width: '460px', label: 'Now playing', load: lazy(() => import('../overlays/now-playing')) },
  notifications: { side: 'right', modal: false, hue: 'notifications', width: '400px', label: 'Notifications', load: lazy(() => import('./NotificationCenter')) }
}

const IDS = Object.keys(OVERLAYS) as OverlayId[]

/** Open order, most recent last. */
let order: OverlayId[] = []
export const topOverlay = (): OverlayId | null => order[order.length - 1] ?? null

export function OverlayHost() {
  const overlays = useUI((s) => s.overlays)
  const modalOpen = useUI(anyModalOverlay)
  const [mounted, setMounted] = useState<Set<OverlayId>>(() => new Set(IDS.filter((id) => useUI.getState().overlays[id])))

  // bookkeeping on every open/close: order, exclusivity, sounds, mount-on-first-open
  useEffect(() => {
    const st = useUI.getState()
    order = IDS.filter((id) => st.overlays[id])
    let prevOverlays = st.overlays
    const unsub = useUI.subscribe((s) => {
      const prev = prevOverlays
      prevOverlays = s.overlays
      if (s.overlays === prev) return
      const opened = IDS.filter((id) => s.overlays[id] && !prev[id])
      const closed = IDS.filter((id) => !s.overlays[id] && prev[id])
      order = order.filter((id) => !closed.includes(id))
      for (const id of opened) {
        order = [...order.filter((x) => x !== id), id]
        const def = OVERLAYS[id]
        // exclusivity: a modal closes other modals and popovers; a popover closes other popovers
        for (const other of IDS) {
          if (other === id || !useUI.getState().overlays[other]) continue
          const o = OVERLAYS[other]
          if (def.modal || !o.modal) useUI.getState().toggleOverlay(other, false)
        }
      }
      if (opened.length) {
        sfx.play('open', { volume: opened.some((id) => OVERLAYS[id].modal) ? 1 : 0.6 })
        setMounted((m) => (opened.every((id) => m.has(id)) ? m : new Set([...m, ...opened])))
      } else if (closed.length) sfx.play('close', { volume: closed.some((id) => OVERLAYS[id].modal) ? 1 : 0.6 })
    })
    return unsub
  }, [])

  // muffle the music behind modal overlays (osu!-style)
  useEffect(() => {
    void ghost().player.setOverlayFilter(modalOpen).catch(() => {})
  }, [modalOpen])

  // Esc closes the top overlay (overlay contents may bind Esc themselves at higher priority)
  useEffect(
    () =>
      registerKeybinding(
        'Escape',
        () => {
          const top = topOverlay()
          if (!top) return false
          useUI.getState().toggleOverlay(top, false)
        },
        { scope: 'overlay', priority: -100 },
        { scope: 'overlay', isActive: () => order.length > 0, id: 'overlay-host' }
      ),
    []
  )

  const closeTopModal = () => {
    for (let i = order.length - 1; i >= 0; i--) {
      if (OVERLAYS[order[i]].modal) {
        useUI.getState().toggleOverlay(order[i], false)
        return
      }
    }
  }

  return (
    <>
      <div className={cx('g-overlay-dim', modalOpen && 'g-overlay-dim--visible')} onPointerDown={closeTopModal} aria-hidden />
      {IDS.filter((id) => mounted.has(id)).map((id) => (
        <OverlayPanel key={id} id={id} def={OVERLAYS[id]} open={overlays[id]} />
      ))}
    </>
  )
}

function OverlayPanel({ id, def, open }: { id: OverlayId; def: OverlayDef; open: boolean }) {
  const panel = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<OverlayPhase>(open ? 'entering' : 'closed')
  const [isTop, setIsTop] = useState(false)
  const firstRun = useRef(true)
  const close = useMemo(() => () => useUI.getState().toggleOverlay(id, false), [id])
  const hue = def.hue ? `var(--hue-${def.hue})` : 'var(--accent)'

  useEffect(() => {
    // deferred: the host's own store listener (which maintains `order`) may run after ours
    let alive = true
    const update = () => queueMicrotask(() => alive && setIsTop(topOverlay() === id))
    update()
    const unsub = useUI.subscribe(update)
    return () => {
      alive = false
      unsub()
    }
  }, [id])

  useFocusTrap(panel, open && isTop && (def.modal || id === 'notifications'))

  useLayoutEffect(() => {
    const el = panel.current
    const b = body.current
    if (!el || !b) return
    // A closed panel is display:none (data-phase='closed'): it must be laid out before we can
    // measure it or slide it in. React re-renders the same phase right after.
    if (open && el.dataset.phase === 'closed') el.dataset.phase = 'entering'
    const w = el.offsetWidth + 40
    const hidden = def.side === 'left' ? { x: -w, y: 0 } : def.side === 'right' ? { x: w, y: 0 } : { x: 0, y: -24 }
    if (open) {
      if (def.side === 'drop') alignDrop(el)
      el.removeAttribute('inert')
      setPhase('entering')
      const t = tween(el).clear()
      if (phase === 'closed' || firstRun.current) t.set({ ...hidden, opacity: def.side === 'drop' ? 0 : 1, scale: def.side === 'drop' ? 0.97 : 1 })
      t.moveTo(0, 0, def.side === 'drop' ? 420 : 560, 'outQuint').scaleTo(1, 420, 'outQuint').fadeIn(def.side === 'drop' ? 180 : 0)
      tween(b).clear().set({ opacity: 0, x: def.side === 'left' ? -24 : def.side === 'right' ? 24 : 0, y: def.side === 'drop' ? -6 : 0 }).delay(90).fadeIn(320, 'outQuad').moveTo(0, 0, 520, 'outQuint')
      void t.then(() => setPhase((p) => (p === 'entering' ? 'open' : p)))
      firstRun.current = false
    } else if (phase !== 'closed' && !firstRun.current) {
      setPhase('exiting')
      tween(b).clear().fadeOut(160, 'outQuad')
      void tween(el)
        .clear()
        .moveTo(hidden.x, hidden.y, def.side === 'drop' ? 260 : 440, 'outQuint')
        .fadeTo(def.side === 'drop' ? 0 : 1, 200)
        .then(() => {
          if (useUI.getState().overlays[id]) return
          setPhase('closed')
          el.setAttribute('inert', '')
        })
    }
    firstRun.current = false
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // popovers close on click outside (ignoring their own toolbar toggle)
  useEffect(() => {
    if (!open || def.modal) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element
      if (panel.current?.contains(t)) return
      if (t.closest?.(`[data-overlay-toggle="${id}"]`)) return
      if (t.closest?.('[role="menu"], [role="listbox"], [role="dialog"], .g-toasts')) return
      close()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open, def.modal, id, close])

  const scope = useMemo<KeyScopeValue>(() => ({ scope: 'overlay', id, isActive: () => topOverlay() === id }), [id])
  const Content = def.load
  const props: OverlayProps = { open, phase, close, hue }

  return (
    <div
      ref={panel}
      className={cx('g-ov', `g-ov--${def.side}`, `g-ov--${id}`, def.modal && 'g-ov--modal')}
      style={{ width: def.width, ...hueStyle(def.hue ?? undefined), '--ov-hue': hue } as CSSProperties}
      role={def.modal ? 'dialog' : 'region'}
      aria-modal={def.modal || undefined}
      aria-label={def.label}
      tabIndex={-1}
      data-overlay={id}
      data-phase={phase}
    >
      <div className="g-ov__edge" />
      <div ref={body} className="g-ov__body">
        <KeyScopeContext.Provider value={scope}>
          <ErrorBoundary label={def.label} compact>
            <Suspense fallback={<LoadingRing center />}>
              <Content {...props} />
            </Suspense>
          </ErrorBoundary>
        </KeyScopeContext.Provider>
      </div>
    </div>
  )
}

/** Hang the drop-down under its toolbar toggle (the now-playing chip). */
function alignDrop(el: HTMLElement): void {
  const anchor = document.querySelector<HTMLElement>('[data-overlay-toggle="nowPlaying"]')
  if (!anchor) return
  const r = anchor.getBoundingClientRect()
  const w = el.offsetWidth
  const right = Math.max(10, window.innerWidth - r.right - Math.max(0, (w - r.width) / 2) * 0.35)
  el.style.right = `${Math.min(right, window.innerWidth - w - 10)}px`
}
