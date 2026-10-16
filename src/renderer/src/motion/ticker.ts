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
  /**
   * The display's refresh rate, measured from back-to-back frames (60 until measured). 120 on
   * ProMotion and other high-refresh displays.
   */
  refreshHz = 60
  /** Called whenever a subscriber is added (the pacing policy wakes a paused loop with it). */
  onAdd: (() => void) | null = null

  private cap = Infinity
  private entries: Entry[] = []
  private raf = 0
  private timer: ReturnType<typeof setTimeout> | 0 = 0
  private last = 0
  private running = false
  private hidden = typeof document !== 'undefined' ? document.hidden : false
  private dirty = false
  /** Inside the subscriber loop: add() must not splice the array being iterated. */
  private iterating = false
  private copied = false
  /**
   * When the cap timer asks for a capped frame, in ms relative to the vsync the frame should
   * start on. Where a rAF asked for between vsyncs lands depends on the browser and on how long
   * the page has been idle (Chromium serves some at once, stamped with the interval that has
   * begun); a frame that lands a vsync early has to be skipped (a wasted round of frame work), one
   * that lands late is a hitch. Nudged from where frames actually land.
   */
  private askOffset = 0
  /** When the cap timer asked for the frame being run (0: it wasn't the timer). */
  private timerAskedAt = 0
  /** This callback was asked for by the previous one, straight away (so they're a vsync apart). */
  private chained = false
  private prevCallback = 0
  /** Recent back-to-back frame intervals, for refreshHz. */
  private intervals = new Float32Array(24)
  private intervalCount = 0

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.hidden = document.hidden
        if (this.hidden) this.stop()
        else this.wake()
      })
    }
  }

  /**
   * Frame-rate cap (frames per second). Infinity = display refresh; 0 = paused (no frames until
   * it's raised again). Set by the pacing policy (motion/pacing.ts) when the app is idle or
   * unfocused, so a music player left in the background doesn't keep the GPU compositing.
   */
  get maxFps(): number {
    return this.cap
  }

  set maxFps(v: number) {
    const was = this.cap
    if (v === was) return
    this.cap = v
    if (v === 0) {
      this.stop()
      return
    }
    if (was === 0) this.wake()
    else if (v > was && this.timer) {
      // raised while waiting out a long capped interval: don't sit on the old timer
      clearTimeout(this.timer)
      this.timer = 0
      this.chained = false
      this.raf = requestAnimationFrame(this.loop)
    }
  }

  /** Subscribe; returns an unsubscribe function. */
  add(fn: TickFn, priority: number = TickPriority.normal): () => void {
    const e: Entry = { fn, priority, dead: false }
    // Mid-frame adds go into a copy: splicing the array being iterated would run (or skip) a
    // neighbouring subscriber twice in this frame.
    if (this.iterating && !this.copied) {
      this.entries = this.entries.slice()
      this.copied = true
    }
    // insertion keeps entries sorted by priority, stable for equal priorities
    let i = this.entries.length
    while (i > 0 && this.entries[i - 1].priority > priority) i--
    this.entries.splice(i, 0, e)
    this.onAdd?.()
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
    if (this.running || this.hidden || this.cap === 0) return
    if (!this.entries.some((e) => !e.dead)) return
    this.running = true
    this.last = 0
    this.chained = false
    this.raf = requestAnimationFrame(this.loop)
  }

  private stop(): void {
    if (!this.running) return
    this.running = false
    cancelAnimationFrame(this.raf)
    if (this.timer) clearTimeout(this.timer)
    this.timer = 0
  }

  /** One display refresh, ms. */
  private get vsyncMs(): number {
    return 1000 / this.refreshHz
  }

  /** Frame time of the next capped frame: a whole number of vsyncs after the last one. */
  private get due(): number {
    const vsync = this.vsyncMs
    return this.last + Math.max(1, Math.round(this.refreshHz / this.cap)) * vsync
  }

  /**
   * Ask for the next frame. Below the display rate, wait on a timer first and only then request
   * the frame: a requested-but-skipped rAF still costs the renderer a full BeginMainFrame
   * (lifecycle update + commit) and the compositor a frame. Not for frames two vsyncs apart
   * (30 fps at 60 Hz, 60 at 120 Hz): no request time lands those reliably, so the loop asks every
   * vsync and skips the one in between.
   */
  private schedule(): void {
    if (this.cap !== Infinity && this.last && this.refreshHz / this.cap > 2.5) {
      const wait = this.due + this.askOffset - performance.now()
      if (wait > 1) {
        this.timer = setTimeout(this.timed, wait)
        return
      }
    }
    this.timerAskedAt = 0
    this.chained = true
    this.raf = requestAnimationFrame(this.loop)
  }

  private timed = (): void => {
    this.timer = 0
    this.timerAskedAt = performance.now()
    this.chained = false
    if (this.running) this.raf = requestAnimationFrame(this.loop)
  }

  /** Refresh rate from the shortest typical interval (the median of the faster half of a window). */
  private sampleInterval(ms: number): void {
    if (ms < 2 || ms > 40) return
    const n = this.intervals.length
    this.intervals[this.intervalCount++ % n] = ms
    if (this.intervalCount % n !== 0) return
    const sorted = Array.from(this.intervals).sort((a, b) => a - b)
    const hz = 1000 / sorted[n >> 2]
    // snap to the common rates so small timing noise doesn't flip decisions
    this.refreshHz = hz > 200 ? 240 : hz > 130 ? 144 : hz > 100 ? 120 : hz > 80 ? 90 : hz > 67 ? 75 : 60
  }

  private loop = (t: number): void => {
    if (!this.running) return
    if (this.chained && this.prevCallback) this.sampleInterval(t - this.prevCallback)
    this.prevCallback = t
    if (this.cap !== Infinity && this.last) {
      const v = this.vsyncMs
      const due = this.due
      const asked = this.timerAskedAt
      if (t < due - v / 2) {
        // Early: skip it. From the timer, ask later from now on, and wait for the due vsync.
        if (asked) {
          this.askOffset = Math.min(this.askOffset + v / 6, v - 1)
          this.schedule()
        } else {
          this.chained = true
          this.raf = requestAnimationFrame(this.loop)
        }
        return
      }
      // Late (a vsync after the due one): ask earlier.
      if (asked && t > due + v / 2) this.askOffset = Math.max(this.askOffset - v / 6, 1 - v)
    }
    const raw = this.last ? t - this.last : 1000 / 60
    this.last = t
    this.rawDt = raw
    this.dt = raw > 100 ? 100 : raw < 0 ? 0 : raw
    this.now = t
    this.frameId++
    if (raw > 0 && raw < 250) this.fps += (1000 / raw - this.fps) * 0.1

    const list = this.entries
    this.iterating = true
    this.copied = false
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
    this.iterating = false
    if (this.dirty) {
      this.entries = this.entries.filter((e) => !e.dead)
      this.dirty = false
    }
    if (this.entries.length === 0) {
      this.running = false
      return
    }
    // a subscriber may have paused the loop (maxFps = 0) during this frame
    if (this.running) this.schedule()
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
