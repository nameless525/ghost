// What a loading / buffering track is waiting on, as a Progress for PlayerState.loading (and
// previewLoading). One wait runs through steps on a single monotonic bar:
//
//   resolve [0, RESOLVE_END)  finding a source: the catalog's network steps (catalog/progress.ts),
//                             estimated from how long that provider usually takes
//   open    [RESOLVE_END, 1]  the engine opening it: connecting, then the whole file (chip formats,
//                             archives) or the first audio, measured from engine.loadProgress()
//
// A stall mid-track or a fallback to another source starts a new wait (the bar restarts).
import type { Progress } from '../../shared/types'
import type { ResolveStep, ToolProgress } from '../catalog/progress'

/** End of the resolve span on the bar. */
export const RESOLVE_END = 0.65

/** The fields of the engine's EngineLoadProgress this module reads (engine/types.ts). */
export interface EngineWait {
  started: boolean
  connected: boolean
  bytes: number
  totalBytes: number | null
  wholeFile: boolean
  bufferedMs: number
  targetMs: number
  stalledMs: number
  stallTimeoutMs: number
}

/** A stall is called out (and the fallback countdown shown) once the reader has waited this long. */
const STALL_NOTICE_MS = 1500

/** Typical step lengths (ms), learned per provider and step (an exponential moving average). */
export class Typical {
  private ms = new Map<string, number>()
  /** Provider display names, as the catalog's resolve steps report them. */
  readonly names = new Map<string, string>()

  static defaultFor(key: string): number {
    const [kind, provider] = key.split(':')
    if (kind === 'stream') {
      if (provider === 'youtube') return 4500
      if (provider === 'soundcloud') return 9000
      if (provider === 'bandcamp') return 1500
      return 800
    }
    if (kind === 'search') {
      if (provider === 'youtube') return 7000
      if (provider === 'soundcloud') return 9000
      return 2500
    }
    if (kind === 'connect') return 600
    if (kind === 'find') return 300
    return 1000
  }

  get(key: string): number {
    return this.ms.get(key) ?? Typical.defaultFor(key)
  }

  /** One measurement moves the estimate 30 % of the way (from the default at first): one quick or slow run doesn't decide it. */
  record(key: string, ms: number): void {
    if (!(ms > 0) || ms > 120_000) return
    const prev = this.get(key)
    this.ms.set(key, prev * 0.7 + Math.max(100, ms) * 0.3)
  }
}

