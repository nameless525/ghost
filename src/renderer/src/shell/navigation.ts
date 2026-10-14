// Screen navigation helpers on top of useUI.
import { useUI, type OverlayId, type ScreenId } from '../state/ui'
import { sfx } from '../sound'

/** Depth order: going to a later screen is 'forward'. */
export const SCREEN_ORDER: ScreenId[] = ['title', 'browse', 'play']
export const SCREEN_IDS = new Set<ScreenId>(SCREEN_ORDER)
export const OVERLAY_IDS = new Set<OverlayId>(['library', 'settings', 'downloads', 'nowPlaying', 'notifications'])

export const screenDepth = (s: ScreenId): number => SCREEN_ORDER.indexOf(s)

/** The screen Esc returns to, or null on the title screen. */
export function parentScreen(s: ScreenId): ScreenId | null {
  if (s === 'play') return 'browse'
  if (s === 'browse') return 'title'
  return null
}

/** Go back one screen (play → browse → title). Returns false when already at the top. */
export function goBack(): boolean {
  const ui = useUI.getState()
  const p = parentScreen(ui.screen)
  if (!p) return false
  sfx.play('back')
  ui.goTo(p)
  return true
}

/** Navigate with the select sound. */
export function navigate(s: ScreenId): void {
  const ui = useUI.getState()
  if (ui.screen === s) return
  sfx.play(screenDepth(s) > screenDepth(ui.screen) ? 'confirm' : 'back')
  ui.goTo(s)
}

/**
 * Apply ?screen=…&overlay=… deep links (used by every workstream for screenshots).
 *   ?screen=title|browse|play     ?overlay=library|settings|downloads|nowPlaying|notifications
 */
export function applyDeepLinks(search = window.location.search): void {
  const q = new URLSearchParams(search)
  const screen = q.get('screen')?.toLowerCase() as ScreenId | undefined
  if (screen && SCREEN_IDS.has(screen)) useUI.setState({ screen, prevScreen: null })
  const raw = q.get('overlay')
  if (raw) {
    const norm = raw.replace(/[-_\s]/g, '').toLowerCase()
    const id = [...OVERLAY_IDS].find((o) => o.toLowerCase() === norm)
    if (id) useUI.getState().toggleOverlay(id, true)
  }
}
