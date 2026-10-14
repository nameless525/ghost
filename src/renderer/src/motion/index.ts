// Motion toolkit: one rAF loop, osu!-style transforms, springs, and music-aware timing.
// See src/renderer/src/ui/README.md for a guided tour.
import './prefs'

export { easings, resolveEasing, cssEasing, clamp, clamp01, lerp, damp, DEFAULT_EASING } from './easing'
export type { Easing, EasingFn, EasingName } from './easing'
export { ticker, useTicker, TickPriority } from './ticker'
export type { TickFn } from './ticker'
export { tween, stagger, animateValue, Tween } from './tween'
export type { TweenProp, TweenValues, ValueAnimation } from './tween'
export { Spring } from './spring'
export type { SpringOptions } from './spring'
export { frame, levels, retainLevels } from './frame'
export { beat } from './beat'
export type { BeatEvent } from './beat'
export { usePulse, useBeat, useKiai, useAudioLevels, useReducedMotion } from './hooks'
export type { PulseOptions } from './hooks'
export { motionPrefs } from './prefs'
