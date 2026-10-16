import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowsePage, BrowseQuery } from '@shared/types'
import { Carousel, type Sel } from './carousel'
import { browseModel, PAGE_SIZE } from './model'
import { memory, useBrowse } from './store'
import { album, albumPagesOf, deferred, flush, installGhost, pagesOf, type Deferred } from './testing'

const { fakeEl } = vi.hoisted(() => {
  const fakeEl = (): unknown => ({
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    setAttribute() {},
    appendChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 900 }),
    clientWidth: 800,
    clientHeight: 900
  })
  return { fakeEl }
})

vi.mock('./panels', () => ({
  createPanel: (type: string) => ({ type, el: fakeEl(), panel: fakeEl(), glow: fakeEl(), ring: fakeEl(), title: fakeEl(), sub: null, meta: null, img: null, preview: null, cache: {} }),
  disposePanel: () => {},
  fillAlbum: () => {},
  fillGroup: () => {},
  fillLoading: () => {},
  fillTrack: () => {},
  finishLoading: () => {},
  resetPanel: () => {},
  setClass: () => false
}))
vi.mock('../../sound', () => ({ sfx: { play: () => {} } }))
vi.mock('../../motion/beat', () => ({ beat: { retain: () => () => {}, pulse: 0 } }))
vi.mock('../../motion/ticker', () => ({ ticker: { add: () => () => {} }, TickPriority: { physics: -100 } }))

interface Internals {
  rows: { id: string; type: string; label?: string; album: { id: string } | null }[]
  tick(dt: number, now: number): void
}
const inner = (c: Carousel) => c as unknown as Internals

/** Run frames (16 ms apart, on a clock of their own) until the scroll has followed the selection. */
function settle(c: Carousel): void {
  for (let i = 1; i <= 150; i++) inner(c).tick(16, i * 16)
}

let ghost: ReturnType<typeof installGhost>
let run = 0
let carousel: Carousel | null = null

beforeEach(() => {
  ghost = installGhost()
  vi.stubGlobal('document', { createElement: fakeEl, getElementById: () => null })
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  Object.assign(memory, { gi: 0, groupKey: null, albumId: null, trackId: null, exAlbum: null, collapsed: false, scroll: null, history: [] })
})
afterEach(() => {
  carousel?.destroy()
  carousel = null
  vi.unstubAllGlobals()
})

/** Results of their own for this test, and a carousel showing them. */
async function mount(keys: () => string[]): Promise<Carousel> {
  ghost.api.catalog.browse.mockImplementation(pagesOf(keys))
  await browseModel.setQuery({ text: `run ${++run}`, group: 'game', sort: 'title' })
  carousel = new Carousel(fakeEl() as HTMLElement, { activate: () => {}, menu: () => {} })
  return carousel
}

const selected = () => useBrowse.getState().sel

