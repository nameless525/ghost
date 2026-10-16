import { describe, expect, it } from 'vitest'
import { focusables, fromNestedControl, trapTarget } from './util'

// A small stand-in for the DOM: just the element APIs the focus helpers use, with the browser's
// rules for them (selectors are the simple compound kind the helpers query with).
type Attrs = Record<string, string>
interface Style {
  display?: 'none'
  visibility?: 'hidden' | 'visible'
}

const NATIVE_TAB = new Set(['a', 'button', 'input', 'select', 'textarea'])

class El {
  parent: El | null = null
  children: El[] = []
  constructor(
    readonly tag: string,
    readonly attrs: Attrs = {},
    readonly style: Style = {}
  ) {}

  get tabIndex(): number {
    if ('tabindex' in this.attrs) return Number(this.attrs.tabindex)
    return NATIVE_TAB.has(this.tag) ? 0 : -1
  }
  hasAttribute(a: string): boolean {
    return a in this.attrs
  }
  matches(selector: string): boolean {
    return selector.split(',').some((s) => this.matchesOne(s.trim()))
  }
  closest(selector: string): El | null {
    for (let e: El | null = this; e; e = e.parent) if (e.matches(selector)) return e
    return null
  }
  contains(other: El | null): boolean {
    for (let e = other; e; e = e.parent) if (e === this) return true
    return false
  }
  querySelectorAll(selector: string): El[] {
    return this.descendants().filter((e) => e.matches(selector))
  }
  checkVisibility(): boolean {
    for (let e: El | null = this; e; e = e.parent) if (e.style.display === 'none') return false
    for (let e: El | null = this; e; e = e.parent) if (e.style.visibility) return e.style.visibility !== 'hidden'
    return true
  }
  compareDocumentPosition(other: El): number {
    const all = this.root().descendants(true)
    const rel = all.indexOf(other) > all.indexOf(this) ? 4 : 2
    return rel | (this.contains(other) ? 16 : other.contains(this) ? 8 : 0)
  }

  private root(): El {
    let e: El = this
    while (e.parent) e = e.parent
    return e
  }
  private descendants(self = false): El[] {
    const out: El[] = self ? [this] : []
    for (const c of this.children) out.push(...c.descendants(true))
    return out
  }
  private get disabled(): boolean {
    if (!['button', 'input', 'select', 'textarea', 'fieldset'].includes(this.tag)) return false
    if ('disabled' in this.attrs) return true
    for (let e = this.parent, child: El = this; e; child = e, e = e.parent) {
      if (e.tag === 'fieldset' && 'disabled' in e.attrs) return !(child.tag === 'legend' && e.children.find((c) => c.tag === 'legend') === child)
    }
    return false
  }
  private matchesOne(s: string): boolean {
    if (s === ':disabled') return this.disabled
    const m = /^(\w+)?((?:\[[\w-]+(?:="[^"]*")?\])*)(?::not\((\[[\w-]+(?:="[^"]*")?\])\))?$/.exec(s)
    if (!m) throw new Error(`selector not supported here: ${s}`)
    if (m[1] && m[1] !== this.tag) return false
    const has = (a: string) => {
      const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a)!
      return name in this.attrs && (value === undefined || this.attrs[name] === value)
    }
    for (const a of m[2].match(/\[[^\]]+\]/g) ?? []) if (!has(a)) return false
    return !(m[3] && has(m[3]))
  }
}

function h(tag: string, attrs: Attrs = {}, children: El[] = [], style: Style = {}): El {
  const e = new El(tag, attrs, style)
  for (const c of children) {
    c.parent = e
    e.children.push(c)
  }
  return e
}

const asHtml = (e: El) => e as unknown as HTMLElement
const names = (list: HTMLElement[]) => list.map((e) => (e as unknown as El).attrs.id)

/** A modal overlay like Library: a header, a visible tab, the tabs kept but hidden, a track list. */
function overlay() {
  const close = h('button', { id: 'close' })
  const filter = h('input', { id: 'filter' })
  const hiddenInput = h('input', { id: 'hidden-input', type: 'hidden' })
  const heart = h('button', { id: 'heart', tabindex: '-1' })
  const row = h('div', { id: 'row', tabindex: '0' }, [h('span'), heart])
  const lastRow = h('div', { id: 'last-row', tabindex: '-1' })
  const active = h('div', { id: 'active-tab' }, [filter, hiddenInput, row, lastRow])
  const inertTab = h('div', { id: 'liked-tab', inert: '' }, [h('button', { id: 'in-inert' })], { visibility: 'hidden' })
  const hiddenTab = h('div', { id: 'history-tab' }, [h('button', { id: 'in-hidden' })], { visibility: 'hidden' })
  const gone = h('div', {}, [h('button', { id: 'in-display-none' })], { display: 'none' })
  const fieldset = h('fieldset', { disabled: '' }, [h('legend', {}, [h('button', { id: 'in-legend' })]), h('input', { id: 'in-fieldset' })])
  const trailing = h('button', { id: 'trailing', tabindex: '-1' })
  const root = h('div', { id: 'root', tabindex: '-1' }, [close, active, inertTab, hiddenTab, gone, fieldset, h('button', { id: 'disabled', disabled: '' }), trailing])
  const page = h('body', {}, [h('button', { id: 'behind' }), root, h('button', { id: 'after' })])
  return { page, root, close, filter, row, heart, lastRow, trailing }
}

