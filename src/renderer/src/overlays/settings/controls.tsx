// Building blocks for the Settings overlay: live patching, setting rows, sliders with a value
// readout, secret fields, and search highlighting.
import { Check, Eye, EyeOff } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent as RKeyboardEvent, type ReactNode } from 'react'
import type { DeepPartial, Settings } from '@shared/types'
import { mergeSettings } from '@shared/defaults'
import { sfx } from '../../sound'
import { updateSettings, useSettings } from '../../state/settings'
import { Slider } from '../../ui/Slider'
import { cx, useIsoLayoutEffect } from '../../ui/util'

/** Apply a settings patch now (optimistically, so controls feel instant) and persist it. */
export function patchSettings(patch: DeepPartial<Settings>): Promise<Settings> {
  useSettings.setState((s) => mergeSettings(s, patch), true)
  return updateSettings(patch)
}

/** The active search query (lower-case), for highlighting labels. */
export const SearchContext = createContext('')

/** Wrap occurrences of the search words in <mark>. */
export function Highlight({ text }: { text: string }) {
  const q = useContext(SearchContext)
  if (!q) return <>{text}</>
  const words = q.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length) return <>{text}</>
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'))
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} className="set-mark">
            {p}
          </mark>
        ) : (
          p
        )
      )}
    </>
  )
}

export interface RowProps {
  label: string
  description?: ReactNode
  /** Right-aligned control (or below the text when `wide`). */
  children?: ReactNode
  wide?: boolean
  /** osu!-style: label and description on top, the control full-width underneath. */
  stack?: boolean
  disabled?: boolean
  /** Small value readout next to the label (e.g. "−16 LUFS"). */
  value?: ReactNode
  className?: string
}

/** One settings row: label + description on the left, control on the right. */
export function Row({ label, description, children, wide, stack, disabled, value, className }: RowProps) {
  return (
    <div className={cx('set-row', (wide || stack) && 'set-row--wide', stack && 'set-row--stack', disabled && 'set-row--disabled', className)}>
      <div className="set-row__text">
        <div className="set-row__label">
          <span>
            <Highlight text={label} />
          </span>
          {value !== undefined && <span className="set-row__value tnum">{value}</span>}
        </div>
        {description && <div className="set-row__desc">{typeof description === 'string' ? <Highlight text={description} /> : description}</div>}
      </div>
      {children !== undefined && <div className="set-row__control">{children}</div>}
    </div>
  )
}

export interface SettingSliderProps {
  value: number
  min: number
  max: number
  step: number
  /** Persist (called on release / wheel / keys). */
  onCommit: (v: number) => void
  /** Optional live preview while dragging (no persistence). */
  onPreview?: (v: number) => void
  format: (v: number) => string
  disabled?: boolean
  /** Render prop for the readout so the row can show the live value. */
  children?: (display: string) => ReactNode
  'aria-label'?: string
}

/** A settings slider: shows the live value while dragging, persists once on release. */
export function SettingSlider({ value, min, max, step, onCommit, onPreview, format, disabled, children, 'aria-label': ariaLabel }: SettingSliderProps) {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? value
  useEffect(() => {
    setDraft(null)
  }, [value])
  return (
    <div className={cx('set-slider', disabled && 'set-slider--disabled')}>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        wheelStep={step / (max - min)}
        disabled={disabled}
        format={format}
        aria-label={ariaLabel}
        onChange={(v) => {
          setDraft(v)
          onPreview?.(v)
        }}
        onCommit={(v) => {
          setDraft(null)
          if (v !== value) onCommit(v)
        }}
      />
      <span className="set-slider__value tnum">{children ? children(format(shown)) : format(shown)}</span>
    </div>
  )
}

export interface DraftFieldOptions {
  /** Pause after the last keystroke before the draft saves itself (ms). */
  delay: number
  /** The value a draft saves as (trimmed, the default for an empty field…). */
  clean: (text: string) => string
  /** Persist a cleaned value that differs from the saved one. */
  save: (value: string) => void
  /** An emptied field waits for blur / Enter instead of saving after the pause. */
  holdEmpty?: boolean
}

/**
 * A text setting edited in place: the draft saves after a pause, on blur and on Enter. Escape puts
 * the saved value back and drops the pending save with it, so a thrown-away edit never lands
 * later. Plain state rather than a hook so the rules are testable; useDraftField binds it.
 */
