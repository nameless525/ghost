// The big title card shown when the Play screen opens (and on every track change): cover,
// title, game, album, composers and stats. It covers the buffering time, then the screen
// FLIPs its cover/title/game into the compact HUD block (see glide() in index.tsx).
// Elements tagged data-flip="cover|title|game" travel; data-fade ones just leave.
import { forwardRef } from 'react'
import type { PlayStatus, TrackView } from '@shared/types'
import { CoverArt, IntensityBadge, LoadingRing, SourceBadge, formatTime } from '../../ui'
import { cx } from '../../ui/util'

export interface TitleCardProps {
  track: TrackView
  status: PlayStatus
  intensity: number | null
  bpm: number | null
  durationMs: number | null
  position: { index: number; total: number; context: string | null }
  coverSize: number
  /** True while the hold is extended because the track is still loading. */
  waiting: boolean
  /** Changes on every showing (restarts the hold progress line). */
  showKey: number
}

export const TitleCard = forwardRef<HTMLDivElement, TitleCardProps>(function TitleCard(
  { track, status, intensity, bpm, durationMs, position, coverSize, waiting, showKey },
  ref
) {
  const loading = status === 'loading' || status === 'buffering'
  const composers = track.composers.length ? track.composers.join(', ') : null
  const year = track.year ? String(track.year) : null
  return (
    <div ref={ref} className="pl-card" aria-live="polite">
      <div className="pl-card__scrim" data-card-scrim />
      <div className="pl-card__inner">
        <div className="pl-card__cover" data-flip="cover" style={{ width: coverSize, height: coverSize }}>
          <CoverArt src={track.cover} size={coverSize} radius={18} hue={track.accent} />
          <div className="pl-card__cover-shine" />
        </div>
        <div className="pl-card__text">
          <div className="pl-card__eyebrow g-caps" data-fade>
            {loading ? <LoadingRing size={13} /> : <span className="pl-card__dot" />}
            <span>{loading ? 'Loading' : 'Now playing'}</span>
            {position.total > 1 && (
              <span className="pl-card__pos tnum">
                {position.index + 1} / {position.total}
              </span>
            )}
            {position.context && <span className="pl-card__ctx g-ellipsis">{position.context}</span>}
          </div>
          <h1 className="pl-card__title" data-flip="title">
            {track.title}
          </h1>
          {track.titleOriginal && track.titleOriginal !== track.title && (
            <div className="pl-card__original g-jp" data-fade>
              {track.titleOriginal}
            </div>
          )}
          <div className="pl-card__game" data-flip="game">
            {track.gameName ?? track.albumTitle}
          </div>
          <div className="pl-card__album" data-fade>
            <span className="pl-card__album-name" title={track.albumTitle}>
              {track.albumTitle}
            </span>
            {year && <span className="pl-card__year">{year}</span>}
            {track.platforms.length > 0 && <span className="pl-card__year">{track.platforms.join(' · ')}</span>}
          </div>
          {composers && (
            <div className="pl-card__composers" data-fade>
              <span className="g-caps">Music</span> {composers}
            </div>
          )}
          <div className="pl-card__stats" data-fade>
            <IntensityBadge value={intensity} size="lg" glow />
            {bpm ? <span className="pl-stat tnum">{Math.round(bpm)} BPM</span> : null}
            {durationMs ? <span className="pl-stat tnum">{formatTime(durationMs)}</span> : null}
            {track.source && <SourceBadge source={track.source} />}
          </div>
          <div className={cx('pl-card__progress', waiting && 'pl-card__progress--waiting')} data-fade>
            <i key={showKey} />
          </div>
        </div>
      </div>
    </div>
  )
})
