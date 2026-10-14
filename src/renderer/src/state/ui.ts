// UI navigation state: screen stack (osu!-style screens) and overlays.
import { create } from 'zustand'

export type ScreenId = 'title' | 'browse' | 'play'
export type OverlayId = 'library' | 'settings' | 'downloads' | 'nowPlaying' | 'notifications'

export interface UIState {
  screen: ScreenId
  /** Previous screen, for choreographed back transitions. */
  prevScreen: ScreenId | null
  overlays: Record<OverlayId, boolean>
  /** Accent colour currently driving the theme ('#rrggbb'). */
  accent: string
  /** Hero art currently shown by the global background layer. */
  backgroundArt: string | null
  /** 0..1 dim applied to the background art. */
  backgroundDim: number
  /** 0..1 blur amount of the background art. */
  backgroundBlur: number
  goTo(screen: ScreenId): void
  toggleOverlay(id: OverlayId, open?: boolean): void
  closeAllOverlays(): void
  setAccent(hex: string): void
  setBackground(art: string | null, opts?: { dim?: number; blur?: number }): void
}

export const DEFAULT_ACCENT = '#ff66aa'

export const useUI = create<UIState>((set, get) => ({
  screen: 'title',
  prevScreen: null,
  overlays: { library: false, settings: false, downloads: false, nowPlaying: false, notifications: false },
  accent: DEFAULT_ACCENT,
  backgroundArt: null,
  backgroundDim: 0.55,
  backgroundBlur: 1,
  goTo: (screen) => {
    if (screen !== get().screen) set({ prevScreen: get().screen, screen })
  },
  toggleOverlay: (id, open) => set((s) => ({ overlays: { ...s.overlays, [id]: open ?? !s.overlays[id] } })),
  closeAllOverlays: () => set((s) => ({ overlays: Object.fromEntries(Object.keys(s.overlays).map((k) => [k, false])) as UIState['overlays'] })),
  setAccent: (accent) => set({ accent }),
  setBackground: (backgroundArt, opts) =>
    set((s) => ({ backgroundArt, backgroundDim: opts?.dim ?? s.backgroundDim, backgroundBlur: opts?.blur ?? s.backgroundBlur }))
}))

/** True when any modal overlay is open (drives the music low-pass filter). */
export const anyModalOverlay = (s: UIState) => s.overlays.library || s.overlays.settings || s.overlays.downloads
