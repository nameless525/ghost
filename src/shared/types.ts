// Domain types shared by the main process, preload and renderer.
// This file is a contract between parallel workstreams: change it additively only.

export type ID = string

export type AlbumKind =
  | 'ost'
  | 'gamerip'
  | 'arrange'
  | 'remix'
  | 'single'
  | 'compilation'
  | 'other'

export type AudioFormat = 'mp3' | 'flac' | 'm4a' | 'aac' | 'ogg' | 'opus' | 'wav' | 'chip' | 'unknown'

export interface Game {
  id: ID
  name: string
  altNames: string[]
  year: number | null
  platforms: string[]
  franchise: string | null
  /** Portrait cover art URL. */
  cover: string | null
  /** Wide background art URL (SteamGridDB hero / IGDB artwork). */
  hero: string | null
  logo: string | null
  /** '#rrggbb' accent extracted from the art, if known. */
  accent: string | null
  albumCount: number
}

export interface Album {
  id: ID
  gameId: ID | null
  gameName: string | null
  title: string
  titleOriginal: string | null
  kind: AlbumKind
  year: number | null
  platforms: string[]
  catalogNo: string | null
  composers: string[]
  cover: string | null
  trackCount: number | null
  totalMs: number | null
  formats: AudioFormat[]
  /** Provider that owns this album record, e.g. 'khinsider'. */
  provider: string
  /** Provider-specific reference (e.g. the KHInsider album slug). */
  providerRef: string
  addedAt: number | null
}

export interface Track {
  id: ID
  albumId: ID
  disc: number
  number: number
  title: string
  titleOriginal: string | null
  durationMs: number | null
  composers: string[]
}

/** Offline analysis of a track, produced by the Rust engine and stored in the catalog DB. */
export interface TrackAnalysis {
  lufs: number | null
  truePeakDb: number | null
  bpm: number | null
  /** Beat times in seconds. Empty when tempo confidence is low. */
  beats: number[]
  downbeats: number[]
  /** High-energy "kiai" sections as [startSec, endSec]. */
  kiai: [number, number][]
  /** Normalised 0..1 energy curve across the whole track (~512 points). */
  energy: number[]
  /** 0..10 osu!-style intensity stars. */
  intensity: number | null
}

export interface TrackAnalysisSummary {
  bpm: number | null
  intensity: number | null
  lufs: number | null
}

export interface SourceSummary {
  provider: string
  format: AudioFormat
  lossless: boolean
  bitrateKbps: number | null
  /** 0..1 match confidence against the canonical track. */
  confidence: number
}

/** A track joined with everything the UI needs to render it. */
export interface TrackView extends Track {
  albumTitle: string
  albumKind: AlbumKind
  gameId: ID | null
  gameName: string | null
  year: number | null
  platforms: string[]
  cover: string | null
  hero: string | null
  accent: string | null
  liked: boolean
  downloaded: boolean
  source: SourceSummary | null
  analysis: TrackAnalysisSummary | null
}

/** Sources that can be searched on demand and imported ("Search online" in Browse). */
export type ExternalProviderId = 'youtube' | 'archive' | 'bandcamp' | 'soundcloud'

/** An album-like result from an external source (YouTube playlist / full-OST video, Internet Archive item, Bandcamp album, SoundCloud set). */
export interface ExternalAlbumHit {
  provider: ExternalProviderId
  /** Provider-specific reference (playlist id, video id, IA identifier, Bandcamp URL). */
  ref: string
  title: string
  /** Channel / uploader / artist. */
  subtitle: string | null
  cover: string | null
  trackCount: number | null
  totalMs: number | null
  url: string
  /** 0..1 how likely this is the official/complete soundtrack. */
  score: number
}

export interface AlbumDetail {
  album: Album
  game: Game | null
  tracks: TrackView[]
}

// ---------------------------------------------------------------------------
// Browse (song-select carousel)

export type GroupBy = 'game' | 'album' | 'composer' | 'franchise' | 'platform' | 'year'
export type SortBy = 'title' | 'year' | 'recent' | 'length' | 'intensity' | 'random'

export interface BrowseQuery {
  /** Free text plus filter syntax, see src/shared/search.ts. */
  text: string
  group: GroupBy
  sort: SortBy
  offset: number
  limit: number
}

/** A top-level carousel entry. With group=game this is a game; otherwise a named bucket. */
export interface BrowseGroup {
  key: string
  kind: GroupBy
  title: string
  subtitle: string | null
  cover: string | null
  hero: string | null
  accent: string | null
  year: number | null
  platforms: string[]
  albumCount: number
  gameId: ID | null
}

export interface BrowsePage {
  total: number
  offset: number
  groups: BrowseGroup[]
}

