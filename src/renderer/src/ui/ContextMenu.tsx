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
// Or imperatively: openContextMenu({ x: e.clientX, y: e.clientY }, items)
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
      /** Shows a check mark (toggle items). */
      checked?: boolean
      submenu?: MenuItem[]
      separator?: never
      heading?: never
    }
  | { separator: true }
  | { heading: ReactNode }

type ActionItem = Extract<MenuItem, { label: ReactNode }>
const isAction = (i: MenuItem): i is ActionItem => 'label' in i

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

let setGlobal: ((s: MenuState | null) => void) | null = null

/** Open a context menu at viewport coordinates. */
export function openContextMenu(at: { x: number; y: number }, items: MenuItem[]): void {
  if (!items.length) return
  sfx.play('select', { volume: 0.5 })
  setGlobal?.({ x: at.x, y: at.y, items })
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
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        openContextMenu({ x: r.left + 12, y: r.bottom - 4 }, typeof items === 'function' ? items() : items)
      }
    }
  })
}

interface ListProps {
  items: MenuItem[]
  anchor: { x: number; y: number } | DOMRect
  depth: number
  onClose: (all: boolean) => void
  autoFocus: boolean
}

function MenuList({ items, anchor, depth, onClose, autoFocus }: ListProps) {
  const el = useRef<HTMLDivElement>(null)
  // a submenu opened from the keyboard starts on its first actionable item
  const [active, setActive] = useState(() => (autoFocus && depth > 0 ? items.findIndex((i) => isAction(i) && !i.disabled) : -1))
  // focus stays on the menu: name the active item so screen readers follow the arrows
  const itemId = useId()
  const [sub, setSub] = useState<{ index: number; rect: DOMRect; focus: boolean } | null>(null)
  const hoverTimer = useRef(0)

  useLayoutEffect(() => {
    const node = el.current
    if (!node) return
    const p =
      'width' in anchor
        ? place(anchor, node.offsetWidth, node.offsetHeight, { side: 'right', align: 'start', offset: 2 })
        : placeAtPoint(anchor.x, anchor.y, node.offsetWidth, node.offsetHeight)
    node.style.left = `${p.x}px`
    node.style.top = `${p.y - ('width' in anchor ? 5 : 0)}px`
    node.style.transformOrigin = p.origin
    if (autoFocus) node.focus({ preventScroll: true })
  }, [anchor, autoFocus])

  const actionable = (i: number) => isAction(items[i]) && !(items[i] as ActionItem).disabled
  const move = (dir: 1 | -1) => {
    let i = active
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length
      if (actionable(i)) break
    }
    setActive(i)
  }

  const openSub = (i: number, focus: boolean) => {
    const item = items[i]
    if (!isAction(item) || !item.submenu?.length) return
    const btn = el.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)
    if (btn) setSub({ index: i, rect: btn.getBoundingClientRect(), focus })
  }

  const activate = (i: number) => {
    const item = items[i]
    if (!isAction(item) || item.disabled) return
    if (item.submenu?.length) return openSub(i, true)
    sfx.play('confirm', { volume: 0.45 })
    onClose(true)
    item.onSelect?.()
  }

  const onKeyDown = (e: RKeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'ArrowDown') move(1)
    else if (e.key === 'ArrowUp') move(-1)
    else if (e.key === 'Home') setActive(items.findIndex((_, i) => actionable(i)))
    else if (e.key === 'End') {
      for (let i = items.length - 1; i >= 0; i--) if (actionable(i)) return setActive(i)
    } else if (e.key === 'ArrowRight') openSub(active, true)
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
              role="menuitem"
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
    return () => {
      setGlobal = null
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
      key={`${menu.x},${menu.y}`}
      items={menu.items}
      anchor={{ x: menu.x, y: menu.y }}
      depth={0}
      autoFocus
      onClose={() => {
        setMenu(null)
        restore.current?.focus?.({ preventScroll: true })
      }}
    />,
    portalRoot()
  )
}
