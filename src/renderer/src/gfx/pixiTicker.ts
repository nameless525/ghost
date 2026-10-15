// Pixi's hidden render loop, folded into ours.
//
// Every Pixi renderer registers a SchedulerSystem (its texture / renderable GC timers) on
// Ticker.system, an auto-started Pixi ticker with its own requestAnimationFrame loop. That loop
// ran at the display rate for the whole session, outside the app's one paced loop: even with the
// ticker capped to 12 fps or paused, every vsync still cost a BeginMainFrame (rAF, lifecycle
// update, commit) and a compositor frame. Stop it and pump it from the app ticker instead; the
// GC timers only need checking now and then, and not at all while nothing is drawn.
import { Ticker } from 'pixi.js'
import { ticker, TickPriority } from '../motion/ticker'

const PUMP_MS = 1000
let adopted = false

/** Call after creating a Pixi renderer (idempotent). */
export function adoptPixiTicker(): void {
  const sys = Ticker.system
  sys.autoStart = false
  sys.stop()
  if (adopted) return
  adopted = true
  let last = 0
  ticker.add((_dt, now) => {
    if (now - last < PUMP_MS) return
    last = now
    sys.update(now)
  }, TickPriority.render + 1)
}
