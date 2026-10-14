// The queue: "Up next", "History" (earlier queue items) and the full queue, shared by the
// now-playing overlay's drawer and the Play screen's queue drawer.
//
// · virtualised (fixed row height, only the visible window + overscan is mounted)
// · drag to reorder (@dnd-kit/sortable, DragOverlay portalled so transformed panels don't
//   offset it) → player.moveInQueue, applied optimistically until the engine echoes it
// · click / Enter to jump, ✕ / Delete to remove, Alt+↑/↓ to move, context menu via trackMenuItems
// · the current item carries a tiny beat-reactive equaliser
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier
} from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ArrowUpToLine, GripVertical, History, ListMusic, ListOrdered, Play, Trash2, X } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { QueueItem } from '@shared/types'
import { ghost } from '../../ghost'
import { trackMenuItems } from '../../lib/track-actions'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { confirmDialog } from '../../ui/Dialog'
import { CoverArt } from '../../ui/CoverArt'
import { openContextMenu, type MenuItem } from '../../ui/ContextMenu'
import { formatTime } from '../../ui/format'
import { IconButton } from '../../ui/IconButton'
import { ScrollArea } from '../../ui/ScrollArea'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { cx, portalRoot } from '../../ui/util'
import { MiniEq } from './MiniEq'
import { useStableQueue } from './store'
import './queue.css'

export type QueueTab = 'next' | 'history' | 'all'

const ROW_H = 52
const OVERSCAN = 6

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 })

