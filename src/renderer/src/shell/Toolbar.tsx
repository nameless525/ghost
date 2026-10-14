// The osu!-like top bar. Left: GHOST mark (home), Browse, Library. Right: downloads ring,
// notifications, a mini now-playing chip, clock, settings. Translucent with blur; the whole
// bar is a window drag region (controls are no-drag). Leaves room for the macOS traffic
// lights (left) and the Windows titleBarOverlay controls (right, via env(titlebar-area-*)).
// On the Play screen it hides itself until the pointer nears the top edge.
import { Bell, Compass, Download, LibraryBig, Music2, Pause, Play, Settings } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DownloadItem } from '@shared/types'
import { ghost } from '../ghost'
import { Spring } from '../motion/spring'
import { useTicker } from '../motion/ticker'
import { livePositionMs, usePlayer } from '../state/player'
import { useUI, type OverlayId } from '../state/ui'
import { sfx } from '../sound'
import { CoverArt } from '../ui/CoverArt'
import { GhostMark } from '../ui/GhostMark'
import { Marquee } from '../ui/Marquee'
import { ProgressRing } from '../ui/ProgressRing'
import { Tooltip } from '../ui/Tooltip'
import { cx } from '../ui/util'
import { navigate } from './navigation'
import { useNotifications } from './notifications'
import { preloadScreen } from './ScreenStack'

interface ToolbarButtonProps {
  icon: ReactNode
  label?: string
  tooltip: string
  shortcut?: string
  active?: boolean
  onClick: () => void
  overlay?: OverlayId
  className?: string
  children?: ReactNode
  onPointerEnter?: () => void
}

function ToolbarButton({ icon, label, tooltip, shortcut, active, onClick, overlay, className, children, onPointerEnter }: ToolbarButtonProps) {
  return (
    <Tooltip content={tooltip} shortcut={shortcut}>
      <button
        type="button"
        className={cx('g-tb-btn', active && 'g-tb-btn--active', label && 'g-tb-btn--labelled', className)}
        aria-label={tooltip}
        aria-pressed={active}
        data-overlay-toggle={overlay}
        onPointerEnter={() => {
          sfx.play('hover')
          onPointerEnter?.()
        }}
        onClick={onClick}
      >
        <span className="g-tb-btn__icon">{icon}</span>
        {label && <span className="g-tb-btn__label">{label}</span>}
        {children}
        <span className="g-tb-btn__bar" />
      </button>
    </Tooltip>
  )
}

const ACTIVE: DownloadItem['status'][] = ['queued', 'resolving', 'downloading', 'tagging']

function DownloadsButton() {
  const open = useUI((s) => s.overlays.downloads)
  const [items, setItems] = useState<DownloadItem[]>([])
  useEffect(() => {
    let alive = true
    void ghost()
      .downloads.list()
      .then((l) => alive && setItems(l))
      .catch(() => {})
    const off = ghost().on('downloads:changed', setItems)
    return () => {
      alive = false
      off()
    }
  }, [])
  const active = items.filter((d) => ACTIVE.includes(d.status))
  const progress = active.length ? active.reduce((s, d) => s + d.progress, 0) / active.length : 0
  return (
    <ToolbarButton
      icon={
        active.length ? (
          <ProgressRing value={active.some((d) => d.status === 'downloading') ? progress : null} size={24} thickness={2.2} hue="downloads">
            <Download style={{ width: 12, height: 12, color: 'var(--fg-1)' }} />
          </ProgressRing>
        ) : (
          <Download />
        )
      }
      tooltip={active.length ? `Downloads · ${active.length} active · ${Math.round(progress * 100)}%` : 'Downloads'}
      active={open}
      overlay="downloads"
      className="g-tb-btn--downloads"
      onClick={() => useUI.getState().toggleOverlay('downloads')}
    >
      {active.length > 0 && <span className="g-tb-badge g-tb-badge--downloads">{active.length}</span>}
    </ToolbarButton>
  )
}

function NotificationsButton() {
  const open = useUI((s) => s.overlays.notifications)
  const unread = useNotifications((s) => s.unread)
  return (
    <ToolbarButton
      icon={<Bell />}
      tooltip={unread ? `${unread} new notification${unread === 1 ? '' : 's'}` : 'Notifications'}
      active={open}
      overlay="notifications"
      className={cx(unread > 0 && 'g-tb-btn--ring')}
      onClick={() => useUI.getState().toggleOverlay('notifications')}
    >
      {unread > 0 && <span className="g-tb-badge">{unread > 9 ? '9+' : unread}</span>}
    </ToolbarButton>
  )
}

