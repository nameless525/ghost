// Modal dialogs. Pop in with a soft elastic, trap focus, block other keybindings.
//
//   const ok = await confirmDialog({ title: 'Delete playlist?', body: 'This can't be undone.', confirmLabel: 'Delete', danger: true })
//   const name = await promptDialog({ title: 'New playlist', label: 'Name', placeholder: 'Boss rush',
//                                     validate: (v) => (v.trim() ? null : 'Give it a name') })
//
//   <Dialog open={open} onClose={() => setOpen(false)} title="Export" footer={<Button …/>}>…</Dialog>
import { CircleAlert, CircleHelp, PenLine } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { tween } from '../motion/tween'
import { pushModalScope } from '../shell/keys'
import { sfx } from '../sound'
import { Button } from './Button'
import { cx, hueStyle, useEvent, useFocusTrap, type Hue, portalRoot } from './util'

export interface DialogProps {
  open: boolean
  /** Esc, backdrop click, or the close action. */
  onClose: () => void
  title?: ReactNode
  /** Icon in a tinted tile beside the title. */
  icon?: ReactNode
  children?: ReactNode
  /** Right-aligned actions row. */
  footer?: ReactNode
  hue?: Hue
  /** Max width in px. Default 440. */
  width?: number
  /** Allow Esc / backdrop to close. Default true. */
  dismissible?: boolean
  /** Render children without the padded body wrapper (bring your own .g-dialog__body/.g-dialog__foot). */
  bare?: boolean
  className?: string
}

/** Controlled modal dialog. Stays mounted through its exit animation. */
export function Dialog(props: DialogProps) {
  const [mounted, setMounted] = useState(props.open)
  useEffect(() => {
    if (props.open) setMounted(true)
  }, [props.open])
  if (!mounted) return null
  return createPortal(<DialogFrame {...props} onExited={() => setMounted(false)} />, portalRoot())
}

function DialogFrame({ open, onClose, title, icon, children, footer, hue, width = 440, dismissible = true, bare, className, onExited }: DialogProps & { onExited: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [closing, setClosing] = useState(false)
  const close = useEvent(() => {
    if (dismissible) onClose()
  })

  useFocusTrap(panel, open)

  useEffect(() => {
    if (!open) return
    const release = pushModalScope()
    return release
  }, [open])

  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    if (open) {
      setClosing(false)
      sfx.play('open', { volume: 0.45 })
      tween(el).clear().set({ opacity: 0, scale: 0.9, y: 14 }).fadeIn(180, 'outQuad').scaleTo(1, 700, 'outElasticHalf').moveToY(0, 450, 'outQuint')
    } else {
      setClosing(true)
      void tween(el)
        .clear()
        .fadeOut(170, 'outQuad')
        .scaleTo(0.95, 220, 'outQuint')
        .moveToY(8, 220, 'outQuint')
        .then(() => onExited())
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cx('g-dialog-layer', closing && 'g-dialog-layer--closing')} style={hueStyle(hue)}>
      <div className="g-dialog-backdrop" onPointerDown={close} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cx('g-dialog', className)}
        style={{ width: `min(${width}px, 100%)` }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            if (dismissible) sfx.play('back', { volume: 0.6 })
            close()
          }
        }}
      >
        <div className="g-dialog__glow" />
        {(title || icon) && (
          <div className="g-dialog__head">
            {icon && <div className="g-dialog__icon">{icon}</div>}
            {title && (
              <div id={titleId} className="g-dialog__title">
                {title}
              </div>
            )}
          </div>
        )}
        {children && (bare ? children : <div className={cx('g-dialog__body', icon && 'g-dialog__body--indented')}>{children}</div>)}
        {footer && <div className="g-dialog__foot">{footer}</div>}
      </div>
    </div>
  )
}

// ---- imperative dialogs -------------------------------------------------------

interface Entry {
  id: number
  open: boolean
  render: (close: () => void, open: boolean) => ReactNode
}

let setEntries: ((fn: (e: Entry[]) => Entry[]) => void) | null = null
let nextId = 1

function openImperative(render: Entry['render']): () => void {
  const id = nextId++
  const close = () => setEntries?.((list) => list.map((e) => (e.id === id ? { ...e, open: false } : e)))
  if (!setEntries) {
    console.warn('[dialog] DialogHost is not mounted')
    return close
  }
  setEntries((list) => [...list, { id, open: true, render }])
  return close
}

