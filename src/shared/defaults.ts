import type { Settings } from './types'

export const DEFAULT_SOURCE_ORDER = ['local', 'chip', 'bandcamp', 'khinsider', 'zophar', 'modland', 'archive', 'soundcloud', 'youtube']

/**
 * A saved source order plus any source it doesn't know yet (added in a later version), each slotted
 * in right after its nearest default-order predecessor (or before its nearest successor), so new
 * sources land where the defaults put them instead of after the last resort, and the user's own
 * arrangement is kept. Duplicates are dropped.
 */
export function withKnownSources(order: readonly string[], defaults: readonly string[] = DEFAULT_SOURCE_ORDER): string[] {
  const out = order.filter((id, i) => order.indexOf(id) === i)
  defaults.forEach((id, i) => {
    if (out.includes(id)) return
    const prev = defaults
      .slice(0, i)
      .reverse()
      .find((d) => out.includes(d))
    if (prev) return void out.splice(out.indexOf(prev) + 1, 0, id)
    const next = defaults.slice(i + 1).find((d) => out.includes(d))
    if (next) out.splice(out.indexOf(next), 0, id)
    else out.push(id)
  })
  return out
}

export function defaultSettings(downloadDir: string): Settings {
  return {
    audio: {
      device: 'default',
      normalization: { enabled: true, targetLufs: -16, mode: 'auto' },
      gapless: true,
      crossfadeSec: 0,
      loopMode: 'album',
      loopCount: 2,
      fadeSec: 10,
      previewOnSelect: true,
      uiSounds: true,
      uiSoundVolume: 0.6
    },
    sources: { order: [...DEFAULT_SOURCE_ORDER], disabled: [], quality: 'lossless', localFolders: [], crawlJoshw: false },
    library: {
      downloadDir,
      namingTemplate: '{game}/{album} ({year})/{disc}-{track} {title}',
      cacheMaxGb: 5
    },
    interface: {
      uiScale: 1,
      parallax: true,
      blurQuality: 'high',
      preferOriginalTitles: false,
      backgroundDim: 0.55,
      visualizer: 'radial',
      reduceMotion: false,
      showFps: false
    },
    keys: { igdbClientId: '', igdbClientSecret: '', steamGridDbKey: '' }
  }
}

/** Deep-merge a partial settings patch (arrays are replaced, not merged). */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return (patch ?? base) as T
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) }
  for (const [k, v] of Object.entries(patch as object)) {
    if (v === undefined) continue
    const cur = (base as any)?.[k]
    out[k] = cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v) ? mergeSettings(cur, v) : v
  }
  return out
}

/** osu! difficulty colour spectrum, used for Intensity ★. */
export const INTENSITY_STOPS: [number, string][] = [
  [0.1, '#4290fb'],
  [1.25, '#4fc0ff'],
  [2.0, '#4fffd5'],
  [2.5, '#7cff4f'],
  [3.3, '#f6f05c'],
  [4.2, '#ff8068'],
  [4.9, '#ff4e6f'],
  [5.8, '#c645b8'],
  [6.7, '#6563de'],
  [7.7, '#18158e'],
  [9.0, '#000000']
]

export function intensityColor(stars: number): string {
  const s = INTENSITY_STOPS
  if (stars <= s[0][0]) return s[0][1]
  for (let i = 1; i < s.length; i++) {
    if (stars <= s[i][0]) {
      const [a, ca] = s[i - 1]
      const [b, cb] = s[i]
      const t = (stars - a) / (b - a)
      const pa = parseInt(ca.slice(1), 16)
      const pb = parseInt(cb.slice(1), 16)
      const mix = (sh: number) => Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t)
      return '#' + ((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, '0')
    }
  }
  return s[s.length - 1][1]
}
