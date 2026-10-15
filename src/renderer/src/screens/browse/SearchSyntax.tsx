// The search query with its filter tokens coloured (DESIGN §7.6): the search box's mirror and the
// examples in the filters popover.
import { useMemo, type ReactNode } from 'react'
import { parseSearch } from '@shared/search'

/** Mirror of the query with filter tokens coloured (must reproduce the text exactly). */
export function SearchSyntax({ text }: { text: string }) {
  const parsed = useMemo(() => parseSearch(text), [text])
  const out: ReactNode[] = []
  let i = 0
  parsed.tokens.forEach((t, k) => {
    if (t.start > i) out.push(text.slice(i, t.start))
    out.push(
      <span key={k} className={`bs-tok bs-tok--${t.type}`}>
        {t.text}
      </span>
    )
    i = t.end
  })
  if (i < text.length) out.push(text.slice(i))
  return <>{out}</>
}
