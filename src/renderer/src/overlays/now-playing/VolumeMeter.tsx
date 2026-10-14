// osu!-style volume meter: a glass disc with a spring-driven ring that pops in at the right edge
// whenever the volume changes (↑/↓ on Play, Alt+scroll anywhere, any volume slider), then fades
// out ~1 s after the last change. Hover keeps it up; scroll over it to adjust; click to mute.
// Mounted once, globally (App.tsx).
import { Volume, Volume1, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Spring } from '../../motion/spring'
import { tween } from '../../motion/tween'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { cx } from '../../ui/util'
import { volume, type VolumeSnapshot } from './volume'
import './volume-meter.css'

const R = 50
const C = 2 * Math.PI * R
const HIDE_MS = 1000
/** Ignore store changes right after startup (the initial state sync isn't a user change). */
const GRACE_MS = 2500

export function volumeIcon(v: number, muted: boolean) {
  if (muted || v <= 0.001) return VolumeX
  if (v < 0.34) return Volume
  if (v < 0.67) return Volume1
  return Volume2
}

/** Wheel → volume delta: one mouse notch ≈ 5%, trackpads proportional. */
export function wheelToVolume(e: WheelEvent): number {
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 600 : 1
  const d = -(Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * unit
  return Math.max(-0.1, Math.min(0.1, d * 0.0005))
}

export function VolumeMeter() {
  const root = useRef<HTMLDivElement>(null)
  const arc = useRef<SVGCircleElement>(null)
  const glow = useRef<SVGCircleElement>(null)
  const num = useRef<HTMLSpanElement>(null)
  const [snap, setSnap] = useState<VolumeSnapshot>(() => ({ volume: usePlayer.getState().volume, muted: usePlayer.getState().muted }))
  const [visible, setVisible] = useState(false)
  const shown = useRef(false)
  const hovering = useRef(false)
  const hideTimer = useRef(0)
  const lastTick = useRef(-1)
  const spring = useMemo(() => new Spring({ value: usePlayer.getState().volume, frequency: 3.4, damping: 0.82 }), [])

  // ring + number follow the spring (ticks only while it moves)
  useEffect(
    () =>
      spring.drive((v) => {
        const f = Math.max(0, Math.min(1, v))
        const off = (C * (1 - f)).toFixed(2)
        arc.current?.setAttribute('stroke-dashoffset', off)
        glow.current?.setAttribute('stroke-dashoffset', off)
        const n = String(Math.round(f * 100))
        if (num.current && num.current.textContent !== n) num.current.textContent = n
      }),
    [spring]
  )

  useEffect(() => {
    const el = root.current
    if (!el) return
    tween(el).set({ opacity: 0, x: 24, scale: 0.86 })
    // Hidden = display:none: the meter is mounted for the app's lifetime, and while merely
    // transparent its accent-coloured strokes and backdrop blur still restyle/animate (e.g. on
    // every accent change) for nothing.
    el.style.display = 'none'

    const hide = () => {
      if (!shown.current) return
      if (hovering.current) return arm()
      shown.current = false
      setVisible(false)
      tween(el)
        .fadeOut(320, 'outQuad')
        .moveToX(20, 460, 'outQuint')
        .scaleTo(0.94, 460, 'outQuint')
        .then(() => {
          if (!shown.current) el.style.display = 'none'
        })
    }
    const arm = (ms = HIDE_MS) => {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = window.setTimeout(hide, ms)
    }
    const show = (v: VolumeSnapshot) => {
      setSnap((s) => (s.volume === v.volume && s.muted === v.muted ? s : v))
      spring.to(v.muted ? 0 : v.volume)
      // a soft tick per 5% step, like the kit sliders
      const bucket = Math.round(v.volume * 20)
      if (bucket !== lastTick.current) {
        if (shown.current) sfx.play('tick')
        lastTick.current = bucket
      }
      if (!shown.current) {
        shown.current = true
        setVisible(true)
        el.style.display = ''
        tween(el).fadeIn(160, 'outQuad').moveToX(0, 520, 'outQuint').scaleTo(1, 520, 'outBack')
      } else {
        // a little kick on every change while visible
        tween(el).scaleTo(1.035, 60, 'outQuad').then().scaleTo(1, 420, 'outElasticHalf')
      }
      arm()
    }

    const offCtl = volume.subscribe(show)
    const mountedAt = performance.now()
    let prev = { volume: usePlayer.getState().volume, muted: usePlayer.getState().muted }
    const offStore = usePlayer.subscribe((s) => {
      if (s.volume === prev.volume && s.muted === prev.muted) return
      prev = { volume: s.volume, muted: s.muted }
      const shownV = volume.get()
      if (performance.now() - mountedAt < GRACE_MS) {
        spring.set(s.muted ? 0 : s.volume)
        setSnap(prev)
        return
      }
      // echoes of our own optimistic changes are already shown
      if (Math.abs(shownV.volume - s.volume) < 0.002 && shownV.muted === s.muted && shown.current) return
      show(prev)
    })

    // Alt+scroll anywhere
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      const d = wheelToVolume(e)
      if (d) volume.nudge(d)
    }
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    // scroll over the meter itself (no modifier needed)
    const onOwnWheel = (e: WheelEvent) => {
      if (!shown.current) return
      e.preventDefault()
      e.stopPropagation()
      const d = wheelToVolume(e)
      if (d) volume.nudge(d)
    }
    el.addEventListener('wheel', onOwnWheel, { passive: false })
    return () => {
      offCtl()
      offStore()
      window.removeEventListener('wheel', onWheel, { capture: true })
      el.removeEventListener('wheel', onOwnWheel)
      window.clearTimeout(hideTimer.current)
    }
  }, [spring])

  const Icon = volumeIcon(snap.volume, snap.muted)

  return (
    <div
      ref={root}
      className={cx('g-volmeter', visible && 'g-volmeter--visible', snap.muted && 'g-volmeter--muted')}
      role="status"
      aria-live="polite"
      aria-label={snap.muted ? 'Muted' : `Volume ${Math.round(snap.volume * 100)}%`}
      onPointerEnter={() => {
        hovering.current = true
        window.clearTimeout(hideTimer.current)
      }}
      onPointerLeave={() => {
        hovering.current = false
        if (shown.current) volume.peek()
      }}
    >
      <div className="g-volmeter__disc">
        <svg className="g-volmeter__svg" viewBox="0 0 132 132" aria-hidden>
          <circle className="g-volmeter__ticks" cx="66" cy="66" r={R + 10} />
          <circle className="g-volmeter__track" cx="66" cy="66" r={R} />
          <circle ref={glow} className="g-volmeter__glow" cx="66" cy="66" r={R} strokeDasharray={C.toFixed(2)} strokeDashoffset={C * (1 - snap.volume)} />
          <circle ref={arc} className="g-volmeter__arc" cx="66" cy="66" r={R} strokeDasharray={C.toFixed(2)} strokeDashoffset={C * (1 - snap.volume)} />
        </svg>
        <button
          type="button"
          className="g-volmeter__center"
          tabIndex={-1}
          aria-label={snap.muted ? 'Unmute' : 'Mute'}
          onClick={() => {
            sfx.play(snap.muted ? 'toggleOn' : 'toggleOff')
            volume.toggleMute()
          }}
        >
          <span className="g-volmeter__value tnum">
            <span ref={num}>{Math.round(snap.volume * 100)}</span>
            <small>%</small>
          </span>
          <span className="g-volmeter__label">
            <Icon size={12} strokeWidth={2.4} />
            {snap.muted ? 'Muted' : 'Volume'}
          </span>
        </button>
      </div>
    </div>
  )
}
