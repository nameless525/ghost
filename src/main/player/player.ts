// The player: source of truth for PlayerState. Owns the queue and decides what plays; the
// engine only knows `current`, a preloaded `next` (gapless) and an optional `preview`.
import { randomUUID } from 'node:crypto'
import type { PlayerAPI } from '../../shared/api'
import type {
  AudioDevice,
  ID,
  LoopMode,
  PlayContext,
  PlayerState,
  PlayStatus,
  PlaylistDetail,
  QueueItem,
  RepeatMode,
  Settings,
  ShuffleMode,
  SourceSummary,
  TrackAnalysis,
  TrackAnalysisSummary,
  TrackView
} from '../../shared/types'
import type { CatalogService, ResolvedSource } from '../catalog'
import type { EngineBridge, EngineEvent, EnginePlaybackState, EngineSource, EngineTrack, OfflineAnalysisResult } from '../engine/types'
import { sliderToDb } from '../engine/types'
import type { Broadcast } from '../ipc'
import type { SessionData, SessionStore } from './session'
import { fisherYates, smartShuffle, type Rng } from './shuffle'

export type PlayerCatalog = Pick<CatalogService, 'album' | 'resolveSources' | 'getAnalysis' | 'recordAnalysis' | 'markSourceFailed'>

export interface PlayerLibrary {
  decorateOne(t: TrackView): TrackView
  fetchTracks(ids: ID[]): Promise<TrackView[]>
  /** Local file of a downloaded track, only if it still exists. */
  downloadedPath(trackId: ID): string | null
  recordPlay(trackId: ID, playedAt: number, msPlayed: number): number
  updatePlay(rowId: number, msPlayed: number): void
}

export interface PlayerDeps {
  engine: EngineBridge
  catalog: PlayerCatalog
  library: PlayerLibrary
  playlists: { get(id: ID): Promise<PlaylistDetail> }
  getSettings: () => Settings
  /** Persist the loop mode (it lives in settings.audio.loopMode). */
  setLoopMode: (mode: LoopMode) => void
  broadcast: Broadcast
  session?: SessionStore
  now?: () => number
  random?: Rng
  /** Heartbeat period while playing; 0 disables the timer (tests call tick()). */
  heartbeatMs?: number
  sessionDebounceMs?: number
}

/** Restart instead of going back when prev() is pressed past this point. */
export const PREV_RESTART_MS = 3000
/** History: a play counts after 30 s or half the track, whichever comes first. */
export const HISTORY_MIN_MS = 30000
/** Stop auto-skipping after this many tracks in a row failed to play. */
export const MAX_FAIL_STREAK = 8

interface Attempt {
  /** Engine id: the queue item uid (or a preview id). */
  id: string
  trackId: ID
  track: TrackView
  sources: ResolvedSource[]
  /** Index of the source currently handed to the engine. */
  srcIdx: number
  /** Whether remote sources have been resolved (local downloads are tried first without the network). */
  remoteResolved: boolean
  lastError: string | null
}

interface Current extends Attempt {
  seq: number
  autoplay: boolean
  /** The engine has this track as its current one. */
  loaded: boolean
  startMs: number
}

interface Preload extends Attempt {
  seq: number
  /** engine.setNext() has been called with this item. */
  armed: boolean
}

interface Preview extends Attempt {
  seq: number
  startMs: number
}

interface PlayAccount {
  trackId: ID
  durationMs: number | null
  accumMs: number
  since: number | null
  rowId: number | null
}

export const sourceKey = (s: EngineSource): string => (s.kind === 'http' ? s.cacheKey : `file:${s.path}`)

const LOSSLESS_EXT = new Set(['flac', 'wav', 'aif', 'aiff', 'alac'])
const FORMAT_BY_EXT: Record<string, ResolvedSource['format']> = { mp3: 'mp3', flac: 'flac', m4a: 'm4a', mp4: 'm4a', aac: 'aac', ogg: 'ogg', oga: 'ogg', opus: 'opus', webm: 'opus', wav: 'wav' }

export function localSource(path: string): ResolvedSource {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(path)?.[1]?.toLowerCase() ?? ''
  return {
    provider: 'download',
    source: { kind: 'file', path, formatHint: ext || undefined },
    format: FORMAT_BY_EXT[ext] ?? (ext ? 'chip' : 'unknown'),
    lossless: LOSSLESS_EXT.has(ext),
    bitrateKbps: null,
    confidence: 1,
    sizeBytes: null
  }
}

const summaryOf = (s: ResolvedSource): SourceSummary => ({ provider: s.provider, format: s.format, lossless: s.lossless, bitrateKbps: s.bitrateKbps, confidence: s.confidence })

export function analysisFromResult(r: OfflineAnalysisResult): TrackAnalysis {
  return {
    lufs: r.integratedLufs,
    truePeakDb: r.truePeakDb,
    bpm: r.bpm,
    beats: r.beats,
    downbeats: r.downbeats,
    kiai: r.kiai,
    energy: r.energy,
    intensity: r.intensity
  }
}

const groupOf = (t: TrackView): string => (t.gameId ? `g:${t.gameId}` : `a:${t.albumId}`)

/** Duration-weighted power mean of track loudness values (album loudness estimate). */
export function combineLufs(values: { lufs: number; durationMs: number | null }[]): number | null {
  if (!values.length) return null
  let num = 0
  let den = 0
  for (const v of values) {
    const w = v.durationMs && v.durationMs > 0 ? v.durationMs : 1
    num += w * Math.pow(10, v.lufs / 10)
    den += w
  }
  return 10 * Math.log10(num / den)
}

class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super()
  }
  override set(k: K, v: V): this {
    if (this.has(k)) this.delete(k)
    super.set(k, v)
    while (this.size > this.max) this.delete(this.keys().next().value as K)
    return this
  }
}

export class Player implements PlayerAPI {
  private readonly engine: EngineBridge
  private readonly catalog: PlayerCatalog
  private readonly library: PlayerLibrary
  private readonly deps: PlayerDeps
  private readonly now: () => number
  private readonly rng: Rng

  private s: Omit<PlayerState, 'current'>
  /** Pre-shuffle order of queue uids while shuffle is on. */
  private originalOrder: string[] | null = null

  private cur: Current | null = null
  private pre: Preload | null = null
  private pv: Preview | null = null
  private loadSeq = 0
  private preSeq = 0
  private pvSeq = 0
  private engineState: EnginePlaybackState = 'idle'
  private seekHold: { ms: number; at: number } | null = null

