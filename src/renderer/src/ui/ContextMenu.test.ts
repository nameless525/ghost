import { describe, expect, it } from 'vitest'
import { actionAt, stepAction, type MenuItem } from './ContextMenu'

const items: MenuItem[] = [
  { heading: 'Battle with Magus' },
  { label: 'Playing', disabled: true },
  { label: 'Play next' },
  { separator: true },
  { label: 'Add to playlist', submenu: [{ label: 'New playlist…' }] },
  { label: 'Remove from queue' }
]

describe('context menu keyboard', () => {
  it('a keyboard-opened menu starts on the first enabled action', () => {
    expect(stepAction(items, -1, 1)).toBe(2)
  })

  it('Enter, Space or Right with nothing active act on nothing instead of throwing', () => {
    expect(actionAt(items, -1)).toBeNull()
    expect(actionAt(items, items.length)).toBeNull()
    expect(actionAt(items, 0)).toBeNull()
    expect(actionAt(items, 1)).toBeNull()
    expect(actionAt(items, 3)).toBeNull()
    expect(actionAt(items, 4)).toBe(items[4])
  })

  it('the first Up goes to the last action, the first Down to the first', () => {
    expect(stepAction(items, -1, -1)).toBe(5)
    expect(stepAction(items, -1, 1)).toBe(2)
  })

  it('skips headings, separators and disabled items, and wraps', () => {
    expect(stepAction(items, 2, 1)).toBe(4)
    expect(stepAction(items, 5, 1)).toBe(2)
    expect(stepAction(items, 2, -1)).toBe(5)
    expect(stepAction(items, 4, -1)).toBe(2)
  })

  it('a menu with nothing to act on stays on nothing', () => {
    const inert: MenuItem[] = [{ heading: 'Add to playlist' }, { label: 'No playlists yet', disabled: true }]
    expect(stepAction(inert, -1, 1)).toBe(-1)
    expect(stepAction(inert, -1, -1)).toBe(-1)
    expect(stepAction([], -1, 1)).toBe(-1)
  })
})
