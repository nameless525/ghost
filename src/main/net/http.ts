// HTTP for providers. Page (HTML) requests go through Electron's Chromium network stack
// (`net.fetch`): downloads.khinsider.com sits behind Cloudflare and refuses non-browser HTTP
// clients, but serves Chromium normally. We do NOT try to get around bot protection: if we see a
// block or challenge page we stop and raise a typed `blocked` error so the UI can tell the user.
//
// Politeness: per-host concurrency + spacing (HostLimiter), retries with exponential backoff, an
// honest User-Agent, and an on-disk HTML cache so the same page isn't fetched twice in a week.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GHOST_VERSION } from '../../shared/version'
import { blockedMessage, NetError } from './errors'
import { HostLimiter, type Priority } from './limiter'

export const GHOST_USER_AGENT = `GHOST/${GHOST_VERSION} (personal video game soundtrack player)`

export const DAY = 24 * 3600_000
export const TTL = {
  album: 7 * DAY,
  browse: 1 * DAY,
  search: 3600_000
} as const

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * `fetch` through Electron's Chromium network stack (main process only). Imported lazily so tests
 * and the catalog worker can load this module. Chromium's HTTP cache is bypassed: callers keep their
 * own disk caches (HTML, art), and Chromium's had grown to hundreds of MB duplicating them.
 */
export const electronFetch: FetchLike = async (url, init) => {
  const { net } = await import('electron')
  return net.fetch(url, { cache: 'no-store', ...(init ?? {}) } as Parameters<typeof net.fetch>[1])
}

export interface HostPolicy {
  concurrency: number
  spacingMs: number
}

export const DEFAULT_HOST_POLICIES: Record<string, HostPolicy> = {
  'downloads.khinsider.com': { concurrency: 2, spacingMs: 250 },
  'api.igdb.com': { concurrency: 2, spacingMs: 260 },
  'id.twitch.tv': { concurrency: 1, spacingMs: 1000 },
  'www.steamgriddb.com': { concurrency: 1, spacingMs: 300 },
  // Chiptune rip archives: listing pages only (archives go through the engine), gently.
  'nsf.joshw.info': { concurrency: 1, spacingMs: 1500 },
  'spc.joshw.info': { concurrency: 1, spacingMs: 1500 },
  'gbs.joshw.info': { concurrency: 1, spacingMs: 1500 },
  'hes.joshw.info': { concurrency: 1, spacingMs: 1500 },
  'kss.joshw.info': { concurrency: 1, spacingMs: 1500 },
  'vgmrips.net': { concurrency: 2, spacingMs: 1000 }
}
const FALLBACK_POLICY: HostPolicy = { concurrency: 4, spacingMs: 0 }

export interface PageFetchOptions {
  /** Serve from the disk cache when younger than this. 0 / undefined = always fetch (still writes the cache when `cache` is true). */
  ttlMs?: number
  /** Write successful responses to the disk cache (default: when ttlMs > 0). */
  cache?: boolean
  priority?: Priority
  /** Ignore a fresh cache entry and fetch anyway. */
  force?: boolean
  /** On failure, fall back to an expired cache entry (default true). */
  allowStale?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  retries?: number
  headers?: Record<string, string>
}

export interface PageResult {
  url: string
  status: number
  html: string
  fromCache: boolean
  /** True when served from an expired cache entry because the network request failed. */
  stale: boolean
  fetchedAt: number
}

export interface BytesResult {
  url: string
  status: number
  bytes: Buffer
  contentType: string | null
}

export interface HttpClient {
  pageFetch(url: string, opts?: PageFetchOptions): Promise<PageResult>
  fetchBytes(url: string, opts?: Omit<PageFetchOptions, 'ttlMs' | 'cache' | 'allowStale' | 'force'>): Promise<BytesResult>
  limiter(host: string): HostLimiter
  /** Host currently considered blocked (fail fast) until this epoch ms, or 0. */
  blockedUntil(host: string): number
  /** Drop a cached page (e.g. when its content turned out to be unusable). */
  invalidate(url: string): Promise<void>
}

