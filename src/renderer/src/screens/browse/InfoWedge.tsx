// The lazer-style info wedge (left): big cover over the hero art, title (original/romanised),
// credits, stats for the selection, which source will play, and the group's album list.
// Content changes cross-slide (old layer slides out while the new one slides in).
import { AudioLines, Disc3, Gamepad2, SearchX } from 'lucide-react'
import { useMemo, useReducer, useRef, type ReactNode } from 'react'
import { parseSearch } from '@shared/search'
import type { Album, SourceSummary } from '@shared/types'
import { artUrl } from '../../lib/art'
import { usePlayer } from '../../state/player'
import { useSettings } from '../../state/settings'
import { CoverArt } from '../../ui/CoverArt'
import { IntensityBadge, SourceBadge } from '../../ui/Badges'
import { formatSum, formatTime, sumKnown } from '../../ui/format'
import { GhostMark } from '../../ui/GhostMark'

import { LoadingRing } from '../../ui/LoadingRing'
import { Wedge } from '../../ui/Panel'
import { cx } from '../../ui/util'
import { previewAlbumId } from './actions'
import { browseModel } from './model'
import { KIND_LABEL, plural } from './panels'
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
  wide?: boolean
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
  source: { badge: SourceSummary | Album['formats'][number] | null; provider: string; extra: string | null } | null
  albums: Album[] | null
  albumId: string | null
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)]
/** Totals over albums whose counts/lengths may be unknown (not yet crawled): "–", never 0. */
const sumMs = (as: Album[]) => formatSum(sumKnown(as.map((a) => a.totalMs || null)), formatTime)
const sumTracks = (as: Album[]) => formatSum(sumKnown(as.map((a) => a.trackCount)), (n) => n.toLocaleString())
/** An album row's "tracks · length", leaving out what isn't known. */
const albumMeta = (a: Album) => [a.trackCount != null ? String(a.trackCount) : null, a.totalMs ? formatTime(a.totalMs) : null].filter(Boolean).join(' · ')

function yearSpan(years: (number | null)[]): string | null {
  const ys = years.filter((y): y is number => !!y)
  if (!ys.length) return null
  const a = Math.min(...ys)
  const b = Math.max(...ys)
  return a === b ? String(a) : `${a}–${String(b).slice(-2)}`
}

