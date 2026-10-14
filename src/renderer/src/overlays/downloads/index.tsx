// Downloads overlay (green hue): Active · Queued · Completed · Failed, live from
// `downloads:changed`. Every row lives in one keyed list, so items glide between sections
// (FLIP) as their status changes; removed rows fade out in place.
import { Ban, CircleAlert, CircleCheck, Compass, Download, FolderOpen, FolderSearch, ListX, LoaderCircle, Play, RotateCw, Trash, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from 'react'
import type { DownloadItem } from '@shared/types'
import { ghost } from '../../ghost'
import { trackActions } from '../../lib/track-actions'
import { navigate } from '../../shell/navigation'
import type { OverlayProps } from '../../shell/types'
import { sfx } from '../../sound'
import { useUI } from '../../state/ui'
import { isMac } from '../../theme'
import { Button } from '../../ui/Button'
import { openContextMenu, type MenuItem } from '../../ui/ContextMenu'
import { CoverArt } from '../../ui/CoverArt'
import { formatTime } from '../../ui/format'
import { IconButton } from '../../ui/IconButton'
import { LoadingRing } from '../../ui/LoadingRing'
import { OverlayHeader } from '../../ui/OverlayHeader'
import { ProgressRing } from '../../ui/ProgressRing'
import { ScrollArea } from '../../ui/ScrollArea'
import { cx } from '../../ui/util'
import { EmptyState, formatBytes, leavingStyle, plural, relativeTime, useAnimatedList, useNow } from '../library/common'
import './downloads.css'

/** Props: open, phase ('entering' | 'open' | 'exiting' | 'closed'), close(), hue. */
export type DownloadsOverlayProps = OverlayProps

type Section = 'active' | 'queued' | 'done' | 'failed'
const SECTION_OF: Record<DownloadItem['status'], Section> = {
  resolving: 'active',
  downloading: 'active',
  tagging: 'active',
  queued: 'queued',
  done: 'done',
  error: 'failed',
  canceled: 'failed'
}
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'queued', label: 'Queued' },
  { id: 'failed', label: 'Failed' },
  { id: 'done', label: 'Completed' }
]
const MAX_QUEUED = 60
const revealLabel = isMac ? 'Reveal in Finder' : 'Show in folder'

interface Rate {
  bytes: number
  t: number
  /** Smoothed bytes per second. */
  bps: number
}

type Row =
  | { type: 'header'; section: Section; count: number }
  | { type: 'item'; item: DownloadItem; index: number }
  | { type: 'more'; count: number }