export interface CatalogStatus {
  indexing: boolean
  games: number
  albums: number
  tracks: number
  /** 0..1 while indexing, otherwise null. */
  progress: number | null
  lastIndexedAt: number | null
  message: string | null
  enrichment: { igdb: boolean; steamGridDb: boolean }
  /**
   * Increments whenever catalog data shown in Browse changed (index pages, album details, art,
   * enrichment). Refetch the visible page when it moves. Optional for older mocks.
   */
  revision?: number
  /** Every indexed source and what its crawl is doing (catalog activity UI). Optional for older mocks. */
  sources?: SourceIndexStatus[]
  /** A source is being added for the first time (one-time setup) rather than refreshed. */
  setup?: boolean
  /** Rough time left for everything queued or running (ms), when it can be estimated. */
  etaMs?: number | null
}

/** One indexed source's crawl, for the catalog activity UI. */
export interface SourceIndexStatus {
  id: string
  name: string
  /** waiting: queued behind other crawls; running; idle: index current; off: source disabled. */
  state: 'waiting' | 'running' | 'idle' | 'off'
  /** The queued / running crawl is this source's first complete read (one-time setup). */
  initial: boolean
  /** 0..1 while running. */
  progress: number | null
  /** Where the crawl is ("PS1 3/7"). */
  detail: string | null
  etaMs: number | null
  lastIndexedAt: number | null
  /** How often the source is re-read in the background. */
  refreshEveryMs: number
}

/** One catalog source in Settings → Sources: how much of the catalog it contributes. */
export interface SourceStat {
  /** Provider id ('khinsider', 'zophar', …). */
  id: string
  albums: number
  /** When its album index was last crawled completely (index sources only). */
  lastIndexedAt: number | null
  /** Its index is being crawled right now. */
  indexing: boolean
}

// ---------------------------------------------------------------------------
// Progress

/**
 * How far along a wait is, for progress bars (ui/ProgressBar). A step is either measured
 * (`fraction`), estimated (`expectMs`: the bar eases toward the end over about that long and never
 * reaches it until the step ends) or unknown (both null: an indeterminate sweep).
 */
export interface Progress {
  /** What is happening, e.g. "Getting the stream from YouTube", "Buffering". */
  label: string
  /** Secondary text, e.g. "1.2 of 4.5 MB", "3 of 4 sources". */
  detail?: string | null
  /** 0..1 within this step when measured, else null. */
  fraction: number | null
  /** Typical length of this step in ms when it can't be measured, else null. */
  expectMs: number | null
  /** Epoch ms (Date.now() domain) at which this step began. */
  since: number
  /** Where this step sits in the whole wait, as [from, to] within 0..1 (default [0, 1]), so bars stay monotonic across steps. */
  span?: [number, number]
  /** Identity of the whole wait: its steps share it, and a new one (e.g. a fallback to another source) restarts bars. */
  wait?: string
}

/** A long task's progress, pushed as the 'progress' event. Bars find theirs by `key`. */
export interface TaskProgress extends Progress {
  /**
   * What it belongs to: `album:<albumId>` (fetching an album's track list or chiptune set),
   * `import:<provider>:<ref>` (importing an external result), `scan` (adding local folders),
   * `tool:yt-dlp` (the one-time yt-dlp download).
   */
  key: string
  /** The task finished (or failed): bars complete and go. */
  done?: boolean
}

// ---------------------------------------------------------------------------
// Player

export type PlayStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'error'
export type ShuffleMode = 'off' | 'on' | 'smart'
export type RepeatMode = 'off' | 'all' | 'one'
/** How loop-aware sources (chiptunes, game-engine formats) end. */
export type LoopMode = 'album' | 'endless' | 'custom'

export interface QueueItem {
  /** Unique per queue entry (the same track may appear twice). */
  uid: string
  track: TrackView
}

export interface PlayContext {
  kind: 'album' | 'playlist' | 'search' | 'liked' | 'history' | 'downloaded' | 'queue' | 'radio'
  id: string | null
  title: string
}

export interface PlayerState {
  status: PlayStatus
  current: TrackView | null
  /** Full analysis (beats, kiai, energy) for the current track only. */
  currentAnalysis: TrackAnalysis | null
  positionMs: number
  /** Epoch ms (Date.now() domain) at which positionMs was sampled. Extrapolate while playing. */
  positionAt: number
  durationMs: number | null
  /** Slider position 0..1 (mapped to dB by the engine). */
  volume: number
  muted: boolean
  shuffle: ShuffleMode
  repeat: RepeatMode
  loopMode: LoopMode
  queue: QueueItem[]
  /** Index of the current item in `queue`, -1 if none. */
  queueIndex: number
  context: PlayContext | null
  preview: { track: TrackView; startedAt: number } | null
  /**
   * While the current track loads or buffers (status 'loading' / 'buffering'): what it waits on.
   * null otherwise. Optional for older mocks.
   */
  loading?: Progress | null
  /** A preview being fetched (before `preview` is set): its track and progress. */
  previewLoading?: (Progress & { trackId: ID }) | null
  error: string | null
  /**
   * Mutable sound-chip voices of the current source (chiptune rips: "Square 1", "Triangle", "Noise",
   * …), or null when it has none. Bit i of `mask` set = voice i is muted. Resets to 0 on track change.
   */
  voices: { names: string[]; mask: number } | null
  /**
   * Revision of `queue`: changes whenever the queue's order, membership or any item changes.
   * Lets a consumer of 'player:state' keep its copy of the queue (see PlayerStateEvent).
   */
  queueRev?: number
}

