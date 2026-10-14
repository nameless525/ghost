// TypeScript view of the Rust audio engine (native/crates/ghost-node, napi-rs).
// The main process owns the queue and decides what plays; the engine only knows
// `current`, a preloaded `next` (for gapless) and an optional `preview`.
//
// Contract between the engine workstream and the player workstream: change additively.

/** Optional addressing inside a source, shared by both kinds. */
export interface EngineSourceExtras {
  /** Play only [clipStartMs, clipEndMs) of the stream (e.g. one chapter of a full-OST video). */
  clipStartMs?: number
  clipEndMs?: number
  /** Sub-song index for multi-song chiptune files (NSF, GBS, HES, KSS, …). 0-based. */
  subsong?: number
  /** Path of the entry to play inside an archive source (.zip / .7z rip sets). */
  archiveEntry?: string
}

export type EngineSource =
  | ({
      kind: 'http'
      url: string
      headers?: Record<string, string>
      /** Stable key for the on-disk stream cache (e.g. 'khinsider:<album>/<file>'). */
      cacheKey: string
      formatHint?: string
    } & EngineSourceExtras)
  | ({ kind: 'file'; path: string; formatHint?: string } & EngineSourceExtras)

export interface EngineTrack {
  /** Opaque id chosen by the main process (we use the queue item uid). */
  id: string
  source: EngineSource
  /** Measured integrated loudness if known; the engine normalises toward the target. */
  lufs?: number | null
  /** Album loudness, used in album-gain mode. */
  albumLufs?: number | null
  /** Tracks sharing an albumKey that play consecutively are treated as one album (no crossfade, album gain). */
  albumKey?: string | null
  expectedDurationMs?: number | null
}

export type EnginePlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering'

export interface EngineTrackInfo {
  id: string
  durationMs: number | null
  sampleRate: number
  channels: number
  codec: string
  bitrateKbps: number | null
  /** Tags from the file itself (chip / tracker formats), when known. */
  title?: string
  artist?: string
  album?: string
  /** Sub-songs in the file and the one playing (0-based), for multi-song chip files. */
  subsongCount?: number
  subsong?: number
  /** Loop region in source time, when the format has loop points. */
  loopStartMs?: number
  loopEndMs?: number
  /** Mutable sound-chip voices (see `EngineBridge.setVoiceMask`); absent when there are none. */
  voiceCount?: number
  voiceNames?: string[]
}

export interface OfflineAnalysisResult {
  integratedLufs: number | null
  loudnessRange: number | null
  truePeakDb: number | null
  bpm: number | null
  bpmConfidence: number
  beats: number[]
  downbeats: number[]
  kiai: [number, number][]
  energy: number[]
  intensity: number | null
  durationMs: number
}

export type EngineEvent =
  | { type: 'state'; state: EnginePlaybackState; id: string | null }
  /** The engine moved gaplessly into the preloaded `next` track. */
  | { type: 'advanced'; id: string }
  /** The current track finished and there was no `next`. */
  | { type: 'ended'; id: string }
  | ({ type: 'trackInfo' } & EngineTrackInfo)
  | { type: 'buffering'; id: string; buffering: boolean }
  | { type: 'error'; id: string | null; message: string; recoverable: boolean }
  | { type: 'analysis'; id: string; cacheKey: string | null; result: OfflineAnalysisResult }
  | { type: 'cacheComplete'; id: string; cacheKey: string; path: string; bytes: number }
  | {
      type: 'download'
      downloadId: string
      status: 'progress' | 'done' | 'error' | 'canceled'
      bytes: number
      totalBytes: number | null
      path?: string
      error?: string
    }
  | { type: 'devices'; devices: { id: string; name: string; isDefault: boolean }[] }
  | { type: 'previewEnded' }

export interface EnginePosition {
  id: string | null
  /** Audible position (output latency compensated). */
  positionMs: number
  durationMs: number | null
  playing: boolean
  /** Epoch ms when sampled. */
  at: number
}

export interface TagInfo {
  title: string
  album: string
  albumArtist: string | null
  artist: string | null
  composer: string | null
  trackNumber: number | null
  trackTotal: number | null
  discNumber: number | null
  year: number | null
  genre: string | null
  comment: string | null
  /** Cover image to embed (downloaded by the engine). */
  coverUrl: string | null
  replayGainTrackDb: number | null
  replayGainTrackPeak: number | null
}

/** Options for `EngineBridge.download`. */
export interface EngineDownloadOptions {
  /**
   * `true`: decode and render to FLAC with the current loop settings (Endless renders as Album:
   * 2 loops + 10 s fade). `false`: save the stream as-is (for an archive entry, the entry's bytes).
   * Default: render chip / tracker / game-engine formats and clips, copy everything else.
   */
  renderFlac?: boolean
}

