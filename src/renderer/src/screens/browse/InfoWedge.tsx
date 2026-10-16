// The lazer-style info wedge (left): big cover over the hero art, title (original/romanised),
// credits, stats for the selection, which source will play, and the group's album list.
// Content changes cross-slide (old layer slides out while the new one slides in).
import { AudioLines, Disc3, Gamepad2, SearchX } from 'lucide-react'
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { parseSearch } from '@shared/search'
import type { Album, SourceSummary, TrackAnalysisSummary } from '@shared/types'
import { artUrl } from '../../lib/art'
import { usePlayer } from '../../state/player'
import { useSettings } from '../../state/settings'
import { CoverArt } from '../../ui/CoverArt'
import { IntensityBadge, SourceBadge, sourceLabel } from '../../ui/Badges'
import { formatSum, formatTime, sumKnown } from '../../ui/format'
import { GhostMark } from '../../ui/GhostMark'

import { LoadingRing } from '../../ui/LoadingRing'
import { Wedge } from '../../ui/Panel'
import { Tooltip } from '../../ui/Tooltip'
import { cx } from '../../ui/util'
import { toggleTitles } from './actions'
import { CoverStatus } from './CoverStatus'
import { browseModel } from './model'
import { formatHint, KIND_HINT, KIND_LABEL, plural } from './panels'
import { GROUP_LABELS, providerName, useBrowse, type SelInfo } from './store'

/** The format that will actually play, given the streaming-quality setting. */
function preferredFormat(formats: Album['formats']): Album['formats'][number] | null {
  if (!formats.length) return null
  const q = useSettings.getState().sources.quality
  const order = q === 'lossless' ? ['flac', 'wav', 'm4a', 'mp3', 'ogg', 'opus'] : ['mp3', 'm4a', 'ogg', 'opus', 'flac', 'wav']
  return [...formats].sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99)[0] ?? formats[0]
}

interface Stat {
  label: string
  value: ReactNode
  /** What the number means (tooltip). */
  hint?: string
}

interface View {
  kicker: string
  title: string
  alt: string | null
  line: string | null
  facts: string[]
  cover: string | null
  hero: string | null
  accent: string | null
  stats: Stat[]
  source: { badge: SourceSummary | Album['formats'][number] | null; provider: string; extra: string | null; hint?: string } | null
  albums: Album[] | null
  /** How many albums the group has (more than `albums` while a long list loads). */
  albumsTotal: number | null
  albumId: string | null
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)]
/** Totals over albums whose counts/lengths may be unknown (not yet crawled): "–", never 0. */
const msSum = (as: Album[]) => sumKnown(as.map((a) => a.totalMs || null))
const trackSum = (as: Album[]) => sumKnown(as.map((a) => a.trackCount))
const sumMs = (as: Album[]) => formatSum(msSum(as), formatTime)
/** A total with a "+": only some albums' track lists are known so far. */
const partialHint = (what: string) => `At least ${what}: some albums’ track lists load when you open them.`
/** A total with a "+": only the first albums of a long list are loaded so far. */
const loadedHint = (what: string, n: number, of: number) => `At least ${what}: counted over the first ${n.toLocaleString()} of ${of.toLocaleString()} albums (the rest load as you scroll through them).`
/** The group's albums aren't all loaded yet (a long list loads as the carousel scrolls through it). */
const listPartial = (albums: Album[] | null, total: number | null) => !!albums && total != null && albums.length < total
/** Why a value reads "–". */
const UNKNOWN_TRACKS = 'Not known yet: an album’s track list loads when you open it.'

/** `a` with the counts of its track list when that's loaded here but the album list (from the index) doesn't have them yet. */
function withDetail(a: Album): Album {
  if (a.trackCount != null && a.totalMs) return a
  const d = browseModel.peekDetail(a.id)
  if (!d?.tracks.length) return a
  return { ...a, trackCount: a.trackCount ?? d.tracks.length, totalMs: a.totalMs || d.tracks.reduce((n, t) => n + (t.durationMs ?? 0), 0) || null }
}

/** An album row's "tracks · length", leaving out what isn't known. */
const albumMeta = (a: Album) => [a.trackCount != null ? String(a.trackCount) : null, a.totalMs ? formatTime(a.totalMs) : null].filter(Boolean).join(' · ')

/** "also MP3" when there's more than the format that plays (the badge shows that one). */
function otherFormats(formats: Album['formats']): string | null {
  const best = preferredFormat(formats)
  const bestLabel = best ? sourceLabel(best)?.label : null
  const rest = uniq(formats.map((f) => sourceLabel(f)?.label ?? f.toUpperCase())).filter((l) => l !== bestLabel)
  return rest.length ? `also ${rest.join(', ')}` : null
}

