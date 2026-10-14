// `ghost-art://` protocol: serves remote artwork through Chromium's network stack with an
// on-disk cache and permissive CORS so the renderer can use it as WebGL textures.
//
//   ghost-art://img/?u=<encodeURIComponent(https url)>[&w=<max width px>]
//
// Cache: <userData>/art/<sha1[0..2]>/<sha1> (bytes) + <sha1>.json (content type, source url, size).
// Images larger than 1600 px or 1.5 MB are downscaled once on the way in (KHInsider scans can be
// 3000 px PNGs). `w` requests an extra resized variant (cached separately).
import { protocol } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '../paths'
import { extractAccent } from './accent'
import { isNetError, NetError } from './errors'
import { sharedHttp } from './shared'

export const ART_SCHEME = 'ghost-art'

const MAX_SIDE = 1600
const MAX_UNTOUCHED_BYTES = 1_500_000
const CORS = { 'access-control-allow-origin': '*' }

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
      w = Number.isFinite(wp) && wp > 0 ? Math.max(32, Math.min(2048, Math.round(wp))) : undefined
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
// Cache

type Listener = (url: string, bytes: Buffer, contentType: string) => void
const listeners = new Set<Listener>()

/** Notified (asynchronously) whenever an image is fetched from the network for the first time. */
export function onArtFetched(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

let dirOverride: string | null = null
/** Use a different cache directory (smoke tests). */
export function setArtDir(dir: string | null): void {
  dirOverride = dir
}
const artDir = () => dirOverride ?? paths.art()

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

function cachePaths(url: string, w?: number) {
  const h = sha1(w ? `${url}#w=${w}` : url)
  const d = join(artDir(), h.slice(0, 2))
  return { d, data: join(d, h), meta: join(d, `${h}.json`) }
}

export interface ArtBytes {
  bytes: Buffer
  type: string
}

export async function readCachedArt(url: string, w?: number): Promise<ArtBytes | null> {
  const p = cachePaths(url, w)
  try {
    const [meta, bytes] = await Promise.all([readFile(p.meta, 'utf8'), readFile(p.data)])
    const m = JSON.parse(meta) as { type: string; url: string }
    if (m.url !== url) return null
    return { bytes, type: m.type }
  } catch {
    return null
  }
}

async function writeCachedArt(url: string, w: number | undefined, art: ArtBytes, size: { width: number; height: number } | null): Promise<void> {
  const p = cachePaths(url, w)
  await mkdir(p.d, { recursive: true })
  const tmp = `${p.data}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, art.bytes)
  await rename(tmp, p.data)
  await writeFile(p.meta, JSON.stringify({ type: art.type, url, w: w ?? null, width: size?.width ?? null, height: size?.height ?? null, at: Date.now() }))
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

async function shrink(art: ArtBytes, maxSide: number, force: boolean): Promise<{ art: ArtBytes; size: { width: number; height: number } | null }> {
  if (!/jpeg|png|webp/.test(art.type)) return { art, size: null }
  const { nativeImage } = await import('electron')
  const img = nativeImage.createFromBuffer(art.bytes)
  if (img.isEmpty()) return { art, size: null }
  const size = img.getSize()
  const longest = Math.max(size.width, size.height)
  if (!force && longest <= maxSide && art.bytes.length <= MAX_UNTOUCHED_BYTES) return { art, size }
  const scale = Math.min(1, maxSide / longest)
  const out = scale < 1 ? img.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'better' }) : img
  const png = art.type === 'image/png'
  const bytes = png ? out.toPNG() : out.toJPEG(88)
  // Keep the original if re-encoding didn't help.
  if (scale === 1 && bytes.length >= art.bytes.length) return { art, size }
  return { art: { bytes, type: png ? 'image/png' : 'image/jpeg' }, size: out.getSize() }
}

/** KHInsider full-size scans occasionally 404 while their /thumbs/ copy exists. */
function fallbackUrl(url: string): string | null {
  const m = /^(https?:\/\/[^/]*vgmtreasurechest\.com\/soundtracks\/[^/]+\/)(?!thumbs)([^/]+)$/.exec(url)
  return m ? `${m[1]}thumbs/${m[2]}` : null
}

const inflight = new Map<string, Promise<ArtBytes>>()

/** Cached image bytes for a URL (fetching through Chromium's network stack on a miss). */
export function getArt(url: string, w?: number): Promise<ArtBytes> {
  const key = w ? `${url}#w=${w}` : url
  const existing = inflight.get(key)
  if (existing) return existing
  const p = (async (): Promise<ArtBytes> => {
    const cached = await readCachedArt(url, w)
    if (cached) return cached
    if (w) {
      const base = await getArt(url)
      const { art, size } = await shrink(base, w, true)
      await writeCachedArt(url, w, art, size).catch(() => {})
      return art
    }
    let res
    try {
      res = await sharedHttp().fetchBytes(url, { priority: 1, retries: 2, timeoutMs: 25_000 })
    } catch (e) {
      const fb = isNetError(e, 'not_found') ? fallbackUrl(url) : null
      if (!fb) throw e
      res = await sharedHttp().fetchBytes(fb, { priority: 1, retries: 1, timeoutMs: 25_000 })
    }
    const type = sniffType(res.bytes, res.contentType)
    if (!type) throw new NetError('parse', `not an image: ${url}`, { url })
    const { art, size } = await shrink({ bytes: res.bytes, type }, MAX_SIDE, false)
    await writeCachedArt(url, undefined, art, size).catch(() => {})
    for (const l of listeners) setImmediate(() => l(url, art.bytes, art.type))
    return art
  })().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** Accent colour for a cover (from given bytes or the art cache). */
export async function artAccent(url: string, bytes?: Buffer): Promise<string | null> {
  const buf = bytes ?? (await readCachedArt(url))?.bytes
  if (!buf) return null
  const { nativeImage } = await import('electron')
  const img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return null
  const small = img.resize({ width: 48, height: 48, quality: 'good' })
  return extractAccent(small.toBitmap(), 'bgra')
}

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
    for (const n of names) {
      if (n.endsWith('.json') || n.endsWith('.tmp')) continue
      try {
        const s = await stat(join(root, d, n))
        files.push({ path: join(root, d, n), size: s.size, mtime: s.mtimeMs })
        total += s.size
      } catch {
        /* raced */
      }
    }
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
