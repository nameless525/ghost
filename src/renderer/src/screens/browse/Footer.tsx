// lazer-style footer: what you can do with the selection, as sheared buttons with keycap hints,
// "More" for the rest of its menu (the same as right-clicking a row) and Play.
import { Download, Ellipsis, ListEnd, ListPlus, Play, Shuffle } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { Kbd } from '../../ui/Kbd'
import { ShearButton } from '../../ui/ShearButton'
import { addSelectionToPlaylist, downloadSelection, playSelection, queueSelection } from './actions'
import { activeCarousel } from './carousel'
import { openSelectionMenu } from './menu'
import { useBrowse } from './store'

function Label({ children, combo }: { children: ReactNode; combo?: string }) {
  return (
    <span className="bf__label">
      <span className="bf__text">{children}</span>
      {combo && <Kbd combo={combo} size="sm" className="bf__kbd" />}
    </span>
  )
}

const sel = () => useBrowse.getState().sel

/** F2's partner: back to where the last random pick came from (Shift+F2, Shift-click or right-click Random). */
function rewind(): void {
  if (activeCarousel?.rewind()) sfx.play('back', { volume: 0.6 })
  else sfx.play('error', { volume: 0.4 })
}

export function Footer() {
  // only whether there's a selection: subscribing to `sel` itself re-rendered every button on
  // every key press
  const none = useBrowse((s) => !s.sel)
  const canRewind = useBrowse((s) => s.historyLen > 0)
  const total = useBrowse((s) => s.total)
  const playing = usePlayer((s) => s.status === 'playing')
  const plBtn = useRef<HTMLButtonElement>(null)
  const moreBtn = useRef<HTMLButtonElement>(null)

  return (
    <div className="bf">
      <div className="bf__buttons">
        <ShearButton
          icon={<Shuffle />}
          label={<Label combo="F2">Random</Label>}
          aria-label="Random"
          tooltip={canRewind ? 'Jump to a random game (right-click or Shift+F2 goes back)' : 'Jump to a random game'}
          shortcut="F2"
          soft={!total || total < 2}
          sound={false}
          onClick={(e) => {
            // (the spin plays its own sound; a soft button already played the error)
            if (e.shiftKey) rewind()
            else activeCarousel?.random()
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            rewind()
          }}
        />
        <ShearButton
          icon={<ListEnd />}
          label={<Label combo="Q">Add to queue</Label>}
          aria-label="Add to queue"
          tooltip="Add to queue (Shift+Q plays it next)"
          shortcut="Q"
          soft={none}
          onClick={(e) => void queueSelection(sel(), e.shiftKey ? 'next' : 'end')}
        />
        <ShearButton
          ref={plBtn}
          icon={<ListPlus />}
          label={<Label combo="Mod+S">Add to playlist</Label>}
          aria-label="Add to playlist"
          tooltip="Add to playlist"
          shortcut="Mod+S"
          soft={none}
          onClick={() => plBtn.current && void addSelectionToPlaylist(sel(), plBtn.current)}
        />
        <ShearButton
          icon={<Download />}
          label={<Label combo="Mod+D">Download</Label>}
          aria-label="Download"
          tooltip="Download, to listen offline"
          shortcut="Mod+D"
          soft={none}
          onClick={() => void downloadSelection(sel())}
        />
      </div>
      <div className="bf__end">
        <ShearButton
          ref={moreBtn}
          className="bf__more"
          icon={<Ellipsis />}
          aria-label="More actions"
          tooltip="More actions (or right-click a row)"
          soft={none}
          onClick={() => {
            const s = sel()
            if (s && moreBtn.current) openSelectionMenu(s, moreBtn.current)
          }}
        />
        <ShearButton
          className="bf__play"
          size="md"
          icon={<Play />}
          label={<Label combo="Enter">{playing ? 'Play this' : 'Play'}</Label>}
          aria-label="Play"
          tooltip="Play (or double-click a row)"
          shortcut="Enter"
          soft={none}
          sound={false}
          onClick={() => void playSelection(sel())}
        />
      </div>
    </div>
  )
}
