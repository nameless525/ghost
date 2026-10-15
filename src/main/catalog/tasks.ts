// Sending progress without flooding: the 'progress' event (TaskProgress, see shared/types.ts) and the
// catalog's other progress reports go out at most a few times a second per key, unchanged values are
// skipped, and a step's final value always goes out. Timers exist only while a value is held back.
// Used by the catalog worker (album pages, imports, folder scans, the yt-dlp install) and by main
// (a chiptune set's download through the engine).
import type { GhostNotification, Progress, TaskProgress } from '../../shared/types'
import type { EngineCacheProgress } from '../engine/types'
import type { Broadcast } from '../ipc'
import type { InstallProgress } from '../tools/ytdlp'
import type { ToolProgress } from './progress'

/** "4.2 of 12.0 MB", or "4.2 MB" while the size is unknown. */
export function mbDetail(bytes: number, totalBytes: number | null): string {
  const mb = (n: number) => (n / 1048576).toFixed(1)
  return totalBytes != null && totalBytes > 0 ? `${mb(bytes)} of ${mb(totalBytes)} MB` : `${mb(bytes)} MB`
}

/** bytes / total in 0..1, or null when the total is unknown. */
export function byteFraction(bytes: number, totalBytes: number | null): number | null {
  return totalBytes != null && totalBytes > 0 ? Math.min(1, Math.max(0, bytes / totalBytes)) : null
}

/**
 * Sends values at most once per `intervalMs` and skips ones `same` as the last sent. A value held
 * back goes out when the interval is up, unless a newer one replaced it. `push(v, true)` sends at
 * once (a new step, a final value).
 */
export class Throttle<T> {
  private last: T | undefined
  private lastAt = -Infinity
  private held: T | undefined
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly send: (v: T) => void,
    private readonly intervalMs: number,
    private readonly same: (a: T, b: T) => boolean,
    private readonly now: () => number = Date.now
  ) {}

  push(v: T, urgent = false): void {
    if (this.last !== undefined && this.same(this.last, v)) {
      this.cancel()
      return
    }
    const wait = this.lastAt + this.intervalMs - this.now()
    if (urgent || wait <= 0) return this.emit(v)
    this.held = v
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        const h = this.held
        if (h !== undefined) this.emit(h)
      }, wait)
      this.timer.unref?.()
    }
  }

  /** Drop a value held back (the task ended). */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.held = undefined
  }

  private emit(v: T): void {
    this.cancel()
    this.last = v
    this.lastAt = this.now()
    this.send(v)
  }
}

/** Fractions closer than this count as unchanged. */
const FRACTION_STEP = 0.002

function sameProgress(a: Progress, b: Progress): boolean {
  const close = a.fraction == null || b.fraction == null ? a.fraction === b.fraction : Math.abs(a.fraction - b.fraction) < FRACTION_STEP
  return a.label === b.label && (a.detail ?? null) === (b.detail ?? null) && close && a.expectMs === b.expectMs && a.since === b.since && a.span?.[0] === b.span?.[0] && a.span?.[1] === b.span?.[1]
}

export type TaskStep = Omit<Progress, 'since'>

/**
 * TaskProgress for any number of keys: ≤ 1 event per `intervalMs` per key, a new step (another label
 * or span) at once, `done` at once and always last (a held-back update is dropped). A key's state
 * goes on done.
 */
export class TaskReporter {
  private tasks = new Map<string, { throttle: Throttle<TaskProgress>; last: TaskProgress }>()

  constructor(
    private readonly send: (p: TaskProgress) => void,
    private readonly intervalMs = 200,
    private readonly now: () => number = Date.now
  ) {}

  /** Report a step of `key`. Re-sending the same step (label and span) updates it (fraction, detail): throttled. */
  step(key: string, step: TaskStep): void {
    let t = this.tasks.get(key)
    const fresh = !t || t.last.label !== step.label || t.last.span?.[0] !== step.span?.[0]
    const p: TaskProgress = { key, label: step.label, detail: step.detail ?? null, fraction: step.fraction, expectMs: step.expectMs, since: fresh || !t ? this.now() : t.last.since }
    if (step.span) p.span = step.span
    if (!t) {
      t = { throttle: new Throttle<TaskProgress>((v) => this.send(v), this.intervalMs, sameProgress, this.now), last: p }
      this.tasks.set(key, t)
    }
    t.last = p
    t.throttle.push(p, fresh)
  }

  /** The task finished or failed: its bar completes and goes. Nothing is sent for a key never reported. */
  done(key: string): void {
    const t = this.tasks.get(key)
    if (!t) return
    this.tasks.delete(key)
    t.throttle.cancel()
    this.send({ key, label: t.last.label, detail: t.last.detail ?? null, fraction: 1, expectMs: null, since: t.last.since, done: true })
  }

  /** Whether `key` has reported a step and isn't done. */
  active(key: string): boolean {
    return this.tasks.has(key)
  }

  /** Drop `key` without a done (another process finishes the task): a held-back update is dropped too. */
  forget(key: string): void {
    this.tasks.get(key)?.throttle.cancel()
    this.tasks.delete(key)
  }
}

/**
 * While `work` (the engine listing a chiptune set) runs, poll how much of the archive has reached the
 * stream cache (EngineBridge.cacheProgress) and report it under `key`: "Downloading the chiptune
 * set" with its bytes, then "Unpacking the chiptune set" once it's all there and being read. Polls
 * only while `work` is pending. The steps continue the worker's first one (span [0, 0.1]); the worker
 * sends the done.
 */
