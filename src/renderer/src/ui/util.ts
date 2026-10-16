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

const CONTROLS = 'button, a[href], input, select, textarea, [contenteditable="true"], [role="button"], [role="checkbox"], [role="switch"], [role="slider"]'

/**
 * True for a key event that a control inside the handler's element (a row's remove button)
 * received: its Enter / Space / Delete belong to that control, not to the row around it.
 */
export function fromNestedControl(e: { target: EventTarget | null; currentTarget: EventTarget | null }): boolean {
  const target = e.target as Element | null
  const own = e.currentTarget as Element | null
  if (!target || !own || target === own || typeof target.closest !== 'function') return false
  const control = target.closest(CONTROLS)
  return !!control && control !== own && own.contains(control)
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

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex], [contenteditable="true"]'

// Node.compareDocumentPosition bits
const PRECEDING = 2
const FOLLOWING = 4

/**
 * Whether Tab stops on a FOCUSABLE candidate: not disabled (a disabled fieldset counts), not
 * taken out of the order (tabindex="-1", like Library's row hearts), not in an inert subtree
 * (Library's hidden tabs), and rendered (display: none or visibility: hidden on the way up).
 */
function tabbable(el: HTMLElement): boolean {
  return el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert]') && el.checkVisibility({ visibilityProperty: true })
}

/** What Tab visits inside `root`, in its order: positive tabindex first, then document order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  const order = (el: HTMLElement) => (el.tabIndex > 0 ? el.tabIndex : Number.MAX_SAFE_INTEGER)
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter(tabbable)
    .sort((a, b) => order(a) - order(b))
}

/**
 * Where Tab (Shift+Tab when `back`) has to move focus to stay inside `root`, or null when the
 * browser's own move stays inside. Wraps at either end, and steps out of a spot Tab doesn't stop
 * at (the container itself, a tabindex="-1" row), where the browser could leave `root`.
 */
export function trapTarget(root: HTMLElement, current: Element | null, back: boolean): HTMLElement | null {
  const list = focusables(root)
  if (!list.length) return root
  const first = list[0]
  const last = list[list.length - 1]
  if (!current || !root.contains(current)) return back ? last : first
  const i = list.indexOf(current as HTMLElement)
  if (i >= 0) return back ? (i === 0 ? last : null) : i === list.length - 1 ? first : null
  const next = back ? list.findLast((el) => current.compareDocumentPosition(el) & PRECEDING) : list.find((el) => current.compareDocumentPosition(el) & FOLLOWING)
  return next ?? (back ? last : first)
}

/** Active focus traps, innermost (most recent) last: only that one handles Tab. */
const traps: HTMLElement[] = []

/**
 * Keep Tab focus inside `ref` while `active`; focuses the first focusable (or the container)
 * on activation and restores the previously focused element afterwards. Traps nest (a dialog
 * over a modal overlay): only the innermost one acts, otherwise the outer trap pulled focus back
 * into itself and the inner one pushed it to its first element on every Tab.
 */
export function useFocusTrap(ref: { current: HTMLElement | null }, active: boolean, opts?: { initialFocus?: boolean }): void {
  useEffect(() => {
    const root = ref.current
    if (!active || !root) return
    traps.push(root)
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
      if (e.key !== 'Tab' || traps[traps.length - 1] !== root) return
      const to = trapTarget(root, document.activeElement, e.shiftKey)
      if (!to) return
      e.preventDefault()
      to.focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      const i = traps.lastIndexOf(root)
      if (i >= 0) traps.splice(i, 1)
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKey, true)
      if (previous && document.contains(previous) && root.contains(document.activeElement)) previous.focus({ preventScroll: true })
    }
  }, [active, ref, opts?.initialFocus])
}
