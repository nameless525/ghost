// Source priority: drag to reorder, toggle to enable. Writes settings.sources.order / disabled.
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type Modifier } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Archive, Cpu, Disc3, GripVertical, HardDrive, Landmark, TvMinimalPlay } from 'lucide-react'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { DEFAULT_SOURCE_ORDER } from '@shared/defaults'
import { sfx } from '../../sound'
import { useSettings } from '../../state/settings'
import { Toggle } from '../../ui/Toggle'
import { cx } from '../../ui/util'
import { Highlight, patchSettings } from './controls'

export const PROVIDERS: Record<string, { name: string; icon: ReactNode; description: string; tone: string }> = {
  local: { name: 'Local files', icon: <HardDrive />, description: 'Your own music folders, matched to the catalog. Always the fastest.', tone: '#9aa6c4' },
  chip: { name: 'Chiptune rips', icon: <Cpu />, description: 'Original sound-chip files (NSF, SPC, VGM…) rendered live with real loop points.', tone: '#5ee6a0' },
  bandcamp: { name: 'Bandcamp', icon: <Disc3 />, description: 'Official releases straight from composers and labels.', tone: '#4fc3e8' },
  khinsider: { name: 'KHInsider', icon: <Archive />, description: 'The big video game music archive: MP3 and FLAC album rips.', tone: '#f6c75c' },
  archive: { name: 'Internet Archive', icon: <Landmark />, description: 'Soundtracks and rips preserved on archive.org.', tone: '#c9b8ff' },
  youtube: { name: 'YouTube', icon: <TvMinimalPlay />, description: 'Last resort: full-OST uploads and playlists, via yt-dlp.', tone: '#ff6b6b' }
}

const lockY: Modifier = ({ transform }) => ({ ...transform, x: 0 })

/** Saved order, plus any known provider missing from it (appended in default order). */
function effectiveOrder(order: string[]): string[] {
  const out = order.filter((id, i) => order.indexOf(id) === i)
  for (const id of DEFAULT_SOURCE_ORDER) if (!out.includes(id)) out.push(id)
  return out
}

export function ProviderList() {
  const order = effectiveOrder(useSettings((s) => s.sources.order))
  const disabled = useSettings((s) => s.sources.disabled)
  const [active, setActive] = useState<string | null>(null)
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
            <ProviderRow key={id} id={id} rank={i + 1} enabled={!disabled.includes(id)} lastEnabled={enabledCount === 1 && !disabled.includes(id)} dragging={active === id} onToggle={toggle} />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  )
}

function ProviderRow({ id, rank, enabled, lastEnabled, dragging, onToggle }: { id: string; rank: number; enabled: boolean; lastEnabled: boolean; dragging: boolean; onToggle: (id: string, on: boolean) => void }) {
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
      </span>
      <span onPointerDown={(e) => e.stopPropagation()} title={lastEnabled ? 'At least one source must stay on' : undefined}>
        <Toggle checked={enabled} disabled={lastEnabled} onChange={(on) => onToggle(id, on)} aria-label={`${enabled ? 'Disable' : 'Enable'} ${p.name}`} />
      </span>
    </li>
  )
}