export interface ConfirmOptions {
  title: ReactNode
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button + alert icon. */
  danger?: boolean
  icon?: ReactNode
  hue?: Hue
}

/** Ask a yes/no question. Resolves true on confirm, false on cancel/Esc. */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      resolve(v)
      close()
    }
    const close = openImperative((_c, open) => (
      <Dialog
        open={open}
        onClose={() => done(false)}
        title={o.title}
        icon={o.icon ?? (o.danger ? <CircleAlert /> : <CircleHelp />)}
        hue={o.hue ?? (o.danger ? '#ff5f7a' : undefined)}
        footer={
          <>
            <Button variant="ghost" sound="back" onClick={() => done(false)}>
              {o.cancelLabel ?? 'Cancel'}
            </Button>
            <Button variant={o.danger ? 'danger' : 'primary'} sound="confirm" data-autofocus onClick={() => done(true)}>
              {o.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {o.body}
      </Dialog>
    ))
  })
}

export interface PromptOptions {
  title: ReactNode
  body?: ReactNode
  label?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Return an error message to block submission, or null when valid. */
  validate?: (value: string) => string | null
  icon?: ReactNode
  hue?: Hue
}

function PromptBody({ o, onDone }: { o: PromptOptions; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState(o.defaultValue ?? '')
  const [touched, setTouched] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const error = o.validate?.(value) ?? null
  useEffect(() => {
    const t = window.setTimeout(() => {
      input.current?.focus()
      input.current?.select()
    }, 40)
    return () => window.clearTimeout(t)
  }, [])
  const submit = () => {
    setTouched(true)
    if (error) {
      sfx.play('error', { volume: 0.6 })
      if (input.current) void tween(input.current).moveToX(6, 50).then().moveToX(-5, 70).then().moveToX(0, 300, 'outElastic')
      return
    }
    onDone(value)
  }
  return (
    <>
      {/* indented under the title like every other dialog body (the prompt always has an icon) */}
      <div className="g-dialog__body g-dialog__body--indented" style={{ paddingTop: 2 }}>
        {o.body && <div style={{ marginBottom: 10 }}>{o.body}</div>}
        <label className="g-field">
          {o.label && <span className="g-field__label">{o.label}</span>}
          <input
            ref={input}
            className={cx('g-input', touched && error && 'g-input--invalid')}
            value={value}
            placeholder={o.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
          />
          {touched && error && <span className="g-field__error">{error}</span>}
        </label>
      </div>
      <div className="g-dialog__foot">
        <Button variant="ghost" sound="back" onClick={() => onDone(null)}>
          {o.cancelLabel ?? 'Cancel'}
        </Button>
        <Button variant="primary" sound="confirm" onClick={submit}>
          {o.confirmLabel ?? 'Save'}
        </Button>
      </div>
    </>
  )
}

/** Ask for a line of text (playlist names…). Resolves the string, or null when cancelled. */
export function promptDialog(o: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: string | null) => {
      if (settled) return
      settled = true
      resolve(v)
      close()
    }
    const close = openImperative((_c, open) => (
      <Dialog open={open} onClose={() => done(null)} title={o.title} icon={o.icon ?? <PenLine />} hue={o.hue} bare>
        <PromptBody o={o} onDone={done} />
      </Dialog>
    ))
  })
}

/** Hosts imperative dialogs. Mounted once (inside <UIHosts/>). */
export function DialogHost() {
  const [entries, set] = useState<Entry[]>([])
  useEffect(() => {
    setEntries = set
    return () => {
      setEntries = null
    }
  }, [])
  // prune closed entries after their exit animation
  useEffect(() => {
    if (!entries.some((e) => !e.open)) return
    const t = window.setTimeout(() => set((l) => l.filter((e) => e.open)), 400)
    return () => window.clearTimeout(t)
  }, [entries])
  return (
    <>
      {entries.map((e) => (
        <DialogSlot key={e.id} entry={e} />
      ))}
    </>
  )
}

function DialogSlot({ entry }: { entry: Entry }) {
  return <>{entry.render(() => {}, entry.open)}</>
}
