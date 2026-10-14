// Provider interface (DESIGN §6.1). A provider knows one source of music: it can list albums,
// describe an album's tracks, find candidates for a canonical track, and turn a locator into a
// playable stream. The catalog's resolver asks enabled providers in the user's priority order.

import type { AlbumKind, AudioFormat } from '../../shared/types'
import type { EngineSource } from '../engine/types'
import type { Priority } from '../net/limiter'

export interface ProviderCallOptions {
  priority?: Priority
  signal?: AbortSignal
  /** Bypass caches. */
  force?: boolean
}

export interface PlatformRef {
  /** Stable lowercase id, e.g. 'nintendo-snes'. */
  slug: string
  /** Display name, e.g. 'SNES'. */
  name: string
}

/** One album as it appears in a listing (browse index, search results, "latest"). */
export interface AlbumHit {
  provider: string
  /** Provider-specific album reference (KHInsider: the album slug). */
  ref: string
  title: string
  /** The listing had no title; `title` was derived from `ref`. */
  titleFromRef: boolean
  platforms: PlatformRef[]
  kind: AlbumKind
  /** The provider's own type label, e.g. 'Gamerip'. */
  typeLabel: string | null
  year: number | null
  /** Small thumbnail URL. */
  thumb: string | null
  /** Best-guess full-size cover URL. */
  cover: string | null
  catalogNo: string | null
  /** When the provider says the album was added (epoch ms), if listed. */
  addedAt: number | null
}

export interface ProviderTrackFile {
  format: AudioFormat
  sizeBytes: number | null
}

export interface ProviderTrack {
  disc: number
  number: number
  title: string
  durationMs: number | null
  /** Provider locator for resolveStream (KHInsider: '<album slug>/<encoded file>'). */
  locator: string
  files: ProviderTrackFile[]
  composers: string[]
}

export interface ProviderAlbum extends AlbumHit {
  altTitles: string[]
  /** Original-language title when one of the alternative titles is in a non-Latin script. */
  titleOriginal: string | null
  developers: string[]
  publishers: string[]
  composers: string[]
  /** All full-size images (cover first). */
  images: string[]
  description: string | null
  formats: AudioFormat[]
  /** Total bytes per format as reported by the provider. */
  totalSizes: Partial<Record<AudioFormat, number>>
  /** Provider-internal numeric id if any. */
  externalId: string | null
  tracks: ProviderTrack[]
}

/** A playable stream for a locator. */
export interface StreamInfo {
  provider: string
  source: EngineSource
  format: AudioFormat
  lossless: boolean
  bitrateKbps: number | null
  sizeBytes: number | null
  /** URLs that expire (YouTube) set this; null = stable. */
  expiresAt: number | null
}

/** What we know about a track when asking search-based providers for candidates. */
export interface CanonicalTrack {
  trackId: string
  title: string
  albumTitle: string
  gameName: string | null
  composers: string[]
  durationMs: number | null
  disc: number
  number: number
  year: number | null
  platforms: string[]
  /** Album owner provider + ref, and this track's locator with that provider. */
  albumProvider: string
  albumRef: string
  locator: string
}

export interface SourceCandidate {
  provider: string
  locator: string
  title: string
  durationMs: number | null
  /** 0..1 match confidence (DESIGN §6.4). */
  confidence: number
}

export interface Provider {
  id: string
  /** Human name for settings / UI. */
  name: string
  searchAlbums?(q: string, opts?: ProviderCallOptions): Promise<AlbumHit[]>
  getAlbum?(ref: string, opts?: ProviderCallOptions): Promise<ProviderAlbum>
  /** Search-based providers (YouTube, Internet Archive, local files) find candidates for any track. */
  findTrack?(t: CanonicalTrack, opts?: ProviderCallOptions): Promise<SourceCandidate[]>
  /** Turn a locator into playable stream(s), one per available format. */
  resolveStream(locator: string, opts?: ProviderCallOptions): Promise<StreamInfo[]>
}

export interface IndexSection {
  key: string
  label: string
  /** Stop after this many pages (e.g. the "latest additions" feed). */
  maxPages?: number
}

export interface IndexPage {
  items: AlbumHit[]
  page: number
  totalPages: number
  totalAlbums: number | null
}

/** Providers with a crawlable album index (KHInsider). */
export interface IndexProvider extends Provider {
  indexSections(): IndexSection[]
  fetchIndexPage(sectionKey: string, page: number, opts?: ProviderCallOptions): Promise<IndexPage>
}

export function isIndexProvider(p: Provider): p is IndexProvider {
  return typeof (p as IndexProvider).indexSections === 'function' && typeof (p as IndexProvider).fetchIndexPage === 'function'
}

export const LOSSLESS_FORMATS = new Set<AudioFormat>(['flac', 'wav'])
