// Fallback engine used when the native addon can't be loaded: no audio, simulated clock.
// Keeps the app usable (browsing, library) and makes failures visible instead of fatal.
import type { EngineBridge, EngineCacheProgress, EngineEvent, EngineLoadProgress, EnginePosition, EngineTrack } from './types'

export class NullEngine implements EngineBridge {
  private cb: (e: EngineEvent) => void = () => {}
  private current: EngineTrack | null = null
  private next: EngineTrack | null = null
  private posMs = 0
  private at = Date.now()
  private playing = false
  private timer: ReturnType<typeof setInterval>

  constructor(private readonly reason: string) {
    this.timer = setInterval(() => this.tick(), 250)
  }

  private emit(e: EngineEvent) {
    queueMicrotask(() => this.cb(e))
  }
  private live() {
    return this.playing ? this.posMs + (Date.now() - this.at) : this.posMs
  }
  private tick() {
    const dur = this.current?.expectedDurationMs
    if (!this.playing || !this.current || !dur || this.live() < dur) return
    if (this.next) {
      this.current = this.next
      this.next = null
      this.posMs = 0
      this.at = Date.now()
      this.emit({ type: 'advanced', id: this.current.id })
    } else {
      this.playing = false
      this.posMs = dur
      this.emit({ type: 'ended', id: this.current.id })
      this.emit({ type: 'state', state: 'idle', id: this.current.id })
    }
  }

  setCurrent(track: EngineTrack, startMs: number, autoplay: boolean) {
    this.current = track
    this.posMs = startMs
    this.at = Date.now()
    this.playing = autoplay
    this.emit({ type: 'error', id: track.id, message: `Audio engine unavailable: ${this.reason}`, recoverable: false })
    this.emit({ type: 'trackInfo', id: track.id, durationMs: track.expectedDurationMs ?? null, sampleRate: 44100, channels: 2, codec: 'none', bitrateKbps: null })
    this.emit({ type: 'state', state: autoplay ? 'playing' : 'paused', id: track.id })
  }
  setNext(track: EngineTrack | null) {
    this.next = track
  }
  play() {
    this.posMs = this.live()
    this.at = Date.now()
    this.playing = true
    this.emit({ type: 'state', state: 'playing', id: this.current?.id ?? null })
  }
  pause() {
    this.posMs = this.live()
    this.playing = false
    this.emit({ type: 'state', state: 'paused', id: this.current?.id ?? null })
  }
  stop() {
    this.playing = false
    this.current = null
    this.posMs = 0
    this.emit({ type: 'state', state: 'idle', id: null })
  }
  seek(ms: number) {
    this.posMs = ms
    this.at = Date.now()
  }
  setVolumeDb() {}
  setMuted() {}
  setLoop() {}
  setNormalization() {}
  setGapless() {}
  setCrossfade() {}
  setOverlayFilter() {}
  preview() {}
  stopPreview() {}
  position(): EnginePosition {
    return { id: this.current?.id ?? null, positionMs: this.live(), durationMs: this.current?.expectedDurationMs ?? null, playing: this.playing, at: Date.now() }
  }
  loadProgress(): EngineLoadProgress | null {
    return null
  }
  cacheProgress(): EngineCacheProgress | null {
    return null
  }
  listDevices() {
    return [{ id: 'default', name: 'System default', isDefault: true }]
  }
  setDevice() {}
  analyze() {}
  download(downloadId: string) {
    this.emit({ type: 'download', downloadId, status: 'error', bytes: 0, totalBytes: null, error: `Audio engine unavailable: ${this.reason}` })
  }
  cancelDownload() {}
  setVoiceMask() {}
  voiceCount() {
    return 0
  }
  analysisShmName() {
    return ''
  }
  onEvent(cb: (e: EngineEvent) => void) {
    this.cb = cb
  }
  shutdown() {
    clearInterval(this.timer)
  }
}
