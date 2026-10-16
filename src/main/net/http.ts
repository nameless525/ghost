// HTTP for providers. Page (HTML) requests go through Electron's Chromium network stack
// (`net.fetch`): downloads.khinsider.com sits behind Cloudflare and refuses non-browser HTTP
// clients, but serves Chromium normally. We do NOT try to get around bot protection: if we see a
// block or challenge page we stop and raise a typed `blocked` error so the UI can tell the user.
//
// Politeness: per-host concurrency + spacing (HostLimiter), Retry-After pauses, retries with
// exponential backoff and an honest User-Agent, all in one HostScheduler per process that talks to
// the network (the main process: the catalog worker's requests run in its scheduler too, see
// rpc-fetch.ts), and an on-disk HTML cache so the same page isn't fetched twice in a week.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GHOST_VERSION } from '../../shared/version'
import { blockedMessage, NetError } from './errors'
import { HostLimiter, type Priority } from './limiter'

export const GHOST_USER_AGENT = `GHOST/${GHOST_VERSION} (video game soundtrack player; +https://github.com/nameless525/ghost)`

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
  // The Internet Archive's JSON APIs and its item covers (its downloads stream through the engine).
  'archive.org': { concurrency: 2, spacingMs: 250 },
  'api.igdb.com': { concurrency: 2, spacingMs: 260 },
  'id.twitch.tv': { concurrency: 1, spacingMs: 1000 },
  'www.steamgriddb.com': { concurrency: 1, spacingMs: 300 },
  // Chiptune rip archives: listing pages only (archives go through the engine), gently.
  'nsf.joshw.info': { concurrency: 1, spacingMs: 1500 },
  'spc.joshw.info': { concurrency: 1, spacingMs: 1500 },
  'gbs.joshw.info': { concurrency: 1, spacingMs: 1500 },
  'hes.joshw.info': { concurrency: 1, spacingMs: 1500 },
  'kss.joshw.info': { concurrency: 1, spacingMs: 1500 },
  'vgmrips.net': { concurrency: 2, spacingMs: 1000 },
  // Zophar's Domain listing / album pages (the MP3 host fi.zophar.net streams through the engine).
  'www.zophar.net': { concurrency: 1, spacingMs: 1000 },
  // Modland's daily index file (files stream through the engine).
  'ftp.modland.com': { concurrency: 1, spacingMs: 1000 }
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

/** One GET for a HostScheduler. Plain data: it crosses from the catalog worker to main as is. */
export interface NetRequest {
  /** The Accept header. */
  accept: string
  priority?: Priority
  /** Per attempt, reading the body included. */
  timeoutMs?: number
  retries?: number
  headers?: Record<string, string>
}

/** A successful (2xx) response, its body read whole. */
export interface NetResponse {
  /** Final URL after redirects. */
  url: string
  status: number
  contentType: string | null
  body: Uint8Array
}

/**
 * Where the politeness lives: each host's limiter (concurrency, spacing, priorities, Retry-After
 * pauses), the fail-fast cooldown after a block page, and retries with backoff. Everything that
 * reaches one host should share one scheduler, or the limits only hold per caller.
 */
export interface HostScheduler {
  /**
   * GET `url` in its host's turn, retrying what's worth retrying. `onQueued` receives a
   * `promote(priority)` that moves the request up while it waits (an interactive caller joined a
   * background one). Rejects with a NetError.
   */
  request(url: string, req: NetRequest, signal?: AbortSignal, onQueued?: (promote: (p: Priority) => void) => void): Promise<NetResponse>
  limiter(host: string): HostLimiter
  /** Host currently considered blocked (fail fast) until this epoch ms, or 0. */
  blockedUntil(host: string): number
}

