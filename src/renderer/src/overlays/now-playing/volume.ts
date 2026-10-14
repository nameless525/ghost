// One volume controller for every in-app volume change (Play ↑/↓, Alt+scroll, sliders, the
// meter's own wheel). It applies the change optimistically (so repeated nudges stack before
// the engine echoes the state back) and tells the global VolumeMeter to show itself.
import { ghost } from '../../ghost'
import { usePlayer } from '../../state/player'

export interface VolumeSnapshot {
  volume: number
  muted: boolean
}

type Listener = (v: VolumeSnapshot) => void
const listeners = new Set<Listener>()

let pending: VolumeSnapshot | null = null
let pendingTimer = 0

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const round = (v: number) => Math.round(v * 1000) / 1000

function current(): VolumeSnapshot {
  const s = usePlayer.getState()
  return pending ?? { volume: s.volume, muted: s.muted }
}

function publish(v: VolumeSnapshot): void {
  pending = v
  window.clearTimeout(pendingTimer)
  // the engine's state echo normally lands well within this; afterwards trust the store
  pendingTimer = window.setTimeout(() => (pending = null), 900)
  for (const l of listeners) l(v)
}

export const volume = {
  /** Latest volume/mute, including changes not yet echoed by the engine. */
  get: current,

  /** Set the 0..1 slider volume. Raising the volume unmutes. */
  set(v: number): void {
    const next = round(clamp01(v))
    const cur = current()
    const unmute = cur.muted && next > 0
    publish({ volume: next, muted: unmute ? false : cur.muted })
    void ghost().player.setVolume(next)
    if (unmute) void ghost().player.setMuted(false)
  },

  /** Relative change, e.g. +0.05 for ↑. */
  nudge(delta: number): void {
    volume.set(current().volume + delta)
  },

  setMuted(muted: boolean): void {
    const cur = current()
    publish({ volume: cur.volume, muted })
    void ghost().player.setMuted(muted)
  },

  toggleMute(): void {
    volume.setMuted(!current().muted)
  },

  /** Re-show the meter without changing anything (e.g. hovering it). */
  peek(): void {
    for (const l of listeners) l(current())
  },

  /** Called on every change made through this controller. */
  subscribe(l: Listener): () => void {
    listeners.add(l)
    return () => listeners.delete(l)
  }
}
