// Play: GHOST's player screen, the osu! player analogue.
//
//  · entry: a big title card (cover, title, game, album, composers, ★) zooms in, holds ~1.2 s
//    (longer while the track is still loading, up to ~3 s), then FLIPs its cover/title/game
//    into the compact bottom-left block; the same card returns on every track change
//  · the game's hero art behind, far less blurred/dimmed than Browse (restored on exit)
//  · GPU visualizer (radial / skyline / scope; V cycles) with osu!-style kiai time
//  · energy-graph seek bar, auto-hiding controls (2 s idle; the cursor hides too), queue drawer
//  · keys: Space · ←/→ ±5 s (Shift ±15 s) · ↑/↓ volume · L like · V visualizer · Q queue · M mute · Esc back
import { FastForward, Rewind } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ghost } from '../../ghost'
import { getVisualizerStage, radialGeometry, RADIAL_PULSE, VISUALIZER_LABELS, VISUALIZER_MODES, type VisualizerMode } from '../../gfx/visualizers'
import { trackArt } from '../../hooks'
import { useIdle } from '../../hooks/useIdle'
import { usePulse, useKiai } from '../../motion/hooks'
import { stagger, tween } from '../../motion/tween'
import { downloadCurrent, toggleLikeCurrent } from '../../overlays/now-playing/controls'
import { useCurrentTrack } from '../../overlays/now-playing/store'
import { volume } from '../../overlays/now-playing/volume'
import { useKeybinding } from '../../shell/keys'
import { goBack } from '../../shell/navigation'
import { useScreenTransitions } from '../../shell/ScreenStack'
import type { ScreenProps } from '../../shell/types'
import { sfx } from '../../sound'
import { livePositionMs, usePlayer } from '../../state/player'
import { updateSettings, useSettings } from '../../state/settings'
import { DEFAULT_ACCENT, useUI } from '../../state/ui'
import { CoverArt, formatTime } from '../../ui'
import { cx, uiZoom } from '../../ui/util'
import { EmptyState, ErrorNotice, FallbackBanner, Osd, PausePop, type OsdHandle } from './Feedback'
import { PlayHud, PlayTopBar, VIS_ICONS } from './PlayHud'
import { QueueDrawer } from './QueueDrawer'
import { TitleCard } from './TitleCard'
import './play.css'

/** Props: lifecycle ('entering' | 'active' | 'exiting'), direction, from, to. */
export type PlayScreenProps = ScreenProps

type Phase = 'card' | 'play'

const HOLD_MS = 1200
const MAX_HOLD_MS = 3000
const GLIDE_MS = 860
const IDLE_MS = 2000

/** Background treatment: Play shows the art far less blurred/dimmed than Browse. */
const BG_CARD = { dim: 0.58, blur: 0.5 }
const BG_PLAY = { dim: 0.3, blur: 0.12 }
const BG_KIAI = { dim: 0.2, blur: 0.08 }

const coverSizeFor = (w: number, h: number) => Math.round(Math.max(150, Math.min(300, h * 0.34, w < 780 ? h * 0.3 : Infinity)))

