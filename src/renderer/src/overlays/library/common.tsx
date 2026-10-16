// Shared bits for the Library, Downloads and Settings overlays (all owned by ui-library):
// live data hooks, empty states, time formatting and a FLIP/presence helper for animated lists.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import type { GhostEvents } from '@shared/api'
import { ghost } from '../../ghost'
import { tween } from '../../motion/tween'
import { GhostMark } from '../../ui/GhostMark'
import { cx, useEvent } from '../../ui/util'
import { CatalogRefresh } from './catalog-refresh'
import './common.css'

export type LibraryKind = GhostEvents['library:changed']['kind']

// ---------------------------------------------------------------------------
// Data

export interface Live<T> {
  data: T | null
  error: unknown
  loading: boolean
  reload: () => void
  /** Optimistic local update (overwritten by the next load). */
  mutate: (fn: (d: T) => T) => void
}

/**
 * Load something from the backend and keep it fresh on `library:changed` events of the given
 * kinds. While `active` is false (overlay closed / tab hidden) refreshes are deferred until it
 * becomes active again. Bursts of events are coalesced. `catalog`: it's a query over the catalog
 * (a smart playlist), so it's also refreshed when the catalog's data changes (throttled).
 */
export function useLive<T>(load: () => Promise<T>, kinds: LibraryKind[], active = true, filter?: (e: GhostEvents['library:changed']) => boolean, opts: { catalog?: boolean } = {}): Live<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const stale = useRef(true)
  const timer = useRef(0)
  const activeRef = useRef(active)
  activeRef.current = active
  const catalogRefresh = useRef<CatalogRefresh | null>(null)

  const run = useEvent(() => {
    const my = ++seq.current
    stale.current = false
    catalogRefresh.current?.loading()
    setLoading(true)
    load().then(
      (d) => {
        if (my !== seq.current) return
        setData(d)
        setError(null)
        setLoading(false)
      },
      (err) => {
        if (my !== seq.current) return
        setError(err)
        setLoading(false)
      }
    )
  })

  const schedule = useEvent(() => {
    if (!activeRef.current) {
      stale.current = true
      return
    }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(run, 90)
  })

  const kindKey = kinds.join(',')
  useEffect(() => {
    const ks = new Set(kindKey.split(','))
    const off = ghost().on('library:changed', (e) => {
      if (ks.has(e.kind) && (!filter || filter(e))) schedule()
    })
    return () => {
      off()
      window.clearTimeout(timer.current)
    }
  }, [kindKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const catalog = !!opts.catalog
  useEffect(() => {
    if (!catalog) return
    const c = (catalogRefresh.current = new CatalogRefresh(
      run,
      () => activeRef.current,
      () => {
        stale.current = true
      }
    ))
    const off = ghost().on('catalog:status', (s) => c.status(s.revision, s.indexing))
    return () => {
      off()
      c.dispose()
      catalogRefresh.current = null
    }
  }, [catalog, run])

  useEffect(() => {
    if (active && stale.current) run()
  }, [active, run])

  return {
    data,
    error,
    loading: loading && data === null,
    reload: run,
    mutate: (fn) => setData((d) => (d === null ? d : fn(d)))
  }
}

// ---------------------------------------------------------------------------
// Formatting

export const plural = (n: number, word: string, many = `${word}s`): string => `${n.toLocaleString()} ${n === 1 ? word : many}`

/** 2 760 000 → "46 min", 5 520 000 → "1 h 32 min". */
export function formatLong(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '0 min'
  const totalMin = Math.round(ms / 60000)
  if (totalMin < 1) return `${Math.max(1, Math.round(ms / 1000))} s`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (!h) return `${m} min`
  return m ? `${h} h ${m} min` : `${h} h`
}

/** "just now", "4 min ago", "3 h ago", "yesterday", "5 days ago", "12 Oct". */
export function relativeTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts)
  const min = Math.floor(d / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24 && isSameDay(ts, now)) return `${h} h ago`
  const days = dayDiff(ts, now)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(ts).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' })
}

const startOfDay = (ts: number) => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
export const isSameDay = (a: number, b: number): boolean => startOfDay(a) === startOfDay(b)
/** Whole calendar days between two timestamps (b later). */
export const dayDiff = (a: number, b: number): number => Math.round((startOfDay(b) - startOfDay(a)) / 86400000)

/** "Today", "Yesterday", "Monday", "3 October", "3 October 2025". */
export function dayLabel(ts: number, now = Date.now()): string {
  const diff = dayDiff(ts, now)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  const d = new Date(ts)
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' })
}

