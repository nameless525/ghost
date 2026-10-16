// Right-click menus with keyboard navigation and nested submenus.
//
//   <ContextMenu items={() => [
//     { label: 'Play next', icon: <ListPlus />, shortcut: 'Shift+Q', onSelect: playNext },
//     { label: 'Add to playlist', icon: <ListMusic />, submenu: playlists.map(…) },
//     { separator: true },
//     { label: 'Remove', icon: <Trash2 />, danger: true, onSelect: remove },
//   ]}>
//     <TrackRow … />
//   </ContextMenu>
//
// Or imperatively: openContextMenu({ x: e.clientX, y: e.clientY }, items) at the pointer, or
// openContextMenu(buttonEl, items) for a menu that belongs to a control: it opens below the control,
// or above it when there's no room below (footer / HUD buttons), and never covers it.
import { ChevronRight } from 'lucide-react'
import {
  Children,
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as RKeyboardEvent,
  type MouseEvent as RMouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { sfx } from '../sound'
import { place, placeAtPoint } from './floating'
import { Kbd } from './Kbd'
import { cx, portalRoot } from './util'

export type MenuItem =
  | {
      label: ReactNode
      icon?: ReactNode
      /** Shown as keycaps on the right. */
      shortcut?: string
      onSelect?: () => void
      disabled?: boolean
      danger?: boolean
      /** Toggle item: true shows a check mark (false: a toggle that is off). */
      checked?: boolean
      submenu?: MenuItem[]
      separator?: never
      heading?: never
    }
  | { separator: true }
  | { heading: ReactNode }

type ActionItem = Extract<MenuItem, { label: ReactNode }>
const isAction = (i: MenuItem): i is ActionItem => 'label' in i

/** The enabled action at `i`, or null (a heading, a separator, a disabled item, or no item). */
export function actionAt(items: MenuItem[], i: number): ActionItem | null {
  const item = items[i]
  return item && isAction(item) && !item.disabled ? item : null
}

/**
 * The next enabled action from `from` in `dir`, wrapping. From nothing (-1), Down starts on the
 * first and Up on the last. Stays put when the menu has nothing to act on.
 */
export function stepAction(items: MenuItem[], from: number, dir: 1 | -1): number {
  const n = items.length
  let i = from < 0 ? (dir > 0 ? -1 : n) : from
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n
    if (actionAt(items, i)) return i
  }
  return from
}

type Point = { x: number; y: number }

interface MenuState {
  /** A pointer position, or the rect of the control the menu belongs to. */
  at: Point | DOMRect
  items: MenuItem[]
  /** Opened from the keyboard (Menu key, Shift+F10, a shortcut, Enter on a button): starts on an item. */
  keyboard: boolean
  seq: number
}

let setGlobal: ((s: MenuState | null) => void) | null = null
let menuSeq = 0
/** The last input was a key press (tracked by the host), so a menu opening now is the keyboard's. */
let keyInput = false

/** Open a context menu at viewport coordinates, or anchored to an element (see the header). */
export function openContextMenu(at: Point | Element, items: MenuItem[]): void {
  if (!items.length) return
  sfx.play('select', { volume: 0.5 })
  setGlobal?.({ at: at instanceof Element ? at.getBoundingClientRect() : { x: at.x, y: at.y }, items, keyboard: keyInput, seq: ++menuSeq })
}

export function closeContextMenu(): void {
  setGlobal?.(null)
}

export interface ContextMenuProps {
  /** Items, or a function evaluated when the menu opens. */
  items: MenuItem[] | (() => MenuItem[])
  disabled?: boolean
  children: ReactElement
}

/** Wrap an element to give it a right-click menu (also opens with the Menu key / Shift+F10). */
export function ContextMenu({ items, disabled, children }: ContextMenuProps) {
  const child = Children.only(children) as ReactElement<{ onContextMenu?: (e: RMouseEvent) => void; onKeyDown?: (e: RKeyboardEvent) => void }>
  return cloneElement(child, {
    onContextMenu: (e: RMouseEvent) => {
      child.props.onContextMenu?.(e)
      if (disabled || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      openContextMenu({ x: e.clientX, y: e.clientY }, typeof items === 'function' ? items() : items)
    },
    onKeyDown: (e: RKeyboardEvent) => {
      child.props.onKeyDown?.(e)
      if (disabled || e.defaultPrevented) return
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault()
        openContextMenu(e.currentTarget as HTMLElement, typeof items === 'function' ? items() : items)
      }
    }
  })
}

interface ListProps {
  items: MenuItem[]
  /** A point, the owning control's rect (root menu), or the parent item's rect (submenu). */
  anchor: Point | DOMRect
  depth: number
  onClose: (all: boolean) => void
  autoFocus: boolean
  /** Start on the first enabled action (opened from the keyboard) rather than on nothing. */
  startOnItem: boolean
}

