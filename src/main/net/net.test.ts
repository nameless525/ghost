import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { extractAccent } from './accent'
import { errorCode, isNetError, NetError } from './errors'
import { createHttpClient, GHOST_USER_AGENT } from './http'
import { HostLimiter } from './limiter'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('HostLimiter', () => {
  it('caps concurrency and spaces request starts', async () => {
    const l = new HostLimiter({ concurrency: 2, spacingMs: 40 })
    let active = 0
    let peak = 0
    const starts: number[] = []
    const job = async () => {
      starts.push(performance.now())
      active++
      peak = Math.max(peak, active)
      await sleep(60)
      active--
    }
    await Promise.all(Array.from({ length: 6 }, () => l.schedule(job)))
    expect(peak).toBe(2)
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(35)
  })

  it('runs higher-priority jobs first', async () => {
    const l = new HostLimiter({ concurrency: 1, spacingMs: 0 })
    const order: string[] = []
    const blocker = l.schedule(() => sleep(30))
    const bg = l.schedule(async () => void order.push('background'), 2)
    const hi = l.schedule(async () => void order.push('interactive'), 0)
    await Promise.all([blocker, bg, hi])
    expect(order).toEqual(['interactive', 'background'])
  })

  it('runs interactive jobs newest first, the rest in order', async () => {
    // Scrolling past albums A, B, C and stopping on D: D is fetched next, then the others.
    const l = new HostLimiter({ concurrency: 1, spacingMs: 0 })
    const order: string[] = []
    const blocker = l.schedule(() => sleep(30))
    const jobs = [
      ...['bg1', 'bg2'].map((n) => l.schedule(async () => void order.push(n), 2)),
      ...['A', 'B', 'C', 'D'].map((n) => l.schedule(async () => void order.push(n), 0))
    ]
    await Promise.all([blocker, ...jobs])
    expect(order).toEqual(['D', 'C', 'B', 'A', 'bg1', 'bg2'])
  })

  it('promotes a queued job', async () => {
    const l = new HostLimiter({ concurrency: 1, spacingMs: 0 })
    const order: string[] = []
    let promote!: (p: 0 | 1 | 2) => void
    const blocker = l.schedule(() => sleep(20))
    const a = l.schedule(async () => void order.push('a'), 2)
    const b = l.schedule(async () => void order.push('b'), 2, undefined, (p) => (promote = p))
    const c = l.schedule(async () => void order.push('c'), 1)
    promote(0)
    await Promise.all([blocker, a, b, c])
    expect(order).toEqual(['b', 'c', 'a'])
  })

  it('says when a job queued now would start, at its priority', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const l = new HostLimiter({ concurrency: 2, spacingMs: 1000 })
      const order: string[] = []
      const first = l.schedule(async () => void order.push('first'))
      const crawl = l.schedule(async () => void order.push('crawl'), 2) // waits out the spacing
      // only as urgent work waiting is ahead (and interactive jobs go newest first: none is)
      expect([l.readyIn(0), l.readyIn(1), l.readyIn(2), l.readyIn()]).toEqual([1000, 1000, Infinity, Infinity])
      await vi.advanceTimersByTimeAsync(400)
      const open = l.schedule(async () => void order.push('open'), 0)
      expect([l.readyIn(0), l.readyIn(1)]).toEqual([600, Infinity])
      await vi.advanceTimersByTimeAsync(1600)
      await Promise.all([first, crawl, open])
      expect(order).toEqual(['first', 'open', 'crawl'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborting a queued job rejects it without running', async () => {
    const l = new HostLimiter({ concurrency: 1, spacingMs: 0 })
    const ac = new AbortController()
    let ran = false
    const blocker = l.schedule(() => sleep(20))
    const p = l.schedule(async () => void (ran = true), 1, ac.signal)
    ac.abort()
    await expect(p).rejects.toThrow(/aborted/)
    await blocker
    expect(ran).toBe(false)
  })
})

describe('http client', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-http-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function fake(responses: (() => Response | Promise<Response>)[]) {
    const calls: { url: string; init?: RequestInit }[] = []
    let i = 0
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const r = responses[Math.min(i++, responses.length - 1)]
      return r()
    }
    return { fetch, calls }
  }

  it('sends an honest User-Agent and caches pages on disk with a TTL', async () => {
    const f = fake([() => new Response('<html>v1</html>', { status: 200, headers: { 'content-type': 'text/html' } })])
    const c = createHttpClient({ cacheDir: dir, fetch: f.fetch, backoffMs: 1 })
    const a = await c.pageFetch('https://example.test/a', { ttlMs: 60_000 })
    expect(a).toMatchObject({ html: '<html>v1</html>', fromCache: false })
    expect((f.calls[0].init!.headers as Record<string, string>)['User-Agent']).toBe(GHOST_USER_AGENT)
    const b = await c.pageFetch('https://example.test/a', { ttlMs: 60_000 })
    expect(b.fromCache).toBe(true)
    expect(f.calls.length).toBe(1)
    // A fresh client (app restart) reads the same disk cache.
    const c2 = createHttpClient({ cacheDir: dir, fetch: f.fetch })
    expect((await c2.pageFetch('https://example.test/a', { ttlMs: 60_000 })).fromCache).toBe(true)
    expect(f.calls.length).toBe(1)
  })

  it('retries 5xx / network errors with backoff, then succeeds', async () => {
    const f = fake([() => new Response('oops', { status: 502 }), () => Promise.reject(new Error('ECONNRESET')), () => new Response('ok', { status: 200 })])
    const c = createHttpClient({ cacheDir: null, fetch: f.fetch, backoffMs: 1 })
    expect((await c.pageFetch('https://example.test/r')).html).toBe('ok')
    expect(f.calls.length).toBe(3)
  })

  it('404 → not_found without retries', async () => {
    const f = fake([() => new Response('nope', { status: 404 })])
    const c = createHttpClient({ cacheDir: null, fetch: f.fetch, backoffMs: 1 })
    await expect(c.pageFetch('https://example.test/missing')).rejects.toSatisfy((e: unknown) => isNetError(e, 'not_found'))
    expect(f.calls.length).toBe(1)
  })

  it('a Cloudflare block page → typed blocked error, no retries, fail-fast cooldown', async () => {
    const block = '<!DOCTYPE html><title>Attention Required! | Cloudflare</title><h1>Sorry, you have been blocked</h1><div id="cf-error-details"></div>'
    const f = fake([() => new Response(block, { status: 403, headers: { server: 'cloudflare', 'content-type': 'text/html' } })])
    const c = createHttpClient({ cacheDir: null, fetch: f.fetch, backoffMs: 1 })
    const err = await c.pageFetch('https://downloads.khinsider.com/x').catch((e) => e)
    expect(isNetError(err, 'blocked')).toBe(true)
    expect(err.message).toMatch(/^\[blocked\] downloads\.khinsider\.com is blocking requests/)
    expect(errorCode(new Error(err.message))).toBe('blocked')
    expect(f.calls.length).toBe(1)
    expect(c.blockedUntil('downloads.khinsider.com')).toBeGreaterThan(Date.now())
    await expect(c.pageFetch('https://downloads.khinsider.com/y')).rejects.toThrow(/\[blocked\]/)
    expect(f.calls.length).toBe(1)
  })

  it('serves a stale cache entry when the network fails', async () => {
    const ok = fake([() => new Response('cached copy', { status: 200 })])
    const c1 = createHttpClient({ cacheDir: dir, fetch: ok.fetch })
    await c1.pageFetch('https://example.test/stale', { ttlMs: 1 })
    // The page is saved in the background; a cache read on the same client waits for that save
    // (a fixed pause raced slow CI disks).
    expect(await c1.pageFetch('https://example.test/stale', { ttlMs: 60_000 })).toMatchObject({ fromCache: true })
    await sleep(5)
    const bad = fake([() => Promise.reject(new Error('offline'))])
    const c2 = createHttpClient({ cacheDir: dir, fetch: bad.fetch, backoffMs: 1 })
    const r = await c2.pageFetch('https://example.test/stale', { ttlMs: 1, retries: 0 })
    expect(r).toMatchObject({ html: 'cached copy', fromCache: true, stale: true })
  })

  it('de-duplicates concurrent requests for the same URL', async () => {
    const f = fake([async () => (await sleep(20), new Response('once', { status: 200 }))])
    const c = createHttpClient({ cacheDir: null, fetch: f.fetch })
    const [a, b] = await Promise.all([c.pageFetch('https://example.test/d'), c.pageFetch('https://example.test/d')])
    expect(a.html).toBe('once')
    expect(b.html).toBe('once')
    expect(f.calls.length).toBe(1)
  })

  it('one caller aborting a shared request does not fail the others', async () => {
    const f = fake([async () => (await sleep(40), new Response('shared', { status: 200 }))])
    const c = createHttpClient({ cacheDir: null, fetch: f.fetch })
    const search = new AbortController()
    const superseded = c.pageFetch('https://example.test/album', { signal: search.signal, priority: 0 })
    const opened = c.pageFetch('https://example.test/album', { priority: 0 })
    await sleep(5)
    search.abort() // e.g. a newer search query
    await expect(superseded).rejects.toSatisfy((e: unknown) => isNetError(e, 'aborted'))
    expect((await opened).html).toBe('shared')
    expect(f.calls.length).toBe(1)
    // …but when every caller gave up, the request itself is aborted
    const f2 = fake([async () => (await sleep(40), new Response('x', { status: 200 }))])
    const c2 = createHttpClient({ cacheDir: null, fetch: f2.fetch })
    const a1 = new AbortController()
    const a2 = new AbortController()
    const p1 = c2.pageFetch('https://example.test/y', { signal: a1.signal })
    const p2 = c2.pageFetch('https://example.test/y', { signal: a2.signal })
    await sleep(5)
    a1.abort()
    a2.abort()
    await expect(Promise.all([p1, p2])).rejects.toSatisfy((e: unknown) => isNetError(e, 'aborted'))
    expect((f2.calls[0].init?.signal as AbortSignal).aborted).toBe(true)
  })

  it('an interactive caller promotes a queued background request for the same page', async () => {
    const order: string[] = []
    const fetch = async (url: string) => {
      order.push(new URL(url).pathname)
      await sleep(10)
      return new Response('ok', { status: 200 })
    }
    const c = createHttpClient({ cacheDir: null, fetch, policies: { 'q.test': { concurrency: 1, spacingMs: 0 } } })
    const busy = c.pageFetch('https://q.test/busy', { priority: 2 })
    const crawl = ['a', 'b', 'c'].map((n) => c.pageFetch(`https://q.test/${n}`, { priority: 2 }))
    const album = c.pageFetch('https://q.test/c', { priority: 2 })
    await sleep(1)
    const open = c.pageFetch('https://q.test/c', { priority: 0 }) // the user opens the album the crawl queued
    await Promise.all([busy, ...crawl, album, open])
    expect(order).toEqual(['/busy', '/c', '/a', '/b'])
  })

  it('returns before the cache write lands, and a re-read still finds the page', async () => {
    const f = fake([() => new Response('<html>p</html>', { status: 200 })])
    const c = createHttpClient({ cacheDir: dir, fetch: f.fetch })
    await c.pageFetch('https://example.test/fast', { ttlMs: 60_000 })
    const again = await c.pageFetch('https://example.test/fast', { ttlMs: 60_000 })
    expect(again).toMatchObject({ html: '<html>p</html>', fromCache: true })
    expect(f.calls.length).toBe(1)
  })

  it('a request every caller gave up on is never joined: the next caller gets a fetch of its own', async () => {
    const calls: string[] = []
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push(url)
      if (calls.length === 1) {
        return await new Promise<Response>((_r, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      }
      return new Response('fresh', { status: 200 })
    }
    const c = createHttpClient({ cacheDir: null, fetch })
    const ac = new AbortController()
    const first = c.pageFetch('https://example.test/reopen', { signal: ac.signal })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    ac.abort()
    // (at once: the aborted request hasn't finished unwinding yet)
    const again = c.pageFetch('https://example.test/reopen')
    await expect(first).rejects.toSatisfy((e: unknown) => isNetError(e, 'aborted'))
    expect((await again).html).toBe('fresh')
    expect(calls).toHaveLength(2)
  })

  it('a caller that already gave up starts no request and gets no page, cached or not', async () => {
    const f = fake([() => new Response('<html>page</html>', { status: 200 })])
    const c = createHttpClient({ cacheDir: dir, fetch: f.fetch })
    const gone = AbortSignal.abort()
    await expect(c.pageFetch('https://example.test/never', { signal: gone, ttlMs: 60_000 })).rejects.toSatisfy((e: unknown) => isNetError(e, 'aborted'))
    expect(f.calls).toHaveLength(0)
    await c.pageFetch('https://example.test/cached', { ttlMs: 60_000 })
    await expect(c.pageFetch('https://example.test/cached', { signal: gone, ttlMs: 60_000 })).rejects.toSatisfy((e: unknown) => isNetError(e, 'aborted'))
    await expect(c.fetchBytes('https://example.test/bytes', { signal: gone })).rejects.toSatisfy((e: unknown) => isNetError(e, 'aborted'))
    expect(f.calls).toHaveLength(1)
  })

  it('a caller that refuses stale pages never gets one from a caller it shares a request with (either way round)', async () => {
    const url = 'https://example.test/signed-streams'
    const t0 = Date.now()
    const seed = createHttpClient({ cacheDir: dir, fetch: async () => new Response('old signed stream', { status: 200 }), now: () => t0 })
    await seed.pageFetch(url, { ttlMs: 60_000 })
    await seed.pageFetch(url, { ttlMs: 60_000 }) // (waits for the cache write)
    /** Whether the caller with `ac` has joined the request (it listens to its signal then). */
    const joined = (ac: AbortController) => {
      let yes = false
      const add = ac.signal.addEventListener.bind(ac.signal)
      ac.signal.addEventListener = ((...a: Parameters<typeof add>) => ((yes = true), add(...a))) as typeof add
      return () => yes
    }
    for (const strictFirst of [false, true]) {
      let fail!: () => void
      const fetch = () => new Promise<Response>((_r, reject) => (fail = () => reject(new Error('offline'))))
      const c = createHttpClient({ cacheDir: dir, fetch, now: () => t0 + 120_000 })
      const strict = { ttlMs: 60_000, allowStale: false }
      const ordinary = { ttlMs: 60_000 }
      const ac = new AbortController()
      const a = c.pageFetch(url, { ...(strictFirst ? strict : ordinary), retries: 0 })
      await vi.waitFor(() => expect(fail).toBeDefined())
      const b = c.pageFetch(url, { ...(strictFirst ? ordinary : strict), retries: 0, signal: ac.signal })
      const hasJoined = joined(ac)
      await vi.waitFor(() => expect(hasJoined()).toBe(true))
      fail()
      const [first, second] = await Promise.allSettled([a, b])
      const [strictResult, ordinaryResult] = strictFirst ? [first, second] : [second, first]
      expect(strictResult.status).toBe('rejected')
      expect(isNetError((strictResult as PromiseRejectedResult).reason, 'network')).toBe(true)
      expect(ordinaryResult).toMatchObject({ status: 'fulfilled', value: { html: 'old signed stream', stale: true } })
    }
  })

  it('a body cut off or stalled after the headers is retried; a caller giving up meanwhile is not', async () => {
    // (like fetch: the request's signal ends its body too)
    const stalled = (init?: RequestInit) =>
      new Response(new ReadableStream({ start: (ctl) => init?.signal?.addEventListener('abort', () => ctl.error(init.signal!.reason)) }), { status: 200 })
    const cut = () => new Response(new ReadableStream({ pull: (ctl) => ctl.error(new TypeError('terminated')) }), { status: 200 })
    const f = fake([cut, () => new Response('page', { status: 200 })])
    const c = createHttpClient({ cacheDir: null, fetch: f.fetch, backoffMs: 1 })
    expect((await c.pageFetch('https://example.test/cut', { retries: 2 })).html).toBe('page')
    expect(f.calls).toHaveLength(2)
    let n = 0
    const g = createHttpClient({ cacheDir: null, backoffMs: 1, fetch: async (_u, init) => (n++ === 0 ? stalled(init) : new Response(new Uint8Array([1, 2, 3]))) })
    expect([...(await g.fetchBytes('https://example.test/stall', { timeoutMs: 50, retries: 1 })).bytes]).toEqual([1, 2, 3])
    expect(n).toBe(2)
    // giving up while the body arrives: aborted, not retried
    let m = 0
    const h = createHttpClient({ cacheDir: null, backoffMs: 1, fetch: async (_u, init) => (m++, stalled(init)) })
    const ac = new AbortController()
    const p = h.fetchBytes('https://example.test/stall', { signal: ac.signal, retries: 3 })
    await vi.waitFor(() => expect(m).toBe(1))
    ac.abort()
    await expect(p).rejects.toSatisfy((e: unknown) => isNetError(e, 'aborted'))
    expect(m).toBe(1)
  })

  it('NetError carries code, status and a [code] message prefix', () => {
    const e = new NetError('http', 'HTTP 503', { status: 503 })
    expect(e.retryable).toBe(true)
    expect(e.message).toBe('[http] HTTP 503')
  })
})

