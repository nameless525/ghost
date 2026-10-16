// The catalog worker's page requests and the art protocol's downloads, through the one host
// scheduler in the main process: the worker's HttpClient over a real RPC channel (as in the app,
// minus the thread), art through main's own HttpClient. Fake network, fake clock.
import { MessageChannel } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isNetError } from './errors'
import { createHostScheduler, createHttpClient, type FetchLike, type HostSchedulerOptions } from './http'
import { RpcEndpoint, transfer } from './rpc'
import { remoteScheduler, serveFetch, type WireRequest, type WireResponse } from './rpc-fetch'

afterEach(() => vi.useRealTimers())

/** Let the event loop run (the RPC's messages) until `done`. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !done(); i++) await new Promise((r) => setImmediate(r))
  expect(done()).toBe(true)
}

function wire(fetch: FetchLike, o: HostSchedulerOptions = {}) {
  const scheduler = createHostScheduler({ fetch, backoffMs: 1, ...o })
  const { port1, port2 } = new MessageChannel()
  const served: WireRequest[] = []
  // main: the catalog client's 'fetch' handler (client.ts), with host.ts's transport
  new RpcEndpoint(port1, {
    fetch: async ([req], ctx) => {
      served.push(req as WireRequest)
      const r = await serveFetch(scheduler, req as WireRequest, ctx.signal)
      return transfer(r.res, r.transfer)
    }
  })
  const worker = new RpcEndpoint(port2)
  const catalog = createHttpClient({ cacheDir: null, scheduler: remoteScheduler((req, opts) => worker.call<WireResponse>('fetch', [req], opts)) })
  const art = createHttpClient({ cacheDir: null, scheduler })
  const close = () => {
    port1.close()
    port2.close()
  }
  return { scheduler, catalog, art, served, close }
}

describe('one host scheduler for the catalog worker and the art protocol', () => {
  it('runs the worker’s requests in main, with their errors and cancellation', async () => {
    let hung: AbortSignal | null = null
    const t = wire(async (url, init) => {
      if (url.endsWith('/hang')) return await new Promise<Response>((_r, reject) => ((hung = init!.signal!), hung.addEventListener('abort', () => reject(new Error('aborted')))))
      if (url.endsWith('/gone')) return new Response('no', { status: 404 })
      const h = new Headers(init?.headers)
      return new Response(`<p>${h.get('accept')}</p>`, { status: 201, headers: { 'content-type': 'text/html' } })
    })
    expect(await t.catalog.pageFetch('https://example.test/page')).toMatchObject({ status: 201, url: 'https://example.test/page', html: '<p>text/html,application/xhtml+xml;q=0.9,*/*;q=0.8</p>' })
    expect(await t.catalog.fetchBytes('https://example.test/b')).toMatchObject({ status: 201, contentType: 'text/html' })
    await expect(t.catalog.pageFetch('https://example.test/gone')).rejects.toSatisfy((e: unknown) => isNetError(e, 'not_found'))
    const ac = new AbortController()
    const p = t.catalog.fetchBytes('https://example.test/hang', { signal: ac.signal })
    await until(() => hung != null)
    ac.abort()
    await expect(p).rejects.toSatisfy((e: unknown) => isNetError(e, 'aborted'))
    await until(() => hung!.aborted)
    t.close()
  })

  it('holds a host’s limits for both together: concurrency, and spacing between starts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const starts: { url: string; at: number }[] = []
    let active = 0
    let peak = 0
    // Each request takes 1.1 s.
    const t = wire(async (url) => {
      starts.push({ url, at: Date.now() })
      peak = Math.max(peak, ++active)
      await new Promise((r) => setTimeout(r, 1100))
      active--
      return new Response('x', { status: 200 })
    })
    const t0 = Date.now()
    const done = [
      t.catalog.pageFetch('https://vgmrips.net/packs/pack/a'),
      t.catalog.pageFetch('https://vgmrips.net/packs/pack/b'),
      t.art.fetchBytes('https://vgmrips.net/files/a.png'),
      t.art.fetchBytes('https://vgmrips.net/files/b.png')
    ]
    let settled = 0
    for (const d of done) void d.then(() => settled++)
    await until(() => t.served.length === 2)
    while (settled < done.length) {
      await vi.advanceTimersByTimeAsync(50)
      await new Promise((r) => setImmediate(r))
    }
    expect(starts.map((s) => new URL(s.url).pathname).sort()).toEqual(['/files/a.png', '/files/b.png', '/packs/pack/a', '/packs/pack/b'])
    // vgmrips.net: 2 at a time, starts 1 s apart (DEFAULT_HOST_POLICIES)
    expect(peak).toBe(2)
    expect(starts.map((s) => s.at - t0)).toEqual([0, 1000, 2000, 3000])
    t.close()
  })

  it('a block page or a Retry-After from either route holds back the other', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const calls: { url: string; at: number }[] = []
    const t = wire(async (url) => {
      calls.push({ url, at: Date.now() })
      if (url.endsWith('/challenge.png')) return new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } })
      if (url.endsWith('/busy')) return new Response('slow down', { status: 429, headers: { 'retry-after': '5' } })
      return new Response('ok', { status: 200 })
    })
    // art meets a challenge: the catalog's next page there fails fast, without a request
    await expect(t.art.fetchBytes('https://a.example/challenge.png')).rejects.toSatisfy((e: unknown) => isNetError(e, 'blocked'))
    await expect(t.catalog.pageFetch('https://a.example/album')).rejects.toSatisfy((e: unknown) => isNetError(e, 'blocked'))
    expect(calls.map((c) => c.url)).toEqual(['https://a.example/challenge.png'])
    // the catalog is told to wait 5 s: art waits too
    const t0 = Date.now()
    await expect(t.catalog.pageFetch('https://b.example/busy', { retries: 0 })).rejects.toThrow(/rate limited/)
    const cover = t.art.fetchBytes('https://b.example/cover.png')
    await vi.advanceTimersByTimeAsync(4900)
    expect(calls.map((c) => c.url)).not.toContain('https://b.example/cover.png')
    await vi.advanceTimersByTimeAsync(200)
    await cover
    expect(calls.at(-1)!.at - t0).toBeGreaterThanOrEqual(5000)
    t.close()
  })

  it('keeps the worker’s priorities in main’s queue: interactive newest first, and moved up when someone opens a queued page', async () => {
    const order: string[] = []
    let release!: () => void
    const t = wire(
      async (url) => {
        order.push(new URL(url).pathname)
        if (url.endsWith('/busy')) await new Promise<void>((r) => (release = r))
        return new Response('ok', { status: 200 })
      },
      { policies: { 'q.test': { concurrency: 1, spacingMs: 0 } } }
    )
    const busy = t.art.fetchBytes('https://q.test/busy')
    await until(() => order.length === 1)
    const pages = [
      t.catalog.pageFetch('https://q.test/crawl-1', { priority: 2 }),
      t.catalog.pageFetch('https://q.test/crawl-2', { priority: 2 }),
      t.catalog.pageFetch('https://q.test/open-1', { priority: 0 }),
      t.catalog.pageFetch('https://q.test/open-2', { priority: 0 })
    ]
    await until(() => t.scheduler.limiter('q.test').pending === 4)
    // the user opens the album the crawl queued
    pages.push(t.catalog.pageFetch('https://q.test/crawl-2', { priority: 0 }))
    await until(() => t.served.some((r) => r.promote))
    await new Promise((r) => setImmediate(r))
    release()
    await Promise.all([busy, ...pages])
    expect(order).toEqual(['/busy', '/crawl-2', '/open-2', '/open-1', '/crawl-1'])
    // a request the worker gives up on while it waits leaves main's queue
    const blocker = t.art.fetchBytes('https://q.test/busy')
    await until(() => order.length === 6)
    const ac = new AbortController()
    const dropped = t.catalog.fetchBytes('https://q.test/never', { signal: ac.signal })
    await until(() => t.scheduler.limiter('q.test').pending === 1)
    ac.abort()
    await expect(dropped).rejects.toSatisfy((e: unknown) => isNetError(e, 'aborted'))
    await until(() => t.scheduler.limiter('q.test').pending === 0)
    release()
    await blocker
    expect(order).not.toContain('/never')
    t.close()
  })
})
