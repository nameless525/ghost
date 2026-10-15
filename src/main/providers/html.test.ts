import { load } from 'cheerio'
import { describe, expect, it } from 'vitest'
import { childElements, findAll, findFirst, fragmentText, linkWithHref, loadHtml, tag, textOf, type DomNode } from './html'

const HTML = `<table class="t"><tr id="h"><th>A</th><th colspan="2">B &amp; C</th></tr>
<tr><td class="x clickable-row"><a href="/one">One <b>bold</b></a><!-- note --><span>[S-1]</span></td><td><a>no href</a><a href="">empty</a></td>
<td><img src="/i.jpg"><img src="/j.jpg"><table><tr><td>nested</td></tr></table></td></tr></table>
<p>Caf&eacute;<br>Line 2</p>`

describe('html: htmlparser2-backed loading and tree walks', () => {
  it('walks match the cheerio calls they replace', () => {
    const $ = load(HTML)
    const $2 = loadHtml(HTML)
    const table = $2('table.t').toArray()[0] as DomNode
    const rows = findAll(table, tag('tr'))
    expect(rows.length).toBe($('table.t').find('tr').length) // nested rows included
    const header = rows.find((r) => r.attribs?.id === 'h')!
    expect(childElements(header, 'th').map((th) => textOf(th))).toEqual($('#h').children('th').toArray().map((th) => $(th).text()))
    const tds = childElements(rows[1], 'td')
    expect(tds.length).toBe($('table.t > tbody > tr').eq(1).children('td').length)
    // text includes descendants, not comments
    expect(textOf(tds[0])).toBe($('td').first().text())
    // a[href] includes an empty href; the first with one
    expect(findAll(tds[1], linkWithHref).map((a) => a.attribs!.href)).toEqual($('td').eq(1).find('a[href]').toArray().map((a) => $(a).attr('href')))
    expect(findFirst(tds[2], tag('img'))?.attribs?.src).toBe($('td').eq(2).find('img').attr('src'))
    expect(textOf(undefined)).toBe('')
    expect(findAll(undefined, tag('a'))).toEqual([])
  })

  it('entities decode in text and attributes; fragments read as text', () => {
    expect(loadHtml(HTML)('p').text()).toBe('CaféLine 2')
    expect(loadHtml('<a href="/x?a=1&amp;b=2">x</a>')('a').attr('href')).toBe('/x?a=1&b=2')
    expect(fragmentText('Tom &amp; Jerry <i>(JP)</i>')).toBe('Tom & Jerry (JP)')
  })
})
