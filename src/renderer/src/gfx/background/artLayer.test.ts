import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Just enough of pixi.js to see which texture each art slot shows and which were freed.
vi.mock('pixi.js', () => {
  class Texture {
    static EMPTY = new Texture(null)
    destroyed = false
    constructor(readonly source: { width: number; height: number } | null) {}
    static from(source: { width: number; height: number }) {
      return new Texture(source)
    }
    destroy() {
      this.destroyed = true
    }
  }
  class Container {
    children: Container[] = []
    alpha = 1
    visible = true
    addChild(...c: Container[]) {
      this.children.push(...c)
    }
    removeChild(c: Container) {
      this.children = this.children.filter((x) => x !== c)
    }
    destroy() {}
  }
  class Sprite extends Container {
    anchor = { set() {} }
    position = { set() {} }
    tint = 0
    width = 0
    height = 0
    constructor(public texture: Texture) {
      super()
    }
  }
  return { Container, Sprite, Texture }
})

import { ArtLayer } from './artLayer'

interface FakeTexture {
  destroyed: boolean
  source: { width: number } | null
}
interface SlotView {
  quality: string
  fade: number
  blurred: { texture: FakeTexture }
  sharp: { texture: FakeTexture; visible: boolean }
}

/** Image loads, each held until the test lets it finish. */
let loads: { url: string; finish: () => void }[] = []

beforeEach(() => {
  loads = []
  vi.stubGlobal('fetch', (url: string) => new Promise((resolve) => loads.push({ url, finish: () => resolve({ ok: true, status: 200, blob: async () => ({ url }) }) })))
  // a 1600 px image, or the size asked for
  vi.stubGlobal('createImageBitmap', async (_blob: unknown, o?: { resizeWidth?: number }) => ({ width: o?.resizeWidth ?? 1600, height: 900, close() {} }))
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ filter: '', drawImage() {} }) }) })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const slots = (layer: ArtLayer) => (layer as unknown as { slots: SlotView[] }).slots
const flush = () => new Promise((r) => setTimeout(r, 0))
/** Let every pending image load finish. */
async function finishLoads() {
  while (loads.length) {
    loads.shift()!.finish()
    await flush()
  }
}
/** Run frames until every cross-fade has settled. */
function settle(layer: ArtLayer) {
  const t = performance.now()
  for (let now = t; now <= t + 2000; now += 16) layer.update(16, now + 1000, 1280, 800, 0, 0)
}
const shownWidth = (layer: ArtLayer) => slots(layer).map((s) => s.blurred.texture.source?.width)

describe('ArtLayer blur quality', () => {
  it('rebuilds the art on screen when the quality changes, cross-fading to it', async () => {
    const layer = new ArtLayer()
    const set = layer.setArt('https://img/cover.jpg')
    await finishLoads()
    await set
    settle(layer)
    expect(shownWidth(layer)).toEqual([480])
    const high = slots(layer)[0].blurred.texture

    layer.setQuality('low')
    await finishLoads()
    // the low copy fades in over the high one…
    expect(slots(layer).map((s) => s.quality)).toEqual(['high', 'low'])
    expect(slots(layer)[1].fade).toBe(0)
    settle(layer)
    // …which then retires and is freed
    expect(shownWidth(layer)).toEqual([320])
    expect(high.destroyed).toBe(true)

    // back again
    layer.setQuality('high')
    await finishLoads()
    settle(layer)
    expect(shownWidth(layer)).toEqual([480])
  })

  it('a load started before the change never shows at the old quality', async () => {
    const layer = new ArtLayer()
    void layer.setArt('https://img/cover.jpg')
    expect(loads).toHaveLength(1)
    layer.setQuality('low') // while the high copy is still loading
    await finishLoads()
    settle(layer)
    expect(slots(layer).map((s) => s.quality)).toEqual(['low'])
    expect(shownWidth(layer)).toEqual([320])
  })

  it('quick toggles end on the last quality, with nothing extra on screen', async () => {
    const layer = new ArtLayer()
    void layer.setArt('https://img/cover.jpg')
    await finishLoads()
    settle(layer)
    layer.setQuality('low')
    layer.setQuality('high')
    layer.setQuality('low')
    await finishLoads()
    settle(layer)
    expect(slots(layer).map((s) => s.quality)).toEqual(['low'])
    expect(shownWidth(layer)).toEqual([320])
  })

  it('the same art at the same quality is not rebuilt', async () => {
    const layer = new ArtLayer()
    void layer.setArt('https://img/cover.jpg')
    await finishLoads()
    settle(layer)
    void layer.setArt('https://img/cover.jpg')
    layer.setQuality('high')
    expect(loads).toHaveLength(0)
    expect(slots(layer)).toHaveLength(1)
  })

  it('keeps the sharp copy through the change: Play does not flash blurred', async () => {
    const layer = new ArtLayer()
    layer.setDim(0.3, 0) // Play: unblurred
    void layer.setArt('https://img/cover.jpg')
    await finishLoads() // blur source, then the sharp copy
    await finishLoads()
    settle(layer)
    expect(slots(layer)[0].sharp.visible).toBe(true)
    layer.setQuality('low')
    await finishLoads()
    // no new full-size load, and mid-fade both copies show the sharp art
    expect(loads).toHaveLength(0)
    layer.update(16, performance.now() + 100, 1280, 800, 0, 0)
    expect(slots(layer).map((s) => s.sharp.visible)).toEqual([true, true])
  })
})
