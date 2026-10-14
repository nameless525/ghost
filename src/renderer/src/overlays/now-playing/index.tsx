// Now playing: GHOST's music controller (the osu! Now Playing overlay analogue). Drops from the
// toolbar chip on any screen: the game's art with cover + marquee title over it, a live seek bar
// along the art's bottom edge, transport, shuffle/repeat/loop toggles, like/playlist/download,
// volume, and a drawer that slides out with the queue (Up next · History · All).
import { Compass, LibraryBig, ListMusic, Maximize2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { ghost } from '../../ghost'
import { artUrl } from '../../lib/art'
import { usePulse } from '../../motion/hooks'
import { navigate } from '../../shell/navigation'
import { useKeybinding } from '../../shell/keys'
import type { OverlayProps } from '../../shell/types'
import { sfx } from '../../sound'
import { livePositionMs, usePlayer } from '../../state/player'
import { useUI } from '../../state/ui'
import { Button, CoverArt, GhostMark, IconButton, IntensityBadge, Marquee, Slider, SourceBadge, formatTime } from '../../ui'
import { cx } from '../../ui/util'
import {
  AddToPlaylistButton,
  DownloadButton,
  LikeButton,
  LiveTime,
  LoopModeButton,
  NextButton,
  PlayPauseButton,
  PrevButton,
  RepeatButton,
  ShuffleButton,
  VolumeControl
} from './controls'
import { QueueList } from './QueueList'
import { useCurrentTrack } from './store'
import './now-playing.css'

/** Props: open, phase ('entering' | 'open' | 'exiting' | 'closed'), close(), hue. */
export type NowPlayingOverlayProps = OverlayProps


const STATUS_LABEL: Record<string, string> = {
  playing: 'Now playing',
  paused: 'Paused',
  loading: 'Loading',
  buffering: 'Buffering',
  error: 'Couldn’t play',
  idle: 'Stopped'
}

export default function NowPlayingOverlay({ open, close }: NowPlayingOverlayProps) {
  const current = useCurrentTrack()
  const status = usePlayer((s) => s.status)
  const duration = usePlayer((s) => s.durationMs)
  const context = usePlayer((s) => s.context)
  const upNext = usePlayer((s) => Math.max(0, s.queue.length - s.queueIndex - 1))
  const bpm = usePlayer((s) => s.currentAnalysis?.bpm ?? s.current?.analysis?.bpm ?? null)
  const intensity = usePlayer((s) => s.currentAnalysis?.intensity ?? s.current?.analysis?.intensity ?? null)
  const [drawer, setDrawer] = useState(false)
  const glow = useRef<HTMLDivElement>(null)
  const playing = status === 'playing'

  usePulse(glow, { mode: 'var', enabled: open && playing })

  const toggleDrawer = () => {
    sfx.play(drawer ? 'collapse' : 'expand')
    setDrawer((d) => !d)
  }
  useKeybinding('Q', toggleDrawer, { repeat: false, enabled: open && !!current })

  if (!current) {
    return (
      <div className="np-root np-root--empty">
        <div className="np-empty">
          <div className="np-empty__mark">
            <GhostMark size={44} />
          </div>
          <div className="np-empty__title">Nothing playing</div>
          <div className="np-empty__body">Pick a soundtrack in Browse, or play something from your Library.</div>
          <div className="np-empty__actions">
            <Button
              variant="primary"
              icon={<Compass size={16} />}
              sound="confirm"
              onClick={() => {
                close()
                navigate('browse')
              }}
            >
              Browse
            </Button>
            <Button variant="soft" icon={<LibraryBig size={16} />} onClick={() => useUI.getState().toggleOverlay('library', true)}>
              Library
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const art = artUrl(current.hero ?? current.cover, { w: 460 })
  const sub = [current.gameName, current.albumTitle].filter(Boolean).join(' · ')

  return (
    <div className="np-root">
      <section className="np-hero">
        <div className="np-hero__art" aria-hidden>
          {art && <img key={art} src={art} alt="" decoding="async" draggable={false} />}
        </div>
        <div className="np-hero__shade" aria-hidden />
        <div className="np-hero__body">
          <div ref={glow} className="np-hero__cover">
            <CoverArt src={current.cover} size={92} radius={12} hue={current.accent} />
          </div>
          <div className="np-hero__text">
            <div className="np-hero__eyebrow g-caps">
              <span className={cx('np-hero__status', playing && 'np-hero__status--live')}>{STATUS_LABEL[status] ?? 'Now playing'}</span>
              {context && <span className="np-hero__ctx g-ellipsis">{context.title}</span>}
            </div>
            <Marquee className="np-hero__title" speed={34} paused={!open || !playing} pauseOnHover>
              {current.title}
            </Marquee>
            <Marquee className="np-hero__sub" speed={28} paused={!open || !playing} pauseOnHover>
              {sub}
            </Marquee>
            <div className="np-hero__chips">
              <IntensityBadge value={intensity} size="sm" />
              {bpm ? <span className="np-chip tnum">{Math.round(bpm)} BPM</span> : null}
              {current.source && <SourceBadge source={current.source} />}
            </div>
          </div>
          <IconButton
            className="np-hero__open"
            size="sm"
            variant="subtle"
            label="Open the player"
            icon={<Maximize2 />}
            sound="confirm"
            onClick={() => {
              close()
              navigate('play')
            }}
          />
        </div>
        <div className="np-seek">
          <Slider
            variant="seek"
            min={0}
            max={duration ?? 1}
            disabled={!duration}
            live={() => livePositionMs()}
            liveActive={open}
            onCommit={(ms) => void ghost().player.seek(ms)}
            format={formatTime}
            wheelStep={0.02}
            aria-label="Seek"
          />
          <div className="np-seek__times">
            <LiveTime kind="elapsed" active={open} />
            <LiveTime kind="remaining" active={open} />
          </div>
        </div>
      </section>

      <section className="np-transport">
        <ShuffleButton />
        <PrevButton />
        <PlayPauseButton size="xl" />
        <NextButton />
        <RepeatButton />
      </section>

      <section className="np-actions">
        <LoopModeButton size="sm" />
        <LikeButton track={current} size="sm" />
        <AddToPlaylistButton track={current} size="sm" />
        <DownloadButton track={current} size="sm" />
        <div className="np-actions__spacer" />
        <VolumeControl width={96} size="sm" />
        <IconButton size="sm" label={drawer ? 'Hide queue' : 'Show queue'} shortcut="Q" active={drawer} sound={false} icon={<ListMusic />} className="np-queue-toggle" onClick={toggleDrawer}>
          {upNext > 0 && <span className="np-queue-toggle__count tnum">{upNext > 99 ? '99+' : upNext}</span>}
        </IconButton>
      </section>

      <div className={cx('np-drawer', drawer && 'np-drawer--open')} aria-hidden={!drawer}>
        <div className="np-drawer__clip">
          <div className="np-drawer__inner" inert={!drawer || undefined}>
            <QueueList active={open && drawer} compact fit={{ min: 230, max: Math.max(260, Math.min(460, window.innerHeight - 420)) }} />
          </div>
        </div>
      </div>
    </div>
  )
}
