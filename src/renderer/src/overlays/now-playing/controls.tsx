// Transport + track controls shared by the Play screen HUD and the now-playing overlay.
// All built on the kit's IconButton/Slider; per-frame bits (live time) write the DOM directly.
import {
  Disc3,
  Download,
  Heart,
  Infinity as InfinityIcon,
  IterationCw,
  ListPlus,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Check
} from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { LoopMode, RepeatMode, ShuffleMode, TrackView } from '@shared/types'
import { ghost } from '../../ghost'
import { playlistSubmenu, trackActions } from '../../lib/track-actions'
import { useTicker } from '../../motion/ticker'
import { tween } from '../../motion/tween'
import { notify } from '../../shell/notifications'
import { sfx } from '../../sound'
import { livePositionMs, usePlayer } from '../../state/player'
import { IntensityBadge, type IntensityBadgeProps } from '../../ui/Badges'
import { IconButton, type IconButtonProps } from '../../ui/IconButton'
import { openContextMenu } from '../../ui/ContextMenu'
import { Tooltip } from '../../ui/Tooltip'
import { Slider } from '../../ui/Slider'
import { formatTime } from '../../ui/format'
import { cx } from '../../ui/util'
import { volumeIcon } from './VolumeMeter'
import { volume } from './volume'
import './controls.css'

type Size = IconButtonProps['size']

// ---------------------------------------------------------------------------
// transport

export function PlayPauseButton({ size = 'xl', className }: { size?: Size; className?: string }) {
  const status = usePlayer((s) => s.status)
  const hasTrack = usePlayer((s) => !!s.current)
  const playing = status === 'playing'
  const busy = status === 'loading' || status === 'buffering'
  return (
    <IconButton
      className={cx('np-play', playing && 'np-play--playing', busy && 'np-play--busy', className)}
      variant="solid"
      round
      size={size}
      label={playing ? 'Pause' : 'Play'}
      shortcut="Space"
      disabled={!hasTrack}
      sound={false}
      onClick={() => {
        sfx.play(playing ? 'toggleOff' : 'toggleOn', { volume: 0.7 })
        void ghost().player.toggle()
      }}
      icon={
        <span className="np-play__icons" aria-hidden>
          <Play className="np-play__icon np-play__icon--play" />
          <Pause className="np-play__icon np-play__icon--pause" />
        </span>
      }
    >
      <span className="np-play__busy" aria-hidden />
    </IconButton>
  )
}

export function PrevButton({ size = 'lg' }: { size?: Size }) {
  const can = usePlayer((s) => !!s.current)
  return <IconButton size={size} round label="Previous" shortcut="Mod+ArrowLeft" disabled={!can} icon={<SkipBack />} onClick={() => void ghost().player.prev()} />
}

export function NextButton({ size = 'lg' }: { size?: Size }) {
  const can = usePlayer((s) => s.queueIndex >= 0 && (s.queueIndex < s.queue.length - 1 || s.repeat === 'all'))
  return <IconButton size={size} round label="Next" shortcut="Mod+ArrowRight" disabled={!can} icon={<SkipForward />} onClick={() => void ghost().player.next()} />
}

// ---------------------------------------------------------------------------
// modes

const SHUFFLE_NEXT: Record<ShuffleMode, ShuffleMode> = { off: 'on', on: 'smart', smart: 'off' }
const SHUFFLE_LABEL: Record<ShuffleMode, string> = { off: 'Shuffle: off', on: 'Shuffle: on', smart: 'Shuffle: smart (spreads games apart, favours likes)' }

export function ShuffleButton({ size }: { size?: Size }) {
  const mode = usePlayer((s) => s.shuffle)
  return (
    <IconButton
      size={size}
      label={SHUFFLE_LABEL[mode]}
      active={mode !== 'off'}
      sound={false}
      className="np-mode"
      icon={<Shuffle />}
      onClick={() => {
        const next = SHUFFLE_NEXT[mode]
        sfx.play(next === 'off' ? 'toggleOff' : 'toggleOn')
        void ghost().player.setShuffle(next)
      }}
    >
      {mode === 'smart' && <span className="np-mode__tag">S</span>}
      {mode !== 'off' && <span className="np-mode__dot" />}
    </IconButton>
  )
}

const REPEAT_NEXT: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' }
const REPEAT_LABEL: Record<RepeatMode, string> = { off: 'Repeat: off', all: 'Repeat: queue', one: 'Repeat: this track' }

