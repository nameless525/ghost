// Damped springs for physics-y motion (carousel scrolling, hover magnetism, follow-the-mouse).
//
//   const s = new Spring({ value: 0, frequency: 3, damping: 0.75 })
//   s.drive((v) => (el.style.transform = `translateY(${v}px)`))   // auto-ticks while moving
//   s.to(120)                                                      // retarget any time
//   s.impulse(-800)                                                // add velocity (flings)
//
// `frequency` is the undamped natural frequency in Hz (higher = snappier); `damping` is the
// damping ratio ζ (1 = critically damped, <1 overshoots, >1 sluggish).

import { ticker, TickPriority } from './ticker'
import { motionPrefs } from './prefs'

export interface SpringOptions {
  value?: number
  target?: number
  /** Natural frequency in Hz. Default 2.5. */
  frequency?: number
  /** Damping ratio ζ. Default 1 (critically damped). */
  damping?: number
  /** Rest threshold for both distance and velocity. Default 0.001. */
  precision?: number
}

export class Spring {
  value: number
  target: number
  velocity = 0
  frequency: number
  damping: number
  precision: number

  private listener: ((v: number, s: Spring) => void) | null = null
  private off: (() => void) | null = null
  private restCbs: (() => void)[] = []

  constructor(o: SpringOptions = {}) {
    this.value = o.value ?? 0
    this.target = o.target ?? this.value
    this.frequency = o.frequency ?? 2.5
    this.damping = o.damping ?? 1
    this.precision = o.precision ?? 0.001
  }

  get atRest(): boolean {
    return Math.abs(this.target - this.value) < this.precision && Math.abs(this.velocity) < this.precision * 10
  }

  /** Advance by dt milliseconds (semi-implicit Euler with ≤4 ms substeps: stable at any frame rate). */
  step(dtMs: number): number {
    if (motionPrefs.reduce) {
      this.value = this.target
      this.velocity = 0
      return this.value
    }
    const w = 2 * Math.PI * this.frequency
    const k = w * w
    const c = 2 * this.damping * w
    let remaining = Math.min(dtMs, 100) / 1000
    while (remaining > 0) {
      const h = Math.min(remaining, 0.004)
      const a = -k * (this.value - this.target) - c * this.velocity
      this.velocity += a * h
      this.value += this.velocity * h
      remaining -= h
    }
    if (this.atRest) {
      this.value = this.target
      this.velocity = 0
    }
    return this.value
  }

  /** Retarget (wakes the driver). */
  to(target: number): this {
    this.target = target
    this.wake()
    return this
  }

  /** Jump without animation. */
  set(value: number, target = value): this {
    this.value = value
    this.target = target
    this.velocity = 0
    this.listener?.(this.value, this)
    this.wake()
    return this
  }

  /** Add velocity (units per second). */
  impulse(v: number): this {
    this.velocity += v
    this.wake()
    return this
  }

  /** Have the global ticker step this spring and call `fn` each frame while it moves. */
  drive(fn: (v: number, s: Spring) => void): () => void {
    this.listener = fn
    fn(this.value, this)
    this.wake()
    return () => this.stop()
  }

  /** Callback once the spring next comes to rest. */
  onRest(cb: () => void): void {
    if (this.atRest && !this.off) cb()
    else this.restCbs.push(cb)
  }

  stop(): void {
    this.listener = null
    this.off?.()
    this.off = null
  }

  private wake(): void {
    if (this.off || !this.listener) return
    if (this.atRest) {
      this.listener(this.value, this)
      return
    }
    this.off = ticker.add((dt) => {
      this.step(dt)
      this.listener?.(this.value, this)
      if (this.atRest) {
        this.off?.()
        this.off = null
        const cbs = this.restCbs
        this.restCbs = []
        cbs.forEach((c) => c())
      }
    }, TickPriority.physics)
  }
}