export default function PlayScreen(props: PlayScreenProps) {
  const current = useCurrentTrack()
  const status = usePlayer((s) => s.status)
  const error = usePlayer((s) => s.error)
  const duration = usePlayer((s) => s.durationMs)
  const queueLen = usePlayer((s) => s.queue.length)
  const queueIndex = usePlayer((s) => s.queueIndex)
  const contextTitle = usePlayer((s) => s.context?.title ?? null)
  const intensity = usePlayer((s) => s.currentAnalysis?.intensity ?? s.current?.analysis?.intensity ?? null)
  const bpm = usePlayer((s) => s.currentAnalysis?.bpm ?? s.current?.analysis?.bpm ?? null)
  const savedMode = useSettings((s) => s.interface.visualizer)
  const kiai = useKiai()

  const [mode, setModeState] = useState<VisualizerMode>(savedMode)
  const [phase, setPhase] = useState<Phase>('card')
  const [showKey, setShowKey] = useState(0)
  const [waiting, setWaiting] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [hudHover, setHudHover] = useState(false)
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const [banner, setBanner] = useState<string | null>(null)

  const root = useRef<HTMLDivElement>(null)
  const visHost = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const meta = useRef<HTMLDivElement | null>(null)
  const row = useRef<HTMLDivElement | null>(null)
  const seek = useRef<HTMLDivElement | null>(null)
  const top = useRef<HTMLDivElement>(null)
  const disc = useRef<HTMLDivElement>(null)
  const discPulse = useRef<HTMLDivElement>(null)
  const discGlow = useRef<HTMLDivElement>(null)
  const drawer = useRef<HTMLElement | null>(null)
  const osd = useRef<OsdHandle>(null)
  const empty = useRef<HTMLDivElement>(null)

  const lifecycle = useRef(props.lifecycle)
  lifecycle.current = props.lifecycle
  const exiting = useRef(false)
  const phaseRef = useRef<Phase>('card')
  /** Until the first glide finishes, the HUD stays hidden (entry choreography). */
  const firstShow = useRef(true)
  const cardAnimated = useRef(false)
  const enterFrom = useRef<string | null>(null)
  const holdTimer = useRef(0)
  const shownAt = useRef(0)
  const glideTimer = useRef(0)

  const stage = getVisualizerStage()
  const playing = status === 'playing'

  usePulse(discPulse, { amount: RADIAL_PULSE, enabled: phase === 'play' && mode === 'radial' })
  usePulse(discGlow, { mode: 'var', enabled: phase === 'play' && mode === 'radial' })

  // ------------------------------------------------------------------ background
  const prevBg = useRef<{ art: string | null; dim: number; blur: number } | null>(null)
  const restoreBg = useCallback(() => {
    const p = prevBg.current
    if (!p) return
    prevBg.current = null
    const ui = useUI.getState()
    ui.setBackground(p.art ?? ui.backgroundArt, { dim: p.dim, blur: p.blur })
  }, [])
  useLayoutEffect(() => {
    const u = useUI.getState()
    prevBg.current = { art: u.backgroundArt, dim: u.backgroundDim, blur: u.backgroundBlur }
    return restoreBg
  }, [restoreBg])

  const applyBg = useCallback(() => {
    if (exiting.current) return
    const ui = useUI.getState()
    const t = usePlayer.getState().current
    if (!t) return ui.setBackground(ui.backgroundArt, { dim: 0.62, blur: 1 })
    const look = phaseRef.current === 'card' ? BG_CARD : kiai ? BG_KIAI : BG_PLAY
    ui.setBackground(trackArt(t), look)
    // Browse leaves the accent on its selection; Play always wears the playing game's colour
    ui.setAccent(t.accent ?? DEFAULT_ACCENT)
  }, [kiai])
  useEffect(applyBg, [applyBg, current?.id, phase])
  // the previous screen may still be tidying up its own background while we enter
  useEffect(() => {
    if (props.lifecycle === 'active') applyBg()
  }, [props.lifecycle]) // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------ visualizer stage
  useEffect(() => {
    const host = visHost.current!
    stage.setMode(useSettings.getState().interface.visualizer, false)
    stage.setPresence(0, true)
    stage.attach(host)
    return () => stage.detach(host)
  }, [stage])
  useEffect(() => setModeState(savedMode), [savedMode])
  useEffect(() => stage.setMode(mode), [stage, mode])
  useEffect(() => {
    stage.setPresence(!current || status === 'error' ? 0 : phase === 'play' ? 1 : firstShow.current ? 0 : 0.14)
  }, [stage, phase, current, status])

  const setMode = (m: VisualizerMode, announce = true) => {
    setModeState(m)
    sfx.play('select', { volume: 0.6 })
    void updateSettings({ interface: { visualizer: m } })
    if (announce) osd.current?.show({ icon: VIS_ICONS[m], label: 'Visualizer', value: VISUALIZER_LABELS[m] })
  }
  const cycleMode = (dir: 1 | -1) => {
    const i = VISUALIZER_MODES.indexOf(mode)
    setMode(VISUALIZER_MODES[(i + dir + VISUALIZER_MODES.length) % VISUALIZER_MODES.length])
  }

  // ------------------------------------------------------------------ layout
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  const geo = radialGeometry(size.w, size.h)
  const coverSize = coverSizeFor(size.w, size.h)

  // the skyline stands on the HUD
  useEffect(() => {
    const hud = root.current?.querySelector<HTMLElement>('.pl-hud')
    if (!hud) return
    const apply = () => {
      stage.setBottomInset(hud.offsetHeight)
      root.current?.style.setProperty('--hud-h', `${hud.offsetHeight}px`)
    }
    const ro = new ResizeObserver(apply)
    ro.observe(hud)
    apply()
    return () => ro.disconnect()
  }, [stage, !!current]) // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------ HUD visibility helpers
  const hudParts = () => [top.current, row.current, seek.current].filter(Boolean) as HTMLElement[]
  const hideHudNow = () => {
    for (const [i, el] of hudParts().entries()) tween(el).clear().set({ opacity: 0, y: i === 0 ? -16 : 28 })
  }
  const revealHud = () => {
    stagger(hudParts(), (t) => t.fadeIn(320, 'outQuad').moveToY(0, 640, 'outQuint'), 70)
  }

  // ------------------------------------------------------------------ title card → meta FLIP
  const cardPieces = () => {
    const c = card.current
    if (!c) return null
    return {
      flips: Array.from(c.querySelectorAll<HTMLElement>('[data-flip]')),
      fades: Array.from(c.querySelectorAll<HTMLElement>('[data-fade]')),
      scrim: c.querySelector<HTMLElement>('[data-card-scrim]')
    }
  }

  const resetCard = () => {
    const p = cardPieces()
    if (!p) return
    for (const el of [...p.flips, ...p.fades]) tween(el).clear().set({ opacity: 1, x: 0, y: 0, scale: 1 })
    if (p.scrim) tween(p.scrim).clear().set({ opacity: 1 })
  }

  const finishGlide = () => {
    if (exiting.current) return
    phaseRef.current = 'play'
    setPhase('play')
    setWaiting(false)
    const m = meta.current
    if (m) {
      for (const el of m.querySelectorAll<HTMLElement>('[data-flip]')) tween(el).clear().set({ opacity: 1, x: 0, y: 0, scale: 1 })
      stagger(Array.from(m.querySelectorAll<HTMLElement>('[data-meta-fade]')), (t) => t.fadeIn(280, 'outQuad').moveToX(0, 520, 'outQuint'), 50)
    }
    if (firstShow.current) {
      firstShow.current = false
      revealHud()
    }
  }

  const glide = () => {
    window.clearTimeout(holdTimer.current)
    if (exiting.current) return
    const c = card.current
    const m = meta.current
    const p = cardPieces()
    if (!c || !m || !p) return finishGlide()
    setWaiting(false)
    const z = uiZoom()
    tween(m).clear().set({ opacity: 1, x: 0 })
    const targets = new Map<string, HTMLElement>()
    for (const el of m.querySelectorAll<HTMLElement>('[data-flip]')) {
      targets.set(el.dataset.flip!, el)
      tween(el).clear().set({ opacity: 0 })
    }
    for (const el of m.querySelectorAll<HTMLElement>('[data-meta-fade]')) tween(el).clear().set({ opacity: 0, x: -14 })

    stagger(p.fades, (t) => t.fadeOut(200, 'outQuad').moveToX(-28, 340, 'inQuad'), 26)
    if (p.scrim) tween(p.scrim).fadeOut(700, 'outQuad')
    const ease = 'inOutQuart'
    p.flips.forEach((el, i) => {
      const target = targets.get(el.dataset.flip!)
      if (!target) return void tween(el).fadeOut(200)
      const rc = el.getBoundingClientRect()
      const rm = target.getBoundingClientRect()
      const isCover = el.dataset.flip === 'cover'
      const s = isCover ? rm.width / Math.max(1, rc.width) : parseFloat(getComputedStyle(target).fontSize) / parseFloat(getComputedStyle(el).fontSize)
      const delay = i * 45
      tween(el)
        .delay(delay)
        .moveTo((rm.left - rc.left) / z, (rm.top - rc.top) / z, GLIDE_MS, ease)
        .scaleTo(s, GLIDE_MS, ease)
      if (isCover) {
        // lands exactly on its twin: swap on arrival
        tween(el).delay(delay + GLIDE_MS).fadeOut(0)
        tween(target).delay(delay + GLIDE_MS).fadeIn(0)
      } else {
        tween(el).delay(delay + GLIDE_MS * 0.42).fadeOut(GLIDE_MS * 0.42, 'outQuad')
        tween(target).delay(delay + GLIDE_MS * 0.5).fadeIn(GLIDE_MS * 0.45, 'outQuad')
      }
    })
    sfx.play('expand', { volume: 0.35 })
    window.clearTimeout(glideTimer.current)
    glideTimer.current = window.setTimeout(finishGlide, GLIDE_MS + 2 * 45 + 40)
  }

  const checkHold = () => {
    if (exiting.current) return
    const st = usePlayer.getState().status
    const elapsed = performance.now() - shownAt.current
    if ((st === 'loading' || st === 'buffering') && elapsed < MAX_HOLD_MS) {
      setWaiting(true)
      holdTimer.current = window.setTimeout(checkHold, 100)
      return
    }
    glide()
  }

  const animateCardIn = (from: string | null) => {
    const c = card.current
    const p = cardPieces()
    if (!c || !p) return
    cardAnimated.current = true
    tween(c)
      .clear()
      .set({ opacity: 0, scale: from === 'browse' ? 0.8 : 0.9 })
      .fadeIn(300, 'outQuad')
      .scaleTo(1, 900, 'outQuint')
    if (p.scrim) tween(p.scrim).clear().set({ opacity: 0 }).fadeIn(500, 'outQuad')
    const cover = p.flips.find((el) => el.dataset.flip === 'cover')
    if (cover) tween(cover).clear().set({ opacity: 0, x: -36, scale: 1 }).delay(60).fadeIn(320, 'outQuad').moveToX(0, 800, 'outQuint')
    const lines = [...p.flips.filter((el) => el !== cover), ...p.fades].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    stagger(lines, (t) => t.clear().set({ opacity: 0, x: 34, scale: 1 }).delay(120).fadeIn(300, 'outQuad').moveToX(0, 760, 'outQuint'), 38)
  }

  const showCard = () => {
    window.clearTimeout(holdTimer.current)
    window.clearTimeout(glideTimer.current)
    if (exiting.current) return
    const again = phaseRef.current === 'play' || !firstShow.current
    phaseRef.current = 'card'
    setPhase('card')
    setShowKey((k) => k + 1)
    shownAt.current = performance.now()
    resetCard()
    if (again) {
      const m = meta.current
      if (m) tween(m).clear().fadeOut(200, 'outQuad').moveToX(-26, 320, 'inQuad')
      animateCardIn(null)
    } else if (!cardAnimated.current) animateCardIn(enterFrom.current)
    holdTimer.current = window.setTimeout(checkHold, HOLD_MS)
  }

  // the HUD starts hidden; it arrives after the first glide
  const setRow = useCallback((el: HTMLDivElement | null) => {
    row.current = el
    if (el && firstShow.current) tween(el).set({ opacity: 0, y: 28 })
  }, [])
  const setSeek = useCallback((el: HTMLDivElement | null) => {
    seek.current = el
    if (el && firstShow.current) tween(el).set({ opacity: 0, y: 28 })
  }, [])
  const setMeta = useCallback((el: HTMLDivElement | null) => {
    meta.current = el
    if (el && phaseRef.current === 'card') tween(el).set({ opacity: 0 })
  }, [])
  useLayoutEffect(() => {
    if (top.current && current) tween(top.current).set({ opacity: 0, y: -16 })
    if (disc.current) tween(disc.current).set({ opacity: 0, scale: 0.7 })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const trackId = current?.id ?? null
  useEffect(() => {
    if (!trackId) {
      // nothing (left) playing: drop back to a clean state
      window.clearTimeout(holdTimer.current)
      phaseRef.current = 'card'
      setPhase('card')
      if (top.current) tween(top.current).fadeIn(300).moveToY(0, 500)
      return
    }
    showCard()
    return () => window.clearTimeout(holdTimer.current)
  }, [trackId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      window.clearTimeout(holdTimer.current)
      window.clearTimeout(glideTimer.current)
    },
    []
  )

  // ------------------------------------------------------------------ disc (radial mode)
  const discShown = phase === 'play' && mode === 'radial' && !!current && status !== 'error'
  useEffect(() => {
    const d = disc.current
    if (!d) return
    if (discShown) tween(d).clear().delay(80).fadeIn(260, 'outQuad').scaleTo(1, 760, 'outBack')
    else tween(d).clear().fadeOut(200, 'outQuad').scaleTo(0.72, 420, 'outQuint')
  }, [discShown])

  // ------------------------------------------------------------------ fallback notices
  useEffect(() => {
    if (error && status !== 'error') setBanner(error)
    if (!error) setBanner(null)
  }, [error, status])

  // ------------------------------------------------------------------ idle (controls + cursor)
  const idle = useIdle(IDLE_MS, props.lifecycle !== 'exiting' && phase === 'play' && playing && !queueOpen && !hudHover)

  // ------------------------------------------------------------------ keys
  const seekBy = (delta: number) => {
    const s = usePlayer.getState()
    if (!s.current || !s.durationMs) return
    const to = Math.max(0, Math.min(s.durationMs - 250, livePositionMs(s) + delta))
    void ghost().player.seek(to)
    osd.current?.show({ icon: delta < 0 ? <Rewind /> : <FastForward />, label: `${delta < 0 ? '−' : '+'}${Math.abs(delta / 1000)} s`, value: formatTime(to) })
  }
  const toggleQueue = () => {
    sfx.play(queueOpen ? 'collapse' : 'expand')
    setQueueOpen((o) => !o)
  }
  const hasTrack = !!current
  useKeybinding('ArrowLeft', () => seekBy(-5000), { enabled: hasTrack })
  useKeybinding('ArrowRight', () => seekBy(5000), { enabled: hasTrack })
  useKeybinding('Shift+ArrowLeft', () => seekBy(-15000), { enabled: hasTrack })
  useKeybinding('Shift+ArrowRight', () => seekBy(15000), { enabled: hasTrack })
  useKeybinding('ArrowUp', () => volume.nudge(0.05))
  useKeybinding('ArrowDown', () => volume.nudge(-0.05))
  useKeybinding('Shift+ArrowUp', () => volume.nudge(0.01))
  useKeybinding('Shift+ArrowDown', () => volume.nudge(-0.01))
  useKeybinding('L', () => toggleLikeCurrent(), { repeat: false, enabled: hasTrack })
  useKeybinding('V', () => cycleMode(1), { repeat: false })
  useKeybinding('Shift+V', () => cycleMode(-1), { repeat: false })
  useKeybinding('Q', toggleQueue, { repeat: false })
  useKeybinding('M', () => volume.toggleMute(), { repeat: false })
  useKeybinding('Mod+D', () => downloadCurrent(usePlayer.getState().current), { repeat: false, enabled: hasTrack })
  useKeybinding('Escape', () => {
    if (queueOpen) {
      sfx.play('back', { volume: 0.6 })
      setQueueOpen(false)
      return
    }
    goBack()
  })

  // ------------------------------------------------------------------ screen choreography
  useScreenTransitions({
    enter: ({ other }) => {
      enterFrom.current = other
      if (!usePlayer.getState().current) {
        const e = empty.current
        if (top.current) tween(top.current).set({ opacity: 0, y: -16 }).delay(200).fadeIn(300).moveToY(0, 600, 'outQuint')
        return e ? tween(e).set({ opacity: 0, scale: 0.92 }).fadeIn(320, 'outQuad').scaleTo(1, 800, 'outQuint').finished : undefined
      }
      hideHudNow()
      animateCardIn(other)
      return new Promise<void>((r) => window.setTimeout(r, 900))
    },
    exit: ({ el }) => {
      exiting.current = true
      window.clearTimeout(holdTimer.current)
      window.clearTimeout(glideTimer.current)
      restoreBg()
      stage.setPresence(0)
      setQueueOpen(false)
      const parts = hudParts()
      stagger(parts, (t, i) => t.clear().fadeOut(220, 'outQuad').moveToY(i === 0 ? -24 : 44, 440, 'inQuint'), 45)
      if (meta.current) tween(meta.current).clear().fadeOut(240, 'outQuad').moveToX(-60, 440, 'inQuint')
      if (disc.current) tween(disc.current).clear().fadeOut(260, 'outQuad').scaleTo(0.8, 440, 'inQuint')
      if (card.current && phaseRef.current === 'card') tween(card.current).clear().fadeOut(260, 'outQuad').scaleTo(1.08, 460, 'inQuint')
      if (empty.current) tween(empty.current).fadeOut(240).scaleTo(0.94, 400, 'inQuint')
      if (drawer.current) tween(drawer.current).clear().moveToX(480, 420, 'inQuint')
      return tween(el).delay(240).fadeOut(240, 'outQuad').finished
    }
  })

  const position = { index: Math.max(0, queueIndex), total: queueLen, context: contextTitle }

  return (
    <div
      ref={root}
      className={cx('pl-root', idle && 'pl-root--idle', kiai && 'pl-root--kiai', queueOpen && 'pl-root--queue', !current && 'pl-root--empty')}
      data-phase={phase}
      data-mode={mode}
      style={{ '--disc-x': `${geo.cx}px`, '--disc-y': `${geo.cy}px`, '--disc-r': `${geo.radius}px` } as CSSProperties}
    >
      <div ref={visHost} className="pl-vis" onPointerDown={() => queueOpen && setQueueOpen(false)} />
      <div className="pl-scrim" aria-hidden />

      {current && (
        <div ref={disc} className="pl-disc" aria-hidden={!discShown}>
          <div ref={discPulse} className="pl-disc__pulse">
            <div ref={discGlow} className="pl-disc__glow" />
            <button
              type="button"
              className="pl-disc__cover"
              tabIndex={-1}
              aria-label={playing ? 'Pause' : 'Play'}
              onClick={() => {
                sfx.play(playing ? 'toggleOff' : 'toggleOn', { volume: 0.6 })
                void ghost().player.toggle()
              }}
            >
              <CoverArt src={current.cover} size={geo.radius * 2} radius={geo.radius} hue={current.accent} ring={false} />
            </button>
          </div>
        </div>
      )}

      {current ? (
        <TitleCard
          ref={card}
          track={current}
          status={status}
          intensity={intensity}
          bpm={bpm}
          durationMs={duration}
          position={position}
          coverSize={coverSize}
          waiting={waiting}
          showKey={showKey}
        />
      ) : (
        <EmptyState ref={empty} />
      )}

      <PlayTopBar ref={top} mode={mode} onMode={(m) => setMode(m, false)} />

      {current && (
        <PlayHud
          track={current}
          intensity={intensity}
          bpm={bpm}
          queueOpen={queueOpen}
          onToggleQueue={toggleQueue}
          active={props.lifecycle !== 'exiting'}
          onHoverChange={setHudHover}
          metaRef={setMeta}
          rowRef={setRow}
          seekRef={setSeek}
        />
      )}

      {current && status === 'error' && phase === 'play' && <ErrorNotice message={error} />}
      {banner && <FallbackBanner message={banner} onDismiss={() => setBanner(null)} />}
      <PausePop enabled={!!current && phase === 'play'} />
      <Osd ref={osd} />
      <QueueDrawer
        open={queueOpen}
        onClose={() => setQueueOpen(false)}
        drawerRef={(el) => {
          drawer.current = el
        }}
      />
    </div>
  )
}
