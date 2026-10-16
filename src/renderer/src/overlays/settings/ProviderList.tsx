// Source priority: drag to reorder, toggle to enable. Writes settings.sources.order / disabled.
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type Modifier } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Archive, AudioWaveform, Cloud, Cpu, Disc3, GripVertical, HardDrive, Landmark, LibraryBig, TvMinimalPlay } from 'lucide-react'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { withKnownSources } from '@shared/defaults'
import type { CatalogStatus, SourceIndexStatus, SourceStat } from '@shared/types'
import { ghost } from '../../ghost'
import { sfx } from '../../sound'
import { useSettings } from '../../state/settings'
import { Toggle } from '../../ui/Toggle'
import { cx } from '../../ui/util'
import { formatEta, formatEvery } from '../../screens/browse/activity'
import { relativeTime } from '../library/common'
import { Highlight, patchSettings } from './controls'

export const PROVIDERS: Record<string, { name: string; icon: ReactNode; description: string; tone: string }> = {
  local: { name: 'Local files', icon: <HardDrive />, description: 'Your own music folders: their albums show up in Browse, and catalog tracks you have play from them. Always the fastest.', tone: '#9aa6c4' },
  chip: { name: 'Chiptune rips', icon: <Cpu />, description: 'Original sound-chip files (NSF, SPC, VGM…) rendered live with real loop points.', tone: '#5ee6a0' },
  bandcamp: { name: 'Bandcamp', icon: <Disc3 />, description: 'Official releases straight from composers and labels, searched on demand.', tone: '#4fc3e8' },
  khinsider: { name: 'KHInsider', icon: <Archive />, description: 'The big video game music archive: MP3 and FLAC album rips.', tone: '#f6c75c' },
  zophar: { name: 'Zophar’s Domain', icon: <LibraryBig />, description: 'Per-track MP3 rips of about 19,000 games, including PlayStation, DS, GBA and N64 sets.', tone: '#7fd6a8' },
  modland: { name: 'Modland', icon: <AudioWaveform />, description: 'Original SNES, NES, Game Boy and Sega sound files, emulated live with real loop points.', tone: '#6fc4ff' },
  archive: { name: 'Internet Archive', icon: <Landmark />, description: 'Curated game soundtrack collections, plus anything on archive.org when you use Search online.', tone: '#c9b8ff' },
  soundcloud: { name: 'SoundCloud', icon: <Cloud />, description: 'Last resort: full-soundtrack uploads, searched only when no other source has a track.', tone: '#ff9f5a' },
  youtube: { name: 'YouTube', icon: <TvMinimalPlay />, description: 'Last resort: full-soundtrack uploads and playlists, searched only when no other source has a track.', tone: '#ff6b6b' }
}

/** Albums per source (refreshed while the catalog indexes) plus each crawl's live state. */
function useSourceStats(): { stats: Map<string, SourceStat>; live: Map<string, SourceIndexStatus> } {
  const [stats, setStats] = useState<Map<string, SourceStat>>(new Map())
  const [live, setLive] = useState<Map<string, SourceIndexStatus>>(new Map())
  useEffect(() => {
    let alive = true
    let last = 0
    let timer = 0
    const load = () => {
      last = Date.now()
      void ghost()
        .catalog.sources()
        .then((list) => alive && setStats(new Map(list.map((x) => [x.id, x]))))
        .catch(() => {})
    }
    load()
    const onStatus = (st: CatalogStatus) => setLive(new Map((st.sources ?? []).map((x) => [x.id, x])))
    void ghost()
      .catalog.status()
      .then((st) => alive && onStatus(st))
      .catch(() => {})
    const off = ghost().on('catalog:status', (st) => {
      onStatus(st)
      if (timer) return
      timer = window.setTimeout(() => {
        timer = 0
        load()
      }, Math.max(0, 4000 - (Date.now() - last)))
    })
    return () => {
      alive = false
      window.clearTimeout(timer)
      off()
    }
  }, [])
  return { stats, live }
}