describe('focusables', () => {
  it('lists only what Tab stops on', () => {
    const { root } = overlay()
    expect(names(focusables(asHtml(root)))).toEqual(['close', 'filter', 'row', 'in-legend'])
  })

  it('puts positive tabindex first, in tabindex order', () => {
    const root = h('div', {}, [h('button', { id: 'a' }), h('button', { id: 'b', tabindex: '2' }), h('button', { id: 'c', tabindex: '1' }), h('button', { id: 'd' })])
    expect(names(focusables(asHtml(root)))).toEqual(['c', 'b', 'a', 'd'])
  })
})

describe('trapTarget', () => {
  it('wraps at the real ends, not at hidden or untabbable controls', () => {
    const { root } = overlay()
    const last = root.querySelectorAll('button').find((b) => b.attrs.id === 'in-legend')!
    const close = root.children[0]
    expect(trapTarget(asHtml(root), asHtml(last), false)).toBe(close)
    expect(trapTarget(asHtml(root), asHtml(close), true)).toBe(last)
  })

  it('leaves moves between stops to the browser', () => {
    const { root, filter, row } = overlay()
    expect(trapTarget(asHtml(root), asHtml(filter), false)).toBeNull()
    expect(trapTarget(asHtml(root), asHtml(row), true)).toBeNull()
  })

  it('steps out of spots Tab does not stop at without leaving', () => {
    const { root, close, heart, lastRow, trailing } = overlay()
    // the container itself: forward is the first stop, back wraps to the last
    expect(trapTarget(asHtml(root), asHtml(root), false)).toBe(close)
    expect(names([trapTarget(asHtml(root), asHtml(root), true)!])).toEqual(['in-legend'])
    // a clicked tabindex="-1" heart inside a row: on to the stop after it, or before it
    expect(names([trapTarget(asHtml(root), asHtml(heart), false)!])).toEqual(['in-legend'])
    expect(names([trapTarget(asHtml(root), asHtml(lastRow), true)!])).toEqual(['row'])
    // after the last stop: wraps instead of letting Tab out of the overlay
    expect(trapTarget(asHtml(root), asHtml(trailing), false)).toBe(close)
  })

  it('brings focus back in from outside', () => {
    const { page, root, close } = overlay()
    const behind = page.children[0]
    expect(trapTarget(asHtml(root), asHtml(behind), false)).toBe(close)
    expect(names([trapTarget(asHtml(root), asHtml(behind), true)!])).toEqual(['in-legend'])
    expect(trapTarget(asHtml(root), null, false)).toBe(close)
  })

  it('holds focus on the container when nothing inside can take it', () => {
    const root = h('div', { tabindex: '-1' }, [h('button', { disabled: '' }), h('button', { tabindex: '-1' })])
    expect(trapTarget(asHtml(root), null, false)).toBe(root)
  })
})

describe('fromNestedControl', () => {
  const heart = h('button', { id: 'remove' }, [h('svg')])
  const label = h('span')
  const row = h('div', { role: 'listitem', tabindex: '0' }, [label, heart])
  const card = h('div', { role: 'button', tabindex: '0' }, [h('span', { id: 'name' })])

  it('is true for a control inside the element handling the key', () => {
    expect(fromNestedControl({ target: heart as never, currentTarget: row as never })).toBe(true)
    expect(fromNestedControl({ target: heart.children[0] as never, currentTarget: row as never })).toBe(true)
  })

  it('is false for the element itself and for plain content inside it', () => {
    expect(fromNestedControl({ target: row as never, currentTarget: row as never })).toBe(false)
    expect(fromNestedControl({ target: label as never, currentTarget: row as never })).toBe(false)
    // a role="button" card is the control itself, not something nested in it
    expect(fromNestedControl({ target: card.children[0] as never, currentTarget: card as never })).toBe(false)
  })
})
