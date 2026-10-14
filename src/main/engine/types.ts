// TypeScript view of the Rust audio engine (native/crates/ghost-node, napi-rs).
// The main process owns the queue and decides what plays; the engine only knows
// `current`, a preloaded `next` (for gapless) and an optional `preview`.
//
// Contract between the engine workstream and the player workstream: change additively.

export type EngineSource =
  | {
      kind: 'http'
      url: string
      headers?: Record<string, string>
      /** Stable key for the on-disk stream cache (e.g. 'khinsider:<album>/<file>'). */
      cacheKey: string
      formatHint?: string
    }
  | { kind: 'file'; path: string; formatHint?: string }

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
  download(downloadId: string, source: EngineSource, destPath: string, tags: TagInfo): void
  cancelDownload(downloadId: string): void
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
