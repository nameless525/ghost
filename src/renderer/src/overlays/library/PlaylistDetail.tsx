// Playlist detail: hero header (big mosaic flown in from the card, inline rename, description,
// counts, actions), the smart query editor, and the virtualised, reorderable track list.
import { ChevronLeft, Compass, Copy, Download, FileOutput, ListMusic, Pencil, Play, Shuffle, Sparkles, Trash, Undo2 } from 'lucide-react'
import { arrayMove } from '@dnd-kit/sortable'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parseSearch } from '@shared/search'
import type { Playlist, PlaylistDetail } from '@shared/types'
import { ghost } from '../../ghost'
import { stagger, tween } from '../../motion/tween'
import { navigate } from '../../shell/navigation'
import { notify } from '../../shell/notifications'
import { sfx } from '../../sound'
import { useUI } from '../../state/ui'
import { isMac } from '../../theme'
import { Button } from '../../ui/Button'
import { ContextMenu } from '../../ui/ContextMenu'
import { IconButton } from '../../ui/IconButton'
import { LoadingRing } from '../../ui/LoadingRing'
import { ScrollArea } from '../../ui/ScrollArea'
import { uiZoom } from '../../ui/util'
import { artUrl } from '../../lib/art'
import { playlistActions, playlistMenuItems } from './actions'
import { formatSum, sumKnown } from '../../ui/format'
import { EmptyState, formatLong, plural, relativeTime, useLive } from './common'
import { InlineEdit } from './InlineEdit'
import { Mosaic } from './Mosaic'
import { QueryField, QueryText } from './query'
import { showSnack } from './Snack'
import { TrackList, type TrackListItem } from './TrackList'

export interface PlaylistDetailViewProps {
  initial: Playlist
  from: DOMRect | null
  active: boolean
  /** Close the detail; passes the header mosaic rect for the return flight. */
  onBack: (mosaicRect: DOMRect | null) => void
  onOpenPlaylist: (p: Playlist) => void
}

