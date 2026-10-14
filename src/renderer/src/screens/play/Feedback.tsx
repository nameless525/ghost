// Play screen feedback bits: the on-screen display toast (V / M / seek), the centre play/pause
// pop, the error / fallback notices and the "Nothing playing" state.
import { AlertTriangle, Compass, LibraryBig, Pause, Play, RotateCcw, SkipForward, X } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { ghost } from '../../ghost'
import { tween } from '../../motion/tween'
import { navigate } from '../../shell/navigation'
import { usePlayer } from '../../state/player'
import { useUI } from '../../state/ui'
import { Button, GhostMark, IconButton } from '../../ui'

// ---------------------------------------------------------------------------
// OSD (osu!-style "setting changed" toast, top centre)

export interface OsdHandle {
  show(o: { icon?: ReactNode; label: ReactNode; value?: ReactNode }): void
}

export const Osd = forwardRef<OsdHandle>(function Osd(_props, ref) {
  const el = useRef<HTMLDivElement>(null)
  const [content, setContent] = useState<{ icon?: ReactNode; label: ReactNode; value?: ReactNode } | null>(null)
  const timer = useRef(0)
  useImperativeHandle(ref, () => ({
    show(o) {
      setContent(o)
      const n = el.current
      if (!n) return
      const t = tween(n)
      if (n.style.opacity !== '1') t.set({ opacity: 0, y: -14, scale: 0.94 })
      t.fadeIn(160, 'outQuad').moveToY(0, 480, 'outQuint').scaleTo(1, 480, 'outBack')
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => tween(n).fadeOut(380, 'outQuad').moveToY(-8, 420, 'outQuint'), 1300)
    }
  }))
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <div ref={el} className="pl-osd" style={{ opacity: 0 }} role="status" aria-live="polite">
      {content && (
        <>
          {content.icon && <span className="pl-osd__icon">{content.icon}</span>}
          <span className="pl-osd__label">{content.label}</span>
          {content.value != null && <span className="pl-osd__value">{content.value}</span>}
        </>
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// play/pause pop + persistent "paused" chip

export function PausePop({ enabled }: { enabled: boolean }) {
  const pop = useRef<HTMLDivElement>(null)
  const [icon, setIcon] = useState<'play' | 'pause'>('pause')
  const status = usePlayer((s) => s.status)
  const prev = useRef(status)
  useEffect(() => {
    const p = prev.current
    prev.current = status
    if (!enabled || !pop.current) return
    const toggled = (p === 'playing' && status === 'paused') || (p === 'paused' && status === 'playing')
    if (!toggled) return
    setIcon(status === 'paused' ? 'pause' : 'play')
    tween(pop.current).clear().set({ opacity: 0.95, scale: 0.7 }).scaleTo(1.25, 620, 'outQuint').fadeOut(620, 'inQuad')
  }, [status, enabled])
  return (
    <>
      <div ref={pop} className="pl-pop" style={{ opacity: 0 }} aria-hidden>
        {icon === 'pause' ? <Pause /> : <Play />}
      </div>
      <div className={`pl-paused${status === 'paused' && enabled ? ' pl-paused--on' : ''}`} aria-hidden={status !== 'paused'}>
        <Pause size={12} strokeWidth={3} /> Paused
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// errors

export function ErrorNotice({ message }: { message: string | null }) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (el.current) tween(el.current).set({ opacity: 0, y: 16, scale: 0.97 }).fadeIn(240, 'outQuad').moveToY(0, 520, 'outQuint').scaleTo(1, 520, 'outQuint')
  }, [])
  return (
    <div ref={el} className="pl-error" role="alert">
      <div className="pl-error__icon">
        <AlertTriangle />
      </div>
      <div className="pl-error__title">Couldn’t play this track</div>
      <div className="pl-error__body">{message ?? 'Every source for it failed. It may be region-locked, removed, or the network is down.'}</div>
      <div className="pl-error__actions">
        <Button variant="primary" icon={<SkipForward size={16} />} onClick={() => void ghost().player.next()}>
          Skip to next
        </Button>
        <Button variant="soft" icon={<RotateCcw size={16} />} onClick={() => void ghost().player.play()}>
          Retry
        </Button>
        <Button variant="ghost" icon={<Compass size={16} />} onClick={() => navigate('browse')}>
          Browse
        </Button>
      </div>
    </div>
  )
}

/** A non-fatal problem while still playing (e.g. fell back to another source). */
export function FallbackBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (el.current) tween(el.current).set({ opacity: 0, y: -12 }).fadeIn(220).moveToY(0, 480, 'outQuint')
    const t = window.setTimeout(onDismiss, 7000)
    return () => window.clearTimeout(t)
  }, [message]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={el} className="pl-banner" role="status">
      <AlertTriangle size={15} />
      <span className="pl-banner__text">{message}</span>
      <IconButton size="sm" label="Dismiss" icon={<X />} onClick={onDismiss} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// nothing playing

export const EmptyState = forwardRef<HTMLDivElement>(function EmptyState(_props, ref) {
  return (
    <div ref={ref} className="pl-empty">
      <div className="pl-empty__disc">
        <span className="pl-empty__ring" />
        <span className="pl-empty__ring pl-empty__ring--2" />
        <GhostMark size={72} />
      </div>
      <div className="pl-empty__title">Nothing playing</div>
      <div className="pl-empty__body">Pick a soundtrack in Browse — the player comes alive as soon as the music starts.</div>
      <div className="pl-empty__actions">
        <Button variant="primary" size="lg" icon={<Compass size={18} />} sound="confirm" onClick={() => navigate('browse')}>
          Browse soundtracks
        </Button>
        <Button variant="soft" size="lg" icon={<LibraryBig size={18} />} onClick={() => useUI.getState().toggleOverlay('library', true)}>
          Library
        </Button>
      </div>
    </div>
  )
})
