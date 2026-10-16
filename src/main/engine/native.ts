// Loads the Rust audio engine (native/crates/ghost-node, napi-rs) into the main process and
// adapts it to EngineBridge. The renderer preload loads the same .node file, but only to map
// the shared-memory analysis region (see src/preload/analysis.ts).
//
// The addon is loaded with a runtime require on an absolute path, so electron-vite never tries
// to bundle it (and `.node` files are externalized in electron.vite.config.ts as well).
//
// The same addon also carries the cover-art pipeline (`processArt` / `artAccent`, see the end of
// this file): decode, resize, encode and accent extraction on a small native thread pool. It
// works without the engine, and falls back to passing bytes through if the addon can't load.
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { perfMark } from '../perf'
import type {
  ArchiveListing,
  EngineBridge,
  EngineCacheProgress,
  EngineConfig,
  EngineDownloadOptions,
  EngineEvent,
  EngineLoadProgress,
  EnginePosition,
  EngineSource,
  EngineStats,
  EngineTrack,
  TagInfo
} from './types'

/** The `GhostEngine` class exported by the addon: the EngineBridge surface, 1:1, plus chip voice muting. */
export type NativeGhostEngine = EngineBridge & {
  inspectArchive(source: EngineSource): Promise<ArchiveListing>
  /** Mute chip voices on the playing tracks: bit i mutes voice i (see trackInfo `voiceNames`); 0n unmutes all. */
  setVoiceMask(mask: bigint): void
  /** Mutable voices of the current track (0 when unsupported or idle). */
  voiceCount(): number
  /** Absent in addons built before it existed. */
  setAnalysisDemand?(on: boolean): void
  /** Health counters (absent in addons built before it existed). */
  stats?(reset?: boolean): EngineStats
  /** Load / cache progress (absent in addons built before they existed). */
  loadProgress?(which: 'current' | 'preview'): EngineLoadProgress | null
  cacheProgress?(cacheKey: string): EngineCacheProgress | null
}

/** Read-only view of the analysis region (renderer side). Constructing one starts nothing. */
export interface NativeAnalysisReader {
  /** Latest frame, or null when nothing is playing / the region is stale. */
  read(): {
    bands: Float32Array
    waveform: Float32Array
    rms: number
    peak: number
    onset: number
    positionMs: number
    trackSeq: number
  } | null
  /** False once the publisher stopped (engine shut down/replaced): reopen the path. */
  alive(): boolean
}

export interface NativeAddon {
  GhostEngine: new (config: EngineConfig) => NativeGhostEngine
  AnalysisReader: new (path: string) => NativeAnalysisReader
  /** Absent in addons built before the art pipeline existed. */
  processArt?: (bytes: Buffer, opts?: ArtOptions) => Promise<ArtResult>
  artAccent?: (bytes: Buffer) => Promise<ArtRgb | null>
}

const nodeRequire = createRequire(import.meta.url)

/**
 * Absolute path of `ghost.node`.
 * - dev: `<repo>/native/dist/ghost.node` (built by `npm run build:native`)
 * - packaged: `<resources>/native/ghost.node` (copy native/dist/ghost.node there, unpacked)
 * `GHOST_NATIVE_ADDON` overrides both (testing).
 */
export function nativeAddonPath(): string {
  const override = process.env.GHOST_NATIVE_ADDON
  if (override) return override
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'ghost.node')
    : join(app.getAppPath(), 'native', 'dist', 'ghost.node')
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function loadAddon(path: string): NativeAddon {
  const platform = `${process.platform}-${process.arch}`
  if (!existsSync(path)) {
    throw new Error(
      app.isPackaged
        ? `GHOST audio engine is missing from the app bundle (${path}). Reinstall GHOST.`
        : `GHOST audio engine not built: ${path} does not exist. Run \`npm run build:native\`.`
    )
  }
  let addon: Partial<NativeAddon>
  try {
    addon = nodeRequire(path) as Partial<NativeAddon>
  } catch (e) {
    throw new Error(
      `GHOST audio engine failed to load from ${path} (${platform}): ${message(e)}. ` +
        (app.isPackaged ? 'Reinstall GHOST.' : 'Rebuild it for this platform with `npm run build:native`.'),
      { cause: e }
    )
  }
  if (typeof addon.GhostEngine !== 'function' || typeof addon.AnalysisReader !== 'function') {
    throw new Error(`${path} is not the GHOST engine addon (missing GhostEngine/AnalysisReader exports). Rebuild with \`npm run build:native\`.`)
  }
  return addon as NativeAddon
}

