// `ghost-art://` protocol: serves remote artwork with an on-disk cache and permissive CORS so the
// renderer can use it as WebGL textures.
//
//   ghost-art://img/?u=<encodeURIComponent(https url)>[&w=<width px>]
//
// Nothing here blocks the main thread (on macOS it also delivers window input): decoding,
// resizing, re-encoding and the accent colour run in the native art pipeline (`processArt`,
// native/crates/ghost-art on a small Rust thread pool), all disk I/O is async, and Electron's
// nativeImage is never used.
//
// Sizes: every image the renderer receives is capped. Without `w` it gets the base image, at most
// 1600 px wide (KHInsider scans can be 3000+ px PNGs). `w` snaps up to a bucket (ART_BUCKETS) so
// each cover has at most a handful of variants on disk. Nothing is ever upscaled. Small enough
// originals (≤ 1600 px, ≤ 1.5 MB) are kept byte-for-byte.
//
// Cache: <userData>/art/<sha1[0..2]>/<sha1> (bytes) + <sha1>.json (ArtMeta). Base: sha1(url);
// variant: sha1(`${url}#w=${bucket}`). The base meta also stores the cover's accent colour, so
// accents of cached covers never need another decode.
//
// Network: Chromium's stack (`net.fetch`, Cloudflare-friendly) with `cache: 'no-store'`: this
// cache is the only one (Chromium's HTTP cache used to hold a second copy of every cover), and
// requests go through the shared per-host limiter so politeness limits hold app-wide.
import { protocol } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artAccentOf, artPipelineAvailable, processArt } from '../engine/native'
import { paths } from '../paths'
import { accentHex } from './accent'
import { blockedMessage, isNetError, NetError } from './errors'
import { detectBlock, GHOST_USER_AGENT, type FetchLike } from './http'
import { sharedHttp } from './shared'

export const ART_SCHEME = 'ghost-art'

/** Widths (px) a `w` request snaps up to. The largest is also the cap for un-sized requests. */
export const ART_BUCKETS = [128, 256, 512, 768, 1024, 1600] as const
const BASE_MAX_WIDTH = 1600
/** Height cap relative to the width cap (guards against absurd strips; covers never get near). */
const MAX_ASPECT = 2
/** Originals within the size caps and at most this big are served byte-for-byte. */
const PASSTHROUGH_MAX_BYTES = 1_500_000
const JPEG_QUALITY = 85
/** Bump when the meaning of cached files changes; older entries are re-processed lazily. */
const META_VERSION = 2
const CORS = { 'access-control-allow-origin': '*' }

/** The bucket a requested width snaps to (smallest bucket ≥ w; the largest for anything bigger). */
export function artBucket(w: number): number {
  for (const b of ART_BUCKETS) if (w <= b) return b
  return BASE_MAX_WIDTH
}

/** Bucket for a `w` request, or undefined when that is just the base image. */
function variantFor(w: number | undefined): number | undefined {
  if (w === undefined || !Number.isFinite(w) || w <= 0) return undefined
  const b = artBucket(w)
  return b >= BASE_MAX_WIDTH ? undefined : b
}

/** Must run before app 'ready'. */
export function registerArtScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ART_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
  ])
}

