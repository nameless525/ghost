// Title ("Press Start"): GHOST's main menu, the osu! main-menu analogue.
//  · big disc logo with a mirrored radial spectrum ring, pulsing on beats, label text spinning while playing
//  · hover: lift + glow; click / any key: the logo slides left and sheared buttons fan out on an arc
//  · attract mode after 20 s idle: buttons retract, the logo drifts
//  · background follows the current track's hero art; a now-playing line sits at the bottom
import { Compass, CornerDownLeft, LibraryBig, Radio, Settings } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useIdle, useNowPlayingBackground } from '../../hooks'
import { beat } from '../../motion/beat'
import { damp } from '../../motion/easing'
import { frame } from '../../motion/frame'
import { useAudioLevels, usePulse } from '../../motion/hooks'
import { motionPrefs } from '../../motion/prefs'
import { ticker, TickPriority } from '../../motion/ticker'
import { stagger, tween } from '../../motion/tween'
import { useKeybinding } from '../../shell/keys'
import { navigate } from '../../shell/navigation'
import { preloadScreen, useScreenTransitions } from '../../shell/ScreenStack'
import type { ScreenProps } from '../../shell/types'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { useUI } from '../../state/ui'
import { accentNow } from '../../theme/accent'
import { Kbd } from '../../ui/Kbd'
import { ShearButton } from '../../ui/ShearButton'
import { Tooltip } from '../../ui/Tooltip'
import { cx } from '../../ui/util'
import { GhostLogo } from './GhostLogo'
import { RingVisualiser } from './RingVisualiser'
import './title.css'

type MenuId = 'browse' | 'library' | 'radio' | 'settings'

const MENU: { id: MenuId; label: string; hint: string; icon: typeof Compass; hue: 'browse' | 'library' | 'radio' | 'settings'; soon?: boolean }[] = [
  { id: 'browse', label: 'Browse', hint: 'Find any soundtrack', icon: Compass, hue: 'browse' },
  { id: 'library', label: 'Library', hint: 'Playlists, likes & history', icon: LibraryBig, hue: 'library' },
  { id: 'radio', label: 'Radio', hint: 'Endless mixes', icon: Radio, hue: 'radio', soon: true },
  { id: 'settings', label: 'Settings', hint: 'Audio, sources & look', icon: Settings, hue: 'settings' }
]

const EXPANDED_SCALE = 0.62
const BTN_W = 300
const BTN_GAP = 30
const SPACING = 78
const IDLE_MS = 20000

const logoSize = () => Math.round(Math.max(280, Math.min(window.innerHeight * 0.56, window.innerWidth * 0.4, 560)))

