// osu!framework-style transforms for DOM elements.
//
//   tween(el).fadeTo(1, 300, 'outQuint').moveTo(40, 0, 400)      // run together
//   tween(el).moveToX(-20, 200).then().fadeOut(300)               // .then() sequences
//   tween(el).delay(120).scaleTo(1.05, 200, 'outBack')
//   await tween(el).fadeOut(250)                                  // thenable: resolves when done
//   tween(el).then(() => el.remove())                             // .then(cb): callback at the end
//   tween(el).clear()                                             // stop everything (pending callbacks fire)
//
// Semantics (same as osu!framework):
// - Transforms added in one chain start at the chain's cursor; `.delay(ms)` moves the cursor,
//   `.then()` moves it to the end of everything queued so far in this chain.
// - A new transform on a property replaces any transforms of that property that start at
//   or after it; a running one is superseded from the moment the new one starts, which then
//   animates from the property's current value. So re-targeting mid-flight is seamless.
// - Only `transform`, `opacity` and `filter` are written, and only the ones you touched.
//   The transform is composed as translate3d → rotate → skewX → scale. The tween engine owns
//   the element's inline `transform`; pair it with CSS `scale`/`translate` (e.g. usePulse
//   writes `scale`) if something else must move the same element.
// - Honours settings.interface.reduceMotion: movement becomes instant, fades are capped at 150 ms.

import { clamp01, resolveEasing, type Easing, type EasingFn } from './easing'
import { motionPrefs } from './prefs'
import { ticker, TickPriority } from './ticker'

export type TweenProp = 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotate' | 'shear' | 'opacity' | 'blur'

export type TweenValues = Partial<Record<TweenProp | 'scale', number>>

type Styled = Element & ElementCSSInlineStyle

interface Transform {
  start: number
  end: number
  from: number | null
  to: number
  ease: EasingFn
}

const MOVEMENT: Record<TweenProp, boolean> = {
  x: true,
  y: true,
  scaleX: true,
  scaleY: true,
  rotate: true,
  shear: true,
  opacity: false,
  blur: true
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

class ElState {
  v: Record<TweenProp, number> = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, shear: 0, opacity: 1, blur: 0 }
  tracks: Partial<Record<TweenProp, Transform[]>> = {}
  callbacks: { time: number; fn: () => void }[] = []
  touchedTransform = false
  touchedOpacity = false
  touchedBlur = false
  lastT = ''
  lastO = ''
  lastF = ''
  active = false

  constructor(public el: Styled | null) {
    const o = el?.style.opacity
    if (o) this.v.opacity = parseFloat(o)
  }

  add(prop: TweenProp, to: number, start: number, duration: number, ease: EasingFn): void {
    if (motionPrefs.reduce) duration = MOVEMENT[prop] ? 0 : Math.min(duration, 150)
    const list = (this.tracks[prop] ??= [])
    let i = list.length
    while (i > 0 && list[i - 1].start >= start) i--
    list.length = i
    list.push({ start, end: start + Math.max(0, duration), from: null, to, ease })
    if (prop === 'opacity') this.touchedOpacity = true
    else if (prop === 'blur') this.touchedBlur = true
    else this.touchedTransform = true
    // Instant transforms that are due now apply synchronously: no one-frame flash.
    const now = performance.now()
    if (duration <= 0 && start <= now) {
      this.update(now)
      this.write()
    }
    activate(this)
  }

  addCallback(time: number, fn: () => void): void {
    let i = this.callbacks.length
    while (i > 0 && this.callbacks[i - 1].time > time) i--
    this.callbacks.splice(i, 0, { time, fn })
    activate(this)
  }

  clear(): void {
    this.tracks = {}
    const cbs = this.callbacks
    this.callbacks = []
    for (const c of cbs) c.fn()
  }

  /** Advance to `now`; returns true while anything is pending. */
  update(now: number): boolean {
    let busy = false
    const v = this.v
    for (const key in this.tracks) {
      const prop = key as TweenProp
      const list = this.tracks[prop]!
      if (list.length === 0) continue
      let k = -1
      for (let i = 0; i < list.length; i++) {
        if (list[i].start <= now) k = i
        else break
      }
      if (k < 0) {
        busy = true
        continue
      }
      for (let i = 0; i <= k; i++) {
        const tr = list[i]
        if (tr.from === null) tr.from = v[prop]
        const until = i < k ? list[i + 1].start : now
        const d = tr.end - tr.start
        const p = d <= 0 ? 1 : clamp01((until - tr.start) / d)
        // (done lands on the target itself: from + (to - from) can miss it by a rounding error)
        v[prop] = p >= 1 ? tr.to : tr.from + (tr.to - tr.from) * tr.ease(p)
      }
      if (k > 0) list.splice(0, k)
      if (now >= list[0].end) list.shift()
      if (list.length) busy = true
    }
    while (this.callbacks.length && this.callbacks[0].time <= now) {
      const c = this.callbacks.shift()!
      try {
        c.fn()
      } catch (err) {
        console.error('[tween] callback threw', err)
      }
    }
    if (this.callbacks.length) busy = true
    return busy
  }

  write(): void {
    const el = this.el
    if (!el) return
    const v = this.v
    if (this.touchedTransform) {
      let t = `translate3d(${r3(v.x)}px, ${r3(v.y)}px, 0)`
      if (v.rotate) t += ` rotate(${r3(v.rotate)}deg)`
      if (v.shear) t += ` skewX(${r3(v.shear)}rad)`
      if (v.scaleX !== 1 || v.scaleY !== 1) t += ` scale(${r3(v.scaleX)}, ${r3(v.scaleY)})`
      if (t !== this.lastT) el.style.transform = this.lastT = t
    }
    if (this.touchedOpacity) {
      const o = String(r3(Math.max(0, Math.min(1, v.opacity))))
      if (o !== this.lastO) el.style.opacity = this.lastO = o
    }
    if (this.touchedBlur) {
      const f = v.blur > 0.05 ? `blur(${r3(v.blur)}px)` : ''
      if (f !== this.lastF) el.style.filter = this.lastF = f
    }
  }
}