/**
 * Payload of the 'player:state' event: a PlayerState whose `queue` is only included when it
 * changed since the previous broadcast (the 1 Hz heartbeat, volume steps, seeks, previews…
 * leave it out). `queueRev` names the queue the state refers to: keep your previous copy when
 * `queue` is absent, and refetch player.getState() if your copy's revision doesn't match.
 * player.getState() always returns the full state (queue included).
 */
export interface PlayerStateEvent extends Omit<PlayerState, 'queue'> {
  queue?: QueueItem[]
}

export interface AudioDevice {
  id: string
  name: string
  isDefault: boolean
}

/**
 * Layout of AnalysisAPI.readPacked(): one Float32Array per frame instead of an object holding
 * two typed arrays (one copy across the context bridge, nothing else allocated).
 *   [rms, peak, onset, positionMs, trackSeq, numBands, waveformLen, ...bands, ...waveform]
 */
export const PACKED_FRAME = { RMS: 0, PEAK: 1, ONSET: 2, POSITION: 3, TRACK_SEQ: 4, NUM_BANDS: 5, WAVEFORM_LEN: 6, HEADER: 7 } as const

/** One real-time analysis frame (read synchronously every animation frame). */
export interface AnalysisFrame {
  /** 96 log-spaced bands, 30 Hz–16 kHz, smoothed, 0..1. */
  bands: Float32Array
  /** 512 mono samples, -1..1. */
  waveform: Float32Array
  rms: number
  peak: number
  /** Spectral-flux onset strength, roughly 0..1. */
  onset: number
  /** Audible position (latency compensated) this frame corresponds to. */
  positionMs: number
  /** Increments whenever the engine's current track changes. */
  trackSeq: number
}

// ---------------------------------------------------------------------------
// Library

export interface Playlist {
  id: ID
  name: string
  description: string | null
  kind: 'manual' | 'smart'
  /** Search query for smart playlists. */
  query: string | null
  trackCount: number
  durationMs: number
  /** Up to 4 cover URLs for the mosaic. */
  covers: string[]
  createdAt: number
  updatedAt: number
}

export interface PlaylistItem {
  /** Playlist item id (stable across reorders). */
  uid: string
  track: TrackView
  addedAt: number
}

export interface PlaylistDetail {
  playlist: Playlist
  items: PlaylistItem[]
}

export interface HistoryEntry {
  track: TrackView
  playedAt: number
  msPlayed: number
}

// ---------------------------------------------------------------------------
// Downloads

export type DownloadStatus = 'queued' | 'resolving' | 'downloading' | 'tagging' | 'done' | 'error' | 'canceled'

export interface DownloadItem {
  id: ID
  trackId: ID
  title: string
  gameName: string | null
  albumTitle: string
  cover: string | null
  status: DownloadStatus
  /** 0..1 */
  progress: number
  bytes: number
  totalBytes: number | null
  path: string | null
  error: string | null
  createdAt: number
}

export type DownloadTarget = { trackIds: ID[] } | { albumId: ID } | { playlistId: ID }

// ---------------------------------------------------------------------------
// Settings

export interface Settings {
  audio: {
    /** Output device id, or 'default' to follow the system default. */
    device: string
    normalization: { enabled: boolean; targetLufs: number; mode: 'auto' | 'track' | 'album' }
    gapless: boolean
    crossfadeSec: number
    loopMode: LoopMode
    loopCount: number
    fadeSec: number
    previewOnSelect: boolean
    uiSounds: boolean
    /** 0..1 */
    uiSoundVolume: number
  }
  sources: {
    order: string[]
    disabled: string[]
    quality: 'lossless' | 'high' | 'saver'
    /** Folders scanned by the local-files provider. */
    localFolders: string[]
    /**
     * Index joshw.info's chiptune rip listings. Off by default: that site's robots.txt asks
     * automated clients not to crawl it. vgmrips.net (which allows it) is always indexed.
     */
    crawlJoshw: boolean
  }
  library: {
    downloadDir: string
    namingTemplate: string
    cacheMaxGb: number
  }
  interface: {
    uiScale: number
    parallax: boolean
    blurQuality: 'low' | 'high'
    preferOriginalTitles: boolean
    /** 0..1 background dim on Browse. */
    backgroundDim: number
    visualizer: 'radial' | 'skyline' | 'scope'
    reduceMotion: boolean
    showFps: boolean
  }
  keys: {
    igdbClientId: string
    igdbClientSecret: string
    steamGridDbKey: string
  }
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }

// ---------------------------------------------------------------------------
// Notifications

export interface GhostNotification {
  id: string
  kind: 'info' | 'success' | 'error' | 'progress'
  title: string
  body?: string
  /** 0..1 for kind='progress'. */
  progress?: number
  /** Optional icon/cover URL. */
  image?: string | null
  /** A confirmation of something the user just did ("Added to queue"): toasted, but kept out of
   *  the notification centre and its unread count, which are for things they might have missed. */
  ephemeral?: boolean
}