export function watchArchiveDownload<T>(work: Promise<T>, probe: () => EngineCacheProgress | null, key: string, tasks: TaskReporter, everyMs = 200): Promise<T> {
  let downloading = false
  const tick = () => {
    let fill: EngineCacheProgress | null = null
    try {
      fill = probe()
    } catch {
      fill = null
    }
    const complete = !!fill && fill.totalBytes != null && fill.bytes >= fill.totalBytes
    if (fill && !complete) {
      downloading = true
      tasks.step(key, { label: 'Downloading the chiptune set', detail: mbDetail(fill.bytes, fill.totalBytes), fraction: byteFraction(fill.bytes, fill.totalBytes), expectMs: null, span: [0.1, 0.9] })
    } else if (downloading || complete) {
      tasks.step(key, { label: 'Unpacking the chiptune set', fraction: null, expectMs: 1000, span: [0.9, 1] })
    }
  }
  const timer = setInterval(tick, everyMs)
  timer.unref?.()
  return work.finally(() => {
    clearInterval(timer)
    tasks.forget(key)
  })
}

/**
 * Typical length of a step per provider: an exponentially weighted mean of the last few runs, seeded
 * with a default. Tiny (one number per provider id).
 */
export class TypicalMs {
  private learned = new Map<string, number>()

  constructor(
    private readonly defaults: Record<string, number>,
    private readonly fallback: number,
    private readonly alpha = 0.3
  ) {}

  get(id: string): number {
    return Math.round(this.learned.get(id) ?? this.defaults[id] ?? this.fallback)
  }

  record(id: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    const v = Math.min(120_000, Math.max(100, ms))
    const prev = this.learned.get(id) ?? this.defaults[id] ?? this.fallback
    this.learned.set(id, prev + this.alpha * (v - prev))
  }
}

const YTDLP_KEY = 'tool:yt-dlp'
const YTDLP_NOTICE = 'tool-yt-dlp'
const YTDLP_TITLE = 'Setting up YouTube support'
/** The download is most of the wait; its first run (checking it works) the rest. */
const YTDLP_DOWNLOAD_SPAN: [number, number] = [0, 0.95]

/**
 * The one-time yt-dlp download as the user sees it: the player's ToolProgress (`onTool`), the
 * 'progress' event (key 'tool:yt-dlp') and a toast updated in place, which ends saying it's ready or
 * why it failed. Each at most once per `intervalMs`.
 */
export function ytDlpInstallReporter(out: { broadcast: Broadcast; onTool?: (p: ToolProgress) => void }, intervalMs = 250): (p: InstallProgress) => void {
  const tasks = new TaskReporter((p) => out.broadcast('progress', p), intervalMs)
  // Per attempt (a failed download is tried again on the next use).
  let run: { tool: Throttle<ToolProgress>; toast: Throttle<GhostNotification> } | null = null
  return (p) => {
    if (p.phase === 'download' || p.phase === 'check') {
      const first = !run
      run ??= {
        tool: new Throttle((v) => out.onTool?.(v), intervalMs, (a, b) => a.fraction === b.fraction && a.detail === b.detail),
        toast: new Throttle((n) => out.broadcast('notify', n), intervalMs, (a, b) => a.body === b.body && a.progress === b.progress)
      }
      const fraction = byteFraction(p.bytes, p.totalBytes)
      const size = p.bytes || p.totalBytes ? ` · ${mbDetail(p.bytes, p.totalBytes)}` : ''
      const toast: GhostNotification = { id: YTDLP_NOTICE, kind: 'progress', title: YTDLP_TITLE, body: `One-time download for YouTube and SoundCloud${size}` }
      if (p.phase === 'download') {
        const detail = `One-time download${size}`
        tasks.step(YTDLP_KEY, { label: YTDLP_TITLE, detail, fraction, expectMs: null, span: YTDLP_DOWNLOAD_SPAN })
        run.tool.push({ tool: 'yt-dlp', phase: 'download', fraction, detail, done: false }, first)
        if (fraction != null) toast.progress = fraction * YTDLP_DOWNLOAD_SPAN[1]
        run.toast.push(toast, first)
      } else {
        const detail = 'Checking that it works'
        tasks.step(YTDLP_KEY, { label: YTDLP_TITLE, detail, fraction: null, expectMs: 2500, span: [YTDLP_DOWNLOAD_SPAN[1], 1] })
        run.tool.push({ tool: 'yt-dlp', phase: 'check', fraction: null, detail, done: false }, true)
        run.toast.push({ ...toast, body: `${detail}…`, progress: YTDLP_DOWNLOAD_SPAN[1] }, true)
      }
      return
    }
    run?.tool.cancel()
    run?.toast.cancel()
    run = null
    tasks.done(YTDLP_KEY)
    const ok = p.phase === 'done'
    out.onTool?.({ tool: 'yt-dlp', phase: 'check', fraction: ok ? 1 : null, detail: null, done: true, error: ok ? null : (p.error ?? 'unknown error') })
    out.broadcast(
      'notify',
      ok
        ? ({ id: YTDLP_NOTICE, kind: 'success', title: 'YouTube support is ready', body: 'YouTube and SoundCloud sources work from now on.' } satisfies GhostNotification)
        : ({ id: YTDLP_NOTICE, kind: 'error', title: 'Couldn’t set up YouTube support', body: `Downloading yt-dlp failed: ${p.error ?? 'unknown error'}. It’s tried again the next time it’s needed.` } satisfies GhostNotification)
    )
  }
}