const states = new WeakMap<Element, ElState>()
const activeSet = new Set<ElState>()
let unsubscribe: (() => void) | null = null

function activate(s: ElState): void {
  if (s.active) return
  s.active = true
  activeSet.add(s)
  if (!unsubscribe) unsubscribe = ticker.add(step, TickPriority.tween)
}

function step(_dt: number, now: number): void {
  for (const s of activeSet) {
    const busy = s.update(now)
    s.write()
    if (!busy) {
      s.active = false
      activeSet.delete(s)
    }
  }
  if (activeSet.size === 0 && unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}

function stateFor(el: Element | null | undefined): ElState {
  if (!el) return new ElState(null)
  let s = states.get(el)
  if (!s) states.set(el, (s = new ElState(el as Styled)))
  return s
}

export class Tween implements PromiseLike<void> {
  private cursor: number
  private groupEnd: number

  constructor(private s: ElState, start: number) {
    this.cursor = start
    this.groupEnd = start
  }

  private push(prop: TweenProp, to: number, duration = 0, easing?: Easing): this {
    const ease = resolveEasing(easing)
    this.s.add(prop, to, this.cursor, duration, ease)
    const d = motionPrefs.reduce ? (MOVEMENT[prop] ? 0 : Math.min(duration, 150)) : duration
    this.groupEnd = Math.max(this.groupEnd, this.cursor + d)
    return this
  }

  fadeTo(opacity: number, duration = 0, easing?: Easing): this {
    return this.push('opacity', opacity, duration, easing)
  }
  fadeIn(duration = 0, easing?: Easing): this {
    return this.push('opacity', 1, duration, easing)
  }
  fadeOut(duration = 0, easing?: Easing): this {
    return this.push('opacity', 0, duration, easing)
  }
  moveTo(x: number, y: number, duration = 0, easing?: Easing): this {
    return this.push('x', x, duration, easing).push('y', y, duration, easing)
  }
  moveToX(x: number, duration = 0, easing?: Easing): this {
    return this.push('x', x, duration, easing)
  }
  moveToY(y: number, duration = 0, easing?: Easing): this {
    return this.push('y', y, duration, easing)
  }
  /** Uniform `scaleTo(1.05)` or non-uniform `scaleTo([1, 0.9])`. */
  scaleTo(scale: number | [number, number], duration = 0, easing?: Easing): this {
    const [sx, sy] = typeof scale === 'number' ? [scale, scale] : scale
    return this.push('scaleX', sx, duration, easing).push('scaleY', sy, duration, easing)
  }
  /** Degrees. */
  rotateTo(deg: number, duration = 0, easing?: Easing): this {
    return this.push('rotate', deg, duration, easing)
  }
  /** skewX in radians (lazer shear is -0.15). */
  shearTo(rad: number, duration = 0, easing?: Easing): this {
    return this.push('shear', rad, duration, easing)
  }
  /** CSS blur radius in px (expensive on large elements; use sparingly). */
  blurTo(px: number, duration = 0, easing?: Easing): this {
    return this.push('blur', px, duration, easing)
  }
  /** Set values instantly at the cursor: `.set({ opacity: 0, x: -40, scale: 0.9 })`. */
  set(values: TweenValues): this {
    for (const [k, val] of Object.entries(values)) {
      if (val === undefined) continue
      if (k === 'scale') this.push('scaleX', val).push('scaleY', val)
      else this.push(k as TweenProp, val)
    }
    return this
  }
  /** Shift the cursor: following transforms start `ms` later. */
  delay(ms: number): this {
    this.cursor += motionPrefs.reduce ? Math.min(ms, 0) : ms
    this.groupEnd = Math.max(this.groupEnd, this.cursor)
    return this
  }
  /** Run `fn` when the cursor time is reached. */
  call(fn: () => void): this {
    this.s.addCallback(this.cursor, fn)
    return this
  }
  /**
   * `.then()` → sequence: following transforms start after everything queued so far.
   * `.then(cb)` → run cb once everything queued so far has finished (or was cleared).
   * Being thenable, `await tween(el)...` waits for completion.
   */
  then<R = void>(onDone?: ((value: void) => R | PromiseLike<R>) | null, _onError?: unknown): this & PromiseLike<R> {
    if (typeof onDone === 'function') this.s.addCallback(this.groupEnd, () => void onDone())
    else this.cursor = this.groupEnd
    return this as this & PromiseLike<R>
  }
  /** A real Promise resolving when everything queued so far is done. */
  get finished(): Promise<void> {
    return new Promise((r) => this.s.addCallback(this.groupEnd, r))
  }
  /** Absolute end time (performance.now domain) of everything queued so far. */
  get endTime(): number {
    return this.groupEnd
  }
  /** Cancel every transform on this element (current values are kept, pending callbacks fire). */
  clear(): this {
    this.s.clear()
    return this
  }
}

/** Start a transform chain on an element. A null element yields a harmless no-op chain. */
export function tween(el: Element | null | undefined, opts?: { delay?: number }): Tween {
  const t = new Tween(stateFor(el), performance.now())
  if (opts?.delay) t.delay(opts.delay)
  return t
}

/** Cancel all transforms on `el`. */
tween.clear = (el: Element | null | undefined): void => {
  if (el) states.get(el)?.clear()
}

/** Current (animated) values for `el`. */
tween.get = (el: Element | null | undefined): Readonly<Record<TweenProp, number>> => stateFor(el).v

/** True while `el` has pending transforms. */
tween.isActive = (el: Element | null | undefined): boolean => !!el && !!states.get(el)?.active

/**
 * Staggered choreography: `fn` builds each element's chain, offset by `step` ms per index.
 * Resolves when the last one finishes.
 *   await stagger(rows, (t) => t.set({ opacity: 0, x: 30 }).fadeIn(300).moveToX(0, 450), 35)
 */
export function stagger(
  els: ArrayLike<Element | null | undefined>,
  fn: (t: Tween, i: number) => Tween,
  step = 40,
  opts?: { delay?: number; reverse?: boolean }
): Promise<void> {
  const list = Array.from(els)
  if (opts?.reverse) list.reverse()
  const ends = list.map((el, i) => fn(tween(el, { delay: (opts?.delay ?? 0) + i * step }), i).finished)
  return Promise.all(ends).then(() => undefined)
}

export interface ValueAnimation {
  cancel(): void
  finished: Promise<void>
}

/**
 * Tween an arbitrary number (canvas / Pixi / CSS variables).
 *   animateValue({ from: 0, to: 1, duration: 600, onUpdate: (v) => sprite.alpha = v })
 */
export function animateValue(o: {
  from: number
  to: number
  duration: number
  easing?: Easing
  delay?: number
  onUpdate: (v: number) => void
  onComplete?: () => void
}): ValueAnimation {
  const ease = resolveEasing(o.easing)
  const dur = motionPrefs.reduce ? 0 : o.duration
  const start = performance.now() + (o.delay ?? 0)
  let resolve!: () => void
  const finished = new Promise<void>((r) => (resolve = r))
  let done = false
  const off = ticker.add((_dt, now) => {
    if (done) return
    if (now < start) return
    const p = dur <= 0 ? 1 : clamp01((now - start) / dur)
    o.onUpdate(p >= 1 ? o.to : o.from + (o.to - o.from) * ease(p))
    if (p >= 1) {
      done = true
      off()
      o.onComplete?.()
      resolve()
    }
  }, TickPriority.tween)
  return {
    cancel() {
      if (done) return
      done = true
      off()
      resolve()
    },
    finished
  }
}
