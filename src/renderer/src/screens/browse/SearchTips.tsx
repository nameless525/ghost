// "Filters" in the search panel: what you can type besides a name, as examples that add
// themselves to the search when clicked (the power-user syntax of DESIGN §7.6, made discoverable).
// The button counts the filters in the current query.
import { SlidersHorizontal } from 'lucide-react'
import { useRef, useState, type RefObject } from 'react'
import { sfx } from '../../sound'
import { Kbd } from '../../ui/Kbd'
import type { SearchInputHandle } from '../../ui/SearchInput'
import { Tooltip } from '../../ui/Tooltip'
import { cx } from '../../ui/util'
import { AnchoredPopover } from './Popover'
import { appendToQuery } from './query'
import { SearchSyntax } from './SearchSyntax'

/** Filters that work on the whole catalog (track-level ones only see tracks GHOST has loaded). */
const EXAMPLES: { token: string; what: string }[] = [
  { token: 'platform=snes', what: 'Games on a platform (snes, ps2, switch…)' },
  { token: 'composer=uematsu', what: 'Music by a composer' },
  { token: 'year=1990s', what: 'From a year or decade (or year>2015)' },
  { token: 'kind=ost', what: 'Only official soundtracks (or gamerip, arrange)' },
  { token: 'source=flac', what: 'Only lossless audio (or chip, mp3)' },
  { token: 'liked=yes', what: 'Tracks you’ve liked' },
  { token: 'downloaded=yes', what: 'Tracks you’ve downloaded' },
  { token: '-remix', what: 'Leave out anything with a word' }
]

export function SearchTips({ count, inputRef }: { count: number; inputRef: RefObject<SearchInputHandle | null> }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const add = (token: string) => {
    sfx.play('confirm', { volume: 0.5 })
    const next = appendToQuery(token)
    setOpen(false)
    // caret after the new filter, ready to change its value
    const el = inputRef.current?.input
    if (el) {
      el.focus({ preventScroll: true })
      requestAnimationFrame(() => el.setSelectionRange(next.length, next.length))
    }
  }
  return (
    <>
      <Tooltip content={count ? `${count} filter${count === 1 ? '' : 's'} in your search` : 'Narrow the search by platform, composer, year…'}>
        <button
          ref={btn}
          type="button"
          className={cx('bs__filters', count > 0 && 'bs__filters--on')}
          aria-expanded={open}
          aria-haspopup="dialog"
          onPointerEnter={() => sfx.play('hover')}
          onClick={() => {
            sfx.play(open ? 'collapse' : 'expand', { volume: 0.45 })
            setOpen((o) => !o)
          }}
        >
          <SlidersHorizontal />
          <span className="bs__filters-label">Filters</span>
          {count > 0 && <b className="bs__filters-count tnum">{count}</b>}
        </button>
      </Tooltip>
      {open && btn.current && (
        <AnchoredPopover anchor={btn.current} onClose={() => setOpen(false)} className="bs-tips" aria-label="Search filters">
          <div className="bs-tips__title">Narrow your search</div>
          <p className="bs-tips__lead">Type these after a name, or on their own. Click one to add it.</p>
          <ul className="bs-tips__list">
            {EXAMPLES.map((x) => (
              <li key={x.token}>
                <button type="button" className="bs-tips__row" onClick={() => add(x.token)}>
                  <code className="bs-tips__code">
                    <SearchSyntax text={x.token} />
                  </code>
                  <span className="bs-tips__what">{x.what}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="bs-tips__foot">
            Start typing anywhere in Browse to search. Spelling is forgiving: “ff7”, “megaman” and “yugioh” all work. <Kbd combo="Enter" size="sm" /> plays the highlighted result, <Kbd combo="Escape" size="sm" /> clears.
          </p>
        </AnchoredPopover>
      )}
    </>
  )
}
