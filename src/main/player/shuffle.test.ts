import { describe, expect, it } from 'vitest'
import { adjacentRepeats, fisherYates, LIKED_WEIGHT, minAdjacentRepeats, smartShuffle } from './shuffle'

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Item {
  id: number
  game: string
  liked: boolean
}

const entry = (i: Item) => ({ group: i.game, liked: i.liked })

describe('fisherYates', () => {
  it('is a permutation', () => {
    const r = rng(1)
    for (let n = 0; n < 20; n++) {
      const a = Array.from({ length: n }, (_, i) => i)
      const s = fisherYates(a, r)
      expect([...s].sort((x, y) => x - y)).toEqual(a)
    }
  })
})

describe('smartShuffle', () => {
  it('is a permutation of its input', () => {
    const r = rng(7)
    const items: Item[] = Array.from({ length: 50 }, (_, i) => ({ id: i, game: `g${i % 7}`, liked: i % 5 === 0 }))
    const out = smartShuffle(items, entry, null, r)
    expect(out.map((x) => x.id).sort((a, b) => a - b)).toEqual(items.map((x) => x.id))
  })

  it('achieves the minimum possible number of same-game neighbours on random inputs', () => {
    const r = rng(1234)
    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + Math.floor(r() * 30)
      const games = 1 + Math.floor(r() * 6)
      // skewed distributions so some inputs are infeasible
      const items: Item[] = Array.from({ length: n }, (_, i) => ({ id: i, game: `g${Math.floor(Math.pow(r(), 2) * games)}`, liked: r() < 0.3 }))
      const prev = r() < 0.5 ? `g${Math.floor(r() * games)}` : null
      const out = smartShuffle(items, entry, prev, r)
      const best = minAdjacentRepeats(items.map((x) => x.game), prev)
      expect(adjacentRepeats(out, (x) => x.game, prev), `trial ${trial}`).toBe(best)
    }
  })

  it('never repeats a game back-to-back when spacing is possible', () => {
    const r = rng(99)
    const items: Item[] = []
    for (let g = 0; g < 5; g++) for (let k = 0; k < 4; k++) items.push({ id: items.length, game: `g${g}`, liked: false })
    for (let i = 0; i < 200; i++) {
      const out = smartShuffle(items, entry, 'g0', r)
      expect(adjacentRepeats(out, (x) => x.game, 'g0')).toBe(0)
    }
  })

  it('weights liked tracks toward the front', () => {
    const r = rng(5)
    const items: Item[] = Array.from({ length: 40 }, (_, i) => ({ id: i, game: `g${i}`, liked: i < 10 }))
    let likedPos = 0
    let otherPos = 0
    const runs = 400
    for (let k = 0; k < runs; k++) {
      smartShuffle(items, entry, null, r).forEach((x, i) => {
        if (x.liked) likedPos += i
        else otherPos += i
      })
    }
    const likedAvg = likedPos / (runs * 10)
    const otherAvg = otherPos / (runs * 30)
    expect(LIKED_WEIGHT).toBeGreaterThan(1)
    expect(likedAvg).toBeLessThan(otherAvg - 5)
  })

  it('still varies the order between runs', () => {
    const r = rng(3)
    const items: Item[] = Array.from({ length: 12 }, (_, i) => ({ id: i, game: `g${i % 4}`, liked: false }))
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) seen.add(smartShuffle(items, entry, null, r).map((x) => x.id).join(','))
    expect(seen.size).toBeGreaterThan(15)
  })
})
