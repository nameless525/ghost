import { describe, expect, it } from 'vitest'
import { share } from './share'

describe('share', () => {
  it('returns prev when deep-equal', () => {
    const a = { x: 1, list: [{ id: 'a', n: [1, 2] }], nested: { s: 'v', z: null } }
    const b = structuredClone(a)
    expect(share(a, b)).toBe(a)
  })

  it('keeps unchanged branches and replaces changed ones', () => {
    const a = { pos: 1, current: { id: 't1', liked: false }, queue: [{ uid: 'u1' }, { uid: 'u2' }] }
    const b = structuredClone(a)
    b.pos = 2
    b.queue[1] = { uid: 'u3' }
    const r = share(a, b)
    expect(r).not.toBe(a)
    expect(r).toEqual(b)
    expect(r.current).toBe(a.current)
    expect(r.queue).not.toBe(a.queue)
    expect(r.queue[0]).toBe(a.queue[0])
    expect(r.queue[1]).toEqual({ uid: 'u3' })
  })

  it('handles added/removed keys and length changes', () => {
    const a: Record<string, unknown> = { a: 1, b: 2 }
    const b: Record<string, unknown> = { a: 1 }
    expect(share(a, b)).toEqual({ a: 1 })
    expect(share([1, 2], [1, 2, 3])).toEqual([1, 2, 3])
    expect(share([1, 2, 3], [1, 2])).toEqual([1, 2])
    const c = { a: 1, b: undefined }
    expect(share({ a: 1 } as Record<string, unknown>, c)).toEqual(c)
  })

  it('treats null/primitives by value', () => {
    expect(share(null, null)).toBe(null)
    expect(share({ a: 1 } as unknown, null)).toBe(null)
    expect(share(NaN, NaN)).toBeNaN()
  })
})
