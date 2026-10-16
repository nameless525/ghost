// `ghost-art://` protocol: serves remote artwork with an on-disk cache and permissive CORS so the
// renderer can use it as WebGL textures.
//
//   ghost-art://img/?u=<encodeURIComponent(https url)>[&w=<width px>][&bg=1]
//
// `bg=1` marks a request nobody is looking at yet (Browse warming the rows ahead): its download
// only uses capacity the on-screen ones leave (see "Download order").
//
// Nothing here blocks the main thread (on macOS it also delivers window input): decoding,
// resizing, re-encoding and the accent colour run in the native art pipeline (`processArt`,
// native/crates/ghost-art on a small Rust thread pool), all disk I/O is async, and Electron's
// nativeImage is never used.
//
// Sizes: every image the renderer receives is capped. Without `w` it gets the base image, at most
// 1600 px wide (KHInsider scans can be 3000+ px PNGs). `w` snaps up to a bucket (ART_BUCKETS) so
// each cover has at most a handful of variants on disk. Nothing is ever upscaled. Small enough
// originals (≤ 1600 px, ≤ 1.5 MB) are kept byte-for-byte. An image the pipeline rejects (corrupt,
// over its size limits, not an image) is neither served nor cached; only a format the browser reads
// and the pipeline doesn't (AVIF, SVG, BMP) is served as fetched, within limits of its own.
//
// Cache: <userData>/art/<sha1[0..2]>/<sha1> (bytes) + <sha1>.json (ArtMeta). Base: sha1(url);
// variant: sha1(`${url}#w=${bucket}`). The base meta also stores the cover's accent colour, so
// accents of cached covers never need another decode.
//
// Network: Chromium's stack (`net.fetch`, Cloudflare-friendly) with `cache: 'no-store'`: this
// cache is the only one (Chromium's HTTP cache used to hold a second copy of every cover), and
// requests go through the shared host scheduler (net/shared.ts; the catalog's page requests wait in
// it too) so per-host limits, Retry-After pauses and block cooldowns hold app-wide.
import { protocol } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artAccentOf, artPipelineAvailable, processArt } from '../engine/native'
import { paths } from '../paths'
import { perfActive } from '../perf'
import { accentHex } from './accent'
import { isNetError, NetError } from './errors'
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
/**
 * Limits for an image served as fetched because only the browser reads its format (it can't be
 * capped here): its file size, and its width and height where its header says.
 */
const BROWSER_ONLY_MAX_BYTES = 4_000_000
const BROWSER_ONLY_MAX_SIDE = 4096
/** An image found unusable isn't fetched again for this long (a server's bad moment passes). */
const UNUSABLE_RETRY_MS = 15 * 60_000
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

// Debug counters (system perf stats): requests served, how, and how long they took.
const stats = { requests: 0, errors: 0, memHits: 0, diskHits: 0, fetched: 0, processed: 0, bytes: 0, totalMs: 0, maxMs: 0, urls: new Set<string>() }

/** Art protocol counters since the last reset (debugging). */
export function artStats(reset = false) {
  const { urls, ...rest } = stats
  const out = { ...rest, distinct: urls.size, avgMs: stats.requests ? Math.round((stats.totalMs / stats.requests) * 100) / 100 : 0, totalMs: Math.round(stats.totalMs), maxMs: Math.round(stats.maxMs * 10) / 10 }
  if (reset) {
    Object.assign(stats, { requests: 0, errors: 0, memHits: 0, diskHits: 0, fetched: 0, processed: 0, bytes: 0, totalMs: 0, maxMs: 0 })
    urls.clear()
  }
  return out
}