/** Call after app 'ready'. */
export function handleArtProtocol(): void {
  protocol.handle(ART_SCHEME, async (req) => {
    let target: string | null = null
    let w: number | undefined
    try {
      const u = new URL(req.url)
      target = u.searchParams.get('u')
      const wp = Number(u.searchParams.get('w'))
      w = Number.isFinite(wp) && wp > 0 ? wp : undefined
    } catch {
      /* fall through */
    }
    if (!target || !/^https?:\/\//i.test(target)) return new Response('bad art url', { status: 400, headers: { ...CORS, 'cache-control': 'no-store' } })
    try {
      const art = await getArt(target, w)
      return new Response(new Uint8Array(art.bytes), {
        status: 200,
        headers: { ...CORS, 'content-type': art.type, 'content-length': String(art.bytes.length), 'cache-control': 'public, max-age=31536000, immutable' }
      })
    } catch (e) {
      const status = isNetError(e, 'not_found') ? 404 : 502
      return new Response(null, { status, headers: { ...CORS, 'cache-control': 'no-store' } })
    }
  })
}

// ---------------------------------------------------------------------------
// Listeners

type FetchedListener = (url: string, bytes: Buffer, contentType: string) => void
type AccentListener = (url: string, accentHex: string | null) => void
const fetchedListeners = new Set<FetchedListener>()
const accentListeners = new Set<AccentListener>()

/** Notified (asynchronously) whenever an image is fetched from the network for the first time. */
export function onArtFetched(fn: FetchedListener): () => void {
  fetchedListeners.add(fn)
  return () => fetchedListeners.delete(fn)
}

/**
 * Notified (asynchronously) whenever an image is fetched from the network for the first time,
 * with its accent colour ('#rrggbb', or null for greyscale art), computed off-thread while the
 * image was being processed anyway. Plain data, so it can be forwarded to a worker as is.
 */
export function onArtAccent(fn: AccentListener): () => void {
  accentListeners.add(fn)
  return () => accentListeners.delete(fn)
}

// ---------------------------------------------------------------------------
// Cache

let dirOverride: string | null = null
let defaultDir: string | null = null
/** Use a different cache directory (smoke tests). */
export function setArtDir(dir: string | null): void {
  dirOverride = dir
  madeDirs.clear()
}
// paths.art() does a synchronous mkdir: resolve it once.
const artDir = () => dirOverride ?? (defaultDir ??= paths.art())

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

function cachePaths(url: string, w?: number) {
  const h = sha1(w ? `${url}#w=${w}` : url)
  const d = join(artDir(), h.slice(0, 2))
  return { d, data: join(d, h), meta: join(d, `${h}.json`) }
}

interface ArtMeta {
  /** META_VERSION when written by this pipeline (absent in older entries). */
  v?: number
  type: string
  url: string
  /** Variant bucket, or null for the base image. */
  w: number | null
  width: number | null
  height: number | null
  /** Base images: '#rrggbb', or null for greyscale art. Absent = not computed yet. */
  accent?: string | null
  at: number
}

export interface ArtBytes {
  bytes: Buffer
  type: string
}

interface CachedArt extends ArtBytes {
  meta: ArtMeta
}

async function readMeta(path: string, url: string): Promise<ArtMeta | null> {
  try {
    const m = JSON.parse(await readFile(path, 'utf8')) as ArtMeta
    return m.url === url ? m : null
  } catch {
    return null
  }
}

async function readCached(url: string, w?: number): Promise<CachedArt | null> {
  const p = cachePaths(url, w)
  const [meta, bytes] = await Promise.all([readMeta(p.meta, url), readFile(p.data).catch(() => null)])
  return meta && bytes ? { bytes, type: meta.type, meta } : null
}

/** Cached image bytes (`w` = exact variant bucket), or null. */
export async function readCachedArt(url: string, w?: number): Promise<ArtBytes | null> {
  const c = await readCached(url, variantFor(w))
  return c ? { bytes: c.bytes, type: c.type } : null
}

const madeDirs = new Set<string>()

async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

async function writeCached(url: string, w: number | undefined, bytes: Buffer, meta: ArtMeta): Promise<void> {
  const p = cachePaths(url, w)
  if (!madeDirs.has(p.d)) {
    await mkdir(p.d, { recursive: true })
    madeDirs.add(p.d)
  }
  await writeAtomic(p.data, bytes)
  await writeAtomic(p.meta, JSON.stringify(meta))
}

function sniffType(bytes: Buffer, header: string | null): string | null {
  if (bytes.length >= 4) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  }
  const h = (header ?? '').split(';')[0].trim().toLowerCase()
  return h.startsWith('image/') ? h : null
}

// ---------------------------------------------------------------------------
// Network

let fetchImpl: FetchLike = async (url, init) => {
  const { net } = await import('electron')
  return net.fetch(url, init as Parameters<typeof net.fetch>[1])
}

/** Replace the fetch used for art (smoke tests); null restores Electron's `net.fetch`. */
export function setArtFetch(f: FetchLike | null): void {
  fetchImpl =
    f ??
    (async (url, init) => {
      const { net } = await import('electron')
      return net.fetch(url, init as Parameters<typeof net.fetch>[1])
    })
}

const BLOCK_PAUSE_MS = 60_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fetchOnce(url: string, host: string, timeoutMs: number): Promise<{ bytes: Buffer; contentType: string | null }> {
  const http = sharedHttp()
  if (http.blockedUntil(host)) throw new NetError('blocked', blockedMessage(host), { url })
  const timeout = AbortSignal.timeout(timeoutMs)
  let res: Response
  try {
    res = await fetchImpl(url, {
      headers: { 'User-Agent': GHOST_USER_AGENT, Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5' },
      signal: timeout,
      redirect: 'follow',
      // Our disk cache is the cache: keep Chromium's HTTP cache out of it.
      cache: 'no-store'
    })
  } catch (e) {
    if (timeout.aborted) throw new NetError('timeout', `timed out fetching ${url}`, { url })
    throw new NetError('network', `network error fetching ${url}: ${(e as Error).message}`, { url, cause: e })
  }
  const type = res.headers.get('content-type')
  if (type?.includes('text/html')) {
    const body = await res.text()
    if (detectBlock(res.status, res.headers, body)) {
      http.limiter(host).pause(BLOCK_PAUSE_MS)
      throw new NetError('blocked', blockedMessage(host), { status: res.status, url })
    }
  }
  if (res.status === 404 || res.status === 410) throw new NetError('not_found', `not found: ${url}`, { status: res.status, url })
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'))
    http.limiter(host).pause(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 10_000)
    throw new NetError('http', `rate limited by ${host}`, { status: 429, url, retryable: true })
  }
  if (!res.ok) throw new NetError('http', `HTTP ${res.status} from ${url}`, { status: res.status, url })
  return { bytes: Buffer.from(await res.arrayBuffer()), contentType: type }
}