function statLine(id: string, st: SourceStat | undefined, run: SourceIndexStatus | undefined): string | null {
  const albums = st?.albums ? `${st.albums.toLocaleString()} albums` : null
  if (run?.state === 'running') {
    const what = run.initial ? 'Adding for the first time' : 'Refreshing'
    const pct = run.progress != null ? ` ${Math.round(run.progress * 100)}%` : ''
    return [albums, `${what}…${pct}`, run.etaMs != null ? `${formatEta(run.etaMs)} left` : null].filter(Boolean).join(' · ')
  }
  if (run?.state === 'waiting') return [albums, run.initial ? 'Waiting to be added' : 'Refresh queued'].filter(Boolean).join(' · ')
  if (!st) return null
  if (!st.albums) return id === 'local' ? null : id === 'youtube' || id === 'soundcloud' || id === 'bandcamp' ? 'Searched on demand' : null
  const when = st.lastIndexedAt ? `indexed ${relativeTime(st.lastIndexedAt)}` : null
  return [albums, when, run ? `refreshes ${formatEvery(run.refreshEveryMs)}` : null].filter(Boolean).join(' · ')
}

const lockY: Modifier = ({ transform }) => ({ ...transform, x: 0 })

/** Saved order, plus any known provider missing from it (appended in default order). */
function effectiveOrder(order: string[]): string[] {
  return withKnownSources(order)
}

export function ProviderList() {
  const order = effectiveOrder(useSettings((s) => s.sources.order))
  const disabled = useSettings((s) => s.sources.disabled)
  const [active, setActive] = useState<string | null>(null)
  const { stats, live } = useSourceStats()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))

  const onDragEnd = (e: DragEndEvent) => {
    setActive(null)
    if (!e.over || e.active.id === e.over.id) return
    const next = arrayMove(order, order.indexOf(String(e.active.id)), order.indexOf(String(e.over.id)))
    sfx.play('confirm', { volume: 0.6 })
    void patchSettings({ sources: { order: next } })
  }

  const toggle = (id: string, on: boolean) => {
    const next = on ? disabled.filter((x) => x !== id) : [...new Set([...disabled, id])]
    void patchSettings({ sources: { disabled: next } })
  }

  const enabledCount = order.filter((id) => !disabled.includes(id)).length

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[lockY]}
      onDragStart={(e) => {
        setActive(String(e.active.id))
        sfx.play('select', { volume: 0.6 })
      }}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActive(null)}
    >
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <ol className="set-prov">
          {order.map((id, i) => (
            <ProviderRow key={id} id={id} rank={i + 1} stat={statLine(id, stats.get(id), live.get(id))} enabled={!disabled.includes(id)} lastEnabled={enabledCount === 1 && !disabled.includes(id)} dragging={active === id} onToggle={toggle} />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  )
}

function ProviderRow({ id, rank, stat, enabled, lastEnabled, dragging, onToggle }: { id: string; rank: number; stat: string | null; enabled: boolean; lastEnabled: boolean; dragging: boolean; onToggle: (id: string, on: boolean) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({ id, transition: { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' } })
  // pointer drags start anywhere on the row; keyboard drags (Space, arrows, Space) only from the grip
  const { onKeyDown, ...pointer } = (listeners ?? {}) as Record<string, (e: unknown) => void>
  const p = PROVIDERS[id] ?? { name: id, icon: <Disc3 />, description: 'Custom source', tone: '#9aa6c4' }
  return (
    <li
      ref={setNodeRef}
      className={cx('set-prov__item', !enabled && 'set-prov__item--off', dragging && 'set-prov__item--drag')}
      style={{ transform: CSS.Translate.toString(transform), transition, '--tone': p.tone } as CSSProperties}
      {...pointer}
    >
      <span ref={setActivatorNodeRef} className="set-prov__grip" {...attributes} aria-label={`Reorder ${p.name}`} onKeyDown={(e) => onKeyDown?.(e)}>
        <GripVertical />
      </span>
      <span className="set-prov__rank tnum">{rank}</span>
      <span className="set-prov__icon">{p.icon}</span>
      <span className="set-prov__text">
        <span className="set-prov__name">
          <Highlight text={p.name} />
        </span>
        <span className="set-prov__desc">
          <Highlight text={p.description} />
        </span>
        {stat && <span className="set-prov__stat tnum">{stat}</span>}
      </span>
      <span onPointerDown={(e) => e.stopPropagation()} title={lastEnabled ? 'At least one source must stay on' : undefined}>
        <Toggle checked={enabled} disabled={lastEnabled} onChange={(on) => onToggle(id, on)} aria-label={`${enabled ? 'Disable' : 'Enable'} ${p.name}`} />
      </span>
    </li>
  )
}