  /** Cache keys that failed this session, per track (passed to resolveSources as `exclude`). */
  private failed = new Map<ID, Set<string>>()
  private failStreak = new Set<string>()
  private streakNotice = ''
  private uidTrack = new BoundedMap<string, ID>(512)
  private infoDuration = new BoundedMap<string, number>(64)
  private account: PlayAccount | null = null
  private lastNotice = new Map<string, number>()

  private emitQueued = false
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private lastSaveAt = 0
  private mutations = 0
  private pending = new Set<Promise<unknown>>()
  private disposed = false

  constructor(deps: PlayerDeps) {
    this.deps = deps
    this.engine = deps.engine
    this.catalog = deps.catalog
    this.library = deps.library
    this.now = deps.now ?? Date.now
    this.rng = deps.random ?? Math.random
    this.s = {
      status: 'idle',
      currentAnalysis: null,
      positionMs: 0,
      positionAt: this.now(),
      durationMs: null,
      volume: 0.8,
      muted: false,
      shuffle: 'off',
      repeat: 'off',
      loopMode: deps.getSettings().audio.loopMode,
      queue: [],
      queueIndex: -1,
      context: null,
      preview: null,
      error: null
    }
    const hb = deps.heartbeatMs ?? 1000
    if (hb > 0) {
      this.heartbeat = setInterval(() => this.tick(), hb)
      this.heartbeat.unref?.()
    }
  }

  // ===========================================================================
  // State & broadcasting

  private item(i = this.s.queueIndex): QueueItem | null {
    return this.s.queue[i] ?? null
  }

  private refreshPosition(): void {
    if (this.cur?.loaded) {
      let p
      try {
        p = this.engine.position()
      } catch {
        return
      }
      if (p.id === this.cur.id) {
        const hold = this.seekHold
        if (hold) {
          // The engine may report the pre-seek position for a moment; don't let the UI jump back.
          const elapsed = this.now() - hold.at
          const expected = hold.ms + (this.s.status === 'playing' ? elapsed : 0)
          if (elapsed < 1500 && Math.abs(p.positionMs - expected) > 750) {
            this.s.positionMs = hold.ms
            this.s.positionAt = hold.at
            return
          }
          this.seekHold = null
        }
        const dur = this.s.durationMs
        this.s.positionMs = Math.max(0, dur ? Math.min(p.positionMs, dur) : p.positionMs)
        this.s.positionAt = p.at
        return
      }
    }
    if (this.s.status !== 'playing') this.s.positionAt = this.now()
  }

  /** A fresh PlayerState snapshot. */
  snapshot(): PlayerState {
    this.refreshPosition()
    return { ...this.s, current: this.item()?.track ?? null, queue: [...this.s.queue] }
  }

  private changed(): void {
    if (this.emitQueued || this.disposed) return
    this.emitQueued = true
    queueMicrotask(() => {
      this.emitQueued = false
      if (!this.disposed) this.deps.broadcast('player:state', this.snapshot())
    })
  }

  private setStatus(st: PlayStatus): void {
    if (this.s.status === st) return
    const t = this.now()
    const a = this.account
    if (a) {
      if (st === 'playing' && a.since === null) a.since = t
      else if (st !== 'playing' && a.since !== null) {
        a.accumMs += t - a.since
        a.since = null
      }
    }
    this.s.status = st
    this.checkPlay()
  }

  private notify(kind: 'info' | 'success' | 'error', title: string, body?: string, image?: string | null, dedupeKey?: string, id?: string): void {
    if (dedupeKey) {
      const last = this.lastNotice.get(dedupeKey) ?? 0
      if (this.now() - last < 60000) return
      this.lastNotice.set(dedupeKey, this.now())
    }
    this.deps.broadcast('notify', { id: id ?? `player-${randomUUID()}`, kind, title, body, image: image ?? null })
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const wrapped = p.catch((e) => {
      console.error('[player]', e)
    }) as Promise<T>
    this.pending.add(wrapped)
    void wrapped.finally(() => this.pending.delete(wrapped))
    return wrapped
  }

  /** Resolves once all in-flight loads/preloads have settled (tests, shutdown). */
  async settled(): Promise<void> {
    for (let i = 0; i < 50 && this.pending.size; i++) await Promise.all([...this.pending])
  }

  // ===========================================================================
  // History accounting

  private beginPlay(item: QueueItem): void {
    this.finishPlay()
    this.account = {
      trackId: item.track.id,
      durationMs: item.track.durationMs,
      accumMs: 0,
      since: this.s.status === 'playing' ? this.now() : null,
      rowId: null
    }
  }

  private playedMs(a: PlayAccount): number {
    return a.accumMs + (a.since !== null ? this.now() - a.since : 0)
  }

  private checkPlay(): void {
    const a = this.account
    if (!a || a.rowId !== null) return
    const played = this.playedMs(a)
    const dur = (this.cur?.trackId === a.trackId ? this.s.durationMs : null) ?? a.durationMs
    const threshold = dur && dur > 0 ? Math.min(HISTORY_MIN_MS, dur * 0.5) : HISTORY_MIN_MS
    if (played >= threshold) {
      try {
        a.rowId = this.library.recordPlay(a.trackId, this.now(), played)
      } catch (e) {
        console.error('[player] history write failed:', e)
        a.rowId = -1
      }
    }
  }

  private finishPlay(): void {
    const a = this.account
    if (!a) return
    this.checkPlay()
    if (a.rowId !== null && a.rowId >= 0) {
      try {
        this.library.updatePlay(a.rowId, this.playedMs(a))
      } catch (e) {
        console.error('[player] history update failed:', e)
      }
    }
    this.account = null
  }

  // ===========================================================================
  // Sources

  private failedSet(trackId: ID): Set<string> {
    let s = this.failed.get(trackId)
    if (!s) this.failed.set(trackId, (s = new Set()))
    return s
  }

  private async resolveRemote(trackId: ID): Promise<ResolvedSource[]> {
    const exclude = [...(this.failed.get(trackId) ?? [])]
    const list = await this.catalog.resolveSources(trackId, { quality: this.deps.getSettings().sources.quality, exclude })
    const bad = new Set(exclude)
    return list.filter((s) => !bad.has(sourceKey(s.source)))
  }