interface Row {
  item: QueueItem
  /** Absolute index in the queue. */
  abs: number
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function totalMinutes(items: QueueItem[]): string {
  const ms = items.reduce((s, q) => s + (q.track.durationMs ?? 0), 0)
  if (!ms) return ''
  const m = Math.round(ms / 60000)
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}

/** Store queue, overridden by an optimistic reorder until the engine's echo arrives. */
function useQueue(): { queue: QueueItem[]; index: number; setOptimistic: (q: QueueItem[]) => void } {
  const queue = useStableQueue()
  const queueIndex = usePlayer((s) => s.queueIndex)
  const [local, setLocal] = useState<{ base: QueueItem[]; q: QueueItem[] } | null>(null)
  // drop the optimistic order if the engine never echoes it (e.g. the move failed)
  useEffect(() => {
    if (!local) return
    const t = window.setTimeout(() => setLocal(null), 2500)
    return () => window.clearTimeout(t)
  }, [local])
  const effective = local && local.base === queue ? local.q : queue
  const currentUid = queue[queueIndex]?.uid
  const index = effective === queue ? queueIndex : effective.findIndex((q) => q.uid === currentUid)
  return { queue: effective, index, setOptimistic: (q) => setLocal({ base: queue, q }) }
}

export interface QueueListProps {
  /** Pause per-frame work (equaliser) when hidden. */
  active: boolean
  /** Initial tab. */
  tab?: QueueTab
  className?: string
  /** Compact header (inside the overlay drawer). */
  compact?: boolean
  /** Size to the content, between these heights (px), instead of filling the parent. */
  fit?: { min: number; max: number }
}

export function QueueList({ active, tab: initialTab = 'next', className, compact, fit }: QueueListProps) {
  const { queue, index, setOptimistic } = useQueue()
  const [tab, setTab] = useState<QueueTab>(initialTab)
  const viewport = useRef<HTMLDivElement>(null)
  const [win, setWin] = useState({ top: 0, height: 400 })
  const [dragId, setDragId] = useState<string | null>(null)
  const justDragged = useRef(0)

  const rows: Row[] = useMemo(() => {
    const all = queue.map((item, abs) => ({ item, abs }))
    if (tab === 'next') return all.slice(index + 1)
    if (tab === 'history') return all.slice(0, Math.max(0, index))
    return all
  }, [queue, index, tab])
  const base = tab === 'next' ? index + 1 : 0
  const current = index >= 0 ? queue[index] : null
  const upNext = queue.length - index - 1
  const ids = useMemo(() => rows.map((r) => r.item.uid), [rows])

  // virtual window
  const onScroll = () => {
    const v = viewport.current
    if (!v) return
    const top = v.scrollTop
    const height = v.clientHeight
    setWin((w) => (Math.floor(w.top / ROW_H) === Math.floor(top / ROW_H) && w.height === height ? w : { top, height }))
  }
  useLayoutEffect(() => {
    const v = viewport.current
    if (!v) return
    onScroll()
    const ro = new ResizeObserver(onScroll)
    ro.observe(v)
    return () => ro.disconnect()
  }, [])

  // land somewhere sensible when switching tabs / opening
  useLayoutEffect(() => {
    const v = viewport.current
    if (!v || !active) return
    if (tab === 'all') v.scrollTop = Math.max(0, index * ROW_H - v.clientHeight / 2 + ROW_H)
    else if (tab === 'history') v.scrollTop = v.scrollHeight
    else v.scrollTop = 0
    onScroll()
  }, [tab, active]) // eslint-disable-line react-hooks/exhaustive-deps

  const first = Math.max(0, Math.floor(win.top / ROW_H) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((win.top + win.height) / ROW_H) + OVERSCAN)
  const visible = rows.slice(first, last)
  const dragRow = dragId ? rows.find((r) => r.item.uid === dragId) : undefined
  if (dragRow && (dragRow.abs - base < first || dragRow.abs - base >= last)) visible.push(dragRow) // keep the dragged row mounted

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= queue.length) return
    setOptimistic(arrayMove(queue, from, to))
    sfx.play('tick')
    void ghost().player.moveInQueue(from, to)
  }

  const onDragStart = (e: DragStartEvent) => {
    setDragId(String(e.active.id))
    sfx.play('select', { volume: 0.5 })
  }
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null)
    justDragged.current = performance.now()
    if (!e.over || e.active.id === e.over.id) return
    const from = ids.indexOf(String(e.active.id))
    const to = ids.indexOf(String(e.over.id))
    if (from < 0 || to < 0) return
    move(base + from, base + to)
  }

  const jump = (abs: number) => {
    if (performance.now() - justDragged.current < 120) return
    sfx.play('confirm', { volume: 0.7 })
    void ghost().player.jumpTo(abs)
  }
  const remove = (r: Row) => {
    sfx.play('back', { volume: 0.5 })
    void ghost().player.removeFromQueue([r.item.uid])
  }

  const menu = (r: Row): MenuItem[] => {
    const isCur = r.abs === index
    const base = trackMenuItems(r.item.track)
    const fromPlaylist = base.findIndex((m) => 'label' in m && m.label === 'Add to playlist')
    return [
      base[0],
      { label: isCur ? 'Playing' : 'Play now', icon: <Play size={15} />, disabled: isCur, onSelect: () => jump(r.abs) },
      {
        label: 'Play next',
        icon: <ArrowUpToLine size={15} />,
        disabled: isCur || r.abs === index + 1,
        onSelect: () => move(r.abs, r.abs < index ? index : index + 1)
      },
      ...(fromPlaylist >= 0 ? base.slice(fromPlaylist) : []),
      { separator: true },
      { label: 'Remove from queue', icon: <X size={15} />, shortcut: 'Delete', danger: true, disabled: isCur, onSelect: () => remove(r) }
    ]
  }

  const onRowKey = (e: RKeyboardEvent<HTMLDivElement>, r: Row) => {
    const pos = r.abs - base
    if (e.key === 'Enter') {
      e.preventDefault()
      jump(r.abs)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && r.abs !== index) {
      e.preventDefault()
      remove(r)
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
      const dir = e.key === 'ArrowUp' ? -1 : 1
      const target = pos + dir
      if (target < 0 || target >= rows.length) return
      if (e.altKey) move(r.abs, r.abs + dir)
      const v = viewport.current
      if (v) {
        const y = target * ROW_H
        if (y < v.scrollTop) v.scrollTop = y
        else if (y + ROW_H > v.scrollTop + v.clientHeight) v.scrollTop = y + ROW_H - v.clientHeight
      }
      const uid = e.altKey ? r.item.uid : rows[target].item.uid
      requestAnimationFrame(() => viewport.current?.querySelector<HTMLElement>(`[data-uid="${uid}"]`)?.focus({ preventScroll: true }))
    }
  }

  const clear = async () => {
    if (upNext <= 0 && index <= 0) return
    const n = queue.length - (current ? 1 : 0)
    if (n > 3 && !(await confirmDialog({ title: 'Clear the queue?', body: `${plural(n, 'track')} will be removed. The current track keeps playing.`, confirmLabel: 'Clear', danger: true }))) return
    sfx.play('back')
    void ghost().player.clearQueue()
  }

  const counts = { next: Math.max(0, upNext), history: Math.max(0, index), all: queue.length }
  const empty =
    tab === 'next'
      ? { icon: <ListMusic />, title: 'Nothing up next', body: 'Queue tracks from Browse or the Library (Q), and they’ll line up here.' }
      : tab === 'history'
        ? { icon: <History />, title: 'No history yet', body: 'Tracks you’ve played from this queue show up here.' }
        : { icon: <ListOrdered />, title: 'The queue is empty', body: 'Play an album or a playlist to fill it.' }

  const fitHeight = fit
    ? Math.round(Math.max(fit.min, Math.min(fit.max, 96 + (tab === 'next' && current ? 58 : 0) + Math.max(2.4, rows.length) * ROW_H + 10)))
    : undefined

  return (
    <div className={cx('np-queue', compact && 'np-queue--compact', className)} style={fitHeight ? { height: fitHeight } : undefined}>
      <div className="np-queue__head">
        <SegmentedControl<QueueTab>
          value={tab}
          onChange={setTab}
          aria-label="Queue view"
          options={[
            { value: 'next', label: <span className="np-queue__tab">Up next <em>{counts.next}</em></span> },
            { value: 'history', label: <span className="np-queue__tab">History <em>{counts.history}</em></span> },
            { value: 'all', label: <span className="np-queue__tab">All <em>{counts.all}</em></span> }
          ]}
        />
        <div className="np-queue__spacer" />
        <IconButton size="sm" label="Clear queue" icon={<Trash2 />} disabled={queue.length <= 1} onClick={() => void clear()} />
      </div>
      <div className="np-queue__summary">
        {tab === 'next' && counts.next > 0 && (
          <>
            {plural(counts.next, 'track')}
            {totalMinutes(queue.slice(index + 1)) && <> · {totalMinutes(queue.slice(index + 1))}</>}
          </>
        )}
        {tab === 'history' && counts.history > 0 && <>{plural(counts.history, 'track')} played</>}
        {tab === 'all' && counts.all > 0 && (
          <>
            {plural(counts.all, 'track')} · {totalMinutes(queue)}
          </>
        )}
      </div>

      {tab === 'next' && current && (
        <div className="np-queue__now">
          <QueueRowView row={{ item: current, abs: index }} current active={active} onJump={() => {}} onRemove={() => {}} pinned />
        </div>
      )}

      <ScrollArea className="np-queue__scroll" viewportRef={viewport} onScroll={onScroll} role="list">
        {rows.length === 0 ? (
          <div className="np-queue__empty">
            <span className="np-queue__empty-icon">{empty.icon}</span>
            <strong>{empty.title}</strong>
            <span>{empty.body}</span>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <div className="np-queue__content" style={{ height: rows.length * ROW_H }}>
                {visible.map((r) => (
                  <SortableRow
                    key={r.item.uid}
                    row={r}
                    top={(r.abs - base) * ROW_H}
                    current={r.abs === index}
                    active={active}
                    dragging={dragId === r.item.uid}
                    onJump={() => jump(r.abs)}
                    onRemove={() => remove(r)}
                    onMenu={(x, y) => openContextMenu({ x, y }, menu(r))}
                    onKey={(e) => onRowKey(e, r)}
                  />
                ))}
              </div>
            </SortableContext>
            {createPortal(
              <DragOverlay dropAnimation={{ duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }} zIndex={130}>
                {dragRow ? <QueueRowView row={dragRow} current={dragRow.abs === index} active={false} overlay onJump={() => {}} onRemove={() => {}} /> : null}
              </DragOverlay>,
              portalRoot()
            )}
          </DndContext>
        )}
      </ScrollArea>
    </div>
  )
}

