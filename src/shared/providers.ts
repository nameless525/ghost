// Display names of the music sources (provider ids), and how a backup source is explained: shared
// by the UI and the main process's notices.
import type { AudioFormat, SourceMiss } from './types'

export const PROVIDER_NAMES: Record<string, string> = {
  khinsider: 'KHInsider',
  youtube: 'YouTube',
  yt: 'YouTube',
  archive: 'Internet Archive',
  bandcamp: 'Bandcamp',
  local: 'Local files',
  chip: 'Chiptune engine',
  zophar: 'Zophar’s Domain',
  modland: 'Modland',
  soundcloud: 'SoundCloud',
  download: 'Your download'
}

export const providerName = (p: string | null | undefined): string => (p ? (PROVIDER_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1)) : 'Unknown')

const formatName = (f: AudioFormat): string => (f === 'unknown' ? 'file' : f.toUpperCase())

/** What went wrong with the source GHOST meant to use: "Internet Archive isn’t answering". */
export function missReason(miss: SourceMiss): string {
  if (miss.provider === 'download') return 'Your downloaded file couldn’t be played'
  const from = providerName(miss.provider)
  return miss.noAnswer ? `${from} isn’t answering` : `${from}’s ${formatName(miss.format)} couldn’t be played`
}

/**
 * Why a track plays from `to` rather than the source GHOST meant to use: "Internet Archive isn’t
 * answering, so this is a backup copy from YouTube."
 */
export function backupReason(miss: SourceMiss, to: { provider: string; format: AudioFormat }): string {
  if (miss.provider === 'download') return `${missReason(miss)}, so this streams from ${providerName(to.provider)}.`
  if (miss.provider === to.provider) return `The ${formatName(miss.format)} from ${providerName(miss.provider)} ${miss.noAnswer ? 'didn’t load' : 'couldn’t be played'}, so this is its ${formatName(to.format)} instead.`
  return `${missReason(miss)}, so this is a backup copy from ${providerName(to.provider)}.`
}

/** Whether `to` stands in for the missed source (a 403 that re-resolved the same file isn't a backup). */
export function isBackup(miss: SourceMiss | null | undefined, to: { provider: string; format: AudioFormat }): miss is SourceMiss {
  return !!miss && (miss.provider !== to.provider || miss.format !== to.format)
}
