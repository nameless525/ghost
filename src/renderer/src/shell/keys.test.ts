import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('dispatch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('../theme')
    vi.resetModules()
  })

  /** A fresh copy of the module, its window keydown listener caught. */
  async function dispatcher() {
    vi.resetModules()
    vi.doMock('../theme', () => ({ isMac: false }))
    class Input {
      type = 'search'
    }
    vi.stubGlobal('HTMLInputElement', Input)
    vi.stubGlobal('HTMLTextAreaElement', class {})
    vi.stubGlobal('HTMLSelectElement', class {})
    const body = { isContentEditable: false }
    vi.stubGlobal('document', { activeElement: body })
    let listener: ((e: KeyboardEvent) => void) | null = null
    vi.stubGlobal('window', { addEventListener: (_type: string, fn: (e: KeyboardEvent) => void) => (listener = fn) })
    const keys = await import('./keys')
    const key = (k: string, target: unknown, more: Partial<KeyboardEvent> = {}) =>
      listener!({ key: k, code: k, target, keyCode: 13, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, preventDefault() {}, stopPropagation() {}, ...more } as unknown as KeyboardEvent)
    return { keys, key, input: new Input(), body }
  }

  it('a key typed in a field is typing even after the field’s own handler blurred it', async () => {
    const { keys, key, input, body } = await dispatcher()
    const play = vi.fn()
    keys.registerKeybinding('Enter', play, {}, { scope: 'screen', isActive: () => true })
    // Enter in the search box: its submit blurred the box before the window heard the key
    key('Enter', input)
    expect(play).not.toHaveBeenCalled()
    key('Enter', body)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('a key that went to an IME is not a shortcut', async () => {
    const { keys, key, body } = await dispatcher()
    const play = vi.fn()
    keys.registerKeybinding('Enter', play, {}, { scope: 'screen', isActive: () => true })
    key('Enter', body, { isComposing: true })
    key('Enter', body, { keyCode: 229 })
    expect(play).not.toHaveBeenCalled()
  })

  it('a button focused from the keyboard keeps its Enter; one focused by a click is blurred and the key is the binding\'s', async () => {
    const { keys } = await dispatcher()
    const button = (visible: boolean) => ({ tagName: 'BUTTON', getAttribute: () => null, matches: (q: string) => q === ':focus-visible' && visible, blur: vi.fn() })
    const kb = button(true)
    vi.stubGlobal('document', { activeElement: kb })
    expect(keys.focusedControlTakesKey()).toBe(true)
    expect(kb.blur).not.toHaveBeenCalled()
    const clicked = button(false)
    vi.stubGlobal('document', { activeElement: clicked })
    expect(keys.focusedControlTakesKey()).toBe(false)
    expect(clicked.blur).toHaveBeenCalled()
    vi.stubGlobal('document', { activeElement: { tagName: 'DIV', getAttribute: () => null } })
    expect(keys.focusedControlTakesKey()).toBe(false)
  })
})