  /** Downloaded file first (no network); otherwise the catalog's ranked sources. */
  private async resolveInitial(trackId: ID): Promise<{ sources: ResolvedSource[]; remoteResolved: boolean }> {
    const local = this.library.downloadedPath(trackId)
    if (local && !this.failed.get(trackId)?.has(sourceKey(localSource(local).source))) return { sources: [localSource(local)], remoteResolved: false }
    return { sources: await this.resolveRemote(trackId), remoteResolved: true }
  }

  /** Advance `a` to its next usable source, resolving remote sources lazily. */
  private async nextSource(a: Attempt): Promise<ResolvedSource | null> {
    for (;;) {
      a.srcIdx++
      const bad = this.failed.get(a.trackId)
      while (a.srcIdx < a.sources.length && bad?.has(sourceKey(a.sources[a.srcIdx].source))) a.srcIdx++
      if (a.srcIdx < a.sources.length) return a.sources[a.srcIdx]
      if (a.remoteResolved) return null
      a.remoteResolved = true
      try {
        const more = await this.resolveRemote(a.trackId)
        const have = new Set(a.sources.map((s) => sourceKey(s.source)))
        a.sources.push(...more.filter((s) => !have.has(sourceKey(s.source))))
      } catch (e) {
        a.lastError = (e as Error)?.message ?? String(e)
      }
      a.srcIdx = Math.min(a.srcIdx, a.sources.length) - 1
    }
  }

  private albumLufs(track: TrackView): number | null {
    const vals: { lufs: number; durationMs: number | null }[] = []
    const seen = new Set<ID>()
    for (const q of this.s.queue) {
      const t = q.track
      if (t.albumId !== track.albumId || seen.has(t.id)) continue
      seen.add(t.id)
      const l = t.analysis?.lufs
      if (typeof l === 'number' && Number.isFinite(l)) vals.push({ lufs: l, durationMs: t.durationMs })
    }
    return combineLufs(vals)
  }

  private engineTrack(id: string, track: TrackView, src: ResolvedSource): EngineTrack {
    let lufs: number | null = track.analysis?.lufs ?? null
    try {
      lufs = this.catalog.getAnalysis(track.id)?.lufs ?? lufs
    } catch {
      /* keep summary value */
    }
    return {
      id,
      source: src.source,
      lufs,
      albumLufs: this.albumLufs(track),
      albumKey: track.albumId,
      expectedDurationMs: track.durationMs
    }
  }

  private markFailed(a: Attempt, message: string): void {
    const src = a.sources[a.srcIdx]
    a.lastError = message
    if (!src) return
    const key = sourceKey(src.source)
    this.failedSet(a.trackId).add(key)
    if (src.provider === 'download') return // our own file; nothing for the catalog to learn
    try {
      this.catalog.markSourceFailed(a.trackId, key, message)
    } catch (e) {
      console.error('[player] markSourceFailed failed:', e)
    }
  }

  private setSourceSummary(uid: string, src: ResolvedSource): void {
    const i = this.s.queue.findIndex((q) => q.uid === uid)
    if (i < 0) return
    const q = this.s.queue[i]
    this.s.queue = this.s.queue.slice()
    this.s.queue[i] = { ...q, track: { ...q.track, source: summaryOf(src) } }
  }

  // ===========================================================================
  // Loading

  private setCurrentItem(item: QueueItem): void {
    let analysis: TrackAnalysis | null = null
    try {
      analysis = this.catalog.getAnalysis(item.track.id)
    } catch {
      analysis = null
    }
    this.s.currentAnalysis = analysis
    this.s.durationMs = this.infoDuration.get(item.uid) ?? item.track.durationMs ?? null
    this.s.error = null
  }

  private loadIndex(i: number, autoplay: boolean, startMs = 0): Promise<void> {
    return this.track(this.doLoad(i, autoplay, startMs))
  }

  private async doLoad(i: number, autoplay: boolean, startMs: number): Promise<void> {
    const item = this.item(i)
    if (!item) return this.stopAtEnd()
    const seq = ++this.loadSeq
    const wasAudible = !!this.cur?.loaded && (this.s.status === 'playing' || this.s.status === 'buffering')
    // Reuse the preloaded next's sources when the user skips to it.
    const reuse = this.pre && this.pre.id === item.uid && this.pre.sources.length ? this.pre : null
    this.clearPreload()
    this.s.queueIndex = i
    this.setCurrentItem(item)
    this.s.positionMs = Math.max(0, startMs)
    this.setStatus('loading')
    this.beginPlay(item)
    const cur: Current = {
      id: item.uid,
      trackId: item.track.id,
      track: item.track,
      sources: reuse ? reuse.sources : [],
      srcIdx: reuse ? Math.max(-1, reuse.srcIdx - 1) : -1,
      remoteResolved: reuse ? reuse.remoteResolved : false,
      lastError: null,
      seq,
      autoplay,
      loaded: false,
      startMs: Math.max(0, startMs)
    }
    this.cur = cur
    this.changed()
    this.scheduleSave()
    if (!reuse) {
      // Don't keep the old track running while we go to the network for the new one.
      if (wasAudible) this.safe(() => this.engine.pause())
      try {
        const r = await this.resolveInitial(cur.trackId)
        cur.sources = r.sources
        cur.remoteResolved = r.remoteResolved
      } catch (e) {
        cur.lastError = (e as Error)?.message ?? String(e)
        cur.remoteResolved = true
      }
      if (seq !== this.loadSeq) return
    }
    await this.startSource(cur)
  }

  /** Hand the next usable source of `cur` to the engine (fallback path included). */
  private async startSource(cur: Current): Promise<void> {
    for (;;) {
      const src = await this.nextSource(cur)
      if (cur !== this.cur || cur.seq !== this.loadSeq) return
      if (!src) return this.allSourcesFailed(cur)
      try {
        this.engine.setCurrent(this.engineTrack(cur.id, cur.track, src), cur.startMs, cur.autoplay)
      } catch (e) {
        this.markFailed(cur, (e as Error)?.message ?? String(e))
        continue
      }
      cur.loaded = true
      this.seekHold = null
      this.engineState = 'loading'
      this.uidTrack.set(cur.id, cur.trackId)
      this.setSourceSummary(cur.id, src)
      if (!cur.autoplay) this.setStatus('paused')
      this.s.positionMs = cur.startMs
      this.s.positionAt = this.now()
      this.schedulePreload(true)
      this.changed()
      return
    }
  }

