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

export interface CatalogService extends CatalogAPI {
  /** Start background work (index crawl if stale, art prefetch queue). */
  start(): void
  stop(): void
  /** Full analysis for a track, if recorded. */
  getAnalysis(trackId: ID): TrackAnalysis | null
  recordAnalysis(trackId: ID, result: OfflineAnalysisResult): void
  /**
   * Ranked playable sources for a track, resolving provider URLs on demand.
   * `exclude` lists cache keys that already failed this session.
   */
  resolveSources(trackId: ID, opts?: { quality?: Settings['sources']['quality']; exclude?: string[] }): Promise<ResolvedSource[]>
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
