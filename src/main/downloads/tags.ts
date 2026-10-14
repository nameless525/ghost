// Tag and template metadata for downloads.
import type { Album, Game, TrackAnalysis, TrackView } from '../../shared/types'
import type { TagInfo } from '../engine/types'
import type { TemplateVars } from './naming'

/** ReplayGain 2.0 reference loudness. */
export const REPLAYGAIN_REFERENCE_LUFS = -18

/** Only plain web URLs can be fetched by the engine for cover embedding. */
export function fetchableUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return url
  // ghost-art:// proxies a remote image; recover the original URL when it is embedded.
  const m = /^ghost-art:\/\/[^?]*\?(?:.*&)?(?:u|url)=([^&]+)/i.exec(url)
  if (m) {
    try {
      const u = decodeURIComponent(m[1])
      return /^https?:\/\//i.test(u) ? u : null
    } catch {
      return null
    }
  }
  return null
}

export function templateVars(track: TrackView, album: Album | null, game: Game | null): TemplateVars {
  const composers = track.composers.length ? track.composers : (album?.composers ?? [])
  return {
    game: game?.name ?? track.gameName ?? album?.gameName ?? album?.title ?? track.albumTitle ?? 'Unknown Game',
    album: album?.title ?? track.albumTitle ?? 'Unknown Album',
    year: album?.year ?? track.year ?? game?.year ?? null,
    disc: track.disc || 1,
    track: track.number || null,
    title: track.title || 'Untitled',
    composer: composers.join(', ') || null,
    platform: (album?.platforms?.length ? album.platforms : track.platforms)[0] ?? null,
    kind: album?.kind ?? track.albumKind ?? null,
    catalog: album?.catalogNo ?? null
  }
}

export function buildTags(track: TrackView, album: Album | null, game: Game | null, analysis: TrackAnalysis | null): TagInfo {
  const composers = track.composers.length ? track.composers : (album?.composers ?? [])
  const composer = composers.join(', ') || null
  const lufs = analysis?.lufs ?? null
  const peakDb = analysis?.truePeakDb ?? null
  return {
    title: track.title,
    album: album?.title ?? track.albumTitle,
    albumArtist: game?.name ?? track.gameName ?? album?.gameName ?? null,
    artist: composer,
    composer,
    trackNumber: track.number || null,
    trackTotal: album?.trackCount ?? null,
    discNumber: track.disc || null,
    year: album?.year ?? track.year ?? game?.year ?? null,
    genre: 'Video Game',
    comment: 'GHOST',
    coverUrl: fetchableUrl(album?.cover) ?? fetchableUrl(track.cover) ?? fetchableUrl(game?.cover),
    replayGainTrackDb: typeof lufs === 'number' && Number.isFinite(lufs) ? Math.round((REPLAYGAIN_REFERENCE_LUFS - lufs) * 100) / 100 : null,
    replayGainTrackPeak: typeof peakDb === 'number' && Number.isFinite(peakDb) ? Math.round(Math.pow(10, peakDb / 20) * 1e6) / 1e6 : null
  }
}
