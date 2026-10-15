// The "Keyboard shortcuts" sheet: every shortcut from shortcuts.ts, grouped by where it works.
// Opened with ? anywhere, or from Settings → Interface. Code-split: GlobalKeys loads it on first open.
import { Keyboard } from 'lucide-react'
import { Fragment } from 'react'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Kbd } from '../ui/Kbd'
import { SHORTCUT_GROUPS, type ShortcutGroup } from './shortcuts'

export interface ShortcutsSheetProps {
  open: boolean
  onClose: () => void
}

const COLUMNS = 3

/** Groups dealt into columns, each to the shortest so far (a title counts as two rows). */
function columns(groups: ShortcutGroup[]): ShortcutGroup[][] {
  const cols: ShortcutGroup[][] = Array.from({ length: COLUMNS }, () => [])
  const heights = cols.map(() => 0)
  for (const g of groups) {
    const i = heights.indexOf(Math.min(...heights))
    cols[i].push(g)
    heights[i] += g.rows.length + 2
  }
  return cols.filter((c) => c.length)
}

export default function ShortcutsSheet({ open, onClose }: ShortcutsSheetProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" icon={<Keyboard />} width={1000} bare>
      <div className="g-dialog__body g-keys">
        {columns(SHORTCUT_GROUPS).map((col, c) => (
          <div key={c} className="g-keys__col">
            {col.map((g) => (
              <section key={g.title} className="g-keys__group" aria-label={g.title}>
                <h3 className="g-keys__title">{g.title}</h3>
                <dl className="g-keys__list">
                  {g.rows.map((r) => (
                    <div key={r.label} className="g-keys__row">
                      <dt>{r.label}</dt>
                      <dd>
                        {r.text && <span className="g-keys__text">{r.text}</span>}
                        {r.keys.map((k, i) => (
                          <Fragment key={k}>
                            {i > 0 && <span className="g-keys__or">{r.range ? '–' : '/'}</span>}
                            <Kbd combo={k} size="sm" />
                          </Fragment>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        ))}
      </div>
      <div className="g-dialog__foot g-keys__foot">
        <span className="g-keys__hint">
          Press <Kbd combo="?" size="sm" /> anywhere to open this again.
        </span>
        <Button variant="soft" sound="back" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  )
}
