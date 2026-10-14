import { describe, expect, it } from 'vitest'
import { formatCombo, parseCombo } from './keys'

describe('key combos', () => {
  it('parses letters/digits to physical codes', () => {
    expect(parseCombo('L')).toMatchObject({ code: 'KeyL', shift: false })
    expect(parseCombo('Shift+2')).toMatchObject({ code: 'Digit2', shift: true })
  })
  it('parses named keys and aliases', () => {
    expect(parseCombo('Esc').key).toBe('Escape')
    expect(parseCombo('Ctrl+Left')).toMatchObject({ key: 'ArrowLeft', ctrl: true })
    expect(parseCombo('F6').key).toBe('F6')
    expect(parseCombo('Space').code).toBe('Space')
  })
  it('symbols ignore shift unless asked', () => {
    expect(parseCombo('?').shift).toBeNull()
    expect(parseCombo('Shift+/').shift).toBe(true)
  })
  it('Mod maps to Ctrl off macOS (tests run as linux)', () => {
    expect(parseCombo('Mod+L')).toMatchObject({ ctrl: true, meta: false })
    expect(formatCombo('Mod+Shift+L')).toEqual(['Ctrl', 'Shift', 'L'])
    expect(formatCombo('Escape')).toEqual(['Esc'])
  })
})
