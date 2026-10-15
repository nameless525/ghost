// Provider interface (DESIGN §6.1). A provider knows one source of music: it can list albums,
// describe an album's tracks, find candidates for a canonical track, and turn a locator into a
// playable stream. The catalog's resolver asks enabled providers in the user's priority order.

import type { AlbumKind, AudioFormat, ExternalAlbumHit } from '../../shared/types'
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
  /**
   * Index crawls keep this album only when the catalog already has a game of that name (a source
   * whose listings mix game rips with musicians' originals, e.g. Modland's named NSF folders).
   */
  onlyForKnownGame?: boolean
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
  /**
   * Streams already known when the album was fetched (Internet Archive files, Bandcamp stream URLs,
   * a YouTube video resolved for its chapters). Stored as sources on import so playback can start
   * without another provider round-trip.
   */
  streams?: StreamInfo[]
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
  /**
   * When the resolver calls findTrack: 'always' (cheap, e.g. a local DB lookup; the default) or
   * 'fallback' (a network search: only once the album's own sources all failed or were excluded).
   */
  findTrackMode?: 'always' | 'fallback'
  /**
   * resolveStream costs one polite page request (KHInsider's track page): worth doing ahead of a
   * likely play, at a lower priority. Unset for providers whose streams are free (known at album
   * time) or expensive (a yt-dlp run).
   */
  prefetchStreams?: boolean
  /** Album-like results for "import from YouTube / Internet Archive / Bandcamp". */
  searchExternal?(q: string, opts?: ProviderCallOptions): Promise<ExternalAlbumHit[]>
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

/** Providers with a crawlable album index (KHInsider, Zophar's Domain, Modland, IA collections). */
export interface IndexProvider extends Provider {
  indexSections(): IndexSection[]
  fetchIndexPage(sectionKey: string, page: number, opts?: ProviderCallOptions): Promise<IndexPage>
  /** Re-crawl the index after this long (default 7 days). */
  indexRefreshMs?: number
  /** Pause between index pages on top of the host limiter (default 750 ms; 0 for local/in-memory pages). */
  indexPageDelayMs?: number
  /**
   * Crawl after the other secondary sources instead of alongside them (its hits match against
   * games the others add, e.g. Modland's `onlyForKnownGame`).
   */
  indexAfterOthers?: boolean
  /** Rough length of a full first crawl (for "about N min left" before the crawl has a page rate). */
  indexEstimateMs?: number
}

export function isIndexProvider(p: Provider): p is IndexProvider {
  return typeof (p as IndexProvider).indexSections === 'function' && typeof (p as IndexProvider).fetchIndexPage === 'function'
}

export const LOSSLESS_FORMATS = new Set<AudioFormat>(['flac', 'wav'])
