// Search field with optional syntax highlighting.
//
//   <SearchInput value={q} onChange={setQ} placeholder="Search games, albums, composers…"
//                highlight={(text) => <SearchSyntax text={text} />} />
//
// `highlight` renders a styled mirror of the text behind a transparent input, so you can
// colour filter tokens (`composer=`, `intensity>5`) while the caret and selection still work.
// The mirror must produce exactly the same characters (no extra text), only wrapped in spans.
import { Search, X } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, type CSSProperties, type InputHTMLAttributes, type KeyboardEvent as RKeyboardEvent, type ReactNode } from 'react'
import { sfx } from '../sound'
import { LoadingRing } from './LoadingRing'
import { cx, hueStyle, type Hue } from './util'

export interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  /** Enter. */
  onSubmit?: (value: string) => void
  /** Escape. Default: clears the text (and blurs when already empty). */
  onEscape?: () => void
  placeholder?: string
  /** Render-prop for a syntax-highlighted mirror of the text. */
  highlight?: (value: string) => ReactNode
  autoFocus?: boolean
  loading?: boolean
  /** Extra controls on the right (e.g. a result count, a filter button). */
  right?: ReactNode
  size?: 'md' | 'lg'
  hue?: Hue
  className?: string
  style?: CSSProperties
  inputProps?: InputHTMLAttributes<HTMLInputElement>
}

export interface SearchInputHandle {
  focus(): void
  blur(): void
  select(): void
  input: HTMLInputElement | null
}

/**
 * What a key does in the field. Plain Enter submits (once while held; with a modifier it's someone
 * else's shortcut, e.g. ⌘↵ Search online), Escape escapes. Neither while an IME composition runs:
 * there they confirm or cancel the candidate (keyCode 229: the key went to the IME).
 */
export function searchKeyAction(e: Pick<KeyboardEvent, 'key' | 'keyCode' | 'repeat' | 'isComposing' | 'metaKey' | 'ctrlKey' | 'altKey'>): 'submit' | 'escape' | null {
  if (e.isComposing || e.keyCode === 229) return null
  if (e.key === 'Enter') return e.metaKey || e.ctrlKey || e.altKey || e.repeat ? null : 'submit'
  return e.key === 'Escape' ? 'escape' : null
}

export const SearchInput = forwardRef<SearchInputHandle, SearchInputProps>(function SearchInput(
  { value, onChange, onSubmit, onEscape, placeholder = 'Search', highlight, autoFocus, loading, right, size = 'md', hue, className, style, inputProps },
  ref
) {
  const input = useRef<HTMLInputElement>(null)
  const mirror = useRef<HTMLDivElement>(null)

  // Every focus is preventScroll: a field inside a sliding / transformed panel otherwise scrolls an
  // ancestor to "reveal" it (the Play screen jumped ~144 px sideways when the queue search took focus).
  const focus = () => input.current?.focus({ preventScroll: true })
  useImperativeHandle(ref, () => ({
    focus,
    blur: () => input.current?.blur(),
    select: () => input.current?.select(),
    get input() {
      return input.current
    }
  }))

  const sync = () => {
    if (mirror.current && input.current) mirror.current.style.transform = `translateX(${-input.current.scrollLeft}px)`
  }
  useEffect(sync)
  // (not the autoFocus attribute: React's mount focus can't pass preventScroll)
  useLayoutEffect(() => {
    if (autoFocus) focus()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: RKeyboardEvent<HTMLInputElement>) => {
    const action = searchKeyAction(e.nativeEvent)
    if (action === 'submit') onSubmit?.(value)
    else if (action === 'escape') {
      if (onEscape) onEscape()
      else if (value) {
        sfx.play('back', { volume: 0.6 })
        onChange('')
      } else {
        input.current?.blur()
        return // let Escape bubble (e.g. go back) when there's nothing to clear
      }
      e.preventDefault()
      e.stopPropagation()
    }
    requestAnimationFrame(sync)
  }

  return (
    <div className={cx('g-search', size === 'lg' && 'g-search--lg', highlight && 'g-search--highlighted', className)} style={{ ...hueStyle(hue), ...style }} onClick={focus}>
      <Search className="g-search__icon" />
      <div className="g-search__field">
        {highlight && (
          <div ref={mirror} className="g-search__mirror" aria-hidden>
            {highlight(value)}
          </div>
        )}
        <input
          ref={input}
          type="search"
          className="g-search__input"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={sync}
          onSelect={sync}
          {...inputProps}
        />
      </div>
      <div className="g-search__right">
        {loading && <LoadingRing size={16} />}
        {right}
        {value && !loading && (
          <button
            type="button"
            className="g-icon-btn g-icon-btn--sm"
            aria-label="Clear search"
            onClick={(e) => {
              e.stopPropagation()
              sfx.play('back', { volume: 0.6 })
              onChange('')
              focus()
            }}
          >
            <X />
          </button>
        )}
      </div>
    </div>
  )
})