function MenuList({ items, anchor, depth, onClose, autoFocus, startOnItem }: ListProps) {
  const el = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(() => (startOnItem ? stepAction(items, -1, 1) : -1))
  // focus stays on the menu: name the active item so screen readers follow the arrows
  const itemId = useId()
  const [sub, setSub] = useState<{ index: number; rect: DOMRect; focus: boolean } | null>(null)
  const hoverTimer = useRef(0)

  useLayoutEffect(() => {
    const node = el.current
    if (!node) return
    const rect = 'width' in anchor
    const p = !rect
      ? placeAtPoint(anchor.x, anchor.y, node.offsetWidth, node.offsetHeight)
      : depth > 0
        ? place(anchor, node.offsetWidth, node.offsetHeight, { side: 'right', align: 'start', offset: 2 })
        : place(anchor, node.offsetWidth, node.offsetHeight, { side: 'bottom', align: 'start', offset: 6 })
    node.style.left = `${p.x}px`
    node.style.top = `${p.y - (rect && depth > 0 ? 5 : 0)}px`
    node.style.transformOrigin = rect && depth === 0 ? (p.side === 'top' ? 'bottom left' : 'top left') : p.origin
    if (autoFocus) node.focus({ preventScroll: true })
  }, [anchor, autoFocus])

  const openSub = (i: number, focus: boolean) => {
    if (!actionAt(items, i)?.submenu?.length) return
    const btn = el.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)
    if (btn) setSub({ index: i, rect: btn.getBoundingClientRect(), focus })
  }

  // -1 (nothing active yet: a menu opened with the pointer) does nothing
  const activate = (i: number) => {
    const item = actionAt(items, i)
    if (!item) return
    if (item.submenu?.length) return openSub(i, true)
    sfx.play('confirm', { volume: 0.45 })
    onClose(true)
    item.onSelect?.()
  }

  const onKeyDown = (e: RKeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'ArrowDown') setActive(stepAction(items, active, 1))
    else if (e.key === 'ArrowUp') setActive(stepAction(items, active, -1))
    else if (e.key === 'Home') setActive(stepAction(items, -1, 1))
    else if (e.key === 'End') setActive(stepAction(items, -1, -1))
    else if (e.key === 'ArrowRight') openSub(active, true)
    else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
      if (depth > 0 || e.key === 'Escape') onClose(e.key === 'Escape' && depth === 0)
    } else if (e.key === 'Enter' || e.key === ' ') activate(active)
    else if (e.key === 'Tab') onClose(true)
    else return
    e.preventDefault()
  }

  return (
    <>
      <div
        ref={el}
        role="menu"
        tabIndex={-1}
        aria-activedescendant={active >= 0 ? `${itemId}-${active}` : undefined}
        className="g-popover"
        style={{ zIndex: `calc(var(--z-menu) + ${depth})` }}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, i) => {
          if ('separator' in item && item.separator) return <div key={i} className="g-menu-sep" role="separator" />
          if ('heading' in item) return <div key={i} className="g-menu-heading">{item.heading}</div>
          const it = item as ActionItem
          return (
            <button
              key={i}
              id={`${itemId}-${i}`}
              type="button"
              role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={it.checked}
              data-index={i}
              tabIndex={-1}
              aria-disabled={it.disabled || undefined}
              aria-haspopup={it.submenu ? 'menu' : undefined}
              className={cx('g-option', i === active && 'g-option--active', it.danger && 'g-option--danger', it.disabled && 'g-option--disabled')}
              onPointerMove={() => {
                if (active === i) return
                setActive(i)
                sfx.play('hover', { volume: 0.5 })
                window.clearTimeout(hoverTimer.current)
                if (it.submenu) hoverTimer.current = window.setTimeout(() => openSub(i, false), 110)
                else if (sub) hoverTimer.current = window.setTimeout(() => setSub(null), 160)
              }}
              onClick={() => activate(i)}
            >
              {it.icon ?? <span style={{ width: 16 }} />}
              <span className="g-option__label">{it.label}</span>
              {it.checked && <span className="g-option__hint">✓</span>}
              {it.shortcut && <Kbd combo={it.shortcut} size="sm" />}
              {it.submenu && <ChevronRight className="g-option__sub" />}
            </button>
          )
        })}
      </div>
      {sub && isAction(items[sub.index]) && (
        <MenuList
          key={sub.index}
          items={(items[sub.index] as ActionItem).submenu!}
          anchor={sub.rect}
          depth={depth + 1}
          autoFocus={sub.focus}
          startOnItem={sub.focus}
          onClose={(all) => {
            setSub(null)
            if (all) onClose(true)
            else el.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </>
  )
}

/** Renders the active context menu. Mounted once (inside <UIHosts/>). */
export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const restore = useRef<HTMLElement | null>(null)

  useEffect(() => {
    setGlobal = (s) => {
      if (s) restore.current = document.activeElement as HTMLElement | null
      setMenu(s)
    }
    // capture phase: recorded before the handler that opens a menu runs
    const onKey = () => (keyInput = true)
    const onPointer = () => (keyInput = false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      setGlobal = null
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element).closest?.('[role="menu"]')) return
      setMenu(null)
    }
    const close = () => setMenu(null)
    const onWheel = (e: WheelEvent) => {
      if (!(e.target as Element).closest?.('[role="menu"]')) setMenu(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', onWheel)
    }
  }, [menu])

  if (!menu) return null
  return createPortal(
    <MenuList
      key={menu.seq}
      items={menu.items}
      anchor={menu.at}
      depth={0}
      autoFocus
      startOnItem={menu.keyboard}
      onClose={() => {
        setMenu(null)
        restore.current?.focus?.({ preventScroll: true })
      }}
    />,
    portalRoot()
  )
}