/** Contents of an archive source (`EngineBridge.inspectArchive`). */
export interface ArchiveListing {
  /** Every file in the archive (`/`-separated paths, uncompressed sizes). */
  entries: { path: string; size: number }[]
  /**
   * Text of the `.m3u` / `.m3u8` / `.txt` files, decoded (UTF-8, Shift-JIS or Windows-1252).
   * joshw / Zophar sets ship NEZPlug playlists:
   * `file.nsf::NSF,track,title,length,loop,fade` (`$`-prefixed tracks are hex and 0-based, decimal
   * ones 1-based). The engine applies a matching line's timing on its own when playing that
   * archive entry + subsong.
   */
  playlists: { path: string; text: string }[]
}

/** `EngineBridge.stats()`: audio robustness counters since the last reset. */
export interface EngineStats {
  /** The playing track ran out of decoded audio mid-playback (audible dropout / rebuffering). */
  underruns: number
  /** Device-reported overloads (CoreAudio processor overload). */
  xruns: number
  /** Output (device) callbacks rendered. */
  callbacks: number
  /** Callbacks that took more than half of their buffer period. */
  callbackOverBudget: number
  /** Callbacks that started more than 1.5 buffer periods after the previous one. */
  callbackGaps: number
  callbackMaxUs: number
  callbackAvgUs: number
  /** Device buffer period (µs). */
  callbackPeriodUs: number
  /** Least decoded audio buffered ahead of the playing track (ms); null until something played. */
  lowWaterMs: number | null
  /** Times the playing track had less than 500 ms decoded ahead. */
  lowWaterEvents: number
  /** CPU time per thread class (engine threads, the device IO thread, the art pool). */
  threads: { name: string; count: number; cpuMs: number }[]
}

export interface EngineConfig {
  cacheDir: string
  cacheMaxBytes: number
  userAgent: string
}

export interface EngineBridge {
  setCurrent(track: EngineTrack, startMs: number, autoplay: boolean): void
  setNext(track: EngineTrack | null): void
  play(): void
  pause(): void
  stop(): void
  seek(ms: number): void
  setVolumeDb(db: number): void
  setMuted(muted: boolean): void
  setLoop(mode: 'album' | 'endless' | 'custom', count: number, fadeSec: number): void
  setNormalization(enabled: boolean, targetLufs: number, mode: 'auto' | 'track' | 'album'): void
  setGapless(enabled: boolean): void
  setCrossfade(sec: number): void
  setOverlayFilter(active: boolean): void
  preview(track: EngineTrack, startMs: number): void
  stopPreview(): void
  position(): EnginePosition
  listDevices(): { id: string; name: string; isDefault: boolean }[]
  setDevice(id: string | null): void
  /** Decode the full (cached) source and emit an 'analysis' event. */
  analyze(id: string, source: EngineSource): void
  /**
   * Save `source` to `destPath`, tagged. Chip / tracker / game-engine formats and clips are rendered
   * to FLAC by default (see `EngineDownloadOptions`); the file then gets a `.flac` extension, and the
   * 'done' event's `path` is the final file.
   */
  download(downloadId: string, source: EngineSource, destPath: string, tags: TagInfo, options?: EngineDownloadOptions): void
  cancelDownload(downloadId: string): void
  /**
   * List a `.zip` / `.7z` source (fetched through the stream cache) and return the text of its
   * playlists. Rejects if it isn't an archive or can't be fetched. Optional: engines without archive
   * support (the null engine) don't have it.
   */
  inspectArchive?(source: EngineSource): Promise<ArchiveListing>
  /**
   * Mute sound-chip voices (libgme / libopenmpt sources): bit i mutes voice i of the trackInfo
   * `voiceNames`; 0 unmutes all. Global: it persists across tracks until changed. Optional
   * (engines without chip voices don't have it).
   */
  setVoiceMask?(mask: number): void
  /** Mutable voices of the current track (0 when unsupported or idle). */
  voiceCount?(): number
  /**
   * Playback health counters and engine CPU per thread class (see `EngineStats`). Counters
   * accumulate until read with `reset = true`. Optional: the null engine has none.
   */
  stats?(reset?: boolean): EngineStats
  /** Name of the shared-memory region the renderer maps for analysis frames. */
  analysisShmName(): string
  onEvent(cb: (e: EngineEvent) => void): void
  shutdown(): void
}

/** Convert a 0..1 volume slider position to dB on a perceptual curve (-60 dB..0 dB, 0 => -inf). */
export function sliderToDb(v: number): number {
  if (v <= 0.0001) return -120
  const c = Math.min(1, Math.max(0, v))
  return 60 * (Math.pow(c, 0.5) - 1)
}
