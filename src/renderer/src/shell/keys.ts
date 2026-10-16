// Keyboard bindings with osu!-like precedence: modal dialog > overlay > screen > global.
//
//   useKeybinding('Mod+L', () => toggleOverlay('library'))
//   useKeybinding(['ArrowDown', 'J'], next, { repeat: true })
//   useKeybinding('Escape', () => collapse(), { when: () => expanded })   // return false = not handled
//
// The scope defaults to the nearest <KeyScopeContext> (ScreenStack provides 'screen' for each
// screen, OverlayHost provides 'overlay' for each panel), so screen bindings only fire while
// that screen is active with no modal overlay open, and overlay bindings only fire while that
// overlay is the top-most. Within a scope, higher `priority` wins, then the most recently
// registered binding. A handler returning `false` passes the key on to the next binding.
//
// Combos: 'Mod' = ⌘ on macOS, Ctrl elsewhere. Modifiers: Mod, Ctrl, Meta/Cmd, Alt/Option,
// Shift. Keys: letters/digits ('L', '2'), 'Space', 'Enter', 'Escape', 'Tab', 'Backspace',
// 'Delete', 'ArrowUp/Down/Left/Right' (or 'Up'/'Left'…), 'Home', 'End', 'PageUp', 'PageDown',
// 'F1'–'F12', or a literal character like '?', '/', '['.
//
// Typing in inputs never triggers bindings unless the combo uses Mod/Ctrl/Alt, is Escape or
// an F-key, or the binding sets `allowInInput` (a key typed in a field counts as typing even if
// the field's own handler blurred it). Components that consume a key themselves should call
// e.preventDefault() (bindings skip defaultPrevented events).

import { createContext, useContext, useEffect, useRef } from 'react'
import { isMac } from '../theme'

export type KeyScope = 'global' | 'screen' | 'overlay' | 'modal'
const WEIGHT: Record<KeyScope, number> = { global: 0, screen: 1, overlay: 2, modal: 3 }

export interface KeyScopeValue {
  scope: KeyScope
  /** Evaluated on each keydown; inactive scopes don't receive keys. */
  isActive: () => boolean
  /** e.g. the screen or overlay id, for debugging. */
  id?: string
}

export const KeyScopeContext = createContext<KeyScopeValue>({ scope: 'global', isActive: () => true, id: 'root' })

export type KeyHandler = (e: KeyboardEvent) => boolean | void

export interface KeybindingOptions {
  /** Defaults to the surrounding KeyScopeContext. */
  scope?: KeyScope
  /** Higher wins within the same scope. Default 0. */
  priority?: number
  /** Default true. */
  enabled?: boolean
  /** Extra condition checked at keydown time. */
  when?: () => boolean
  /** Fire even while typing in an input. */
  allowInInput?: boolean
  /** Fire on auto-repeat. Default true. */
  repeat?: boolean
  /** preventDefault when handled. Default true. */
  preventDefault?: boolean
}

interface Combo {
  key: string | null
  code: string | null
  ctrl: boolean
  meta: boolean
  alt: boolean
  /** null = don't care (symbols whose key already implies shift). */
  shift: boolean | null
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  plus: '+',
  minus: '-'
}

export function parseCombo(combo: string): Combo {
  const parts = combo === '+' ? ['+'] : combo.split('+').map((p) => p.trim()).filter(Boolean)
  const raw = parts.pop() ?? ''
  const c: Combo = { key: null, code: null, ctrl: false, meta: false, alt: false, shift: false }
  for (const m of parts.map((p) => p.toLowerCase())) {
    if (m === 'mod') {
      if (isMac) c.meta = true
      else c.ctrl = true
    } else if (m === 'ctrl' || m === 'control') c.ctrl = true
    else if (m === 'meta' || m === 'cmd' || m === 'command') c.meta = true
    else if (m === 'alt' || m === 'option' || m === 'opt') c.alt = true
    else if (m === 'shift') c.shift = true
  }
  const lower = raw.toLowerCase()
  if (/^[a-z]$/i.test(raw)) c.code = 'Key' + raw.toUpperCase()
  else if (/^[0-9]$/.test(raw)) c.code = 'Digit' + raw
  else if (lower === 'space') c.code = 'Space'
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) c.key = raw.toUpperCase()
  else if (KEY_ALIASES[lower]) c.key = KEY_ALIASES[lower]
  else {
    c.key = raw
    if (!parts.some((p) => p.toLowerCase() === 'shift')) c.shift = null
  }
  return c
}

