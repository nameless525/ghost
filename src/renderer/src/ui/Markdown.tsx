// Release notes and changelog sections as React elements (never innerHTML). The subset it reads is
// in ./markdownParser.ts. Links open in the browser.
//
//   <Markdown source={release.notes} />
import { useMemo, type ReactNode } from 'react'
import { ghost } from '../ghost'
import { parseMarkdown, type MdInline, type MdListItem } from './markdownParser'
import { Tooltip } from './Tooltip'
import { cx } from './util'

export interface MarkdownProps {
  source: string
  className?: string
}

function inline(nodes: MdInline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return n.text
      case 'strong':
        return <strong key={i}>{inline(n.children)}</strong>
      case 'em':
        return <em key={i}>{inline(n.children)}</em>
      case 'code':
        return <code key={i}>{n.text}</code>
      case 'link':
        return (
          <Tooltip key={i} content={n.href}>
            <a
              href={n.href}
              onClick={(e) => {
                e.preventDefault()
                void ghost().system.openExternal(n.href)
              }}
              // middle-click would open a GHOST window on it
              onAuxClick={(e) => e.preventDefault()}
            >
              {inline(n.children)}
            </a>
          </Tooltip>
        )
    }
  })
}

function List({ items }: { items: MdListItem[] }) {
  return (
    <ul>
      {items.map((it, i) => (
        <li key={i}>
          {inline(it.content)}
          {it.items.length > 0 && <List items={it.items} />}
        </li>
      ))}
    </ul>
  )
}

/** Renders `source` (Markdown) up to a `---` line. Text is selectable. */
export function Markdown({ source, className }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className={cx('g-md g-selectable', className)}>
      {blocks.map((b, i) =>
        b.type === 'heading' ? (
          b.level === 3 ? (
            <h3 key={i}>{inline(b.content)}</h3>
          ) : (
            <h4 key={i}>{inline(b.content)}</h4>
          )
        ) : b.type === 'paragraph' ? (
          <p key={i}>{inline(b.content)}</p>
        ) : (
          <List key={i} items={b.items} />
        )
      )}
    </div>
  )
}