  private allSourcesFailed(cur: Current): void {
    this.failed.delete(cur.trackId) // a later manual retry gets a clean slate
    if (this.failStreak.size === 0) this.streakNotice = `player-skip-${randomUUID()}`
    this.failStreak.add(cur.id)
    const title = cur.track.title
    const reason = cur.lastError ? `Last error: ${cur.lastError}` : 'No playable source found.'
    const ni = this.naturalNext()
    const nextItem = ni === null ? null : this.item(ni)
    const giveUp = !nextItem || this.failStreak.has(nextItem.uid) || this.failStreak.size >= MAX_FAIL_STREAK || !cur.autoplay
    if (giveUp) {
      const streak = this.failStreak.size
      this.failStreak.clear()
      this.cur = null
      this.clearPreload()
      this.safe(() => this.engine.stop())
      this.finishPlay()
      this.s.error = streak > 1 ? `${streak} tracks in a row couldn't be played. ${reason}` : `Couldn't play “${title}”. ${reason}`
      this.setStatus('error')
      this.notify('error', streak > 1 ? 'Playback stopped' : `Couldn't play “${title}”`, this.s.error, cur.track.cover, undefined, this.streakNotice)
      this.changed()
      return
    }
    // One card per failure streak, updated as tracks are skipped.
    const n = this.failStreak.size
    this.notify('error', n > 1 ? `Couldn't play ${n} tracks` : `Couldn't play “${title}”`, `${n > 1 ? `“${title}”: ` : ''}${reason} Skipping to the next track.`, cur.track.cover, undefined, this.streakNotice)
    void this.loadIndex(ni!, true, 0)
  }

  /** Index that plays after the current one when the user skips (repeat-one doesn't pin). */
  private naturalNext(): number | null {
    const n = this.s.queue.length
    const i = this.s.queueIndex
    if (i < 0 || n === 0) return null
    if (i + 1 < n) return i + 1
    return this.s.repeat === 'all' ? 0 : null
  }

  /** Index the engine should preload for a gapless transition. */
  private upcomingIndex(): number | null {
    if (this.s.repeat === 'one' && this.s.queueIndex >= 0 && this.item()) return this.s.queueIndex
    return this.naturalNext()
  }

  private stopAtEnd(): void {
    this.finishPlay()
    this.loadSeq++
    this.cur = null
    this.clearPreload()
    this.safe(() => this.engine.stop())
    if (this.s.queueIndex >= this.s.queue.length) this.s.queueIndex = this.s.queue.length - 1
    this.s.positionMs = 0
    this.setStatus('idle')
    this.changed()
    this.scheduleSave()
  }

  // ===========================================================================
  // Gapless preload

  private clearPreload(): void {
    this.preSeq++
    if (this.pre?.armed) this.safe(() => this.engine.setNext(null))
    this.pre = null
  }

  /**
   * Make sure the engine's `next` matches the queue. `force` re-arms even when the item is
   * unchanged (after setCurrent the engine may have dropped its old `next`).
   */
  private schedulePreload(force = false): void {
    if (!this.cur?.loaded) {
      if (this.pre) this.clearPreload()
      return
    }
    const ni = this.upcomingIndex()
    const item = ni === null ? null : this.item(ni)
    if (!item) {
      if (this.pre || force) {
        this.clearPreload()
        this.safe(() => this.engine.setNext(null))
      }
      return
    }
    if (this.pre && this.pre.id === item.uid) {
      if (force && this.pre.armed) {
        const src = this.pre.sources[this.pre.srcIdx]
        if (src) this.safe(() => this.engine.setNext(this.engineTrack(item.uid, item.track, src)))
      }
      return
    }
    this.clearPreload()
    const pre: Preload = {
      id: item.uid,
      trackId: item.track.id,
      track: item.track,
      sources: [],
      srcIdx: -1,
      remoteResolved: false,
      lastError: null,
      seq: this.preSeq,
      armed: false
    }
    // Repeat-one (or a queue of one with repeat-all): reuse the current track's working sources.
    if (this.cur && this.cur.trackId === item.track.id) {
      pre.sources = this.cur.sources.slice()
      pre.srcIdx = this.cur.srcIdx - 1
      pre.remoteResolved = this.cur.remoteResolved
    }
    this.pre = pre
    // Never leave a stale `next` armed while the new one resolves.
    this.safe(() => this.engine.setNext(null))
    void this.track(this.armPreload(pre, pre.sources.length === 0))
  }

  private async armPreload(pre: Preload, resolve: boolean): Promise<void> {
    if (resolve) {
      try {
        const r = await this.resolveInitial(pre.trackId)
        pre.sources = r.sources
        pre.remoteResolved = r.remoteResolved
      } catch (e) {
        pre.lastError = (e as Error)?.message ?? String(e)
        pre.remoteResolved = true
      }
    }
    if (pre !== this.pre || pre.seq !== this.preSeq) return
    const src = await this.nextSource(pre)
    if (pre !== this.pre || pre.seq !== this.preSeq) return
    // No source: leave `next` empty; 'ended' will load it normally and handle the failure.
    if (!src) return
    try {
      this.engine.setNext(this.engineTrack(pre.id, pre.track, src))
      pre.armed = true
      this.uidTrack.set(pre.id, pre.trackId)
    } catch (e) {
      this.markFailed(pre, (e as Error)?.message ?? String(e))
      await this.armPreload(pre, false)
    }
  }

  // ===========================================================================
  // Engine events

  handleEngineEvent(e: EngineEvent): void {
    try {
      switch (e.type) {
        case 'state':
          return this.onState(e.state, e.id)
        case 'advanced':
          return this.onAdvanced(e.id)
        case 'ended':
          return this.onEnded(e.id)
        case 'trackInfo':
          return this.onTrackInfo(e.id, e.durationMs)
        case 'buffering':
          return this.onBuffering(e.id, e.buffering)
        case 'error':
          return this.onError(e.id, e.message, e.recoverable)
        case 'analysis':
          return this.onAnalysis(e.id, e.result)
        case 'previewEnded':
          return this.onPreviewEnded()
        default:
          return // cacheComplete (engine auto-analyses), devices, download: not ours
      }
    } catch (err) {
      console.error('[player] engine event handler failed:', e.type, err)
    }
  }