function describe(sel: SelInfo, preferOrig: boolean): View {
  const g = sel.group
  const albums = sel.albums
  const pick = (title: string, original: string | null) => {
    if (!original || original === title) return { title, alt: null }
    return preferOrig ? { title: original, alt: title } : { title, alt: original }
  }

  if (sel.track) {
    const t = sel.track
    const d = sel.detail
    const { title, alt } = pick(t.title, t.titleOriginal)
    const a = t.analysis
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
        { label: 'BPM', value: <span className="tnum">{a?.bpm ? Math.round(a.bpm) : '–'}</span> },
        { label: 'Intensity', value: <IntensityBadge value={a?.intensity ?? null} size="lg" glow /> },
        {
          label: 'Loudness',
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
            extra: [t.source.bitrateKbps ? `${Math.round(t.source.bitrateKbps)} kbps` : null, t.source.confidence < 0.995 ? `${Math.round(t.source.confidence * 100)}% match` : null].filter(Boolean).join(' · ') || null
          }
        : { badge: null, provider: 'Resolved when played', extra: null },
      albums,
      albumId: t.albumId
    }
  }

  if (sel.album) {
    const al = sel.album
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
        { label: 'Tracks', value: <span className="tnum">{al.trackCount ?? d?.tracks.length ?? '–'}</span> },
        { label: 'Length', value: <span className="tnum">{al.totalMs ? formatTime(al.totalMs) : '–'}</span> },
        { label: 'Peak', value: d ? <IntensityBadge value={peak >= 0 ? peak : null} size="lg" glow /> : <LoadingRing size={18} /> },
        { label: 'Discs', value: <span className="tnum">{d ? Math.max(1, ...d.tracks.map((t) => t.disc)) : '–'}</span> }
      ],
      source: { badge: preferredFormat(al.formats), provider: providerName(al.provider), extra: al.formats.length ? uniq(al.formats.map((f) => f.toUpperCase())).join(' · ') : null },
      albums,
      albumId: al.id
    }
  }

  // a group (game or bucket)
  if (!g) {
    return { kicker: 'Loading', title: '', alt: null, line: null, facts: [], cover: null, hero: null, accent: null, stats: [], source: null, albums: null, albumId: null }
  }
  const orig = g.kind === 'game' ? browseModel.originalTitle(g.gameId, g.title) : null
  const { title, alt } = pick(g.title, orig)
  const game = g.gameId ? browseModel.game(g.gameId) : null
  const tracks = albums ? sumTracks(albums) : '–'
  const composers = albums ? uniq(albums.flatMap((a) => a.composers)).slice(0, 3) : []
  const stats: Stat[] =
    g.kind === 'game'
      ? [
          { label: 'Albums', value: <span className="tnum">{albums?.length ?? g.albumCount}</span> },
          { label: 'Tracks', value: <span className="tnum">{tracks}</span> },
          { label: 'Length', value: <span className="tnum">{albums ? sumMs(albums) : '–'}</span> },
          { label: 'Era', value: <span className="tnum">{(albums && yearSpan(albums.map((a) => a.year))) ?? g.year ?? '–'}</span> }
        ]
      : [
          { label: g.kind === 'album' ? 'Tracks' : 'Albums', value: <span className="tnum">{g.albumCount}</span> },
          { label: 'Games', value: <span className="tnum">{albums ? uniq(albums.map((a) => a.gameName ?? a.title)).length : '–'}</span> },
          { label: 'Tracks', value: <span className="tnum">{tracks}</span> },
          { label: 'Length', value: <span className="tnum">{albums ? sumMs(albums) : '–'}</span> }
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
    source: providers.length ? { badge: preferredFormat(formats), provider: providers.map(providerName).join(', '), extra: formats.length ? formats.map((f) => f.toUpperCase()).join(' · ') : null } : null,
    albums,
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

export function InfoWedge() {
  const sel = useBrowse((s) => s.sel)
  const total = useBrowse((s) => s.total)
  const loading = useBrowse((s) => s.loading)
  const text = useBrowse((s) => s.text) && browseModel.query.text
  const preferOrig = useSettings((s) => s.interface.preferOriginalTitles)
  const preview = usePlayer((s) => s.preview)
  const v = useMemo(() => (sel ? describe(sel, preferOrig) : null), [sel, preferOrig])

  // only read while showing "no matches": catalog:status arrives several times a second while
  // indexing, and the game count re-rendered the whole wedge each time
  const catalogGames = useBrowse((s) => (!s.sel && !s.loading && s.total === 0 ? (s.status?.games ?? null) : null))
  const noMatch = !sel && !loading && total === 0 && !!text
  const hasFilters = useMemo(() => (noMatch ? parseSearch(text).filters.length > 0 : false), [noMatch, text])

  const previewing = !!(preview && sel && (sel.track ? preview.track.id === sel.track.id : preview.track.albumId === previewAlbumId(sel)))
  const hero = artUrl(v?.hero ?? v?.cover ?? null, { w: 720 })

  return (
    <Wedge side="left" className="bw" glow>
      <div className="bw__hero">
        {hero && <div key={hero} className="bw__hero-art" style={{ backgroundImage: `url("${hero}")` }} />}
        <div className="bw__hero-shade" />
        <div className="bw__cover">
          <CoverArt src={v?.cover ?? null} size="100%" w={188} radius={12} hue={v?.accent ?? undefined} />
          {previewing && (
            <div className="bw__previewing" title={`Previewing ${preview!.track.title}`}>
              <AudioLines />
              Preview
            </div>
          )}
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
              {v.alt && <div className="bw__alt g-jp">{v.alt}</div>}
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
              <div>{loading || total == null ? 'Loading the catalog…' : 'Your catalog is empty'}</div>
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
                <div key={s.label} className="bw__stat">
                  <div className="bw__stat-label">{s.label}</div>
                  <div className="bw__stat-value">{s.value}</div>
                </div>
              ))}
            </div>
            {v.source && (
              <div className="bw__source">
                <span className="bw__source-label">Plays from</span>
                {v.source.badge && <SourceBadge source={v.source.badge} />}
                <span className="bw__source-provider">{v.source.provider}</span>
                {v.source.extra && <span className="bw__source-extra">{v.source.extra}</span>}
              </div>
            )}
            {v.albums && v.albums.length > 0 && (
              <div className="bw__albums">
                <div className="bw__albums-head">
                  {plural(v.albums.length, 'album')}
                  {v.albums.some((a) => a.totalMs) && <> · {sumMs(v.albums)}</>}
                </div>
                {v.albums.slice(0, 5).map((a) => (
                  <div key={a.id} className={cx('bw__album', a.id === v.albumId && 'bw__album--on')}>
                    <span className={`bc-kind bc-kind--${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                    <span className="bw__album-title g-ellipsis">{preferOrig ? (a.titleOriginal ?? a.title) : a.title}</span>
                    <span className="bw__album-meta tnum">{albumMeta(a)}</span>
                  </div>
                ))}
                {v.albums.length > 5 && <div className="bw__albums-more">+{v.albums.length - 5} more</div>}
              </div>
            )}
          </>
        )}
      </Swap>
    </Wedge>
  )
}
