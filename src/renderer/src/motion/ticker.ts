// The one and only animation loop. Everything that moves per frame (tweens, springs,
// beat tracking, the PixiJS background, visualisers) subscribes here, so the app does a
// single requestAnimationFrame per display refresh (120 Hz on ProMotion) and never
// fights itself. The loop sleeps when nothing is subscribed and while the window is hidden.

import { useEffect, useRef } from 'react'

/** dt: ms since the previous frame (clamped to 100 ms); now: rAF timestamp (performance.now domain). */
export type TickFn = (dt: number, now: number) => void

/** Run order inside a frame: lower runs first. */
export const TickPriority = {
  /** Input sampling, analysis-frame read. */
  input: -300,
  /** Beat clock, audio levels. */
  audio: -200,
  /** Springs / physics. */
  physics: -100,
  normal: 0,
  /** Tweens write styles. */
  tween: 50,
  /** GPU renders last so they see this frame's state. */
  render: 100,
  /** Measurement (FPS meter). */
  measure: 200
} as const

interface Entry {
  fn: TickFn
  priority: number
  dead: boolean
}

class Ticker {
  /** Timestamp of the current/last frame. */
  now = performance.now()
  /** Clamped delta of the current/last frame in ms. */
  dt = 1000 / 60
  /** Raw (unclamped) delta of the last frame in ms. */
  rawDt = 1000 / 60
  /** Increments once per frame; used for per-frame caches. */
  frameId = 0
  /** Smoothed frames per second. */
  fps = 60

  private entries: Entry[] = []
  private raf = 0
  private last = 0
  private running = false
  private hidden = typeof document !== 'undefined' ? document.hidden : false
  private dirty = false

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.hidden = document.hidden
        if (this.hidden) this.stop()
        else this.wake()
      })
    }
  }

  /** Subscribe; returns an unsubscribe function. */
  add(fn: TickFn, priority: number = TickPriority.normal): () => void {
    const e: Entry = { fn, priority, dead: false }
    // insertion keeps entries sorted by priority, stable for equal priorities
    let i = this.entries.length
    while (i > 0 && this.entries[i - 1].priority > priority) i--
    this.entries.splice(i, 0, e)
    this.wake()
    return () => {
      if (e.dead) return
      e.dead = true
      this.dirty = true
    }
  }

  /** Run `fn` once on the next frame. */
  once(fn: TickFn, priority: number = TickPriority.normal): void {
    const off = this.add((dt, now) => {
      off()
      fn(dt, now)
    }, priority)
  }

  get active(): boolean {
    return this.running
  }

  private wake(): void {
    if (this.running || this.hidden) return
    if (!this.entries.some((e) => !e.dead)) return
    this.running = true
    this.last = 0
    this.raf = requestAnimationFrame(this.loop)
  }

  private stop(): void {
    if (!this.running) return
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  private loop = (t: number): void => {
    if (!this.running) return
    const raw = this.last ? t - this.last : 1000 / 60
    this.last = t
    this.rawDt = raw
    this.dt = raw > 100 ? 100 : raw < 0 ? 0 : raw
    this.now = t
    this.frameId++
    if (raw > 0 && raw < 250) this.fps += (1000 / raw - this.fps) * 0.1

    const list = this.entries
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      if (e.dead) continue
      try {
        e.fn(this.dt, t)
      } catch (err) {
        console.error('[ticker] subscriber threw; removing it', err)
        e.dead = true
        this.dirty = true
      }
    }
    if (this.dirty) {
      this.entries = this.entries.filter((e) => !e.dead)
      this.dirty = false
    }
    if (this.entries.length === 0) {
      this.running = false
      return
    }
    this.raf = requestAnimationFrame(this.loop)
  }
}

export const ticker = new Ticker()

/**
 * Subscribe a component to the global ticker. The callback may change between renders
 * without resubscribing. Pass `enabled=false` to pause.
 */
export function useTicker(fn: TickFn, enabled = true, priority: number = TickPriority.normal): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!enabled) return
    return ticker.add((dt, now) => ref.current(dt, now), priority)
  }, [enabled, priority])
}
