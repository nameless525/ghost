// The queue: "Up next", "History" (earlier queue items) and the full queue, shared by the
// now-playing overlay's drawer and the Play screen's queue drawer.
//
// · virtualised (fixed row height, only the visible window + overscan is mounted)
// · drag to reorder (@dnd-kit/sortable, DragOverlay portalled so transformed panels don't
//   offset it) → player.moveInQueue, applied optimistically until the engine echoes it
// · click / Enter to play, ✕ / Delete to remove, Alt+↑/↓ to move, context menu via trackMenuItems
// · search (/ or Mod+F): filters every tab as you type (title, original title, game, album,
//   composers; see queue-search.ts), highlights the matches, and the tab counts become match
//   counts. ↑/↓ pick a result, Enter plays it, Esc clears then leaves the field. Reordering is
//   off while searching (moving a row among a filtered subset is ambiguous). The query lives
//   until the drawer closes, across tabs, so a search can be widened from Up next to All.
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
import { ArrowUpToLine, GripVertical, History, ListMusic, ListOrdered, Play, SearchX, Trash2, X } from 'lucide-react'
import {
  forwardRef,
  memo,
  startTransition,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as RKeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import type { QueueItem } from '@shared/types'
import { ghost } from '../../ghost'
import { trackMenuItems } from '../../lib/track-actions'
import { useKeybinding } from '../../shell/keys'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { Button } from '../../ui/Button'
import { confirmDialog } from '../../ui/Dialog'
import { CoverArt } from '../../ui/CoverArt'
import { openContextMenu, type MenuItem } from '../../ui/ContextMenu'
import { formatTime } from '../../ui/format'
import { IconButton } from '../../ui/IconButton'
import { Kbd } from '../../ui/Kbd'
import { ScrollArea } from '../../ui/ScrollArea'
import { SearchInput, type SearchInputHandle } from '../../ui/SearchInput'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { cx, portalRoot, useEvent } from '../../ui/util'
import { MiniEq } from './MiniEq'
import { addsMatch, highlightRanges, matchIndices, queryWords, queueTexts } from './queue-search'
import { useStableQueue } from './store'
import './queue.css'

export type QueueTab = 'next' | 'history' | 'all'

const ROW_H = 52
const OVERSCAN = 6
/** Height of the search row (field + gap), for `fit`. */
const SEARCH_H = 44
const NO_WORDS: readonly string[] = []

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

/** Position of the row with queue index `abs` in `rows` (sorted by abs), or -1. */
function posOf(rows: readonly Row[], abs: number): number {
  let lo = 0
  let hi = rows.length - 1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    const a = rows[m].abs
    if (a === abs) return m
    if (a < abs) lo = m + 1
    else hi = m - 1
  }
  return -1
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
  /** Pause per-frame work (equaliser) when hidden; the search clears when this turns false. */
  active: boolean
  /** Initial tab. */
  tab?: QueueTab
  className?: string
  /** Compact header (inside the overlay drawer). */
  compact?: boolean
  /** Size to the content, between these heights (px), instead of filling the parent. */
  fit?: { min: number; max: number }
  /** A search started or ended (the Play drawer swaps its header hint). */
  onSearchingChange?: (searching: boolean) => void
}

