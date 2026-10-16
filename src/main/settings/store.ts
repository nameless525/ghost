// Persisted user settings (<userData>/settings.json). Deep-merged patches, atomic writes,
// change listeners. Pure Node (no Electron imports) so it can be unit-tested.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mergeSettings, withKnownSources } from '../../shared/defaults'
import type { DeepPartial, Settings } from '../../shared/types'

export type SettingsListener = (next: Settings, prev: Settings) => void

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(hi, Math.max(lo, n))
}

/** The non-empty strings of a list setting (a hand-edited file may hold anything there). */
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [])

/** Coerce out-of-range or wrongly-typed values back into something the app can use. */
export function sanitizeSettings(s: Settings, defaults: Settings): Settings {
  const a = s.audio
  const d = defaults.audio
  const out: Settings = structuredClone(s)
  out.audio.crossfadeSec = clamp(a.crossfadeSec, 0, 12, d.crossfadeSec)
  out.audio.loopCount = Math.round(clamp(a.loopCount, 1, 16, d.loopCount))
  out.audio.fadeSec = clamp(a.fadeSec, 0, 60, d.fadeSec)
  out.audio.uiSoundVolume = clamp(a.uiSoundVolume, 0, 1, d.uiSoundVolume)
  out.audio.normalization.targetLufs = clamp(a.normalization.targetLufs, -40, -5, d.normalization.targetLufs)
  if (!['album', 'endless', 'custom'].includes(a.loopMode)) out.audio.loopMode = d.loopMode
  if (!['auto', 'track', 'album'].includes(a.normalization.mode)) out.audio.normalization.mode = d.normalization.mode
  if (typeof a.device !== 'string' || !a.device) out.audio.device = 'default'
  if (!['lossless', 'high', 'saver'].includes(s.sources.quality)) out.sources.quality = defaults.sources.quality
  out.sources.order = Array.isArray(s.sources.order) ? withKnownSources(s.sources.order.filter((x) => typeof x === 'string'), defaults.sources.order) : [...defaults.sources.order]
  out.sources.disabled = strings(s.sources.disabled)
  out.sources.localFolders = strings(s.sources.localFolders)
  if (typeof s.sources.crawlJoshw !== 'boolean') out.sources.crawlJoshw = false
  out.library.cacheMaxGb = clamp(s.library.cacheMaxGb, 0.25, 1000, defaults.library.cacheMaxGb)
  if (typeof s.library.downloadDir !== 'string' || !s.library.downloadDir.trim()) out.library.downloadDir = defaults.library.downloadDir
  if (typeof s.library.namingTemplate !== 'string' || !s.library.namingTemplate.trim()) out.library.namingTemplate = defaults.library.namingTemplate
  out.interface.uiScale = clamp(s.interface.uiScale, 0.5, 2, defaults.interface.uiScale)
  out.interface.backgroundDim = clamp(s.interface.backgroundDim, 0, 1, defaults.interface.backgroundDim)
  if (typeof s.updates?.auto !== 'boolean') out.updates = { ...defaults.updates }
  return out
}

/** Write a file atomically (temp file + rename) so a crash never leaves it half-written. */
export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  writeFileSync(tmp, data, 'utf8')
  renameSync(tmp, file)
}

export class SettingsStore {
  private current: Settings
  private listeners = new Set<SettingsListener>()

  constructor(
    private readonly file: string,
    private readonly defaults: Settings
  ) {
    this.current = this.load()
  }

  private load(): Settings {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return structuredClone(this.defaults)
    }
    try {
      const parsed = JSON.parse(raw)
      // Merge over defaults so settings added in newer versions get their default values.
      return sanitizeSettings(mergeSettings(this.defaults, parsed), this.defaults)
    } catch (e) {
      // Keep the unreadable file around for inspection rather than silently destroying it.
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      console.warn('[settings] unreadable settings file, using defaults:', e)
      return structuredClone(this.defaults)
    }
  }

  get(): Settings {
    return structuredClone(this.current)
  }

  /** Read-only view without copying (callers must not mutate). */
  peek(): Readonly<Settings> {
    return this.current
  }

  set(patch: DeepPartial<Settings>): Settings {
    const prev = this.current
    const next = sanitizeSettings(mergeSettings(prev, patch), this.defaults)
    this.current = next
    this.persist()
    for (const l of this.listeners) {
      try {
        l(next, prev)
      } catch (e) {
        console.error('[settings] listener failed:', e)
      }
    }
    return this.get()
  }

  onChange(cb: SettingsListener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private persist(): void {
    try {
      writeFileAtomic(this.file, JSON.stringify(this.current, null, 2))
    } catch (e) {
      console.error('[settings] failed to save:', e)
    }
  }
}
