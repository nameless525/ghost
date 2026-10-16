import { describe, expect, it } from 'vitest'
import type { PlayerState, TrackView } from '@shared/types'
import { positionSync } from './useMediaSession'

const track = (id: string) => ({ id, title: id }) as unknown as TrackView
const state = (over: Partial<PlayerState>) => ({ status: 'paused', current: null, positionMs: 0, positionAt: 0, durationMs: null, ...over }) as PlayerState

/** A MediaSession stand-in that keeps what the OS would show. */
function session() {
  const calls: (MediaPositionState | undefined)[] = []
  let shown: MediaPositionState | null = null
  return {
    calls,
    shown: () => shown,
    ms: {
      setPositionState(s?: MediaPositionState) {
        calls.push(s)
        shown = s ?? null
      }
    }
  }
}

describe('positionSync', () => {
  it('clears the range when the next track’s duration is unknown, and sets it once known', () => {
    const os = session()
    const sync = positionSync(os.ms)
    sync(state({ current: track('a'), durationMs: 120_000, positionMs: 30_000 }))
    expect(os.shown()).toEqual({ duration: 120, playbackRate: 1, position: 30 })
    sync(state({ current: track('b'), durationMs: null, positionMs: 0 }))
    expect(os.shown()).toBeNull()
    // no repeated clears while it stays unknown
    sync(state({ current: track('b'), durationMs: null, positionMs: 0 }))
    expect(os.calls).toHaveLength(2)
    sync(state({ current: track('b'), durationMs: 90_000, positionMs: 1000 }))
    expect(os.shown()).toEqual({ duration: 90, playbackRate: 1, position: 1 })
  })

  it('clears it when the queue is cleared', () => {
    const os = session()
    const sync = positionSync(os.ms)
    sync(state({ current: track('a'), durationMs: 120_000, positionMs: 30_000 }))
    sync(state({ status: 'idle', current: null, durationMs: null }))
    expect(os.shown()).toBeNull()
  })

  it('still skips heartbeats that match the extrapolated position', () => {
    let now = 0
    const os = session()
    const sync = positionSync(os.ms, () => now)
    // positionAt in the future: the live position is positionMs as given
    const at = (positionMs: number) => state({ status: 'playing', current: track('a'), durationMs: 120_000, positionMs, positionAt: 1e15 })
    sync(at(10_000))
    now = 1000
    sync(at(11_000))
    now = 2000
    sync(at(12_100))
    expect(os.calls).toHaveLength(1)
    // a seek
    now = 3000
    sync(at(60_000))
    expect(os.calls).toHaveLength(2)
    expect(os.shown()?.position).toBe(60)
  })
})
