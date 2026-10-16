// The player: source of truth for PlayerState. Owns the queue and decides what plays; the
// engine only knows `current`, a preloaded `next` (gapless) and an optional `preview`.
// One song is audible at a time: a preview pauses audible playback and gives it back when it ends
// (see holdForPreview), and anything that makes the queue audible ends the preview.
import { randomUUID } from 'node:crypto'
import type { PlayerAPI } from '../../shared/api'
import { backupReason, isBackup, missReason } from '../../shared/providers'
import type {
  AudioDevice,
  ID,
  LoopMode,
  PlayContext,
  PlayerState,
  PlayerStateEvent,
  PlayStatus,
  PlaylistDetail,
  QueueItem,
  RepeatMode,
  Settings,
  ShuffleMode,
  SourceSummary,
  TrackAnalysis,
  TrackAnalysisSummary,
  TrackView,
  SourceMiss,
  VoiceMask
} from '../../shared/types'
import { MAX_VOICES, VOICES_ALL_ON, allVoices, formatVoiceMask, parseVoiceMask } from '../../shared/voices'
import type { CatalogService, ResolvedSource } from '../catalog'
import type { EngineBridge, EngineEvent, EnginePlaybackState, EngineSource, EngineTrack, EngineTrackInfo, OfflineAnalysisResult } from '../engine/types'
import { sliderToDb } from '../engine/types'
import type { Broadcast } from '../ipc'
import { ACCESS_DENIED } from '../net/errors'
import type { ResolveStep, ToolProgress } from '../catalog/progress'
import { Typical, WaitTracker, type EngineWait } from './progress'
import type { SessionData, SessionStore } from './session'
import { fisherYates, smartShuffle, type Rng } from './shuffle'

export type PlayerCatalog = Pick<CatalogService, 'album' | 'resolveSources' | 'getAnalysis' | 'peekAnalysis' | 'recordAnalysis' | 'markSourceFailed'> &
  Partial<Pick<CatalogService, 'warmSources'>>

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
  /**
   * Volume / mute / seek echoes are coalesced to at most one 'player:state' per this many ms (a
   * dragged volume slider sends ~120 calls a second). Status and track changes are never delayed.
   * Default 0 (no coalescing).
   */
  echoIntervalMs?: number
  sessionDebounceMs?: number
  /** Latency milestones (click → first sound), e.g. perf.ts `perfMark`. */
  mark?: (name: string) => void
}

/** Restart instead of going back when prev() is pressed past this point. */
export const PREV_RESTART_MS = 3000
/** History: a play counts after 30 s or half the track, whichever comes first. */
export const HISTORY_MIN_MS = 30000
/** A source refused again within this long after a refresh is treated as broken. */
const REFRESH_AGAIN_MS = 10 * 60_000
/**
 * A server that didn't answer (a source URL's folder: an Internet Archive item, an album's folder)
 * is tried last for this long: its other files, the rest of the album, are most likely down too.
 */
const UNREACHABLE_MS = 5 * 60_000
/** Engine errors that mean the server never answered (rather than refusing, or sending a broken file). */
const NO_ANSWER = /stream stalled|timed out/i

/** How often the engine is asked what a loading / buffering track waits on (only while one does). */
export const WAIT_POLL_MS = 200

/** An opening preview the engine reports nothing about for this many polls is taken as playing. */
const PREVIEW_UNKNOWN_POLLS = 5

/** Stop auto-skipping after this many tracks in a row failed to play. */
export const MAX_FAIL_STREAK = 8
/** When a queue starts, the catalog pre-resolves this many tracks after the first (see warmUpcoming). */
export const WARM_AHEAD = 2
/**
 * The heartbeat re-sends the position only when the renderer's extrapolation (positionMs +
 * elapsed since positionAt) is off by more than this, or when nothing was sent for HEARTBEAT_KEEPALIVE_MS.
 */
export const HEARTBEAT_DRIFT_MS = 25
export const HEARTBEAT_KEEPALIVE_MS = 15_000

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
  /** Whether the catalog was asked again for other sources (a fallback search) after these failed. */
  searched?: boolean
  /** The source this track was meant to play from, once given up on: what follows is a backup. */
  missed?: SourceMiss
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
  /**
   * This play's track length (the decoder's once it reports one), for its history threshold: not
   * the player's current duration, which already belongs to the next track when a skip ends this one.
   */
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

/** `missed`: the source the track was meant to play from, when this one stands in for it. */
const summaryOf = (s: ResolvedSource, missed?: SourceMiss): SourceSummary => ({
  provider: s.provider,
  format: s.format,
  lossless: s.lossless,
  bitrateKbps: s.bitrateKbps,
  confidence: s.confidence,
  ...(isBackup(missed, s) ? { backupFor: missed } : {})
})
const sameMiss = (a: SourceMiss | null | undefined, b: SourceMiss | null | undefined): boolean => a === b || (!!a && !!b && a.provider === b.provider && a.format === b.format && a.noAnswer === b.noAnswer)
const sameSummary = (a: SourceSummary | null, s: SourceSummary): boolean =>
  !!a && a.provider === s.provider && a.format === s.format && a.lossless === s.lossless && a.bitrateKbps === s.bitrateKbps && a.confidence === s.confidence && sameMiss(a.backupFor, s.backupFor)
