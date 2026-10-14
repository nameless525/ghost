// Test doubles shared by the services unit tests (player, library, downloads, settings).
// Not imported by production code.
import { DatabaseSync } from 'node:sqlite'
import type { GhostEventName, GhostEvents } from '../../shared/api'
import { defaultSettings } from '../../shared/defaults'
import type { Album, AlbumDetail, Game, ID, Settings, TrackAnalysis, TrackView } from '../../shared/types'
import type { CatalogService, ResolvedSource } from '../catalog'
import type { EngineBridge, EngineEvent, EnginePosition, EngineSource, EngineTrack, OfflineAnalysisResult, TagInfo } from '../engine/types'
import type { Broadcast } from '../ipc'

// ---------------------------------------------------------------------------
// broadcast

export interface RecordedEvent {
  event: GhostEventName
  payload: unknown
}

export function fakeBroadcast() {
  const events: RecordedEvent[] = []
  const broadcast = (<E extends GhostEventName>(event: E, payload: GhostEvents[E]) => {
    events.push({ event, payload: structuredClone(payload) })
  }) as Broadcast
  return {
    broadcast,
    events,
    of<E extends GhostEventName>(event: E): GhostEvents[E][] {
      return events.filter((e) => e.event === event).map((e) => e.payload as GhostEvents[E])
    },
    last<E extends GhostEventName>(event: E): GhostEvents[E] | undefined {
      const all = this.of(event)
      return all[all.length - 1]
    },
    clear() {
      events.length = 0
    }
  }
}

// ---------------------------------------------------------------------------
// engine

export interface EngineCall {
  method: string
  args: unknown[]
}

export class FakeEngine implements EngineBridge {
  calls: EngineCall[] = []
  current: EngineTrack | null = null
  next: EngineTrack | null = null
  previewing: { track: EngineTrack; startMs: number } | null = null
  playing = false
  posMs = 0
  /** When set, setCurrent / download throw this error. */
  throwOnSetCurrent: string | null = null
  devices = [
    { id: 'default', name: 'System default', isDefault: true },
    { id: 'dac', name: 'USB DAC', isDefault: false }
  ]
  private cb: (e: EngineEvent) => void = () => {}

  private rec(method: string, ...args: unknown[]) {
    this.calls.push({ method, args: structuredClone(args) })
  }
  callsOf(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args)
  }
  lastCall(method: string): unknown[] | undefined {
    const c = this.callsOf(method)
    return c[c.length - 1]
  }
  /** The engine-level `next`, as last set. */
  get nextId(): string | null {
    return this.next?.id ?? null
  }

  setCurrent(track: EngineTrack, startMs: number, autoplay: boolean) {
    this.rec('setCurrent', track, startMs, autoplay)
    if (this.throwOnSetCurrent) throw new Error(this.throwOnSetCurrent)
    this.current = track
    this.next = null
    this.posMs = startMs
    this.playing = autoplay
  }
  setNext(track: EngineTrack | null) {
    this.rec('setNext', track)
    this.next = track
  }
  play() {
    this.rec('play')
    this.playing = true
  }
  pause() {
    this.rec('pause')
    this.playing = false
  }
  stop() {
    this.rec('stop')
    this.playing = false
    this.current = null
    this.next = null
  }
  seek(ms: number) {
    this.rec('seek', ms)
    this.posMs = ms
  }
  setVolumeDb(db: number) {
    this.rec('setVolumeDb', db)
  }
  setMuted(m: boolean) {
    this.rec('setMuted', m)
  }
  setLoop(mode: 'album' | 'endless' | 'custom', count: number, fadeSec: number) {
    this.rec('setLoop', mode, count, fadeSec)
  }
  setNormalization(enabled: boolean, targetLufs: number, mode: 'auto' | 'track' | 'album') {
    this.rec('setNormalization', enabled, targetLufs, mode)
  }
  setGapless(enabled: boolean) {
    this.rec('setGapless', enabled)
  }
  setCrossfade(sec: number) {
    this.rec('setCrossfade', sec)
  }
  setOverlayFilter(active: boolean) {
    this.rec('setOverlayFilter', active)
  }
  preview(track: EngineTrack, startMs: number) {
    this.rec('preview', track, startMs)
    this.previewing = { track, startMs }
  }
  stopPreview() {
    this.rec('stopPreview')
    this.previewing = null
  }
  position(): EnginePosition {
    return { id: this.current?.id ?? null, positionMs: this.posMs, durationMs: this.current?.expectedDurationMs ?? null, playing: this.playing, at: Date.now() }
  }
  listDevices() {
    return this.devices
  }
  setDevice(id: string | null) {
    this.rec('setDevice', id)
  }
  analyze(id: string, source: EngineSource) {
    this.rec('analyze', id, source)
  }
  download(downloadId: string, source: EngineSource, destPath: string, tags: TagInfo) {
    this.rec('download', downloadId, source, destPath, tags)
  }
  cancelDownload(downloadId: string) {
    this.rec('cancelDownload', downloadId)
  }
  analysisShmName() {
    return ''
  }
  onEvent(cb: (e: EngineEvent) => void) {
    this.cb = cb
  }
  shutdown() {
    this.rec('shutdown')
  }

  // --- test helpers -----------------------------------------------------------
  emit(e: EngineEvent) {
    this.cb(e)
  }
  /** Simulate the current track running out: gapless advance into `next`, else 'ended'. */
  finishCurrent() {
    const cur = this.current
    if (!cur) throw new Error('nothing playing')
    if (this.next) {
      this.current = this.next
      this.next = null
      this.posMs = 0
      this.emit({ type: 'advanced', id: this.current.id })
    } else {
      this.playing = false
      this.emit({ type: 'ended', id: cur.id })
    }
  }
}