export default function DownloadsOverlay({ open }: DownloadsOverlayProps) {
  const [items, setItems] = useState<DownloadItem[] | null>(null)
  const latest = useRef<DownloadItem[] | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const rates = useRef(new Map<string, Rate>())
  const list = useRef<HTMLDivElement>(null)
  const now = useNow(30000, open)

  useEffect(() => {
    const apply = (next: DownloadItem[]) => {
      const t = performance.now()
      const seen = new Set<string>()
      for (const d of next) {
        seen.add(d.id)
        if (SECTION_OF[d.status] !== 'active') {
          rates.current.delete(d.id)
          continue
        }
        const prev = rates.current.get(d.id)
        if (!prev) rates.current.set(d.id, { bytes: d.bytes, t, bps: 0 })
        else {
          const dt = (t - prev.t) / 1000
          if (dt < 0.15) continue
          const inst = Math.max(0, (d.bytes - prev.bytes) / dt)
          rates.current.set(d.id, { bytes: d.bytes, t, bps: prev.bps ? prev.bps * 0.65 + inst * 0.35 : inst })
        }
      }
      for (const k of [...rates.current.keys()]) if (!seen.has(k)) rates.current.delete(k)
      latest.current = next
      // keep sampling speeds while closed, but only re-render while visible
      if (openRef.current) setItems(next)
    }
    void ghost().downloads.list().then(apply)
    return ghost().on('downloads:changed', apply)
  }, [])
  useEffect(() => {
    if (open && latest.current) setItems(latest.current)
  }, [open])

  const groups = useMemo(() => {
    const g: Record<Section, DownloadItem[]> = { active: [], queued: [], done: [], failed: [] }
    for (const d of items ?? []) g[SECTION_OF[d.status]].push(d)
    // queue in the order it'll run (oldest first); finished newest first
    g.queued.sort((a, b) => a.createdAt - b.createdAt)
    g.active.sort((a, b) => a.createdAt - b.createdAt)
    g.done.sort((a, b) => b.createdAt - a.createdAt)
    g.failed.sort((a, b) => b.createdAt - a.createdAt)
    return g
  }, [items])

  const entries = useMemo(() => {
    const out: { key: string; data: Row }[] = []
    for (const s of SECTIONS) {
      const arr = groups[s.id]
      if (!arr.length) continue
      out.push({ key: `h:${s.id}`, data: { type: 'header', section: s.id, count: arr.length } })
      const shown = s.id === 'queued' ? arr.slice(0, MAX_QUEUED) : arr
      shown.forEach((item, index) => out.push({ key: item.id, data: { type: 'item', item, index } }))
      if (shown.length < arr.length) out.push({ key: 'more:queued', data: { type: 'more', count: arr.length - shown.length } })
    }
    return out
  }, [groups])

  const rows = useAnimatedList(list, entries, { exitMs: 280 })

  // ---- summary -------------------------------------------------------------------------
  const pending = [...groups.active, ...groups.queued]
  const totalBps = groups.active.reduce((s, d) => s + (rates.current.get(d.id)?.bps ?? 0), 0)
  const knownTotal = pending.reduce((s, d) => s + (d.totalBytes ?? 0), 0)
  const knownDone = pending.reduce((s, d) => s + (d.totalBytes ? Math.min(d.bytes, d.totalBytes) : 0), 0)
  const overall = knownTotal > 0 ? knownDone / knownTotal : null
  const etaSec = totalBps > 1 && knownTotal > 0 ? (knownTotal - knownDone) / totalBps : null
  const finished = groups.done.length + groups.failed.length

  const errored = groups.failed.filter((d) => d.status === 'error').length
  const canceled = groups.failed.length - errored
  const problems = [errored && `${errored} failed`, canceled && `${canceled} canceled`]
  const desc = !items
    ? 'Loading…'
    : pending.length
      ? [groups.active.length && `${groups.active.length} active`, groups.queued.length && `${groups.queued.length.toLocaleString()} queued`, ...problems].filter(Boolean).join(' · ')
      : items.length
        ? [groups.done.length ? `All done · ${plural(groups.done.length, 'file')} saved` : 'Nothing downloading', ...problems].filter(Boolean).join(' · ')
        : 'Nothing downloading'

  // ---- actions -------------------------------------------------------------------------
  const cancel = (d: DownloadItem) => {
    sfx.play('back', { volume: 0.7 })
    void ghost().downloads.cancel(d.id)
  }
  const retry = (d: DownloadItem) => {
    sfx.play('confirm', { volume: 0.7 })
    void ghost().downloads.retry(d.id)
  }
  const reveal = (d: DownloadItem) => {
    if (d.path) void ghost().system.reveal(d.path)
    else void ghost().downloads.reveal(d.id)
  }
  const clearFinished = () => {
    sfx.play('back', { volume: 0.7 })
    void ghost().downloads.clearFinished()
  }
  const cancelAll = (section: Section) => {
    sfx.play('back', { volume: 0.7 })
    for (const d of groups[section]) void ghost().downloads.cancel(d.id)
  }
  const retryAll = () => {
    sfx.play('confirm', { volume: 0.7 })
    for (const d of groups.failed) void ghost().downloads.retry(d.id)
  }

  const menu = (e: RMouseEvent, d: DownloadItem) => {
    e.preventDefault()
    const s = SECTION_OF[d.status]
    const ic = (I: typeof Play) => <I size={15} strokeWidth={2} />
    const items: MenuItem[] = [{ heading: d.title }]
    if (s === 'active' || s === 'queued') items.push({ label: 'Cancel download', icon: ic(X), danger: true, onSelect: () => cancel(d) })
    if (s === 'failed') items.push({ label: 'Retry', icon: ic(RotateCw), onSelect: () => retry(d) })
    if (s === 'done') {
      items.push({ label: 'Play', icon: ic(Play), onSelect: () => void trackActions.play([d.trackId], 0, { kind: 'downloaded', id: null, title: 'Downloads' }) })
      items.push({ label: revealLabel, icon: ic(FolderSearch), onSelect: () => reveal(d) })
    }
    openContextMenu({ x: e.clientX, y: e.clientY }, items)
  }

  return (
    <div className="dl">
      <OverlayHeader
        icon={<Download />}
        title="Downloads"
        description={desc}
        actions={
          <>
            <IconButton icon={<ListX />} label="Clear finished" disabled={!finished} onClick={clearFinished} />
            <IconButton icon={<FolderOpen />} label="Open downloads folder" onClick={() => void ghost().downloads.openFolder()} />
          </>
        }
      />

      <div className={cx('dl-overall', pending.length > 0 && 'dl-overall--on')} aria-hidden={!pending.length}>
        <div className="dl-overall__inner">
          <div className="dl-overall__row tnum">
            <span className="dl-overall__title">
              {groups.active.length ? (
                <>
                  Downloading <b>{plural(pending.length, 'track')}</b>
                </>
              ) : (
                'Waiting to start…'
              )}
            </span>
            <span className="dl-overall__stats">
              {totalBps > 0 && <span>{formatBytes(totalBps)}/s</span>}
              {etaSec !== null && etaSec > 0 && <span>{formatEta(etaSec)} left</span>}
              {overall !== null && <b>{Math.floor(overall * 100)}%</b>}
            </span>
          </div>
          <div className="dl-overall__bar">
            <div className="dl-overall__fill" style={{ transform: `scaleX(${overall ?? 0})` }} />
            {overall === null && <div className="dl-overall__indet g-keep-motion" />}
          </div>
        </div>
      </div>

      <ScrollArea className="dl-scroll">
        {!items ? (
          <LoadingRing center />
        ) : !items.length ? (
          <EmptyState
            icon={<Download />}
            title="No downloads yet"
            body="Download a track, an album, a playlist or your whole queue to listen offline. Progress shows up here."
            actions={
              <>
                <Button
                  variant="soft"
                  hue="browse"
                  icon={<Compass />}
                  onClick={() => {
                    useUI.getState().toggleOverlay('downloads', false)
                    navigate('browse')
                  }}
                >
                  Browse music
                </Button>
                <Button variant="ghost" icon={<FolderOpen />} onClick={() => void ghost().downloads.openFolder()}>
                  Open folder
                </Button>
              </>
            }
          />
        ) : null}
        <div ref={list} className="dl-list" hidden={!items?.length}>
          {rows.map(({ key, data, leaving, box }) => {
            const common = { 'data-flip': key, 'data-leaving': leaving || undefined, style: leaving ? leavingStyle(box) : undefined }
            if (data.type === 'header') {
              const s = data.section
              return (
                <div key={key} {...common} className={cx('dl-head', `dl-head--${s}`)}>
                  <span className="dl-head__label">{s === 'failed' ? failedLabel(groups.failed) : SECTIONS.find((x) => x.id === s)!.label}</span>
                  <span className="lx-count">{data.count.toLocaleString()}</span>
                  <span className="dl-head__line" />
                  {s === 'queued' && data.count > 1 && (
                    <button type="button" className="dl-head__btn" onClick={() => cancelAll('queued')}>
                      <Ban /> Cancel all
                    </button>
                  )}
                  {s === 'failed' && data.count > 1 && (
                    <button type="button" className="dl-head__btn" onClick={retryAll}>
                      <RotateCw /> Retry all
                    </button>
                  )}
                  {s === 'done' && (
                    <button type="button" className="dl-head__btn" onClick={clearFinished}>
                      <Trash /> Clear
                    </button>
                  )}
                </div>
              )
            }
            if (data.type === 'more') {
              return (
                <div key={key} {...common} className="dl-more">
                  + {data.count.toLocaleString()} more queued
                </div>
              )
            }
            const d = data.item
            const s = SECTION_OF[d.status]
            const rate = rates.current.get(d.id)
            return (
              <div key={key} {...common} className={cx('dl-item', `dl-item--${s}`)} onContextMenu={(e) => menu(e, d)} onDoubleClick={() => s === 'done' && reveal(d)}>
                <ItemArt d={d} section={s} index={data.index} />
                <div className="dl-item__text">
                  <div className="dl-item__title g-ellipsis" title={d.title}>
                    {d.title}
                  </div>
                  <div className="dl-item__sub g-ellipsis">{[d.gameName, d.albumTitle].filter(Boolean).join(' · ')}</div>
                  {s === 'active' && (
                    <>
                      <div className="dl-item__bar">
                        <div className="dl-item__fill" style={{ transform: `scaleX(${d.status === 'tagging' ? 1 : d.progress})` }} />
                      </div>
                      <div className="dl-item__stats tnum">{activeStats(d, rate)}</div>
                    </>
                  )}
                  {s === 'done' && (
                    <div className="dl-item__stats tnum">
                      <CircleCheck className="dl-ok" /> Saved{d.totalBytes ? ` · ${formatBytes(d.totalBytes)}` : ''} · {relativeTime(d.createdAt, now)}
                    </div>
                  )}
                  {s === 'failed' && (
                    <div className={cx('dl-item__error', d.status === 'canceled' && 'dl-item__error--muted')} title={d.error ?? undefined}>
                      {d.status === 'canceled' ? <Ban /> : <CircleAlert />}
                      <span className="g-ellipsis">{d.status === 'canceled' ? 'Canceled' : d.error || 'Download failed'}</span>
                    </div>
                  )}
                </div>
                <div className="dl-item__actions">
                  {(s === 'active' || s === 'queued') && <IconButton size="sm" icon={<X />} label="Cancel" sound={false} onClick={() => cancel(d)} />}
                  {s === 'done' && <IconButton size="sm" icon={<FolderSearch />} label={revealLabel} onClick={() => reveal(d)} />}
                  {s === 'failed' && (
                    <Button size="sm" variant="soft" icon={<RotateCw />} sound={false} onClick={() => retry(d)}>
                      Retry
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

function ItemArt({ d, section, index }: { d: DownloadItem; section: Section; index: number }) {
  if (section === 'active') {
    const indeterminate = d.status === 'resolving' || (d.status === 'downloading' && !d.totalBytes)
    return (
      <div className="dl-item__art dl-item__art--ring">
        <ProgressRing value={indeterminate ? null : d.status === 'tagging' ? 1 : d.progress} size={50} thickness={3}>
          <CoverArt src={d.cover} size={38} radius={19} ring={false} />
        </ProgressRing>
        <span className="dl-item__pct tnum">{indeterminate ? <LoaderCircle className="dl-spin g-keep-motion" /> : `${Math.floor((d.status === 'tagging' ? 1 : d.progress) * 100)}%`}</span>
      </div>
    )
  }
  return (
    <div className="dl-item__art">
      {section === 'queued' && <span className="dl-item__pos tnum">{index + 1}</span>}
      <CoverArt src={d.cover} size={section === 'queued' ? 32 : 40} radius={8} />
    </div>
  )
}

function activeStats(d: DownloadItem, rate: Rate | undefined) {
  if (d.status === 'resolving') return 'Finding the best source…'
  if (d.status === 'tagging') return 'Writing tags & artwork…'
  const parts: string[] = []
  parts.push(d.totalBytes ? `${formatBytes(d.bytes)} / ${formatBytes(d.totalBytes)}` : formatBytes(d.bytes))
  if (rate && rate.bps > 0) {
    parts.push(`${formatBytes(rate.bps)}/s`)
    if (d.totalBytes) parts.push(`${formatEta((d.totalBytes - d.bytes) / rate.bps)} left`)
  }
  return parts.join(' · ')
}

function failedLabel(list: DownloadItem[]): string {
  const canceled = list.filter((d) => d.status === 'canceled').length
  if (!canceled) return 'Failed'
  return canceled === list.length ? 'Canceled' : 'Failed & canceled'
}

function formatEta(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–'
  if (sec < 1) return 'a moment'
  if (sec < 60) return `${Math.ceil(sec)} s`
  if (sec < 3600) return formatTime(sec * 1000)
  const h = Math.floor(sec / 3600)
  return `${h} h ${Math.round((sec % 3600) / 60)} min`
}
