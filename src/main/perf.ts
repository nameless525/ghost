// Main-process performance diagnostics: event-loop stall detection and slow SQLite statements.
// The Electron main thread also pumps native window input on macOS, so any synchronous work
// here (SQL, HTML parsing, image resizing) shows up as UI jank. Stalls are logged and kept for
// `system.perfStats()` (debug) so they can be attributed.
//
// The detectors are timers (a 50 ms drift check and the 10 ms event-loop-delay sampler: ~120
// wakeups a second), so they only run while they can matter: while a GHOST window has focus,
// for a while after perf stats were read, or always with GHOST_PERF_LOG. A backgrounded app
// doesn't wake up for them.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { DatabaseSync, StatementSync } from 'node:sqlite'

export interface StallRecord {
  at: number
  ms: number
  /** Most recent slow-statement / op label seen just before the stall. */
  hint: string | null
}

const stalls: StallRecord[] = []
const slowSql: { at: number; ms: number; sql: string }[] = []
let lastHint: string | null = null
let lastHintAt = 0
const hist = monitorEventLoopDelay({ resolution: 10 })

/** Startup / latency milestones: ms since the process started (performance.timeOrigin). */
const marks: { name: string; ms: number }[] = []

/**
 * Record a milestone (startup phases, click→sound). Cheap: an array push. Kept for
 * `system.perfStats()` and logged live with GHOST_PERF_LOG.
 */
export function perfMark(name: string): number {
  const ms = Math.round(performance.now() * 10) / 10
  if (marks.length >= 400) marks.splice(0, 100)
  marks.push({ name, ms })
  if (process.env.GHOST_PERF_LOG) console.log(`[perf] ${name} @ ${ms} ms`)
  return ms
}

export function perfHint(label: string): void {
  lastHint = label
  lastHintAt = performance.now()
}

const TICK = 50
let stallTimer: ReturnType<typeof setInterval> | null = null
let focused = true
let inspectUntil = 0
let inspectTimer: ReturnType<typeof setTimeout> | null = null
/** After perf stats are read, keep measuring this long even without focus (scripted profiling). */
const INSPECT_WINDOW_MS = 10 * 60_000

/** Whether the stall detectors are running right now. */
export function perfActive(): boolean {
  return stallTimer !== null
}

function syncDetectors(): void {
  const want = !!process.env.GHOST_PERF_LOG || focused || Date.now() < inspectUntil
  if (want && !stallTimer) {
    hist.enable()
    let last = performance.now()
    stallTimer = setInterval(() => {
      const now = performance.now()
      const drift = now - last - TICK
      last = now
      if (drift > 40) {
        const hint = now - lastHintAt < drift + 200 ? lastHint : null
        stalls.push({ at: Date.now(), ms: Math.round(drift), hint })
        if (stalls.length > 200) stalls.shift()
        if (process.env.GHOST_PERF_LOG) console.warn(`[perf] main stall ${Math.round(drift)} ms${hint ? ` (after: ${hint})` : ''}`)
      }
    }, TICK)
    stallTimer.unref()
  } else if (!want && stallTimer) {
    clearInterval(stallTimer)
    stallTimer = null
    hist.disable()
  }
}

/** A GHOST window gained (true) or no GHOST window has (false) focus. */
export function setPerfFocus(hasFocus: boolean): void {
  focused = hasFocus
  syncDetectors()
}

export function startMainPerf(): void {
  syncDetectors()

  // Time every statement execution; record the slow ones.
  const proto = StatementSync.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  for (const m of ['run', 'all', 'get', 'iterate']) {
    const orig = proto[m]
    if (typeof orig !== 'function') continue
    proto[m] = function (this: StatementSync, ...args: unknown[]) {
      const t0 = performance.now()
      try {
        return orig.apply(this, args)
      } finally {
        const ms = performance.now() - t0
        if (ms > 8) {
          const sql = (this as unknown as { sourceSQL?: string }).sourceSQL ?? '?'
          slowSql.push({ at: Date.now(), ms: Math.round(ms * 10) / 10, sql: sql.replace(/\s+/g, ' ').slice(0, 160) })
          if (slowSql.length > 300) slowSql.shift()
          perfHint(`sql ${Math.round(ms)}ms: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`)
        }
      }
    }
  }
  const dbProto = DatabaseSync.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  const exec = dbProto.exec
  dbProto.exec = function (this: DatabaseSync, sql: unknown) {
    const t0 = performance.now()
    try {
      return exec.call(this, sql)
    } finally {
      const ms = performance.now() - t0
      if (ms > 8) {
        const s = String(sql).replace(/\s+/g, ' ').slice(0, 160)
        slowSql.push({ at: Date.now(), ms: Math.round(ms * 10) / 10, sql: 'exec ' + s })
        perfHint(`exec ${Math.round(ms)}ms: ${s.slice(0, 80)}`)
      }
    }
  }
}

export function perfStats(reset = false) {
  // Someone is measuring: keep the detectors on for a while even if the window loses focus.
  inspectUntil = Date.now() + INSPECT_WINDOW_MS
  if (inspectTimer) clearTimeout(inspectTimer)
  inspectTimer = setTimeout(syncDetectors, INSPECT_WINDOW_MS + 100)
  inspectTimer.unref()
  syncDetectors()
  const out = {
    loop: {
      p50: Math.round(hist.percentile(50) / 1e4) / 100,
      p99: Math.round(hist.percentile(99) / 1e4) / 100,
      max: Math.round(hist.max / 1e4) / 100
    },
    stalls: [...stalls],
    slowSql: [...slowSql].sort((a, b) => b.ms - a.ms).slice(0, 40),
    marks: [...marks],
    detectorsActive: perfActive(),
    /** Epoch ms of process start: marks are relative to it (compare with the renderer's timeOrigin). */
    timeOrigin: performance.timeOrigin
  }
  if (reset) {
    stalls.length = 0
    slowSql.length = 0
    hist.reset()
  }
  return out
}