export default function TitleScreen(props: ScreenProps) {
  const intro = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const scaler = useRef<HTMLDivElement>(null)
  const floater = useRef<HTMLDivElement>(null)
  const logo = useRef<HTMLButtonElement>(null)
  const spin = useRef<HTMLDivElement>(null)
  const glow = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const wordmark = useRef<HTMLDivElement>(null)
  const footer = useRef<HTMLDivElement>(null)
  /** Positioning wrappers (tweened); the ShearButtons inside keep their own CSS transforms. */
  const slots = useRef<(HTMLDivElement | null)[]>([])
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const lifecycle = useRef(props.lifecycle)
  lifecycle.current = props.lifecycle

  const [D, setD] = useState(logoSize)
  const [expanded, setExpanded] = useState(props.from === 'browse' || props.from === 'play')
  const [hover, setHover] = useState(false)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const current = usePlayer((s) => s.current)
  const status = usePlayer((s) => s.status)
  const loadingLabel = usePlayer((s) => s.loading?.label ?? null)
  const anyOverlay = useUI((s) => Object.values(s.overlays).some(Boolean))
  const attract = useIdle(IDLE_MS, props.lifecycle !== 'exiting' && !anyOverlay)
  const attractRef = useRef(attract)
  attractRef.current = attract
  const sizeRef = useRef(D)
  sizeRef.current = D

  useNowPlayingBackground({ dim: 0.5, blur: 1 })
  useAudioLevels()
  usePulse(logo, { amount: 0.035 })
  usePulse(glow, { mode: 'var' })

  useEffect(() => {
    const onResize = () => setD(logoSize())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // arc layout for the fanned buttons, around the (scaled) logo centre
  const layout = useMemo(() => {
    const r1 = (D / 2) * EXPANDED_SCALE
    const R = r1 + BTN_GAP + 18
    return MENU.map((_, i) => {
      const y = (i - (MENU.length - 1) / 2) * SPACING
      const th = Math.asin(Math.max(-0.92, Math.min(0.92, y / R)))
      return { x: R * Math.cos(th) - 12, y, rot: (th * 180) / Math.PI * 0.16 }
    })
  }, [D])
  const shift = -(BTN_GAP + BTN_W) / 2 - D * 0.05

  // expand / collapse choreography
  const firstLayout = useRef(true)
  useLayoutEffect(() => {
    const instant = firstLayout.current
    firstLayout.current = false
    const d = instant ? 0 : 1
    tween(stage.current).moveToX(expanded ? shift : 0, 780 * d, 'outQuint')
    tween(scaler.current).scaleTo(expanded ? EXPANDED_SCALE : 1, 780 * d, 'outQuint')
    tween(wordmark.current)
      .fadeTo(expanded ? 0 : 1, (expanded ? 200 : 500) * d, 'outQuad')
      .moveToY(expanded ? -10 : 0, 500 * d, 'outQuint')
    slots.current.forEach((b, i) => {
      if (!b) return
      const L = layout[i]
      if (expanded) {
        const t = tween(b).clear()
        if (!instant) t.set({ opacity: 0, x: L.x * 0.15, y: L.y * 0.3, scale: 0.55, rotate: 0 }).delay(90 + i * 55)
        t.fadeIn(240 * d, 'outQuad')
          .moveTo(L.x, L.y, 760 * d, 'outQuint')
          .scaleTo(1, 760 * d, 'outBack')
          .rotateTo(L.rot, 760 * d, 'outQuint')
      } else {
        tween(b)
          .clear()
          .delay((MENU.length - 1 - i) * 30 * d)
          .fadeOut(200 * d, 'outQuad')
          .moveTo(L.x * 0.15, L.y * 0.3, 340 * d, 'inQuint')
          .scaleTo(0.6, 340 * d, 'inQuint')
          .rotateTo(0, 340 * d)
      }
    })
  }, [expanded, layout, shift])

  // attract mode: retract and let the logo drift
  useEffect(() => {
    if (attract && expandedRef.current) {
      sfx.play('collapse', { volume: 0.5 })
      setExpanded(false)
    }
  }, [attract])

  // per-frame: disc spin, attract drift, visualiser
  useEffect(() => {
    const vis = canvas.current ? new RingVisualiser(canvas.current) : null
    let angle = 0
    let speed = 0
    let drift = 0
    let notch = expandedRef.current ? 0 : 1
    const rgb = [0, 0, 0]
    const release = beat.retain()
    const off = ticker.add((dt, now) => {
      const ps = usePlayer.getState()
      const playing = ps.status === 'playing'
      const reduce = motionPrefs.reduce
      speed = damp(speed, playing && !reduce ? 26 : 0, 450, dt)
      angle = (angle + (speed * dt) / 1000) % 360
      if (spin.current) spin.current.style.transform = `rotate(${angle.toFixed(2)}deg)`

      drift = damp(drift, attractRef.current && !reduce ? 1 : 0, 900, dt)
      const f = floater.current
      if (f) {
        if (drift > 0.001) {
          const t = now / 1000
          const ax = window.innerWidth * 0.07
          const ay = window.innerHeight * 0.05
          f.style.transform = `translate3d(${(drift * ax * Math.sin(t * 0.21)).toFixed(1)}px, ${(drift * ay * Math.sin(t * 0.33 + 1.1)).toFixed(1)}px, 0) rotate(${(drift * 4 * Math.sin(t * 0.17)).toFixed(2)}deg)`
        } else if (f.style.transform) f.style.transform = ''
      }

      if (vis) {
        const sz = Math.round(sizeRef.current * 1.8)
        vis.resize(sz)
        const a = accentNow.rgb
        rgb[0] = 255 - (255 - a[0]) * 0.35
        rgb[1] = 255 - (255 - a[1]) * 0.35
        rgb[2] = 255 - (255 - a[2]) * 0.35
        // the wordmark under the logo shows only while the menu is collapsed
        notch = damp(notch, expandedRef.current ? 0 : 1, 300, dt)
        vis.draw(dt, now, frame(), sizeRef.current / 2 + 5, rgb, beat.kiai, beat.pulse, playing, notch)
      }
    }, TickPriority.normal)
    return () => {
      off()
      release()
    }
  }, [])
  const expand = () => {
    if (expandedRef.current) return
    sfx.play('expand')
    preloadScreen('browse')
    setExpanded(true)
  }
  const collapse = () => {
    if (!expandedRef.current) return
    sfx.play('collapse')
    setExpanded(false)
  }

  const activate = (id: MenuId, i: number) => {
    if (id === 'browse') navigate('browse')
    else if (id === 'library') useUI.getState().toggleOverlay('library', true)
    else if (id === 'settings') useUI.getState().toggleOverlay('settings', true)
    else if (id === 'radio') {
      const b = slots.current[i]
      const L = layout[i]
      if (b) void tween(b).clear().moveToX(L.x + 9, 50).then().moveToX(L.x - 7, 70).then().moveToX(L.x, 500, 'outElastic')
    }
  }

  // any key on the collapsed title opens the menu (bindings that handle keys run first)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || lifecycle.current !== 'active' || expandedRef.current) return
      if (e.metaKey || e.ctrlKey || e.altKey || ['Escape', 'Tab', 'Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key) || /^F\d/.test(e.key)) return
      const st = useUI.getState()
      if (Object.values(st.overlays).some(Boolean)) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      e.preventDefault()
      expand()
      window.setTimeout(() => buttons.current[0]?.focus({ preventScroll: true }), 120)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useKeybinding('Escape', () => (expandedRef.current ? collapse() : false))
  useKeybinding(['ArrowDown', 'ArrowUp'], (e) => {
    if (!expandedRef.current) return false
    const list = buttons.current.filter(Boolean) as HTMLButtonElement[]
    const idx = list.indexOf(document.activeElement as HTMLButtonElement)
    const next = idx < 0 ? 0 : (idx + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length
    list[next].focus({ preventScroll: true })
    sfx.play('hover')
  })
  useKeybinding('Enter', () => {
    if (!expandedRef.current) return expand()
    if (buttons.current.includes(document.activeElement as HTMLButtonElement)) return false // native activation
    navigate('browse')
  })

  useScreenTransitions({
    enter: ({ direction, other }) => {
      const first = other === null
      tween(footer.current).set({ opacity: 0, y: 12 }).delay(first ? 500 : 250).fadeIn(600, 'outQuad').moveToY(0, 700, 'outQuint')
      return tween(intro.current)
        .set({ opacity: 0, scale: direction === 'back' ? 1.14 : 0.86 })
        .fadeIn(first ? 600 : 420, 'outQuad')
        .scaleTo(1, first ? 1400 : 850, first ? 'outElasticQuarter' : 'outQuint').finished
    },
    exit: () => {
      stagger(
        slots.current,
        (t, i) => t.fadeOut(240, 'outQuad').moveToX(layout[i].x + 160, 420, 'inQuint'),
        30
      )
      tween(footer.current).fadeOut(220).moveToY(12, 300, 'inQuint')
      return tween(intro.current).delay(60).fadeOut(380, 'outQuad').scaleTo(1.22, 520, 'outQuint').finished
    }
  })

  const playing = status === 'playing'

  return (
    <div className={cx('tl-root', attract && 'tl-root--attract', expanded && 'tl-root--expanded')} style={{ '--logo': `${D}px` } as CSSProperties}>
      <div ref={intro} className="tl-intro">
        <div ref={stage} className="tl-stage">
          <div ref={scaler} className="tl-scaler">
            <div className={cx('tl-hover', hover && 'tl-hover--on')}>
              <div ref={floater} className="tl-float">
                <canvas ref={canvas} className="tl-vis" />
                <button
                  ref={logo}
                  type="button"
                  className="tl-logo"
                  aria-label={expanded ? 'Browse' : 'Open menu'}
                  onPointerEnter={() => {
                    setHover(true)
                    sfx.play('hover')
                    preloadScreen('browse')
                  }}
                  onPointerLeave={() => setHover(false)}
                  onClick={() => (expandedRef.current ? navigate('browse') : expand())}
                >
                  <GhostLogo glowRef={glow} spinRef={spin} />
                </button>
              </div>
            </div>
          </div>
          <div ref={wordmark} className="tl-wordmark" aria-hidden>
            <span className="tl-wordmark__name">GHOST</span>
          </div>
          <div className={cx('tl-menu', expanded && 'tl-menu--open')} role="menu" aria-hidden={!expanded}>
            {MENU.map((m, i) => {
              const Icon = m.icon
              const btn = (
                <ShearButton
                  ref={(el) => {
                    buttons.current[i] = el
                  }}
                  role="menuitem"
                  size="lg"
                  hue={m.hue}
                  icon={<Icon />}
                  label={m.label}
                  hint={m.soon ? 'Coming soon' : m.hint}
                  soft={m.soon}
                  tabIndex={expanded ? 0 : -1}
                  className={cx('tl-menu__btn', m.soon && 'tl-menu__btn--soon')}
                  sound={m.id === 'browse' ? 'confirm' : 'select'}
                  onPointerEnter={() => m.id === 'browse' && preloadScreen('browse')}
                  onClick={() => activate(m.id, i)}
                />
              )
              return (
                <div
                  key={m.id}
                  ref={(el) => {
                    slots.current[i] = el
                  }}
                  className="tl-menu__slot"
                >
                  {m.soon ? (
                    <Tooltip content="Radio is coming soon: endless, mood-matched game music." side="right">
                      {btn}
                    </Tooltip>
                  ) : (
                    btn
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div ref={footer} className="tl-footer">
        {current ? (
          <div className={cx('tl-np', playing && 'tl-np--playing')}>
            <span className="tl-np__eq" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="tl-np__label">
              {playing
                ? 'Now playing'
                : status === 'paused'
                  ? 'Paused'
                  : status === 'loading' || status === 'buffering'
                    ? (loadingLabel ?? 'Loading')
                    : status === 'error'
                      ? 'Couldn’t play'
                      : 'Last played'}
            </span>
            <span className="tl-np__title">{current.title}</span>
            {current.gameName && <span className="tl-np__game">{current.gameName}</span>}
          </div>
        ) : expanded ? (
          <div className="tl-hint">
            <Kbd combo="Enter" size="sm" /> Browse <span className="tl-hint__sep" /> <Kbd combo="Escape" size="sm" /> Back
          </div>
        ) : (
          <div className="tl-press">
            Press any key
            <CornerDownLeft className="tl-press__icon" />
          </div>
        )}
      </div>
    </div>
  )
}