export function RepeatButton({ size }: { size?: Size }) {
  const mode = usePlayer((s) => s.repeat)
  return (
    <IconButton
      size={size}
      label={REPEAT_LABEL[mode]}
      active={mode !== 'off'}
      sound={false}
      className="np-mode"
      icon={mode === 'one' ? <Repeat1 /> : <Repeat />}
      onClick={() => {
        const next = REPEAT_NEXT[mode]
        sfx.play(next === 'off' ? 'toggleOff' : 'toggleOn')
        void ghost().player.setRepeat(next)
      }}
    >
      {mode !== 'off' && <span className="np-mode__dot" />}
    </IconButton>
  )
}

const LOOP_NEXT: Record<LoopMode, LoopMode> = { album: 'endless', endless: 'custom', custom: 'album' }
const LOOP_LABEL: Record<LoopMode, string> = {
  album: 'Looping: as released (2 loops, then a fade)',
  endless: 'Looping: endless (until you skip)',
  custom: 'Looping: your loop count (Settings › Audio)'
}

/**
 * How looping game music (chiptunes and other files with loop points) ends. Shown only while such
 * a track plays: for everything else the button did nothing, and its disc icon meant nothing.
 */
export function LoopModeButton({ size }: { size?: Size }) {
  const mode = usePlayer((s) => s.loopMode)
  const loops = usePlayer((s) => s.current?.source?.format === 'chip' || !!s.voices)
  const Icon = mode === 'endless' ? InfinityIcon : mode === 'custom' ? IterationCw : Disc3
  if (!loops) return null
  return (
    <IconButton
      size={size}
      label={LOOP_LABEL[mode]}
      active={mode !== 'album'}
      sound={false}
      className="np-mode"
      icon={<Icon />}
      onClick={() => {
        sfx.play('select')
        void ghost().player.setLoopMode(LOOP_NEXT[mode])
      }}
    >
      {mode !== 'album' && <span className="np-mode__dot" />}
    </IconButton>
  )
}

// ---------------------------------------------------------------------------
// track actions

/** Toggle like on the current track (optimistic). Shared by the heart button and the L key. */
const likeOverride = new Map<string, boolean>()
export function toggleLikeCurrent(): void {
  const t = usePlayer.getState().current
  if (!t) return
  const next = !(likeOverride.get(t.id) ?? t.liked)
  likeOverride.set(t.id, next)
  usePlayer.setState((s) => (s.current?.id === t.id ? { current: { ...s.current, liked: next } } : s))
  sfx.play(next ? 'toggleOn' : 'toggleOff')
  void trackActions
    .toggleLike(t.id)
    .then((liked) => {
      likeOverride.delete(t.id)
      if (liked !== next) usePlayer.setState((s) => (s.current?.id === t.id ? { current: { ...s.current, liked } } : s))
    })
    .catch(() => likeOverride.delete(t.id))
}

export function LikeButton({ track, size }: { track: TrackView | null; size?: Size }) {
  const liked = !!track?.liked
  const icon = useRef<HTMLSpanElement>(null)
  const [burst, setBurst] = useState(0)
  const prev = useRef<{ id: string | null; liked: boolean }>({ id: track?.id ?? null, liked })

  // pop on every like (from the button, the L key, or a context menu)
  useEffect(() => {
    const p = prev.current
    prev.current = { id: track?.id ?? null, liked }
    if (p.id !== (track?.id ?? null) || p.liked === liked || !icon.current) return
    if (liked) {
      setBurst((b) => b + 1)
      tween(icon.current).clear().set({ scale: 0.55 }).scaleTo(1.28, 140, 'outQuad').then().scaleTo(1, 650, 'outElasticHalf')
    } else tween(icon.current).clear().set({ scale: 0.82 }).scaleTo(1, 380, 'outBack')
  }, [liked, track?.id])

  return (
    <IconButton
      size={size}
      label={liked ? 'Unlike' : 'Like'}
      shortcut="L"
      active={liked}
      disabled={!track}
      sound={false}
      className={cx('np-like', liked && 'np-like--on')}
      icon={
        <span ref={icon} className="np-like__icon">
          <Heart fill={liked ? 'currentColor' : 'none'} />
        </span>
      }
      onClick={toggleLikeCurrent}
    >
      {burst > 0 && <span key={burst} className="np-like__burst" aria-hidden />}
    </IconButton>
  )
}

