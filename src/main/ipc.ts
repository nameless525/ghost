// Routes `ghost:invoke` calls to the GhostServices implementation and broadcasts events.
import { BrowserWindow, ipcMain } from 'electron'
import { API_METHODS, IPC_EVENT, IPC_INVOKE, type GhostEvents, type GhostEventName, type GhostServices } from '../shared/api'

const allowed = new Set<string>(API_METHODS)

// Debug (GHOST_PERF_IPC=1): per-channel message counts, payload sizes (JSON length, a close proxy for
// the structured-clone size) and handler times. Off by default: measuring means serialising twice.
const measure = !!process.env.GHOST_PERF_IPC
interface ChannelStats {
  n: number
  bytes: number
  ms: number
}
const ipcCounters = new Map<string, ChannelStats>()
let ipcSince = Date.now()

function count(key: string, payload: unknown, ms = 0): void {
  let s = ipcCounters.get(key)
  if (!s) ipcCounters.set(key, (s = { n: 0, bytes: 0, ms: 0 }))
  s.n++
  s.ms += ms
  try {
    s.bytes += payload === undefined ? 0 : (JSON.stringify(payload)?.length ?? 0)
  } catch {
    /* unserialisable: the IPC send fails on its own */
  }
}

/** IPC traffic since the last reset (empty unless GHOST_PERF_IPC is set). */
export function ipcStats(reset = false) {
  const secs = Math.max(0.001, (Date.now() - ipcSince) / 1000)
  const channels = Object.fromEntries(
    [...ipcCounters].sort((a, b) => b[1].bytes - a[1].bytes).map(([k, s]) => [k, { n: s.n, bytes: s.bytes, bytesPerSec: Math.round(s.bytes / secs), avgMs: s.n ? Math.round((s.ms / s.n) * 100) / 100 : 0 }])
  )
  const out = { enabled: measure, secs: Math.round(secs * 10) / 10, channels }
  if (reset) {
    ipcCounters.clear()
    ipcSince = Date.now()
  }
  return out
}

/** Resolve "a.b.c" against the services tree once per method (not on every call). */
function resolveMethod(services: GhostServices, path: string): { target: unknown; fn: (...a: unknown[]) => unknown } | null {
  const parts = path.split('.')
  let target: any = services
  for (const p of parts.slice(0, -1)) target = target?.[p]
  const fn = target?.[parts[parts.length - 1]]
  return typeof fn === 'function' ? { target, fn } : null
}

export function registerIpc(services: GhostServices): void {
  // Method lookups are resolved once per method name (the services tree never changes).
  const methods = new Map<string, { target: unknown; fn: (...a: unknown[]) => unknown } | null>()
  ipcMain.handle(IPC_INVOKE, async (_e, path: string, args: unknown[]) => {
    if (typeof path !== 'string' || !allowed.has(path)) throw new Error(`Unknown GHOST method: ${path}`)
    let m = methods.get(path)
    if (m === undefined) methods.set(path, (m = resolveMethod(services, path)))
    if (!m) throw new Error(`GHOST method not implemented: ${path}`)
    if (!measure) return await m.fn.apply(m.target, Array.isArray(args) ? args : [])
    const t0 = performance.now()
    const out = await m.fn.apply(m.target, Array.isArray(args) ? args : [])
    count(`invoke ${path}`, out, performance.now() - t0)
    return out
  })
}

export function broadcast<E extends GhostEventName>(event: E, payload: GhostEvents[E]): void {
  const t0 = measure ? performance.now() : 0
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENT, event, payload)
  }
  // avgMs = time spent in send (serialisation happens there, on this thread)
  if (measure) count(`event ${event}`, payload, performance.now() - t0)
}

export type Broadcast = typeof broadcast
