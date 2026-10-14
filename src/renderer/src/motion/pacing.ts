// Frame-pacing policy for the global ticker. Full display rate whenever it can be seen to matter:
// while the user is interacting, or while music plays in a focused window. Otherwise the cap
// drops: the drifting pixels and pulses still move, just without burning a GPU core.
//
//   interacting (input in the last 4 s) ........ display rate
//   focused + playing .......................... display rate
//   focused, idle, not playing ................. 30 fps
//   unfocused + playing ........................ 30 fps
//   unfocused, not playing ..................... 12 fps
//   hidden / minimised ......................... stopped (ticker handles visibility)
import { usePlayer } from '../state/player'
import { ticker } from './ticker'

const ACTIVE_MS = 4000
let lastInput = performance.now()
let focused = typeof document !== 'undefined' ? document.hasFocus() : true
let started = false

function decide(): number {
  const playing = usePlayer.getState().status === 'playing'
  const interacting = performance.now() - lastInput < ACTIVE_MS
  if (focused && (interacting || playing)) return Infinity
  if (focused) return 30
  return playing ? 30 : 12
}

// Infinite CSS animations run on the compositor at full display rate no matter what the ticker
// does, so in low-power states we pause the purely decorative ones (bobbing logo, breathing
// glows, Ken Burns drifts). Progress indicators keep running.
const KEEP = /loading|spin|indet|wait|sweep|shimmer|sheen|bc-breathe/
const pausedByUs = new Set<Animation>()

function sweepAnimations(lowPower: boolean): void {
  if (typeof document.getAnimations !== 'function') return
  if (lowPower) {
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
    apply()
  })
  usePlayer.subscribe((s, prev) => {
    if (s.status !== prev.status) apply()
  })
  // Re-evaluate periodically so "interacting" times out.
  window.setInterval(apply, 1000)
  apply()
  // Debug handle (devtools / scripts/cdp.mjs): frame rate, cap and pacing inputs.
  ;(window as unknown as { __ghostPacing: unknown }).__ghostPacing = { ticker, get focused() { return focused }, get idleMs() { return performance.now() - lastInput } }
}