function yearSpan(years: (number | null)[]): string | null {
  const ys = years.filter((y): y is number => !!y)
  if (!ys.length) return null
  const a = Math.min(...ys)
  const b = Math.max(...ys)
  return a === b ? String(a) : `${a}–${String(b).slice(-2)}`
}

/** `live`: the selected track's analysis as the player has it (it measures a track while it plays or previews), ahead of the catalog's copy. */
function describe(sel: SelInfo, preferOrig: boolean, live: TrackAnalysisSummary | null): View {
  const g = sel.group
  const albums = sel.albums?.map(withDetail) ?? null
  const albumsTotal = sel.albumsTotal
  const pick = (title: string, original: string | null) => {
    if (!original || original === title) return { title, alt: null }
    return preferOrig ? { title: original, alt: title } : { title, alt: original }
  }

  if (sel.track) {
    const t = sel.track
    const d = sel.detail
    const { title, alt } = pick(t.title, t.titleOriginal)
    const a = live ?? t.analysis
    return {
      kicker: `Track ${t.number}${d ? ` of ${d.tracks.length}` : ''}${t.disc > 1 ? ` · Disc ${t.disc}` : ''}`,
      title,
      alt,
      line: [t.albumTitle, t.gameName && !t.albumTitle.includes(t.gameName) ? t.gameName : null].filter(Boolean).join(' · '),
      facts: [t.composers.slice(0, 3).join(', '), t.year ? String(t.year) : '', t.platforms.slice(0, 3).join(' · '), d?.album.catalogNo ?? ''].filter(Boolean),
      cover: t.cover ?? d?.album.cover ?? null,
      hero: t.hero ?? d?.game?.hero ?? g?.hero ?? null,
      accent: t.accent ?? g?.accent ?? null,
      stats: [
        { label: 'Length', value: <span className="tnum">{t.durationMs ? formatTime(t.durationMs) : '–'}</span> },
        { label: 'BPM', value: <span className="tnum">{a?.bpm ? Math.round(a.bpm) : '–'}</span>, hint: a?.bpm ? 'Tempo, in beats per minute' : 'Tempo: measured the first time the track plays or is previewed' },
        { label: 'Intensity', value: <IntensityBadge value={a?.intensity ?? null} size="lg" glow />, hint: a?.intensity != null ? 'How energetic the track is, from 0 (calm) to 10 (frantic)' : 'How energetic the track is: measured the first time it plays or is previewed' },
        {
          label: 'Loudness',
          hint: a?.lufs != null ? 'Average loudness (LUFS). GHOST evens out the volume between tracks.' : 'Average loudness: measured the first time the track plays or is previewed',
          value: a?.lufs != null ? (
            <>
              <span className="tnum">{a.lufs.toFixed(1)}</span>
              <span className="bw__unit">LUFS</span>
            </>
          ) : (
            '–'
          )
        }
      ],
      source: t.source
        ? {
            badge: t.source,
            provider: providerName(t.source.provider),
            extra: [t.source.bitrateKbps ? `${Math.round(t.source.bitrateKbps)} kbps` : null, t.source.confidence < 0.995 ? `${Math.round(t.source.confidence * 100)}% match` : null].filter(Boolean).join(' · ') || null,
            hint: t.source.confidence < 0.995 ? 'How sure GHOST is that this recording is the right track' : undefined
          }
        : { badge: null, provider: 'Found when you play it', extra: null },
      albums,
      albumsTotal,
      albumId: t.albumId
    }
  }

  if (sel.album) {
    const al = withDetail(sel.album)
    const d = sel.detail
    const { title, alt } = pick(al.title, al.titleOriginal)
    const peak = d?.tracks.reduce((m, t) => Math.max(m, t.analysis?.intensity ?? -1), -1) ?? -1
    return {
      kicker: `${KIND_LABEL[al.kind] ?? 'Album'} · Album`,
      title,
      alt,
      line: al.gameName && !al.title.includes(al.gameName) ? al.gameName : (d?.game?.name ?? null),
      facts: [al.composers.slice(0, 3).join(', '), al.year ? String(al.year) : '', al.platforms.slice(0, 3).join(' · '), al.catalogNo ?? ''].filter(Boolean),
      cover: al.cover ?? g?.cover ?? null,
      hero: d?.game?.hero ?? g?.hero ?? null,
      accent: d?.game?.accent ?? g?.accent ?? null,
      stats: [
        { label: 'Tracks', value: <span className="tnum">{al.trackCount ?? d?.tracks.length ?? '–'}</span>, hint: al.trackCount == null && !d ? UNKNOWN_TRACKS : undefined },
        { label: 'Length', value: <span className="tnum">{al.totalMs ? formatTime(al.totalMs) : '–'}</span>, hint: al.totalMs ? undefined : UNKNOWN_TRACKS },
        {
          label: 'Peak',
          value: d ? <IntensityBadge value={peak >= 0 ? peak : null} size="lg" glow /> : <LoadingRing size={18} />,
          hint: peak >= 0 ? 'Intensity of the album’s most energetic track, from 0 to 10' : 'Intensity of the most energetic track: measured as tracks play'
        },
        { label: 'Discs', value: <span className="tnum">{d ? Math.max(1, ...d.tracks.map((t) => t.disc)) : '–'}</span> }
      ],
      source: { badge: preferredFormat(al.formats), provider: providerName(al.provider), extra: otherFormats(al.formats) },
      albums,
      albumsTotal,
      albumId: al.id
    }
  }

  // a group (game or bucket)
  if (!g) {
    return { kicker: 'Loading', title: '', alt: null, line: null, facts: [], cover: null, hero: null, accent: null, stats: [], source: null, albums: null, albumsTotal: null, albumId: null }
  }
  const orig = g.kind === 'game' ? browseModel.originalTitle(g.gameId, g.title) : null
  const { title, alt } = pick(g.title, orig)
  const game = g.gameId ? browseModel.game(g.gameId) : null
  // Over a long list's first albums only, the sums are "at least" (a "+"), never the group's total.
  const partial = listPartial(albums, albumsTotal)
  const atLeast = (sum: { total: number; partial: boolean } | null) => (sum && partial ? { ...sum, partial: true } : sum)
  const trackTotal = albums && atLeast(trackSum(albums))
  const lengthTotal = albums && atLeast(msSum(albums))
  const tracks = albums ? formatSum(trackTotal, (n) => n.toLocaleString()) : '–'
  const length = albums ? formatSum(lengthTotal, formatTime) : '–'
  const sumHint = (sum: { total: number; partial: boolean } | null, what: (n: number) => string) =>
    !albums ? undefined : !sum ? UNKNOWN_TRACKS : partial ? loadedHint(what(sum.total), albums.length, albumsTotal!) : sum.partial ? partialHint(what(sum.total)) : undefined
  const tracksHint = sumHint(trackTotal, (n) => plural(n, 'track'))
  const lengthHint = sumHint(lengthTotal, formatTime)
  const composers = albums ? uniq(albums.flatMap((a) => a.composers)).slice(0, 3) : []
  const years = albums && yearSpan(albums.map((a) => a.year))
  const stats: Stat[] =
    g.kind === 'game'
      ? [
          { label: 'Albums', value: <span className="tnum">{albumsTotal ?? albums?.length ?? g.albumCount}</span> },
          { label: 'Tracks', value: <span className="tnum">{tracks}</span>, hint: tracksHint },
          { label: 'Length', value: <span className="tnum">{length}</span>, hint: lengthHint },
          { label: 'Released', value: <span className="tnum">{years ?? g.year ?? '–'}</span>, hint: years ? (partial ? 'When the albums loaded so far came out' : 'When its soundtrack albums came out') : undefined }
        ]
      : g.kind === 'album'
        ? // its track list is still loading (then it shows as an album)
          [
            { label: 'Tracks', value: '–', hint: UNKNOWN_TRACKS },
            { label: 'Length', value: '–', hint: UNKNOWN_TRACKS },
            { label: 'Peak', value: <LoadingRing size={18} /> },
            { label: 'Discs', value: '–' }
          ]
        : [
            { label: 'Albums', value: <span className="tnum">{g.albumCount}</span> },
            {
              label: 'Games',
              value: <span className="tnum">{albums ? `${uniq(albums.map((a) => a.gameName ?? a.title)).length}${partial ? '+' : ''}` : '–'}</span>,
              hint: partial ? `Among the first ${albums!.length.toLocaleString()} of ${albumsTotal!.toLocaleString()} albums (the rest load as you scroll through them)` : undefined
            },
            { label: 'Tracks', value: <span className="tnum">{tracks}</span>, hint: tracksHint },
            { label: 'Length', value: <span className="tnum">{length}</span>, hint: lengthHint }
          ]
  const providers = albums ? uniq(albums.map((a) => a.provider)) : []
  const formats = albums ? uniq(albums.flatMap((a) => a.formats)) : []
  return {
    kicker: g.kind === 'game' ? 'Game' : GROUP_LABELS[g.kind],
    title,
    alt,
    line: g.kind === 'game' ? (game?.franchise && game.franchise !== g.title ? `${game.franchise} series` : null) : g.subtitle,
    facts: [composers.join(', '), g.year ? String(g.year) : '', g.platforms.slice(0, 4).join(' · ')].filter(Boolean),
    cover: g.cover ?? g.hero,
    hero: g.hero ?? g.cover,
    accent: g.accent,
    stats,
    source: providers.length ? { badge: preferredFormat(formats), provider: providers.map(providerName).join(', '), extra: otherFormats(formats) } : null,
    albums,
    albumsTotal,
    albumId: null
  }
}

