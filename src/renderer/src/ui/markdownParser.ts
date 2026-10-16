// The small Markdown subset GHOST's changelog and GitHub release notes use, parsed to a tree that
// <Markdown/> renders as React elements (never as HTML). Blocks: `###`/`####` headings (`#`/`##`
// count as `###`), paragraphs, `-` bullet lists nested by indentation. Inline: **bold**, *italic*,
// `code`, [links](https://…) and bare http(s) URLs. A line that is exactly `---` ends the notes:
// GitHub release bodies put the install instructions after one.
// (Not `markdown.ts`: on a case-insensitive disk './Markdown' would resolve to it.)

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: MdInline[] }

export interface MdListItem {
  content: MdInline[]
  /** Nested bullets. */
  items: MdListItem[]
}

export type MdBlock =
  | { type: 'heading'; level: 3 | 4; content: MdInline[] }
  | { type: 'paragraph'; content: MdInline[] }
  | { type: 'list'; items: MdListItem[] }

/** The URL when it's an absolute http(s) one, else null (no javascript:, file:, relative…). */
export function safeHref(url: string): string | null {
  const u = url.trim()
  if (!/^https?:\/\//i.test(u)) return null
  try {
    return new URL(u).href
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Blocks

interface ItemDraft {
  text: string
  indent: number
  items: ItemDraft[]
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/

export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = []
  let para: string[] = []
  let list: { items: ItemDraft[]; stack: ItemDraft[] } | null = null
  let blank = false

  const endPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', content: parseInline(para.join(' ')) })
    para = []
  }
  const endList = () => {
    if (list) blocks.push({ type: 'list', items: list.items.map(toItem) })
    list = null
  }

  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\t/g, '    ')
    if (line.trim() === '---') break
    if (!line.trim()) {
      endPara()
      blank = true
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      endPara()
      endList()
      blocks.push({ type: 'heading', level: h[1].length >= 4 ? 4 : 3, content: parseInline(h[2]) })
    } else {
      const b = BULLET.exec(line)
      if (b) {
        endPara()
        list ??= { items: [], stack: [] }
        const indent = b[1].length
        const item: ItemDraft = { text: b[2].trim(), indent, items: [] }
        // two spaces deeper than the item above makes a sub-bullet; anything less, a sibling of
        // the nearest item at least that far out
        while (list.stack.length && list.stack[list.stack.length - 1].indent + 2 > indent) list.stack.pop()
        const parent = list.stack[list.stack.length - 1]
        ;(parent ? parent.items : list.items).push(item)
        list.stack.push(item)
      } else if (list && (!blank || /^\s/.test(line))) {
        // a wrapped bullet: its text goes on (unindented too, as on GitHub, unless after a blank line)
        const last = list.stack[list.stack.length - 1]
        last.text += ` ${line.trim()}`
      } else {
        endList()
        para.push(line.trim())
      }
    }
    blank = false
  }
  endPara()
  endList()
  return blocks
}

function toItem(d: ItemDraft): MdListItem {
  return { content: parseInline(d.text), items: d.items.map(toItem) }
}

// ---------------------------------------------------------------------------
// Inline

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!<>|~]/
const BARE_URL = /^https?:\/\/[^\s<>()[\]]+/i
const ws = (c: string | undefined) => c === undefined || /\s/.test(c)

/** Where the `**` or `*` closing the run opened just before `from` is, or -1. */
function findClose(s: string, from: number, marker: '**' | '*'): number {
  for (let j = from; j < s.length; j++) {
    const c = s[j]
    if (c === '\\') {
      j++
      continue
    }
    if (c === '`') {
      const end = codeEnd(s, j)
      if (end > 0) j = end - 1
      continue
    }
    if (c !== '*') continue
    const double = s[j + 1] === '*'
    if (marker === '**') {
      if (double && j > from && !ws(s[j - 1])) return j
      if (double) j++
    } else if (double) {
      j++ // a nested **strong** inside *em*
    } else if (j > from && !ws(s[j - 1])) {
      return j
    }
  }
  return -1
}

