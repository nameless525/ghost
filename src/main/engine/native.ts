// Loads the Rust audio engine (native/crates/ghost-node, napi-rs) into the main process and
// adapts it to EngineBridge. The renderer preload loads the same .node file, but only to map
// the shared-memory analysis region (see src/preload/analysis.ts).
//
// The addon is loaded with a runtime require on an absolute path, so electron-vite never tries
// to bundle it (and `.node` files are externalized in electron.vite.config.ts as well).
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  ArchiveListing,
  EngineBridge,
  EngineConfig,
  EngineDownloadOptions,
  EngineEvent,
  EnginePosition,
  EngineSource,
  EngineTrack,
  TagInfo
} from './types'

/** The `GhostEngine` class exported by the addon: the EngineBridge surface, 1:1, plus chip voice muting. */
export type NativeGhostEngine = EngineBridge & {
  inspectArchive(source: EngineSource): Promise<ArchiveListing>
  /** Mute chip voices on the playing tracks: bit i mutes voice i (see trackInfo `voiceNames`); 0 unmutes all. */
  setVoiceMask(mask: number): void
  /** Mutable voices of the current track (0 when unsupported or idle). */
  voiceCount(): number
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
  constructor(
    private readonly native: NativeGhostEngine,
    readonly addonPath: string
  ) {}

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
  setVoiceMask(mask: number): void {
    this.native.setVoiceMask(Number.isFinite(mask) && mask > 0 ? Math.floor(mask) : 0)
  }
  voiceCount(): number {
    return this.native.voiceCount()
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

/**
 * Load the native addon and start the engine. Throws a descriptive Error when the addon is
 * missing/incompatible or the engine can't start; callers fall back to NullEngine.
 */
export function loadEngine(config: EngineConfig): EngineBridge {
  const path = nativeAddonPath()
  const addon = loadAddon(path)
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
