// Progress the catalog worker reports to the main process while the player waits on it.
// The worker sends these over its RPC endpoint; services.ts hands them to the player, which
// turns them into PlayerState.loading / previewLoading (see player/progress.ts).
import type { ID } from '../../shared/types'

/**
 * Resolving a track went to the network: which provider it asks, and how. Only sent for real
 * requests (a cached, current source resolves without any step).
 */
export interface ResolveStep {
  trackId: ID
  /** Provider id, e.g. 'khinsider', 'youtube'. */
  provider: string
  /** Its display name (Provider.name), e.g. "Zophar's Domain". */
  providerName: string
  /** 'stream': the track's own page / API / extraction; 'search': a fallback search for the track on a site. */
  kind: 'stream' | 'search'
  /** 0..1 when the step can measure itself (e.g. a whole-track download), else null. */
  fraction: number | null
  /** Optional detail, e.g. "2.1 of 5.3 MB". */
  detail?: string | null
}

/** A tool the catalog needs is being installed (the one-time yt-dlp download). */
export interface ToolProgress {
  tool: 'yt-dlp'
  /** 0..1 of the download, or null before its size is known. */
  fraction: number | null
  detail?: string | null
  done: boolean
  /** It failed (with `done`): why. */
  error?: string | null
}