export interface HttpClientOptions {
  /** Directory for the HTML cache; null disables it. */
  cacheDir: string | null
  fetch?: FetchLike
  userAgent?: string
  policies?: Record<string, HostPolicy>
  now?: () => number
  /** Base for exponential backoff (ms). */
  backoffMs?: number
  /** How long to fail fast after a block page (ms). */
  blockCooldownMs?: number
  log?: (msg: string) => void
}

/** Recognise bot-protection block / challenge pages (Cloudflare and similar). */
export function detectBlock(status: number, headers: Headers, body: string): boolean {
  if (headers.get('cf-mitigated')) return true
  const head = body.slice(0, 6000)
  const cfMarkers = /you have been blocked|attention required!? \| cloudflare|cf-error-details|challenge-platform|cf_chl_|just a moment\.\.\./i
  if (status === 403 || status === 503 || status === 429) {
    const server = headers.get('server') ?? ''
    if (/cloudflare/i.test(server) && cfMarkers.test(body)) return true
    if (cfMarkers.test(head)) return true
  }
  // Interstitials occasionally come back with 200.
  if (/<title>\s*(just a moment\.\.\.|attention required! \| cloudflare)/i.test(head)) return true
  return false
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new NetError('aborted', 'request aborted'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new NetError('aborted', 'request aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

interface CacheMeta {
  url: string
  status: number
  fetchedAt: number
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const fetchImpl = options.fetch ?? electronFetch
  const ua = options.userAgent ?? GHOST_USER_AGENT
  const policies = { ...DEFAULT_HOST_POLICIES, ...(options.policies ?? {}) }
  const now = options.now ?? Date.now
  const backoff = options.backoffMs ?? 1000
  const blockCooldown = options.blockCooldownMs ?? 90_000
  const log = options.log ?? (() => {})
  const limiters = new Map<string, HostLimiter>()
  const blocked = new Map<string, number>()
  const inflight = new Map<string, Promise<PageResult>>()

  const limiter = (host: string): HostLimiter => {
    let l = limiters.get(host)
    if (!l) {
      l = new HostLimiter({ ...(policies[host] ?? FALLBACK_POLICY), now })
      limiters.set(host, l)
    }
    return l
  }

  const cachePaths = (url: string) => {
    const h = sha1(url)
    const dir = join(options.cacheDir!, h.slice(0, 2))
    return { dir, body: join(dir, `${h}.html`), meta: join(dir, `${h}.json`) }
  }

  async function readCache(url: string): Promise<{ meta: CacheMeta; html: string } | null> {
    if (!options.cacheDir) return null
    const p = cachePaths(url)
    try {
      const [m, html] = await Promise.all([readFile(p.meta, 'utf8'), readFile(p.body, 'utf8')])
      const meta = JSON.parse(m) as CacheMeta
      if (meta.url !== url) return null
      return { meta, html }
    } catch {
      return null
    }
  }

  async function writeCache(url: string, status: number, html: string, fetchedAt: number): Promise<void> {
    if (!options.cacheDir) return
    const p = cachePaths(url)
    try {
      await mkdir(p.dir, { recursive: true })
      const tmp = `${p.body}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(tmp, html)
      await rename(tmp, p.body)
      await writeFile(p.meta, JSON.stringify({ url, status, fetchedAt } satisfies CacheMeta))
    } catch (e) {
      log(`html cache write failed: ${(e as Error).message}`)
    }
  }

  async function once(url: string, opts: PageFetchOptions, accept: string): Promise<Response> {
    const host = new URL(url).host
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    let res: Response
    try {
      res = await fetchImpl(url, {
        headers: { 'User-Agent': ua, Accept: accept, 'Accept-Language': 'en', ...(opts.headers ?? {}) },
        signal,
        redirect: 'follow'
      })
    } catch (e) {
      if (opts.signal?.aborted) throw new NetError('aborted', 'request aborted', { url })
      if (timeout.aborted) throw new NetError('timeout', `timed out fetching ${url}`, { url })
      throw new NetError('network', `network error fetching ${url}: ${(e as Error).message}`, { url, cause: e })
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'))
      limiter(host).pause(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 10_000)
    }
    return res
  }

  async function withRetry<T>(url: string, opts: PageFetchOptions, fn: () => Promise<T>): Promise<T> {
    const host = new URL(url).host
    const retries = opts.retries ?? 3
    for (let attempt = 0; ; attempt++) {
      try {
        return await limiter(host).schedule(fn, opts.priority ?? 1, opts.signal)
      } catch (e) {
        const ne = e instanceof NetError ? e : null
        if (!ne || !ne.retryable || attempt >= retries) throw e
        const delay = backoff * Math.pow(3, attempt) * (0.8 + Math.random() * 0.4)
        log(`retrying ${url} in ${Math.round(delay)}ms (${ne.message})`)
        await sleep(delay, opts.signal)
      }
    }
  }

  async function fetchPage(url: string, opts: PageFetchOptions): Promise<PageResult> {
    const host = new URL(url).host
    return withRetry(url, opts, async () => {
      if ((blocked.get(host) ?? 0) > now()) throw new NetError('blocked', blockedMessage(host), { url })
      const res = await once(url, opts, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8')
      const html = await res.text()
      if (detectBlock(res.status, res.headers, html)) {
        blocked.set(host, now() + blockCooldown)
        throw new NetError('blocked', blockedMessage(host), { status: res.status, url })
      }
      if (res.status === 404 || res.status === 410) throw new NetError('not_found', `not found: ${url}`, { status: res.status, url })
      if (res.status === 429) throw new NetError('http', `rate limited by ${host}`, { status: 429, url, retryable: true })
      if (!res.ok) throw new NetError('http', `HTTP ${res.status} from ${url}`, { status: res.status, url })
      return { url: res.url || url, status: res.status, html, fromCache: false, stale: false, fetchedAt: now() }
    })
  }

  return {
    limiter,
    blockedUntil: (host) => {
      const t = blocked.get(host) ?? 0
      return t > now() ? t : 0
    },

    async invalidate(url) {
      if (!options.cacheDir) return
      const p = cachePaths(url)
      await Promise.all([rm(p.body, { force: true }), rm(p.meta, { force: true })])
    },

    async pageFetch(url, opts = {}) {
      const ttl = opts.ttlMs ?? 0
      const useCache = opts.cache ?? ttl > 0
      const allowStale = opts.allowStale ?? true
      const cached = ttl > 0 || allowStale ? await readCache(url) : null
      if (cached && !opts.force && ttl > 0 && now() - cached.meta.fetchedAt < ttl) {
        return { url, status: cached.meta.status, html: cached.html, fromCache: true, stale: false, fetchedAt: cached.meta.fetchedAt }
      }
      const existing = inflight.get(url)
      if (existing) return existing
      const p = fetchPage(url, opts)
        .then(async (r) => {
          if (useCache) await writeCache(url, r.status, r.html, r.fetchedAt)
          return r
        })
        .catch((e: unknown) => {
          const code = e instanceof NetError ? e.code : null
          if (cached && allowStale && code !== 'not_found' && code !== 'aborted') {
            log(`serving stale ${url}: ${(e as Error).message}`)
            return { url, status: cached.meta.status, html: cached.html, fromCache: true, stale: true, fetchedAt: cached.meta.fetchedAt }
          }
          throw e
        })
        .finally(() => inflight.delete(url))
      inflight.set(url, p)
      return p
    },

    async fetchBytes(url, opts = {}) {
      const host = new URL(url).host
      return withRetry(url, opts, async () => {
        if ((blocked.get(host) ?? 0) > now()) throw new NetError('blocked', blockedMessage(host), { url })
        const res = await once(url, opts, 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5')
        const type = res.headers.get('content-type')
        if (type?.includes('text/html')) {
          const body = await res.text()
          if (detectBlock(res.status, res.headers, body)) {
            blocked.set(host, now() + blockCooldown)
            throw new NetError('blocked', blockedMessage(host), { status: res.status, url })
          }
        }
        if (res.status === 404 || res.status === 410) throw new NetError('not_found', `not found: ${url}`, { status: res.status, url })
        if (res.status === 429) throw new NetError('http', `rate limited by ${host}`, { status: 429, url, retryable: true })
        if (!res.ok) throw new NetError('http', `HTTP ${res.status} from ${url}`, { status: res.status, url })
        const bytes = Buffer.from(await res.arrayBuffer())
        return { url: res.url || url, status: res.status, bytes, contentType: type }
      })
    }
  }
}
