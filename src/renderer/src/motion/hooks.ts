// React bindings for the motion toolkit.
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useSettings } from '../state/settings'
import { beat, type BeatEvent } from './beat'
import { retainLevels } from './frame'
import { motionPrefs } from './prefs'
import { ticker, TickPriority } from './ticker'

export interface PulseOptions {
  /** Peak extra scale on a normal beat (downbeats ×1.35, kiai ×1.2). Default 0.04 → 1.00 → 1.04. */
  amount?: number
  /** Default true. */
  enabled?: boolean
  /**
   * 'scale' (default) writes the CSS `scale` property, which composes with `transform`
   * (so tweens and pulses can share an element). 'var' writes a 0..1.6 custom property
   * instead (default `--pulse`) for CSS-driven effects like glows.
   */
  mode?: 'scale' | 'var'
  varName?: string
}

/** Make an element breathe with the music. */
export function usePulse(ref: RefObject<HTMLElement | SVGElement | null>, opts: PulseOptions = {}): void {
  const o = useRef(opts)
  o.current = opts
  const enabled = opts.enabled !== false
  useEffect(() => {
    if (!enabled) return
    const release = beat.retain()
    let last = ''
    const off = ticker.add(() => {
      const el = ref.current
      if (!el) return
      const { amount = 0.04, mode = 'scale', varName = '--pulse' } = o.current
      const p = motionPrefs.reduce ? 0 : beat.pulse
      if (mode === 'scale') {
        const s = p > 0.0005 ? (1 + amount * p).toFixed(4) : ''
        if (s !== last) el.style.scale = last = s
      } else {
        const v = p.toFixed(3)
        if (v !== last) el.style.setProperty(varName, (last = v))
      }
    }, TickPriority.normal)
    return () => {
      off()
      release()
      const el = ref.current
      if (el) {
        el.style.scale = ''
        el.style.removeProperty(o.current.varName ?? '--pulse')
      }
    }
  }, [enabled, ref])
}

/** Call `cb` on every beat (grid or onset fallback). */
export function useBeat(cb: (e: BeatEvent) => void, enabled = true): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    if (!enabled) return
    return beat.onBeat((e) => ref.current(e))
  }, [enabled])
}

/** React state that flips when a kiai section starts/ends. (Re-renders only on change.) */
export function useKiai(): boolean {
  const [k, setK] = useState(beat.inKiai)
  useEffect(() => beat.onKiai(setK), [])
  return k
}

/** Keep `levels` (frame.ts) updating while the component is mounted. */
export function useAudioLevels(enabled = true): void {
  useEffect(() => (enabled ? retainLevels() : undefined), [enabled])
}

/** settings.interface.reduceMotion as React state. */
export function useReducedMotion(): boolean {
  return useSettings((s) => s.interface.reduceMotion)
}
