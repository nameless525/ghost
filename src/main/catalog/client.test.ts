// The main-process catalog client between workers: calls wait through a restart, and fail at once
// after the catalog has gone for good.
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { RpcEndpoint } from '../net/rpc'
import { CatalogClient } from './client'

/** How a call stands once everything already settled has run: its value, its error, or still waiting. */
async function outcome(p: Promise<unknown>): Promise<{ ok: unknown } | { err: unknown } | 'pending'> {
  const pending = new Promise<'pending'>((r) => setImmediate(() => r('pending')))
  return Promise.race([p.then((ok) => ({ ok }), (err) => ({ err })), pending])
}

const ports: MessagePort[] = []
afterEach(() => {
  for (const p of ports.splice(0)) p.close()
})

/** A worker stand-in answering status() with `tag`. */
function worker(tag: string) {
  const { port1, port2 } = new MessageChannel()
  ports.push(port1, port2)
  new RpcEndpoint(port1, { status: () => tag })
  return port2
}

describe('CatalogClient', () => {
  it('calls made while a worker restarts wait for it', async () => {
    const client = new CatalogClient({ broadcast: (() => {}) as never, log: () => {} })
    client.attach(worker('first'))
    expect(await client.catalog.status()).toBe('first')
    client.detach(new Error('worker exited'))
    const waiting = client.catalog.status()
    expect(await outcome(waiting)).toBe('pending')
    client.attach(worker('second'))
    expect(await waiting).toBe('second')
  })

  it('after a terminal failure, queued and new calls fail with it at once', async () => {
    const client = new CatalogClient({ broadcast: (() => {}) as never, log: () => {} })
    const queued = client.catalog.status() // before any worker (startup)
    const reason = new Error('permanent startup failure')
    client.close(reason)
    expect(await outcome(queued)).toEqual({ err: reason })
    expect(await outcome(client.catalog.status())).toEqual({ err: reason })
    expect(await outcome(client.catalog.album('1'))).toEqual({ err: reason })
    // fire-and-forget calls neither throw nor pile up
    client.catalog.markSourceFailed('1', 'k', 'gone')
    client.catalog.warmSources(['1'])
    expect((client as unknown as { queue: unknown[] }).queue).toEqual([])
    // a worker attached afterwards (an explicit restart) serves calls again
    client.attach(worker('again'))
    expect(await client.catalog.status()).toBe('again')
  })
})