/** The "Add to playlist" menu for `track`, at `anchor` (the button; Mod+S passes it too). */
export function openPlaylistMenu(track: TrackView | null, anchor: Element | null | undefined): void {
  if (!track) return
  const r = anchor?.getBoundingClientRect()
  openContextMenu(r ? { x: r.left, y: r.top - 6 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 }, [{ heading: 'Add to playlist' }, ...playlistSubmenu([track.id])])
}

export function AddToPlaylistButton({ track, size }: { track: TrackView | null; size?: Size }) {
  return (
    <IconButton
      size={size}
      label="Add to playlist"
      shortcut="Mod+S"
      disabled={!track}
      icon={<ListPlus />}
      className="np-add-playlist"
      // the menu plays its own open cue
      sound={false}
      onClick={(e) => openPlaylistMenu(track, e.currentTarget)}
    />
  )
}

export function downloadCurrent(track: TrackView | null): void {
  if (!track || track.downloaded) return
  void trackActions.download({ trackIds: [track.id] }).then(
    () => notify({ kind: 'info', title: 'Download queued', body: track.title, image: track.cover }),
    (err) => notify({ kind: 'error', title: 'Couldn’t queue download', body: String(err?.message ?? err) })
  )
}

export function DownloadButton({ track, size }: { track: TrackView | null; size?: Size }) {
  const done = !!track?.downloaded
  return (
    <IconButton
      size={size}
      label={done ? 'Downloaded' : 'Download'}
      shortcut={done ? undefined : 'Mod+D'}
      disabled={!track}
      active={done}
      icon={done ? <Check /> : <Download />}
      sound={done ? false : 'confirm'}
      onClick={() => downloadCurrent(track)}
    />
  )
}

// ---------------------------------------------------------------------------
// track info

/**
 * The intensity stars with a tooltip saying what they are. Nothing until the track is analysed:
 * a bare "★ –" read as a broken rating.
 */
export function Intensity({ value, size, glow }: Pick<IntensityBadgeProps, 'value' | 'size' | 'glow'>) {
  if (value == null || Number.isNaN(value)) return null
  return (
    <Tooltip content={`Intensity ${value.toFixed(2)} of 10: how energetic this track is`}>
      <span className="np-intensity">
        <IntensityBadge value={value} size={size} glow={glow} />
      </span>
    </Tooltip>
  )
}

// ---------------------------------------------------------------------------
// volume

export function VolumeControl({ width = 110, size = 'md' }: { width?: number; size?: Size }) {
  const vol = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const Icon = volumeIcon(vol, muted)
  return (
    <div className="np-volume" style={{ '--np-vol-w': `${width}px` } as CSSProperties}>
      <IconButton size={size} label={muted ? 'Unmute' : 'Mute'} shortcut="M" sound={false} icon={<Icon />} onClick={() => {
        sfx.play(muted ? 'toggleOn' : 'toggleOff')
        volume.toggleMute()
      }} />
      <Slider
        className="np-volume__slider"
        variant="volume"
        value={muted ? 0 : vol}
        min={0}
        max={1}
        step={0.01}
        wheelStep={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => volume.set(v)}
        aria-label="Volume"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// time

/** Live elapsed / remaining time; writes text only when the displayed second changes. */
export function LiveTime({ kind, active = true, className }: { kind: 'elapsed' | 'remaining' | 'duration'; active?: boolean; className?: string }) {
  const el = useRef<HTMLSpanElement>(null)
  const shown = useRef('')
  const text = () => {
    const s = usePlayer.getState()
    const d = s.durationMs ?? 0
    if (kind === 'duration') return d ? formatTime(d) : '–:––'
    const p = livePositionMs(s)
    if (kind === 'elapsed') return formatTime(p)
    return d ? `-${formatTime(Math.max(0, d - p))}` : '–:––'
  }
  const write = () => {
    const n = el.current
    if (!n) return
    // format only when the displayed second (or the duration) changed, not every frame
    const s = usePlayer.getState()
    const key = `${Math.floor(kind === 'duration' ? 0 : livePositionMs(s) / 1000)}|${s.durationMs ?? 0}`
    if (key === shown.current) return
    shown.current = key
    const t = text()
    if (n.textContent !== t) n.textContent = t
  }
  // per frame only while the clock runs; otherwise on state pushes (seek, track change)
  const playing = usePlayer((s) => s.status === 'playing')
  useTicker(write, active && playing)
  useEffect(() => {
    if (!active || playing) return
    write()
    return usePlayer.subscribe(write)
  }, [active, playing]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span ref={el} className={cx('tnum', className)}>
      {text()}
    </span>
  )
}
