import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, describe, expect, it } from 'vitest'
import { endTree, killTrackedChildren, trackChild, trackedChildren, treeAlive, untrackChild, watchChildren } from './children'

const unix = process.platform !== 'win32'
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('child process registry', () => {
  it('tracks and ends children of this thread', async () => {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
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
       const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
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
    // Windows has no signals: the child is just terminated.
    expect(msgs[1]).toEqual({ exited: pid, signal: unix ? 'SIGTERM' : null })
    await w.terminate()
  })

  describe.runIf(unix)('process trees (Unix: a process group of their own)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghost-children-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    /** A shell (group leader) that starts a sleep and waits; `onTerm`: its TERM trap. */
    async function tree(name: string, onTerm: string) {
      const pidFile = join(dir, `${name}.pid`)
      const c = spawn('/bin/sh', ['-c', `trap '${onTerm}' TERM; sleep 30 & echo $! > ${pidFile}; wait; wait`], { detached: true, stdio: 'ignore' })
      const exited = new Promise((r) => c.once('exit', r))
      for (let i = 0; i < 1000 && !(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()); i++) await new Promise((r) => setTimeout(r, 10))
      return { pid: c.pid!, sleep: Number(readFileSync(pidFile, 'utf8').trim()), exited }
    }

    it('quitting ends the whole group, asking first', async () => {
      const marker = join(dir, 'asked')
      const t = await tree('quit', `echo asked > ${marker}; exit 0`)
      trackChild(t.pid, true)
      killTrackedChildren()
      await t.exited
      expect(existsSync(marker)).toBe(true)
      expect(alive(t.sleep)).toBe(false)
      expect(treeAlive(t.pid, true)).toBe(false)
      expect(trackedChildren()).not.toContain(t.pid)
    })

    it('a tree that ignores SIGTERM is killed once its grace is up', async () => {
      const t = await tree('stubborn', '')
      await endTree(t.pid, true, 100)
      await t.exited
      expect(alive(t.sleep)).toBe(false)
      expect(treeAlive(t.pid, true)).toBe(false)
    })
  })
})
