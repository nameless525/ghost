// The renderer <-> main contract. The renderer talks only to `window.ghost: GhostAPI`.
// In Electron it is implemented by the preload bridge (IPC to src/main/services.ts);
// in the browser-only dev server it is implemented by src/renderer/src/mock.
//
// Contract rules: change additively. Every async method here must also be listed in
// API_METHODS below so the preload bridge and main-process router pick it up.

import type {
  Album,
  AlbumDetail,
  AnalysisFrame,
  AudioDevice,
  BrowsePage,
  BrowseQuery,
  CatalogStatus,
  DeepPartial,
  DownloadItem,
  DownloadTarget,
  ExternalAlbumHit,
  Game,
  GhostNotification,
  HistoryEntry,
  ID,
  LoopMode,
  PlayContext,
  PlayerState,
  PlayerStateEvent,
  Playlist,
  PlaylistDetail,
  RepeatMode,
  Settings,
  ShuffleMode,
  SourceStat,
  TaskProgress,
  TrackView
} from './types'

export interface CatalogAPI {
  status(): Promise<CatalogStatus>
  /** Re-crawl provider indexes in the background; progress via 'catalog:status'. */
  reindex(): Promise<void>
  browse(q: BrowseQuery): Promise<BrowsePage>
  /** Albums inside a carousel group, filtered by the same query text. */
  groupAlbums(groupKey: string, q: Pick<BrowseQuery, 'text' | 'group' | 'sort'>): Promise<Album[]>
  /** Album with its tracks. Fetches the track list from the provider on first access. */
  album(albumId: ID): Promise<AlbumDetail>
  game(gameId: ID): Promise<Game | null>
  tracks(trackIds: ID[]): Promise<TrackView[]>
  searchTracks(text: string, limit?: number): Promise<TrackView[]>
  /** Search external sources (YouTube, SoundCloud, Internet Archive, Bandcamp) for album-like results. */
  searchExternal(query: string, providers?: ExternalAlbumHit['provider'][]): Promise<ExternalAlbumHit[]>
  /** Import an external hit as a catalog album (tracks from playlist entries / chapters / files). */
  importExternal(hit: ExternalAlbumHit, opts?: { gameName?: string }): Promise<AlbumDetail>
  /** Pick a random group (and album) matching the query, for F2. */
  random(text?: string): Promise<{ groupKey: string; albumId: ID | null } | null>
  /** "Did you mean …?": game names close to a query that found nothing (typo-tolerant). */
  suggest(text: string, limit?: number): Promise<string[]>
  /** Albums per source and index freshness, for Settings → Sources. */
  sources(): Promise<SourceStat[]>
  /** Resolve these tracks' stream URLs ahead of a likely play (background priority, bounded). Fire-and-forget. */
  warmSources(trackIds: ID[]): void | Promise<void>
}

export interface PlayerAPI {
  getState(): Promise<PlayerState>
  playTracks(trackIds: ID[], startIndex?: number, context?: PlayContext): Promise<void>
  playAlbum(albumId: ID, startIndex?: number): Promise<void>
  playPlaylist(playlistId: ID, startIndex?: number): Promise<void>
  toggle(): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  seek(ms: number): Promise<void>
  /** 0..1 slider position. */
  setVolume(volume: number): Promise<void>
  setMuted(muted: boolean): Promise<void>
  setShuffle(mode: ShuffleMode): Promise<void>
  setRepeat(mode: RepeatMode): Promise<void>
  setLoopMode(mode: LoopMode): Promise<void>
  enqueue(trackIds: ID[], mode: 'next' | 'end'): Promise<void>
  removeFromQueue(uids: string[]): Promise<void>
  moveInQueue(from: number, to: number): Promise<void>
  clearQueue(): Promise<void>
  jumpTo(index: number): Promise<void>
  /**
   * Song-select style preview. One song is audible at a time: an audible queue pauses for the
   * preview and resumes when it ends, and playing the queue ends the preview. Resolves true once
   * the preview plays (false: superseded, or nothing playable).
   */
  preview(trackId: ID, startMs?: number): Promise<boolean>
  stopPreview(): Promise<void>
  /** Muffle the music (low-pass + duck) while a modal overlay is open. */
  setOverlayFilter(active: boolean): Promise<void>
  devices(): Promise<AudioDevice[]>
  /** Mute sound-chip voices of the current track: bit i mutes `PlayerState.voices.names[i]`; 0 unmutes all. */
  setVoiceMask(mask: number): Promise<void>
}

export interface PlaylistsAPI {
  list(): Promise<Playlist[]>
  get(id: ID): Promise<PlaylistDetail>
  create(name: string, opts?: { query?: string; trackIds?: ID[]; description?: string }): Promise<Playlist>
  update(id: ID, patch: { name?: string; description?: string | null; query?: string | null }): Promise<Playlist>
  delete(id: ID): Promise<void>
  duplicate(id: ID): Promise<Playlist>
  addTracks(id: ID, trackIds: ID[], position?: number): Promise<void>
  removeItems(id: ID, itemUids: string[]): Promise<void>
  moveItem(id: ID, from: number, to: number): Promise<void>
  /** Writes an .m3u8 and returns its path. */
  exportM3U(id: ID): Promise<string>
}

