// Code-split components without React.lazy + <Suspense>.
//
// React holds back content that resolves after a Suspense fallback was shown until 300 ms after
// that fallback appeared (its FALLBACK_THROTTLE_MS), so a screen or overlay chunk that loads in
// 5 ms still appeared ~300 ms late: on every launch (the title screen), on the first visit to
// each screen and on the first open of each overlay. Here the module is loaded outside React; a
// component that is already loaded renders directly (same commit, no fallback), and one that
// isn't renders `null` until it arrives (the caller shows its own placeholder).
import { useEffect, useState, type ComponentType } from 'react'

export interface LazyModule<P> {
  /** Start (or join) the load; resolves with the component. A failed load can be retried. */
  load(): Promise<ComponentType<P>>
  /** The component if it has loaded, else null. */
  readonly loaded: ComponentType<P> | null
}

export function lazyModule<P>(factory: () => Promise<{ default: ComponentType<P> }>): LazyModule<P> {
  let promise: Promise<ComponentType<P>> | null = null
  const m: { loaded: ComponentType<P> | null; load(): Promise<ComponentType<P>> } = {
    loaded: null,
    load() {
      promise ??= factory().then(
        (mod) => (m.loaded = mod.default),
        (err: unknown) => {
          promise = null
          throw err
        }
      )
      return promise
    }
  }
  return m
}

/**
 * The module's component, or null while it loads (re-renders when it arrives). A load error is
 * thrown during render so the nearest ErrorBoundary shows it (its retry remounts and reloads).
 */
export function useLazyModule<P>(m: LazyModule<P>): ComponentType<P> | null {
  const [, arrived] = useState(0)
  const [error, setError] = useState<unknown>(null)
  const C = m.loaded
  useEffect(() => {
    if (C) return
    let live = true
    m.load().then(
      () => live && arrived((n) => n + 1),
      (err: unknown) => live && setError(() => err)
    )
    return () => {
      live = false
    }
  }, [m, C])
  if (error) throw error
  return C
}

/** Run `fn` when the main thread is idle (falls back to a timeout). */
export function whenIdle(fn: () => void, timeout = 2000): void {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
  if (ric) ric(fn, { timeout })
  else window.setTimeout(fn, 800)
}