/** EngineBridge over the native GhostEngine. Keeps JS listener errors away from the addon. */
class NativeEngine implements EngineBridge {
  /**
   * Load / cache progress: present only when the addon has them, so callers can tell "no progress
   * reporting" (an addon built before it) from "nothing loading" (null).
   */
  readonly loadProgress?: (which: 'current' | 'preview') => EngineLoadProgress | null
  readonly cacheProgress?: (cacheKey: string) => EngineCacheProgress | null

  constructor(
    private readonly native: NativeGhostEngine,
    readonly addonPath: string
  ) {
    const load = native.loadProgress
    if (typeof load === 'function') this.loadProgress = (which) => load.call(native, which) ?? null
    const cache = native.cacheProgress
    if (typeof cache === 'function') this.cacheProgress = (cacheKey) => cache.call(native, cacheKey) ?? null
  }

  setCurrent(track: EngineTrack, startMs: number, autoplay: boolean): void {
    this.native.setCurrent(track, startMs, autoplay)
  }
  setNext(track: EngineTrack | null): void {
    this.native.setNext(track)
  }
  play(): void {
    this.native.play()
  }
  pause(): void {
    this.native.pause()
  }
  stop(): void {
    this.native.stop()
  }
  seek(ms: number): void {
    this.native.seek(ms)
  }
  setVolumeDb(db: number): void {
    this.native.setVolumeDb(db)
  }
  setMuted(muted: boolean): void {
    this.native.setMuted(muted)
  }
  setAnalysisDemand(on: boolean): void {
    this.native.setAnalysisDemand?.(on)
  }
  setLoop(mode: 'album' | 'endless' | 'custom', count: number, fadeSec: number): void {
    this.native.setLoop(mode, Math.max(0, Math.round(count)), fadeSec)
  }
  setNormalization(enabled: boolean, targetLufs: number, mode: 'auto' | 'track' | 'album'): void {
    this.native.setNormalization(enabled, targetLufs, mode)
  }
  setGapless(enabled: boolean): void {
    this.native.setGapless(enabled)
  }
  setCrossfade(sec: number): void {
    this.native.setCrossfade(sec)
  }
  setOverlayFilter(active: boolean): void {
    this.native.setOverlayFilter(active)
  }
  preview(track: EngineTrack, startMs: number): void {
    this.native.preview(track, startMs)
  }
  stopPreview(): void {
    this.native.stopPreview()
  }
  position(): EnginePosition {
    return this.native.position()
  }
  listDevices(): { id: string; name: string; isDefault: boolean }[] {
    return this.native.listDevices()
  }
  setDevice(id: string | null): void {
    this.native.setDevice(id)
  }
  analyze(id: string, source: EngineSource): void {
    this.native.analyze(id, source)
  }
  download(downloadId: string, source: EngineSource, destPath: string, tags: TagInfo, options?: EngineDownloadOptions): void {
    this.native.download(downloadId, source, destPath, tags, options)
  }
  inspectArchive(source: EngineSource): Promise<ArchiveListing> {
    return this.native.inspectArchive(source)
  }
  setVoiceMask(mask: bigint): void {
    // (The addon unmutes all for a bigint outside 64 bits; a number would make it throw.)
    this.native.setVoiceMask(typeof mask === 'bigint' ? mask : 0n)
  }
  voiceCount(): number {
    return this.native.voiceCount()
  }
  stats(reset = false): EngineStats {
    return this.native.stats?.(reset) ?? EMPTY_STATS
  }
  cancelDownload(downloadId: string): void {
    this.native.cancelDownload(downloadId)
  }
  analysisShmName(): string {
    return this.native.analysisShmName()
  }
  onEvent(cb: (e: EngineEvent) => void): void {
    // Events arrive on the main thread via an unref'd threadsafe function. A throwing listener
    // must not become an uncaught exception (that would take down the main process).
    this.native.onEvent((e: EngineEvent) => {
      try {
        cb(e)
      } catch (err) {
        console.error('[engine] event listener threw', e.type, err)
      }
    })
  }
  shutdown(): void {
    this.native.shutdown()
  }
}

const EMPTY_STATS: EngineStats = {
  underruns: 0,
  xruns: 0,
  callbacks: 0,
  callbackOverBudget: 0,
  callbackGaps: 0,
  callbackMaxUs: 0,
  callbackAvgUs: 0,
  callbackPeriodUs: 0,
  lowWaterMs: null,
  lowWaterEvents: 0,
  threads: []
}

/**
 * Load the native addon and start the engine. Throws a descriptive Error when the addon is
 * missing/incompatible or the engine can't start; callers fall back to NullEngine.
 */