export function PlaylistDetailView({ initial, from, active, onBack, onOpenPlaylist }: PlaylistDetailViewProps) {
  const id = initial.id
  const live = useLive<PlaylistDetail>(() => ghost().library.playlists.get(id), ['playlists', 'likes', 'downloaded'], active, (e) => e.kind !== 'playlists' || !e.id || e.id === id)
  const [items, setItems] = useState<TrackListItem[] | null>(null)
  const p = live.data?.playlist ?? initial
  const smart = p.kind === 'smart'
  const root = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const mosaic = useRef<HTMLDivElement>(null)
  const hero = useRef<HTMLDivElement>(null)

  // optimistic edits in flight: a reload that lands mid-way would briefly undo them
  const inFlight = useRef(0)
  useEffect(() => {
    if (live.data && !inFlight.current) setItems(live.data.items.map((i) => ({ key: i.uid, track: i.track })))
  }, [live.data])
  const track = <T,>(p: Promise<T>): Promise<T> => {
    inFlight.current++
    return p.finally(() => {
      if (--inFlight.current === 0) live.reload()
    })
  }

  // gone (deleted elsewhere)
  useEffect(() => {
    if (live.error) onBack(null)
  }, [live.error]) // eslint-disable-line react-hooks/exhaustive-deps

  // shared-element entrance: the mosaic flies from the card, the rest staggers in
  useLayoutEffect(() => {
    const m = mosaic.current
    if (m && from) {
      const to = m.getBoundingClientRect()
      const z = uiZoom()
      m.style.transformOrigin = '0 0'
      tween(m)
        .clear()
        .set({ x: (from.left - to.left) / z, y: (from.top - to.top) / z, scale: from.width / to.width })
        .moveTo(0, 0, 620, 'outQuint')
        .scaleTo(1, 620, 'outQuint')
    } else if (m) {
      tween(m).clear().set({ opacity: 0, scale: 0.9 }).fadeIn(240, 'outQuad').scaleTo(1, 700, 'outElasticHalf')
    }
    const bits = hero.current?.querySelectorAll<HTMLElement>('[data-stagger]')
    if (bits) void stagger(bits, (t) => t.clear().set({ opacity: 0, x: 26 }).fadeIn(280, 'outQuad').moveToX(0, 560, 'outQuint'), 40, { delay: from ? 90 : 30 })
    const back = root.current?.querySelector<HTMLElement>('.lib-detail__backdrop')
    if (back) tween(back).clear().set({ opacity: 0 }).fadeIn(700, 'outQuad')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const goBack = () => onBack(mosaic.current?.getBoundingClientRect() ?? null)

  // ---- mutations -------------------------------------------------------------------------
  const rename = (name: string) => ghost().library.playlists.update(id, { name })
  const describe = (d: string) => ghost().library.playlists.update(id, { description: d || null })
  const move = (fromIdx: number, toIdx: number) => {
    setItems((list) => (list ? arrayMove(list, fromIdx, toIdx) : list))
    void track(ghost().library.playlists.moveItem(id, fromIdx, toIdx)).catch((err) => {
      notify({ kind: 'error', title: 'Could not reorder', body: String(err?.message ?? err) })
      live.reload()
    })
  }
  const remove = (keys: string[]) => {
    const set = new Set(keys)
    const removed = (items ?? []).map((it, index) => ({ it, index })).filter(({ it }) => set.has(it.key))
    setItems((list) => (list ? list.filter((i) => !set.has(i.key)) : list))
    void track(ghost().library.playlists.removeItems(id, keys))
      .then(() =>
        showSnack({
          host: 'library',
          icon: <Trash />,
          title: removed.length === 1 ? `Removed “${removed[0].it.track.title}”` : `Removed ${plural(removed.length, 'track')}`,
          body: `from ${p.name}`,
          action: {
            label: 'Undo',
            icon: <Undo2 />,
            onClick: () =>
              void (async () => {
                // re-insert at the original positions, lowest first, so every index is valid again
                for (const r of removed) await ghost().library.playlists.addTracks(id, [r.it.track.id], r.index)
              })()
          }
        })
      )
      .catch(() => live.reload())
  }

  const n = items?.length ?? p.trackCount
  // unknown track lengths stay unknown (no "0 min"); a partly-known total reads "42 min+"
  const totalMs = useMemo(() => (items ? sumKnown(items.map((i) => i.track.durationMs || null)) : p.durationMs ? { total: p.durationMs, partial: false } : null), [items, p.durationMs])
  const ctx = useMemo(() => ({ kind: 'playlist' as const, id, title: p.name }), [id, p.name])
  // heavily blurred and faint: a small copy is indistinguishable
  const backdrop = artUrl(p.covers[0] ?? null, { w: 160 })

  return (
    <div ref={root} className="lib-detail">
      <ScrollArea viewportRef={scroll} className="lib-scroll lib-detail__scroll" fade={false}>
        <div ref={hero} className="lib-detail__hero">
          {backdrop && <div className="lib-detail__backdrop" style={{ backgroundImage: `url("${backdrop}")` }} />}
          <div className="lib-detail__topbar" data-stagger>
            <button type="button" className="lib-back" onClick={goBack} onPointerEnter={() => sfx.play('hover')}>
              <ChevronLeft />
              Playlists
            </button>
          </div>
          <div className="lib-detail__main">
            <ContextMenu items={() => playlistMenuItems(p, { onDeleted: () => onBack(null), onDuplicated: onOpenPlaylist })}>
              <div className="lib-detail__art">
                <Mosaic ref={mosaic} covers={p.covers} size={172} radius={14} smart={smart} />
              </div>
            </ContextMenu>
            <div className="lib-detail__info">
              <div className="lib-detail__kind" data-stagger>
                {smart ? (
                  <>
                    <Sparkles /> Smart playlist
                  </>
                ) : (
                  <>
                    <ListMusic /> Playlist
                  </>
                )}
              </div>
              <div data-stagger>
                <InlineEdit className="lib-detail__name" value={p.name} onCommit={rename} aria-label="Playlist name" maxLength={120} />
              </div>
              <div data-stagger>
                <InlineEdit
                  className="lib-detail__desc"
                  value={p.description ?? ''}
                  placeholder="Add a description"
                  allowEmpty
                  multiline
                  maxLength={300}
                  onCommit={describe}
                  aria-label="Description"
                />
              </div>
              <div className="lib-detail__meta tnum" data-stagger>
                <b>{plural(n, 'track')}</b>
                {totalMs && (
                  <>
                    <span className="lib-dot" />
                    {formatSum(totalMs, formatLong)}
                  </>
                )}
                <span className="lib-dot" />
                updated {relativeTime(p.updatedAt)}
              </div>
            </div>
          </div>
          <div className="lib-detail__actions" data-stagger>
            <Button variant="primary" hue="library" icon={<Play />} disabled={!n} sound="confirm" onClick={() => void playlistActions.play(p)}>
              Play
            </Button>
            <Button variant="secondary" icon={<Shuffle />} disabled={!n} sound="confirm" onClick={() => void playlistActions.shuffle({ ...p, trackCount: n })}>
              Shuffle
            </Button>
            <div className="lib-detail__sep" />
            <IconButton icon={<Download />} label="Download all" disabled={!n} onClick={() => void playlistActions.download({ ...p, trackCount: n })} />
            <IconButton icon={<FileOutput />} label="Export M3U" onClick={() => void playlistActions.exportM3U(p)} />
            <IconButton icon={<Copy />} label="Duplicate" onClick={() => void playlistActions.duplicate(p).then(onOpenPlaylist)} />
            <IconButton icon={<Trash />} label="Delete playlist" className="lib-danger" onClick={() => void playlistActions.remove({ ...p, trackCount: n }).then((ok) => ok && onBack(null))} />
          </div>
        </div>

        {smart && <SmartQuery query={p.query ?? ''} onSave={(q) => ghost().library.playlists.update(id, { query: q })} />}

        {items === null ? (
          <div className="lib-detail__loading">
            <LoadingRing />
          </div>
        ) : items.length === 0 ? (
          smart ? (
            <EmptyState
              compact
              icon={<Sparkles />}
              title="Nothing matches yet"
              body="No track in your catalog matches this query right now. Loosen it a little, or let the catalog finish indexing."
            />
          ) : (
            <EmptyState
              compact
              icon={<ListMusic />}
              title="This playlist is empty"
              body={`Right-click any track in Browse and choose Add to playlist, or select it and press ${isMac ? '⌘S' : 'Ctrl+S'}.`}
              actions={
                <Button
                  variant="soft"
                  hue="browse"
                  icon={<Compass />}
                  onClick={() => {
                    useUI.getState().toggleOverlay('library', false)
                    navigate('browse')
                  }}
                >
                  Find music in Browse
                </Button>
              }
            />
          )
        ) : (
          <TrackList
            items={items}
            scrollRef={scroll}
            context={ctx}
            sortable={!smart}
            onMove={move}
            onRemove={smart ? undefined : remove}
            onPlay={(i) => {
              void ghost().player.playPlaylist(id, i)
            }}
          />
        )}
        {smart && items && items.length > 0 && <div className="lib-detail__note">Smart playlists are ordered by the query. Duplicate it to get a hand-sortable copy.</div>}
      </ScrollArea>
    </div>
  )
}

function SmartQuery({ query, onSave }: { query: string; onSave: (q: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(query)
  const [saving, setSaving] = useState(false)
  const parsed = useMemo(() => parseSearch(draft), [draft])
  const invalid = parsed.empty || parsed.errors.length > 0

  useEffect(() => {
    if (!editing) setDraft(query)
  }, [query, editing])

  const save = async () => {
    if (invalid) {
      sfx.play('error', { volume: 0.6 })
      return
    }
    setSaving(true)
    try {
      if (draft.trim() !== query) await onSave(draft.trim())
      sfx.play('confirm', { volume: 0.7 })
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={`lib-smart${editing ? ' lib-smart--editing' : ''}`}>
      <div className="lib-smart__head">
        <Sparkles />
        <span className="lib-smart__label">Saved search</span>
        {!editing && (
          <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(true)}>
            Edit query
          </Button>
        )}
      </div>
      {editing ? (
        <div className="lib-smart__edit">
          <QueryField
            value={draft}
            onChange={setDraft}
            autoFocus
            onSubmit={() => void save()}
            onEscape={() => {
              sfx.play('back', { volume: 0.6 })
              setDraft(query)
              setEditing(false)
            }}
          />
          <div className="lib-smart__btns">
            <Button
              size="sm"
              variant="ghost"
              sound="back"
              onClick={() => {
                setDraft(query)
                setEditing(false)
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" hue="library" sound={false} disabled={invalid} loading={saving} onClick={() => void save()}>
              Save query
            </Button>
          </div>
        </div>
      ) : (
        <button type="button" className="lib-smart__query" onClick={() => setEditing(true)} title="Click to edit">
          <QueryText query={query || '—'} />
        </button>
      )}
    </div>
  )
}
