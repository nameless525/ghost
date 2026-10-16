// HTML parsing for the page-scraping providers (KHInsider, Zophar's Domain, chiptune listings,
// Bandcamp). Cheerio over htmlparser2 rather than its default parse5: the pages are read for a
// handful of tables, links and paragraphs, which parse identically, and htmlparser2 builds the
// tree 2.5–6x faster (a 500-row KHInsider listing: ~50 ms → ~10 ms, an album page ~21 → ~5 ms),
// which is crawl CPU and album-open latency in the catalog worker.

import type { CheerioAPI } from 'cheerio'
// The slim entry: htmlparser2 only. The default one also loads parse5, undici and the encoding
// sniffers at import, ~45 ms of catalog-worker start-up for code these options never reach.
import { load } from 'cheerio/slim'

const OPTIONS = { xml: { xmlMode: false, decodeEntities: true } } as const

export function loadHtml(html: string): CheerioAPI {
  return load(html, OPTIONS)
}

/** Text of an HTML fragment (entities decoded, tags dropped). */
export function fragmentText(frag: string): string {
  return loadHtml(`<div>${frag}</div>`)('div').first().text()
}

// ---------------------------------------------------------------------------
// Plain tree walking for hot loops (listing rows, track lists): a cheerio selection per cell costs
// selector compilation, wrapping and de-duplication, several times the parse itself on a 500-row
// listing. Same semantics as the cheerio calls they replace (noted on each).

/** A parsed node (htmlparser2 / domhandler shape). */
export interface DomNode {
  type: string
  name?: string
  attribs?: Record<string, string>
  children?: DomNode[]
  data?: string
}

const isElement = (n: DomNode): boolean => n.type === 'tag' || n.type === 'script' || n.type === 'style'

/** `$(n).children(name)`. */
export function childElements(n: DomNode | undefined, name: string): DomNode[] {
  const out: DomNode[] = []
  for (const c of n?.children ?? []) if (isElement(c) && c.name === name) out.push(c)
  return out
}

/** `$(n).find(…)` for a predicate: descendants in document order. */
export function findAll(n: DomNode | undefined, pred: (e: DomNode) => boolean, out: DomNode[] = []): DomNode[] {
  for (const c of n?.children ?? []) {
    if (!isElement(c)) continue
    if (pred(c)) out.push(c)
    findAll(c, pred, out)
  }
  return out
}

/** `$(n).find(…).first()`. */
export function findFirst(n: DomNode | undefined, pred: (e: DomNode) => boolean): DomNode | undefined {
  for (const c of n?.children ?? []) {
    if (!isElement(c)) continue
    if (pred(c)) return c
    const hit = findFirst(c, pred)
    if (hit) return hit
  }
  return undefined
}

/** `$(n).text()`: every descendant text node (comments excluded). */
export function textOf(n: DomNode | undefined): string {
  if (!n) return ''
  if (n.type === 'text') return n.data ?? ''
  if (!n.children || n.type === 'comment') return ''
  let s = ''
  for (const c of n.children) s += textOf(c)
  return s
}

/** Elements with this tag name. */
export const tag =
  (name: string) =>
  (e: DomNode): boolean =>
    e.name === name

/** `a[href]`. */
export const linkWithHref = (e: DomNode): boolean => e.name === 'a' && e.attribs?.href !== undefined