describe('a catalog refresh keeps the selected group', () => {
  const games = (n: number) => Array.from({ length: n }, (_, i) => `game:${i}`)

  /** Select `gi` (pages around it loaded and shown), then change the list and refresh with the pages held back. */
  async function refreshing(keys: { list: string[] }, gi: number, sel: Partial<Sel>, change: () => void) {
    const c = await mount(() => keys.list)
    c.select({ gi, albumId: null, trackId: null, ...sel })
    await flush()
    settle(c)
    await flush()
    change()
    const held = new Map<number, Deferred<BrowsePage>>()
    ghost.api.catalog.browse.mockImplementation((q: BrowseQuery) => {
      const d = deferred<BrowsePage>()
      held.set(q.offset / PAGE_SIZE, d)
      return d.promise
    })
    c.refreshData()
    const answer = async (p: number) => {
      held.get(p)!.resolve(await pagesOf(() => keys.list)({ text: '', group: 'game', sort: 'title', offset: p * PAGE_SIZE, limit: PAGE_SIZE }))
      await flush()
    }
    return { c, held, answer }
  }

  it('follows it onto the next page when it moves there, whichever page comes back first', async () => {
    for (const order of [
      [0, 1],
      [1, 0]
    ]) {
      const keys = { list: games(200) }
      // a game indexed meanwhile sorts before it: index 99 → 100, across the page boundary
      const { c, held, answer } = await refreshing(keys, 99, { albumId: 'alb-99' }, () => (keys.list = ['game:new', ...keys.list]))
      expect([...held.keys()].sort()).toEqual([0, 1])
      await answer(order[0])
      // meanwhile the wedge keeps showing it, not the game that took its index
      expect(selected()?.group?.key).toBe('game:99')
      await answer(order[1])
      expect(c.sel).toEqual({ gi: 100, albumId: 'alb-99', trackId: null })
      expect(selected()?.group?.key).toBe('game:99')
      expect(memory.groupKey).toBe('game:99')
      carousel!.destroy()
      carousel = null
    }
  })

  it('follows it back when it moves up a page', async () => {
    const keys = { list: games(200) }
    const { c, answer } = await refreshing(keys, 100, {}, () => (keys.list = keys.list.filter((k) => k !== 'game:3')))
    await answer(1)
    await answer(0)
    expect(c.sel.gi).toBe(99)
    expect(selected()?.group?.key).toBe('game:100')
  })

  it('finds it on a page next to those refreshed', async () => {
    const keys = { list: games(400) }
    const { c, held, answer } = await refreshing(keys, 150, {}, () => (keys.list = [...games(120).map((k) => k + 'x'), ...keys.list]))
    await answer(1)
    // not on the refreshed pages: the next one is asked for
    expect(held.has(2)).toBe(true)
    await answer(2)
    expect(c.sel.gi).toBe(270)
    expect(selected()?.group?.key).toBe('game:150')
  })

  it('a removed group leaves the selection where it was, without its album', async () => {
    const keys = { list: games(200) }
    const { c, answer } = await refreshing(keys, 99, { albumId: 'alb-99' }, () => (keys.list = keys.list.filter((k) => k !== 'game:99')))
    await answer(0)
    await answer(1)
    expect(c.sel).toEqual({ gi: 99, albumId: null, trackId: null })
    expect(selected()?.group?.key).toBe('game:100')
  })

  it('the user moving meanwhile is not overridden', async () => {
    const keys = { list: games(200) }
    const { c, answer } = await refreshing(keys, 99, {}, () => (keys.list = ['game:new', ...keys.list]))
    await answer(0)
    c.select({ gi: 50, albumId: null, trackId: null })
    expect(selected()?.group?.key).toBe('game:49')
    await answer(1)
    expect(c.sel.gi).toBe(50)
    expect(memory.groupKey).toBe('game:49')
  })
})

describe('long album lists', () => {
  it('a group of more than 1,000 albums can be scrolled to its last album; its totals say what is loaded', async () => {
    const all = Array.from({ length: 1234 }, (_, i) => album(`p${i}`))
    ghost.api.catalog.groupAlbumPage.mockImplementation(albumPagesOf(() => all))
    const c = await mount(() => ['platform:snes'])
    c.select({ gi: 0, albumId: null, trackId: null })
    await flush()
    expect(inner(c).rows.filter((r) => r.type === 'album')).toHaveLength(500)
    expect(selected()).toMatchObject({ albumsTotal: 1234 })
    expect(selected()!.albums).toHaveLength(500)

    // nearing the end of what's loaded brings the next albums
    for (const id of ['p480', 'p980']) {
      c.select({ gi: 0, albumId: id, trackId: null })
      await flush()
    }
    expect(inner(c).rows.filter((r) => r.type === 'album')).toHaveLength(1234)
    c.select({ gi: 0, albumId: 'p1233', trackId: null })
    expect(selected()).toMatchObject({ kind: 'album', album: { id: 'p1233' }, albumsTotal: 1234 })
    expect(selected()!.albums).toHaveLength(1234)
  })

  it('an album list that failed says so (not “No albums match”), and a deliberate load fills it in', async () => {
    ghost.api.catalog.groupAlbumPage.mockRejectedValueOnce(new Error('busy')).mockImplementation(albumPagesOf(() => [album('q1')]))
    const c = await mount(() => ['game:1'])
    c.select({ gi: 0, albumId: null, trackId: null })
    await flush()
    expect(inner(c).rows.map((r) => r.label)).toEqual(['Couldn’t load the albums · Click to try again'])

    await browseModel.loadAlbums('game:1')
    expect(inner(c).rows.map((r) => r.album?.id)).toEqual(['q1'])
  })

  it('the next albums failing says so at the end of the list', async () => {
    const all = Array.from({ length: 700 }, (_, i) => album(`r${i}`))
    ghost.api.catalog.groupAlbumPage.mockImplementation(albumPagesOf(() => all))
    const c = await mount(() => ['year:1995'])
    c.select({ gi: 0, albumId: null, trackId: null })
    await flush()
    ghost.api.catalog.groupAlbumPage.mockRejectedValueOnce(new Error('busy'))
    c.select({ gi: 0, albumId: 'r499', trackId: null })
    await flush()
    const rows = inner(c).rows
    expect(rows).toHaveLength(501)
    expect(rows.at(-1)!.label).toBe('Couldn’t load more albums · Click to try again')
  })
})