export function QueueList({ active, tab: initialTab = 'next', className, compact, fit, onSearchingChange }: QueueListProps) {
  const { queue, index, setOptimistic } = useQueue()
  const [tab, setTab] = useState<QueueTab>(initialTab)
  const viewport = useRef<HTMLDivElement>(null)
  const [win, setWin] = useState({ top: 0, height: 400 })
  const [dragId, setDragId] = useState<string | null>(null)
  const justDragged = useRef(0)

  // ---- search: a keystroke re-renders only the field; the list follows in a transition (an
  // interruptible render: typing never waits for it)
  const search = useRef<QueueSearchHandle>(null)
  const [query, setQuery] = useState('')
  // keyed by the folded words, so "battle" → "battle " or "Battle" doesn't refilter (or rescroll)
  const wordsKey = queryWords(query).join(' ')
  const words = useMemo(() => (wordsKey ? wordsKey.split(' ') : NO_WORDS), [wordsKey])
  const searching = words.length > 0
  /** The result ↑/↓ picked (null: the first one). */
  const [pickedUid, setPickedUid] = useState<string | null>(null)
  const [fieldFocused, setFieldFocused] = useState(false)

  const onQuery = useEvent((q: string) =>
    startTransition(() => {
      setQuery(q)
      setPickedUid(null)
    })
  )
  const clearSearch = () => {
    sfx.play('back', { volume: 0.6 })
    search.current?.clear()
  }
  useEffect(() => {
    if (active) return
    search.current?.clear()
    search.current?.blur()
  }, [active])
  const searchingChanged = useEvent((s: boolean) => onSearchingChange?.(s))
  useEffect(() => searchingChanged(searching), [searching, searchingChanged])
  useKeybinding(
    ['/', 'Mod+F'],
    () => {
      search.current?.focus()
      search.current?.select()
    },
    { enabled: active, repeat: false }
  )

  // ---- rows: one Row per queue item (kept across tab switches and track changes, so memoised
  // rows don't re-render), then the tab's slice or the search hits inside it
  const all = useMemo(() => queue.map((item, abs) => ({ item, abs })), [queue])
  const texts = useMemo(() => (searching ? queueTexts(queue) : null), [queue, searching])
  const hits = useMemo(() => (texts ? matchIndices(texts, words) : null), [texts, words])
  const lo = tab === 'next' ? index + 1 : 0
  const hi = tab === 'history' ? Math.max(0, index) : all.length
  const rows: Row[] = useMemo(() => {
    if (!hits) return lo === 0 && hi === all.length ? all : all.slice(lo, hi)
    const out: Row[] = []
    for (const abs of hits) if (abs >= lo && abs < hi) out.push(all[abs])
    return out
  }, [all, hits, lo, hi])
  const current = index >= 0 ? queue[index] : null
  const upNext = queue.length - index - 1
  const ids = useMemo(() => rows.map((r) => r.item.uid), [rows])

  /** Unfiltered sizes; while searching the tabs count matches instead. */
  const totals = { next: Math.max(0, upNext), history: Math.max(0, index), all: queue.length }
  const counts = useMemo(() => {
    if (!hits) return null
    let before = 0
    let after = 0
    for (const abs of hits) {
      if (abs < index) before++
      else if (abs > index) after++
    }
    return { next: after, history: before, all: hits.length }
  }, [hits, index])
  const shown = counts ?? totals

  // keyboard-picked result (only while the field has focus: it's what Enter plays)
  const pickedPos = useMemo(() => {
    if (!fieldFocused || !rows.length) return -1
    if (pickedUid) {
      const i = rows.findIndex((r) => r.item.uid === pickedUid)
      if (i >= 0) return i
    }
    return searching ? 0 : -1
  }, [fieldFocused, rows, pickedUid, searching])
  const pickedRow = pickedPos >= 0 ? rows[pickedPos] : null

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

  /** Scroll just enough to show the row at `pos`. */
  const reveal = (pos: number) => {
    const v = viewport.current
    if (!v) return
    const y = pos * ROW_H
    if (y < v.scrollTop) v.scrollTop = y
    else if (y + ROW_H > v.scrollTop + v.clientHeight) v.scrollTop = y + ROW_H - v.clientHeight
  }

  // land somewhere sensible when switching tabs / opening / searching
  useLayoutEffect(() => {
    const v = viewport.current
    if (!v || !active) return
    if (searching || tab === 'next') v.scrollTop = 0
    else if (tab === 'all') v.scrollTop = Math.max(0, index * ROW_H - v.clientHeight / 2 + ROW_H)
    else v.scrollTop = v.scrollHeight
    onScroll()
  }, [tab, active, words]) // eslint-disable-line react-hooks/exhaustive-deps

  const first = Math.max(0, Math.floor(win.top / ROW_H) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((win.top + win.height) / ROW_H) + OVERSCAN)
  const visible: { r: Row; pos: number }[] = []
  for (let p = first; p < last; p++) visible.push({ r: rows[p], pos: p })
  const dragRow = dragId ? rows.find((r) => r.item.uid === dragId) : undefined
  if (dragRow) {
    const p = posOf(rows, dragRow.abs)
    if (p < first || p >= last) visible.push({ r: dragRow, pos: p }) // keep the dragged row mounted
  }

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
    move(lo + from, lo + to)
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
      { label: isCur ? 'Playing' : 'Play', icon: <Play size={15} />, shortcut: isCur ? undefined : 'Enter', disabled: isCur, onSelect: () => jump(r.abs) },
      {
        label: 'Play next',
        icon: <ArrowUpToLine size={15} />,
        disabled: isCur || r.abs === index + 1,
        onSelect: () => move(r.abs, r.abs < index ? index : index + 1)
      },
      // their shortcuts (L, Mod+D) act on the playing track or the Browse selection, not on this row
      ...(fromPlaylist >= 0 ? base.slice(fromPlaylist).map((m) => ('shortcut' in m ? { ...m, shortcut: undefined } : m)) : []),
      { separator: true },
      { label: 'Remove from queue', icon: <X size={15} />, shortcut: 'Delete', danger: true, disabled: isCur, onSelect: () => remove(r) }
    ]
  }

  const onRowKey = (e: RKeyboardEvent<HTMLDivElement>, r: Row) => {
    const pos = posOf(rows, r.abs)
    if (e.key === 'Enter') {
      e.preventDefault()
      jump(r.abs)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && r.abs !== index) {
      e.preventDefault()
      remove(r)
      // the focused row unmounts when the engine echoes the removal: hand focus to its neighbour
      // instead of dropping it to <body>
      const nextUid = (rows[pos + 1] ?? rows[pos - 1])?.item.uid
      if (nextUid) window.setTimeout(() => viewport.current?.querySelector<HTMLElement>(`[data-uid="${nextUid}"]`)?.focus({ preventScroll: true }), 150)
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
      const dir = e.key === 'ArrowUp' ? -1 : 1
      const target = pos + dir
      if (target < 0 || target >= rows.length) return
      // moving among search results would jump over the hidden rows: no reordering while searching
      const moving = e.altKey && !searching
      if (moving) move(r.abs, r.abs + dir)
      reveal(target)
      const uid = moving ? r.item.uid : rows[target].item.uid
      requestAnimationFrame(() => viewport.current?.querySelector<HTMLElement>(`[data-uid="${uid}"]`)?.focus({ preventScroll: true }))
    }
  }

  // stable per-row actions: inline closures per render defeated SortableRow's memo, so every
  // visible row re-rendered on each scroll step of the virtual window
  const jumpRow = useEvent((r: Row) => jump(r.abs))
  const removeRow = useEvent((r: Row) => remove(r))
  const menuRow = useEvent((r: Row, x: number, y: number) => openContextMenu({ x, y }, menu(r)))
  const keyRow = useEvent((e: RKeyboardEvent<HTMLDivElement>, r: Row) => onRowKey(e, r))
  const rowActions = useMemo<RowActions>(() => ({ jump: jumpRow, remove: removeRow, menu: menuRow, key: keyRow }), [jumpRow, removeRow, menuRow, keyRow])

  // ---- search field keys: ↑/↓ (PgUp/PgDn) pick a row, Enter plays it
  const pick = (delta: number) => {
    if (!rows.length) return
    const from = pickedPos >= 0 ? pickedPos : delta > 0 ? -1 : rows.length
    const to = Math.max(0, Math.min(rows.length - 1, from + delta))
    setPickedUid(rows[to].item.uid)
    reveal(to)
    if (to !== pickedPos) sfx.play('hover', { volume: 0.4 })
  }
  const onFieldKey = useEvent((e: RKeyboardEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
    const page = Math.max(1, Math.floor((viewport.current?.clientHeight ?? ROW_H) / ROW_H) - 1)
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[e.key]
    if (!step) return
    // ours, not the screen's (volume on Play, the carousel on Browse)
    e.preventDefault()
    e.stopPropagation()
    pick(step)
  })
  const onSubmit = useEvent(() => pickedRow && jump(pickedRow.abs))

  const clear = async () => {
    if (upNext <= 0 && index <= 0) return
    const n = queue.length - (current ? 1 : 0)
    if (n > 3 && !(await confirmDialog({ title: 'Clear the queue?', body: `${plural(n, 'track')} will be removed. The current track keeps playing.`, confirmLabel: 'Clear', danger: true }))) return
    sfx.play('back')
    void ghost().player.clearQueue()
  }

  const shownQuery = query.trim()
  const empty = searching
    ? {
        icon: <SearchX />,
        title: <>No tracks match “{shownQuery}”</>,
        body:
          tab !== 'all' && shown.all > 0
            ? `${plural(shown.all, 'track')} in the whole queue ${shown.all === 1 ? 'matches' : 'match'}.`
            : 'Check the spelling, or try fewer words.',
        actions: (
          <>
            {tab !== 'all' && shown.all > 0 && (
              <Button size="sm" variant="soft" onClick={() => setTab('all')}>
                Show {shown.all === 1 ? 'it' : 'them'}
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={clearSearch}>
              Clear search
            </Button>
          </>
        )
      }
    : tab === 'next'
      ? { icon: <ListMusic />, title: 'Nothing up next', body: 'Queue tracks from Browse or the Library (Q), and they’ll line up here.' }
      : tab === 'history'
        ? { icon: <History />, title: 'No history yet', body: 'Tracks you’ve played from this queue show up here.' }
        : { icon: <ListOrdered />, title: 'The queue is empty', body: 'Play an album or a playlist to fill it.' }

  const tabTotal = totals[tab]
  // sized by the unfiltered tab, so the drawer doesn't jump around while typing
  const fitHeight = fit
    ? Math.round(Math.max(fit.min, Math.min(fit.max, 96 + SEARCH_H + (tab === 'next' && current ? 58 : 0) + Math.max(2.4, tabTotal) * ROW_H + 10)))
    : undefined

  let summary: ReactNode = null
  if (searching) {
    summary = (
      <>
        <strong>{rows.length}</strong> of {plural(tabTotal, 'track')}
        {compact && <span className="np-queue__hint"> · clear the search to reorder</span>}
      </>
    )
  } else if (tab === 'next' && totals.next > 0) {
    const mins = totalMinutes(queue.slice(index + 1))
    summary = (
      <>
        {plural(totals.next, 'track')}
        {mins && <> · {mins}</>}
      </>
    )
  } else if (tab === 'history' && totals.history > 0) summary = <>{plural(totals.history, 'track')} played</>
  else if (tab === 'all' && totals.all > 0) {
    const mins = totalMinutes(queue)
    summary = (
      <>
        {plural(totals.all, 'track')}
        {mins && <> · {mins}</>}
      </>
    )
  }

  return (
    <div
      className={cx('np-queue', compact && 'np-queue--compact', searching && 'np-queue--searching', className)}
      style={fitHeight ? { height: fitHeight } : undefined}
    >
      <QueueSearch ref={search} onQuery={onQuery} onSubmit={onSubmit} onKeyDown={onFieldKey} onFocusChange={setFieldFocused} />
      <div className="np-queue__head">
        <SegmentedControl<QueueTab>
          value={tab}
          onChange={setTab}
          aria-label="Queue view"
          options={[
            { value: 'next', label: <span className="np-queue__tab">Up next <em>{shown.next}</em></span> },
            { value: 'history', label: <span className="np-queue__tab">History <em>{shown.history}</em></span> },
            { value: 'all', label: <span className="np-queue__tab">All <em>{shown.all}</em></span> }
          ]}
        />
        <div className="np-queue__spacer" />
        <IconButton size="sm" label="Clear queue" icon={<Trash2 />} disabled={queue.length <= 1} onClick={() => void clear()} />
      </div>
      <div className="np-queue__summary" aria-live={searching ? 'polite' : undefined}>
        {summary}
      </div>

      {tab === 'next' && current && !searching && (
        <div className="np-queue__now">
          <QueueRowView row={{ item: current, abs: index }} current active={active} words={NO_WORDS} onJump={() => {}} onRemove={() => {}} pinned />
        </div>
      )}

      <ScrollArea className="np-queue__scroll" viewportRef={viewport} onScroll={onScroll} role="list">
        {rows.length === 0 ? (
          <div className="np-queue__empty">
            <span className="np-queue__empty-icon">{empty.icon}</span>
            <strong>{empty.title}</strong>
            <span>{empty.body}</span>
            {'actions' in empty && <div className="np-queue__empty-actions">{empty.actions}</div>}
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <div className="np-queue__content" style={{ height: rows.length * ROW_H }}>
                {visible.map(({ r, pos }) => (
                  <SortableRow
                    key={r.item.uid}
                    row={r}
                    top={pos * ROW_H}
                    current={r.abs === index}
                    active={active}
                    dragging={dragId === r.item.uid}
                    locked={searching}
                    picked={r === pickedRow}
                    words={words}
                    actions={rowActions}
                  />
                ))}
              </div>
            </SortableContext>
            {createPortal(
              <DragOverlay dropAnimation={{ duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }} zIndex={130}>
                {dragRow ? <QueueRowView row={dragRow} current={dragRow.abs === index} active={false} words={NO_WORDS} overlay onJump={() => {}} onRemove={() => {}} /> : null}
              </DragOverlay>,
              portalRoot()
            )}
          </DndContext>
        )}
      </ScrollArea>
    </div>
  )
}

interface QueueSearchHandle {
  focus(): void
  select(): void
  blur(): void
  /** Empty the field (and the search). */
  clear(): void
}

interface QueueSearchProps {
  onQuery: (q: string) => void
  onSubmit: () => void
  onKeyDown: (e: RKeyboardEvent) => void
  onFocusChange: (focused: boolean) => void
}

/** The search field. It owns the text, so a keystroke re-renders this alone (props are stable). */
const QueueSearch = memo(
  forwardRef<QueueSearchHandle, QueueSearchProps>(function QueueSearch({ onQuery, onSubmit, onKeyDown, onFocusChange }, ref) {
    const input = useRef<SearchInputHandle>(null)
    const [text, setText] = useState('')
    const [focused, setFocused] = useState(false)
    const change = (q: string) => {
      setText(q)
      onQuery(q)
    }
    useImperativeHandle(ref, () => ({
      // never scroll an ancestor to reveal it (the drawer may still be sliding in)
      focus: () => input.current?.input?.focus({ preventScroll: true }),
      select: () => input.current?.select(),
      blur: () => input.current?.blur(),
      clear: () => change('')
    }))
    const focus = (f: boolean) => {
      setFocused(f)
      onFocusChange(f)
    }
    return (
      <div className="np-queue__search" onKeyDown={onKeyDown}>
        <SearchInput
          ref={input}
          value={text}
          onChange={change}
          onSubmit={onSubmit}
          onEscape={() => {
            // clear first, then leave the field (a third Esc closes the queue)
            if (!text) return input.current?.blur()
            sfx.play('back', { volume: 0.6 })
            change('')
          }}
          placeholder="Search the queue"
          right={!text && !focused ? <Kbd combo="/" size="sm" className="np-queue__search-key" /> : null}
          inputProps={{ 'aria-label': 'Search the queue', onFocus: () => focus(true), onBlur: () => focus(false) }}
        />
      </div>
    )
  })
)

interface RowProps {
  row: Row
  current: boolean
  active: boolean
  /** Search words to highlight (empty when not searching). */
  words: readonly string[]
  onJump: () => void
  onRemove: () => void
  onMenu?: (x: number, y: number) => void
  onKey?: (e: RKeyboardEvent<HTMLDivElement>) => void
  overlay?: boolean
  pinned?: boolean
  /** Picked with ↑/↓ from the search field (Enter plays it). */
  picked?: boolean
}

interface RowActions {
  jump(r: Row): void
  remove(r: Row): void
  menu(r: Row, x: number, y: number): void
  key(e: RKeyboardEvent<HTMLDivElement>, r: Row): void
}

const SortableRow = memo(function SortableRow({
  row,
  top,
  current,
  active,
  dragging,
  locked,
  picked,
  words,
  actions
}: {
  row: Row
  top: number
  current: boolean
  active: boolean
  dragging: boolean
  /** No dragging (while searching). */
  locked: boolean
  picked: boolean
  words: readonly string[]
  actions: RowActions
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: row.item.uid, disabled: locked })
  const style: CSSProperties = {
    top,
    transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
    transition: transition ?? undefined
  }
  return (
    <QueueRowView
      row={row}
      current={current}
      active={active}
      words={words}
      picked={picked}
      onJump={() => actions.jump(row)}
      onRemove={() => actions.remove(row)}
      onMenu={(x, y) => actions.menu(row, x, y)}
      onKey={(e) => actions.key(e, row)}
      nodeRef={setNodeRef}
      style={style}
      dragging={dragging}
      dndProps={{ ...attributes, ...listeners }}
    />
  )
})

