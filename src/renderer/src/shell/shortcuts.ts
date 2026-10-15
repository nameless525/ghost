// Every keyboard shortcut a user can rely on, grouped by where it works: the "Keyboard
// shortcuts" sheet (?, Settings → Interface) reads this list. Keep it in step with the
// useKeybinding calls when you add or change one. Combos use the keys.ts syntax (Mod = ⌘ / Ctrl).
import { create } from 'zustand'

export interface ShortcutRow {
  /** Alternatives, shown as "A / B" (or a range "A–B" with `range`). */
  keys: string[]
  label: string
  /** Words instead of keycaps (e.g. "Just type"). */
  text?: string
  range?: boolean
}

export interface ShortcutGroup {
  title: string
  rows: ShortcutRow[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Anywhere',
    rows: [
      { keys: ['Space'], label: 'Play / pause' },
      { keys: ['Mod+ArrowLeft', 'Mod+ArrowRight'], label: 'Previous / next track' },
      { keys: ['F6'], label: 'Now playing' },
      { keys: ['Mod+L'], label: 'Library' },
      { keys: ['Mod+O'], label: 'Settings' },
      { keys: ['Escape'], label: 'Close or go back' },
      { keys: ['?'], label: 'Keyboard shortcuts' }
    ]
  },
  {
    title: 'Browse',
    rows: [
      { keys: ['Mod+F'], label: 'Search the catalog (or just start typing)' },
      { keys: ['Mod+Enter'], label: 'Search online (YouTube, SoundCloud…)' },
      { keys: ['ArrowUp', 'ArrowDown'], label: 'Move through the list' },
      { keys: ['ArrowRight', 'ArrowLeft'], label: 'Open / close a game or album' },
      { keys: ['Enter'], label: 'Play' },
      { keys: ['P'], label: 'Preview' },
      { keys: ['Q', 'Shift+Q'], label: 'Add to queue / play next' },
      { keys: ['L'], label: 'Like' },
      { keys: ['Mod+S'], label: 'Add to playlist' },
      { keys: ['Mod+D'], label: 'Download' },
      { keys: ['F2', 'Shift+F2'], label: 'Random pick / previous pick' },
      { keys: ['Alt+J'], label: 'Original / romanized titles' }
    ]
  },
  {
    title: 'Play screen',
    rows: [
      { keys: ['ArrowLeft', 'ArrowRight'], label: 'Seek 5 s (with Shift: 15 s)' },
      { keys: ['ArrowUp', 'ArrowDown'], label: 'Volume' },
      { keys: ['M'], label: 'Mute' },
      { keys: ['L'], label: 'Like' },
      { keys: ['Q'], label: 'Show / hide the queue' },
      { keys: ['/', 'Mod+F'], label: 'Search the queue (while it’s open)' },
      { keys: ['V'], label: 'Change the visualizer' },
      { keys: ['Mod+D'], label: 'Download' },
      { keys: ['1', '9'], range: true, label: 'Chiptunes: mute a channel (0: all on)' }
    ]
  },
  {
    title: 'Library',
    rows: [
      { keys: ['Mod+1', 'Mod+4'], range: true, label: 'Switch tabs' },
      { keys: ['Mod+N'], label: 'New playlist' },
      { keys: ['Enter'], label: 'Play the selected track' },
      { keys: ['Q', 'Shift+Q'], label: 'Add to queue / play next' },
      { keys: ['L'], label: 'Like' },
      { keys: ['Mod+D'], label: 'Download' },
      { keys: ['Mod+A'], label: 'Select all' },
      { keys: ['Alt+ArrowUp', 'Alt+ArrowDown'], label: 'Move up / down in a playlist' },
      { keys: ['Delete'], label: 'Remove from playlist' }
    ]
  }
]

/** Whether the sheet is open (GlobalKeys hosts it; the dialog chunk loads on first open). */
export const useShortcutsSheet = create<{ open: boolean }>(() => ({ open: false }))

export const openShortcuts = (): void => useShortcutsSheet.setState({ open: true })
export const closeShortcuts = (): void => useShortcutsSheet.setState({ open: false })