/** Keeps the previous content on screen while it slides out and the new one slides in. */
function Swap({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const cur = useRef<{ id: string; node: ReactNode }>({ id, node: children })
  const prev = useRef<{ id: string; node: ReactNode; n: number } | null>(null)
  const n = useRef(0)
  const [, force] = useReducer((x: number) => x + 1, 0)
  if (cur.current.id !== id) {
    prev.current = { ...cur.current, n: ++n.current }
    cur.current = { id, node: children }
  } else cur.current.node = children
  const p = prev.current
  return (
    <div className={cx('bw-swap', className)}>
      {p && (
        <div
          key={'out' + p.n}
          className="bw-swap__layer bw-swap__layer--out"
          aria-hidden
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget && prev.current?.n === p.n) {
              prev.current = null
              force()
            }
          }}
        >
          {p.node}
        </div>
      )}
      <div key={'in' + id} className={cx('bw-swap__layer', p && 'bw-swap__layer--in')}>
        {children}
      </div>
    </div>
  )
}

const HERO_REST_MS = 160

/** `value` once it has stayed the same for `ms`. */
function useRested<T>(value: T, ms: number): T {
  const [rested, setRested] = useState(value)
  useEffect(() => {
    if (Object.is(value, rested)) return
    const t = window.setTimeout(() => setRested(value), ms)
    return () => window.clearTimeout(t)
  }, [value, rested, ms])
  return rested
}

