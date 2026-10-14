// lazer-style footer: sheared action buttons with keycap hints, plus the group/sort readout.
import { Download, ListEnd, ListPlus, ListStart, Play, Rewind, Shuffle, Telescope } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { usePlayer } from '../../state/player'
import { openContextMenu } from '../../ui/ContextMenu'
import { Kbd } from '../../ui/Kbd'
import { ShearButton } from '../../ui/ShearButton'
import { Tooltip } from '../../ui/Tooltip'
import { addSelectionToPlaylist, downloadSelection, playSelection, queueSelection } from './actions'
import { activeCarousel } from './carousel'
import { openExternalSearch } from './query'
import { GROUP_LABELS, SORT_LABELS, useBrowse } from './store'

function Label({ children, combo }: { children: ReactNode; combo?: string }) {
  return (
    <span className="bf__label">
      {children}
      {combo && <Kbd combo={combo} size="sm" className="bf__kbd" />}
    </span>
  )
}

const anchor = (el: HTMLElement | null) => {
  const r = el?.getBoundingClientRect()
  return r ? { x: r.left + 8, y: r.top - 6 } : { x: 200, y: window.innerHeight - 80 }
}

export function Footer() {
  // only whether there's a selection: subscribing to `sel` itself re-rendered every button on
  // every key press
  const none = useBrowse((s) => !s.sel)
  const group = useBrowse((s) => s.group)
  const sort = useBrowse((s) => s.sort)
  const historyLen = useBrowse((s) => s.historyLen)
  const total = useBrowse((s) => s.total)
  const playing = usePlayer((s) => s.status === 'playing')
  const queueBtn = useRef<HTMLButtonElement>(null)
  const plBtn = useRef<HTMLButtonElement>(null)

  return (
    <div className="bf">
      <div className="bf__buttons">
        <ShearButton icon={<Shuffle />} label={<Label combo="F2">Random</Label>} soft={!total || total < 2} onClick={() => activeCarousel?.random()} />
        <Tooltip content="Back to the previous random pick" shortcut="Shift+F2">
          <ShearButton icon={<Rewind />} label="Rewind" soft={!historyLen} sound={historyLen ? 'back' : false} onClick={() => activeCarousel?.rewind()} />
        </Tooltip>
        <ShearButton
          ref={queueBtn}
          icon={<ListEnd />}
          label={<Label combo="Q">Queue</Label>}
          soft={none}
          onClick={() => {
            const s = useBrowse.getState().sel
            if (!s) return
            openContextMenu(anchor(queueBtn.current), [
              { heading: 'Queue' },
              { label: 'Play next', icon: <ListStart size={15} />, shortcut: 'Shift+Q', onSelect: () => void queueSelection(s, 'next') },
              { label: 'Add to queue', icon: <ListEnd size={15} />, shortcut: 'Q', onSelect: () => void queueSelection(s, 'end') }
            ])
          }}
        />
        <ShearButton
          ref={plBtn}
          icon={<ListPlus />}
          label={<Label combo="Mod+S">Playlist</Label>}
          soft={none}
          onClick={() => void addSelectionToPlaylist(useBrowse.getState().sel, anchor(plBtn.current))}
        />
        <ShearButton icon={<Download />} label={<Label combo="Mod+D">Download</Label>} soft={none} onClick={() => void downloadSelection(useBrowse.getState().sel)} />
        <Tooltip content="Can’t find it? Search YouTube, Internet Archive and Bandcamp">
          <ShearButton icon={<Telescope />} label="Search elsewhere" className="bf__elsewhere" onClick={() => openExternalSearch()} />
        </Tooltip>
      </div>
      <div className="bf__info">
        <span>
          group <b>{GROUP_LABELS[group].toLowerCase()}</b>
        </span>
        <span className="bf__dot">·</span>
        <span>
          sort <b>{SORT_LABELS[sort].toLowerCase()}</b>
        </span>
        <ShearButton
          className="bf__play"
          size="md"
          icon={<Play />}
          label={<Label combo="Enter">{playing ? 'Play this' : 'Play'}</Label>}
          soft={none}
          sound={false}
          onClick={() => void playSelection(useBrowse.getState().sel)}
        />
      </div>
    </div>
  )
}
