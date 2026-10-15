// Liked, History and Downloaded tabs.
import { ClockFading, Compass, Download, FolderOpen, FolderSearch, HardDriveDownload, Heart, HeartOff, Play, Shuffle, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DownloadItem, HistoryEntry, PlayContext, TrackView } from '@shared/types'
import { ghost } from '../../ghost'
import { trackActions, trackMenuItems } from '../../lib/track-actions'
import { navigate } from '../../shell/navigation'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { useUI } from '../../state/ui'
import { isMac } from '../../theme'
import { IntensityBadge } from '../../ui/Badges'
import { Button } from '../../ui/Button'
import { openContextMenu } from '../../ui/ContextMenu'
import { CoverArt } from '../../ui/CoverArt'
import { formatSum, formatTime, sumKnown } from '../../ui/format'
import { IconButton } from '../../ui/IconButton'
import { LoadingRing } from '../../ui/LoadingRing'
import { ScrollArea } from '../../ui/ScrollArea'
import { cx } from '../../ui/util'
import { clockTime, dayLabel, EmptyState, formatLong, isSameDay, plural, relativeTime, useNow, type Live } from './common'
import { showSnack } from './Snack'
import { TrackList, type TrackListItem } from './TrackList'

const browse = () => {
  useUI.getState().toggleOverlay('library', false)
  navigate('browse')
}

const BrowseButton = ({ label = 'Browse music' }: { label?: string }) => (
  <Button variant="soft" hue="browse" icon={<Compass />} onClick={browse}>
    {label}
  </Button>
)

async function playAll(tracks: TrackView[], ctx: PlayContext, shuffle: boolean) {
  if (!tracks.length) return
  await ghost().player.setShuffle(shuffle ? 'on' : 'off')
  await trackActions.play(
    tracks.map((t) => t.id),
    shuffle ? Math.floor(Math.random() * tracks.length) : 0,
    ctx
  )
}