export const clockTime = (ts: number): string => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** 38 123 456 → "36.4 MB". */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '–'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`
}

/** A re-render every `ms` (for relative timestamps). */
export function useNow(ms = 30000, active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms, active])
  return now
}

// ---------------------------------------------------------------------------
// Empty states

export interface EmptyStateProps {
  /** Small glyph shown in a badge on the ghost. */
  icon?: ReactNode
  title: ReactNode
  body?: ReactNode
  actions?: ReactNode
  compact?: boolean
  className?: string
}

/** A floating ghost, a title, a line of help and a call to action. */
export function EmptyState({ icon, title, body, actions, compact, className }: EmptyStateProps) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const kids = root.current?.children
    if (!kids) return
    Array.from(kids).forEach((k, i) =>
      tween(k)
        .clear()
        .set({ opacity: 0, y: 14 })
        .delay(60 + i * 55)
        .fadeIn(320, 'outQuad')
        .moveToY(0, 560, 'outQuint')
    )
  }, [])
  return (
    <div ref={root} className={cx('lx-empty', compact && 'lx-empty--compact', className)}>
      <div className="lx-empty__art">
        <div className="lx-empty__halo" />
        <div className="lx-empty__ghost g-keep-motion">
          <GhostMark size={compact ? 54 : 76} />
        </div>
        {icon && <div className="lx-empty__badge">{icon}</div>}
        <div className="lx-empty__shadow g-keep-motion" />
      </div>
      <div className="lx-empty__title">{title}</div>
      {body && <div className="lx-empty__body">{body}</div>}
      {actions && <div className="lx-empty__actions">{actions}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Animated lists: FLIP + exit presence for keyed children of one container

export interface Box {
  top: number
  left: number
  width: number
  height: number
}

export interface PresenceEntry<T> {
  key: string
  data: T
  /** True while the entry plays its exit animation (it's out of flow at its last position). */
  leaving: boolean
  /** Last laid-out box (offset coordinates), for leaving entries: position them absolutely there. */
  box: Box | null
}

/**
 * Keeps removed entries around for `exitMs` so they can animate out, and FLIP-animates every
 * child with a `data-flip` attribute whenever its laid-out position changes between renders
 * (x and y, so it works for grids too). New children slide in (after the first render).
 * Children are matched by `data-flip` = key; leaving children must carry data-leaving="true".
 * `entries` must be memoised (a new array identity means "the list changed").
 */
export function useAnimatedList<T>(
  container: RefObject<HTMLElement | null>,
  entries: { key: string; data: T }[],
  opts: { exitMs?: number; enterFrom?: number; disabled?: boolean; enter?: 'slide' | 'pop' } = {}
): PresenceEntry<T>[] {
  const exitMs = opts.exitMs ?? 260
  const boxes = useRef(new Map<string, Box>())
  const first = useRef(true)
  type Gone = { data: T; box: Box | null; at: number }
  const [snap, setSnap] = useState<{ entries: { key: string; data: T }[]; leaving: Map<string, Gone> }>(() => ({ entries, leaving: new Map() }))

  // derived state: diff against the previous entries during render (no flash of missing rows)
  let view = snap
  if (snap.entries !== entries) {
    const cur = new Set(entries.map((e) => e.key))
    const leaving = new Map(snap.leaving)
    const now = performance.now()
    for (const e of snap.entries) if (!cur.has(e.key)) leaving.set(e.key, { data: e.data, box: boxes.current.get(e.key) ?? null, at: now })
    for (const k of [...leaving.keys()]) if (cur.has(k)) leaving.delete(k)
    view = { entries, leaving }
    setSnap(view)
  }

  // purge finished exits. Timed from the oldest exit: a list that re-renders more often than
  // exitMs (Downloads, 4×/s while downloading) used to push the timer back forever.
  useEffect(() => {
    if (!snap.leaving.size) return
    let oldest = Infinity
    for (const v of snap.leaving.values()) oldest = Math.min(oldest, v.at)
    const t = window.setTimeout(
      () => {
        const now = performance.now()
        setSnap((s) => {
          const leaving = new Map([...s.leaving].filter(([, v]) => now - v.at < exitMs - 5))
          return leaving.size === s.leaving.size ? s : { ...s, leaving }
        })
      },
      Math.max(0, oldest + exitMs - performance.now())
    )
    return () => window.clearTimeout(t)
  }, [snap, exitMs])

  // FLIP after every commit
  useLayoutEffect(() => {
    const el = container.current
    // Hidden (a closed overlay is display:none, and still re-renders as it closes): every box
    // would measure 0,0 and the next open would fly every row in from the corner. Keep the old.
    if (!el || el.getClientRects().length === 0) return
    // measure everything first, then write: reading offsets between tween writes forced a
    // style recalc per moved row
    const seen = new Map<string, Box>()
    const laid: [HTMLElement, string, Box][] = []
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const k = child.dataset.flip
      if (!k || child.dataset.leaving === 'true') continue
      const box = { top: child.offsetTop, left: child.offsetLeft, width: child.offsetWidth, height: child.offsetHeight }
      seen.set(k, box)
      laid.push([child, k, box])
    }
    for (const [child, k, box] of opts.disabled ? [] : laid) {
      const prev = boxes.current.get(k)
      if (prev === undefined) {
        if (first.current) continue
        if (opts.enter === 'pop') tween(child).clear().set({ opacity: 0, scale: 0.85 }).fadeIn(220, 'outQuad').scaleTo(1, 700, 'outElasticHalf')
        else tween(child).clear().set({ opacity: 0, x: opts.enterFrom ?? 22 }).fadeIn(260, 'outQuad').moveToX(0, 480, 'outQuint')
      } else if (Math.abs(prev.top - box.top) > 0.5 || Math.abs(prev.left - box.left) > 0.5) {
        const cur = tween.get(child)
        tween(child)
          .set({ x: prev.left - box.left + cur.x, y: prev.top - box.top + cur.y })
          .moveTo(0, 0, 520, 'outQuint')
      }
    }
    for (const [k, v] of view.leaving) if (!seen.has(k) && v.box) seen.set(k, v.box)
    boxes.current = seen
    first.current = false
  })

  const out: PresenceEntry<T>[] = view.entries.map((e) => ({ key: e.key, data: e.data, leaving: false, box: null }))
  for (const [k, v] of view.leaving) out.push({ key: k, data: v.data, leaving: true, box: v.box })
  return out
}

/** Inline style for a leaving entry (absolute at its last box). */
export const leavingStyle = (box: Box | null): CSSProperties | undefined =>
  box ? { top: box.top, left: box.left, width: box.width, height: box.height } : undefined
