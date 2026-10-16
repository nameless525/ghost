// Child processes (yt-dlp) that must not outlive the app.
//
// yt-dlp runs from the catalog worker thread, but every thread's children are children of this one
// process, and quitting doesn't take them along: a 5–10 minute SoundCloud download or set listing
// would keep running (and downloading) after GHOST is gone. Each thread registers the children it
// spawns here; registrations are mirrored to the other threads over a BroadcastChannel, so the
// main thread can end them all when the app quits (`killTrackedChildren`), whichever thread started them.
//
// A child is ended as a process tree: the standalone yt-dlp build is a launcher that unpacks itself
// and runs the real yt-dlp as its child. On Unix the child is started as the leader of a process
// group of its own (spawn `detached`), and the group is signalled: SIGTERM first (the launcher
// passes it on and deletes what it unpacked), SIGKILL for whatever is left after a grace period.
// It stays registered until nothing of the group runs, even after the child itself has exited.
// Windows has no process groups, and no signal a console program can handle: `taskkill /T /F` ends
// the tree, found from its root while that still runs.
import { execFile, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { BroadcastChannel } from 'node:worker_threads'

type Msg = { t: 'add' | 'del'; pid: number; group?: boolean }

/** pid → whether it leads a process group of its own (Unix, spawned `detached`). */
const tracked = new Map<number, boolean>()
let channel: BroadcastChannel | null = null

/** How long a tree gets to end on SIGTERM before it is killed. */
export const TERM_GRACE_MS = 3000
/** How long a killed tree may take to be gone. */
const KILL_WAIT_MS = 2000
/** Quitting waits at most this long for trees to end on SIGTERM. */
const QUIT_GRACE_MS = 500

const windows = process.platform === 'win32'

function bus(): BroadcastChannel | null {
  if (channel) return channel
  try {
    channel = new BroadcastChannel('ghost:child-processes')
    channel.onmessage = (e: unknown) => {
      const m = (e as { data?: Msg })?.data
      if (!m || typeof m.pid !== 'number') return
      if (m.t === 'add') tracked.set(m.pid, m.group === true)
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

/** Register a running child process (by pid) until `untrackChild`. `group`: it leads its own process group. */
export function trackChild(pid: number | undefined, group = false): void {
  if (!pid) return
  tracked.set(pid, group)
  bus()?.postMessage({ t: 'add', pid, group } satisfies Msg)
}

export function untrackChild(pid: number | undefined): void {
  if (!pid) return
  tracked.delete(pid)
  bus()?.postMessage({ t: 'del', pid } satisfies Msg)
}

/** Pids currently registered (any thread). */
export function trackedChildren(): number[] {
  return [...tracked.keys()]
}

/** Whether anything of a tree still runs: any process of its group (a group leader), else the process. */
export function treeAlive(pid: number, group: boolean): boolean {
  try {
    process.kill(group && !windows ? -pid : pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalTree(pid: number, group: boolean, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  // A group is only ever one a child leads: never this process's own.
  const target = group && !windows && pid > 1 && pid !== process.pid ? -pid : pid
  try {
    process.kill(target, signal)
    return true
  } catch {
    return false
  }
}

const taskkill = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')

async function gone(pid: number, group: boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (treeAlive(pid, group)) {
    if (Date.now() >= until) return false
    await new Promise((r) => setTimeout(r, 25))
  }
  return true
}

/**
 * End a process tree: SIGTERM, then SIGKILL if anything of it still runs after `graceMs`. Resolves
 * once nothing of it runs (or the kill had its time). Windows: `taskkill /T /F`.
 */
export async function endTree(pid: number, group: boolean, graceMs = TERM_GRACE_MS): Promise<void> {
  if (windows) {
    await new Promise<void>((resolve) => execFile(taskkill(), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => resolve()))
    return
  }
  signalTree(pid, group, 'SIGTERM')
  if (await gone(pid, group, graceMs)) return
  signalTree(pid, group, 'SIGKILL')
  await gone(pid, group, KILL_WAIT_MS)
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * End every registered tree. Synchronous, safe to call while quitting: SIGTERM to all, a short wait
 * for them to end, then SIGKILL to what is left (a child whose thread no longer reaps it can make
 * that wait last QUIT_GRACE_MS). Returns how many were signalled.
 */
export function killTrackedChildren(): number {
  const trees = [...tracked]
  let n = 0
  if (windows) {
    for (const [pid] of trees) {
      const r = spawnSync(taskkill(), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
      if (r.status === 0 || signalTree(pid, false, 'SIGTERM')) n++
    }
  } else {
    for (const [pid, group] of trees) if (signalTree(pid, group, 'SIGTERM')) n++
    const until = Date.now() + QUIT_GRACE_MS
    let left = trees.filter(([pid, group]) => treeAlive(pid, group))
    while (left.length && Date.now() < until) {
      sleepSync(10)
      left = left.filter(([pid, group]) => treeAlive(pid, group))
    }
    for (const [pid, group] of left) signalTree(pid, group, 'SIGKILL')
  }
  tracked.clear()
  return n
}