function Summary({ tracks }: { tracks: TrackView[] }) {
  // unknown lengths stay unknown: no "0 min", and a partly-known total reads "1 h 20 min+"
  const ms = sumKnown(tracks.map((t) => t.durationMs || null))
  return (
    <span className="lib-toolbar__summary tnum">
      {plural(tracks.length, 'track')}
      {ms && (
        <>
          <span className="lib-dot" />
          {formatSum(ms, formatLong)}
        </>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Liked

const LIKED_CTX: PlayContext = { kind: 'liked', id: null, title: 'Liked tracks' }

export function LikedTab({ live }: { live: Live<TrackView[]> }) {
  const scroll = useRef<HTMLDivElement>(null)
  const tracks = live.data
  const items = useMemo<TrackListItem[]>(() => (tracks ?? []).map((t) => ({ key: t.id, track: t })), [tracks])

  return (
    <div className="lib-tabview">
      {!!tracks?.length && (
        <div className="lib-toolbar">
          <Button variant="primary" hue="library" icon={<Play />} sound="confirm" onClick={() => void playAll(tracks, LIKED_CTX, false)}>
            Play all
          </Button>
          <Button variant="secondary" icon={<Shuffle />} sound="confirm" onClick={() => void playAll(tracks, LIKED_CTX, true)}>
            Shuffle
          </Button>
          <div className="lib-toolbar__spacer" />
          <Summary tracks={tracks} />
        </div>
      )}
      <ScrollArea viewportRef={scroll} className="lib-scroll" fade={false}>
        {live.loading ? (
          <LoadingRing center />
        ) : !tracks?.length ? (
          <EmptyState
            icon={<Heart />}
            title="No liked tracks yet"
            body={
              <>
                Hit the heart on any track (or press <b>L</b>) and it lands here, ready to play all or shuffle.
              </>
            }
            actions={<BrowseButton />}
          />
        ) : (
          <TrackList
            items={items}
            scrollRef={scroll}
            context={LIKED_CTX}
            onPlay={(i) => void trackActions.play(items.map((x) => x.track.id), i, LIKED_CTX)}
            onLikeChange={(t, liked) => {
              if (liked) return
              showSnack({
                host: 'library',
                icon: <HeartOff />,
                title: `Removed “${t.title}”`,
                body: 'from Liked tracks',
                action: { label: 'Undo', icon: <Undo2 />, onClick: () => void trackActions.toggleLike(t.id) }
              })
            }}
          />
        )}
      </ScrollArea>
    </div>
  )
}

// ---------------------------------------------------------------------------
// History

const HISTORY_CTX: PlayContext = { kind: 'history', id: null, title: 'Recently played' }

export function HistoryTab({ live, active }: { live: Live<HistoryEntry[]>; active: boolean }) {
  const now = useNow(30000, active)
  const entries = live.data
  const groups = useMemo(() => {
    const out: { label: string; key: string; rows: { e: HistoryEntry; i: number }[] }[] = []
    ;(entries ?? []).forEach((e, i) => {
      const last = out[out.length - 1]
      if (last && isSameDay(last.rows[0].e.playedAt, e.playedAt)) last.rows.push({ e, i })
      else out.push({ label: dayLabel(e.playedAt, now), key: String(new Date(e.playedAt).toDateString()), rows: [{ e, i }] })
    })
    return out
  }, [entries, now])
  const ids = useMemo(() => (entries ?? []).map((e) => e.track.id), [entries])
  const currentId = usePlayer((s) => s.current?.id ?? null)
  // keyed by play (time + track), not by index: each new play shifts every index, which remounted
  // all rows and moved the highlight to another track
  const [sel, setSel] = useState<string | null>(null)

  const play = (i: number) => {
    sfx.play('confirm', { volume: 0.7 })
    void trackActions.play(ids, i, HISTORY_CTX)
  }

  return (
    <div className="lib-tabview">
      <ScrollArea className="lib-scroll" fade={false}>
        {live.loading ? (
          <LoadingRing center />
        ) : !entries?.length ? (
          <EmptyState icon={<ClockFading />} title="Nothing played yet" body="Everything you listen to shows up here, grouped by day, so you can find that one track again." actions={<BrowseButton label="Start listening" />} />
        ) : (
          <div className="lib-hist" role="list">
            {groups.map((g) => (
              <section key={g.key} className="lib-hist__group">
                <header className="lib-hist__day">
                  <span>{g.label}</span>
                  <span className="lx-count">{g.rows.length}</span>
                </header>
                {g.rows.map(({ e, i }) => {
                  const t = e.track
                  const today = isSameDay(e.playedAt, now)
                  const key = `${e.playedAt}:${t.id}`
                  return (
                    <div
                      key={key}
                      role="listitem"
                      className={cx('lib-hist__row', sel === key && 'lib-hist__row--sel', currentId === t.id && 'lib-hist__row--current')}
                      onClick={() => setSel(key)}
                      onDoubleClick={() => play(i)}
                      onContextMenu={(ev) => {
                        ev.preventDefault()
                        setSel(key)
                        openContextMenu({ x: ev.clientX, y: ev.clientY }, trackMenuItems(t, { playList: { ids, index: i, context: HISTORY_CTX } }))
                      }}
                    >
                      <span className="lib-hist__time tnum" title={new Date(e.playedAt).toLocaleString()}>
                        {today ? relativeTime(e.playedAt, now) : clockTime(e.playedAt)}
                      </span>
                      <span className="lib-hist__cover">
                        <CoverArt src={t.cover} size={36} radius={7} hue={t.accent} lazy />
                        <button
                          type="button"
                          className="lib-hist__play"
                          aria-label={`Play ${t.title}`}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            play(i)
                          }}
                        >
                          <Play />
                        </button>
                      </span>
                      <span className="lib-hist__title">
                        <span className="tl-title g-ellipsis">{t.title}</span>
                        <span className="tl-sub g-ellipsis">
                          {t.gameName ?? t.albumTitle}
                          {t.gameName && <span className="lib-hist__album"> · {t.albumTitle}</span>}
                        </span>
                      </span>
                      <span className="lib-hist__int">
                        <IntensityBadge value={t.analysis?.intensity ?? null} size="sm" />
                      </span>
                      <span className="lib-hist__len tnum">
                        {t.durationMs && e.msPlayed > 0 && e.msPlayed < t.durationMs - 5000 ? (
                          <span className="lib-hist__partial" title={`Played ${formatTime(e.msPlayed)} of ${formatTime(t.durationMs)}`}>
                            <span style={{ transform: `scaleX(${Math.min(1, e.msPlayed / t.durationMs)})` }} />
                          </span>
                        ) : null}
                        {t.durationMs ? formatTime(t.durationMs) : '–:––'}
                      </span>
                      <span className={cx('lib-hist__liked', t.liked && 'lib-hist__liked--on')} aria-label={t.liked ? 'Liked' : undefined}>
                        <Heart />
                      </span>
                    </div>
                  )
                })}
              </section>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Downloaded

const DOWNLOADED_CTX: PlayContext = { kind: 'downloaded', id: null, title: 'Downloaded' }
export const revealLabel = isMac ? 'Reveal in Finder' : 'Show in folder'

export function DownloadedTab({ live, active }: { live: Live<TrackView[]>; active: boolean }) {
  const scroll = useRef<HTMLDivElement>(null)
  const tracks = live.data
  const items = useMemo<TrackListItem[]>(() => (tracks ?? []).map((t) => ({ key: t.id, track: t })), [tracks])
  const [paths, setPaths] = useState<Map<string, string>>(() => new Map())

  // file paths come from the downloads list (finished items)
  useEffect(() => {
    if (!active) return
    let live = true
    const apply = (list: DownloadItem[]) => {
      if (!live) return
      const m = new Map<string, string>()
      for (const d of [...list].sort((a, b) => a.createdAt - b.createdAt)) if (d.status === 'done' && d.path) m.set(d.trackId, d.path)
      // downloads:changed arrives ~4×/s while anything downloads: only re-render when a finished
      // file actually appeared, moved or went away
      setPaths((prev) => (prev.size === m.size && [...m].every(([k, v]) => prev.get(k) === v) ? prev : m))
    }
    ghost()
      .downloads.list()
      .then(apply)
      .catch(() => {})
    const off = ghost().on('downloads:changed', apply)
    return () => {
      live = false
      off()
    }
  }, [active])

  const reveal = (trackId: string) => {
    const p = paths.get(trackId)
    if (p) void ghost().system.reveal(p)
    else void ghost().downloads.openFolder()
  }

  return (
    <div className="lib-tabview">
      {!!tracks?.length && (
        <div className="lib-toolbar">
          <Button variant="primary" hue="library" icon={<Play />} sound="confirm" onClick={() => void playAll(tracks, DOWNLOADED_CTX, false)}>
            Play all
          </Button>
          <Button variant="secondary" icon={<Shuffle />} sound="confirm" onClick={() => void playAll(tracks, DOWNLOADED_CTX, true)}>
            Shuffle
          </Button>
          <div className="lib-toolbar__spacer" />
          <Summary tracks={tracks} />
          <Button variant="ghost" icon={<FolderOpen />} title="Open the downloads folder" onClick={() => void ghost().downloads.openFolder()}>
            Open folder
          </Button>
        </div>
      )}
      <ScrollArea viewportRef={scroll} className="lib-scroll" fade={false}>
        {live.loading ? (
          <LoadingRing center />
        ) : !tracks?.length ? (
          <EmptyState
            icon={<HardDriveDownload />}
            title="Nothing downloaded yet"
            body="Download tracks, albums or whole playlists to listen offline. Files are saved untouched and fully tagged in your downloads folder."
            actions={
              <>
                <BrowseButton />
                <Button variant="ghost" icon={<Download />} onClick={() => useUI.getState().toggleOverlay('downloads', true)}>
                  Open Downloads
                </Button>
                <Button variant="ghost" icon={<FolderOpen />} onClick={() => void ghost().downloads.openFolder()}>
                  Open folder
                </Button>
              </>
            }
          />
        ) : (
          <TrackList
            items={items}
            scrollRef={scroll}
            context={DOWNLOADED_CTX}
            onPlay={(i) => void trackActions.play(items.map((x) => x.track.id), i, DOWNLOADED_CTX)}
            menuExtra={(it) => [{ label: revealLabel, icon: <FolderSearch size={15} strokeWidth={2} />, onSelect: () => reveal(it.track.id) }]}
            rowExtra={(it) => <IconButton size="sm" icon={<FolderSearch />} label={revealLabel} tooltip={paths.has(it.track.id) ? revealLabel : 'Open downloads folder'} onClick={() => reveal(it.track.id)} />}
          />
        )}
      </ScrollArea>
    </div>
  )
}
