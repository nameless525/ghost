// Now playing: GHOST's music controller (the osu! Now Playing overlay analogue). Drops from the
// toolbar chip on any screen: the game's art with cover + marquee title over it, a live seek bar
// along the art's bottom edge, transport, shuffle/repeat/loop toggles, like/playlist/download,
// volume, and a drawer that slides out with the queue (Up next · History · All, searchable).
// While open, the keys its tooltips show act on the playing track: Q queue, L like, M mute,
// Mod+S add to playlist, Mod+D download (over Browse they'd otherwise act on its selection).
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
import { BackupBadge, Button, CoverArt, GhostMark, IconButton, Marquee, ProgressBar, Slider, SourceBadge, formatTime } from '../../ui'
import { cx } from '../../ui/util'
import {
  AddToPlaylistButton,
  DownloadButton,
  downloadCurrent,
  Intensity,
  LikeButton,
  LiveTime,
  LoopModeButton,
  NextButton,
  openPlaylistMenu,
  PlayPauseButton,
  PrevButton,
  RepeatButton,
  ShuffleButton,
  toggleLikeCurrent,
  VolumeControl
} from './controls'
import { QueueList } from './QueueList'
import { useCurrentTrack } from './store'
import { volume } from './volume'
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
  const loading = usePlayer((s) => s.loading ?? null)
  const duration = usePlayer((s) => s.durationMs)
  const context = usePlayer((s) => s.context)
  const upNext = usePlayer((s) => Math.max(0, s.queue.length - s.queueIndex - 1))
  const bpm = usePlayer((s) => s.currentAnalysis?.bpm ?? s.current?.analysis?.bpm ?? null)
  const intensity = usePlayer((s) => s.currentAnalysis?.intensity ?? s.current?.analysis?.intensity ?? null)
  const onPlay = useUI((s) => s.screen === 'play')
  const [drawer, setDrawer] = useState(false)
  const glow = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const playing = status === 'playing'

  usePulse(glow, { mode: 'var', enabled: open && playing })

  const toggleDrawer = () => {
    sfx.play(drawer ? 'collapse' : 'expand')
    setDrawer((d) => !d)
  }
  const live = open && !!current
  useKeybinding('Q', toggleDrawer, { repeat: false, enabled: live })
  useKeybinding('L', () => toggleLikeCurrent(), { repeat: false, enabled: live })
  useKeybinding('M', () => volume.toggleMute(), { repeat: false, enabled: live })
  useKeybinding('Mod+S', () => openPlaylistMenu(usePlayer.getState().current, root.current?.querySelector('.np-actions .np-add-playlist')), { repeat: false, enabled: live })
  useKeybinding('Mod+D', () => downloadCurrent(usePlayer.getState().current), { repeat: false, enabled: live })

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
  // "Game · Game: The Original Soundtrack" says it twice: the album alone when it names the game
  const game = current.gameName
  const album = current.albumTitle
  const sub = game && album && !album.toLowerCase().includes(game.toLowerCase()) ? `${game} · ${album}` : album || game || ''
  // the context is news only when it isn't the album already on the line below
  const ctx = context && context.title.trim().toLowerCase() !== album.trim().toLowerCase() ? context.title : null

  return (
    <div ref={root} className="np-root">
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
              {ctx && <span className="np-hero__ctx g-ellipsis">{ctx}</span>}
            </div>
            <Marquee className="np-hero__title" speed={34} paused={!open || !playing} pauseOnHover>
              {current.title}
            </Marquee>
            <Marquee className="np-hero__sub" speed={28} paused={!open || !playing} pauseOnHover>
              {sub}
            </Marquee>
            <div className="np-hero__chips">
              <Intensity value={intensity} size="sm" />
              {bpm ? <span className="np-chip tnum">{Math.round(bpm)} BPM</span> : null}
              {current.source && <SourceBadge source={current.source} />}
              <BackupBadge source={current.source} />
            </div>
          </div>
          {/* on the Play screen already it only closed the panel */}
          {!onPlay && (
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
          )}
        </div>
        <div className="np-seek">
          {loading && <ProgressBar className="np-load" size="thin" caption progress={loading} waitKey={loading.wait} />}
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
            <QueueList active={open && drawer} compact fit={{ min: 280, max: Math.max(300, Math.min(500, window.innerHeight - 420)) }} />
          </div>
        </div>
      </div>
    </div>
  )
}
