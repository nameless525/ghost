// Playlists tab: a grid of mosaic cards (hover lift, pop-in play button, smart badge), "New
// playlist" (manual or smart), and the playlist detail view with a shared-element transition
// from the card's mosaic.
import { ListMusic, ListPlus, Play, Sparkles } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react'
import type { Playlist } from '@shared/types'
import { initPlaylistCache, usePlaylistCache } from '../../lib/track-actions'
import { stagger, tween } from '../../motion/tween'
import { useKeybinding } from '../../shell/keys'
import { sfx } from '../../sound'
import { Button } from '../../ui/Button'
import { ContextMenu } from '../../ui/ContextMenu'
import { LoadingRing } from '../../ui/LoadingRing'
import { ScrollArea } from '../../ui/ScrollArea'
import { SearchInput } from '../../ui/SearchInput'
import { Select } from '../../ui/Select'
import { cx, uiZoom } from '../../ui/util'
import { playlistActions, playlistMenuItems } from './actions'
import { EmptyState, formatLong, leavingStyle, plural, useAnimatedList } from './common'
import { Mosaic } from './Mosaic'
import { NewPlaylistDialog, type PlaylistKind } from './NewPlaylistDialog'
import { PlaylistDetailView } from './PlaylistDetail'

type SortKey = 'recent' | 'name' | 'tracks' | 'length'

export interface PlaylistsTabProps {
  /** Tab visible and overlay open. */
  active: boolean
  /** Bumped when the tab is (re)entered, to replay the card entrance. */
  enterSeq: number
}

interface DetailState {
  playlist: Playlist
  /** Card mosaic rect to fly from. */
  from: DOMRect | null
}

