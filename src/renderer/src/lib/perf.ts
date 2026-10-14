// Renderer performance diagnostics (debug): frame-time histogram from the global ticker, long
// tasks with attribution, and heap growth. Read via `window.__ghostPerf.stats(reset)`.
import { ticker } from '../motion/ticker'

interface LongTask {
  at: number
  ms: number
  name: string
}

const frames: number[] = []
const longTasks: LongTask[] = []
let started = false

export function startRendererPerf(): void {
  if (started) return
  started = true
  ticker.add(() => {
    frames.push(ticker.rawDt)
    if (frames.length > 6000) frames.splice(0, 1000)
  }, 1000)
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const attr = (e as PerformanceEntry & { attribution?: { name: string; containerType?: string }[] }).attribution?.[0]
        longTasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration), name: attr ? `${attr.name}${attr.containerType ? '/' + attr.containerType : ''}` : e.name })
        if (longTasks.length > 300) longTasks.shift()
      }
    })
    po.observe({ type: 'longtask', buffered: true })
  } catch {
    /* not supported */
  }
  try {
    const lo = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEntry[]) {
        const la = e as PerformanceEntry & { blockingDuration?: number; scripts?: { sourceURL: string; sourceFunctionName: string; duration: number; invoker: string }[] }
        const top = [...(la.scripts ?? [])].sort((a, b) => b.duration - a.duration)[0]
        if (e.duration > 50)
          longTasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration), name: `LoAF${top ? ` ${top.invoker || ''} ${top.sourceFunctionName || ''} @${(top.sourceURL || '').split('/').pop()} ${Math.round(top.duration)}ms` : ''}` })
      }
    })
    lo.observe({ type: 'long-animation-frame', buffered: true })
  } catch {
    /* not supported */
  }
  ;(window as unknown as { __ghostPerf: unknown }).__ghostPerf = { stats }
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10
}

export function stats(reset = false) {
  const s = [...frames].sort((a, b) => a - b)
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  const out = {
    frames: s.length,
    p50: pct(s, 50),
    p95: pct(s, 95),
    p99: pct(s, 99),
    max: Math.round((s[s.length - 1] ?? 0) * 10) / 10,
    over25: s.filter((x) => x > 25).length,
    over50: s.filter((x) => x > 50).length,
    longTasks: [...longTasks],
    heapMB: mem ? Math.round(mem.usedJSHeapSize / 1e5) / 10 : null
  }
  if (reset) {
    frames.length = 0
    longTasks.length = 0
  }
  return out
}