  private onState(state: EnginePlaybackState, id: string | null): void {
    const cur = this.cur
    if (!cur?.loaded || (id !== null && id !== cur.id)) return
    this.engineState = state
    switch (state) {
      case 'playing':
        this.failStreak.clear()
        this.setStatus('playing')
        break
      case 'paused':
        this.setStatus('paused')
        break
      case 'loading':
        if (this.s.status !== 'paused') this.setStatus('loading')
        break
      case 'buffering':
        this.setStatus('buffering')
        break
      case 'idle':
        return // end of track is handled by 'ended'/'advanced'
    }
    this.changed()
  }

  private onBuffering(id: string, buffering: boolean): void {
    const cur = this.cur
    if (!cur?.loaded || id !== cur.id) return
    if (buffering) this.setStatus('buffering')
    else this.setStatus(this.engineState === 'paused' || !cur.autoplay ? 'paused' : 'playing')
    this.changed()
  }

  private onTrackInfo(id: string, durationMs: number | null): void {
    if (durationMs && durationMs > 0) this.infoDuration.set(id, durationMs)
    if (this.cur?.id === id && durationMs && durationMs > 0) {
      this.s.durationMs = durationMs
      this.failStreak.clear()
      this.changed()
    }
  }

  private onAdvanced(id: string): void {
    const idx = this.s.queue.findIndex((q) => q.uid === id)
    if (idx < 0) {
      // The engine moved into something that's no longer queued; get back in sync.
      const ni = this.upcomingIndex()
      if (ni !== null) void this.loadIndex(ni, true, 0)
      else this.stopAtEnd()
      return
    }
    const pre = this.pre && this.pre.id === id ? this.pre : null
    const item = this.s.queue[idx]
    this.finishPlay()
    this.loadSeq++
    this.preSeq++
    this.pre = null
    this.s.queueIndex = idx
    this.setCurrentItem(item)
    this.cur = {
      id,
      trackId: item.track.id,
      track: item.track,
      sources: pre?.sources ?? [],
      srcIdx: pre?.srcIdx ?? -1,
      remoteResolved: pre?.remoteResolved ?? false,
      lastError: null,
      seq: this.loadSeq,
      autoplay: true,
      loaded: true,
      startMs: 0
    }
    if (pre) {
      const src = pre.sources[pre.srcIdx]
      if (src) this.setSourceSummary(id, src)
    }
    this.uidTrack.set(id, item.track.id)
    this.seekHold = null
    this.engineState = 'playing'
    this.s.positionMs = 0
    this.s.positionAt = this.now()
    this.failStreak.clear()
    if (this.s.status !== 'playing') this.setStatus('playing')
    this.beginPlay(item)
    this.schedulePreload()
    this.changed()
    this.scheduleSave()
  }

  private onEnded(id: string): void {
    const cur = this.cur
    if (!cur?.loaded || cur.id !== id) return
    cur.loaded = false
    this.finishPlay()
    const ni = this.upcomingIndex()
    if (ni === null) return this.stopAtEnd()
    void this.loadIndex(ni, true, 0)
  }

  private onError(id: string | null, message: string, recoverable: boolean): void {
    const pv = this.pv
    if (pv && id === pv.id) {
      if (recoverable) {
        this.markFailed(pv, message)
        void this.track(this.startPreviewSource(pv))
      } else this.clearPreviewState()
      return
    }
    const cur = this.cur
    const pre = this.pre
    if (recoverable && pre && id === pre.id && (!cur || cur.id !== id)) {
      if (!pre.armed) return // already falling back
      // The preloaded next failed while buffering: re-arm it with its next source.
      this.markFailed(pre, message)
      pre.armed = false
      this.safe(() => this.engine.setNext(null))
      void this.track(this.armPreload(pre, false))
      return
    }
    if (recoverable && cur && (id === null || id === cur.id)) {
      if (!cur.loaded) return // already falling back (duplicate error for the same source)
      this.markFailed(cur, message)
      let pos = this.s.positionMs
      if (cur.loaded) {
        try {
          const p = this.engine.position()
          if (p.id === cur.id) pos = p.positionMs
        } catch {
          /* keep last known */
        }
      }
      cur.startMs = Math.max(0, pos)
      cur.loaded = false
      // Same queue position; superseded if the user loads something else meanwhile.
      cur.autoplay = cur.autoplay && this.s.status !== 'paused'
      this.setStatus('loading')
      this.changed()
      void this.track(this.startSource(cur))
      return
    }
    if (!recoverable) {
      this.s.error = message
      if (cur && (id === null || id === cur.id)) this.setStatus('error')
      this.notify('error', 'Playback error', message, null, `fatal:${message}`)
      this.changed()
    }
  }

  private onAnalysis(id: string, result: OfflineAnalysisResult): void {
    const trackId = this.uidTrack.get(id) ?? this.s.queue.find((q) => q.uid === id)?.track.id
    if (!trackId) return
    try {
      this.catalog.recordAnalysis(trackId, result)
    } catch (e) {
      console.error('[player] recordAnalysis failed:', e)
    }
    let full: TrackAnalysis | null = null
    try {
      full = this.catalog.getAnalysis(trackId)
    } catch {
      full = null
    }
    full ??= analysisFromResult(result)
    const summary: TrackAnalysisSummary = { bpm: full.bpm, intensity: full.intensity, lufs: full.lufs }
    let touched = false
    this.s.queue = this.s.queue.map((q) => {
      if (q.track.id !== trackId) return q
      touched = true
      return { ...q, track: { ...q.track, analysis: summary } }
    })
    if (this.item()?.track.id === trackId) {
      this.s.currentAnalysis = full
      touched = true
    }
    if (this.s.preview && this.s.preview.track.id === trackId) {
      this.s.preview = { ...this.s.preview, track: { ...this.s.preview.track, analysis: summary } }
      touched = true
    }
    if (touched) this.changed()
  }

  // ===========================================================================
  // Heartbeat

  /** ~1 Hz: fresh position broadcast while playing, history threshold, periodic session save. */
  tick(): void {
    if (this.disposed) return
    const cur = this.cur
    if (cur?.loaded) {
      try {
        const p = this.engine.position()
        // Self-heal if a state event was missed.
        if (p.id === cur.id && p.playing && this.s.status === 'loading') this.setStatus('playing')
      } catch {
        /* ignore */
      }
    }
    this.checkPlay()
    if (this.s.status === 'playing' || this.s.status === 'buffering') {
      this.changed()
      if (this.now() - this.lastSaveAt > 5000) this.scheduleSave()
    }
  }

  // ===========================================================================
  // Session

