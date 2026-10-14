import { describe, expect, it } from 'vitest'
import type { PlayerState, TrackView } from '@shared/types'
import { applyPlayerState, usePlayer } from './player'

const track = (id: string): TrackView => ({ id, title: `Song ${id}`, liked: false, source: { provider: 'khinsider', format: 'mp3' } }) as unknown as TrackView

function full(over: Partial<PlayerState> = {}): PlayerState {
  const queue = [
    { uid: 'u1', track: track('t1') },
    { uid: 'u2', track: track('t2') }
  ]
  return { ...usePlayer.getState(), status: 'playing', current: queue[0].track, queue, queueIndex: 0, queueRev: 1, positionMs: 0, positionAt: 1000, ...over }
}

describe('applyPlayerState', () => {
  it('keeps unchanged objects (current, queue) across pushes', () => {
    expect(applyPlayerState(full())).toBe(true)
    const a = usePlayer.getState()
    // heartbeat: fresh clone, queue omitted, same revision
    const { queue: _q, ...hb } = structuredClone(full({ positionMs: 1000, positionAt: 2000 }))
    expect(applyPlayerState(hb)).toBe(true)
    const b = usePlayer.getState()
    expect(b.positionMs).toBe(1000)
    expect(b.current).toBe(a.current)
    expect(b.queue).toBe(a.queue)
  })

  it('takes a new queue when it is sent and shares unchanged items', () => {
    applyPlayerState(full())
    const a = usePlayer.getState()
    const next = structuredClone(full({ queueRev: 2 }))
    next.queue.push({ uid: 'u3', track: track('t3') })
    applyPlayerState(next)
    const b = usePlayer.getState()
    expect(b.queue).toHaveLength(3)
    expect(b.queue[0]).toBe(a.queue[0])
    expect(b.queueRev).toBe(2)
  })

  it('asks for a refetch when the event names a queue it does not hold', () => {
    applyPlayerState(full())
    const { queue: _q, ...ev } = full({ queueRev: 5 })
    expect(applyPlayerState(ev)).toBe(false)
    expect(usePlayer.getState().queueRev).toBe(1)
  })
})