export class DraftField {
  text: string
  options: DraftFieldOptions
  private saved: string
  private focused = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(saved: string, options: DraftFieldOptions, private onText: (text: string) => void = () => {}) {
    this.text = this.saved = saved
    this.options = options
  }

  /** The setting changed (saved here, or elsewhere): shown unless the user is typing. */
  setSaved(value: string): void {
    this.saved = value
    if (!this.focused) this.show(value)
  }

  focus(): void {
    this.focused = true
  }

  blur(): void {
    this.focused = false
    this.commit()
  }

  change(text: string): void {
    this.show(text)
    this.cancel()
    if (this.options.holdEmpty && !text.trim()) return
    this.timer = setTimeout(() => this.commit(text), this.options.delay)
  }

  /** Save now: blur, Enter, or a value set by a button (reset). */
  commit(text = this.text): void {
    this.cancel()
    const clean = this.options.clean(text)
    this.show(clean)
    if (clean !== this.saved) this.options.save(clean)
  }

  /** Escape. True when there was an edit to throw away (the key is then the field's). */
  revert(): boolean {
    this.cancel()
    if (this.text === this.saved) return false
    this.show(this.saved)
    return true
  }

  dispose(): void {
    this.cancel()
  }

  private cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private show(text: string): void {
    if (text === this.text) return
    this.text = text
    this.onText(text)
  }
}

/** A DraftField for `value`, re-rendering with its text. Bind the input with draftInputProps. */
export function useDraftField(value: string, options: DraftFieldOptions): [DraftField, string] {
  const [text, setText] = useState(value)
  const [field] = useState(() => new DraftField(value, options, setText))
  // the latest closures, for a save that fires after the pause
  useIsoLayoutEffect(() => {
    field.options = options
  })
  useEffect(() => field.setSaved(value), [field, value])
  useEffect(() => () => field.dispose(), [field])
  return [field, text]
}

/** The <input> handlers of a DraftField. */
export function draftInputProps(field: DraftField) {
  return {
    onFocus: () => field.focus(),
    onBlur: () => field.blur(),
    onChange: (e: ChangeEvent<HTMLInputElement>) => field.change(e.target.value),
    onKeyDown: (e: RKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        field.commit()
      } else if (e.key === 'Escape' && field.revert()) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
  }
}

export interface SecretFieldProps {
  value: string
  onSave: (v: string) => void | Promise<unknown>
  placeholder?: string
  /** Mask the value (password style) until revealed. Default true. */
  secret?: boolean
  'aria-label'?: string
}

/** Text field for API keys: masked with a reveal toggle, saved on blur / Enter / after a pause. */
export function SecretField({ value, onSave, placeholder, secret = true, 'aria-label': ariaLabel }: SecretFieldProps) {
  const [shown, setShown] = useState(!secret)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef(0)

  useEffect(() => () => window.clearTimeout(savedTimer.current), [])

  const [field, draft] = useDraftField(value, {
    delay: 900,
    clean: (v) => v.trim(),
    save: (clean) =>
      void Promise.resolve(onSave(clean)).then(
        () => {
          setSaved(true)
          sfx.play('confirm', { volume: 0.5 })
          window.clearTimeout(savedTimer.current)
          savedTimer.current = window.setTimeout(() => setSaved(false), 1800)
        },
        (err: unknown) => {
          sfx.play('error', { volume: 0.5 })
          console.warn('[settings] save failed', err)
        }
      )
  })

  return (
    <div className={cx('set-secret', saved && 'set-secret--saved')}>
      <input
        className="g-input set-secret__input"
        type={shown ? 'text' : 'password'}
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        autoComplete="off"
        {...draftInputProps(field)}
      />
      <span className="set-secret__saved" aria-live="polite">
        <Check /> Saved
      </span>
      {secret && (
        <button
          type="button"
          className="set-secret__eye"
          aria-label={shown ? 'Hide' : 'Show'}
          title={shown ? 'Hide' : 'Show'}
          onClick={() => {
            sfx.play(shown ? 'toggleOff' : 'toggleOn', { volume: 0.6 })
            setShown((s) => !s)
          }}
        >
          {shown ? <EyeOff /> : <Eye />}
        </button>
      )}
    </div>
  )
}

/** Group heading inside a section. */
export function GroupTitle({ children }: { children: ReactNode }) {
  return <div className="set-group__title">{children}</div>
}