function matches(c: Combo, e: KeyboardEvent): boolean {
  if (c.ctrl !== e.ctrlKey || c.meta !== e.metaKey || c.alt !== e.altKey) return false
  if (c.shift !== null && c.shift !== e.shiftKey) return false
  if (c.code) return e.code === c.code
  return e.key === c.key || (c.key!.length === 1 && e.key.toLowerCase() === c.key!.toLowerCase())
}

/** Human-readable keycaps for a combo, platform-aware: 'Mod+Shift+L' → ['⌘', '⇧', 'L']. */
export function formatCombo(combo: string): string[] {
  const parts = combo === '+' ? ['+'] : combo.split('+').map((p) => p.trim())
  return parts.map((p) => {
    const l = p.toLowerCase()
    if (l === 'mod') return isMac ? '⌘' : 'Ctrl'
    if (l === 'ctrl' || l === 'control') return isMac ? '⌃' : 'Ctrl'
    if (l === 'meta' || l === 'cmd' || l === 'command') return isMac ? '⌘' : 'Win'
    if (l === 'alt' || l === 'option' || l === 'opt') return isMac ? '⌥' : 'Alt'
    if (l === 'shift') return isMac ? '⇧' : 'Shift'
    if (l === 'escape' || l === 'esc') return 'Esc'
    if (l === 'enter' || l === 'return') return '↵'
    if (l === 'arrowleft' || l === 'left') return '←'
    if (l === 'arrowright' || l === 'right') return '→'
    if (l === 'arrowup' || l === 'up') return '↑'
    if (l === 'arrowdown' || l === 'down') return '↓'
    if (l === 'space') return 'Space'
    if (l === 'backspace') return '⌫'
    if (l === 'delete') return 'Del'
    if (l === 'pageup') return 'PgUp'
    if (l === 'pagedown') return 'PgDn'
    return p.length === 1 ? p.toUpperCase() : p
  })
}

// ---- registry ------------------------------------------------------------------

interface Binding {
  combos: Combo[]
  seq: number
  get: () => { handler: KeyHandler; opts: KeybindingOptions; ctx: KeyScopeValue }
}

const bindings = new Set<Binding>()
let seq = 0
let modalDepth = 0

/** Block all non-modal bindings while a modal dialog is open. Returns the release fn. */
export function pushModalScope(): () => void {
  modalDepth++
  let done = false
  return () => {
    if (done) return
    done = true
    modalDepth--
  }
}

export const isModalScopeActive = (): boolean => modalDepth > 0

function isEditable(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLInputElement) {
    const t = el.type
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(t)
  }
  return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable
}

const isActivatable = (el: Element | null) =>
  !!el && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SUMMARY' || ['button', 'menuitem', 'option', 'switch', 'tab', 'radio', 'checkbox'].includes(el.getAttribute('role') ?? ''))

/**
 * For Enter / Space bindings: a control focused from the keyboard (button, link, menu item…) gets
 * the key itself, so the binding should step aside (return false). A control that merely kept
 * focus after a mouse click is blurred instead, and the key is the binding's.
 */
export function focusedControlTakesKey(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || !isActivatable(el)) return false
  if (el.matches(':focus-visible')) return true
  el.blur()
  return false
}

function isCommandLike(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey || e.key === 'Escape' || /^F\d{1,2}$/.test(e.key)
}