/** The index just past the code span opening at `i` (a run of backticks), or -1 when unclosed. */
function codeEnd(s: string, i: number): number {
  let n = 0
  while (s[i + n] === '`') n++
  const fence = '`'.repeat(n)
  let j = s.indexOf(fence, i + n)
  while (j >= 0 && s[j + n] === '`') {
    // a longer run doesn't close it
    let k = j
    while (s[k] === '`') k++
    j = s.indexOf(fence, k)
  }
  return j < 0 ? -1 : j + n
}

/** `[text](url "title")` starting at `i`. */
function matchLink(s: string, i: number): { text: string; url: string; end: number } | null {
  let depth = 0
  let close = -1
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') j++
    else if (s[j] === '[') depth++
    else if (s[j] === ']' && --depth === 0) {
      close = j
      break
    }
  }
  if (close < 0 || s[close + 1] !== '(') return null
  depth = 0
  for (let j = close + 1; j < s.length; j++) {
    if (s[j] === '(') depth++
    else if (s[j] === ')' && --depth === 0) {
      const target = s.slice(close + 2, j).trim()
      const url = (target.match(/^<([^>]*)>/)?.[1] ?? target.split(/\s+/)[0]) || ''
      return { text: s.slice(i + 1, close), url, end: j + 1 }
    }
  }
  return null
}

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = []
  const push = (n: MdInline) => {
    const last = out[out.length - 1]
    if (n.type === 'text' && last?.type === 'text') last.text += n.text
    else if (n.type !== 'text' || n.text) out.push(n)
  }
  const text = (t: string) => push({ type: 'text', text: t })

  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '\\' && ESCAPABLE.test(src[i + 1] ?? '')) {
      text(src[i + 1])
      i += 2
      continue
    }
    if (c === '`') {
      const end = codeEnd(src, i)
      let n = 0
      while (src[i + n] === '`') n++
      if (end < 0) {
        text('`'.repeat(n))
        i += n
        continue
      }
      const body = src.slice(i + n, end - n)
      push({ type: 'code', text: /^ .* $/.test(body) && body.trim() ? body.slice(1, -1) : body })
      i = end
      continue
    }
    if (c === '*') {
      const marker = src[i + 1] === '*' ? '**' : '*'
      const start = i + marker.length
      const end = ws(src[start]) ? -1 : findClose(src, start, marker)
      if (end < 0) {
        text(marker)
        i = start
        continue
      }
      push({ type: marker === '**' ? 'strong' : 'em', children: parseInline(src.slice(start, end)) })
      i = end + marker.length
      continue
    }
    if (c === '[') {
      const link = matchLink(src, i)
      if (link) {
        const href = safeHref(link.url)
        // no link inside a link (a URL as the link's text)
        const children = parseInline(link.text).flatMap((n) => (n.type === 'link' ? n.children : [n]))
        if (href) push({ type: 'link', href, children })
        else children.forEach(push)
        i = link.end
        continue
      }
    }
    if (c === '<') {
      const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(i))
      const href = auto && safeHref(auto[1])
      if (auto && href) {
        push({ type: 'link', href, children: [{ type: 'text', text: auto[1] }] })
        i += auto[0].length
        continue
      }
    }
    if ((c === 'h' || c === 'H') && !/[\w/]/.test(src[i - 1] ?? '')) {
      const m = BARE_URL.exec(src.slice(i))
      // trailing punctuation belongs to the sentence, not the URL
      const url = m?.[0].replace(/[.,:;!?'"]+$/, '')
      const href = url && safeHref(url)
      if (url && href) {
        push({ type: 'link', href, children: [{ type: 'text', text: url }] })
        i += url.length
        continue
      }
    }
    text(c)
    i++
  }
  return out
}