// ---------------------------------------------------------------------------
// catalog

export function makeTrack(id: ID, over: Partial<TrackView> = {}): TrackView {
  return {
    id,
    albumId: 'al1',
    disc: 1,
    number: 1,
    title: `Track ${id}`,
    titleOriginal: null,
    durationMs: 180_000,
    composers: ['Composer'],
    albumTitle: 'Album One',
    albumKind: 'ost',
    gameId: 'g1',
    gameName: 'Game One',
    year: 1995,
    platforms: ['SNES'],
    cover: `https://img.example/${over.albumId ?? 'al1'}.jpg`,
    hero: null,
    accent: null,
    liked: false,
    downloaded: false,
    source: null,
    analysis: null,
    ...over
  }
}

export function makeAlbum(id: ID, over: Partial<Album> = {}): Album {
  return {
    id,
    gameId: 'g1',
    gameName: 'Game One',
    title: `Album ${id}`,
    titleOriginal: null,
    kind: 'ost',
    year: 1995,
    platforms: ['SNES'],
    catalogNo: null,
    composers: ['Composer'],
    cover: `https://img.example/${id}.jpg`,
    trackCount: null,
    totalMs: null,
    formats: ['mp3'],
    provider: 'khinsider',
    providerRef: id,
    addedAt: null,
    ...over
  }
}

export function httpSource(trackId: ID, tag: string, over: Partial<ResolvedSource> = {}): ResolvedSource {
  return {
    provider: 'khinsider',
    source: { kind: 'http', url: `https://cdn.example/${trackId}/${tag}.mp3`, cacheKey: `${trackId}#${tag}` },
    format: 'mp3',
    lossless: false,
    bitrateKbps: 320,
    confidence: 1,
    sizeBytes: 5_000_000,
    ...over
  }
}

/** The catalog methods the services actually use (so additions to CatalogService don't break the fake). */
export type UsedCatalog = Pick<CatalogService, 'tracks' | 'album' | 'albumOf' | 'queryTrackIds' | 'resolveSources' | 'getAnalysis' | 'recordAnalysis' | 'markSourceFailed'>