function NowPlayingChip() {
  const current = usePlayer((s) => s.current)
  const status = usePlayer((s) => s.status)
  const open = useUI((s) => s.overlays.nowPlaying)
  const bar = useRef<HTMLDivElement>(null)
  const playing = status === 'playing'
  const busy = status === 'loading' || status === 'buffering'

  useTicker(
    () => {
      const el = bar.current
      if (!el) return
      const s = usePlayer.getState()
      const f = s.durationMs ? Math.min(1, livePositionMs(s) / s.durationMs) : 0
      const v = f.toFixed(4)
      if (el.dataset.v !== v) {
        el.dataset.v = v
        el.style.transform = `scaleX(${v})`
      }
    },
    !!current
  )

  return (
    <div className={cx('g-np-chip', open && 'g-np-chip--open', !current && 'g-np-chip--empty')} data-overlay-toggle="nowPlaying">
      <Tooltip content={current ? 'Now playing' : 'Nothing playing'} shortcut="F6">
        <button
          type="button"
          className="g-np-chip__main"
          aria-label="Toggle now playing"
          aria-expanded={open}
          onPointerEnter={() => sfx.play('hover')}
          onClick={() => useUI.getState().toggleOverlay('nowPlaying')}
        >
          {current ? (
            <CoverArt src={current.cover} size={28} radius={6} hue={current.accent} />
          ) : (
            <span className="g-np-chip__idle">
              <Music2 />
            </span>
          )}
          <span className="g-np-chip__text">
            {current ? (
              <>
                <Marquee className="g-np-chip__title" speed={30} paused={!playing}>
                  {current.title}
                </Marquee>
                <span className="g-np-chip__sub g-ellipsis">{current.gameName ?? current.albumTitle}</span>
              </>
            ) : (
              <span className="g-np-chip__sub">Nothing playing</span>
            )}
          </span>
        </button>
      </Tooltip>
      {current && (
        <Tooltip content={playing ? 'Pause' : 'Play'} shortcut="Space">
          <button
            type="button"
            className={cx('g-np-chip__play', busy && 'g-np-chip__play--busy')}
            aria-label={playing ? 'Pause' : 'Play'}
            onPointerEnter={() => sfx.play('hover')}
            onClick={() => {
              sfx.play('select', { volume: 0.7 })
              void ghost().player.toggle()
            }}
          >
            {playing ? <Pause /> : <Play />}
          </button>
        </Tooltip>
      )}
      {current && (
        <div className="g-np-chip__progress">
          <div ref={bar} className="g-np-chip__progress-fill" />
        </div>
      )}
    </div>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let t = 0
    const tick = () => {
      setNow(new Date())
      t = window.setTimeout(tick, 60000 - (Date.now() % 60000) + 20)
    }
    t = window.setTimeout(tick, 60000 - (Date.now() % 60000) + 20)
    return () => window.clearTimeout(t)
  }, [])
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  return (
    <Tooltip content={date}>
      <span className="g-tb-clock tnum" tabIndex={-1}>
        {time}
      </span>
    </Tooltip>
  )
}

export function Toolbar() {
  const screen = useUI((s) => s.screen)
  const overlays = useUI((s) => s.overlays)
  const root = useRef<HTMLElement>(null)
  const anyOverlay = Object.values(overlays).some(Boolean)
  const autoHide = screen === 'play' && !anyOverlay
  const reveal = useRef(false)
  /** Mirrors `reveal` for rendering: while hidden the bar must not be a window drag region,
   *  or Electron would swallow the pointer moves near the top edge that reveal it. */
  const [revealed, setRevealed] = useState(false)
  const spring = useMemo(() => new Spring({ value: 0, frequency: 2.6, damping: 0.95 }), [])

  // auto-hide on Play: reveal when the pointer nears the top, or while focus is inside
  useEffect(() => {
    const el = root.current
    if (!el) return
    const off = spring.drive((v) => {
      el.style.transform = v ? `translate3d(0, ${v.toFixed(2)}px, 0)` : ''
      el.style.opacity = v ? String(Math.max(0, 1 + v / 54).toFixed(3)) : ''
    })
    return off
  }, [spring])

  useEffect(() => {
    const update = () => spring.to(autoHide && !reveal.current && !root.current?.matches(':focus-within') ? -54 : 0)
    update()
    if (!autoHide) return
    const onMove = (e: PointerEvent) => {
      const near = e.clientY < (reveal.current ? 76 : 30)
      if (near !== reveal.current) {
        reveal.current = near
        setRevealed(near)
        update()
      }
    }
    const onLeave = () => {
      reveal.current = false
      setRevealed(false)
      update()
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    root.current?.addEventListener('focusin', update)
    root.current?.addEventListener('focusout', update)
    const r = root.current
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      r?.removeEventListener('focusin', update)
      r?.removeEventListener('focusout', update)
      reveal.current = false
      setRevealed(false)
    }
  }, [autoHide, spring])

  return (
    <header ref={root} className={cx('g-toolbar', (!autoHide || revealed) && 'g-drag', autoHide && 'g-toolbar--autohide')}>
      <div className="g-toolbar__bg" />
      <nav className="g-toolbar__left">
        <ToolbarButton icon={<GhostMark size={22} />} tooltip="Home" active={screen === 'title'} className="g-tb-btn--home" onClick={() => navigate('title')} />
        <ToolbarButton icon={<Compass />} label="Browse" tooltip="Browse soundtracks" active={screen === 'browse'} onPointerEnter={() => preloadScreen('browse')} onClick={() => navigate('browse')} />
        <ToolbarButton
          icon={<LibraryBig />}
          label="Library"
          tooltip="Library"
          shortcut="Mod+L"
          active={overlays.library}
          overlay="library"
          className="g-tb-btn--library"
          onClick={() => useUI.getState().toggleOverlay('library')}
        />
      </nav>
      <div className="g-toolbar__spacer" />
      <div className="g-toolbar__right">
        <DownloadsButton />
        <NotificationsButton />
        <NowPlayingChip />
        <Clock />
        <ToolbarButton
          icon={<Settings />}
          tooltip="Settings"
          shortcut="Mod+O"
          active={overlays.settings}
          overlay="settings"
          className="g-tb-btn--settings"
          onClick={() => useUI.getState().toggleOverlay('settings')}
        />
      </div>
    </header>
  )
}
