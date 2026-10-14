// True after `ms` without pointer/keyboard/wheel activity (attract mode, auto-hiding controls).
import { useEffect, useState } from 'react'

export function useIdle(ms: number, enabled = true): boolean {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setIdle(false)
      return
    }
    let t = 0
    let isIdle = false
    const arm = () => {
      window.clearTimeout(t)
      t = window.setTimeout(() => {
        isIdle = true
        setIdle(true)
      }, ms)
    }
    const activity = () => {
      if (isIdle) {
        isIdle = false
        setIdle(false)
      }
      arm()
    }
    arm()
    const evs = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const
    evs.forEach((e) => window.addEventListener(e, activity, { passive: true, capture: true }))
    return () => {
      window.clearTimeout(t)
      evs.forEach((e) => window.removeEventListener(e, activity, { capture: true }))
    }
  }, [ms, enabled])
  return idle
}
