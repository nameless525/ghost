// App-wide shortcuts (DESIGN §7.5). Rendered at the root, outside any screen/overlay scope.
import { ghost } from '../ghost'
import { useSettings, updateSettings } from '../state/settings'
import { useUI } from '../state/ui'
import { sfx } from '../sound'
import { useKeybinding } from './keys'
import { goBack } from './navigation'

const isActivatable = (el: Element | null) =>
  !!el && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SUMMARY' || ['button', 'menuitem', 'option', 'switch', 'tab', 'radio', 'checkbox'].includes(el.getAttribute('role') ?? ''))

export function GlobalKeys() {
  // Space: play/pause, unless a keyboard-focused control wants Space for itself. A control
  // that merely kept focus after a mouse click is blurred instead of being re-activated.
  useKeybinding(
    'Space',
    () => {
      const el = document.activeElement as HTMLElement | null
      if (isActivatable(el)) {
        if (el!.matches(':focus-visible')) return false
        el!.blur()
      }
      void ghost().player.toggle()
    },
    { scope: 'global', repeat: false }
  )
  useKeybinding('Mod+ArrowLeft', () => void ghost().player.prev(), { scope: 'global' })
  useKeybinding('Mod+ArrowRight', () => void ghost().player.next(), { scope: 'global' })
  useKeybinding('Mod+L', () => useUI.getState().toggleOverlay('library'), { scope: 'global', repeat: false })
  useKeybinding('Mod+O', () => useUI.getState().toggleOverlay('settings'), { scope: 'global', repeat: false })
  useKeybinding('F6', () => useUI.getState().toggleOverlay('nowPlaying'), { scope: 'global', repeat: false })
  useKeybinding('Mod+Shift+F', () => void updateSettings({ interface: { showFps: !useSettings.getState().interface.showFps } }), { scope: 'global', repeat: false })
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
  return null
}