export function InfoWedge() {
  const sel = useBrowse((s) => s.sel)
  const total = useBrowse((s) => s.total)
  const loading = useBrowse((s) => s.loading)
  const text = useBrowse((s) => s.text) && browseModel.query.text
  const preferOrig = useSettings((s) => s.interface.preferOriginalTitles)
  const trackId = sel?.track?.id ?? null
  const live = usePlayer((s) => (trackId == null ? null : s.preview?.track.id === trackId ? s.preview.track.analysis : s.current?.id === trackId ? s.current.analysis : null))
  const v = useMemo(() => (sel ? describe(sel, preferOrig, live) : null), [sel, preferOrig, live])

  // only read while showing "no matches": catalog:status arrives several times a second while
  // indexing, and the game count re-rendered the whole wedge each time
  const catalogGames = useBrowse((s) => (!s.sel && !s.loading && s.total === 0 ? (s.status?.games ?? null) : null))
  // the catalog couldn't be read at all: not a "no matches" (EmptyState says what happened)
  const unavailable = useBrowse((s) => !!s.catalogError)
  const noMatch = !sel && !loading && total === 0 && !!text && !unavailable
  const hasFilters = useMemo(() => (noMatch ? parseSearch(text).filters.length > 0 : false), [noMatch, text])

  // The hero is the 1600 px copy: decoded and uploaded on every row passed while scrolling, it was
  // thrown away a few frames later. It follows once the selection rests (the cover above it,
  // the size the row already asked for, comes at once).
  const hero = useRested(artUrl(v?.hero ?? v?.cover ?? null, { w: 720 }), HERO_REST_MS)

  return (
    <Wedge side="left" className="bw" glow>
      <div className="bw__hero">
        {hero && <div key={hero} className="bw__hero-art" style={{ backgroundImage: `url("${hero}")` }} />}
        <div className="bw__hero-shade" />
        <div className="bw__cover">
          <CoverArt src={v?.cover ?? null} size="100%" w={188} radius={12} hue={v?.accent ?? undefined} />
          <CoverStatus sel={sel} />
        </div>
        <Swap id={sel?.id ?? (loading ? 'loading' : 'empty')} className="bw__heading">
          {v && v.title ? (
            <>
              <div className="bw__kicker">
                {sel?.kind === 'track' ? <AudioLines /> : sel?.kind === 'album' ? <Disc3 /> : <Gamepad2 />}
                {v.kicker}
              </div>
              <h1 className={cx('bw__title', v.title.length > 34 && 'bw__title--long')} title={v.title}>
                {v.title}
              </h1>
              {v.alt && (
                <Tooltip content={`${preferOrig ? 'Romanized' : 'Original'} title: click to show it first`} shortcut="Alt+J" side="bottom">
                  <button type="button" className="bw__alt g-jp" onClick={toggleTitles}>
                    {v.alt}
                  </button>
                </Tooltip>
              )}
              {v.line && <div className="bw__line">{v.line}</div>}
            </>
          ) : sel && !sel.group ? (
            <div className="bw__skeleton" aria-label="Loading">
              <span />
              <span />
              <span />
            </div>
          ) : noMatch ? (
            <>
              <div className="bw__kicker">
                <SearchX />
                No matches
              </div>
              <h1 className={cx('bw__title', text.length > 30 && 'bw__title--long')} title={text}>
                “{text}”
              </h1>
              {catalogGames != null && catalogGames > 0 && <div className="bw__line">{catalogGames.toLocaleString()} games searched</div>}
            </>
          ) : (
            <div className="bw__empty">
              <GhostMark />
              <div>{unavailable ? 'Catalog unavailable' : loading || total == null ? 'Loading the catalog…' : 'Your catalog is empty'}</div>
            </div>
          )}
        </Swap>
      </div>
      <Swap id={noMatch ? 'no-match' : (sel?.id ?? 'none') + (v?.stats.length ?? 0)} className="bw__body">
        {noMatch && (
          <ul className="bw__tips">
            <li>Spelling is forgiving: punctuation, accents and spaces don’t matter (“yugioh” finds Yu-Gi-Oh!) and sequel numbers match either way (FF7, VII).</li>
            <li>Fewer words usually help. Try just the series name.</li>
            {hasFilters && <li>Filters in the query narrow the search. Remove them to widen it.</li>}
          </ul>
        )}
        {v && v.title && (
          <>
            {v.facts.length > 0 && (
              <div className="bw__facts">
                {v.facts.map((f, i) => (
                  <span key={i} className={cx('bw__fact', i === 0 && 'bw__fact--lead')}>
                    {f}
                  </span>
                ))}
              </div>
            )}
            <div className="bw__stats">
              {v.stats.map((s) => (
                <Tooltip key={s.label} content={s.hint} disabled={!s.hint} side="bottom">
                  <div className={cx('bw__stat', s.hint && 'bw__stat--hint')}>
                    <div className="bw__stat-label">{s.label}</div>
                    <div className="bw__stat-value">{s.value}</div>
                  </div>
                </Tooltip>
              ))}
            </div>
            {v.source && (
              <div className="bw__source">
                <span className="bw__source-label">Plays from</span>
                {v.source.badge && <SourceBadge source={v.source.badge} title={formatHint(v.source.badge)} />}
                <span className="bw__source-provider">{v.source.provider}</span>
                {v.source.extra && (
                  <span className="bw__source-extra" title={v.source.hint}>
                    {v.source.extra}
                  </span>
                )}
              </div>
            )}
            {v.albums && v.albums.length > 0 && (
              <div className="bw__albums">
                <div className="bw__albums-head">
                  {plural(v.albumsTotal ?? v.albums.length, 'album')}
                  {v.albums.some((a) => a.totalMs) && <> · {listPartial(v.albums, v.albumsTotal) ? formatSum({ total: msSum(v.albums)!.total, partial: true }, formatTime) : sumMs(v.albums)}</>}
                </div>
                {v.albums.slice(0, 5).map((a) => (
                  <div key={a.id} className={cx('bw__album', a.id === v.albumId && 'bw__album--on')}>
                    <span className={`bc-kind bc-kind--${a.kind}`} title={KIND_HINT[a.kind]}>
                      {KIND_LABEL[a.kind]}
                    </span>
                    <span className="bw__album-title g-ellipsis">{preferOrig ? (a.titleOriginal ?? a.title) : a.title}</span>
                    <span className="bw__album-meta tnum">{albumMeta(a)}</span>
                  </div>
                ))}
                {(v.albumsTotal ?? v.albums.length) > 5 && <div className="bw__albums-more">+{((v.albumsTotal ?? v.albums.length) - 5).toLocaleString()} more</div>}
              </div>
            )}
          </>
        )}
      </Swap>
    </Wedge>
  )
}
