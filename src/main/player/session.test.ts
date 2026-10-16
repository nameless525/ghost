import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSessionStore, type SessionData } from './session'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-session-'))
  dirs.push(dir)
  const file = join(dir, 'session.json')
  return { file, s: new FileSessionStore(file) }
}

const data = (over: Partial<SessionData> = {}): SessionData => ({
  v: 1,
  queue: [
    { uid: 'a', trackId: '1' },
    { uid: 'b', trackId: '2' }
  ],
  originalOrder: null,
  queueIndex: 1,
  positionMs: 1234,
  shuffle: 'off',
  repeat: 'all',
  volume: 0.5,
  muted: false,
  context: null,
  savedAt: 99,
  ...over
})

describe('FileSessionStore', () => {
  it('round-trips, with the queue reused while only the position changes', () => {
    const { file, s } = store()
    const first = data()
    s.save(first)
    expect(s.load()).toEqual(first)
    // same queue array, new position: still valid JSON with everything in it
    s.save({ ...first, positionMs: 5678, savedAt: 100 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...first, positionMs: 5678, savedAt: 100 })
    // a new queue array is written as itself
    const queue = [{ uid: 'c', trackId: '3' }]
    s.save({ ...first, queue, queueIndex: 0 })
    expect(s.load()).toEqual({ ...first, queue, queueIndex: 0 })
  })

  it('keeps an empty queue valid', () => {
    const { s } = store()
    s.save(data({ queue: [], queueIndex: -1 }))
    expect(s.load()?.queue).toEqual([])
  })
})
