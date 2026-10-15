import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sound', () => ({ sfx: { play: () => {} } }))

const { notify, useNotifications } = await import('./notifications')
const { SHORTCUT_GROUPS } = await import('./shortcuts')
const { formatCombo, parseCombo } = await import('./keys')

describe('notifications', () => {
  beforeEach(() => useNotifications.setState({ toasts: [], history: [], unread: 0 }))

  it('lists notices in the centre and counts them as unread', () => {
    notify({ kind: 'success', title: 'Downloaded', body: 'Battle' })
    const s = useNotifications.getState()
    expect(s.toasts).toHaveLength(1)
    expect(s.history).toHaveLength(1)
    expect(s.unread).toBe(1)
  })

  it('only toasts ephemeral confirmations (no centre entry, no unread count)', () => {
    notify({ kind: 'info', title: 'Added to queue', body: 'Battle', ephemeral: true })
    notify({ kind: 'info', title: 'Added to queue', body: 'Kefka', ephemeral: true })
    const s = useNotifications.getState()
    expect(s.toasts.map((t) => t.body)).toEqual(['Kefka', 'Battle'])
    expect(s.history).toHaveLength(0)
    expect(s.unread).toBe(0)
  })

  it('updates a card in place when its id comes again', () => {
    notify({ id: 'dl', kind: 'progress', title: 'Downloading', progress: 0.2 })
    notify({ id: 'dl', kind: 'success', title: 'Downloaded' })
    const s = useNotifications.getState()
    expect(s.toasts).toHaveLength(1)
    expect(s.toasts[0]).toMatchObject({ title: 'Downloaded', rev: 1 })
    expect(s.history).toHaveLength(1)
    expect(s.unread).toBe(1)
  })
})

describe('keyboard shortcuts sheet', () => {
  it('lists only combos the key system understands', () => {
    for (const g of SHORTCUT_GROUPS)
      for (const r of g.rows) {
        expect(r.keys.length || r.text, r.label).toBeTruthy()
        for (const k of r.keys) {
          const c = parseCombo(k)
          expect(c.key ?? c.code, `${g.title}: ${k}`).toBeTruthy()
          expect(formatCombo(k).every(Boolean)).toBe(true)
        }
      }
  })
})
