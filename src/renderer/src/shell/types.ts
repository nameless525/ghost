// Props contracts between the shell and the screens / overlays other workstreams build.
import type { OverlayId, ScreenId } from '../state/ui'

export type { OverlayId, ScreenId }

/** 'entering' on mount (run your enter choreography), 'active' once settled, 'exiting' while leaving. */
export type ScreenLifecycle = 'entering' | 'active' | 'exiting'

/** 'forward' when going deeper (title → browse → play), 'back' when returning. */
export type NavDirection = 'forward' | 'back'

/**
 * Props every screen component receives from the ScreenStack.
 *
 * Choreography: call `useScreenTransitions({ enter, exit })` (shell/ScreenStack) to run your
 * own staggered enter/exit with the motion toolkit. If you don't, the stack applies a default
 * slide + fade to the whole screen. Your `exit` may return a promise (e.g. an awaited tween);
 * the stack waits for it (max 1 s) before unmounting the screen.
 */
export interface ScreenProps {
  lifecycle: ScreenLifecycle
  /** Direction of the navigation that caused the current lifecycle. */
  direction: NavDirection
  /** Screen we came from (on enter) — null on first load. */
  from: ScreenId | null
  /** Screen we're leaving for (while exiting), else null. */
  to: ScreenId | null
}

/** 'entering' while sliding in, 'open' when settled, 'exiting' while sliding out, 'closed' when hidden. */
export type OverlayPhase = 'entering' | 'open' | 'exiting' | 'closed'

/**
 * Props every overlay content component receives from the OverlayHost.
 *
 * The host draws the panel (slide-in, hue, backdrop, focus trap, Esc/click-outside) and
 * renders your component inside it; you fill it (use <OverlayHeader/> for the title row).
 * After its first open, an overlay stays mounted while closed (state is preserved), so check
 * `open` to pause expensive work (tickers, polling) while hidden.
 */
export interface OverlayProps {
  /** True while the overlay is open or opening. */
  open: boolean
  phase: OverlayPhase
  /** Close this overlay (plays the exit animation). */
  close: () => void
  /** CSS colour of this overlay's hue (also applied as --accent inside the panel). */
  hue: string
}
