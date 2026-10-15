// Mirror of the main-process PlayerState, plus a live (extrapolated) position helper.
//
// Every 'player:state' push is a fresh structured clone, and the queue is only included when
// it changed (PlayerStateEvent). Incoming state is merged with structural sharing: anything
// deep-equal to what we already hold keeps its identity, so selectors like (s) => s.current
// don't re-render their components on the 1 Hz heartbeat, a volume step or a seek.
import { create } from 'zustand'
import type { PlayerState, PlayerStateEvent } from '@shared/types'
import { ghost } from '../ghost'
import { share } from '../lib/share'

const initial: PlayerState = {
  status: 'idle',
  current: null,
  currentAnalysis: null,
  positionMs: 0,
  positionAt: Date.now(),
  durationMs: null,
  volume: 0.8,
  muted: false,
  shuffle: 'off',
  repeat: 'off',
  loopMode: 'album',
  queue: [],
  queueIndex: -1,
  context: null,
  preview: null,
  error: null,
  voices: null
}

export const usePlayer = create<PlayerState>(() => initial)

/**
 * performance.now() stops while the machine sleeps (macOS/Linux), so timeOrigin + now() falls
 * behind the wall clock by every sleep, while main stamps positions with Date.now(). Re-anchored
 * on every state push (≥ 1 Hz while playing); without it the live position sat seconds-to-hours
 * in the past after a lid close (seek bars at 0, no beat pulses) until a reload.
 */
let clockSkew = 0
function resyncClock(): void {
  const skew = Date.now() - (performance.timeOrigin + performance.now())
  // Date.now() only has ms resolution: ignore jitter, follow real jumps (sleep, NTP steps)
  if (Math.abs(skew - clockSkew) > 4) clockSkew = skew
}

/** Sub-millisecond epoch clock in the same domain as Date.now(). */
export const epochNow = (): number => performance.timeOrigin + performance.now() + clockSkew

/** Current playback position in ms, extrapolated between state updates. Call from rAF loops. */
export function livePositionMs(s: PlayerState = usePlayer.getState()): number {
  if (s.status !== 'playing') return s.positionMs
  const p = s.positionMs + Math.max(0, epochNow() - s.positionAt)
  return s.durationMs ? Math.min(p, s.durationMs) : p
}

/**
 * Fold a 'player:state' event (or a full state) into the store. Returns false when the event
 * refers to a queue revision we don't hold (the caller should refetch the full state).
 */
export function applyPlayerState(e: PlayerStateEvent | PlayerState): boolean {
  resyncClock()
  const prev = usePlayer.getState()
  let queue = e.queue
  if (queue === undefined) {
    // queue omitted: it's unchanged since the last broadcast, which we must have seen
    if (e.queueRev !== undefined && prev.queueRev !== e.queueRev) return false
    queue = prev.queue
  }
  const next: PlayerState = { ...e, queue }
  usePlayer.setState(share(prev, next), true)
  return true
}

let refetching = false
function refetch(): void {
  if (refetching) return
  refetching = true
  void ghost()
    .player.getState()
    .then((s) => applyPlayerState(s))
    .finally(() => {
      refetching = false
    })
}

export function initPlayerStore(): void {
  void ghost().player.getState().then((s) => applyPlayerState(s))
  ghost().on('player:state', (s) => {
    if (!applyPlayerState(s)) refetch()
  })
}