/** Call after app 'ready'. */
export function handleArtProtocol(): void {
  protocol.handle(ART_SCHEME, async (req) => {
    const t0 = performance.now()
    stats.requests++
    // distinct URLs, for perf stats only (up to ~15 MB of strings in a long session otherwise)
    if (perfActive() && stats.urls.size < 50_000) stats.urls.add(req.url)
    let target: string | null = null
    let w: number | undefined
    let bg = false
    try {
      const u = new URL(req.url)
      target = u.searchParams.get('u')
      const wp = Number(u.searchParams.get('w'))
      w = Number.isFinite(wp) && wp > 0 ? wp : undefined
      bg = u.searchParams.get('bg') === '1'
    } catch {
      /* fall through */
    }
    if (!target || !/^https?:\/\//i.test(target)) return new Response('bad art url', { status: 400, headers: { ...CORS, 'cache-control': 'no-store' } })
    try {
      const art = await getArt(target, w, bg)
      const ms = performance.now() - t0
      stats.totalMs += ms
      if (ms > stats.maxMs) stats.maxMs = ms
      stats.bytes += art.bytes.length
      return new Response(new Uint8Array(art.bytes), {
        status: 200,
        headers: { ...CORS, 'content-type': art.type, 'content-length': String(art.bytes.length), 'cache-control': 'public, max-age=31536000, immutable' }
      })
    } catch (e) {
      stats.errors++
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
  /** Kept as fetched: a format only the browser reads (see browserOnly). */
  browserOnly?: true
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
  if (!meta || !bytes) return null
  stats.diskHits++
  return { bytes, type: meta.type, meta }
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

/**
 * The type of an image in a format the browser reads but the native pipeline doesn't (AVIF, SVG,
 * BMP), when it is within BROWSER_ONLY limits; null for anything else.
 */
function browserOnly(b: Buffer): string | null {
  if (b.length > BROWSER_ONLY_MAX_BYTES) return null
  const fits = (w: number, h: number) => w > 0 && h > 0 && w <= BROWSER_ONLY_MAX_SIDE && h <= BROWSER_ONLY_MAX_SIDE
  // AVIF: an ISO-BMFF `ftyp` box with its brand; the size is in the image's `ispe` box.
  if (b.length >= 16 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brands: string[] = []
    for (let i = 8; i + 4 <= Math.min(b.readUInt32BE(0), b.length); i += 4) if (i !== 12) brands.push(b.toString('latin1', i, i + 4))
    if (!brands.includes('avif') && !brands.includes('avis')) return null
    const i = b.indexOf('ispe')
    return i < 0 || (i + 16 <= b.length && fits(b.readUInt32BE(i + 8), b.readUInt32BE(i + 12))) ? 'image/avif' : null
  }
  // BMP: "BM" and a Windows bitmap header (its height is negative for top-down rows).
  if (b.length >= 26 && b.toString('latin1', 0, 2) === 'BM' && [40, 52, 56, 108, 124].includes(b.readUInt32LE(14))) {
    return fits(b.readInt32LE(18), Math.abs(b.readInt32LE(22))) ? 'image/bmp' : null
  }
  // SVG: markup whose root is <svg> (drawn at whatever size it's shown).
  const head = b.toString('utf8', 0, Math.min(b.length, 2048)).replace(/^\uFEFF/, '')
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

// ---------------------------------------------------------------------------
// Network

/** GET through the shared HTTP client: its host scheduler's turns, pauses, block cooldowns and retries. */
function fetchBytes(url: string, retries: number): Promise<{ bytes: Buffer; contentType: string | null }> {
  return sharedHttp().fetchBytes(url, { priority: 1, timeoutMs: 25_000, retries })
}

/**
 * The source's own small copy of a full-size cover: KHInsider's /thumbs/ (117 px, ~10–30 KB) and
 * Zophar's thumbs_large (~180 px), where the full scan can be several MB. Used for the smallest
 * bucket (album rows, queue and library lists), and when a full-size scan 404s.
 */
function thumbnailUrl(url: string): string | null {
  const m = /^(https?:\/\/[^/]*vgmtreasurechest\.com\/soundtracks\/[^/]+\/)(?!thumbs)([^/]+)$/.exec(url)
  if (m) return `${m[1]}thumbs/${m[2]}`
  const z = /^(https?:\/\/fi\.zophar\.net\/soundcovers\/[^/]+\/)(?!thumbs_)([^/]+)$/.exec(url)
  return z ? `${z[1]}thumbs_large/${z[2]}` : null
}

async function fetchArt(url: string): Promise<{ bytes: Buffer; contentType: string | null }> {
  try {
    return await fetchBytes(url, 2)
  } catch (e) {
    const fb = isNetError(e, 'not_found') ? thumbnailUrl(url) : null
    if (!fb) throw e
    return fetchBytes(fb, 1)
  }
}

// ---------------------------------------------------------------------------
// Download order
//
// Scrolling Browse asks for covers far faster than they download, and nothing says when a page
// stops wanting one (Electron's request signal doesn't fire when an <img> moves on). All started
// at once, a fling's worth of full-size scans (up to 4 per host, across half a dozen hosts) split
// the connection, so the covers on screen arrived no sooner than everything scrolled past: a
// median of 7.6 s in a quick scroll, 20 s at worst. Now at most DOWNLOADS run at a time, newest
// first, since what was asked for last is what's on screen; a request for one already waiting
// moves it to the front. Small images (the smallest bucket: thumbnails, row previews) go before
// full-size scans, since they take a fraction of the time; background requests (`bg=1`) only use
// what's left. A download only takes a slot once its host's limiter can start it, so a host paced
// at one request a second never holds slots that covers from other hosts could use.
const DOWNLOADS = 6
const BG_DOWNLOADS = 2

/** 0 = small image, 1 = full-size, on screen, 2 = background. */
type Tier = 0 | 1 | 2

interface Download {
  /** The cover URL (`#thumb` for its thumbnail): what a later request for it can move up. */
  key: string
  host: string
  tier: Tier
  start: () => void
}
const waiting: Download[] = []
let downloading = 0
let downloadingBg = 0
let retry: ReturnType<typeof setTimeout> | null = null

function pumpDownloads(): void {
  if (retry) {
    clearTimeout(retry)
    retry = null
  }
  let soonest = Infinity
  // by tier, newest first within each; background ones only while there's room for them
  for (const tier of [0, 1, 2] as const) {
    for (let i = waiting.length - 1; i >= 0 && downloading < DOWNLOADS; i--) {
      const d = waiting[i]
      if (d.tier !== tier || (tier === 2 && downloadingBg >= BG_DOWNLOADS)) continue
      // (at the priority fetchBytes uses: the catalog's background crawl waiting there isn't ahead)
      const ready = sharedHttp().limiter(d.host).readyIn(1)
      if (ready > 0) {
        soonest = Math.min(soonest, ready)
        continue
      }
      waiting.splice(i, 1)
      downloading++
      if (tier === 2) downloadingBg++
      d.start()
    }
  }
  // A host that's only spaced out: look again when it can start. A busy one (or one paced by
  // requests other than these) is looked at again when a download ends, or after a moment.
  if (waiting.length && downloading < DOWNLOADS) {
    retry = setTimeout(pumpDownloads, Number.isFinite(soonest) ? soonest + 1 : 250)
    retry.unref?.()
  }
}

/** Run a download when its turn comes (see above). */
function inTurn<T>(key: string, url: string, tier: Tier, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const d: Download = {
      key,
      host: new URL(url).host,
      tier,
      start: () => {
        const counted = d.tier === 2
        fn()
          .then(resolve, reject)
          .finally(() => {
            downloading--
            if (counted) downloadingBg--
            pumpDownloads()
          })
      }
    }
    waiting.push(d)
    pumpDownloads()
  })
}

/** Someone wants `url` now: its waiting download(s) move to the front, as on-screen work. */
function moveUp(url: string): void {
  for (let i = waiting.length - 1; i >= 0; i--) {
    const d = waiting[i]
    if (d.key !== url && d.key !== `${url}#thumb`) continue
    waiting.splice(i, 1)
    if (d.tier === 2) d.tier = d.key === url ? 1 : 0
    waiting.push(d)
  }
  pumpDownloads()
}

/** Downloads waiting / running (tests). */
export function artDownloadQueue(): { waiting: number; running: number } {
  return { waiting: waiting.length, running: downloading }
}

// ---------------------------------------------------------------------------
// Pipeline

const inflight = new Map<string, Promise<CachedArt>>()
/** Covers whose image was unusable, until they may be fetched again. */
const unusable = new Map<string, number>()

/**
 * Cached image bytes for a URL, capped (fetched and processed off-thread on a miss). `w` snaps to
 * a bucket; `bg` marks a request nobody is looking at yet (see "Download order").
 */
export async function getArt(url: string, w?: number, bg = false): Promise<ArtBytes> {
  const a = await load(url, variantFor(w), bg)
  return { bytes: a.bytes, type: a.type }
}

function load(url: string, bucket: number | undefined, bg: boolean): Promise<CachedArt> {
  const key = bucket ? `${url}#w=${bucket}` : url
  const existing = inflight.get(key)
  if (existing) {
    if (!bg) moveUp(url)
    return existing
  }
  const p = (bucket ? loadVariant(url, bucket, bg) : loadBase(url, bg)).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/**
 * Written by this pipeline once it read the image (or knew it for one only the browser reads). One
 * of unknown size otherwise is what an earlier version kept of an image it couldn't read.
 */
function checked(m: ArtMeta): boolean {
  return m.v === META_VERSION && (m.width != null || !!m.browserOnly)
}

/** Older entries are fine when their size is known and within the caps (they lack an accent). */
function baseIsCurrent(m: ArtMeta): boolean {
  if (m.v === META_VERSION) return checked(m)
  return m.width != null && m.height != null && m.width <= BASE_MAX_WIDTH && m.height <= BASE_MAX_WIDTH * MAX_ASPECT
}

async function loadBase(url: string, bg: boolean): Promise<CachedArt> {
  const cached = await readCached(url)
  // (Without the native pipeline there is nothing better to make of an older entry.)
  if (cached && (baseIsCurrent(cached.meta) || !artPipelineAvailable())) return cached
  // An older entry of unknown / oversized dimensions (e.g. an untouched GIF): re-process once (one
  // that turns out unusable is dropped, and fetched again).
  if (cached) {
    const again = await storeBase(url, cached.bytes, cached.type, false).catch(() => null)
    if (again) return again
  }
  if ((unusable.get(url) ?? 0) > Date.now()) throw new NetError('parse', `unusable image: ${url}`, { url })
  const res = await inTurn(url, url, bg ? 2 : 1, () => fetchArt(url))
  stats.fetched++
  try {
    const type = sniffType(res.bytes, res.contentType)
    if (!type) throw new NetError('parse', `not an image: ${url}`, { url })
    return await storeBase(url, res.bytes, type, true)
  } catch (e) {
    // Not fetched again every time it scrolls past, but not given up on for good either.
    if (unusable.size >= 5000) unusable.clear()
    unusable.set(url, Date.now() + UNUSABLE_RETRY_MS)
    throw e
  }
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
  } catch (e) {
    // Not read here: kept as is only in a format the browser reads, within its limits. Corrupt,
    // oversized or not an image at all, it is never served (nor kept: no earlier copy either).
    const other = browserOnly(original)
    if (!other) {
      const p = cachePaths(url)
      await Promise.all([rm(p.data, { force: true }), rm(p.meta, { force: true })]).catch(() => {})
      throw new NetError('parse', `unusable image (${(e as Error).message}): ${url}`, { url })
    }
    meta.type = other
    meta.browserOnly = true
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

/** The bucket the source's thumbnail is enough for (see thumbnailUrl). */
const THUMB_MAX_BUCKET = 128

async function loadVariant(url: string, bucket: number, bg: boolean): Promise<CachedArt> {
  const cached = await readCached(url, bucket)
  if (cached && (checked(cached.meta) || !artPipelineAvailable())) return cached
  if (bucket <= THUMB_MAX_BUCKET) {
    const small = await loadThumbnail(url, bucket, bg)
    if (small) return small
  }
  const base = await load(url, undefined, bg)
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

/**
 * The smallest bucket from the source's thumbnail instead of the full scan (null: there is none,
 * it failed, or the full-size base is already cached, which is resized instead).
 */
async function loadThumbnail(url: string, bucket: number, bg: boolean): Promise<CachedArt | null> {
  const thumb = thumbnailUrl(url)
  if (!thumb) return null
  // (still worth it while the full scan is on its way: it's a fraction of the size)
  if (await stat(cachePaths(url).meta).then(() => true, () => false)) return null
  let res: { bytes: Buffer; contentType: string | null }
  try {
    res = await inTurn(`${url}#thumb`, thumb, bg ? 2 : 0, () => fetchBytes(thumb, 1))
  } catch {
    return null
  }
  const type = sniffType(res.bytes, res.contentType)
  if (!type) return null
  stats.fetched++
  const meta: ArtMeta = { v: META_VERSION, type, url, w: bucket, width: null, height: null, at: Date.now() }
  let bytes = res.bytes
  try {
    const r = await processArt(res.bytes, { maxWidth: bucket, maxHeight: bucket * MAX_ASPECT, quality: JPEG_QUALITY, passthroughMaxBytes: PASSTHROUGH_MAX_BYTES, accent: false })
    if (r.width > 0) {
      bytes = r.data
      meta.type = r.mime
      meta.width = r.width
      meta.height = r.height
    } else delete meta.v // (no native pipeline: see storeBase)
  } catch {
    // Unusable: the full-size cover instead. A browser-only format is served as fetched.
    const other = browserOnly(res.bytes)
    if (!other) return null
    meta.type = other
    meta.browserOnly = true
  }
  await writeCached(url, bucket, bytes, meta).catch(() => {})
  return { bytes, type: meta.type, meta }
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

/** The cache grows by a few covers a minute at most: looking at every file once a day is plenty. */
const TRIM_EVERY_MS = 24 * 3600_000

/**
 * Delete least-recently-written art until the cache is under `maxBytes`. Reads every file's size,
 * so it runs at most once a day (`force` to run anyway); null when it was skipped.
 */
export async function trimArtCache(maxBytes = 2 * 1024 ** 3, force = false): Promise<{ files: number; bytes: number; removed: number } | null> {
  const root = artDir()
  const marker = join(root, '.trimmed')
  if (!force) {
    const last = await stat(marker).then((s) => s.mtimeMs, () => 0)
    if (Date.now() - last < TRIM_EVERY_MS) return null
  }
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
  await writeFile(marker, '').catch(() => {})
  return { files: files.length, bytes: total, removed }
}