/**
 * Keys a text field handles itself even with modifiers: caret/word/line moves (⌘←, ⌥→, Ctrl+←…),
 * deletion, clipboard, select-all and undo. Bindings must not take these from an input
 * (⌘← in a search box used to skip the track instead of moving the caret).
 */
function isTextEditing(e: KeyboardEvent): boolean {
  return /^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown|Backspace|Delete)$/.test(e.key) || ((e.metaKey || e.ctrlKey) && /^Key[ACVXYZ]$/.test(e.code))
}

function onKeyDown(e: KeyboardEvent): void {
  // keyCode 229: the key went to an IME (WebKit reports a candidate's confirming Enter as that)
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return
  // Where the key was typed, not where focus is after the handlers before this one (Enter in the
  // Browse search box blurs it: that Enter is the search's, not Browse's play)
  const editable = isEditable((e.target as Element | null) ?? document.activeElement)
  const candidates: { b: Binding; w: number; p: number; h: KeyHandler; o: KeybindingOptions }[] = []
  let heldRepeat = false
  for (const b of bindings) {
    const { handler, opts, ctx } = b.get()
    if (opts.enabled === false) continue
    if (!b.combos.some((c) => matches(c, e))) continue
    if (editable && !opts.allowInInput && (!isCommandLike(e) || isTextEditing(e))) continue
    const scope = opts.scope ?? ctx.scope
    if (modalDepth > 0 && scope !== 'modal') continue
    if (scope === ctx.scope && !ctx.isActive()) continue
    if (opts.when && !opts.when()) continue
    if (e.repeat && opts.repeat === false) {
      heldRepeat = true
      continue
    }
    candidates.push({ b, w: WEIGHT[scope], p: opts.priority ?? 0, h: handler, o: opts })
  }
  if (!candidates.length) {
    // A held key whose binding doesn't repeat (Space, Enter…) is still ours: without this, the
    // auto-repeats fell through to the browser and page-scrolled the focused list.
    if (heldRepeat) e.preventDefault()
    return
  }
  candidates.sort((a, b) => b.w - a.w || b.p - a.p || b.b.seq - a.b.seq)
  for (const c of candidates) {
    if (c.h(e) === false) continue
    if (c.o.preventDefault !== false) e.preventDefault()
    e.stopPropagation()
    return
  }
}

declare global {
  interface Window {
    __ghostKeysInstalled?: boolean
  }
}

if (typeof window !== 'undefined' && !window.__ghostKeysInstalled) {
  window.__ghostKeysInstalled = true
  window.addEventListener('keydown', (e) => onKeyDown(e))
}

/** Register bindings imperatively (outside React). Returns the unregister fn. */
export function registerKeybinding(combo: string | string[], handler: KeyHandler, opts: KeybindingOptions = {}, ctx?: KeyScopeValue): () => void {
  const scopeCtx = ctx ?? { scope: 'global' as KeyScope, isActive: () => true }
  const b: Binding = {
    combos: (Array.isArray(combo) ? combo : [combo]).map(parseCombo),
    seq: ++seq,
    get: () => ({ handler, opts, ctx: scopeCtx })
  }
  bindings.add(b)
  return () => void bindings.delete(b)
}

/** Bind a key combo (or several) for the lifetime of the component. */
export function useKeybinding(combo: string | string[], handler: KeyHandler, opts: KeybindingOptions = {}): void {
  const ctx = useContext(KeyScopeContext)
  const live = useRef({ handler, opts, ctx })
  live.current = { handler, opts, ctx }
  const key = Array.isArray(combo) ? combo.join('\u0000') : combo
  const enabled = opts.enabled !== false
  useEffect(() => {
    if (!enabled) return
    const b: Binding = {
      combos: key.split('\u0000').map(parseCombo),
      seq: ++seq,
      get: () => live.current
    }
    bindings.add(b)
    return () => void bindings.delete(b)
  }, [key, enabled])
}