export interface HostSchedulerOptions {
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

export interface HttpClientOptions extends HostSchedulerOptions {
  /** Directory for the HTML cache; null disables it. */
  cacheDir: string | null
  /** The scheduler requests go through (default: a scheduler of its own, over `fetch`). */
  scheduler?: HostScheduler
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

const PAGE_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
const BYTES_ACCEPT = 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5'

/** What detectBlock needs of a body: its head, or all of an error page (which may be a challenge). */
function blockProbe(status: number, body: Uint8Array): string {
  const whole = status === 403 || status === 503 || status === 429
  return new TextDecoder().decode(whole ? body : body.subarray(0, 24_000))
}

export function createHostScheduler(options: HostSchedulerOptions = {}): HostScheduler {
  const fetchImpl = options.fetch ?? electronFetch
  const ua = options.userAgent ?? GHOST_USER_AGENT
  const policies = { ...DEFAULT_HOST_POLICIES, ...(options.policies ?? {}) }
  const now = options.now ?? Date.now
  const backoff = options.backoffMs ?? 1000
  const blockCooldown = options.blockCooldownMs ?? 90_000
  const log = options.log ?? (() => {})
  const limiters = new Map<string, HostLimiter>()
  const blocked = new Map<string, number>()

  const limiter = (host: string): HostLimiter => {
    let l = limiters.get(host)
    if (!l) {
      l = new HostLimiter({ ...(policies[host] ?? FALLBACK_POLICY), now })
      limiters.set(host, l)
    }
    return l
  }

  /** One attempt, its body read too: whatever goes wrong on the way comes out as a NetError. */
  async function attempt(url: string, host: string, req: NetRequest, signal?: AbortSignal): Promise<NetResponse> {
    if ((blocked.get(host) ?? 0) > now()) throw new NetError('blocked', blockedMessage(host), { url })
    const timeout = AbortSignal.timeout(req.timeoutMs ?? 20_000)
    let res: Response
    let body: Uint8Array
    try {
      res = await fetchImpl(url, {
        headers: { 'User-Agent': ua, Accept: req.accept, 'Accept-Language': 'en', ...(req.headers ?? {}) },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'follow'
      })
      // (a connection that drops or stalls mid-body is as retryable as one that never answered)
      body = new Uint8Array(await res.arrayBuffer())
    } catch (e) {
      if (signal?.aborted) throw new NetError('aborted', 'request aborted', { url })
      if (timeout.aborted) throw new NetError('timeout', `timed out fetching ${url}`, { url })
      throw new NetError('network', `network error fetching ${url}: ${(e as Error).message}`, { url, cause: e })
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'))
      limiter(host).pause(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 10_000)
    }
    if (detectBlock(res.status, res.headers, blockProbe(res.status, body))) {
      blocked.set(host, now() + blockCooldown)
      throw new NetError('blocked', blockedMessage(host), { status: res.status, url })
    }
    if (res.status === 404 || res.status === 410) throw new NetError('not_found', `not found: ${url}`, { status: res.status, url })
    if (res.status === 429) throw new NetError('http', `rate limited by ${host}`, { status: 429, url, retryable: true })
    if (!res.ok) throw new NetError('http', `HTTP ${res.status} from ${url}`, { status: res.status, url })
    return { url: res.url || url, status: res.status, contentType: res.headers.get('content-type'), body }
  }

  return {
    limiter,
    blockedUntil: (host) => {
      const t = blocked.get(host) ?? 0
      return t > now() ? t : 0
    },

    async request(url, req, signal, onQueued) {
      const host = new URL(url).host
      // Each attempt queues anew, at the most urgent priority asked for by then.
      const prio: { value: Priority; promote: ((p: Priority) => void) | null } = { value: req.priority ?? 1, promote: null }
      onQueued?.((p) => {
        if (p >= prio.value) return
        prio.value = p
        prio.promote?.(p)
      })
      const retries = req.retries ?? 3
      for (let i = 0; ; i++) {
        try {
          const run = () => {
            prio.promote = null // started: nothing left to promote
            return attempt(url, host, req, signal)
          }
          return await limiter(host).schedule(run, prio.value, signal, (promote) => (prio.promote = promote))
        } catch (e) {
          const ne = e instanceof NetError ? e : null
          if (!ne || !ne.retryable || i >= retries) throw e
          const delay = backoff * Math.pow(3, i) * (0.8 + Math.random() * 0.4)
          log(`retrying ${url} in ${Math.round(delay)}ms (${ne.message})`)
          await sleep(delay, signal)
        }
      }
    }
  }
}

/**
 * A page request shared by every concurrent caller for the same URL. It runs with its own abort
 * signal, aborted only once every caller that could abort has (one caller giving up, e.g. a
 * superseded search, must not fail the others), and it is promoted to the most urgent priority
 * among its callers while still queued (opening an album the crawl has queued in the background).
 * Only the network result is shared: falling back to a stale copy is each caller's own choice.
 */
interface SharedPage {
  promise: Promise<PageResult>
  ctl: AbortController
  priority: Priority
  promote: ((p: Priority) => void) | null
  /** Callers still waiting that can abort. */
  abortable: number
  /** A caller without a signal joined: never abort. */
  pinned: boolean
  /** Some caller wants the page in the disk cache. */
  cache: boolean
}

const aborted = (url: string) => new NetError('aborted', 'request aborted', { url })

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const scheduler = options.scheduler ?? createHostScheduler(options)
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const inflight = new Map<string, SharedPage>()

  const cachePaths = (url: string) => {
    const h = sha1(url)
    const dir = join(options.cacheDir!, h.slice(0, 2))
    return { dir, body: join(dir, `${h}.html`), meta: join(dir, `${h}.json`) }
  }

  /** Cache writes still in progress (pageFetch doesn't wait for them; a read of the same URL does). */
  const pendingWrites = new Map<string, Promise<void>>()

