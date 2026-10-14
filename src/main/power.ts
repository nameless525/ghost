// Keep macOS App Nap (and similar background throttling) away while music plays. App Nap
// coalesces and delays a background app's timers, which would make the player's heartbeat,
// gapless preloads and queue advances late; it is released as soon as playback stops.
import { powerSaveBlocker } from 'electron'
import type { PlayerState } from '../shared/types'

let blocker: number | null = null

export function onPlayerState(s: Partial<Pick<PlayerState, 'status'>> | null | undefined): void {
  // Partial updates (e.g. position-only heartbeats) don't carry a status: ignore them.
  if (!s || typeof s.status !== 'string') return
  const active = s.status === 'playing' || s.status === 'loading' || s.status === 'buffering'
  if (active && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
  else if (!active && blocker !== null) {
    powerSaveBlocker.stop(blocker)
    blocker = null
  }
}
