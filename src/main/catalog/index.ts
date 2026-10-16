// Contract between the catalog (implements) and the main-process services (consume).
// Change additively.
import type { CatalogAPI } from '../../shared/api'
import type { Album, AudioFormat, Game, ID, Settings, TrackAnalysis, TrackView } from '../../shared/types'
import type { DB } from '../db'
import type { Broadcast } from '../ipc'
import type { ArchiveListing, EngineSource, OfflineAnalysisResult } from '../engine/types'
import type { ResolveStep } from './progress'

export interface ResolvedSource {
  provider: string
  source: EngineSource
  format: AudioFormat
  lossless: boolean
  bitrateKbps: number | null
  /** 0..1 */
  confidence: number
  sizeBytes: number | null
}

/**
 * The catalog runs in a worker thread (./worker.ts); main holds an RPC proxy (./client.ts). Methods
 * returning void are fire-and-forget: they return at once and errors are logged, not thrown.
 */
export interface CatalogService extends CatalogAPI {
  /** Start background work (index crawl if stale, art prefetch queue). Fire-and-forget. */
  start(): void
  /** Stop background work. Fire-and-forget. */
  stop(): void
  /** Full analysis for a track, if recorded. (Async since the catalog moved off the main thread.) */
  getAnalysis(trackId: ID): Promise<TrackAnalysis | null>
  /**
   * Synchronous peek at an analysis this process recorded or fetched recently (the main-side proxy
   * keeps a small LRU). `undefined` = not known here: call getAnalysis. Optional.
   */
  peekAnalysis?(trackId: ID): TrackAnalysis | null | undefined
  /** Store an engine analysis. Fire-and-forget. */
  recordAnalysis(trackId: ID, result: OfflineAnalysisResult): void
  /**
   * Ranked playable sources for a track, resolving provider URLs on demand.
   * `exclude` lists cache keys that already failed this session.
   */
  resolveSources(trackId: ID, opts?: { quality?: Settings['sources']['quality']; exclude?: string[] }): Promise<ResolvedSource[]>
  /** Demote a source the engine failed to play. Fire-and-forget. */
  markSourceFailed(trackId: ID, cacheKey: string, reason: string): void
  /**
   * Hint: these tracks are likely to play soon (the selected track, the next ones in a queue).
   * Resolves the first few whose source needs a page request (KHInsider) at background priority, so
   * play starts without that round-trip; a play arriving meanwhile joins it. Never searches.
   * Fire-and-forget.
   */
  warmSources(trackIds: ID[]): void
  /**
   * Hint: these albums are on screen and their track lists aren't known (the selected game's), so
   * fetch them in the background (normal priority, a couple at a time, at most a couple of dozen)
   * for the game's track count and length. A newer call replaces the albums still waiting.
   * Fire-and-forget.
   */
  fillAlbums(albumIds: ID[]): void
  /** Album + game for a track (tagging, album gain, notifications). */
  albumOf(trackId: ID): Promise<{ album: Album; game: Game | null } | null>
  /** Evaluate a search query (same syntax as Browse) to track ids, e.g. for smart playlists. */
  queryTrackIds(query: string, limit?: number): Promise<ID[]>
}

/** TrackViews returned by the catalog have liked=false/downloaded=false; services decorate them. */
export type UndecoratedTrackView = TrackView

export interface CatalogDeps {
  db: DB
  broadcast: Broadcast
  getSettings: () => Settings
  /**
   * The engine's archive lister (`EngineBridge.inspectArchive`): chiptune rip albums are built from
   * their archive's listing. Without it those albums can't be opened. `progressKey`: the TaskProgress
   * key main reports the archive's download under (the album being opened).
   */
  inspectArchive?: (source: EngineSource, ctx?: { progressKey?: string }) => Promise<ArchiveListing>
  /** A resolve a play is waiting on went to the network (see ResolveStep); re-sent as a download progresses. */
  onResolveStep?: (step: ResolveStep) => void
  /**
   * Settings pushed to the catalog (the worker gets them from main): called after `getSettings`
   * returns the new ones. Without it, settings the catalog acts on (local folders, sources turned
   * on or off) are polled.
   */
  onSettingsChanged?: (fn: () => void) => () => void
}

export { createCatalogService as createCatalog } from './service'