/** `text` with the search words marked. */
function Marked({ text, words }: { text: string; words: readonly string[] }) {
  const ranges = words.length ? highlightRanges(text, words) : []
  if (!ranges.length) return <>{text}</>
  const out: ReactNode[] = []
  let at = 0
  for (const [s, e] of ranges) {
    if (s > at) out.push(text.slice(at, s))
    out.push(
      <mark key={s} className="np-q-mark">
        {text.slice(s, e)}
      </mark>
    )
    at = e
  }
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

/** The current row's equaliser (only it subscribes to play/pause, not every row). */
function CurrentLead({ active }: { active: boolean }) {
  const playing = usePlayer((s) => s.status === 'playing')
  return <MiniEq active={active && playing} />
}

function NowStatus() {
  const label = usePlayer((s) => (s.status === 'playing' ? 'Now playing' : s.status === 'loading' || s.status === 'buffering' ? 'Loading' : 'Paused'))
  return (
    <>
      <em>{label}</em>
      {' · '}
    </>
  )
}

function QueueRowView({
  row,
  current,
  active,
  words,
  picked,
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
  const sub = t.gameName ?? t.albumTitle
  // while searching, name the field that matched when it isn't on the row already
  const extra = words.length ? [t.titleOriginal, t.albumTitle !== sub ? t.albumTitle : null, t.composers.join(', ')].find((f) => addsMatch(f, `${t.title}\n${sub}`, words)) : undefined
  return (
    <div
      ref={nodeRef}
      style={style}
      data-uid={row.item.uid}
      className={cx(
        'np-q-row',
        current && 'np-q-row--current',
        overlay && 'np-q-row--overlay',
        dragging && 'np-q-row--dragging',
        pinned && 'np-q-row--pinned',
        picked && 'np-q-row--picked'
      )}
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
      <span className="np-q-row__lead">{current ? <CurrentLead active={active} /> : <span className="tnum">{row.abs + 1}</span>}</span>
      <CoverArt src={t.cover} size={38} radius={7} hue={t.accent} lazy />
      <span className="np-q-row__text">
        <span className="np-q-row__title g-ellipsis">
          <Marked text={t.title} words={words} />
        </span>
        <span className="np-q-row__sub g-ellipsis">
          {current && pinned ? <NowStatus /> : null}
          <Marked text={sub} words={words} />
          {extra && (
            <>
              {' · '}
              <Marked text={extra} words={words} />
            </>
          )}
        </span>
      </span>
      <span className="np-q-row__dur tnum">{t.durationMs ? formatTime(t.durationMs) : ''}</span>
      {pinned || overlay ? (
        // keeps the duration column aligned with the list rows
        <span className="np-q-row__actions" aria-hidden />
      ) : (
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