export function PlaylistsTab({ active, enterSeq }: PlaylistsTabProps) {
  const playlists = usePlaylistCache((s) => s.playlists)
  const loaded = usePlaylistCache((s) => s.loaded)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [newKind, setNewKind] = useState<PlaylistKind | null>(null)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortKey>('recent')
  const grid = useRef<HTMLDivElement>(null)
  const arts = useRef(new Map<string, HTMLDivElement>())
  const landing = useRef<{ id: string; from: DOMRect } | null>(null)

  useEffect(() => initPlaylistCache(), [])

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const list = f ? playlists.filter((p) => p.name.toLowerCase().includes(f) || p.description?.toLowerCase().includes(f) || p.query?.toLowerCase().includes(f)) : [...playlists]
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'tracks') list.sort((a, b) => b.trackCount - a.trackCount)
    else if (sort === 'length') list.sort((a, b) => b.durationMs - a.durationMs)
    else list.sort((a, b) => b.updatedAt - a.updatedAt)
    return list
  }, [playlists, filter, sort])

  const entries = useMemo(() => shown.map((p) => ({ key: p.id, data: p })), [shown])
  const cards = useAnimatedList(grid, entries, { enter: 'pop', exitMs: 280 })

  // keep the open detail in sync with the cache (rename etc.); close it if the playlist is gone
  useEffect(() => {
    if (!detail || !loaded) return
    const p = playlists.find((x) => x.id === detail.playlist.id)
    if (!p) setDetail(null)
    else if (p !== detail.playlist) setDetail((d) => (d ? { ...d, playlist: p } : d))
  }, [playlists, loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // card entrance when the tab is entered / data first arrives
  const didIntro = useRef(false)
  useLayoutEffect(() => {
    if (!active || detail || !grid.current || !shown.length) return
    if (didIntro.current && enterSeq === 0) return
    didIntro.current = true
    const els = Array.from(grid.current.querySelectorAll<HTMLElement>('[data-flip]')).slice(0, 18)
    // x: 0 too: clear() keeps the current values, and a FLIP from the same commit may have left an x offset
    void stagger(els, (t) => t.clear().set({ opacity: 0, x: 0, y: 26, scale: 0.94 }).fadeIn(260, 'outQuad').moveToY(0, 620, 'outQuint').scaleTo(1, 620, 'outQuint'), 28)
  }, [active, enterSeq, loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = (p: Playlist) => {
    const art = arts.current.get(p.id)
    sfx.play('expand', { volume: 0.8 })
    setDetail({ playlist: p, from: art ? art.getBoundingClientRect() : null })
  }

  const back = (fromRect: DOMRect | null) => {
    if (!detail) return
    sfx.play('collapse', { volume: 0.8 })
    if (fromRect) landing.current = { id: detail.playlist.id, from: fromRect }
    setDetail(null)
  }

  // the card's mosaic flies back from the detail header
  useLayoutEffect(() => {
    if (detail || !landing.current) return
    const { id, from } = landing.current
    landing.current = null
    const art = arts.current.get(id)
    if (!art) return
    const card = art.closest<HTMLElement>('.lib-card')
    card?.scrollIntoView({ block: 'nearest' })
    const to = art.getBoundingClientRect()
    if (!to.width) return
    const z = uiZoom()
    art.style.transformOrigin = '0 0'
    art.style.zIndex = '5'
    void tween(art)
      .clear()
      .set({ x: (from.left - to.left) / z, y: (from.top - to.top) / z, scale: from.width / to.width })
      .moveTo(0, 0, 560, 'outQuint')
      .scaleTo(1, 560, 'outQuint')
      .then(() => (art.style.zIndex = ''))
    const others = Array.from(grid.current?.querySelectorAll<HTMLElement>('[data-flip]') ?? []).filter((el) => !el.contains(art)).slice(0, 18)
    void stagger(others, (t) => t.clear().set({ opacity: 0, x: 0, y: 14 }).fadeIn(240, 'outQuad').moveToY(0, 520, 'outQuint'), 18, { delay: 60 })
  }, [detail])

  useKeybinding('Escape', () => (detail ? back(null) : false), { priority: 5, when: () => active && !!detail })
  useKeybinding('Backspace', () => (detail ? back(null) : false), { priority: 5, when: () => active && !!detail })
  useKeybinding('Mod+N', () => setNewKind('manual'), { when: () => active })

  const onCardKey = (e: RKeyboardEvent, p: Playlist) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open(p)
    }
  }

  return (
    <div className="lib-pl">
      <div className={cx('lib-pl__grid-view', detail && 'lib-pl__grid-view--hidden')} aria-hidden={!!detail || undefined} inert={!!detail || undefined}>
        <div className="lib-toolbar" hidden={loaded && !playlists.length}>
          <Button variant="primary" hue="library" icon={<ListPlus />} shortcut="Mod+N" onClick={() => setNewKind('manual')}>
            New playlist
          </Button>
          <Button variant="soft" hue="settings" icon={<Sparkles />} aria-label="New smart playlist" tooltip="Smart playlist: a saved search that fills itself and stays up to date" onClick={() => setNewKind('smart')}>
            <span className="lib-narrow-hide">Smart playlist</span>
          </Button>
          <div className="lib-toolbar__spacer" />
          {playlists.length > 5 && <SearchInput value={filter} onChange={setFilter} placeholder="Filter" className="lib-toolbar__search" />}
          {playlists.length > 1 && (
            <Select<SortKey>
              value={sort}
              onChange={setSort}
              prefix="sort:"
              width={150}
              hue="library"
              aria-label="Sort playlists"
              options={[
                { value: 'recent', label: 'Recent' },
                { value: 'name', label: 'Name' },
                { value: 'tracks', label: 'Tracks' },
                { value: 'length', label: 'Length' }
              ]}
            />
          )}
        </div>
        <ScrollArea className="lib-scroll">
          {!loaded ? (
            <LoadingRing center />
          ) : !playlists.length ? (
            <EmptyState
              icon={<ListMusic />}
              title="No playlists yet"
              body="Collect your favourite tracks into playlists, or save a search as a smart playlist that keeps itself up to date."
              actions={
                <>
                  <Button variant="primary" hue="library" icon={<ListPlus />} onClick={() => setNewKind('manual')}>
                    New playlist
                  </Button>
                  <Button variant="soft" hue="settings" icon={<Sparkles />} onClick={() => setNewKind('smart')}>
                    Smart playlist
                  </Button>
                </>
              }
            />
          ) : !shown.length ? (
            <EmptyState compact title="No matches" body={`No playlist matches “${filter}”.`} actions={<Button variant="ghost" onClick={() => setFilter('')}>Clear filter</Button>} />
          ) : null}
          <div ref={grid} className="lib-grid" hidden={!loaded || !shown.length}>
            {cards.map(({ key, data: p, leaving, box }) => (
              <div key={key} className="lib-card-wrap" data-flip={key} data-leaving={leaving || undefined} style={leaving ? leavingStyle(box) : undefined}>
                <PlaylistCard
                  p={p}
                  onOpen={() => open(p)}
                  onKeyDown={(e) => onCardKey(e, p)}
                  artRef={(el) => {
                    if (!el || leaving) return
                    arts.current.set(p.id, el)
                    // ref cleanup (React 19): the old null-call ran while the node was still connected, so deleted playlists stayed in the map
                    return () => {
                      if (arts.current.get(p.id) === el) arts.current.delete(p.id)
                    }
                  }}
                />
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
      {detail && (
        <PlaylistDetailView
          key={detail.playlist.id}
          initial={detail.playlist}
          from={detail.from}
          active={active}
          onBack={back}
          onOpenPlaylist={(p) => setDetail({ playlist: p, from: null })}
        />
      )}
      <NewPlaylistDialog
        open={newKind !== null}
        kind={newKind ?? 'manual'}
        onClose={() => setNewKind(null)}
        onCreated={(p) => {
          setNewKind(null)
          setDetail({ playlist: p, from: null })
        }}
      />
    </div>
  )
}

interface CardProps {
  p: Playlist
  onOpen: () => void
  onKeyDown: (e: RKeyboardEvent) => void
  artRef: (el: HTMLDivElement | null) => void | (() => void)
}

function PlaylistCard({ p, onOpen, onKeyDown, artRef }: CardProps) {
  const smart = p.kind === 'smart'
  return (
    <ContextMenu items={() => playlistMenuItems(p, { onOpen })}>
      <div
        className={cx('lib-card', smart && 'lib-card--smart')}
        role="button"
        tabIndex={0}
        aria-label={`${p.name}, ${plural(p.trackCount, 'track')}`}
        onClick={onOpen}
        onKeyDown={onKeyDown}
        onPointerEnter={() => sfx.play('hover')}
      >
        <div className="lib-card__art">
          <Mosaic ref={artRef} covers={p.covers} size="100%" smart={smart} radius={12} />
          <div className="lib-card__shade" />
          {p.trackCount > 0 && (
            <button
              type="button"
              className="lib-card__play"
              aria-label={`Play ${p.name}`}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation()
                sfx.play('confirm')
                void playlistActions.play(p)
              }}
            >
              <Play />
            </button>
          )}
          {smart && (
            <span className="lib-card__badge">
              <Sparkles /> Smart
            </span>
          )}
        </div>
        <div className="lib-card__name g-ellipsis" title={p.name}>
          {p.name}
        </div>
        <div className="lib-card__meta tnum">
          {plural(p.trackCount, 'track')}
          {p.durationMs > 0 && <> · {formatLong(p.durationMs)}</>}
        </div>
      </div>
    </ContextMenu>
  )
}
