// Click-to-edit text (playlist name / description). Enter or blur saves, Esc cancels.
import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react'
import { tween } from '../../motion/tween'
import { sfx } from '../../sound'
import { cx } from '../../ui/util'

export interface InlineEditProps {
  value: string
  onCommit: (value: string) => void | Promise<unknown>
  placeholder?: string
  /** Empty values are rejected (shake) unless allowEmpty. */
  allowEmpty?: boolean
  multiline?: boolean
  maxLength?: number
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

export function InlineEdit({ value, onCommit, placeholder, allowEmpty, multiline, maxLength = 200, disabled, className, 'aria-label': ariaLabel }: InlineEditProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const done = useRef(false)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  useEffect(() => {
    if (!editing) return
    done.current = false
    const el = input.current
    if (!el) return
    el.focus()
    el.select()
    autosize(el)
  }, [editing])

  const autosize = (el: HTMLTextAreaElement | HTMLInputElement) => {
    if (el instanceof HTMLTextAreaElement) {
      el.style.height = '0px'
      el.style.height = `${el.scrollHeight}px`
    }
  }

  const commit = () => {
    if (done.current) return
    const v = draft.trim()
    if (!v && !allowEmpty) {
      sfx.play('error', { volume: 0.6 })
      if (input.current) void tween(input.current).moveToX(6, 50).then().moveToX(-5, 70).then().moveToX(0, 300, 'outElastic')
      return
    }
    done.current = true
    setEditing(false)
    if (v !== value.trim()) {
      sfx.play('confirm', { volume: 0.6 })
      void onCommit(v)
    }
  }
  const cancel = () => {
    done.current = true
    setDraft(value)
    setEditing(false)
    sfx.play('back', { volume: 0.5 })
  }
  const onKeyDown = (e: RKeyboardEvent) => {
    if (e.key === 'Enter' && (!multiline || !e.shiftKey)) {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
    e.stopPropagation()
  }

  if (editing) {
    const common = {
      ref: input,
      className: cx('lx-inline__input', multiline && 'lx-inline__input--multi', className),
      value: draft,
      maxLength,
      placeholder,
      'aria-label': ariaLabel,
      spellCheck: false,
      onKeyDown,
      onBlur: commit
    }
    return multiline ? (
      <textarea
        {...common}
        rows={1}
        onChange={(e) => {
          setDraft(e.target.value)
          autosize(e.target)
        }}
      />
    ) : (
      <input {...common} onChange={(e) => setDraft(e.target.value)} />
    )
  }

  return (
    <button
      type="button"
      className={cx('lx-inline', !value && 'lx-inline--empty', className)}
      disabled={disabled}
      aria-label={ariaLabel ? `${ariaLabel}: ${value || placeholder}` : undefined}
      title={disabled ? undefined : 'Click to edit'}
      onPointerEnter={() => !disabled && sfx.play('hover', { volume: 0.6 })}
      onClick={() => {
        if (disabled) return
        sfx.play('select', { volume: 0.5 })
        setEditing(true)
      }}
    >
      <span className="lx-inline__text">{value || placeholder}</span>
      {!disabled && <Pencil className="lx-inline__pen" />}
    </button>
  )
}
