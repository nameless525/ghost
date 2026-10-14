// The Library track list: virtualised (fixed row height, absolute rows), drag-to-reorder with
// @dnd-kit/sortable, multi-select (click, Shift-click ranges, Mod-click toggles, keyboard),
// context menus from lib/track-actions, and animated inserts / removals.
//
//   <TrackList items={[{ key, track }]} scrollRef={viewport} context={…} onPlay={(i) => …}
//              sortable onMove={(from, to) => …} onRemove={(keys) => …} />
import {
  closestCenter,
  DndContext,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CircleCheck, Clock, Download, GripVertical, Heart, Star, Trash } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent, type ReactNode, type RefObject } from 'react'
import type { PlayContext, TrackView } from '@shared/types'
import { trackActions, trackMenuItems, tracksMenuItems } from '../../lib/track-actions'
import { tween } from '../../motion/tween'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { isMac } from '../../theme'
import { IntensityBadge } from '../../ui/Badges'
import { openContextMenu, type MenuItem } from '../../ui/ContextMenu'
import { CoverArt } from '../../ui/CoverArt'
import { formatTime } from '../../ui/format'
import { cx, useEvent } from '../../ui/util'

export const ROW_H = 54

export interface TrackListItem {
  /** Stable, unique per row (playlist item uid, or the track id). */
  key: string
  track: TrackView
}

export interface TrackListProps {
  items: TrackListItem[]
  /** The scrolling ancestor (ScrollArea viewport); rows are virtualised against it. */
  scrollRef: RefObject<HTMLElement | null>
  context: PlayContext
  /** Double-click / Enter. */
  onPlay: (index: number) => void
  sortable?: boolean
  onMove?: (from: number, to: number) => void
  /** Enables Delete/Backspace and a "Remove" menu item. */
  onRemove?: (keys: string[]) => void
  removeLabel?: string
  /** Extra menu items for one row (appended after the standard ones). */
  menuExtra?: (item: TrackListItem, index: number) => MenuItem[]
  /** Extra trailing cell per row (e.g. a Reveal button). */
  rowExtra?: (item: TrackListItem) => ReactNode
  /** Called after the user toggles a heart in the list. */
  onLikeChange?: (track: TrackView, liked: boolean) => void
  /** Sticky top offset of the column header (px). */
  stickyTop?: number
  className?: string
}

const lockToY: Modifier = ({ transform }) => ({ ...transform, x: 0 })
const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey)

function offsetWithin(el: HTMLElement, ancestor: HTMLElement): number {
  let y = 0
  let n: HTMLElement | null = el
  while (n && n !== ancestor) {
    y += n.offsetTop
    n = n.offsetParent as HTMLElement | null
  }
  return y
}

interface Gone {
  item: TrackListItem
  index: number
  at: number
}
interface Snap {
  items: TrackListItem[]
  exiting: Map<string, Gone>
  entering: Set<string>
  intro: boolean
}

