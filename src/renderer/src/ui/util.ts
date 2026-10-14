// Small helpers shared by the UI kit.
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type Ref, type RefCallback } from 'react'
import { HUES, hexToRgb, accentFamily, rgbTriplet, rgbToHex, type HueId } from '../theme'

/** Join class names, skipping falsy values. */
export function cx(...parts: unknown[]): string {
  let out = ''
  for (const p of parts) if (p && typeof p === 'string') out = out ? out + ' ' + p : p
  return out
}

/** Merge several refs (callback or object) into one callback ref. */
export function mergeRefs<T>(...refs: (Ref<T> | undefined | null)[]): RefCallback<T> {
  return (v: T | null) => {
    for (const r of refs) {
      if (!r) continue
      if (typeof r === 'function') r(v)
      else (r as { current: T | null }).current = v
    }
  }
}

/** A colour for a component: a hue id ('library'), any '#rrggbb', or undefined (= theme accent). */
export type Hue = HueId | (string & {})

/**
 * CSS variables that re-point --accent/--accent-rgb (and friends) for one subtree, so any
 * accent-driven component takes that hue: <div style={hueStyle('library')}>…</div>
 */
export function hueStyle(hue: Hue | undefined | null): CSSProperties | undefined {
  if (!hue) return undefined
  if (hue in HUES) {
    const id = hue as HueId
    const fam = accentFamily(HUES[id])
    return {
      '--accent': `var(--hue-${id})`,
      '--accent-rgb': `var(--hue-${id}-rgb)`,
      '--accent-hi': rgbToHex(...fam.hi),
      '--accent-hi-rgb': rgbTriplet(fam.hi),
      '--accent-lo': rgbToHex(...fam.lo),
      '--accent-lo-rgb': rgbTriplet(fam.lo),
      '--accent-ink': fam.ink
    } as CSSProperties
  }
  const fam = accentFamily(hue)
  return {
    '--accent': hue,
    '--accent-rgb': rgbTriplet(hexToRgb(hue)),
    '--accent-hi': rgbToHex(...fam.hi),
    '--accent-hi-rgb': rgbTriplet(fam.hi),
    '--accent-lo': rgbToHex(...fam.lo),
    '--accent-lo-rgb': rgbTriplet(fam.lo),
    '--accent-ink': fam.ink
  } as CSSProperties
}

/** useLayoutEffect that doesn't warn outside the DOM. */
export const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/** Stable callback identity that always calls the latest function. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useIsoLayoutEffect(() => {
    ref.current = fn
  })
  const stable = useRef((...args: A) => ref.current(...args))
  return stable.current
}

/** Where floating UI (tooltips, menus, dialogs) is portalled: the app root, so UI scale applies. */
export function portalRoot(): HTMLElement {
  return document.getElementById('g-app') ?? document.body
}

/** Current CSS zoom of the app root (settings.interface.uiScale), for converting viewport px. */
export function uiZoom(): number {
  const root = document.getElementById('g-app')
  const z = root ? parseFloat(root.style.zoom || '1') : 1
  return Number.isFinite(z) && z > 0 ? z : 1
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('inert') && el.offsetParent !== null)
}

/**
 * Keep Tab focus inside `ref` while `active`; focuses the first focusable (or the container)
 * on activation and restores the previously focused element afterwards.
 */
export function useFocusTrap(ref: { current: HTMLElement | null }, active: boolean, opts?: { initialFocus?: boolean }): void {
  useEffect(() => {
    const root = ref.current
    if (!active || !root) return
    const previous = document.activeElement as HTMLElement | null
    let timer = 0
    if (opts?.initialFocus !== false) {
      timer = window.setTimeout(() => {
        if (root.contains(document.activeElement)) return
        const auto = root.querySelector<HTMLElement>('[autofocus], [data-autofocus]')
        const first = auto ?? focusables(root)[0]
        ;(first ?? root).focus({ preventScroll: true })
      }, 30)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const list = focusables(root)
      if (list.length === 0) {
        e.preventDefault()
        root.focus()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const cur = document.activeElement
      if (e.shiftKey && (cur === first || !root.contains(cur))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (cur === last || !root.contains(cur))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKey, true)
      if (previous && document.contains(previous) && root.contains(document.activeElement)) previous.focus({ preventScroll: true })
    }
  }, [active, ref, opts?.initialFocus])
}
