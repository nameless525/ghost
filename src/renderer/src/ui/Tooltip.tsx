// Tooltips: one shared, animated bubble (TooltipHost, mounted once by App via <UIHosts/>).
//
//   <Tooltip content="Add to queue" shortcut="Q"><IconButton … /></Tooltip>
//
// The child must be a single element that accepts a ref and pointer/focus handlers.
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'
import { createPortal } from 'react-dom'
import { place, type Side } from './floating'
import { Kbd } from './Kbd'
import { cx, mergeRefs, portalRoot } from './util'

interface TipState {
  anchor: HTMLElement
  content: ReactNode
  shortcut?: string
  side: Side
}

type Listener = (s: TipState | null) => void
let listener: Listener | null = null
let current: TipState | null = null
let lastHiddenAt = 0

const api = {
  show(s: TipState) {
    current = s
    listener?.(s)
  },
  update(anchor: HTMLElement | null, patch: Partial<TipState>) {
    if (!current || current.anchor !== anchor) return
    current = { ...current, ...patch }
    listener?.(current)
  },
  hide(anchor?: HTMLElement | null) {
    if (!current || (anchor && current.anchor !== anchor)) return
    current = null
    lastHiddenAt = performance.now()
    listener?.(null)
  }
}

/** Hide whatever tooltip is showing. */
export const hideTooltip = (): void => api.hide()

export interface TooltipProps {
  content: ReactNode
  /** Shortcut rendered as keycaps after the text, e.g. 'Mod+L'. */
  shortcut?: string
  /** Preferred side; flips when there's no room. Default 'bottom'. */
  side?: Side
  /** Hover delay in ms. Default 450 (instant while another tooltip was just open). */
  delay?: number
  disabled?: boolean
  children: ReactElement
}

export function Tooltip({ content, shortcut, side = 'bottom', delay = 450, disabled, children }: TooltipProps) {
  const ref = useRef<HTMLElement | null>(null)
  /** Last mounted node: React clears `ref` before unmount cleanups run. */
  const node = useRef<HTMLElement | null>(null)
  const timer = useRef(0)
  const child = Children.only(children)
  const props = (isValidElement(child) ? child.props : {}) as Record<string, unknown> & { ref?: Ref<HTMLElement> }

  const show = () => {
    window.clearTimeout(timer.current)
    if (disabled || content == null || content === '') return
    const warm = performance.now() - lastHiddenAt < 350
    timer.current = window.setTimeout(
      () => {
        if (ref.current?.isConnected) api.show({ anchor: ref.current, content, shortcut, side })
      },
      warm ? 40 : delay
    )
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    api.hide(ref.current)
  }

  useEffect(() => {
    api.update(ref.current, { content, shortcut, side })
  }, [content, shortcut, side])
  useEffect(() => {
    if (disabled) hide()
  }, [disabled]) // eslint-disable-line react-hooks/exhaustive-deps
  // Unmounting hides only our own bubble: api.hide(null) (ref is already cleared by then) hid
  // whatever tooltip was showing elsewhere whenever any tooltipped row/toast unmounted.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      if (node.current) api.hide(node.current)
    },
    []
  )

  const call = (name: string, e: unknown) => (props[name] as ((e: unknown) => void) | undefined)?.(e)
  return cloneElement(child as ReactElement<Record<string, unknown>>, {
    ref: mergeRefs(ref, (el: HTMLElement | null) => void (el && (node.current = el)), props.ref),
    onPointerEnter: (e: unknown) => {
      call('onPointerEnter', e)
      show()
    },
    onPointerLeave: (e: unknown) => {
      call('onPointerLeave', e)
      hide()
    },
    onPointerDown: (e: unknown) => {
      call('onPointerDown', e)
      hide()
    },
    onFocus: (e: unknown) => {
      call('onFocus', e)
      if ((e as { target: Element }).target.matches?.(':focus-visible')) show()
    },
    onBlur: (e: unknown) => {
      call('onBlur', e)
      hide()
    }
  })
}

/** Renders the single tooltip bubble. Mounted once (inside <UIHosts/>). */
export function TooltipHost() {
  const [tip, setTip] = useState<TipState | null>(null)
  const [shown, setShown] = useState<TipState | null>(null)
  const [visible, setVisible] = useState(false)
  const el = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listener = setTip
    return () => {
      listener = null
    }
  }, [])

  useEffect(() => {
    if (tip) {
      setShown(tip)
      return
    }
    setVisible(false)
    const t = window.setTimeout(() => setShown(null), 180)
    return () => window.clearTimeout(t)
  }, [tip])

  useLayoutEffect(() => {
    const node = el.current
    // fading out: stay put (a detached anchor measures as a zero rect at the top-left)
    if (!node || !shown || !tip) return
    const r = shown.anchor.getBoundingClientRect()
    const p = place(r, node.offsetWidth, node.offsetHeight, { side: shown.side, offset: 8 })
    node.style.left = `${p.x}px`
    node.style.top = `${p.y}px`
    node.dataset.side = p.side
    if (tip) {
      const id = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(id)
    }
  }, [shown, tip])

  useEffect(() => {
    if (!tip) return
    const off = () => api.hide()
    window.addEventListener('wheel', off, { passive: true, capture: true })
    window.addEventListener('keydown', off, { capture: true })
    window.addEventListener('blur', off)
    // the anchor can unmount without a pointerleave
    const iv = window.setInterval(() => {
      if (!tip.anchor.isConnected) api.hide()
    }, 300)
    return () => {
      window.removeEventListener('wheel', off, { capture: true })
      window.removeEventListener('keydown', off, { capture: true })
      window.removeEventListener('blur', off)
      window.clearInterval(iv)
    }
  }, [tip])

  if (!shown) return null
  return createPortal(
    <div ref={el} role="tooltip" className={cx('g-tooltip', visible && 'g-tooltip--visible')}>
      {shown.content}
      {shown.shortcut && <Kbd combo={shown.shortcut} size="sm" className="g-tooltip__kbd" />}
    </div>,
    portalRoot()
  )
}