  sessionData(): SessionData {
    this.refreshPosition()
    const live = this.s.status === 'playing' ? this.s.positionMs + Math.max(0, this.now() - this.s.positionAt) : this.s.positionMs
    return {
      v: 1,
      queue: this.s.queue.map((q) => ({ uid: q.uid, trackId: q.track.id })),
      originalOrder: this.originalOrder ? [...this.originalOrder] : null,
      queueIndex: this.s.queueIndex,
      positionMs: Math.round(live),
      shuffle: this.s.shuffle,
      repeat: this.s.repeat,
      volume: this.s.volume,
      muted: this.s.muted,
      context: this.s.context,
      savedAt: this.now()
    }
  }

  private scheduleSave(): void {
    if (!this.deps.session || this.disposed) return
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, this.deps.sessionDebounceMs ?? 1500)
    this.saveTimer.unref?.()
  }

  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.deps.session) return
    this.lastSaveAt = this.now()
    this.deps.session.save(this.sessionData())
  }

  /** Restore a saved session PAUSED at its position. Nothing is loaded until play(). */
  async restore(data: SessionData | null): Promise<void> {
    const startMutations = this.mutations
    const vol = data ? data.volume : this.s.volume
    this.s.volume = vol
    this.s.muted = data?.muted ?? false
    this.safe(() => this.engine.setVolumeDb(sliderToDb(vol)))
    this.safe(() => this.engine.setMuted(this.s.muted))
    if (!data) return this.changed()
    this.s.shuffle = data.shuffle
    this.s.repeat = data.repeat
    const tracks = data.queue.length ? await this.library.fetchTracks([...new Set(data.queue.map((q) => q.trackId))]) : []
    if (this.mutations !== startMutations) return // the user already started something else
    const byId = new Map(tracks.map((t) => [t.id, t]))
    const queue: QueueItem[] = data.queue.filter((q) => byId.has(q.trackId)).map((q) => ({ uid: q.uid, track: byId.get(q.trackId)! }))
    const savedCur = data.queue[data.queueIndex]?.uid
    let idx = queue.findIndex((q) => q.uid === savedCur)
    let pos = data.positionMs
    if (idx < 0 && queue.length) {
      idx = Math.max(0, Math.min(queue.length - 1, data.queueIndex))
      pos = 0
    }
    const uids = new Set(queue.map((q) => q.uid))
    this.originalOrder = data.shuffle !== 'off' ? (data.originalOrder ?? queue.map((q) => q.uid)).filter((u) => uids.has(u)) : null
    if (this.originalOrder) for (const q of queue) if (!this.originalOrder.includes(q.uid)) this.originalOrder.push(q.uid)
    this.s.queue = queue
    this.s.queueIndex = idx
    this.s.context = data.context
    this.cur = null
    if (idx >= 0) {
      this.setCurrentItem(queue[idx])
      const dur = this.s.durationMs
      this.s.positionMs = Math.max(0, dur ? Math.min(pos, dur) : pos)
      this.setStatus('paused')
    } else {
      this.s.positionMs = 0
      this.setStatus('idle')
    }
    this.changed()
  }

  // ===========================================================================
  // Library hooks

  /** Re-decorate (liked/downloaded) the given tracks wherever they appear in the state. */
  refreshTracks(trackIds: ID[]): void {
    const ids = new Set(trackIds)
    let touched = false
    this.s.queue = this.s.queue.map((q) => {
      if (!ids.has(q.track.id)) return q
      const t = this.library.decorateOne(q.track)
      if (t === q.track) return q
      touched = true
      return { ...q, track: t }
    })
    if (this.s.preview && ids.has(this.s.preview.track.id)) {
      const t = this.library.decorateOne(this.s.preview.track)
      if (t !== this.s.preview.track) {
        this.s.preview = { ...this.s.preview, track: t }
        touched = true
      }
    }
    if (touched) this.changed()
  }

  onSettingsChanged(next: Settings): void {
    if (next.audio.loopMode !== this.s.loopMode) {
      this.s.loopMode = next.audio.loopMode
      this.changed()
    }
  }

  // ===========================================================================
  // Queue construction

  private newItems(tracks: TrackView[]): QueueItem[] {
    return tracks.map((track) => ({ uid: randomUUID(), track }))
  }

  private shuffleItems(items: QueueItem[], before: QueueItem | null): QueueItem[] {
    if (this.s.shuffle === 'smart') {
      return smartShuffle(items, (q) => ({ group: groupOf(q.track), liked: q.track.liked }), before ? groupOf(before.track) : null, this.rng)
    }
    return fisherYates(items, this.rng)
  }

  private setQueue(tracks: TrackView[], start: number, context: PlayContext | null): Promise<void> {
    this.mutations++
    if (!tracks.length) {
      this.notify('info', 'Nothing to play', 'None of those tracks are available.')
      return Promise.resolve()
    }
    let items = this.newItems(tracks)
    let startIdx = Math.max(0, Math.min(items.length - 1, Math.floor(start) || 0))
    if (this.s.shuffle !== 'off') {
      this.originalOrder = items.map((q) => q.uid)
      const first = items[startIdx]
      items = [first, ...this.shuffleItems(items.filter((_, i) => i !== startIdx), first)]
      startIdx = 0
    } else {
      this.originalOrder = null
    }
    this.s.queue = items
    this.s.context = context
    this.failStreak.clear()
    return this.loadIndex(startIdx, true, 0)
  }

  // ===========================================================================
  // PlayerAPI

  async getState(): Promise<PlayerState> {
    return this.snapshot()
  }

  async playTracks(trackIds: ID[], startIndex = 0, context?: PlayContext): Promise<void> {
    const ids = (trackIds ?? []).filter((x) => typeof x === 'string')
    const tracks = await this.library.fetchTracks(ids)
    const found = new Set(tracks.map((t) => t.id))
    const start = ids.slice(0, Math.max(0, startIndex)).filter((id) => found.has(id)).length
    void this.setQueue(tracks, start, context ?? null)
  }

  async playAlbum(albumId: ID, startIndex = 0): Promise<void> {
    const detail = await this.catalog.album(albumId)
    const tracks = detail.tracks.map((t) => this.library.decorateOne(t))
    void this.setQueue(tracks, startIndex, { kind: 'album', id: albumId, title: detail.album.title })
  }

  async playPlaylist(playlistId: ID, startIndex = 0): Promise<void> {
    const detail = await this.deps.playlists.get(playlistId)
    void this.setQueue(
      detail.items.map((i) => i.track),
      startIndex,
      { kind: 'playlist', id: playlistId, title: detail.playlist.name }
    )
  }

  async toggle(): Promise<void> {
    const st = this.s.status
    const wantsPlay = st === 'playing' || st === 'buffering' || (st === 'loading' && !!this.cur?.autoplay)
    return wantsPlay ? this.pause() : this.play()
  }

  async play(): Promise<void> {
    if (!this.s.queue.length) return
    if (this.s.queueIndex < 0) {
      void this.loadIndex(0, true, 0)
      return
    }
    const cur = this.cur
    if (cur?.loaded) {
      this.safe(() => this.engine.play())
      this.setStatus('playing')
      this.changed()
      return
    }
    if (cur && cur.seq === this.loadSeq) {
      // Still resolving: start as soon as it's ready.
      cur.autoplay = true
      this.setStatus('loading')
      this.changed()
      return
    }
    // Restored session, stopped at the end, or after an error: (re)load the current item.
    const from = this.s.status === 'idle' || this.s.status === 'error' ? 0 : this.s.positionMs
    void this.loadIndex(this.s.queueIndex, true, from)
  }

  async pause(): Promise<void> {
    const cur = this.cur
    if (cur?.loaded) {
      this.safe(() => this.engine.pause())
      this.refreshPosition()
      this.setStatus('paused')
    } else if (cur) {
      cur.autoplay = false
    } else if (this.s.status === 'playing') {
      this.setStatus('paused')
    }
    this.changed()
    this.scheduleSave()
  }

  private keepPlaying(): boolean {
    return this.s.status !== 'paused'
  }

  async next(): Promise<void> {
    if (!this.s.queue.length) return
    this.mutations++
    const ni = this.naturalNext()
    if (ni === null) return this.stopAtEnd()
    void this.loadIndex(ni, this.keepPlaying(), 0)
  }

  async prev(): Promise<void> {
    if (!this.s.queue.length) return
    this.mutations++
    this.refreshPosition()
    const live = this.s.status === 'playing' ? this.s.positionMs + Math.max(0, this.now() - this.s.positionAt) : this.s.positionMs
    const i = this.s.queueIndex
    const n = this.s.queue.length
    const canGoBack = i > 0 || (this.s.repeat === 'all' && n > 1)
    if (live > PREV_RESTART_MS || !canGoBack) return this.seek(0)
    void this.loadIndex(i > 0 ? i - 1 : n - 1, this.keepPlaying(), 0)
  }

  async seek(ms: number): Promise<void> {
    const dur = this.s.durationMs
    const to = Math.max(0, Math.min(Number(ms) || 0, dur ?? Number.MAX_SAFE_INTEGER))
    if (this.cur?.loaded) {
      this.safe(() => this.engine.seek(to))
      this.seekHold = { ms: to, at: this.now() }
    } else if (this.cur) this.cur.startMs = to
    this.s.positionMs = to
    this.s.positionAt = this.now()
    this.changed()
    this.scheduleSave()
  }

  async setVolume(volume: number): Promise<void> {
    const v = Math.max(0, Math.min(1, Number(volume) || 0))
    this.s.volume = v
    this.safe(() => this.engine.setVolumeDb(sliderToDb(v)))
    this.changed()
    this.scheduleSave()
  }

  async setMuted(muted: boolean): Promise<void> {
    this.s.muted = !!muted
    this.safe(() => this.engine.setMuted(this.s.muted))
    this.changed()
    this.scheduleSave()
  }

  async setShuffle(mode: ShuffleMode): Promise<void> {
    if (!['off', 'on', 'smart'].includes(mode) || mode === this.s.shuffle) return
    const prev = this.s.shuffle
    this.s.shuffle = mode
    const cur = this.item()
    if (mode === 'off') {
      if (this.originalOrder) {
        const byUid = new Map(this.s.queue.map((q) => [q.uid, q]))
        const restored: QueueItem[] = []
        for (const u of this.originalOrder) {
          const q = byUid.get(u)
          if (q) {
            restored.push(q)
            byUid.delete(u)
          }
        }
        for (const q of this.s.queue) if (byUid.has(q.uid)) restored.push(q)
        this.s.queue = restored
        this.s.queueIndex = cur ? restored.findIndex((q) => q.uid === cur.uid) : -1
      }
      this.originalOrder = null
    } else {
      if (prev === 'off' || !this.originalOrder) this.originalOrder = this.s.queue.map((q) => q.uid)
      const i = this.s.queueIndex
      const head = this.s.queue.slice(0, i + 1)
      const upcoming = this.s.queue.slice(i + 1)
      this.s.queue = [...head, ...this.shuffleItems(upcoming, cur)]
    }
    this.schedulePreload()
    this.changed()
    this.scheduleSave()
  }

  async setRepeat(mode: RepeatMode): Promise<void> {
    if (!['off', 'all', 'one'].includes(mode) || mode === this.s.repeat) return
    this.s.repeat = mode
    this.schedulePreload()
    this.changed()
    this.scheduleSave()
  }

  async setLoopMode(mode: LoopMode): Promise<void> {
    if (!['album', 'endless', 'custom'].includes(mode)) return
    this.deps.setLoopMode(mode)
    if (this.s.loopMode !== mode) {
      this.s.loopMode = mode
      this.changed()
    }
  }

  async enqueue(trackIds: ID[], mode: 'next' | 'end'): Promise<void> {
    const tracks = await this.library.fetchTracks(trackIds ?? [])
    if (!tracks.length) return
    this.mutations++
    if (!this.s.queue.length || this.s.queueIndex < 0) {
      void this.setQueue(tracks, 0, { kind: 'queue', id: null, title: 'Queue' })
      return
    }
    const items = this.newItems(tracks)
    const uids = items.map((q) => q.uid)
    if (mode === 'next') {
      this.s.queue = [...this.s.queue.slice(0, this.s.queueIndex + 1), ...items, ...this.s.queue.slice(this.s.queueIndex + 1)]
      if (this.originalOrder) {
        const at = this.originalOrder.indexOf(this.item()!.uid)
        this.originalOrder.splice(at < 0 ? this.originalOrder.length : at + 1, 0, ...uids)
      }
    } else {
      this.s.queue = [...this.s.queue, ...items]
      this.originalOrder?.push(...uids)
    }
    this.schedulePreload()
    this.changed()
    this.scheduleSave()
  }

  async removeFromQueue(uids: string[]): Promise<void> {
    const remove = new Set(uids ?? [])
    if (!remove.size) return
    this.mutations++
    const cur = this.item()
    const oldIdx = this.s.queueIndex
    const before = this.s.queue
    const queue = before.filter((q) => !remove.has(q.uid))
    if (queue.length === before.length) return
    this.originalOrder = this.originalOrder?.filter((u) => !remove.has(u)) ?? null
    this.s.queue = queue
    if (!cur || !remove.has(cur.uid)) {
      this.s.queueIndex = cur ? queue.findIndex((q) => q.uid === cur.uid) : -1
      this.schedulePreload()
      this.changed()
      this.scheduleSave()
      return
    }
    // The current item was removed: continue with whatever now sits in its place.
    const survivorsBefore = before.slice(0, oldIdx).filter((q) => !remove.has(q.uid)).length
    if (!queue.length) {
      this.finishPlay()
      this.loadSeq++
      this.cur = null
      this.clearPreload()
      this.safe(() => this.engine.stop())
      this.s.queueIndex = -1
      this.s.currentAnalysis = null
      this.s.durationMs = null
      this.s.positionMs = 0
      this.s.context = null
      this.originalOrder = null
      this.setStatus('idle')
      this.changed()
      this.scheduleSave()
      return
    }
    const wasActive = this.s.status === 'playing' || this.s.status === 'buffering' || (this.s.status === 'loading' && !!this.cur?.autoplay)
    if (survivorsBefore >= queue.length) {
      this.s.queueIndex = queue.length - 1
      this.setCurrentItem(queue[this.s.queueIndex])
      this.stopAtEnd()
      return
    }
    if (wasActive) {
      void this.loadIndex(survivorsBefore, true, 0)
      return
    }
    this.finishPlay()
    this.loadSeq++
    this.cur = null
    this.clearPreload()
    this.safe(() => this.engine.stop())
    this.s.queueIndex = survivorsBefore
    this.setCurrentItem(queue[survivorsBefore])
    this.s.positionMs = 0
    this.setStatus('paused')
    this.changed()
    this.scheduleSave()
  }

  async moveInQueue(from: number, to: number): Promise<void> {
    const n = this.s.queue.length
    if (!Number.isInteger(from) || from < 0 || from >= n) return
    const dest = Math.max(0, Math.min(n - 1, Math.floor(to)))
    if (dest === from) return
    this.mutations++
    const cur = this.item()
    const q = [...this.s.queue]
    const [moved] = q.splice(from, 1)
    q.splice(dest, 0, moved)
    this.s.queue = q
    this.s.queueIndex = cur ? q.findIndex((x) => x.uid === cur.uid) : -1
    this.schedulePreload()
    this.changed()
    this.scheduleSave()
  }

  async clearQueue(): Promise<void> {
    this.mutations++
    const cur = this.item()
    this.s.queue = cur ? [cur] : []
    this.s.queueIndex = cur ? 0 : -1
    this.originalOrder = this.originalOrder && cur ? [cur.uid] : null
    this.schedulePreload()
    this.changed()
    this.scheduleSave()
  }

  async jumpTo(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0 || index >= this.s.queue.length) return
    this.mutations++
    void this.loadIndex(index, true, 0)
  }

  // ---------------------------------------------------------------------------
  // Previews

  /** Where a preview starts: the first kiai section if analysed, else 35% in. */
  previewPoint(track: TrackView): number {
    let a: TrackAnalysis | null = null
    try {
      a = this.catalog.getAnalysis(track.id)
    } catch {
      a = null
    }
    if (a?.kiai?.length) return Math.max(0, Math.round(a.kiai[0][0] * 1000))
    return track.durationMs ? Math.round(track.durationMs * 0.35) : 0
  }

  async preview(trackId: ID, startMs?: number): Promise<void> {
    const seq = ++this.pvSeq
    const [track] = await this.library.fetchTracks([trackId])
    if (!track || seq !== this.pvSeq) return
    const pv: Preview = {
      id: `preview:${seq}:${trackId}`,
      trackId,
      track,
      sources: [],
      srcIdx: -1,
      remoteResolved: false,
      lastError: null,
      seq,
      startMs: typeof startMs === 'number' && startMs >= 0 ? startMs : this.previewPoint(track)
    }
    this.pv = pv
    try {
      const r = await this.resolveInitial(trackId)
      pv.sources = r.sources
      pv.remoteResolved = r.remoteResolved
    } catch (e) {
      pv.lastError = (e as Error)?.message ?? String(e)
      pv.remoteResolved = true
    }
    if (pv !== this.pv) return
    await this.startPreviewSource(pv)
  }

  private async startPreviewSource(pv: Preview): Promise<void> {
    for (;;) {
      const src = await this.nextSource(pv)
      if (pv !== this.pv) return
      if (!src) {
        this.clearPreviewState()
        return
      }
      try {
        this.engine.preview(this.engineTrack(pv.id, pv.track, src), pv.startMs)
      } catch (e) {
        this.markFailed(pv, (e as Error)?.message ?? String(e))
        continue
      }
      this.uidTrack.set(pv.id, pv.trackId)
      this.s.preview = { track: pv.track, startedAt: this.now() }
      this.changed()
      return
    }
  }

  private clearPreviewState(): void {
    this.pv = null
    if (this.s.preview) {
      this.s.preview = null
      this.changed()
    }
  }

  private onPreviewEnded(): void {
    this.clearPreviewState()
  }

  async stopPreview(): Promise<void> {
    this.pvSeq++
    this.pv = null
    this.safe(() => this.engine.stopPreview())
    this.s.preview = null
    this.changed()
  }

  async setOverlayFilter(active: boolean): Promise<void> {
    this.safe(() => this.engine.setOverlayFilter(!!active))
  }

  async devices(): Promise<AudioDevice[]> {
    try {
      return this.engine.listDevices().map((d) => ({ id: d.id, name: d.name, isDefault: d.isDefault }))
    } catch (e) {
      console.error('[player] listDevices failed:', e)
      return [{ id: 'default', name: 'System default', isDefault: true }]
    }
  }

  // ---------------------------------------------------------------------------

  private safe(fn: () => void): void {
    try {
      fn()
    } catch (e) {
      console.error('[player] engine call failed:', e)
    }
  }

  /** Persist the session and stop timers. */
  dispose(): void {
    if (this.disposed) return
    this.finishPlay()
    this.saveNow()
    this.disposed = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }
}