describe('accent extraction', () => {
  const img = (fill: (i: number) => [number, number, number], n = 400, order: 'rgba' | 'bgra' = 'rgba') => {
    const px = new Uint8Array(n * 4)
    for (let i = 0; i < n; i++) {
      const [r, g, b] = fill(i)
      px.set(order === 'rgba' ? [r, g, b, 255] : [b, g, r, 255], i * 4)
    }
    return px
  }
  const hue = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g = parseInt(hex.slice(3, 5), 16) / 255
    const b = parseInt(hex.slice(5, 7), 16) / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const d = max - min
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return h * 60
  }

  it('picks the vivid colour, not the dominant dark/grey background', () => {
    const px = img((i) => (i % 10 === 0 ? [40, 200, 90] : [30, 30, 34]))
    const a = extractAccent(px, 'rgba')!
    expect(a).toMatch(/^#[0-9a-f]{6}$/)
    expect(hue(a)).toBeGreaterThan(120)
    expect(hue(a)).toBeLessThan(150)
  })

  it('respects BGRA byte order (nativeImage.toBitmap)', () => {
    const red = extractAccent(img(() => [220, 30, 40], 100, 'bgra'), 'bgra')!
    expect(hue(red) < 15 || hue(red) > 345).toBe(true)
  })

  it('returns null for greyscale art', () => {
    expect(extractAccent(img((i) => [i % 255, i % 255, i % 255]), 'rgba')).toBeNull()
  })

  it('normalises lightness for a dark UI', () => {
    const a = extractAccent(img(() => [10, 20, 90]), 'rgba')!
    const max = Math.max(...[1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16)))
    expect(max).toBeGreaterThan(150)
  })
})
