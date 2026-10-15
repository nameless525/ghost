// Library overlay (blue hue, slides in from the right): Playlists · Liked · History · Downloaded.
// Tabs keep their state while hidden; switching slides the panels in the direction of travel.
import { ClockFading, HardDriveDownload, Heart, LibraryBig, ListMusic } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type ReactNode } from 'react'
import { ghost } from '../../ghost'
import { initPlaylistCache, usePlaylistCache } from '../../lib/track-actions'
import { tween } from '../../motion/tween'
import type { OverlayProps } from '../../shell/types'
import { useKeybinding } from '../../shell/keys'
import { sfx } from '../../sound'
import { OverlayHeader } from '../../ui/OverlayHeader'
import { cx } from '../../ui/util'
import { plural, useLive } from './common'
import { PlaylistsTab } from './PlaylistsTab'
import { SnackHost } from './Snack'
import { DownloadedTab, HistoryTab, LikedTab } from './TrackTabs'
import './library.css'

/** Props: open, phase ('entering' | 'open' | 'exiting' | 'closed'), close(), hue. */
export type LibraryOverlayProps = OverlayProps

type TabId = 'playlists' | 'liked' | 'history' | 'downloaded'
const TABS: { id: TabId; label: string; icon: ReactNode; key: string }[] = [
  { id: 'playlists', label: 'Playlists', icon: <ListMusic />, key: 'Mod+1' },
  { id: 'liked', label: 'Liked', icon: <Heart />, key: 'Mod+2' },
  { id: 'history', label: 'History', icon: <ClockFading />, key: 'Mod+3' },
  { id: 'downloaded', label: 'Downloaded', icon: <HardDriveDownload />, key: 'Mod+4' }
]
const tabIndex = (t: TabId) => TABS.findIndex((x) => x.id === t)

export default function LibraryOverlay({ open }: LibraryOverlayProps) {
  const [tab, setTab] = useState<TabId>('playlists')
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set(['playlists']))
  const [enterSeq, setEnterSeq] = useState(0)
  const panels = useRef(new Map<TabId, HTMLDivElement>())
  const prevTab = useRef<TabId>(tab)

  useEffect(() => initPlaylistCache(), [])
  const playlistCount = usePlaylistCache((s) => s.playlists.length)
  const liked = useLive(() => ghost().library.liked(), ['likes'], open)
  // refetched (300 rows) on every play: only while its tab is showing; it catches up on return
  const history = useLive(() => ghost().library.history(300), ['history', 'likes'], open && tab === 'history')
  const downloaded = useLive(() => ghost().library.downloaded(), ['downloaded', 'likes'], open)

  const select = (t: TabId) => {
    if (t === tab) return
    setVisited((v) => (v.has(t) ? v : new Set([...v, t])))
    setTab(t)
  }

  // slide panels in the direction of travel
  useLayoutEffect(() => {
    const prev = prevTab.current
    if (prev === tab) return
    prevTab.current = tab
    const dir = tabIndex(tab) > tabIndex(prev) ? 1 : -1
    const out = panels.current.get(prev)
    const inn = panels.current.get(tab)
    if (out)
      void tween(out)
        .clear()
        .fadeOut(150, 'outQuad')
        .moveToX(-dir * 36, 360, 'outQuint')
        .then(() => {
          if (prevTab.current !== prev) out.style.visibility = 'hidden'
        })
    if (inn) {
      inn.style.visibility = ''
      tween(inn).clear().set({ opacity: 0, x: dir * 48 }).delay(40).fadeIn(260, 'outQuad').moveToX(0, 560, 'outQuint')
    }
    if (tab === 'playlists') setEnterSeq((n) => n + 1)
  }, [tab])

  // replay the entrance each time the overlay opens
  useEffect(() => {
    if (open && tab === 'playlists') setEnterSeq((n) => n + 1)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useKeybinding(
    TABS.map((t) => t.key),
    (e) => {
      const t = TABS[Number(e.key) - 1]
      if (!t) return false
      sfx.play('select', { volume: 0.7 })
      select(t.id)
    }
  )

  const counts: Record<TabId, number | null> = {
    playlists: playlistCount || null,
    liked: liked.data?.length || null,
    history: null,
    downloaded: downloaded.data?.length || null
  }

  const desc = [plural(playlistCount, 'playlist'), liked.data ? `${liked.data.length.toLocaleString()} liked` : null, downloaded.data ? `${downloaded.data.length.toLocaleString()} offline` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="lib">
      <OverlayHeader icon={<LibraryBig />} title="Library" description={desc || 'Playlists · Liked · History · Downloaded'} />
      <Tabs value={tab} onChange={select} counts={counts} />
      <div className="lib-panels">
        {TABS.map((t) =>
          visited.has(t.id) ? (
            <div
              key={t.id}
              ref={(el) => {
                if (el) panels.current.set(t.id, el)
              }}
              className={cx('lib-panel', tab === t.id && 'lib-panel--active')}
              role="tabpanel"
              id={`lib-panel-${t.id}`}
              aria-labelledby={`lib-tab-${t.id}`}
              inert={tab !== t.id || undefined}
            >
              {t.id === 'playlists' && <PlaylistsTab active={open && tab === 'playlists'} enterSeq={enterSeq} />}
              {t.id === 'liked' && <LikedTab live={liked} />}
              {t.id === 'history' && <HistoryTab live={history} active={open && tab === 'history'} />}
              {t.id === 'downloaded' && <DownloadedTab live={downloaded} active={open && tab === 'downloaded'} />}
            </div>
          ) : null
        )}
      </div>
      <SnackHost host="library" />
    </div>
  )
}

function Tabs({ value, onChange, counts }: { value: TabId; onChange: (t: TabId) => void; counts: Record<TabId, number | null> }) {
  const root = useRef<HTMLDivElement>(null)
  const ind = useRef<HTMLDivElement>(null)
  const first = useRef(true)

  useLayoutEffect(() => {
    const r = root.current
    const i = ind.current
    if (!r || !i) return
    const update = () => {
      const btn = r.querySelector<HTMLElement>('[aria-selected="true"]')
      if (!btn) return
      if (first.current) i.style.transition = 'none'
      i.style.width = `${btn.offsetWidth - 16}px`
      i.style.transform = `translateX(${btn.offsetLeft + 8}px)`
      if (first.current) {
        void i.offsetWidth
        i.style.transition = ''
        first.current = false
      }
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(r)
    return () => ro.disconnect()
  }, [value, counts.playlists, counts.liked, counts.downloaded])

  const onKeyDown = (e: RKeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation()
    const i = tabIndex(value)
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length]
    sfx.play('select', { volume: 0.6 })
    onChange(next.id)
    root.current?.querySelector<HTMLElement>(`#lib-tab-${next.id}`)?.focus()
  }

  return (
    <div ref={root} className="lib-tabs" role="tablist" aria-label="Library sections" onKeyDown={onKeyDown}>
      {TABS.map((t) => {
        const on = t.id === value
        return (
          <button
            key={t.id}
            id={`lib-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={`lib-panel-${t.id}`}
            tabIndex={on ? 0 : -1}
            className={cx('lib-tab', on && 'lib-tab--on')}
            title={t.label}
            onPointerEnter={() => sfx.play('hover')}
            onClick={() => {
              if (on) return
              sfx.play('select', { volume: 0.7 })
              onChange(t.id)
            }}
          >
            {t.icon}
            <span>{t.label}</span>
            {counts[t.id] != null && <span className="lib-tab__count tnum">{counts[t.id]}</span>}
          </button>
        )
      })}
      <div ref={ind} className="lib-tabs__ind" />
    </div>
  )
}
