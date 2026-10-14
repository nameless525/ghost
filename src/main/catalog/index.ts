// Contract between the catalog workstream (implements) and the services workstream (consumes).
// Change additively.
import type { CatalogAPI } from '../../shared/api'
import type { Album, AudioFormat, Game, ID, Settings, TrackAnalysis, TrackView } from '../../shared/types'
import type { DB } from '../db'
import type { Broadcast } from '../ipc'
import type { ArchiveListing, EngineSource, OfflineAnalysisResult } from '../engine/types'

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
   * their archive's listing. Without it those albums can't be opened.
   */
  inspectArchive?: (source: EngineSource) => Promise<ArchiveListing>
}

export { createCatalogService as createCatalog } from './service'
