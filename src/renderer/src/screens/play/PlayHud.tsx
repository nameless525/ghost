// Play screen HUD: the compact metadata block (bottom-left, the title card's landing spot),
// transport (centre), track actions + volume + queue toggle (right), the energy seek bar along
// the bottom, and a slim top bar (back, visualizer mode). Controls fade with mouse idle.
import { Activity, ChevronLeft, CircleDot, ListMusic, AudioLines } from 'lucide-react'
import { forwardRef, type ReactNode } from 'react'
import type { TrackView } from '@shared/types'
import type { VisualizerMode } from '../../gfx/visualizers'
import { goBack } from '../../shell/navigation'
import { usePlayer } from '../../state/player'
import { CoverArt, IconButton, Kbd, SegmentedControl, ShearButton } from '../../ui'
import { cx } from '../../ui/util'
import {
  AddToPlaylistButton,
  DownloadButton,
  Intensity,
  LikeButton,
  LoopModeButton,
  NextButton,
  PlayPauseButton,
  PrevButton,
  RepeatButton,
  ShuffleButton,
  VolumeControl
} from '../../overlays/now-playing/controls'
import { ChannelStrip, type ChannelStripProps } from './ChannelStrip'
import { EnergySeekBar } from './EnergySeekBar'

export const VIS_ICONS: Record<VisualizerMode, ReactNode> = {
  radial: <CircleDot size={15} />,
  skyline: <AudioLines size={15} />,
  scope: <Activity size={15} />
}

export const MetaBlock = forwardRef<HTMLDivElement, { track: TrackView; intensity: number | null; bpm: number | null }>(function MetaBlock({ track, intensity, bpm }, ref) {
  return (
    <div ref={ref} className="pl-meta">
      <div className="pl-meta__cover" data-flip="cover">
        <CoverArt src={track.cover} size={64} radius={9} hue={track.accent} />
      </div>
      <div className="pl-meta__text">
        <div className="pl-meta__title g-ellipsis" data-flip="title" title={track.title}>
          {track.title}
        </div>
        <div className="pl-meta__game g-ellipsis" data-flip="game">
          {track.gameName ?? track.albumTitle}
        </div>
        <div className="pl-meta__chips" data-meta-fade>
          <Intensity value={intensity} size="sm" />
          {bpm ? <span className="pl-stat pl-stat--sm tnum">{Math.round(bpm)} BPM</span> : null}
          <span className="pl-meta__album g-ellipsis">{track.albumTitle}</span>
        </div>
      </div>
    </div>
  )
})

export interface PlayHudProps {
  track: TrackView
  intensity: number | null
  bpm: number | null
  queueOpen: boolean
  onToggleQueue: () => void
  /** Tickers (live time) run only while true. */
  active: boolean
  onHoverChange: (hovering: boolean) => void
  metaRef: (el: HTMLDivElement | null) => void
  rowRef: (el: HTMLDivElement | null) => void
  seekRef: (el: HTMLDivElement | null) => void
  /** Keyboard changes on the chip channel strip (OSD). */
  onAnnounce?: ChannelStripProps['onAnnounce']
}

export function PlayHud({ track, intensity, bpm, queueOpen, onToggleQueue, active, onHoverChange, metaRef, rowRef, seekRef, onAnnounce }: PlayHudProps) {
  const upNext = usePlayer((s) => Math.max(0, s.queue.length - s.queueIndex - 1))
  return (
    <div className="pl-hud" onPointerEnter={() => onHoverChange(true)} onPointerLeave={() => onHoverChange(false)}>
      <ChannelStrip onAnnounce={onAnnounce} />
      <div className="pl-hud__row">
        <MetaBlock ref={metaRef} track={track} intensity={intensity} bpm={bpm} />
        <div ref={rowRef} className="pl-hud__controls">
          <div className="pl-transport">
            <ShuffleButton />
            <PrevButton />
            <PlayPauseButton size="xl" />
            <NextButton />
            <RepeatButton />
          </div>
          <div className="pl-actions">
            <LoopModeButton />
            <LikeButton track={track} />
            <AddToPlaylistButton track={track} />
            <DownloadButton track={track} />
            <span className="pl-actions__sep" />
            <VolumeControl width={104} />
            <IconButton
              label={queueOpen ? 'Hide queue' : 'Show queue'}
              shortcut="Q"
              active={queueOpen}
              sound={false}
              className="np-queue-toggle"
              icon={<ListMusic />}
              onClick={onToggleQueue}
            >
              {upNext > 0 && <span className="np-queue-toggle__count tnum">{upNext > 99 ? '99+' : upNext}</span>}
            </IconButton>
          </div>
        </div>
      </div>
      <div ref={seekRef} className="pl-hud__seek">
        <EnergySeekBar active={active} />
      </div>
    </div>
  )
}

export const PlayTopBar = forwardRef<HTMLDivElement, { mode: VisualizerMode; onMode: (m: VisualizerMode) => void; className?: string }>(function PlayTopBar({ mode, onMode, className }, ref) {
  return (
    <div ref={ref} className={cx('pl-top', className)}>
      <div className="pl-top__back">
        <ShearButton icon={<ChevronLeft />} label="Back" hint="Esc" size="sm" sound={false} onClick={() => goBack()} />
      </div>
      <div className="pl-top__vis">
        {/* the key cycles them, like Esc on the Back button */}
        <span className="pl-top__vis-label g-caps">
          Visualizer <Kbd combo="V" size="sm" />
        </span>
        <SegmentedControl<VisualizerMode>
          value={mode}
          onChange={onMode}
          aria-label="Visualizer"
          options={[
            { value: 'radial', label: 'Radial', icon: VIS_ICONS.radial },
            { value: 'skyline', label: 'Skyline', icon: VIS_ICONS.skyline },
            { value: 'scope', label: 'Scope', icon: VIS_ICONS.scope }
          ]}
        />
      </div>
    </div>
  )
})
