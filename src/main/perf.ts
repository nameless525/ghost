// Main-process performance diagnostics: event-loop stall detection and slow SQLite statements.
// The Electron main thread also pumps native window input on macOS, so any synchronous work
// here (SQL, HTML parsing, image resizing) shows up as UI jank. Stalls are logged and kept for
// `system.perfStats()` (debug) so they can be attributed.
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

export function perfHint(label: string): void {
  lastHint = label
  lastHintAt = performance.now()
}

export function startMainPerf(): void {
  hist.enable()
  let last = performance.now()
  const TICK = 50
  setInterval(() => {
    const now = performance.now()
    const drift = now - last - TICK
    last = now
    if (drift > 40) {
      const hint = now - lastHintAt < drift + 200 ? lastHint : null
      stalls.push({ at: Date.now(), ms: Math.round(drift), hint })
      if (stalls.length > 200) stalls.shift()
      if (process.env.GHOST_PERF_LOG) console.warn(`[perf] main stall ${Math.round(drift)} ms${hint ? ` (after: ${hint})` : ''}`)
    }
  }, TICK).unref()

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
  const out = {
    loop: {
      p50: Math.round(hist.percentile(50) / 1e4) / 100,
      p99: Math.round(hist.percentile(99) / 1e4) / 100,
      max: Math.round(hist.max / 1e4) / 100
    },
    stalls: [...stalls],
    slowSql: [...slowSql].sort((a, b) => b.ms - a.ms).slice(0, 40)
  }
  if (reset) {
    stalls.length = 0
    slowSql.length = 0
    hist.reset()
  }
  return out
}