const sameAnalysis = (a: TrackAnalysisSummary | null, b: TrackAnalysisSummary): boolean => !!a && a.bpm === b.bpm && a.intensity === b.intensity && a.lufs === b.lufs

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
  /** The queue as saved, kept while the queue array is the same (it's replaced, never mutated). */
  private savedQueue: { of: QueueItem[]; items: SessionData['queue'] } | null = null

  private cur: Current | null = null
  private pre: Preload | null = null
  private pv: Preview | null = null
  private loadSeq = 0
  private preSeq = 0
  private pvSeq = 0
  /** The queue item a preview paused (P while music plays): it resumes when the preview ends. */
  private hold: { seq: number } | null = null
  /** Seq of a preview() call still fetching its track (not yet `pv`), or 0: it inherits the hold. */
  private pvPending = 0
  /**
   * The user's latest request for a new queue (playTracks / playAlbum / playPlaylist) while its
   * tracks are looked up. A newer request replaces it (the older one is dropped when it resolves);
   * play / pause meanwhile decide whether it starts playing or paused.
   */
  private request: { autoplay: boolean } | null = null
  // What the current track / the preview waits on (PlayerState.loading / previewLoading).
  private readonly typical = new Typical()
  private curWait: WaitTracker | null = null
  private pvWait: WaitTracker | null = null
  /** The preview is audible (the engine started it). */
  private pvStarted = false
  /** Polls in a row without an engine report for the opening preview. */
  private pvMisses = 0
  private waitTimer: ReturnType<typeof setInterval> | null = null
  private engineState: EnginePlaybackState = 'idle'
  private seekHold: { ms: number; at: number } | null = null

  /** Track/cache-key pairs re-resolved after a 401/403/410, and when (one refresh per REFRESH_AGAIN_MS). */
  private refreshed = new Map<string, number>()
  /** Cache keys that failed this session, per track (passed to resolveSources as `exclude`). */
  private failed = new Map<ID, Set<string>>()
  /** Source folders whose server didn't answer, until when (see UNREACHABLE_MS). */
  private unreachable = new Map<string, number>()
  /** Queue items already announced as playing from a backup. */
  private backupNoticed = new Set<string>()
  private failStreak = new Set<string>()
  private streakNotice = ''
  private uidTrack = new BoundedMap<string, ID>(512)
  private infoDuration = new BoundedMap<string, number>(64)
  /** Chip voice names per engine id, from trackInfo (absent = the source has no mutable voices). */
  private infoVoices = new BoundedMap<string, string[]>(64)
  /** The engine's (global) voice mask as we last set it. */
  private engineMask = 0n
  private account: PlayAccount | null = null
  private lastNotice = new Map<string, number>()

  private emitQueued = false
  /** Pending coalesced (non-urgent) broadcast. */
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  /** performance.now() of the last 'player:state' broadcast (echo coalescing). */
  private lastEmitMono = -Infinity
  /** What the renderer extrapolates from: the position fields of the last broadcast. */
  private lastSent: { status: PlayStatus; positionMs: number; positionAt: number; at: number } | null = null
  private readonly heartbeatMs: number
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private lastSaveAt = 0
  private mutations = 0
  private pending = new Set<Promise<unknown>>()
  private disposed = false
  /** Load seq whose first 'playing' was already marked (latency tracing). */
  private audibleMarked = -1

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
      error: null,
      voices: null
    }
    // The heartbeat only runs while something plays (see syncHeartbeat): no wakeups when idle.
    this.heartbeatMs = deps.heartbeatMs ?? 1000
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
    return { ...this.lightSnapshot(), queue: [...this.s.queue] }
  }

  /** Everything but the queue (plus the queue's revision). */
  private lightSnapshot(): Omit<PlayerState, 'queue'> {
    this.refreshPosition()
    const current = this.item()?.track ?? null
    const v = current ? this.s.voices : null
    const { queue: _queue, ...rest } = this.s
    const st = this.s.status
    const loading = (st === 'loading' || st === 'buffering') && this.curWait ? this.curWait.progress() : null
    const pv = this.pv
    const previewLoading = pv && this.pvWait && !this.pvStarted ? { ...this.pvWait.progress(), trackId: pv.trackId } : null
    return { ...rest, current, voices: v ? { names: [...v.names], mask: v.mask } : null, loading, previewLoading, queueRev: this.queueRevision() }
  }

  // The queue is replaced (never mutated) on every change, so its identity is its revision.
  private queueRev = 0
  private revOf: QueueItem[] | null = null
  /** The queue as of the last 'player:state' broadcast. */
  private sentQueue: QueueItem[] | null = null

  private queueRevision(): number {
    if (this.s.queue !== this.revOf) {
      this.revOf = this.s.queue
      this.queueRev++
    }
    return this.queueRev
  }

  /** The 'player:state' payload: the queue only when it changed since the last broadcast. */
  stateEvent(): PlayerStateEvent {
    const ev: PlayerStateEvent = this.lightSnapshot()
    if (this.s.queue !== this.sentQueue) {
      this.sentQueue = this.s.queue
      // Not copied: the queue array is replaced, never mutated, and send() serialises it right away.
      ev.queue = this.s.queue
    }
    return ev
  }

  /**
   * Schedule a 'player:state' broadcast (coalesced per microtask). `urgent = false` (volume, mute,
   * seek echoes) additionally limits those to one per `echoIntervalMs`.
   */
  private changed(urgent = true): void {
    if (this.disposed || this.emitQueued) return
    const gap = this.deps.echoIntervalMs ?? 0
    if (!urgent && gap > 0) {
      if (this.emitTimer) return
      const wait = this.lastEmitMono + gap - performance.now()
      if (wait > 0) {
        this.emitTimer = setTimeout(() => this.emit(), wait)
        return
      }
    }
    this.emitQueued = true
    queueMicrotask(() => this.emit())
  }

  private emit(): void {
    this.emitQueued = false
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    if (this.disposed) return
    const ev = this.stateEvent()
    this.lastEmitMono = performance.now()
    this.lastSent = { status: ev.status, positionMs: ev.positionMs, positionAt: ev.positionAt, at: this.now() }
    this.deps.broadcast('player:state', ev)
  }

  /** Run the heartbeat only while something is (about to be) audible. */
  private syncHeartbeat(): void {
    const active = this.s.status === 'playing' || this.s.status === 'buffering' || this.s.status === 'loading'
    if (active && !this.heartbeat && this.heartbeatMs > 0 && !this.disposed) {
      this.heartbeat = setInterval(() => this.tick(), this.heartbeatMs)
      this.heartbeat.unref?.()
    } else if (!active && this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  /**
   * Whether the renderer's copy of the state needs refreshing on a heartbeat: the status changed
   * since the last broadcast, its position extrapolation (positionMs + time since positionAt) is off
   * by more than HEARTBEAT_DRIFT_MS (a loop point, a stall, clock drift), or the keepalive is due.
   */
  private rendererStale(): boolean {
    const last = this.lastSent
    const now = this.now()
    if (!last || last.status !== this.s.status || now - last.at >= HEARTBEAT_KEEPALIVE_MS) return true
    this.refreshPosition()
    const predicted = last.positionMs + (last.status === 'playing' ? now - last.positionAt : 0)
    const actual = this.s.positionMs + (this.s.status === 'playing' ? now - this.s.positionAt : 0)
    return Math.abs(actual - predicted) > HEARTBEAT_DRIFT_MS
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
    if (st === 'playing') this.curWait?.playing()
    this.syncHeartbeat()
    this.syncWaitPoll()
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
      durationMs: this.infoDuration.get(item.uid) ?? item.track.durationMs,
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
    const dur = a.durationMs
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

  /** `skip`: cache keys to leave out besides the track's failed ones. */
  private async resolveRemote(trackId: ID, skip: string[] = []): Promise<ResolvedSource[]> {
    const exclude = [...(this.failed.get(trackId) ?? []), ...skip]
    const list = await this.catalog.resolveSources(trackId, { quality: this.deps.getSettings().sources.quality, exclude })
    const bad = new Set(exclude)
    return list.filter((s) => !bad.has(sourceKey(s.source)))
  }

  /** The folder a remote source lives in (one server, typically one album), or null. */
  private static folderOf(s: ResolvedSource): string | null {
    if (s.source.kind !== 'http' || s.provider === 'download') return null
    const url = s.source.url
    return url.slice(0, url.lastIndexOf('/'))
  }

  private isUnreachable(s: ResolvedSource): boolean {
    const f = Player.folderOf(s)
    const until = f ? this.unreachable.get(f) : undefined
    if (until == null) return false
    if (until > this.now()) return true
    this.unreachable.delete(f!)
    return false
  }

  /** Downloaded file first (no network); otherwise the catalog's ranked sources. */
  private async resolveInitial(trackId: ID): Promise<{ sources: ResolvedSource[]; remoteResolved: boolean }> {
    const local = this.library.downloadedPath(trackId)
    if (local && !this.failed.get(trackId)?.has(sourceKey(localSource(local).source))) return { sources: [localSource(local)], remoteResolved: false }
    return { sources: await this.resolveRemote(trackId), remoteResolved: true }
  }

  /**
   * Advance `a` to its next usable source, resolving remote sources lazily. When those run out, or
   * only ones on a server that just didn't answer are left, the catalog is asked once more without
   * them (`search`: it then searches its fallback sources, e.g. YouTube) before trying those last.
   */
  private async nextSource(a: Attempt, search = true): Promise<ResolvedSource | null> {
    for (;;) {
      a.srcIdx++
      const bad = this.failed.get(a.trackId)
      while (a.srcIdx < a.sources.length && bad?.has(sourceKey(a.sources[a.srcIdx].source))) a.srcIdx++
      const next = a.sources[a.srcIdx] as ResolvedSource | undefined
      const lookFurther = search && a.remoteResolved && !a.searched
      if (next && !(lookFurther && this.isUnreachable(next))) return next
      if (next && lookFurther) {
        // Not even tried: its server just failed another track. Say why the wait is a search.
        a.missed ??= { provider: next.provider, format: next.format, noAnswer: true }
        if (this.waitOf(a)?.lookingElsewhere(missReason(a.missed))) this.changed()
      }
      if (!a.remoteResolved || lookFurther) {
        const first = !a.remoteResolved
        if (first) a.remoteResolved = true
        else a.searched = true
        try {
          // Ones on a server that isn't answering stay out of this answer (they're still tried last).
          const left = a.sources.slice(a.srcIdx)
          const more = await this.resolveRemote(a.trackId, first ? [] : left.map((s) => sourceKey(s.source)))
          const have = new Set(a.sources.map((s) => sourceKey(s.source)))
          const fresh = more.filter((s) => !have.has(sourceKey(s.source)))
          // Servers that just failed another track's file go after everything else.
          fresh.sort((x, y) => Number(this.isUnreachable(x)) - Number(this.isUnreachable(y)))
          a.sources.splice(a.srcIdx, 0, ...fresh)
        } catch (e) {
          a.lastError = (e as Error)?.message ?? String(e)
        }
        a.srcIdx--
        continue
      }
      return next ?? null
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
      // The catalog runs in a worker: only what it already handed this process (same value as the summary).
      lufs = this.catalog.peekAnalysis?.(track.id)?.lufs ?? lufs
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

  private mark(name: string): void {
    this.deps.mark?.(name)
  }

  private markFailed(a: Attempt, message: string): void {
    const src = a.sources[a.srcIdx]
    a.lastError = message
    if (!src) return
    const key = sourceKey(src.source)
    a.missed ??= { provider: src.provider, format: src.format, noAnswer: NO_ANSWER.test(message) }
    const folder = NO_ANSWER.test(message) ? Player.folderOf(src) : null
    if (folder) {
      this.unreachable.set(folder, this.now() + UNREACHABLE_MS)
      if (this.unreachable.size > 200) this.unreachable.delete(this.unreachable.keys().next().value!)
      // The preloaded next track waits on the same server (the album's next file): drop it, so the
      // next preload looks for it elsewhere while this one plays, not when it's due.
      const pre = this.pre
      const armed = pre && pre !== a ? pre.sources[pre.srcIdx] : undefined
      if (armed && Player.folderOf(armed) === folder) this.clearPreload()
    }
    // A remote URL refused with 401/403/410 has usually just gone stale (expired, or bound to an IP
    // this machine no longer has): drop it from this attempt and re-resolve once, which fetches a
    // fresh URL under the same key, before treating the source as broken.
    const retryKey = `${a.trackId}\u0000${key}`
    const now = this.now()
    const last = this.refreshed.get(retryKey)
    if (src.source.kind === 'http' && src.provider !== 'download' && ACCESS_DENIED.test(message) && (last == null || now - last > REFRESH_AGAIN_MS)) {
      this.refreshed.set(retryKey, now)
      if (this.refreshed.size > 2000) this.refreshed.clear()
      // Drop it and everything ranked below: the next step re-resolves right away (the fresh URL
      // comes back first) instead of trying lower-ranked copies before the refresh.
      a.sources.splice(a.srcIdx)
      a.srcIdx--
      a.remoteResolved = false
    } else this.failedSet(a.trackId).add(key)
    if (src.provider === 'download') return // our own file; nothing for the catalog to learn
    try {
      this.catalog.markSourceFailed(a.trackId, key, message)
    } catch (e) {
      console.error('[player] markSourceFailed failed:', e)
    }
  }

  private setSourceSummary(uid: string, src: ResolvedSource, missed?: SourceMiss): void {
    const i = this.s.queue.findIndex((q) => q.uid === uid)
    if (i < 0) return
    const q = this.s.queue[i]
    const summary = summaryOf(src, missed)
    // Unchanged (a replay, a fallback to an equivalent source): keep the queue's identity, so the
    // (possibly long) queue isn't re-sent to the renderer.
    if (sameSummary(q.track.source, summary)) return
    this.s.queue = this.s.queue.slice()
    this.s.queue[i] = { ...q, track: { ...q.track, source: summary } }
  }

  /** The visible wait of an attempt (the current track's or the preview's; a preload has none). */
  private waitOf(a: Attempt): WaitTracker | null {
    return a === this.cur ? this.curWait : a === this.pv ? this.pvWait : null
  }

  /**
   * Say so when a track plays from a backup because its own source failed: once per queue item, on
   * one card per failed source (an album whose server is down updates that card track by track).
   */
  private noticeBackup(a: Attempt, src: ResolvedSource): void {
    if (!isBackup(a.missed, src) || this.backupNoticed.has(a.id)) return
    if (this.backupNoticed.size > 500) this.backupNoticed.clear()
    this.backupNoticed.add(a.id)
    this.notify('info', `“${a.track.title}” is playing from a backup`, backupReason(a.missed, src), a.track.cover, undefined, `player-backup-${a.missed.provider}`)
  }

  // ===========================================================================
  // Loading

  private setCurrentItem(item: QueueItem): void {
    let analysis: TrackAnalysis | null | undefined
    try {
      analysis = this.catalog.peekAnalysis?.(item.track.id)
    } catch {
      analysis = null
    }
    this.s.currentAnalysis = analysis ?? null
    // Not known in this process yet: ask the catalog (async) and fill it in if still current.
    if (analysis === undefined) this.loadAnalysis(item)
    this.s.durationMs = this.infoDuration.get(item.uid) ?? item.track.durationMs ?? null
    this.s.error = null
    // A new track starts with every voice audible (the engine's mask is global).
    const names = this.infoVoices.get(item.uid)
    this.s.voices = names ? { names, mask: VOICES_ALL_ON } : null
    this.resetVoiceMask()
  }

  private loadAnalysis(item: QueueItem): void {
    this.catalog
      .getAnalysis(item.track.id)
      .then((a) => {
        if (!a || this.s.currentAnalysis || this.item()?.uid !== item.uid) return
        this.s.currentAnalysis = a
        this.changed()
      })
      .catch(() => {})
  }

  private resetVoiceMask(): void {
    if (this.engineMask === 0n) return
    this.engineMask = 0n
    this.safe(() => this.engine.setVoiceMask?.(0n))
  }

  private loadIndex(i: number, autoplay: boolean, startMs = 0): Promise<void> {
    return this.track(this.doLoad(i, autoplay, startMs))
  }

  private async doLoad(i: number, autoplay: boolean, startMs: number): Promise<void> {
    const item = this.item(i)
    if (!item) return this.stopAtEnd()
    const seq = ++this.loadSeq
    const wasAudible = !!this.cur?.loaded && (this.s.status === 'playing' || this.s.status === 'buffering')
    // What replaces an item a preview paused (a queue edit, a failed source) waits for it too.
    if (this.held()) {
      this.hold = { seq }
      autoplay = false
    }
    // Reuse the preloaded next's sources when the user skips to it.
    const reuse = this.pre && this.pre.id === item.uid && this.pre.sources.length ? this.pre : null
    // From its start, setCurrent promotes the engine's armed `next` (already decoding): cancelling
    // it first would throw that audio away and open the source again.
    if (reuse?.armed && startMs <= 0) this.dropPreload()
    else this.clearPreload()
    // The old track's play ends here, against its own length (before the new one's is installed).
    this.finishPlay()
    this.s.queueIndex = i
    this.setCurrentItem(item)
    this.s.positionMs = Math.max(0, startMs)
    this.curWait = new WaitTracker(`${item.uid}:${seq}`, this.typical, this.now)
    this.setStatus('loading')
    this.beginPlay(item)
    const cur: Current = {
      id: item.uid,
      trackId: item.track.id,
      track: item.track,
      sources: reuse ? reuse.sources : [],
      srcIdx: reuse ? Math.max(-1, reuse.srcIdx - 1) : -1,
      remoteResolved: reuse ? reuse.remoteResolved : false,
      missed: reuse?.missed,
      lastError: null,
      seq,
      autoplay,
      loaded: false,
      startMs: Math.max(0, startMs)
    }
    this.cur = cur
    this.mark('play:load')
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
      this.mark('play:resolved')
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
        this.engineSetCurrent(this.engineTrack(cur.id, cur.track, src), cur.startMs, cur.autoplay)
      } catch (e) {
        this.markFailed(cur, (e as Error)?.message ?? String(e))
        continue
      }
      cur.loaded = true
      this.mark('play:engine-set')
      this.seekHold = null
      this.engineState = 'loading'
      this.uidTrack.set(cur.id, cur.trackId)
      this.setSourceSummary(cur.id, src, cur.missed)
      this.noticeBackup(cur, src)
      this.curWait?.opened(src.provider)
      this.syncWaitPoll()
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
    const giveUp = !nextItem || this.failStreak.has(nextItem.uid) || this.failStreak.size >= MAX_FAIL_STREAK || !(cur.autoplay || this.held())
    if (giveUp) {
      const streak = this.failStreak.size
      this.failStreak.clear()
      this.cur = null
      this.clearPreload()
      this.safe(() => this.engineStop())
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
    this.safe(() => this.engineStop())
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
    if (this.pre?.armed) this.safe(() => this.engineSetNext(null))
    this.pre = null
  }

  /** Forget the preload but leave the engine's `next` armed: a setCurrent is about to take it over. */
  private dropPreload(): void {
    this.preSeq++
    this.pre = null
    // Overtaken by that setCurrent: a late 'advanced' into it is stale.
    this.armedNext = null
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
        this.safe(() => this.engineSetNext(null))
      }
      return
    }
    if (this.pre && this.pre.id === item.uid) {
      if (force && this.pre.armed) {
        const src = this.pre.sources[this.pre.srcIdx]
        if (src) this.safe(() => this.engineSetNext(this.engineTrack(item.uid, item.track, src)))
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
    this.safe(() => this.engineSetNext(null))
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
      this.engineSetNext(this.engineTrack(pre.id, pre.track, src))
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
          return this.onTrackInfo(e)
        case 'buffering':
          return this.onBuffering(e.id, e.buffering)
        case 'error':
          return this.onError(e.id, e.message, e.recoverable)
        case 'analysis':
          return this.onAnalysis(e.id, e.result)
        case 'previewEnded':
          return this.onPreviewEnded(e.id)
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
        if (this.audibleMarked !== cur.seq) {
          this.audibleMarked = cur.seq
          this.mark('play:playing')
        }
        break
      case 'paused':
        this.setStatus('paused')
        break
      case 'loading':
        if (this.s.status !== 'paused') this.setStatus('loading')
        break
      case 'buffering':
        this.curWait?.stalled()
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
    if (buffering) {
      this.curWait?.stalled()
      this.setStatus('buffering')
    } else this.setStatus(this.engineState === 'paused' || !cur.autoplay ? 'paused' : 'playing')
    this.changed()
  }

  private onTrackInfo(info: EngineTrackInfo): void {
    const { id, durationMs } = info
    // No length for a track with loop points: it loops endlessly now (a loop setting changed mid-track)
    const endless = durationMs == null && info.loopEndMs != null
    if (durationMs && durationMs > 0) this.infoDuration.set(id, durationMs)
    else if (endless) this.infoDuration.delete(id)
    const count = Math.min(MAX_VOICES, Math.max(0, Math.floor(info.voiceCount ?? 0)))
    const names = count > 0 ? Array.from({ length: count }, (_, i) => info.voiceNames?.[i]?.trim() || `Voice ${i + 1}`) : null
    if (names) this.infoVoices.set(id, names)
    else this.infoVoices.delete(id)
    if (this.cur?.id !== id) return
    // (Metadata isn't playback: the failure streak only resets once audio plays, see onState.)
    if ((durationMs && durationMs > 0) || endless) {
      this.s.durationMs = endless ? null : durationMs
      if (this.account?.trackId === this.cur.trackId) this.account.durationMs = endless ? null : durationMs
    }
    const prev = this.s.voices
    if (!names) this.s.voices = null
    else if (!prev || prev.names.length !== names.length || prev.names.some((n, i) => n !== names[i])) this.s.voices = { names, mask: VOICES_ALL_ON }
    // A fallback source without (or with different) voices must not inherit a stale mask.
    if (!this.s.voices || this.s.voices.mask === VOICES_ALL_ON) this.resetVoiceMask()
    this.changed()
  }

  // Engine transport commands go through these so we always know which item (if any) the engine
  // may advance into. An `advanced` event for anything else was overtaken by a later load or stop
  // (the engine emitted it just before our command arrived) and must not override that load.
  private armedNext: string | null = null
  private engineSetNext(t: EngineTrack | null): void {
    this.engine.setNext(t)
    this.armedNext = t?.id ?? null
  }
  private engineSetCurrent(t: EngineTrack, startMs: number, autoplay: boolean): void {
    this.armedNext = null
    this.engine.setCurrent(t, startMs, autoplay)
  }
  private engineStop(): void {
    this.armedNext = null
    this.engine.stop()
  }

  private onAdvanced(id: string): void {
    if (id !== this.armedNext) return // superseded by a newer setCurrent / setNext / stop
    this.armedNext = null
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
      missed: pre?.missed,
      lastError: null,
      seq: this.loadSeq,
      autoplay: true,
      loaded: true,
      startMs: 0
    }
    if (pre) {
      const src = pre.sources[pre.srcIdx]
      if (src) {
        this.setSourceSummary(id, src, pre.missed)
        this.noticeBackup(this.cur, src)
      }
    }
    this.uidTrack.set(id, item.track.id)
    this.curWait = WaitTracker.playing(`${id}:${this.loadSeq}`, this.typical, this.now)
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
      } else this.stopPreviewNow()
      return
    }
    const cur = this.cur
    const pre = this.pre
    if (recoverable && pre && id === pre.id && (!cur || cur.id !== id)) {
      if (!pre.armed) return // already falling back
      // The preloaded next failed while buffering: re-arm it with its next source.
      this.markFailed(pre, message)
      pre.armed = false
      this.safe(() => this.engineSetNext(null))
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
      ;(this.curWait ??= new WaitTracker(`${cur.id}:${cur.seq}`, this.typical, this.now)).fallback(cur.missed && missReason(cur.missed))
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
      full = this.catalog.peekAnalysis?.(trackId) ?? null
    } catch {
      full = null
    }
    full ??= analysisFromResult(result)
    const summary: TrackAnalysisSummary = { bpm: full.bpm, intensity: full.intensity, lufs: full.lufs }
    let touched = false
    let queueTouched = false
    const queue = this.s.queue.map((q) => {
      if (q.track.id !== trackId || sameAnalysis(q.track.analysis, summary)) return q
      queueTouched = true
      return { ...q, track: { ...q.track, analysis: summary } }
    })
    // Only a real change replaces the queue (and so re-sends it).
    if (queueTouched) {
      this.s.queue = queue
      touched = true
    }
    if (this.item()?.track.id === trackId) {
      this.s.currentAnalysis = full
      touched = true
    }
    if (this.s.preview && this.s.preview.track.id === trackId && !sameAnalysis(this.s.preview.track.analysis, summary)) {
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
        if (p.id === cur.id && p.playing && this.s.status === 'loading') {
          this.failStreak.clear()
          this.setStatus('playing')
        }
      } catch {
        /* ignore */
      }
    }
    this.checkPlay()
    if (this.s.status === 'playing' || this.s.status === 'buffering') {
      // The renderer extrapolates the position itself: only correct it when it's off.
      if (this.rendererStale()) this.changed()
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
      queue: this.sessionQueue(),
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

  /** Same array while the queue is: the session store reuses its JSON (see FileSessionStore). */
  private sessionQueue(): SessionData['queue'] {
    if (this.savedQueue?.of !== this.s.queue) this.savedQueue = { of: this.s.queue, items: this.s.queue.map((q) => ({ uid: q.uid, trackId: q.track.id })) }
    return this.savedQueue.items
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
    if (this.originalOrder) {
      const known = new Set(this.originalOrder)
      for (const q of queue) if (!known.has(q.uid)) this.originalOrder.push(q.uid)
    }
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
    // A new queue array is a full queue resend to the window: only when an item changed.
    const queue = this.s.queue.map((q) => {
      if (!ids.has(q.track.id)) return q
      const t = this.library.decorateOne(q.track)
      if (t === q.track) return q
      touched = true
      return { ...q, track: t }
    })
    if (touched) this.s.queue = queue
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

  private setQueue(tracks: TrackView[], start: number, context: PlayContext | null, autoplay = true): Promise<void> {
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
    this.endPreviewForMain()
    const loading = this.loadIndex(startIdx, autoplay, 0)
    // After the first track's own resolve went out (it stays ahead: the warm-up is background priority).
    this.warmUpcoming(startIdx)
    return loading
  }

  /**
   * Ask the catalog to resolve the next WARM_AHEAD tracks' sources now (fire-and-forget, background
   * priority): the preload only reaches for the next track once the first has started, so a quick
   * skip, or two, would otherwise wait on a page request for each. Downloaded tracks need nothing.
   */
  private warmUpcoming(from: number): void {
    if (!this.catalog.warmSources) return
    const ids: ID[] = []
    for (let i = from + 1; i < this.s.queue.length && ids.length < WARM_AHEAD; i++) {
      const t = this.s.queue[i].track
      if (!t.downloaded && !ids.includes(t.id)) ids.push(t.id)
    }
    if (!ids.length) return
    try {
      this.catalog.warmSources(ids)
    } catch (e) {
      console.error('[player] warmSources failed:', e)
    }
  }

  // ===========================================================================
  // PlayerAPI

  async getState(): Promise<PlayerState> {
    return this.snapshot()
  }

  /**
   * A user request for a new queue: `lookup` finds its tracks, then `queue` says what to play. The
   * lookups take their time (an album's track list may come from the network), so they resolve in
   * any order: only the latest request plays (see `request`).
   */
  private async requestQueue<T>(lookup: () => Promise<T>, queue: (found: T) => [TrackView[], number, PlayContext | null]): Promise<void> {
    this.mark('play:request')
    const req = (this.request = { autoplay: true })
    try {
      const found = await lookup()
      if (req !== this.request) return
      const [tracks, start, context] = queue(found)
      void this.setQueue(tracks, start, context, req.autoplay)
    } finally {
      if (this.request === req) this.request = null
    }
  }

  async playTracks(trackIds: ID[], startIndex = 0, context?: PlayContext): Promise<void> {
    const ids = (trackIds ?? []).filter((x) => typeof x === 'string')
    return this.requestQueue(
      () => this.library.fetchTracks(ids),
      (tracks) => {
        const found = new Set(tracks.map((t) => t.id))
        return [tracks, ids.slice(0, Math.max(0, startIndex)).filter((id) => found.has(id)).length, context ?? null]
      }
    )
  }

  async playAlbum(albumId: ID, startIndex = 0): Promise<void> {
    return this.requestQueue(
      () => this.catalog.album(albumId),
      (detail) => [detail.tracks.map((t) => this.library.decorateOne(t)), startIndex, { kind: 'album', id: albumId, title: detail.album.title }]
    )
  }

  async playPlaylist(playlistId: ID, startIndex = 0): Promise<void> {
    return this.requestQueue(
      () => this.deps.playlists.get(playlistId),
      (detail) => [detail.items.map((i) => i.track), startIndex, { kind: 'playlist', id: playlistId, title: detail.playlist.name }]
    )
  }

  async toggle(): Promise<void> {
    const st = this.s.status
    const wantsPlay = st === 'playing' || st === 'buffering' || (st === 'loading' && !!this.cur?.autoplay)
    return wantsPlay ? this.pause() : this.play()
  }

  async play(): Promise<void> {
    // A new queue still being looked up starts playing.
    if (this.request) this.request.autoplay = true
    if (!this.s.queue.length) return
    this.endPreviewForMain()
    this.resume()
  }

  /** Make the current item audible, loading it if need be. */
  private resume(): void {
    if (this.s.queueIndex < 0) {
      void this.loadIndex(0, true, 0)
      return
    }
    const cur = this.cur
    if (cur?.loaded) {
      // The transport intent: a source failing from here on falls back to another one playing.
      cur.autoplay = true
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
    // Paused on purpose: a running preview no longer hands playback back when it ends, and a new
    // queue still being looked up starts paused.
    this.hold = null
    if (this.request) this.request.autoplay = false
    this.pauseMain()
    this.scheduleSave()
  }

  private pauseMain(): void {
    const cur = this.cur
    if (cur?.loaded) {
      cur.autoplay = false
      this.safe(() => this.engine.pause())
      this.refreshPosition()
      this.setStatus('paused')
    } else if (cur) {
      cur.autoplay = false
    } else if (this.s.status === 'playing') {
      this.setStatus('paused')
    }
    this.changed()
  }

  /** Whether a skip should start playing (a queue paused only for a preview counts as playing). */
  private keepPlaying(): boolean {
    return this.s.status !== 'paused' || this.hold !== null
  }

  async next(): Promise<void> {
    if (!this.s.queue.length) return
    this.mutations++
    const ni = this.naturalNext()
    if (ni === null) return this.stopAtEnd()
    const play = this.keepPlaying()
    if (play) this.endPreviewForMain()
    void this.loadIndex(ni, play, 0)
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
    const play = this.keepPlaying()
    if (play) this.endPreviewForMain()
    void this.loadIndex(i > 0 ? i - 1 : n - 1, play, 0)
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
    this.changed(false)
    this.scheduleSave()
  }

  async setVolume(volume: number): Promise<void> {
    const v = Math.max(0, Math.min(1, Number(volume) || 0))
    this.s.volume = v
    this.safe(() => this.engine.setVolumeDb(sliderToDb(v)))
    this.changed(false)
    this.scheduleSave()
  }

  async setMuted(muted: boolean): Promise<void> {
    this.s.muted = !!muted
    this.safe(() => this.engine.setMuted(this.s.muted))
    this.changed(false)
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
      this.safe(() => this.engineStop())
      this.s.queueIndex = -1
      this.s.currentAnalysis = null
      this.s.voices = null
      this.resetVoiceMask()
      this.s.durationMs = null
      this.s.positionMs = 0
      this.s.context = null
      this.originalOrder = null
      this.setStatus('idle')
      this.changed()
      this.scheduleSave()
      return
    }
    // A queue a preview paused still plays: its replacement loads held (see doLoad).
    const wasActive = this.held() || this.s.status === 'playing' || this.s.status === 'buffering' || (this.s.status === 'loading' && !!this.cur?.autoplay)
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
    this.safe(() => this.engineStop())
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
    this.endPreviewForMain()
    void this.loadIndex(index, true, 0)
  }

  // ---------------------------------------------------------------------------
  // Progress from the catalog (see catalog/progress.ts)

  /** The catalog went to the network to resolve a track (services.ts forwards these from the worker). */
  onResolveStep(step: ResolveStep): void {
    let changed = false
    const cur = this.cur
    if (cur && !cur.loaded && cur.trackId === step.trackId && this.curWait) changed = this.curWait.onResolveStep(step) || changed
    const pv = this.pv
    if (pv && pv.trackId === step.trackId && this.pvWait) changed = this.pvWait.onResolveStep(step) || changed
    if (changed) this.changed(false)
  }

  /** A tool the catalog needs (yt-dlp) is being installed: it holds up whatever resolves meanwhile. */
  onToolProgress(p: ToolProgress): void {
    let changed = false
    if (this.cur && !this.cur.loaded && this.curWait) changed = this.curWait.onTool(p) || changed
    if (this.pv && this.pvWait) changed = this.pvWait.onTool(p) || changed
    if (changed) this.changed(false)
  }

  /** Ask the engine what the opening / buffering tracks wait on, only while one does. */
  private syncWaitPoll(): void {
    const st = this.s.status
    const cur = this.cur
    const curWaits = !!(cur?.loaded && this.curWait && (st === 'loading' || st === 'buffering'))
    const pvWaits = !!(this.pv && this.pvWait?.phaseName === 'open' && !this.pvStarted)
    const want = !!this.engine.loadProgress && (curWaits || pvWaits) && !this.disposed
    if (want && !this.waitTimer) {
      this.waitTimer = setInterval(() => this.pollWaits(), WAIT_POLL_MS)
      this.waitTimer.unref?.()
    } else if (!want && this.waitTimer) {
      clearInterval(this.waitTimer)
      this.waitTimer = null
    }
  }

  /** One engine query per waiting slot; broadcasts only when what the UI shows changed. */
  pollWaits(): void {
    let changed = false
    const st = this.s.status
    const cur = this.cur
    if (cur?.loaded && this.curWait && (st === 'loading' || st === 'buffering')) {
      const w = this.engineWait('current', cur.id)
      if (w) changed = this.curWait.poll(w) || changed
    }
    const pv = this.pv
    if (pv && this.pvWait?.phaseName === 'open' && !this.pvStarted) {
      const w = this.engineWait('preview', pv.id)
      // No report for it yet (the engine hasn't taken it up): wait a little, then assume it plays.
      if (w ? w.started : ++this.pvMisses >= PREVIEW_UNKNOWN_POLLS) changed = this.previewAudible() || changed
      else if (w) changed = this.pvWait.poll(w) || changed
    }
    if (changed) this.changed(false)
    this.syncWaitPoll()
  }

  private engineWait(which: 'current' | 'preview', id: string): EngineWait | null {
    try {
      const w = this.engine.loadProgress?.(which)
      return w && w.id === id ? w : null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Previews

  /** Where a preview starts: the first kiai section if analysed, else 35% in. */
  async previewPoint(track: TrackView): Promise<number> {
    let a: TrackAnalysis | null = null
    try {
      a = this.catalog.peekAnalysis?.(track.id) ?? (await this.catalog.getAnalysis(track.id))
    } catch {
      a = null
    }
    if (a?.kiai?.length) return Math.max(0, Math.round(a.kiai[0][0] * 1000))
    return track.durationMs ? Math.round(track.durationMs * 0.35) : 0
  }

  /** Resolves true once the preview is playing, false if it was superseded or had no playable source. */
  async preview(trackId: ID, startMs?: number): Promise<boolean> {
    const seq = ++this.pvSeq
    this.pvPending = seq
    let track: TrackView | undefined
    try {
      ;[track] = await this.library.fetchTracks([trackId])
    } finally {
      if (this.pvPending === seq) this.pvPending = 0
      // Nothing to play after all: give back the hold an older preview that ended meanwhile left it.
      if (!track && seq === this.pvSeq && !this.pv) this.releaseHold()
    }
    if (!track || seq !== this.pvSeq) return false
    const pv: Preview = {
      id: `preview:${seq}:${trackId}`,
      trackId,
      track,
      sources: [],
      srcIdx: -1,
      remoteResolved: false,
      lastError: null,
      seq,
      startMs: typeof startMs === 'number' && startMs >= 0 ? startMs : 0
    }
    this.pv = pv
    this.pvWait = new WaitTracker(pv.id, this.typical, this.now)
    this.pvStarted = false
    this.changed(false)
    // The start point may need the analysis from the catalog worker: look it up while resolving.
    const point = typeof startMs === 'number' && startMs >= 0 ? null : this.previewPoint(track)
    try {
      const r = await this.resolveInitial(trackId)
      pv.sources = r.sources
      pv.remoteResolved = r.remoteResolved
    } catch (e) {
      pv.lastError = (e as Error)?.message ?? String(e)
      pv.remoteResolved = true
    }
    if (point) pv.startMs = await point
    if (pv !== this.pv || pv.seq !== this.pvSeq) return false
    return this.startPreviewSource(pv)
  }

  private async startPreviewSource(pv: Preview): Promise<boolean> {
    for (;;) {
      const src = await this.nextSource(pv, false) // a preview never waits on a fallback search
      // A newer preview() call (still fetching its track, so not yet in this.pv) supersedes this one.
      if (pv !== this.pv || pv.seq !== this.pvSeq) return false
      if (!src) {
        // An earlier preview may still be sounding (this one replaced it before reaching the engine).
        this.stopPreviewNow()
        return false
      }
      try {
        this.engine.preview(this.engineTrack(pv.id, pv.track, src), pv.startMs)
      } catch (e) {
        this.markFailed(pv, (e as Error)?.message ?? String(e))
        continue
      }
      this.uidTrack.set(pv.id, pv.trackId)
      this.s.preview = { track: pv.track, startedAt: this.now() }
      this.pvWait?.opened(src.provider)
      this.pvMisses = 0
      // The queue keeps playing until the preview is actually audible (then one fades into the other).
      if (!this.engine.loadProgress || this.engineWait('preview', pv.id)?.started) this.previewAudible()
      this.syncWaitPoll()
      this.changed()
      return true
    }
  }

  /** The engine started the preview: it no longer loads, and it takes over from the queue. */
  private previewAudible(): boolean {
    if (this.pvStarted) return false
    this.pvStarted = true
    this.holdForPreview()
    return true
  }

  /**
   * A preview took the speakers while the queue was audible (or about to be): pause the queue
   * until the preview ends. The engine fades one out as the other fades in.
   */
  private holdForPreview(): void {
    const cur = this.cur
    if (!cur || this.hold) return
    const st = this.s.status
    if (!(st === 'playing' || st === 'buffering' || (st === 'loading' && cur.autoplay))) return
    this.hold = { seq: cur.seq }
    this.pauseMain()
  }

  /** A preview paused the current item (not the user): it plays again when the preview ends. */
  private held(): boolean {
    return !!this.hold && !!this.cur && this.hold.seq === this.cur.seq
  }

  /**
   * The preview is over: resume what it paused, unless the user has since taken over. Not play():
   * nothing the user did, so a newer preview still on its way isn't cancelled.
   */
  private releaseHold(): void {
    const h = this.hold
    this.hold = null
    if (!h || this.disposed || this.cur?.seq !== h.seq || this.s.status === 'playing') return
    this.resume()
  }

  /**
   * The user made the queue audible (play, skip, a new queue): end any preview (and any pending
   * one) without resuming a hold. Automatic advances don't: a preview can't sound alongside them
   * (it would have paused the queue), and one still loading pauses them when it starts.
   */
  private endPreviewForMain(): void {
    this.hold = null
    this.pvSeq++
    if (!this.pv && !this.s.preview) return
    this.pv = null
    this.pvWait = null
    this.safe(() => this.engine.stopPreview())
    this.s.preview = null
    this.changed()
  }

  private clearPreviewState(): void {
    const had = !!(this.pv || this.s.preview)
    this.pv = null
    this.pvWait = null
    this.s.preview = null
    if (had) this.changed()
    this.syncWaitPoll()
    // A newer preview still fetching its track takes the hold over: it plays in a moment.
    const successor = this.pvPending !== 0 && this.pvPending === this.pvSeq
    if (!successor) this.releaseHold()
  }

  private onPreviewEnded(id: string | undefined): void {
    // Ended after a newer preview had already started (the event was in flight): not ours.
    if (id && this.pv && id !== this.pv.id) return
    this.clearPreviewState()
  }

  private stopPreviewNow(): void {
    this.safe(() => this.engine.stopPreview())
    this.clearPreviewState()
  }

  async stopPreview(): Promise<void> {
    this.pvSeq++
    this.stopPreviewNow()
  }

  async setOverlayFilter(active: boolean): Promise<void> {
    this.safe(() => this.engine.setOverlayFilter(!!active))
  }

  async setVoiceMask(mask: VoiceMask): Promise<void> {
    const v = this.s.voices
    if (!v || !this.item()) return
    // Bits past the last voice are dropped; anything that isn't a mask unmutes all.
    const m = (parseVoiceMask(mask) ?? 0n) & allVoices(v.names.length)
    const hex = formatVoiceMask(m)
    if (hex === v.mask && m === this.engineMask) return
    this.s.voices = { names: v.names, mask: hex }
    this.engineMask = m
    this.safe(() => this.engine.setVoiceMask?.(m))
    this.changed()
  }

  async setAnalysisDemand(on: boolean): Promise<void> {
    this.safe(() => this.engine.setAnalysisDemand?.(!!on))
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
    if (this.waitTimer) clearInterval(this.waitTimer)
    this.waitTimer = null
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
  }
}
