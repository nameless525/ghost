// Smart-playlist query editing: a syntax-highlighted search field (tokens from shared/search.ts),
// parsed-filter chips, inline errors and a row of example chips.
import { CircleAlert, Sparkles } from 'lucide-react'
import { forwardRef, useMemo, type ReactNode } from 'react'
import { parseSearch, type ParsedSearch, type SearchToken } from '@shared/search'
import { sfx } from '../../sound'
import { SearchInput, type SearchInputHandle } from '../../ui/SearchInput'
import { cx } from '../../ui/util'

const QUERY_EXAMPLES: { query: string; label: string }[] = [
  { query: 'platform=snes intensity>5', label: 'SNES bangers' },
  { query: 'composer=uematsu', label: 'Uematsu' },
  { query: 'liked=true', label: 'Everything liked' },
  { query: 'year=1990s kind=ost', label: '90s OSTs' },
  { query: 'boss length<4m', label: 'Short boss themes' },
  { query: 'source=chip intensity<3', label: 'Mellow chiptunes' },
  { query: 'downloaded=yes', label: 'Offline' }
]

/** Highlighted mirror of `text`: every character is reproduced exactly, wrapped in token spans. */
function highlightQuery(text: string, parsed?: ParsedSearch): ReactNode {
  const p = parsed ?? parseSearch(text)
  const out: ReactNode[] = []
  let pos = 0
  p.tokens.forEach((t: SearchToken, i) => {
    if (t.start > pos) out.push(<span key={`g${i}`}>{text.slice(pos, t.start)}</span>)
    out.push(
      <span key={i} className={`lx-q lx-q--${t.type}`} title={t.type === 'invalid' ? p.errors.find((e) => e.start === t.start)?.message : undefined}>
        {t.text}
      </span>
    )
    pos = t.end
  })
  if (pos < text.length) out.push(<span key="tail">{text.slice(pos)}</span>)
  return out
}

/** Read-only, highlighted rendering of a query (for headers and cards). */
export function QueryText({ query, className }: { query: string; className?: string }) {
  return <code className={cx('lx-qtext', className)}>{highlightQuery(query)}</code>
}

/** A short human summary of the parsed filters: chips like "platform = snes". */
function QuerySummary({ parsed }: { parsed: ParsedSearch }) {
  if (parsed.empty && !parsed.errors.length) return null
  return (
    <div className="lx-qsum">
      {parsed.filters.map((f, i) => (
        <span key={`f${i}`} className="lx-qsum__chip">
          <b>{f.key}</b>
          <i>{f.op === '=' ? (f.bool === false ? 'is not' : 'is') : f.op}</i>
          {f.bool !== null ? (f.bool ? 'yes' : 'no') : f.value}
        </span>
      ))}
      {parsed.terms.map((t, i) => (
        <span key={`t${i}`} className="lx-qsum__chip lx-qsum__chip--text">
          <i>has</i>“{t}”
        </span>
      ))}
      {parsed.excludes.map((t, i) => (
        <span key={`x${i}`} className="lx-qsum__chip lx-qsum__chip--exclude">
          <i>not</i>“{t}”
        </span>
      ))}
      {parsed.errors.map((e, i) => (
        <span key={`e${i}`} className="lx-qsum__error">
          <CircleAlert />
          {e.message}
        </span>
      ))}
    </div>
  )
}

export interface QueryFieldProps {
  value: string
  onChange: (v: string) => void
  onSubmit?: (v: string) => void
  onEscape?: () => void
  autoFocus?: boolean
  /** Show the example chips. Default true. */
  examples?: boolean
  onExample?: (ex: { query: string; label: string }) => void
  className?: string
}

/** Query input with live syntax highlighting, parsed summary and examples. */
export const QueryField = forwardRef<SearchInputHandle, QueryFieldProps>(function QueryField(
  { value, onChange, onSubmit, onEscape, autoFocus, examples = true, onExample, className },
  ref
) {
  const parsed = useMemo(() => parseSearch(value), [value])
  return (
    <div className={cx('lx-qfield', className)}>
      <SearchInput
        ref={ref}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        onEscape={onEscape}
        autoFocus={autoFocus}
        placeholder="e.g. platform=snes intensity>5"
        highlight={(t) => highlightQuery(t, t === value ? parsed : undefined)}
        className="lx-qfield__input"
        inputProps={{ 'aria-label': 'Smart playlist query' }}
      />
      <QuerySummary parsed={parsed} />
      {examples && (
        <div className="lx-qex">
          <span className="lx-qex__label">
            <Sparkles /> Try
          </span>
          {QUERY_EXAMPLES.map((ex) => (
            <button
              key={ex.query}
              type="button"
              className={cx('lx-qex__chip', value.trim() === ex.query && 'lx-qex__chip--on')}
              title={ex.label}
              onPointerEnter={() => sfx.play('hover')}
              onClick={() => {
                sfx.play('select', { volume: 0.6 })
                onChange(ex.query)
                onExample?.(ex)
              }}
            >
              <QueryText query={ex.query} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
})