export class FakeCatalog implements UsedCatalog {
  tracksById = new Map<ID, TrackView>()
  albums = new Map<ID, Album>()
  games = new Map<ID, Game>()
  analyses = new Map<ID, TrackAnalysis>()
  /** trackId -> sources; default: two http sources (a, b). */
  sources = new Map<ID, ResolvedSource[]>()
  /** trackIds whose resolution throws. */
  resolveErrors = new Map<ID, string>()
  resolveCalls: { trackId: ID; opts: unknown }[] = []
  failedMarks: { trackId: ID; cacheKey: string; reason: string }[] = []
  recorded: { trackId: ID; result: OfflineAnalysisResult }[] = []
  smart: (query: string) => ID[] = () => []
  /** Optional gate: resolution waits for this promise. */
  gate: Promise<void> | null = null

  addTracks(...tracks: TrackView[]): this {
    for (const t of tracks) {
      this.tracksById.set(t.id, t)
      if (!this.albums.has(t.albumId)) this.albums.set(t.albumId, makeAlbum(t.albumId, { title: t.albumTitle, gameId: t.gameId, gameName: t.gameName }))
    }
    return this
  }

  start() {}
  stop() {}
  async status() {
    return { indexing: false, games: 0, albums: 0, tracks: this.tracksById.size, progress: null, lastIndexedAt: null, message: null, enrichment: { igdb: false, steamGridDb: false } }
  }
  async reindex() {}
  async browse() {
    return { total: 0, offset: 0, groups: [] }
  }
  async groupAlbums() {
    return []
  }
  async album(albumId: ID): Promise<AlbumDetail> {
    const album = this.albums.get(albumId)
    if (!album) throw new Error(`no album ${albumId}`)
    const tracks = [...this.tracksById.values()].filter((t) => t.albumId === albumId).sort((a, b) => a.disc - b.disc || a.number - b.number)
    return { album, game: (album.gameId && this.games.get(album.gameId)) || null, tracks: tracks.map((t) => ({ ...t })) }
  }
  async game(id: ID) {
    return this.games.get(id) ?? null
  }
  async tracks(ids: ID[]) {
    return ids.map((id) => this.tracksById.get(id)).filter((t): t is TrackView => !!t).map((t) => ({ ...t }))
  }
  async searchTracks() {
    return []
  }
  async random() {
    return null
  }
  getAnalysis(trackId: ID) {
    return this.analyses.get(trackId) ?? null
  }
  recordAnalysis(trackId: ID, result: OfflineAnalysisResult) {
    this.recorded.push({ trackId, result })
    this.analyses.set(trackId, {
      lufs: result.integratedLufs,
      truePeakDb: result.truePeakDb,
      bpm: result.bpm,
      beats: result.beats,
      downbeats: result.downbeats,
      kiai: result.kiai,
      energy: result.energy,
      intensity: result.intensity
    })
  }
  async resolveSources(trackId: ID, opts?: { quality?: Settings['sources']['quality']; exclude?: string[] }) {
    this.resolveCalls.push({ trackId, opts })
    if (this.gate) await this.gate
    const err = this.resolveErrors.get(trackId)
    if (err) throw new Error(err)
    const list = this.sources.get(trackId) ?? [httpSource(trackId, 'a'), httpSource(trackId, 'b')]
    const ex = new Set(opts?.exclude ?? [])
    return list.filter((s) => !(s.source.kind === 'http' && ex.has(s.source.cacheKey)))
  }
  markSourceFailed(trackId: ID, cacheKey: string, reason: string) {
    this.failedMarks.push({ trackId, cacheKey, reason })
  }
  async albumOf(trackId: ID) {
    const t = this.tracksById.get(trackId)
    const album = t ? this.albums.get(t.albumId) : undefined
    if (!album) return null
    return { album, game: (album.gameId && this.games.get(album.gameId)) || null }
  }
  async queryTrackIds(query: string) {
    return this.smart(query)
  }
}

// ---------------------------------------------------------------------------
// misc

export function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  return db
}

export function testSettings(over: (s: Settings) => void = () => {}): Settings {
  const s = defaultSettings('/music/GHOST')
  over(s)
  return s
}

/** Let pending promise chains run (resolution is async even when instant). */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setImmediate(r))
}
