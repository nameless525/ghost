// Motion preferences mirrored from settings so per-frame code can read them for free.
import { useSettings } from '../state/settings'

export const motionPrefs = {
  /** settings.interface.reduceMotion */
  reduce: false,
  /** settings.interface.parallax (and !reduce) */
  parallax: true
}

function sync(s: ReturnType<typeof useSettings.getState>): void {
  const reduce = !!s.interface?.reduceMotion
  motionPrefs.reduce = reduce
  motionPrefs.parallax = !!s.interface?.parallax && !reduce
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('reduce-motion', reduce)
}

sync(useSettings.getState())
useSettings.subscribe(sync)
