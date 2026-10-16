// Per-host request scheduler: at most N requests in flight, at least `spacingMs` between request
// starts, and a priority queue so interactive requests (opening an album, resolving the track that
// is about to play) jump ahead of background work (index crawl, art prefetch). Interactive requests
// run newest first: someone scrolling through albums waits for the one they stopped on, not for
// every one they passed (those still run, after it); the other queues run in order.

import { NetError } from './errors'

/** 0 = interactive, 1 = normal, 2 = background. */
export type Priority = 0 | 1 | 2

export interface LimiterOptions {
  concurrency: number
  spacingMs: number
  now?: () => number
}

interface Job {
  run: () => Promise<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export class HostLimiter {
  private queues: Job[][] = [[], [], []]
  private active = 0
  private lastStart = -Infinity
  private timer: ReturnType<typeof setTimeout> | null = null
  private pausedUntil = 0
  private readonly now: () => number

  constructor(private opts: LimiterOptions) {
    this.now = opts.now ?? Date.now
  }

  get pending(): number {
    return this.queues[0].length + this.queues[1].length + this.queues[2].length
  }

  get inFlight(): number {
    return this.active
  }

  /** Delay all new request starts until `ms` from now (e.g. after a 429). */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms)
    this.pump()
  }

  /**
   * Queue `run`. `onQueued` receives a `promote(priority)` function that moves the job to a more
   * urgent queue while it is still waiting (e.g. an interactive request joined a background one).
   */
  schedule<T>(run: () => Promise<T>, priority: Priority = 1, signal?: AbortSignal, onQueued?: (promote: (p: Priority) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new NetError('aborted', 'request aborted'))
      const job: Job = { run, resolve: resolve as (v: unknown) => void, reject, signal }
      let at = priority
      if (signal) {
        job.onAbort = () => {
          const q = this.queues[at]
          const i = q.indexOf(job)
          if (i >= 0) {
            q.splice(i, 1)
            reject(new NetError('aborted', 'request aborted'))
          }
        }
        signal.addEventListener('abort', job.onAbort, { once: true })
      }
      this.queues[priority].push(job)
      onQueued?.((p) => {
        if (p >= at) return
        const i = this.queues[at].indexOf(job)
        if (i < 0) return // already started
        this.queues[at].splice(i, 1)
        this.queues[p].push(job)
        at = p
      })
      this.pump()
    })
  }

  /**
   * How long until a job queued now at `priority` would start: 0 = at once, Infinity = when a
   * running one ends (all slots busy, or others already waiting ahead of it: more urgent ones, and
   * earlier ones at its own priority unless interactive, since those go newest first).
   */
  readyIn(priority: Priority = 2): number {
    const ahead = priority === 0 ? 0 : this.queues.slice(0, priority + 1).reduce((n, q) => n + q.length, 0)
    if (ahead > 0 || this.active >= this.opts.concurrency) return Infinity
    return Math.max(0, Math.max(this.lastStart + this.opts.spacingMs, this.pausedUntil) - this.now())
  }

  private next(): Job | undefined {
    if (this.queues[0].length) return this.queues[0].pop()
    for (const q of this.queues) if (q.length) return q.shift()
    return undefined
  }

  private pump(): void {
    if (this.timer) return
    while (this.active < this.opts.concurrency && this.pending > 0) {
      const now = this.now()
      const wait = Math.max(this.lastStart + this.opts.spacingMs, this.pausedUntil) - now
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.pump()
        }, wait)
        return
      }
      const job = this.next()!
      if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort)
      this.active++
      this.lastStart = now
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--
          this.pump()
        })
    }
  }
}
