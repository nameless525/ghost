// The catalog host's worker lifecycle with a stand-in Worker: restarts keep calls waiting, and every
// way the catalog can end for good makes calls fail instead of waiting forever.
import type { MessagePort } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import { RpcEndpoint, serializeError } from '../net/rpc'
import { createCatalogHost, type CatalogHost } from './host'

interface FakeWorker {
  /** The worker's end of its port. */
  remote: MessagePort
  local: MessagePort
  emit(event: 'exit', code: number): void
}

const fake = vi.hoisted(() => ({ workers: [] as unknown[], failNext: null as Error | null }))

vi.mock('electron', () => ({ app: { getAppPath: () => '/nonexistent' } }))
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()), existsSync: () => true }))
vi.mock('../net/art-protocol', () => ({ artAccent: async () => null, onArtAccent: () => () => {}, trimArtCache: async () => {} }))
vi.mock('node:worker_threads', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:worker_threads')>()
  class Worker {
    readonly local: MessagePort
    readonly remote: MessagePort
    private readonly exits: ((code: number) => void)[] = []
    constructor() {
      const e = fake.failNext
      fake.failNext = null
      if (e) throw e
      const { port1, port2 } = new real.MessageChannel()
      this.local = port1
      this.remote = port2
      fake.workers.push(this)
    }
    postMessage(v: unknown, transfer?: readonly ArrayBuffer[]) {
      this.local.postMessage(v, transfer as ArrayBuffer[])
    }
    on(event: string, fn: (v: unknown) => void) {
      if (event === 'message') this.local.on('message', fn)
      else if (event === 'exit') this.exits.push(fn)
      return this
    }
    off(event: string, fn: (v: unknown) => void) {
      if (event === 'message') this.local.off('message', fn)
      return this
    }
    emit(_event: 'exit', code: number) {
      for (const fn of this.exits) fn(code)
    }
    async terminate() {
      this.emit('exit', 1)
      return 1
    }
  }
  return { ...real, Worker }
})

const workers = () => fake.workers as FakeWorker[]

/** How a call stands once everything already settled has run: its value, its error, or still waiting. */
async function outcome(p: Promise<unknown>): Promise<{ ok: unknown } | { err: unknown } | 'pending'> {
  const pending = new Promise<'pending'>((r) => setImmediate(() => r('pending')))
  return Promise.race([p.then((ok) => ({ ok }), (err) => ({ err })), pending])
}

let host: CatalogHost | null = null
function makeHost() {
  const fatal: Error[] = []
  let sawFatal!: () => void
  const fatalSeen = new Promise<void>((r) => (sawFatal = r))
  host = createCatalogHost({
    dbPath: '/nonexistent/ghost.db',
    dataDir: '/nonexistent',
    settings: defaultSettings('/nonexistent/downloads'),
    broadcast: (() => {}) as never,
    onFatal: (e) => {
      fatal.push(e)
      sawFatal()
    }
  })
  return { host, fatal, fatalSeen }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  host?.dispose()
  host = null
  for (const w of workers()) {
    w.local.close()
    w.remote.close()
  }
  fake.workers.length = 0
  fake.failNext = null
})

describe('catalog host', () => {
  it('a worker that can’t be started fails calls made before and after with its error', async () => {
    const { host, fatal } = makeHost()
    const early = host.catalog.status()
    const reason = new Error('no worker for you')
    fake.failNext = reason
    host.spawn()
    expect(await outcome(early)).toEqual({ err: reason })
    expect(await outcome(host.catalog.status())).toEqual({ err: reason })
    expect(fatal).toEqual([reason])
  })

  it('calls wait through a restart; once restarts run out they fail', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { host, fatal } = makeHost()
    host.spawn()
    workers()[0].emit('exit', 1)
    const waiting = host.catalog.status()
    expect(await outcome(waiting)).toBe('pending')
    vi.advanceTimersByTime(1000)
    expect(workers()).toHaveLength(2)
    new RpcEndpoint(workers()[1].remote, { status: () => 'restarted' })
    expect(await waiting).toBe('restarted')

    for (let i = 1; i <= 3; i++) {
      workers()[i].emit('exit', 1)
      vi.advanceTimersByTime(1000)
    }
    expect(workers()).toHaveLength(4) // three restarts, no fourth
    expect(fatal).toHaveLength(1)
    const err = (await outcome(host.catalog.status())) as { err: Error }
    expect(err.err.message).toMatch(/stopped unexpectedly/)
  })

  it('a worker that reported a fatal error and then exits leaves calls failing, not waiting', async () => {
    const { host, fatal, fatalSeen } = makeHost()
    host.spawn()
    const w = workers()[0]
    new RpcEndpoint(w.remote).notify('fatal', serializeError(new Error('database is unreadable')))
    await fatalSeen
    expect(fatal.map((e) => e.message)).toEqual(['database is unreadable'])
    w.emit('exit', 1)
    expect(workers()).toHaveLength(1) // not restarted
    expect(await outcome(host.catalog.status())).toEqual({ err: expect.any(Error) })
  })
})
