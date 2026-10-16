// Frame-pacing policy for the global ticker. Full display rate whenever it can be seen to matter:
// while the user is interacting, or while music plays in a focused window. Otherwise the cap
// drops: the drifting pixels and pulses still move, just without burning a GPU core.
//
//   interacting (input in the last 4 s) ........ display rate
//   focused + playing .......................... display rate, at most 60 fps
//   focused, idle, not playing ................. 30 fps
//   unfocused + playing ........................ 30 fps
//   unfocused, not playing ..................... 12 fps for 10 s, then paused (0 fps)
//   hidden / minimised ......................... stopped (ticker handles visibility)
// While paused, anything new that animates (a tween, toast, accent glide: any ticker.add) wakes
// the loop at 12 fps for a couple of seconds, so it still plays out.
import { usePlayer } from '../state/player'
import { ticker } from './ticker'

const ACTIVE_MS = 4000
/**
 * Listening without touching anything: beat motion and visualizers are smooth at 60 fps, and on a
 * 120 Hz display (ProMotion) the full rate would draw, and cost, twice the frames. Displays at
 * 60 Hz or below are unaffected (a timer-paced 60 there would only add jitter).
 */
const PASSIVE_FPS = 60
/** Unfocused and silent for this long: stop drawing entirely. */
const PAUSE_AFTER_MS = 10000
/** A new animation while paused runs at least this long. */
const WAKE_MS = 2500
let lastInput = performance.now()
/** Last time focus was lost, or something new started animating. */
let lastBlur = performance.now()
let lastWake = 0
let focused = typeof document !== 'undefined' ? document.hasFocus() : true
let started = false

/** Debug/profiling override (window.__ghostPacing.override = fps | null). */
let override: number | null = null

function decide(): number {
  if (override !== null) return override
  const playing = usePlayer.getState().status === 'playing'
  const now = performance.now()
  const interacting = now - lastInput < ACTIVE_MS
  if (focused && interacting) return Infinity
  if (focused && playing) return ticker.refreshHz > PASSIVE_FPS + 10 ? PASSIVE_FPS : Infinity
  if (focused) return 30
  if (playing) return 30
  return now - Math.max(lastInput, lastBlur) < PAUSE_AFTER_MS || now - lastWake < WAKE_MS ? 12 : 0
}

// Infinite CSS animations run on the compositor at full display rate no matter what the ticker
// does, so in low-power states we pause the purely decorative ones (bobbing logo, breathing
// glows, Ken Burns drifts). Progress indicators keep running.
const KEEP = /loading|spin|indet|wait|sweep|shimmer|sheen|bc-breathe/
const pausedByUs = new Set<Animation>()

function sweepAnimations(lowPower: boolean): void {
  if (typeof document.getAnimations !== 'function') return
  if (lowPower) {
    // animations of removed elements are cancelled ('idle'): don't hold on to them
    for (const a of pausedByUs) if (a.playState === 'idle') pausedByUs.delete(a)
    for (const a of document.getAnimations()) {
      if (!(a instanceof CSSAnimation) || a.playState !== 'running' || KEEP.test(a.animationName)) continue
      if (a.effect?.getTiming().iterations !== Infinity) continue
      a.pause()
      pausedByUs.add(a)
    }
  } else if (pausedByUs.size) {
    for (const a of pausedByUs) if (a.playState === 'paused') a.play()
    pausedByUs.clear()
  }
}

function apply(): void {
  const fps = decide()
  ticker.maxFps = fps
  sweepAnimations(fps <= 30)
}

export function initFramePacing(): void {
  if (started) return
  started = true
  const onInput = () => {
    const was = performance.now() - lastInput >= ACTIVE_MS
    lastInput = performance.now()
    if (was) apply()
  }
  for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'touchstart'] as const) window.addEventListener(ev, onInput, { passive: true, capture: true })
  window.addEventListener('focus', () => {
    focused = true
    apply()
  })
  window.addEventListener('blur', () => {
    focused = false
    lastBlur = performance.now()
    apply()
  })
  ticker.onAdd = () => {
    lastWake = performance.now()
    if (ticker.maxFps === 0) apply()
  }
  usePlayer.subscribe((s, prev) => {
    if (s.status !== prev.status) apply()
  })
  // Re-evaluate periodically so "interacting" times out.
  window.setInterval(apply, 1000)
  apply()
  // Debug handle (devtools / scripts/cdp.mjs): frame rate, cap and pacing inputs.
  ;(window as unknown as { __ghostPacing: unknown }).__ghostPacing = {
    ticker,
    get focused() {
      return focused
    },
    get idleMs() {
      return performance.now() - lastInput
    },
    set override(v: number | null) {
      override = v
      apply()
    }
  }
}
