// Theme entry: global CSS, tokens, accent driver, per-overlay hues and colour helpers.
import './tokens.css'
import './global.css'

export * from './color'
export { accentNow, transitionAccent, startAccentDriver, ACCENT_TRANSITION_MS } from './accent'

/** Each overlay/section owns a hue (osu!-style). Mirrors the --hue-* tokens. */
export const HUES = {
  browse: '#ff66aa',
  library: '#5aa8ff',
  downloads: '#4fe0a0',
  settings: '#a983ff',
  radio: '#ffb35c',
  notifications: '#ffd166'
} as const
export type HueId = keyof typeof HUES

/** `var(--hue-library)` etc. */
export const hueVar = (id: HueId): string => `var(--hue-${id})`
/** `var(--hue-library-rgb)` etc., for rgb(var(...) / a). */
export const hueRgbVar = (id: HueId): string => `var(--hue-${id}-rgb)`

export type Platform = 'mac' | 'win' | 'linux'

export function detectPlatform(): Platform {
  const ua = navigator.userAgent
  if (/Mac|iPhone|iPad/.test(ua)) return 'mac'
  if (/Win/.test(ua)) return 'win'
  return 'linux'
}

export const platform: Platform = typeof navigator !== 'undefined' ? detectPlatform() : 'linux'
export const isMac = platform === 'mac'

if (typeof document !== 'undefined') document.documentElement.classList.add(`platform-${platform}`)