/** GET through the shared per-host limiter, with retries and backoff. */
async function fetchBytes(url: string, retries: number): Promise<{ bytes: Buffer; contentType: string | null }> {
  const host = new URL(url).host
  for (let attempt = 0; ; attempt++) {
    try {
      return await sharedHttp()
        .limiter(host)
        .schedule(() => fetchOnce(url, host, 25_000), 1)
    } catch (e) {
      if (!(e instanceof NetError) || !e.retryable || attempt >= retries) throw e
      await sleep(400 * Math.pow(3, attempt) * (0.8 + Math.random() * 0.4))
    }
  }
}

/** KHInsider full-size scans occasionally 404 while their /thumbs/ copy exists. */
function fallbackUrl(url: string): string | null {
  const m = /^(https?:\/\/[^/]*vgmtreasurechest\.com\/soundtracks\/[^/]+\/)(?!thumbs)([^/]+)$/.exec(url)
  return m ? `${m[1]}thumbs/${m[2]}` : null
}

async function fetchArt(url: string): Promise<{ bytes: Buffer; contentType: string | null }> {
  try {
    return await fetchBytes(url, 2)
  } catch (e) {
    const fb = isNetError(e, 'not_found') ? fallbackUrl(url) : null
    if (!fb) throw e
    return fetchBytes(fb, 1)
  }
}

// ---------------------------------------------------------------------------
// Pipeline

const inflight = new Map<string, Promise<CachedArt>>()

/** Cached image bytes for a URL, capped (fetched and processed off-thread on a miss). `w` snaps to a bucket. */
export async function getArt(url: string, w?: number): Promise<ArtBytes> {
  const a = await load(url, variantFor(w))
  return { bytes: a.bytes, type: a.type }
}

