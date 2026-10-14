// Mirror of the main-process PlayerState, plus a live (extrapolated) position helper.
import { create } from 'zustand'
import type { PlayerState } from '@shared/types'
import { ghost } from '../ghost'

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
  error: null
}

export const usePlayer = create<PlayerState>(() => initial)

/** Sub-millisecond epoch clock in the same domain as Date.now(). */
export const epochNow = (): number => performance.timeOrigin + performance.now()

/** Current playback position in ms, extrapolated between state updates. Call from rAF loops. */
export function livePositionMs(s: PlayerState = usePlayer.getState()): number {
  if (s.status !== 'playing') return s.positionMs
  const p = s.positionMs + (epochNow() - s.positionAt)
  return s.durationMs ? Math.min(p, s.durationMs) : p
}

export function initPlayerStore(): void {
  void ghost().player.getState().then((s) => usePlayer.setState(s, true))
  ghost().on('player:state', (s) => usePlayer.setState(s, true))
}