const MB = 1024 * 1024
export function formatBytes(n: number): string {
  if (n >= 100 * MB) return `${Math.round(n / MB)} MB`
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

/** "1.2 of 4.5 MB" (one unit when both share it). */
export function formatBytesOf(done: number, total: number): string {
  const a = formatBytes(done)
  const b = formatBytes(total)
  const unit = b.slice(b.lastIndexOf(' '))
  return a.endsWith(unit) ? `${a.slice(0, -unit.length)} of ${b}` : `${a} of ${b}`
}

type Phase = 'resolve' | 'open' | 'playing' | 'buffer'

/**
 * One track's waits (the current track, or a preview). The player feeds it what happens; `progress()`
 * is what the UI shows. Changes report true so the player knows when to broadcast.
 */
export class WaitTracker {
  private phase: Phase = 'resolve'
  private step: Progress
  private stepKey: string
  private stepAt: number
  private waitN = 0
  private wait: string
  /** The part of the bar the one-time tool install takes, while it runs. */
  private toolSpan: [number, number] | null = null

  constructor(
    private readonly id: string,
    private readonly typical: Typical,
    private readonly now: () => number
  ) {
    this.wait = `${id}#0`
    this.stepAt = now()
    this.stepKey = 'find'
    this.step = this.make('Finding a source', null, null, typical.get('find'), [0, RESOLVE_END])
  }

  /** A tracker for a track that is already audible (a gapless advance): only stalls show. */
  static playing(id: string, typical: Typical, now: () => number): WaitTracker {
    const w = new WaitTracker(id, typical, now)
    w.stepKey = ''
    w.phase = 'playing'
    return w
  }

  get phaseName(): Phase {
    return this.phase
  }

  progress(): Progress {
    return this.step
  }

  private make(label: string, detail: string | null, fraction: number | null, expectMs: number | null, span: [number, number]): Progress {
    return { label, detail, fraction, expectMs, since: this.now(), span, wait: this.wait }
  }

  /** Close the running step's timing (it feeds the typical length of its kind). */
  private endStep(): void {
    if (this.stepKey) this.typical.record(this.stepKey, this.now() - this.stepAt)
    this.stepKey = ''
  }

  private begin(key: string, p: Progress): void {
    this.endStep()
    this.stepKey = key
    this.stepAt = this.now()
    this.step = p
  }

  /** The catalog went to the network for this track. */
  onResolveStep(s: ResolveStep): boolean {
    if (this.phase !== 'resolve') return false
    const key = `${s.kind}:${s.provider}`
    const name = s.providerName || s.provider
    if (s.providerName) this.typical.names.set(s.provider, s.providerName)
    const label =
      s.kind === 'search'
        ? `Searching ${name} for this track`
        : s.provider === 'youtube'
          ? 'Getting the stream from YouTube'
          : s.provider === 'soundcloud'
            ? 'Downloading from SoundCloud'
            : `Getting the track from ${name}`
    const fraction = s.fraction != null && Number.isFinite(s.fraction) ? Math.max(0, Math.min(1, s.fraction)) : null
    if (key === this.stepKey) {
      // Progress within the same step (a whole-track download measuring itself).
      if (this.step.fraction === fraction && this.step.detail === (s.detail ?? null)) return false
      this.step = { ...this.step, fraction, detail: s.detail ?? null, expectMs: fraction == null ? this.step.expectMs : null }
      return true
    }
    this.begin(key, this.make(label, s.detail ?? null, fraction, fraction == null ? this.typical.get(key) : null, [this.spanStart(), RESOLVE_END]))
    return true
  }

  /** The one-time yt-dlp download (it blocks any YouTube / SoundCloud step). */
  onTool(p: ToolProgress): boolean {
    if (this.phase !== 'resolve') return false
    if (p.done) {
      if (!this.toolSpan) return false
      // Installed: the step it held up goes on, after the install's part of the bar. Failed: the
      // catalog moves on to other sources.
      const from = this.toolSpan[1]
      this.toolSpan = null
      const key = p.error ? 'find' : 'stream:youtube'
      this.begin(key, this.make(p.error ? 'Trying other sources' : 'Getting the stream', null, null, this.typical.get(key), [from, RESOLVE_END]))
      return true
    }
    // Not a step of any provider: nothing to learn from it. Its span is fixed when it starts.
    if (!this.toolSpan) {
      this.endStep()
      const a = this.spanStart()
      this.toolSpan = [a, a + (RESOLVE_END - a) * 0.85]
    }
    this.stepKey = ''
    const [a, b] = this.toolSpan
    // The download is measured; the first run that checks it works takes a few seconds at the end.
    const cut = a + (b - a) * 0.88
    const check = p.phase === 'check'
    const fraction = check ? null : p.fraction
    const label = 'Setting up YouTube support (one-time)'
    const next = this.make(label, p.detail ?? null, fraction, fraction == null ? (check ? 3000 : 15_000) : null, check ? [cut, b] : [a, cut])
    if (this.step.label === label && this.step.detail === next.detail && this.step.fraction === next.fraction && this.step.span?.[0] === next.span?.[0]) return false
    // Same step, more bytes: keep its start time (an estimate would otherwise restart).
    if (this.step.label === label && this.step.span?.[0] === next.span?.[0]) next.since = this.step.since
    this.step = next
    return true
  }

  /** Where a new resolve step starts on the bar: a little past the previous one, so the bar keeps moving. */
  private spanStart(): number {
    const prev = this.step.span ?? [0, RESOLVE_END]
    return Math.max(prev[0], Math.min(RESOLVE_END * 0.8, prev[0] + (RESOLVE_END - prev[0]) * 0.35))
  }

  /** A source was handed to the engine; `provider` is the one it comes from. */
  opened(provider: string): boolean {
    this.toolSpan = null
    this.phase = 'open'
    const local = provider === 'download' || provider === 'local'
    const name = this.typical.names.get(provider)
    const key = local ? 'open:local' : 'connect'
    this.begin(key, this.make(local ? 'Opening the file' : name ? `Connecting to ${name}` : 'Connecting', null, null, local ? 200 : this.typical.get(key), [RESOLVE_END, 1]))
    return true
  }

  /** The track is audible: a later stall is a new wait. */
  playing(): void {
    if (this.phase === 'resolve') return
    this.endStep()
    this.phase = 'playing'
  }

  /** Playback stalled mid-track (status 'buffering'): a new wait. */
  stalled(): boolean {
    // While still opening, the open step's own progress covers it.
    if (this.phase !== 'playing') return false
    this.endStep()
    this.phase = 'buffer'
    this.wait = `${this.id}#${++this.waitN}`
    this.stepKey = ''
    this.step = this.make('Buffering', null, 0, null, [0, 1])
    return true
  }

  /** The source failed; the player moves to the next one (re-resolving if needed): a new wait. */
  fallback(): boolean {
    this.endStep()
    this.phase = 'resolve'
    this.wait = `${this.id}#${++this.waitN}`
    this.stepKey = ''
    this.step = this.make('Trying another source', null, null, this.typical.get('find'), [0, RESOLVE_END])
    return true
  }

  /** Engine progress while opening or buffering. Returns whether what the UI shows changed. */
  poll(w: EngineWait | null): boolean {
    if (!w || this.phase === 'resolve' || this.phase === 'playing') return false
    let label: string
    let detail: string | null = null
    let fraction: number | null
    let expectMs: number | null = null
    let key = this.stepKey
    const span: [number, number] = this.phase === 'open' ? [RESOLVE_END, 1] : [0, 1]
    if (w.stalledMs >= STALL_NOTICE_MS && w.stallTimeoutMs > w.stalledMs) {
      label = 'Waiting for the network'
      const left = Math.ceil((w.stallTimeoutMs - w.stalledMs) / 1000)
      detail = `Trying another source in ${left} s if it doesn’t answer`
      fraction = null
      key = ''
    } else if (this.phase === 'open' && !w.connected) {
      return false // still the "Connecting" estimate
    } else if (w.wholeFile && w.totalBytes && w.totalBytes > 0 && w.bytes < w.totalBytes) {
      label = 'Downloading'
      detail = formatBytesOf(w.bytes, w.totalBytes)
      fraction = w.bytes / w.totalBytes
      key = 'download'
    } else {
      label = 'Buffering'
      fraction = w.targetMs > 0 ? Math.max(0, Math.min(1, w.bufferedMs / w.targetMs)) : null
      if (fraction == null) expectMs = 800
      key = 'buffer'
    }
    const s = this.step
    const changed =
      s.label !== label || s.detail !== detail || s.expectMs !== expectMs || (fraction == null) !== (s.fraction == null) || Math.abs((fraction ?? 0) - (s.fraction ?? 0)) >= 0.02
    if (!changed) return false
    if (key !== this.stepKey) {
      // The connect estimate ends when the source answers.
      this.endStep()
      this.stepKey = key === 'download' || key === 'buffer' ? '' : key
      this.stepAt = this.now()
    }
    this.step = { label, detail, fraction, expectMs, since: s.label === label ? s.since : this.now(), span, wait: this.wait }
    return true
  }
}
