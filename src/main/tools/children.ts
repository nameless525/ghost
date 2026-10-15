// Child processes (yt-dlp) that must not outlive the app.
//
// yt-dlp runs from the catalog worker thread, but every thread's children are children of this one
// process, and quitting doesn't take them along: a 5–10 minute SoundCloud download or set listing
// would keep running (and downloading) after GHOST is gone. Each thread registers the children it
// spawns here; registrations are mirrored to the other threads over a BroadcastChannel, so the
// main thread can end them all when the app quits (`killTrackedChildren`), whichever thread started them.
import { BroadcastChannel } from 'node:worker_threads'

type Msg = { t: 'add' | 'del'; pid: number }

const tracked = new Set<number>()
let channel: BroadcastChannel | null = null

function bus(): BroadcastChannel | null {
  if (channel) return channel
  try {
    channel = new BroadcastChannel('ghost:child-processes')
    channel.onmessage = (e: unknown) => {
      const m = (e as { data?: Msg })?.data
      if (!m || typeof m.pid !== 'number') return
      if (m.t === 'add') tracked.add(m.pid)
      else tracked.delete(m.pid)
    }
    // Never keep a thread (or the process) alive just for this.
    channel.unref()
  } catch {
    channel = null
  }
  return channel
}

/** Start listening for registrations from other threads (call early on the main thread). */
export function watchChildren(): void {
  bus()
}

/** Register a running child process (by pid) until `untrackChild`. */
export function trackChild(pid: number | undefined): void {
  if (!pid) return
  tracked.add(pid)
  bus()?.postMessage({ t: 'add', pid } satisfies Msg)
}

export function untrackChild(pid: number | undefined): void {
  if (!pid) return
  tracked.delete(pid)
  bus()?.postMessage({ t: 'del', pid } satisfies Msg)
}

/** Pids currently registered (any thread). */
export function trackedChildren(): number[] {
  return [...tracked]
}

/** End every registered child. Synchronous, safe to call while quitting. Returns how many were signalled. */
export function killTrackedChildren(signal: NodeJS.Signals = 'SIGTERM'): number {
  let n = 0
  for (const pid of tracked) {
    try {
      process.kill(pid, signal)
      n++
    } catch {
      /* already gone */
    }
  }
  tracked.clear()
  return n
}