export interface LibraryAPI {
  playlists: PlaylistsAPI
  toggleLike(trackId: ID): Promise<boolean>
  liked(): Promise<TrackView[]>
  history(limit?: number): Promise<HistoryEntry[]>
  downloaded(): Promise<TrackView[]>
}

export interface DownloadsAPI {
  enqueue(target: DownloadTarget): Promise<void>
  list(): Promise<DownloadItem[]>
  cancel(id: ID): Promise<void>
  retry(id: ID): Promise<void>
  clearFinished(): Promise<void>
  reveal(id: ID): Promise<void>
  openFolder(): Promise<void>
}

export interface SettingsAPI {
  get(): Promise<Settings>
  set(patch: DeepPartial<Settings>): Promise<Settings>
  /** Opens a native folder picker; returns the chosen path or null. */
  pickFolder(): Promise<string | null>
}

export interface SystemAPI {
  openExternal(url: string): Promise<void>
  reveal(path: string): Promise<void>
  info(): Promise<{ platform: string; version: string; dataDir: string; mock: boolean }>
}

/** Events pushed from main to renderer. */
export interface GhostEvents {
  /** The queue is omitted when unchanged since the previous broadcast (see PlayerStateEvent). */
  'player:state': PlayerStateEvent
  'catalog:status': CatalogStatus
  'downloads:changed': DownloadItem[]
  'library:changed': { kind: 'playlists' | 'likes' | 'history' | 'downloaded'; id?: ID }
  'settings:changed': Settings
  /** The audio output devices changed (plugged / unplugged / new system default). */
  'player:devices': AudioDevice[]
  notify: GhostNotification
  /** A long task's progress (opening a chiptune set, an import, a folder scan…); see TaskProgress.key. */
  progress: TaskProgress
}
export type GhostEventName = keyof GhostEvents

export interface AnalysisAPI {
  /** Latest real-time analysis frame, or null when nothing is playing. Synchronous; call per rAF. */
  read(): AnalysisFrame | null
  /**
   * The same frame packed into one Float32Array (layout: PACKED_FRAME in types.ts), or null.
   * Cheaper across the context bridge than read(); optional (older preloads / the web mock).
   */
  readPacked?(): Float32Array | null
}

export interface GhostAPI {
  catalog: CatalogAPI
  player: PlayerAPI
  library: LibraryAPI
  downloads: DownloadsAPI
  settings: SettingsAPI
  system: SystemAPI
  analysis: AnalysisAPI
  on<E extends GhostEventName>(event: E, cb: (payload: GhostEvents[E]) => void): () => void
}

/** Every async (IPC-routed) method, as a dotted path into GhostAPI. */
export const API_METHODS = [
  'catalog.status',
  'catalog.reindex',
  'catalog.browse',
  'catalog.groupAlbums',
  'catalog.album',
  'catalog.game',
  'catalog.tracks',
  'catalog.searchTracks',
  'catalog.random',
  'catalog.suggest',
  'catalog.sources',
  'catalog.warmSources',
  'catalog.searchExternal',
  'catalog.importExternal',
  'player.getState',
  'player.playTracks',
  'player.playAlbum',
  'player.playPlaylist',
  'player.toggle',
  'player.play',
  'player.pause',
  'player.next',
  'player.prev',
  'player.seek',
  'player.setVolume',
  'player.setMuted',
  'player.setShuffle',
  'player.setRepeat',
  'player.setLoopMode',
  'player.enqueue',
  'player.removeFromQueue',
  'player.moveInQueue',
  'player.clearQueue',
  'player.jumpTo',
  'player.preview',
  'player.stopPreview',
  'player.setOverlayFilter',
  'player.devices',
  'player.setVoiceMask',
  'library.playlists.list',
  'library.playlists.get',
  'library.playlists.create',
  'library.playlists.update',
  'library.playlists.delete',
  'library.playlists.duplicate',
  'library.playlists.addTracks',
  'library.playlists.removeItems',
  'library.playlists.moveItem',
  'library.playlists.exportM3U',
  'library.toggleLike',
  'library.liked',
  'library.history',
  'library.downloaded',
  'downloads.enqueue',
  'downloads.list',
  'downloads.cancel',
  'downloads.retry',
  'downloads.clearFinished',
  'downloads.reveal',
  'downloads.openFolder',
  'settings.get',
  'settings.set',
  'settings.pickFolder',
  'system.openExternal',
  'system.reveal',
  'system.info'
] as const

export type ApiMethod = (typeof API_METHODS)[number]

/** The main-process implementation: GhostAPI minus the renderer-only parts. */
export type GhostServices = Omit<GhostAPI, 'on' | 'analysis'>

export const IPC_INVOKE = 'ghost:invoke'
export const IPC_EVENT = 'ghost:event'
