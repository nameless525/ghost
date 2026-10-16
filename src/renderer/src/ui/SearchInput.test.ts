import { describe, expect, it } from 'vitest'
import { searchKeyAction } from './SearchInput'

const key = (k: string, more: Partial<KeyboardEvent> = {}) => ({ key: k, keyCode: k === 'Enter' ? 13 : 27, repeat: false, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, ...more })

describe('search field keys', () => {
  it('Enter submits and Escape escapes', () => {
    expect(searchKeyAction(key('Enter'))).toBe('submit')
    expect(searchKeyAction(key('Escape'))).toBe('escape')
    expect(searchKeyAction(key('a'))).toBeNull()
  })

  it('Enter or Escape confirming or cancelling an IME candidate does neither', () => {
    expect(searchKeyAction(key('Enter', { isComposing: true }))).toBeNull()
    expect(searchKeyAction(key('Escape', { isComposing: true }))).toBeNull()
    // WebKit: the confirming Enter comes after compositionend, as keyCode 229
    expect(searchKeyAction(key('Enter', { keyCode: 229 }))).toBeNull()
  })

  it('a modified or held Enter does not submit', () => {
    expect(searchKeyAction(key('Enter', { metaKey: true }))).toBeNull()
    expect(searchKeyAction(key('Enter', { ctrlKey: true }))).toBeNull()
    expect(searchKeyAction(key('Enter', { repeat: true }))).toBeNull()
  })
})
