import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { killTrackedChildren, trackChild, trackedChildren, untrackChild, watchChildren } from './children'

const unix = process.platform !== 'win32'
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!unix)('child process registry', () => {
  it('tracks and ends children of this thread', async () => {
    const c = spawn('sleep', ['30'])
    const exited = new Promise((r) => c.once('exit', r))
    trackChild(c.pid)
    expect(trackedChildren()).toContain(c.pid)
    expect(killTrackedChildren()).toBe(1)
    await exited
    expect(trackedChildren()).not.toContain(c.pid)
    untrackChild(c.pid) // harmless after the fact
  })

  it("ends children another thread registered (the catalog worker's yt-dlp)", async () => {
    watchChildren()
    // The worker spawns a child and registers it the way children.ts does (same channel/message).
    const w = new Worker(
      `const { spawn } = require('node:child_process')
       const { BroadcastChannel, parentPort } = require('node:worker_threads')
       const c = spawn('sleep', ['30'])
       const bc = new BroadcastChannel('ghost:child-processes')
       bc.postMessage({ t: 'add', pid: c.pid })
       c.once('exit', (code, signal) => { parentPort.postMessage({ exited: c.pid, signal }); bc.close() })
       parentPort.postMessage({ pid: c.pid })`,
      { eval: true }
    )
    const msgs: { pid?: number; exited?: number; signal?: string }[] = []
    const next = () => new Promise<void>((r) => w.once('message', (m) => (msgs.push(m), r())))
    await next()
    const pid = msgs[0].pid!
    for (let i = 0; i < 50 && !trackedChildren().includes(pid); i++) await new Promise((r) => setTimeout(r, 10))
    expect(trackedChildren()).toContain(pid)
    expect(alive(pid)).toBe(true)
    const exited = next()
    killTrackedChildren()
    await exited
    expect(msgs[1]).toEqual({ exited: pid, signal: 'SIGTERM' })
    await w.terminate()
  })
})
