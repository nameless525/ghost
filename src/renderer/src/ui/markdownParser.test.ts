import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, safeHref, type MdBlock, type MdInline, type MdListItem } from './markdownParser'

const t = (text: string): MdInline => ({ type: 'text', text })

/** The plain text of inline nodes (to check structure without spelling out every node). */
const plain = (ns: MdInline[]): string => ns.map((n) => (n.type === 'text' || n.type === 'code' ? n.text : plain(n.children))).join('')
const itemText = (i: MdListItem): string => plain(i.content)

describe('parseInline', () => {
  it('bold, italic and code', () => {
    expect(parseInline('a **b** c *d* `e`')).toEqual([t('a '), { type: 'strong', children: [t('b')] }, t(' c '), { type: 'em', children: [t('d')] }, t(' '), { type: 'code', text: 'e' }])
  })

  it('nests emphasis', () => {
    expect(parseInline('**a *b* c**')).toEqual([{ type: 'strong', children: [t('a '), { type: 'em', children: [t('b')] }, t(' c')] }])
    expect(parseInline('*a **b** c*')).toEqual([{ type: 'em', children: [t('a '), { type: 'strong', children: [t('b')] }, t(' c')] }])
  })

  it('leaves stray or spaced asterisks alone', () => {
    expect(parseInline('5 * 3 * 2')).toEqual([t('5 * 3 * 2')])
    expect(parseInline('**unclosed')).toEqual([t('**unclosed')])
    expect(parseInline('a \\*literal\\* b')).toEqual([t('a *literal* b')])
  })

  it('code spans keep their contents verbatim', () => {
    expect(parseInline('run `ghost-cli **render**` now')).toEqual([t('run '), { type: 'code', text: 'ghost-cli **render**' }, t(' now')])
    expect(parseInline('`` a ` b ``')).toEqual([{ type: 'code', text: 'a ` b' }])
    expect(parseInline('a `b')).toEqual([t('a `b')])
  })

  it('links: http(s) only', () => {
    expect(parseInline('please [open an issue](https://github.com/nameless525/ghost/issues).')).toEqual([
      t('please '),
      { type: 'link', href: 'https://github.com/nameless525/ghost/issues', children: [t('open an issue')] },
      t('.')
    ])
    expect(parseInline('[**bold** link](http://example.com/a_(b) "Title")')).toEqual([
      { type: 'link', href: 'http://example.com/a_(b)', children: [{ type: 'strong', children: [t('bold')] }, t(' link')] }
    ])
    // anything else keeps its text and loses the link
    expect(parseInline('[click](javascript:alert(1)) [file](file:///etc/passwd) [rel](/docs)')).toEqual([t('click file rel')])
    expect(parseInline('[not a link] (x)')).toEqual([t('[not a link] (x)')])
  })

  it('bare and angle-bracket URLs become links, without trailing punctuation', () => {
    expect(parseInline('Full Changelog: https://github.com/nameless525/ghost/compare/v0.4.0...v0.4.1.')).toEqual([
      t('Full Changelog: '),
      { type: 'link', href: 'https://github.com/nameless525/ghost/compare/v0.4.0...v0.4.1', children: [t('https://github.com/nameless525/ghost/compare/v0.4.0...v0.4.1')] },
      t('.')
    ])
    expect(parseInline('<https://example.com/x>')).toEqual([{ type: 'link', href: 'https://example.com/x', children: [t('https://example.com/x')] }])
    expect(parseInline('see [https://a.example](https://a.example)')).toEqual([t('see '), { type: 'link', href: 'https://a.example/', children: [t('https://a.example')] }])
    expect(parseInline('xhttps://nope.example')).toEqual([t('xhttps://nope.example')])
  })
})

describe('safeHref', () => {
  it('accepts absolute http(s) URLs only', () => {
    expect(safeHref(' https://github.com/x ')).toBe('https://github.com/x')
    expect(safeHref('HTTP://Example.com')).toBe('http://example.com/')
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('mailto:a@b.c')).toBeNull()
    expect(safeHref('//example.com')).toBeNull()
    expect(safeHref('https://')).toBeNull()
  })
})