export function TrackList({ items, scrollRef, context, onPlay, sortable = false, onMove, onRemove, removeLabel = 'Remove from playlist', menuExtra, rowExtra, onLikeChange, stickyTop = 0, className }: TrackListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState<[number, number]>([0, Math.min(items.length, 24)])
  const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set())
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [likes, setLikes] = useState<Record<string, boolean>>({})
  const anchor = useRef<string | null>(null)
  const cursor = useRef<string | null>(null)

  // ---- derived enter / exit bookkeeping (no flash of removed rows) ----------------------
  const [snap, setSnap] = useState<Snap>(() => ({ items, exiting: new Map(), entering: new Set(), intro: items.length > 0 }))
  let view = snap
  if (snap.items !== items) {
    const cur = new Set(items.map((i) => i.key))
    const prev = new Set(snap.items.map((i) => i.key))
    const exiting = new Map(snap.exiting)
    const now = performance.now()
    snap.items.forEach((it, index) => {
      if (!cur.has(it.key)) exiting.set(it.key, { item: it, index, at: now })
    })
    for (const k of [...exiting.keys()]) if (cur.has(k)) exiting.delete(k)
    const entering = snap.items.length ? new Set(items.filter((i) => !prev.has(i.key)).map((i) => i.key)) : new Set<string>()
    view = { items, exiting, entering: entering.size ? entering : snap.entering, intro: snap.intro || (snap.items.length === 0 && items.length > 0) }
    setSnap(view)
  }
  useEffect(() => {
    if (!snap.exiting.size && !snap.entering.size && !snap.intro) return
    const t = window.setTimeout(() => setSnap((s) => ({ ...s, exiting: new Map(), entering: new Set(), intro: false })), snap.intro ? 900 : 320)
    return () => window.clearTimeout(t)
  }, [snap])

  // fresh data replaces optimistic like toggles; prune selection
  useEffect(() => {
    setLikes({})
    setSel((s) => {
      if (!s.size) return s
      const keys = new Set(items.map((i) => i.key))
      const next = new Set([...s].filter((k) => keys.has(k)))
      return next.size === s.size ? s : next
    })
  }, [items])

  const indexOf = useMemo(() => {
    const m = new Map<string, number>()
    items.forEach((it, i) => m.set(it.key, i))
    return m
  }, [items])

  // ---- virtualisation ------------------------------------------------------------------
  const count = items.length
  useLayoutEffect(() => {
    const sc = scrollRef.current
    const list = listRef.current
    if (!sc || !list) return
    const update = () => {
      const top = offsetWithin(list, sc)
      const vh = sc.clientHeight || 800
      const s = Math.max(0, Math.floor((sc.scrollTop - top) / ROW_H) - 6)
      const e = Math.min(count, Math.ceil((sc.scrollTop + vh - top) / ROW_H) + 6)
      // quantise so small scrolls don't re-render
      const qs = Math.max(0, Math.floor(s / 4) * 4)
      const qe = Math.min(count, Math.ceil(e / 4) * 4)
      setRange((r) => (r[0] === qs && r[1] === qe ? r : [qs, qe]))
    }
    update()
    sc.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(sc)
    return () => {
      sc.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [count, scrollRef])

  const scrollIntoView = (index: number) => {
    const sc = scrollRef.current
    const list = listRef.current
    if (!sc || !list) return
    const top = offsetWithin(list, sc) + index * ROW_H
    const head = stickyTop + 34
    if (top - head < sc.scrollTop) sc.scrollTop = top - head
    else if (top + ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + ROW_H - sc.clientHeight + 8
  }

  // ---- drag & drop -----------------------------------------------------------------------
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const keys = useMemo(() => items.map((i) => i.key), [items])

  const onDragStart = (e: DragStartEvent) => {
    setActiveKey(String(e.active.id))
    sfx.play('select', { volume: 0.6 })
  }
  const onDragEnd = (e: DragEndEvent) => {
    setActiveKey(null)
    const from = indexOf.get(String(e.active.id))
    const to = e.over ? indexOf.get(String(e.over.id)) : undefined
    if (from === undefined || to === undefined || from === to) return
    // rows jump to their new slots without the position transition (dnd-kit settles them)
    if (rootRef.current) rootRef.current.dataset.instant = 'true'
    sfx.play('confirm', { volume: 0.6 })
    onMove?.(from, to)
  }
  useLayoutEffect(() => {
    const r = rootRef.current
    if (r?.dataset.instant) {
      void r.offsetHeight
      delete r.dataset.instant
    }
  })

  // ---- selection & actions ----------------------------------------------------------------
  const selectedItems = () => items.filter((i) => sel.has(i.key))

  const api = useEvent((action: 'click' | 'dbl' | 'menu' | 'like', index: number, e?: RMouseEvent) => {
    const item = items[index]
    if (!item) return
    if (action === 'click' && e) {
      const mod = isMod(e)
      if (e.shiftKey) {
        const a = anchor.current ? (indexOf.get(anchor.current) ?? index) : index
        const [lo, hi] = a < index ? [a, index] : [index, a]
        const range = items.slice(lo, hi + 1).map((i) => i.key)
        setSel((prev) => (mod ? new Set([...prev, ...range]) : new Set(range)))
      } else if (mod) {
        setSel((prev) => {
          const n = new Set(prev)
          if (n.has(item.key)) n.delete(item.key)
          else n.add(item.key)
          return n
        })
        anchor.current = item.key
      } else {
        setSel(new Set([item.key]))
        anchor.current = item.key
      }
      cursor.current = item.key
      listRef.current?.focus({ preventScroll: true })
    } else if (action === 'dbl') {
      sfx.play('confirm', { volume: 0.7 })
      onPlay(index)
    } else if (action === 'menu' && e) {
      e.preventDefault()
      let selection = sel
      if (!sel.has(item.key)) {
        selection = new Set([item.key])
        setSel(selection)
        anchor.current = item.key
      }
      cursor.current = item.key
      const many = items.filter((i) => selection.has(i.key))
      const extra: MenuItem[] = []
      if (onRemove)
        extra.push({
          label: many.length > 1 ? `${removeLabel} (${many.length})` : removeLabel,
          icon: <Trash size={15} strokeWidth={2} />,
          shortcut: 'Delete',
          danger: true,
          onSelect: () => removeKeys(many.map((i) => i.key))
        })
      if (many.length <= 1 && menuExtra) extra.push(...menuExtra(item, index))
      const menu =
        many.length > 1
          ? tracksMenuItems(
              many.map((i) => i.track),
              { extra }
            )
          : trackMenuItems(withLike(item.track), { playList: { ids: items.map((i) => i.track.id), index, context }, extra })
      openContextMenu({ x: e.clientX, y: e.clientY }, menu)
    } else if (action === 'like') {
      toggleLike(item.track)
    }
  })

  const withLike = (t: TrackView): TrackView => (t.id in likes ? { ...t, liked: likes[t.id] } : t)

  const toggleLike = (t: TrackView) => {
    const next = !withLike(t).liked
    setLikes((m) => ({ ...m, [t.id]: next }))
    sfx.play(next ? 'toggleOn' : 'toggleOff', { volume: 0.8 })
    void trackActions.toggleLike(t.id).then((v) => {
      setLikes((m) => ({ ...m, [t.id]: v }))
      onLikeChange?.(t, v)
    })
  }

  const removeKeys = (ks: string[]) => {
    if (!onRemove || !ks.length) return
    const firstIdx = Math.min(...ks.map((k) => indexOf.get(k) ?? Infinity))
    const remaining = items.filter((i) => !ks.includes(i.key))
    const next = remaining[Math.min(firstIdx, remaining.length - 1)]
    setSel(next ? new Set([next.key]) : new Set())
    anchor.current = cursor.current = next?.key ?? null
    sfx.play('back', { volume: 0.7 })
    onRemove(ks)
  }

  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('button, input')) return
    const n = items.length
    if (!n) return
    const cur = cursor.current ? (indexOf.get(cursor.current) ?? -1) : -1
    const move = (to: number) => {
      const i = Math.max(0, Math.min(n - 1, to))
      const key = items[i].key
      if (e.shiftKey) {
        const a = anchor.current ? (indexOf.get(anchor.current) ?? i) : i
        const [lo, hi] = a < i ? [a, i] : [i, a]
        setSel(new Set(items.slice(lo, hi + 1).map((x) => x.key)))
      } else {
        setSel(new Set([key]))
        anchor.current = key
      }
      cursor.current = key
      scrollIntoView(i)
      sfx.play('hover', { volume: 0.8 })
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 600) / ROW_H) - 1)
    const k = e.key
    if ((k === 'ArrowDown' || k === 'ArrowUp') && e.altKey && sortable && onMove && cur >= 0) {
      // keyboard reorder: Alt+↑/↓ moves the focused row
      const to = Math.max(0, Math.min(n - 1, cur + (k === 'ArrowDown' ? 1 : -1)))
      if (to !== cur) {
        sfx.play('tick')
        onMove(cur, to)
        scrollIntoView(to)
      }
    } else if (k === 'ArrowDown') move(cur < 0 ? 0 : cur + 1)
    else if (k === 'ArrowUp') move(cur < 0 ? 0 : cur - 1)
    else if (k === 'PageDown') move(cur + page)
    else if (k === 'PageUp') move(cur - page)
    else if (k === 'Home') move(0)
    else if (k === 'End') move(n - 1)
    else if (k === 'Enter') {
      if (cur >= 0) api('dbl', cur)
    } else if ((k === 'Delete' || k === 'Backspace') && onRemove && sel.size) removeKeys([...sel])
    else if (k.toLowerCase() === 'a' && isMod(e)) {
      setSel(new Set(items.map((i) => i.key)))
      sfx.play('select', { volume: 0.6 })
    } else if (k === 'Escape' && sel.size) setSel(new Set())
    else if (k.toLowerCase() === 'q' && !isMod(e) && sel.size) {
      const ids = selectedItems().map((i) => i.track.id)
      void (e.shiftKey ? trackActions.playNext(ids) : trackActions.addToQueue(ids))
    } else if (k.toLowerCase() === 'l' && !isMod(e) && !e.shiftKey && sel.size === 1) {
      const it = selectedItems()[0]
      if (it) toggleLike(it.track)
    } else if (k.toLowerCase() === 'd' && isMod(e) && sel.size) {
      void trackActions.download({ trackIds: selectedItems().map((i) => i.track.id) })
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  // ---- render --------------------------------------------------------------------------
  const [start, end] = range
  const rendered: { item: TrackListItem; index: number; exiting?: boolean }[] = []
  for (let i = start; i < Math.min(end, items.length); i++) rendered.push({ item: items[i], index: i })
  if (activeKey) {
    const ai = indexOf.get(activeKey)
    if (ai !== undefined && (ai < start || ai >= end)) rendered.push({ item: items[ai], index: ai })
  }
  for (const [, g] of view.exiting) if (g.index >= start - 2 && g.index < end + 2) rendered.push({ item: g.item, index: g.index, exiting: true })

  return (
    <div ref={rootRef} className={cx('tl', rowExtra && 'tl--extra', sortable && 'tl--sortable', className)}>
      <div className="tl-head" style={{ top: stickyTop }}>
        <span className="tl-c tl-c--num">#</span>
        <span className="tl-c tl-c--cover" />
        <span className="tl-c tl-c--title">Title</span>
        <span className="tl-c tl-c--album">Album</span>
        <span className="tl-c tl-c--int" title="Intensity">
          <Star />
        </span>
        <span className="tl-c tl-c--len" title="Length">
          <Clock />
        </span>
        <span className="tl-c tl-c--like" title="Liked">
          <Heart />
        </span>
        <span className="tl-c tl-c--dl" title="Downloaded">
          <Download />
        </span>
        {rowExtra && <span className="tl-c tl-c--extra" />}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[lockToY]}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveKey(null)}
      >
        <SortableContext items={keys} strategy={verticalListSortingStrategy} disabled={!sortable}>
          <div
            ref={listRef}
            className="tl-body"
            role="listbox"
            aria-multiselectable
            aria-label={context.title}
            tabIndex={0}
            style={{ height: items.length * ROW_H }}
            onKeyDown={onKeyDown}
          >
            {rendered.map(({ item, index, exiting }) => (
              <Row
                key={exiting ? `x:${item.key}` : item.key}
                item={item}
                index={index}
                track={withLike(item.track)}
                selected={!exiting && sel.has(item.key)}
                sortable={sortable && !exiting}
                exiting={!!exiting}
                entering={view.entering.has(item.key)}
                introDelay={view.intro && index - start < 16 ? Math.max(0, index - start) * 24 : -1}
                dragging={activeKey === item.key}
                rowExtra={rowExtra}
                api={api}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

interface RowProps {
  item: TrackListItem
  index: number
  track: TrackView
  selected: boolean
  sortable: boolean
  exiting: boolean
  entering: boolean
  introDelay: number
  dragging: boolean
  rowExtra?: (item: TrackListItem) => ReactNode
  api: (action: 'click' | 'dbl' | 'menu' | 'like', index: number, e?: RMouseEvent) => void
}

const Row = memo(function Row({ item, index, track, selected, sortable, exiting, entering, introDelay, dragging, rowExtra, api }: RowProps) {
  const { listeners, setNodeRef, transform, transition, isSorting } = useSortable({
    id: item.key,
    disabled: !sortable,
    transition: { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
  })
  const playState = usePlayer((s) => (s.current?.id === track.id ? s.status : null))
  const playing = playState === 'playing' || playState === 'loading' || playState === 'buffering'
  const heart = useRef<SVGSVGElement>(null)
  const wasLiked = useRef(track.liked)
  useEffect(() => {
    if (track.liked && !wasLiked.current) tween(heart.current).clear().set({ scale: 1.6 }).scaleTo(1, 650, 'outElasticHalf')
    wasLiked.current = track.liked
  }, [track.liked])

  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition: isSorting || dragging ? transition : undefined }
  const pos: CSSProperties = { transform: `translate3d(0, ${index * ROW_H}px, 0)` }
  const bodyStyle: CSSProperties | undefined = introDelay >= 0 ? { animationDelay: `${introDelay}ms` } : undefined
  const { onKeyDown: _keys, ...pointerListeners } = (listeners ?? {}) as Record<string, (e: unknown) => void>

  return (
    <div className={cx('tl-pos', exiting && 'tl-pos--exit', dragging && 'tl-pos--drag')} style={pos} aria-hidden={exiting || undefined}>
      <div
        ref={exiting ? undefined : setNodeRef}
        style={style}
        className={cx('tl-row', selected && 'tl-row--sel', playState && 'tl-row--current', dragging && 'tl-row--dragging')}
        role="option"
        aria-selected={selected}
        {...(sortable ? pointerListeners : {})}
        onClick={(e) => api('click', index, e)}
        onDoubleClick={() => api('dbl', index)}
        onContextMenu={(e) => api('menu', index, e)}
      >
        <div className={cx('tl-row__body', introDelay >= 0 && 'tl-row__body--intro', entering && 'tl-row__body--enter')} style={bodyStyle}>
          <span className="tl-c tl-c--num">
            {playState ? (
              <span className={cx('tl-eq', playing && 'tl-eq--on')} aria-label={playing ? 'Playing' : 'Paused'}>
                <i />
                <i />
                <i />
              </span>
            ) : (
              <span className="tl-num tnum">{index + 1}</span>
            )}
            {sortable && (
              <span className="tl-grip" title="Drag to reorder (Alt+↑/↓)" aria-hidden>
                <GripVertical />
              </span>
            )}
          </span>
          <span className="tl-c tl-c--cover">
            <CoverArt src={track.cover} size={36} radius={7} hue={track.accent} lazy />
          </span>
          <span className="tl-c tl-c--title">
            <span className="tl-title g-ellipsis">{track.title}</span>
            <span className="tl-sub g-ellipsis">{track.gameName ?? track.albumTitle}</span>
          </span>
          <span className="tl-c tl-c--album g-ellipsis" title={track.albumTitle}>
            {track.albumTitle}
          </span>
          <span className="tl-c tl-c--int">
            <IntensityBadge value={track.analysis?.intensity ?? null} size="sm" />
          </span>
          <span className="tl-c tl-c--len tnum">{formatTime(track.durationMs)}</span>
          <span className="tl-c tl-c--like">
            <button
              type="button"
              className={cx('tl-like', track.liked && 'tl-like--on')}
              aria-label={track.liked ? 'Unlike' : 'Like'}
              aria-pressed={track.liked}
              tabIndex={-1}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                api('like', index)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <Heart ref={heart} />
            </button>
          </span>
          <span className="tl-c tl-c--dl">
            {track.downloaded ? <CircleCheck className="tl-dl tl-dl--on" aria-label="Downloaded" /> : <span className="tl-dl-dot" aria-hidden />}
          </span>
          {rowExtra && (
            <span className="tl-c tl-c--extra" onDoubleClick={(e) => e.stopPropagation()}>
              {rowExtra(item)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
})