export function loadEngine(config: EngineConfig): EngineBridge {
  const path = nativeAddonPath()
  const addon = loadAddon(path)
  perfMark('engine:addon-loaded')
  let native: NativeGhostEngine
  try {
    native = new addon.GhostEngine(config)
  } catch (e) {
    throw new Error(`GHOST audio engine failed to start: ${message(e)}`, { cause: e })
  }
  return new NativeEngine(native, path)
}

/**
 * `BrowserWindow.webPreferences.additionalArguments` for the renderer preload's analysis reader:
 * `[--ghost-native=<addon path>, --ghost-shm=<region path>]`. Empty for engines without a
 * shared-memory region (NullEngine), in which case the renderer simply gets no frames.
 */
export function preloadArgsFor(engine: EngineBridge): string[] {
  const shm = engine.analysisShmName()
  if (!shm) return []
  const addon = engine instanceof NativeEngine ? engine.addonPath : nativeAddonPath()
  return [`--ghost-native=${addon}`, `--ghost-shm=${shm}`]
}

// ---------------------------------------------------------------------------------------------
// Cover-art pipeline (independent of the engine)

export type ArtRgb = [number, number, number]

export interface ArtOptions {
  /** Largest output width in px (default: no limit). Never upscales. */
  maxWidth?: number
  /** Largest output height in px (default: no limit). */
  maxHeight?: number
  /** JPEG quality 1–100 (default 85). */
  quality?: number
  /** 'auto' (default): JPEG, or PNG when the image has real transparency. 'webp' is lossless. */
  format?: 'auto' | 'jpeg' | 'png' | 'webp'
  /** Return the input unchanged when it needs no resize and is at most this many bytes (default 0: always re-encode). */
  passthroughMaxBytes?: number
  /** Compute the accent colour (default true). */
  accent?: boolean
}

export interface ArtResult {
  data: Buffer
  width: number
  height: number
  mime: string
  /** Vibrant UI accent `[r, g, b]`; null for greyscale art, when not requested, or without the addon. */
  accent: ArtRgb | null
  /** `data` is the input, unchanged. */
  passthrough: boolean
  sourceWidth: number
  sourceHeight: number
  sourceMime: string
  /** Native processing time (ms, off the JS thread). */
  ms: number
}

type ArtFns = Required<Pick<NativeAddon, 'processArt' | 'artAccent'>>

let artFns: ArtFns | null | undefined

/** The addon's art functions, loaded once; null when the addon (or the functions) can't load. */
function artAddon(): ArtFns | null {
  if (artFns !== undefined) return artFns
  artFns = null
  try {
    const path = nativeAddonPath()
    if (existsSync(path)) {
      const addon = nodeRequire(path) as Partial<NativeAddon>
      if (typeof addon.processArt === 'function' && typeof addon.artAccent === 'function') {
        artFns = { processArt: addon.processArt, artAccent: addon.artAccent }
      } else console.warn(`[art] ${path} has no art pipeline; serving images unprocessed (run \`npm run build:native\`)`)
    } else console.warn(`[art] ${path} missing; serving images unprocessed (run \`npm run build:native\`)`)
  } catch (e) {
    console.warn(`[art] native art pipeline unavailable: ${message(e)}; serving images unprocessed`)
  }
  return artFns
}

/** True when `processArt` really resizes (the native addon loaded). */
export function artPipelineAvailable(): boolean {
  return artAddon() !== null
}

/** Mime type from magic bytes. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  const ascii = (a: number, b: number) => String.fromCharCode(...bytes.subarray(a, b))
  if (bytes.length >= 6 && ascii(0, 4) === 'GIF8') return 'image/gif'
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

/**
 * Decode, downscale (never up), re-encode and pick the accent colour, entirely on the addon's
 * art thread pool (never this thread, never libuv's pool). Rejects for corrupt / unsupported
 * images. Without the addon it resolves with the bytes unchanged and no accent.
 */
export function processArt(bytes: Buffer, opts: ArtOptions = {}): Promise<ArtResult> {
  const fns = artAddon()
  if (fns) return fns.processArt(bytes, opts)
  const mime = sniffImageMime(bytes) ?? 'application/octet-stream'
  return Promise.resolve({ data: bytes, width: 0, height: 0, mime, accent: null, passthrough: true, sourceWidth: 0, sourceHeight: 0, sourceMime: mime, ms: 0 })
}

/** Accent colour of an image, decoded off-thread; null for greyscale art or without the addon. */
export function artAccentOf(bytes: Buffer): Promise<ArtRgb | null> {
  const fns = artAddon()
  return fns ? fns.artAccent(bytes) : Promise.resolve(null)
}