describe('parseMarkdown', () => {
  it('headings, a paragraph under a heading, then bullets', () => {
    const md = ['### Even volume', 'GHOST measures each track', 'and remembers it.', '- **One.** First.', '- Two', '', '#### Smaller', 'Text'].join('\n')
    expect(parseMarkdown(md)).toEqual<MdBlock[]>([
      { type: 'heading', level: 3, content: [t('Even volume')] },
      { type: 'paragraph', content: [t('GHOST measures each track and remembers it.')] },
      {
        type: 'list',
        items: [
          { content: [{ type: 'strong', children: [t('One.')] }, t(' First.')], items: [] },
          { content: [t('Two')], items: [] }
        ]
      },
      { type: 'heading', level: 4, content: [t('Smaller')] },
      { type: 'paragraph', content: [t('Text')] }
    ])
  })

  it('# and ## count as ###; trailing hashes go', () => {
    expect(parseMarkdown('# A\n## B ##\n#nohash')).toEqual([
      { type: 'heading', level: 3, content: [t('A')] },
      { type: 'heading', level: 3, content: [t('B')] },
      { type: 'paragraph', content: [t('#nohash')] }
    ])
  })

  it('nests bullets by indentation, two spaces a level', () => {
    const md = ['- a', '  - a1', '    - a1x', '  - a2', '- b', '    - b1 (four spaces)', '- c'].join('\n')
    const [list] = parseMarkdown(md)
    expect(list.type).toBe('list')
    const items = (list as Extract<MdBlock, { type: 'list' }>).items
    expect(items.map(itemText)).toEqual(['a', 'b', 'c'])
    expect(items[0].items.map(itemText)).toEqual(['a1', 'a2'])
    expect(items[0].items[0].items.map(itemText)).toEqual(['a1x'])
    expect(items[1].items.map(itemText)).toEqual(['b1 (four spaces)'])
    expect(items[2].items).toEqual([])
  })

  it('a wrapped bullet continues its item; a blank line then text starts a paragraph', () => {
    const blocks = parseMarkdown(['- one', '  wrapped', 'lazy', '- two', '', '- three', '', 'After.'].join('\n'))
    expect(blocks).toHaveLength(2)
    const list = blocks[0] as Extract<MdBlock, { type: 'list' }>
    expect(list.items.map(itemText)).toEqual(['one wrapped lazy', 'two', 'three'])
    expect(blocks[1]).toEqual({ type: 'paragraph', content: [t('After.')] })
  })

  it('stops at a line that is exactly ---', () => {
    const md = '### Fixes\n- A fix\n\n---\n\n### Install\n- Download the .dmg'
    expect(parseMarkdown(md)).toEqual([
      { type: 'heading', level: 3, content: [t('Fixes')] },
      { type: 'list', items: [{ content: [t('A fix')], items: [] }] }
    ])
    // CRLF from GitHub, and --- inside a list
    expect(parseMarkdown('- a\r\n---\r\n- b')).toEqual([{ type: 'list', items: [{ content: [t('a')], items: [] }] }])
  })

  it('empty input', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n  \n')).toEqual([])
  })

  it('parses the real changelog', () => {
    const src = readFileSync(resolve(__dirname, '../../../../CHANGELOG.md'), 'utf8')
    // one release's section, as main sends it: the text under "## x.y.z (date)"
    const section = src.split(/^## .*$/m)[1]
    const blocks = parseMarkdown(section)
    expect(blocks.length).toBeGreaterThan(3)
    expect(blocks[0].type).toBe('heading')
    expect(blocks.some((b) => b.type === 'list')).toBe(true)
    // no Markdown syntax left over in the text
    const all = JSON.stringify(blocks)
    expect(all).not.toMatch(/\*\*|\]\(|^#/)

    // 0.3.2: three levels of bullets
    const v032 = src.split(/^## /m).find((s) => s.startsWith('0.3.2'))!
    const lists = parseMarkdown(v032).filter((b): b is Extract<MdBlock, { type: 'list' }> => b.type === 'list')
    const hovering = lists.flatMap((l) => l.items).flatMap((i) => i.items).find((i) => itemText(i).startsWith('Hovering explains'))
    expect(hovering?.items).toHaveLength(3)
  })
})