  async function readCache(url: string): Promise<{ meta: CacheMeta; html: string } | null> {
    if (!options.cacheDir) return null
    const pending = pendingWrites.get(url)
    if (pending) await pending
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
      const tag = `${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(`${p.body}.${tag}`, html)
      await rename(`${p.body}.${tag}`, p.body)
      // Atomic too: a concurrent reader never sees half a meta file.
      await writeFile(`${p.meta}.${tag}`, JSON.stringify({ url, status, fetchedAt } satisfies CacheMeta))
      await rename(`${p.meta}.${tag}`, p.meta)
    } catch (e) {
      log(`html cache write failed: ${(e as Error).message}`)
    }
  }

  /** The network request for `url` that concurrent callers join. */
  function startShared(url: string, opts: PageFetchOptions, cache: boolean): SharedPage {
    const shared: SharedPage = { promise: null!, ctl: new AbortController(), priority: opts.priority ?? 1, promote: null, abortable: 0, pinned: false, cache }
    const req: NetRequest = { accept: PAGE_ACCEPT, priority: shared.priority, timeoutMs: opts.timeoutMs, retries: opts.retries, headers: opts.headers }
    const p = scheduler
      .request(url, req, shared.ctl.signal, (promote) => (shared.promote = promote))
      .then((r) => {
        const page: PageResult = { url: r.url, status: r.status, html: new TextDecoder().decode(r.body), fromCache: false, stale: false, fetchedAt: now() }
        // Written in the background: the caller has the page now (2–5 ms of disk work saved per
        // album open / listing). Reads of this URL wait for the write (see readCache).
        if (shared.cache) {
          const w: Promise<void> = writeCache(url, page.status, page.html, page.fetchedAt).finally(() => {
            if (pendingWrites.get(url) === w) pendingWrites.delete(url)
          })
          pendingWrites.set(url, w)
        }
        return page
      })
      .finally(() => {
        if (inflight.get(url) === shared) inflight.delete(url)
      })
    shared.promise = p
    // Nobody may be listening by the time it fails (every caller aborted): that's fine.
    p.catch(() => {})
    inflight.set(url, shared)
    return shared
  }

  /** Wait for a shared page request as one of its callers (with this caller's own abort / priority). */
  function joinShared(url: string, shared: SharedPage, opts: PageFetchOptions): Promise<PageResult> {
    const p = opts.priority ?? 1
    if (p < shared.priority) {
      shared.priority = p
      shared.promote?.(p)
    }
    const signal = opts.signal
    if (!signal) return ((shared.pinned = true), shared.promise)
    if (signal.aborted) return Promise.reject(aborted(url))
    shared.abortable++
    return new Promise<PageResult>((resolve, reject) => {
      let done = false
      const leave = () => {
        done = true
        signal.removeEventListener('abort', onAbort)
        shared.abortable--
      }
      const onAbort = () => {
        if (done) return
        leave()
        reject(aborted(url))
        if (shared.abortable === 0 && !shared.pinned) {
          shared.ctl.abort()
          // (still winding down: a caller from now on starts a request of its own)
          if (inflight.get(url) === shared) inflight.delete(url)
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      shared.promise.then(
        (r) => {
          if (done) return
          leave()
          resolve(r)
        },
        (e) => {
          if (done) return
          leave()
          reject(e)
        }
      )
    })
  }

  return {
    limiter: (host) => scheduler.limiter(host),
    blockedUntil: (host) => scheduler.blockedUntil(host),

    async invalidate(url) {
      if (!options.cacheDir) return
      await pendingWrites.get(url) // or the write in flight would bring it back
      const p = cachePaths(url)
      await Promise.all([rm(p.body, { force: true }), rm(p.meta, { force: true })])
    },

    async pageFetch(url, opts = {}) {
      const ttl = opts.ttlMs ?? 0
      const useCache = opts.cache ?? ttl > 0
      const allowStale = opts.allowStale ?? true
      // A caller that has given up starts nothing (and gets nothing, not even a cached page).
      if (opts.signal?.aborted) throw aborted(url)
      const cached = ttl > 0 || allowStale ? await readCache(url) : null
      if (opts.signal?.aborted) throw aborted(url)
      if (cached && !opts.force && ttl > 0 && now() - cached.meta.fetchedAt < ttl) {
        return { url, status: cached.meta.status, html: cached.html, fromCache: true, stale: false, fetchedAt: cached.meta.fetchedAt }
      }
      let shared = inflight.get(url)
      if (shared && !shared.ctl.signal.aborted) shared.cache ||= useCache
      else shared = startShared(url, opts, useCache)
      try {
        return await joinShared(url, shared, opts)
      } catch (e) {
        // This caller's own fallback (another one sharing the request may not take a stale copy).
        const code = e instanceof NetError ? e.code : null
        if (cached && allowStale && code !== 'not_found' && code !== 'aborted') {
          log(`serving stale ${url}: ${(e as Error).message}`)
          return { url, status: cached.meta.status, html: cached.html, fromCache: true, stale: true, fetchedAt: cached.meta.fetchedAt }
        }
        throw e
      }
    },

    async fetchBytes(url, opts = {}) {
      const r = await scheduler.request(url, { accept: BYTES_ACCEPT, priority: opts.priority, timeoutMs: opts.timeoutMs, retries: opts.retries, headers: opts.headers }, opts.signal)
      return { url: r.url, status: r.status, bytes: Buffer.from(r.body.buffer, r.body.byteOffset, r.body.byteLength), contentType: r.contentType }
    }
  }
}
