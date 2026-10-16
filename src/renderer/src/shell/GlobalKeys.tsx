// App-wide shortcuts (DESIGN §7.5). Rendered at the root, outside any screen/overlay scope.
// Also hosts the "Keyboard shortcuts" sheet (?), whose chunk loads on its first open.
import { ghost } from '../ghost'
import { useSettings, updateSettings } from '../state/settings'
import { useUI } from '../state/ui'
import { sfx } from '../sound'
import { focusedControlTakesKey, useKeybinding } from './keys'
import { lazyModule, useLazyModule } from './lazyModule'
import { goBack } from './navigation'
import { closeShortcuts, openShortcuts, useShortcutsSheet } from './shortcuts'
import type { ShortcutsSheetProps } from './ShortcutsSheet'

const sheet = lazyModule<ShortcutsSheetProps>(() => import('./ShortcutsSheet'))

function ShortcutsSheetHost() {
  const open = useShortcutsSheet((s) => s.open)
  // mounted from the first open on (it animates out on close)
  const wanted = open || sheet.loaded !== null
  return wanted ? <SheetLoader open={open} /> : null
}
function SheetLoader({ open }: { open: boolean }) {
  const Sheet = useLazyModule(sheet)
  return Sheet ? <Sheet open={open} onClose={closeShortcuts} /> : null
}

export function GlobalKeys() {
  // Space: play/pause, unless a keyboard-focused control wants Space for itself. A control
  // that merely kept focus after a mouse click is blurred instead of being re-activated.
  useKeybinding(
    'Space',
    () => {
      if (focusedControlTakesKey()) return false
      void ghost().player.toggle()
    },
    { scope: 'global', repeat: false }
  )
  // no auto-repeat: holding the keys flooded the engine with skips
  useKeybinding('Mod+ArrowLeft', () => void ghost().player.prev().catch(() => {}), { scope: 'global', repeat: false })
  useKeybinding('Mod+ArrowRight', () => void ghost().player.next().catch(() => {}), { scope: 'global', repeat: false })
  useKeybinding('Mod+L', () => useUI.getState().toggleOverlay('library'), { scope: 'global', repeat: false })
  useKeybinding('Mod+O', () => useUI.getState().toggleOverlay('settings'), { scope: 'global', repeat: false })
  useKeybinding('F6', () => useUI.getState().toggleOverlay('nowPlaying'), { scope: 'global', repeat: false })
  useKeybinding('Mod+Shift+F', () => void updateSettings({ interface: { showFps: !useSettings.getState().interface.showFps } }), { scope: 'global', repeat: false })
  useKeybinding('?', () => (useShortcutsSheet.getState().open ? closeShortcuts() : openShortcuts()), { scope: 'global', repeat: false })
  // Esc: overlays bind it first (OverlayHost); screens may bind it too; otherwise go back
  useKeybinding(
    'Escape',
    () => {
      if (goBack()) return
      sfx.play('back', { volume: 0.4 })
      return false
    },
    { scope: 'global', priority: -1000 }
  )
  return <ShortcutsSheetHost />
}