function load(url: string, bucket: number | undefined): Promise<CachedArt> {
  const key = bucket ? `${url}#w=${bucket}` : url
  const existing = inflight.get(key)
  if (existing) return existing
  const p = (bucket ? loadVariant(url, bucket) : loadBase(url)).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** Older entries are fine when their size is known and within the caps (they lack an accent). */
function baseIsCurrent(m: ArtMeta): boolean {
  if (m.v === META_VERSION) return true
  return m.width != null && m.height != null && m.width <= BASE_MAX_WIDTH && m.height <= BASE_MAX_WIDTH * MAX_ASPECT
}

async function loadBase(url: string): Promise<CachedArt> {
  const cached = await readCached(url)
  // (Without the native pipeline there is nothing better to make of an older entry.)
  if (cached && (baseIsCurrent(cached.meta) || !artPipelineAvailable())) return cached
  // An older entry of unknown / oversized dimensions (e.g. an untouched GIF): re-process once.
  if (cached) return storeBase(url, cached.bytes, cached.type, false)
  const res = await fetchArt(url)
  const type = sniffType(res.bytes, res.contentType)
  if (!type) throw new NetError('parse', `not an image: ${url}`, { url })
  return storeBase(url, res.bytes, type, true)
}

async function storeBase(url: string, original: Buffer, type: string, fetched: boolean): Promise<CachedArt> {
  const meta: ArtMeta = { v: META_VERSION, type, url, w: null, width: null, height: null, at: Date.now() }
  let bytes = original
  try {
    const r = await processArt(original, {
      maxWidth: BASE_MAX_WIDTH,
      maxHeight: BASE_MAX_WIDTH * MAX_ASPECT,
      quality: JPEG_QUALITY,
      passthroughMaxBytes: PASSTHROUGH_MAX_BYTES,
      accent: true
    })
    if (r.width > 0) {
      bytes = r.data
      meta.type = r.mime
      meta.width = r.width
      meta.height = r.height
      meta.accent = accentHex(r.accent)
    } else {
      // No native pipeline (addon missing): stored as is, unversioned, so a later run with the
      // addon caps it.
      delete meta.v
    }
  } catch {
    // Undecodable here (AVIF, SVG, corrupt): keep the original; Chromium may still manage.
    meta.accent = null
  }
  await writeCached(url, undefined, bytes, meta).catch(() => {})
  if (meta.accent !== undefined) rememberAccent(url, meta.accent)
  if (fetched) {
    for (const l of fetchedListeners) setImmediate(() => l(url, bytes, meta.type))
    if (meta.accent !== undefined) {
      const hex = meta.accent
      for (const l of accentListeners) setImmediate(() => l(url, hex))
    }
  }
  return { bytes, type: meta.type, meta }
}

async function loadVariant(url: string, bucket: number): Promise<CachedArt> {
  const cached = await readCached(url, bucket)
  if (cached && cached.meta.v === META_VERSION) return cached
  const base = await load(url, undefined)
  // Already narrow enough (or of unknown size): the base is the answer, no extra file.
  if (base.meta.width == null || base.meta.width <= bucket) return base
  try {
    const r = await processArt(base.bytes, { maxWidth: bucket, maxHeight: bucket * MAX_ASPECT, quality: JPEG_QUALITY, accent: false })
    if (r.width <= 0) return base
    const meta: ArtMeta = { v: META_VERSION, type: r.mime, url, w: bucket, width: r.width, height: r.height, at: Date.now() }
    await writeCached(url, bucket, r.data, meta).catch(() => {})
    return { bytes: r.data, type: r.mime, meta }
  } catch {
    return base
  }
}

// ---------------------------------------------------------------------------
// Accents

const accentMemo = new Map<string, string | null>()
const accentInflight = new Map<string, Promise<string | null>>()

function rememberAccent(url: string, hex: string | null): void {
  if (accentMemo.size >= 5000) accentMemo.clear()
  accentMemo.set(url, hex)
}

/**
 * Accent colour ('#rrggbb') for a cover, or null (greyscale art / not cached / undecodable).
 * Free for covers fetched by this protocol (computed while processing them); older cache entries
 * are decoded once, off-thread, and the result is stored in their meta.
 */
export function artAccent(url: string, bytes?: Buffer): Promise<string | null> {
  const known = accentMemo.get(url)
  if (known !== undefined) return Promise.resolve(known)
  const existing = accentInflight.get(url)
  if (existing) return existing
  const p = computeAccent(url, bytes).finally(() => accentInflight.delete(url))
  accentInflight.set(url, p)
  return p
}

async function computeAccent(url: string, bytes?: Buffer): Promise<string | null> {
  const p = cachePaths(url)
  const meta = await readMeta(p.meta, url)
  if (meta && meta.accent !== undefined) {
    rememberAccent(url, meta.accent)
    return meta.accent
  }
  if (!artPipelineAvailable()) return null
  const buf = bytes ?? (meta ? await readFile(p.data).catch(() => null) : null)
  if (!buf) return null
  let hex: string | null = null
  try {
    hex = accentHex(await artAccentOf(buf))
  } catch {
    hex = null
  }
  rememberAccent(url, hex)
  if (meta) await writeAtomic(p.meta, JSON.stringify({ ...meta, accent: hex } satisfies ArtMeta)).catch(() => {})
  return hex
}

// ---------------------------------------------------------------------------
// Housekeeping

/** Delete least-recently-written art until the cache is under `maxBytes`. */
export async function trimArtCache(maxBytes = 2 * 1024 ** 3): Promise<{ files: number; bytes: number; removed: number }> {
  const root = artDir()
  const files: { path: string; size: number; mtime: number }[] = []
  let total = 0
  let subdirs: string[] = []
  try {
    subdirs = await readdir(root)
  } catch {
    return { files: 0, bytes: 0, removed: 0 }
  }
  for (const d of subdirs) {
    let names: string[] = []
    try {
      names = await readdir(join(root, d))
    } catch {
      continue
    }
    const data = names.filter((n) => !n.endsWith('.json') && !n.endsWith('.tmp'))
    const stats = await Promise.all(data.map((n) => stat(join(root, d, n)).catch(() => null)))
    data.forEach((n, i) => {
      const s = stats[i]
      if (!s) return // raced
      files.push({ path: join(root, d, n), size: s.size, mtime: s.mtimeMs })
      total += s.size
    })
  }
  let removed = 0
  if (total > maxBytes) {
    files.sort((a, b) => a.mtime - b.mtime)
    for (const f of files) {
      if (total <= maxBytes * 0.9) break
      await rm(f.path, { force: true })
      await rm(`${f.path}.json`, { force: true })
      total -= f.size
      removed++
    }
  }
  return { files: files.length, bytes: total, removed }
}
