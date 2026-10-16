import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftField } from './controls'

const DEF = '{album}/{track} {title}'

/** The naming-template field: 700 ms pause, empty means the default, an emptied field waits. */
function template(saved: string) {
  const save = vi.fn<(v: string) => void>()
  const field = new DraftField(saved, { delay: 700, clean: (v) => v.trim() || DEF, save, holdEmpty: true })
  return { field, save }
}

describe('DraftField', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('Escape before the pause ends drops the pending save', () => {
    const { field, save } = template('saved/{title}')
    field.focus()
    field.change('cancelled/{title}')
    vi.advanceTimersByTime(300)
    expect(field.revert()).toBe(true)
    expect(field.text).toBe('saved/{title}')
    vi.advanceTimersByTime(5000)
    field.blur()
    expect(save).not.toHaveBeenCalled()
  })

  it('still saves after the pause, on blur and on Enter', () => {
    const { field, save } = template('saved/{title}')
    field.focus()
    field.change('cancelled/{title}')
    field.revert()
    field.change('fresh/{title}')
    vi.advanceTimersByTime(699)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(save).toHaveBeenLastCalledWith('fresh/{title}')
    field.setSaved('fresh/{title}')

    field.change('enter/{title}')
    field.commit()
    expect(save).toHaveBeenLastCalledWith('enter/{title}')
    field.setSaved('enter/{title}')
    vi.advanceTimersByTime(5000)
    expect(save).toHaveBeenCalledTimes(2)

    field.change('blur/{title}  ')
    field.blur()
    expect(save).toHaveBeenLastCalledWith('blur/{title}')
    expect(field.text).toBe('blur/{title}')
  })

  it('Escape with nothing to revert leaves the key to the overlay', () => {
    const { field, save } = template('saved/{title}')
    field.focus()
    field.change('saved/{title}x')
    field.change('saved/{title}')
    expect(field.revert()).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(save).not.toHaveBeenCalled()
  })

  it('an emptied field waits for blur, then saves the default', () => {
    const { field, save } = template('saved/{title}')
    field.focus()
    field.change('')
    vi.advanceTimersByTime(5000)
    expect(save).not.toHaveBeenCalled()
    expect(field.text).toBe('')
    field.blur()
    expect(save).toHaveBeenLastCalledWith(DEF)
    expect(field.text).toBe(DEF)
  })

  it('a value saved elsewhere replaces the text, but not while typing', () => {
    const onText = vi.fn()
    const field = new DraftField('a', { delay: 900, clean: (v) => v.trim(), save: () => {} }, onText)
    field.setSaved('b')
    expect(field.text).toBe('b')
    field.focus()
    field.change('typing')
    field.setSaved('c')
    expect(field.text).toBe('typing')
    expect(onText.mock.calls.map((c) => c[0])).toEqual(['b', 'typing'])
    // and Escape goes back to the newest saved value
    field.revert()
    expect(field.text).toBe('c')
  })
})