interface RowProps {
  row: Row
  current: boolean
  active: boolean
  onJump: () => void
  onRemove: () => void
  onMenu?: (x: number, y: number) => void
  onKey?: (e: RKeyboardEvent<HTMLDivElement>) => void
  overlay?: boolean
  pinned?: boolean
}

const SortableRow = memo(function SortableRow(props: RowProps & { top: number; dragging: boolean }) {
  const { row, top, dragging } = props
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: row.item.uid })
  const style: CSSProperties = {
    top,
    transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
    transition: transition ?? undefined
  }
  return (
    <QueueRowView
      {...props}
      nodeRef={setNodeRef}
      style={style}
      dragging={dragging}
      dndProps={{ ...attributes, ...listeners }}
    />
  )
})

function QueueRowView({
  row,
  current,
  active,
  onJump,
  onRemove,
  onMenu,
  onKey,
  overlay,
  pinned,
  nodeRef,
  style,
  dragging,
  dndProps
}: RowProps & { nodeRef?: (el: HTMLElement | null) => void; style?: CSSProperties; dragging?: boolean; dndProps?: Record<string, unknown> }) {
  const t = row.item.track
  const playing = usePlayer((s) => s.status === 'playing')
  return (
    <div
      ref={nodeRef}
      style={style}
      data-uid={row.item.uid}
      className={cx('np-q-row', current && 'np-q-row--current', overlay && 'np-q-row--overlay', dragging && 'np-q-row--dragging', pinned && 'np-q-row--pinned')}
      {...dndProps}
      role="listitem"
      tabIndex={pinned ? -1 : 0}
      aria-current={current || undefined}
      aria-label={`${t.title}${t.gameName ? `, ${t.gameName}` : ''}`}
      onClick={pinned ? undefined : onJump}
      onKeyDown={onKey}
      onContextMenu={(e) => {
        if (!onMenu) return
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
      onPointerEnter={() => !overlay && !pinned && sfx.play('hover', { volume: 0.4 })}
    >
      <span className="np-q-row__lead">
        {current ? <MiniEq active={active && playing} /> : <span className="tnum">{row.abs + 1}</span>}
      </span>
      <CoverArt src={t.cover} size={38} radius={7} hue={t.accent} lazy />
      <span className="np-q-row__text">
        <span className="np-q-row__title g-ellipsis">{t.title}</span>
        <span className="np-q-row__sub g-ellipsis">
          {current && pinned ? <em>{playing ? 'Now playing' : 'Paused'}</em> : null}
          {current && pinned ? ' · ' : null}
          {t.gameName ?? t.albumTitle}
        </span>
      </span>
      <span className="np-q-row__dur tnum">{t.durationMs ? formatTime(t.durationMs) : ''}</span>
      {!pinned && !overlay && (
        <span className="np-q-row__actions">
          {!current && (
            <IconButton
              size="sm"
              label="Remove from queue"
              tooltip={false}
              icon={<X />}
              sound={false}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onRemove()
              }}
            />
          )}
          <span className="np-q-row__grip" aria-hidden>
            <GripVertical size={14} />
          </span>
        </span>
      )}
    </div>
  )
}
