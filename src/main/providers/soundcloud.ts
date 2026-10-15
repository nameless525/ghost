// SoundCloud via yt-dlp: a last-resort search source (DESIGN §6.2).
//
//  - searchExternal: yt-dlp only searches tracks (`scsearch`). It has no set search (and reads a
//    soundcloud.com/search/sets URL as a user page), so album-like hits come from the track results:
//      · long uploads (≥ 15 min): a full OST in one track, split by the timestamped track list in its
//        description when there is one (./chapters);
//      · one uploader's tracks of the same game (≥ 3 in the results): an "uploads" album, read from
//        that uploader's track list on import.
//    Pasted set / track URLs import directly.
//  - getAlbum: a set (full extraction, about 1 s a track, capped at 200), an uploads group (the
//    uploader's flat track list plus a search for durations), or one track (chapters if any).
//  - findTrack ('fallback'): `scsearch10:<game> <title> OST`, scored per §6.4 (./match).
//  - resolveStream: SoundCloud serves almost everything as HLS only (AAC 160k in fMP4 segments,
//    verified 2026-10-14), which the engine can't stream. With `cacheDir` the track is downloaded
//    by yt-dlp once (one run, ~5–12 s for a song) and played from the file; the fragmented MP4 gets
//    its real length written into its header first (fixFragmentedMp4), otherwise the engine sees
//    only the first 10 s segment's length and refuses clips past it. The cache is pruned
//    least-recently-used first past `maxCacheBytes`. Without `cacheDir` only progressive HTTP
//    formats play, with the expiry of their signed URL.
//
// Locators: '<trackId>' or '<trackId>#<startMs>-<endMs>' (a chapter of a long upload). Album refs:
// '<trackId>' (a long upload), '<user>/sets/<slug>' (a set), '<user>/<slug>' (a pasted track URL)
// or 'uploads:<user>:<url-encoded title>' (one uploader's tracks of a game).

import { mkdir, open, readdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { basename, join, resolve as resolvePath } from 'node:path'
import type { AlbumKind, AudioFormat, ExternalAlbumHit } from '../../shared/types'
import { baseTitle } from '../catalog/normalize'
import { NetError } from '../net/errors'
import type { YtDlp } from '../tools/ytdlp'
import { parseDescriptionChapters } from './chapters'
import { channelTrust, cleanTrackTitle, combineScore, durationFit, looksNumbered, penaltyHits, titleSimilarity, tokens } from './match'
import type { CanonicalTrack, Provider, ProviderAlbum, ProviderCallOptions, ProviderTrack, SourceCandidate, StreamInfo } from './types'
import { bestThumb, FULL_OST_MIN_SEC, scoreAlbumTitle, trackQuery } from './youtube'

export const SOUNDCLOUD_ID = 'soundcloud'
/** Progressive HTTP first (streams directly), then the AAC HLS rendition (downloaded when a cache dir is set). */
export const SC_FORMAT = 'bestaudio[protocol^=http][acodec=mp3]/bestaudio[protocol^=http]/bestaudio[ext=m4a]/bestaudio'
/** Uploads of one game by one uploader needed in the results to offer them as an album. */
export const UPLOADS_MIN_TRACKS = 3
/** A set import reads every track (≈1 s each): cap it. */
export const SET_MAX_TRACKS = 200
const SEARCH_TTL_MS = 3600_000
const TRACK_TTL_MS = 30 * 60_000
const DEFAULT_URL_LIFETIME_MS = 30 * 60_000
const DEFAULT_CACHE_BYTES = 1024 * 1024 * 1024

// ---------------------------------------------------------------------------
// yt-dlp JSON shapes (only the fields we read)

export interface ScThumb {
  url: string
  id?: string
  width?: number | null
  height?: number | null
}

export interface ScEntry {
  _type?: string
  ie_key?: string | null
  id: string
  url?: string
  title?: string | null
  duration?: number | null
  uploader?: string | null
  uploader_id?: string | null
  uploader_url?: string | null
  webpage_url?: string | null
  description?: string | null
  timestamp?: number | null
  thumbnails?: ScThumb[] | null
  genres?: string[] | null
}

/** `yt-dlp -J -f …` for one track: the entry plus the selected format. */
export interface ScTrack extends ScEntry {
  thumbnail?: string | null
  ext?: string | null
  acodec?: string | null
  abr?: number | null
  protocol?: string | null
  format_id?: string | null
  filesize?: number | null
  filesize_approx?: number | null
  http_headers?: Record<string, string> | null
}

export interface ScPlaylist {
  _type?: string
  id: string
  title?: string | null
  uploader?: string | null
  uploader_id?: string | null
  uploader_url?: string | null
  description?: string | null
  thumbnails?: ScThumb[] | null
  webpage_url?: string | null
  playlist_count?: number | null
  entries?: (ScTrack | null)[] | null
}

// ---------------------------------------------------------------------------
// URLs, refs, locators

export function trackApiUrl(id: string): string {
  return `https://api.soundcloud.com/tracks/${id}`
}

export function pageUrl(path: string): string {
  return `https://soundcloud.com/${path}`
}

const NOT_TRACK_SLUGS = new Set(['tracks', 'sets', 'albums', 'reposts', 'likes', 'popular-tracks', 'followers', 'following', 'comments', 'spotlight', 'toptracks'])
const NOT_USER_SLUGS = new Set(['discover', 'search', 'you', 'stream', 'upload', 'charts', 'pages', 'settings', 'messages', 'notifications', 'mobile', 'terms-of-use'])

/** A pasted soundcloud.com URL → set path / track path / track id. */
export function parseSoundCloudUrl(s: string): { set?: string; track?: string } | null {
  let u: URL
  try {
    u = new URL(s.trim())
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
  if (/^api(?:-v2)?\.soundcloud\.com$/.test(host)) {
    const m = /^(?:soundcloud:tracks:)?(\d+)$/.exec(parts[1] ?? '')
    return parts[0] === 'tracks' && m ? { track: m[1] } : null
  }
  if (!/^(?:www\.|m\.)?soundcloud\.com$/.test(host)) return null
  const ok = (p: string) => /^[A-Za-z0-9_-]+$/.test(p)
  if (parts.length < 2 || !ok(parts[0]) || NOT_USER_SLUGS.has(parts[0])) return null
  if (parts[1] === 'sets' && parts[2] && ok(parts[2])) return { set: `${parts[0]}/sets/${parts[2]}` }
  if (parts.length === 2 && ok(parts[1]) && !NOT_TRACK_SLUGS.has(parts[1])) return { track: `${parts[0]}/${parts[1]}` }
  return null
}

export interface ScLocator {
  id: string
  clipStartMs?: number
  clipEndMs?: number
}

export function makeLocator(id: string, clip?: { startMs: number; endMs: number }): string {
  return clip ? `${id}#${Math.round(clip.startMs)}-${Math.round(clip.endMs)}` : id
}

export function parseLocator(loc: string): ScLocator {
  const m = /^(\d{1,20})(?:#(\d+)-(\d+))?$/.exec(loc.trim())
  if (!m) throw new NetError('parse', `bad SoundCloud locator: ${loc}`)
  return m[2] != null ? { id: m[1], clipStartMs: Number(m[2]), clipEndMs: Number(m[3]) } : { id: m[1] }
}

export function uploadsRef(user: string, title: string): string {
  return `uploads:${user}:${encodeURIComponent(title)}`
}

export function parseUploadsRef(ref: string): { user: string; title: string } | null {
  const m = /^uploads:([A-Za-z0-9_-]+):(.+)$/.exec(ref)
  if (!m) return null
  try {
    return { user: m[1], title: decodeURIComponent(m[2]) }
  } catch {
    return null
  }
}

/** The permalink of an uploader ("https://soundcloud.com/dante-mangone" → "dante-mangone"). */
export function userOf(e: Pick<ScEntry, 'uploader_url' | 'webpage_url'>): string | null {
  for (const u of [e.uploader_url, e.webpage_url]) {
    const m = /^https?:\/\/(?:www\.|m\.)?soundcloud\.com\/([A-Za-z0-9_-]+)/.exec(u ?? '')
    if (m && !NOT_USER_SLUGS.has(m[1])) return m[1]
  }
  return null
}

/** Expiry of a signed stream URL: `expires=<epoch s>` or a CloudFront policy's `AWS:EpochTime`. */
export function expiryFromUrl(url: string): number | null {
  const m = /[?&]expires=(\d{9,})/i.exec(url)
  if (m) return Number(m[1]) * 1000
  const p = /[?&]Policy=([A-Za-z0-9_~-]+)/.exec(url)
  if (p) {
    try {
      const json = Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64').toString('utf8')
      const t = /"AWS:EpochTime"\s*:\s*(\d{9,})/.exec(json)
      if (t) return Number(t[1]) * 1000
    } catch {
      /* not a policy */
    }
  }
  return null
}

export function formatOf(t: Pick<ScTrack, 'ext' | 'acodec'>): AudioFormat {
  const ac = (t.acodec ?? '').toLowerCase()
  const ext = (t.ext ?? '').toLowerCase()
  if (ac.startsWith('mp4a') || ac === 'aac' || ext === 'm4a' || ext === 'mp4') return 'm4a'
  if (ac === 'opus' || ext === 'opus') return 'opus'
  if (ac === 'mp3' || ext === 'mp3') return 'mp3'
  if (ac === 'vorbis' || ext === 'ogg') return 'ogg'
  return 'unknown'
}

function isProgressive(protocol: string | null | undefined): boolean {
  const p = (protocol ?? '').toLowerCase()
  return p === 'http' || p === 'https'
}

// ---------------------------------------------------------------------------
// Streams

/** A track whose selected format is progressive HTTP → StreamInfo; HLS-only tracks are `not_found` (the engine can't play HLS). */
export function progressiveStream(t: ScTrack, clip: { clipStartMs?: number; clipEndMs?: number } = {}, now = Date.now()): StreamInfo {
  if (!t?.id) throw new NetError('parse', 'yt-dlp JSON without an id')
  if (!t.url) throw new NetError('parse', `SoundCloud ${t.id}: yt-dlp returned no stream URL`)
  if (!isProgressive(t.protocol)) throw new NetError('not_found', `SoundCloud ${t.id} only streams as ${t.protocol ?? 'HLS'}, which the engine can't play (no download cache configured)`)
  const format = formatOf(t)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(t.http_headers ?? {})) if (typeof v === 'string') headers[k] = v
  const clipped = clip.clipStartMs != null && clip.clipEndMs != null
  return {
    provider: SOUNDCLOUD_ID,
    source: {
      kind: 'http',
      url: t.url,
      cacheKey: `sc:${t.id}.${(t.ext ?? format).toLowerCase()}`,
      formatHint: format,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(clipped ? { clipStartMs: clip.clipStartMs, clipEndMs: clip.clipEndMs } : {})
    },
    format,
    lossless: false,
    bitrateKbps: t.abr != null ? Math.round(t.abr) : null,
    sizeBytes: clipped ? null : (t.filesize ?? t.filesize_approx ?? null),
    expiresAt: expiryFromUrl(t.url) ?? now + DEFAULT_URL_LIFETIME_MS
  }
}

export interface CachedFile {
  path: string
  format: AudioFormat
  bitrateKbps: number | null
  sizeBytes: number | null
}

export function fileStream(f: CachedFile, clip: { clipStartMs?: number; clipEndMs?: number } = {}): StreamInfo {
  const clipped = clip.clipStartMs != null && clip.clipEndMs != null
  return {
    provider: SOUNDCLOUD_ID,
    source: { kind: 'file', path: f.path, formatHint: f.format, ...(clipped ? { clipStartMs: clip.clipStartMs, clipEndMs: clip.clipEndMs } : {}) },
    format: f.format,
    lossless: false,
    bitrateKbps: f.bitrateKbps,
    sizeBytes: clipped ? null : f.sizeBytes,
    expiresAt: null
  }
}

/** The two `--print` lines of a download run: "<id>\t<format_id>\t<protocol>\t<ext>\t<acodec>\t<abr>\t<duration>" and the final file path. */
export function parseDownloadOutput(stdout: string): { path: string; ext: string; acodec: string | null; abr: number | null } | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const info = lines.find((l) => l.split('\t').length >= 7)
  const path = [...lines].reverse().find((l) => !l.includes('\t') && /[\\/]/.test(l))
  if (!path) return null
  const f = info?.split('\t') ?? []
  const num = (s: string | undefined) => (s && s !== 'NA' && Number.isFinite(Number(s)) ? Number(s) : null)
  const ext = (f[3] && f[3] !== 'NA' ? f[3] : /\.([a-z0-9]{2,4})$/i.exec(path)?.[1] ?? '').toLowerCase()
  return { path, ext, acodec: f[4] && f[4] !== 'NA' ? f[4] : null, abr: num(f[5]) }
}

// ---------------------------------------------------------------------------
// Fragmented MP4 fix-up

interface Box {
  type: string
  start: number
  /** Offset of the box body (after size / type / largesize). */
  body: number
  end: number
}

function boxesIn(buf: Buffer, from: number, to: number, base = 0): Box[] {
  const out: Box[] = []
  let off = from
  while (off + 8 <= to) {
    let size = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    let head = 8
    if (size === 1) {
      if (off + 16 > to) break
      size = Number(buf.readBigUInt64BE(off + 8))
      head = 16
    } else if (size === 0) size = to - off
    if (size < head || off + size > to) break
    out.push({ type, start: base + off, body: base + off + head, end: base + off + size })
    off += size
  }
  return out
}

/**
 * yt-dlp's HLS download is a fragmented MP4 (init + styp/sidx/moof/mdat per 10 s segment) whose
 * only length hint is each segment's sidx. A demuxer that reads the first sidx (symphonia) thinks
 * the file is 10 s long, and the engine refuses clips past that. Fix it in place: every top-level
 * sidx becomes a `free` box (same size, nothing moves) and the summed fragment durations go into
 * mvhd / tkhd / mdhd. Returns the duration found (ms), or null when the file isn't a single-track
 * fragmented MP4 (then it is left alone).
 */
export async function fixFragmentedMp4(path: string): Promise<number | null> {
  const fh = await open(path, 'r+')
  try {
    const size = (await fh.stat()).size
    const top: Box[] = []
    const head = Buffer.alloc(16)
    for (let off = 0; off + 8 <= size; ) {
      await fh.read(head, 0, 16, off)
      let len = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      let hl = 8
      if (len === 1) {
        len = Number(head.readBigUInt64BE(8))
        hl = 16
      } else if (len === 0) len = size - off
      if (len < hl || off + len > size) break
      top.push({ type, start: off, body: off + hl, end: off + len })
      off += len
    }
    const read = async (b: Box) => {
      const buf = Buffer.alloc(b.end - b.start)
      await fh.read(buf, 0, buf.length, b.start)
      return buf
    }
    const moovBox = top.find((b) => b.type === 'moov')
    const moofs = top.filter((b) => b.type === 'moof')
    if (!moovBox || !moofs.length || moovBox.end - moovBox.start > 1 << 20) return null
    const moov = await read(moovBox)
    const inner = (buf: Buffer, b: Box, base: number) => boxesIn(buf, b.body - base, b.end - base, base)
    const kids = inner(moov, moovBox, moovBox.start)
    const traks = kids.filter((b) => b.type === 'trak')
    const mvhd = kids.find((b) => b.type === 'mvhd')
    const trex = kids.filter((b) => b.type === 'mvex').flatMap((b) => inner(moov, b, moovBox.start)).find((b) => b.type === 'trex')
    if (traks.length !== 1 || !mvhd) return null
    const trakKids = inner(moov, traks[0], moovBox.start)
    const tkhd = trakKids.find((b) => b.type === 'tkhd')
    const mdhd = trakKids
      .filter((b) => b.type === 'mdia')
      .flatMap((b) => inner(moov, b, moovBox.start))
      .find((b) => b.type === 'mdhd')
    if (!tkhd || !mdhd) return null
    const at = (b: Box) => b.body - moovBox.start
    // mvhd / mdhd: version, flags, created, modified, timescale, duration (32- or 64-bit fields).
    const timeFields = (b: Box) => {
      const v = moov[at(b)]
      return v === 1 ? { ts: at(b) + 20, dur: at(b) + 24, wide: true } : { ts: at(b) + 12, dur: at(b) + 16, wide: false }
    }
    const mv = timeFields(mvhd)
    const md = timeFields(mdhd)
    const mvScale = moov.readUInt32BE(mv.ts)
    const mdScale = moov.readUInt32BE(md.ts)
    if (!mvScale || !mdScale) return null
    const tkV = moov[at(tkhd)]
    const tkDur = tkV === 1 ? { off: at(tkhd) + 28, wide: true } : { off: at(tkhd) + 20, wide: false }
    const trexDefault = trex ? moov.readUInt32BE(at(trex) + 12) : 0
    let total = 0
    for (const m of moofs) {
      if (m.end - m.start > 1 << 22) return null
      const buf = await read(m)
      for (const traf of boxesIn(buf, m.body - m.start, m.end - m.start).filter((b) => b.type === 'traf')) {
        const parts = boxesIn(buf, traf.body, traf.end)
        const tfhd = parts.find((b) => b.type === 'tfhd')
        let def = trexDefault
        if (tfhd) {
          const flags = buf.readUInt32BE(tfhd.body) & 0xffffff
          let o = tfhd.body + 8
          if (flags & 0x01) o += 8
          if (flags & 0x02) o += 4
          if (flags & 0x08) def = buf.readUInt32BE(o)
        }
        for (const trun of parts.filter((b) => b.type === 'trun')) {
          const flags = buf.readUInt32BE(trun.body) & 0xffffff
          const count = buf.readUInt32BE(trun.body + 4)
          let o = trun.body + 8 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0)
          const per = [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length * 4
          if (!(flags & 0x100)) total += def * count
          else
            for (let i = 0; i < count && o + 4 <= trun.end; i++, o += per) total += buf.readUInt32BE(o)
        }
      }
    }
    if (!total) return null
    const movieTotal = Math.round((total * mvScale) / mdScale)
    const put = async (off: number, value: number, wide: boolean) => {
      const b = Buffer.alloc(wide ? 8 : 4)
      if (wide) b.writeBigUInt64BE(BigInt(value))
      else if (value > 0xffffffff) return
      else b.writeUInt32BE(value)
      await fh.write(b, 0, b.length, moovBox.start + off)
    }
    await put(md.dur, total, md.wide)
    await put(mv.dur, movieTotal, mv.wide)
    await put(tkDur.off, movieTotal, tkDur.wide)
    for (const b of top.filter((x) => x.type === 'sidx')) await fh.write(Buffer.from('free', 'latin1'), 0, 4, b.start + 4)
    return Math.round((total * 1000) / mdScale)
  } finally {
    await fh.close()
  }
}

// ---------------------------------------------------------------------------
// Matching a canonical track

export interface ScoredTrack extends SourceCandidate {
  uploader: string | null
  parts: { title: number; duration: number; trust: number; penalties: string[]; game: boolean }
}

/** Words that decorate a game / album name without naming it. */
const NAME_NOISE = new Set(['ost', 'osv', 'original', 'soundtrack', 'soundtracks', 'sound', 'track', 'tracks', 'music', 'game', 'official', 'full', 'complete', 'the', 'a', 'of', 'and', 'vgm', 'bgm', 'score', 'hq', 'hd', 'high', 'quality', 'album'])

/** The words that name the game ("Yu-Gi-Oh! Forbidden Memories OST" → yu gi oh forbidden memories). */
export function coreTokens(name: string | null | undefined): string[] {
  const t = tokens(name)
  const core = t.filter((w) => !NAME_NOISE.has(w))
  return core.length ? core : t
}

function hasAll(haystack: string[], needles: string[]): boolean {
  return needles.every((w) => haystack.some((h) => h === w || (w.length >= 5 && h.startsWith(w.slice(0, -1)))))
}

export function scoreTracks(entries: ScEntry[], t: CanonicalTrack): ScoredTrack[] {
  const game = coreTokens(t.gameName || baseTitle(t.albumTitle) || t.albumTitle)
  const out: ScoredTrack[] = []
  for (const e of entries) {
    if (!e?.id || !/^\d+$/.test(e.id) || !e.title) continue
    if (e.duration != null && e.duration >= FULL_OST_MIN_SEC) continue
    const uploader = e.uploader ?? null
    const title = titleSimilarity(t.title, e.title, { context: [t.gameName, t.albumTitle, baseTitle(t.albumTitle)], channel: uploader })
    const duration = durationFit(t.durationMs, e.duration != null ? e.duration * 1000 : null)
    const trust = channelTrust(uploader, false, { composers: t.composers })
    const penalties = penaltyHits(e.title, [t.title, t.albumTitle, t.gameName])
    // SoundCloud search also matches tags and descriptions: a title that doesn't name the game is less likely the track.
    const named = !game.length || hasAll(tokens(`${e.title} ${(e.genres ?? []).join(' ')}`), game)
    const confidence = Math.max(0, Math.round((combineScore({ title, duration, trust, quality: 0.4, penalties }) - (named ? 0 : 0.15)) * 1000) / 1000)
    out.push({
      provider: SOUNDCLOUD_ID,
      locator: e.id,
      title: e.title,
      durationMs: e.duration != null ? Math.round(e.duration * 1000) : null,
      confidence,
      uploader,
      parts: { title, duration, trust, penalties, game: named }
    })
  }
  return out.sort((a, b) => b.confidence - a.confidence)
}

// ---------------------------------------------------------------------------
// Album-like hits

/** A long upload (a full OST in one track) → hit. */
export function longUploadHit(e: ScEntry, query: string): ExternalAlbumHit | null {
  if (!e?.id || !/^\d+$/.test(e.id) || !e.title || e.duration == null || e.duration < FULL_OST_MIN_SEC) return null
  const chapters = parseDescriptionChapters(e.description, e.duration).length
  return {
    provider: 'soundcloud',
    ref: e.id,
    title: e.title,
    subtitle: e.uploader ?? null,
    cover: bestThumb(e.thumbnails),
    trackCount: chapters || null,
    totalMs: Math.round(e.duration * 1000),
    url: e.webpage_url ?? trackApiUrl(e.id),
    score: scoreAlbumTitle(e.title, query, { channel: e.uploader, kind: 'video' })
  }
}

const TITLE_NOISE_GROUP = /\s*[[(](?:high\s+quality|hq|hd|official|audio|full|1080p|720p)[\])]\s*/gi

function words(s: string): string[] {
  return s.normalize('NFKC').split(/\s+/).filter(Boolean)
}

/** The name a set of upload titles shares ("Hollow Knight OST - Dirtmouth", "Hollow Knight OST - Greenpath" → "Hollow Knight OST"), or null. */
export function commonTitle(titles: string[]): string | null {
  if (titles.length < 2) return null
  const lists = titles.map((t) => words(t.replace(TITLE_NOISE_GROUP, ' ')))
  const key = (w: string) => tokens(w).join(' ')
  const tidy = (ws: string[]) =>
    ws
      .join(' ')
      .replace(/^[\s\-–—:|~•·]+|[\s\-–—:|~•·]+$/gu, '')
      .replace(/\s+\d{1,3}$/, '')
      .trim()
  const minLen = Math.min(...lists.map((l) => l.length))
  let k = 0
  while (k < minLen && lists.every((l) => key(l[k]) === key(lists[0][k]))) k++
  const prefix = tidy(lists[0].slice(0, k))
  if (/\p{L}{2}/u.test(prefix) && coreTokens(prefix).some((w) => !NAME_NOISE.has(w))) return prefix
  let j = 0
  while (j < minLen && lists.every((l) => key(l[l.length - 1 - j]) === key(lists[0][lists[0].length - 1 - j]))) j++
  const suffix = tidy(lists[0].slice(lists[0].length - j))
  if (/\p{L}{2}/u.test(suffix) && coreTokens(suffix).some((w) => !NAME_NOISE.has(w))) return suffix
  return null
}

/** One uploader's tracks of the queried game (≥ UPLOADS_MIN_TRACKS in the results) → "uploads" album hits. */
export function uploadsHits(entries: ScEntry[], query: string): ExternalAlbumHit[] {
  const want = coreTokens(query)
  const groups = new Map<string, ScEntry[]>()
  for (const e of entries) {
    if (!e?.id || !e.title || (e.duration != null && e.duration >= FULL_OST_MIN_SEC)) continue
    const user = userOf(e)
    if (!user || !hasAll(tokens(e.title), want)) continue
    groups.set(user, [...(groups.get(user) ?? []), e])
  }
  const out: ExternalAlbumHit[] = []
  for (const [user, list] of groups) {
    if (list.length < UPLOADS_MIN_TRACKS) continue
    const title = commonTitle(list.map((e) => e.title!)) ?? query
    const uploader = list[0].uploader ?? user
    const penalised = list.filter((e) => penaltyHits(e.title!, [query]).length > 0).length
    let score = scoreAlbumTitle(title, query, { channel: uploader, kind: 'playlist' }) + Math.min(0.1, 0.02 * (list.length - UPLOADS_MIN_TRACKS))
    if (penalised * 2 >= list.length) score -= 0.3
    out.push({
      provider: 'soundcloud',
      ref: uploadsRef(user, title),
      title,
      subtitle: uploader,
      cover: bestThumb(list[0].thumbnails),
      trackCount: list.length,
      totalMs: list.reduce((s, e) => s + Math.round((e.duration ?? 0) * 1000), 0) || null,
      url: `${pageUrl(user)}/tracks`,
      score: Math.max(0, Math.min(1, Math.round(score * 1000) / 1000))
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Albums

/**
 * cleanTrackTitle, keeping a trailing "Theme" / "Music" / "BGM" that belongs to the name
 * ("Chrono Trigger OST 19 - Frog's Theme" → "Frog's Theme", not "Frog's").
 */
export function scTrackTitle(raw: string, ctx: Parameters<typeof cleanTrackTitle>[1] = {}): string {
  const cleaned = cleanTrackTitle(raw, ctx)
  const t = raw.replace(/\s+/g, ' ').trim()
  const tail = /\s(theme|music|bgm|song)$/i.exec(t)
  if (tail && cleaned && !cleaned.toLowerCase().endsWith(tail[1].toLowerCase()) && t.toLowerCase().endsWith(`${cleaned} ${tail[1]}`.toLowerCase())) return `${cleaned} ${t.slice(-tail[1].length)}`
  return cleaned
}

function albumKindOf(title: string): AlbumKind {
  const t = title.toLowerCase()
  if (/\bremix(?:es|ed)?\b/.test(t)) return 'remix'
  if (/\bpiano\b|\borchestra|\barrange|\bcovers?\b|\bacoustic\b|\bjazz\b|\bmetal\b|\bmedley\b/.test(t)) return 'arrange'
  if (/\bgame\s*rip\b/.test(t)) return 'gamerip'
  return 'ost'
}

function albumShell(ref: string, title: string, uploader: string | null | undefined, cover: string | null, description: string | null | undefined, typeLabel: string, timestamp?: number | null): Omit<ProviderAlbum, 'tracks'> {
  return {
    provider: SOUNDCLOUD_ID,
    ref,
    title,
    titleFromRef: false,
    platforms: [],
    kind: albumKindOf(title),
    typeLabel,
    year: timestamp ? new Date(timestamp * 1000).getUTCFullYear() : null,
    thumb: cover,
    cover,
    catalogNo: null,
    addedAt: null,
    altTitles: [],
    titleOriginal: null,
    developers: [],
    publishers: [],
    composers: [],
    images: cover ? [cover] : [],
    description: description?.trim() || null,
    formats: ['m4a'],
    totalSizes: {},
    externalId: null
  }
}

function isTrackId(ref: string): boolean {
  return /^\d{1,20}$/.test(ref)
}

/** One track → album: one clipped track per chapter of its description's track list, or a single track. */
export function trackToAlbum(t: ScTrack, ref: string = t.id, now = Date.now()): ProviderAlbum {
  const title = t.title?.trim() || t.id
  const stream = (() => {
    try {
      return progressiveStream(t, {}, now)
    } catch {
      return null
    }
  })()
  const format = stream?.format ?? formatOf(t)
  const names = [title, baseTitle(title)]
  const chapters = parseDescriptionChapters(t.description, t.duration)
  const numbered = looksNumbered(chapters.map((c) => c.title))
  const tracks: ProviderTrack[] =
    chapters.length >= 2
      ? chapters.map((c, i) => {
          const clip = { clipStartMs: c.startMs, clipEndMs: c.endMs }
          return {
            disc: 1,
            number: i + 1,
            title: scTrackTitle(c.title, { names, channel: t.uploader, numbered }),
            durationMs: c.endMs - c.startMs,
            locator: makeLocator(t.id, { startMs: c.startMs, endMs: c.endMs }),
            files: [{ format, sizeBytes: null }],
            composers: [],
            streams: stream ? [{ ...stream, sizeBytes: null, source: { ...stream.source, ...clip } }] : undefined
          }
        })
      : [
          {
            disc: 1,
            number: 1,
            title: scTrackTitle(title, { names: [baseTitle(title)], channel: t.uploader }),
            durationMs: t.duration != null ? Math.round(t.duration * 1000) : null,
            locator: t.id,
            files: [{ format, sizeBytes: stream?.sizeBytes ?? null }],
            composers: [],
            streams: stream ? [stream] : undefined
          }
        ]
  const cover = bestThumb(t.thumbnails) ?? t.thumbnail ?? null
  return { ...albumShell(ref, title, t.uploader, cover, t.description, 'SoundCloud track', t.timestamp), formats: [format], tracks }
}

/** A fully extracted set → album (deleted / unavailable entries dropped). */
export function setToAlbum(pl: ScPlaylist, ref: string, now = Date.now()): ProviderAlbum {
  const title = pl.title?.trim() || ref
  const entries = (pl.entries ?? []).filter((e): e is ScTrack => !!e?.id && isTrackId(e.id) && !!e.title)
  const names = [title, baseTitle(title)]
  const numbered = looksNumbered(entries.map((e) => e.title!))
  const tracks: ProviderTrack[] = entries.map((e, i) => {
    const stream = (() => {
      try {
        return progressiveStream(e, {}, now)
      } catch {
        return null
      }
    })()
    return {
      disc: 1,
      number: i + 1,
      title: scTrackTitle(e.title!, { names, channel: e.uploader ?? pl.uploader, numbered }),
      durationMs: e.duration != null ? Math.round(e.duration * 1000) : null,
      locator: e.id,
      files: [{ format: stream?.format ?? formatOf(e), sizeBytes: stream?.sizeBytes ?? null }],
      composers: [],
      streams: stream ? [stream] : undefined
    }
  })
  const cover = bestThumb(pl.thumbnails) ?? (entries[0] ? bestThumb(entries[0].thumbnails) : null)
  return { ...albumShell(ref, title, pl.uploader, cover, pl.description, 'SoundCloud set', entries[0]?.timestamp), tracks }
}

/** The track number that follows the album name in an upload title ("Chrono Trigger OST 04 - Peaceful Days" → 4). */
export function numberAfter(title: string, name: string): number | null {
  const t = tokens(title)
  const n = tokens(name)
  if (!n.length) return null
  for (let i = 0; i + n.length < t.length; i++) {
    if (n.every((w, k) => t[i + k] === w)) {
      const next = t[i + n.length]
      return /^\d{1,3}$/.test(next) ? Number(next) : null
    }
  }
  return null
}

/**
 * One uploader's tracks of a game → album. `listing` is the uploader's flat track list (newest
 * first, titles only); `found` are search results that carry durations and artwork.
 */
export function uploadsToAlbum(ref: string, user: string, name: string, listing: ScEntry[], found: ScEntry[]): ProviderAlbum {
  const want = coreTokens(name)
  const known = new Map(found.filter((e) => userOf(e) === user || !e.uploader_url).map((e) => [e.id, e]))
  // The uploader's own covers / remixes of the game aren't part of its soundtrack.
  const mine = listing.filter((e) => e?.id && isTrackId(e.id) && e.title && hasAll(tokens(e.title), want) && !penaltyHits(e.title, [name]).length).reverse()
  const nums = mine.map((e) => numberAfter(e.title!, name))
  const given = nums.filter((n): n is number => n != null)
  // Numbered uploads ("… OST 04 - Peaceful Days") keep their numbers and order; otherwise upload order.
  const useNums = given.length >= mine.length * 0.6 && new Set(given).size === given.length
  const order = mine.map((e, i) => ({ e, i, n: useNums ? nums[i] : null }))
  if (useNums) order.sort((a, b) => (a.n ?? 1e6) - (b.n ?? 1e6) || a.i - b.i)
  let next = useNums ? Math.max(0, ...given) : 0
  const names = [name, baseTitle(name)]
  const uploader = mine.map((e) => known.get(e.id)?.uploader).find(Boolean) ?? found.find((e) => userOf(e) === user)?.uploader ?? user
  const numbered = useNums || looksNumbered(mine.map((e) => e.title!))
  const tracks: ProviderTrack[] = order.map(({ e, n }, i) => {
    const k = known.get(e.id)
    const d = k?.duration ?? e.duration
    return {
      disc: 1,
      number: useNums ? (n ?? ++next) : i + 1,
      title: scTrackTitle(e.title!, { names, channel: uploader, numbered }),
      durationMs: d != null ? Math.round(d * 1000) : null,
      locator: e.id,
      files: [{ format: 'm4a', sizeBytes: null }],
      composers: []
    }
  })
  const art = order.map(({ e }) => known.get(e.id)?.thumbnails).find((t) => t?.length)
  return { ...albumShell(ref, name, uploader, bestThumb(art), null, 'SoundCloud uploads'), tracks }
}

// ---------------------------------------------------------------------------
// Provider

export interface SoundCloudProviderOptions {
  now?: () => number
  log?: (msg: string) => void
  /**
   * Where HLS-only tracks are downloaded to play from a file (e.g. <userData>/cache/soundcloud).
   * Without it only progressive HTTP streams play, and SoundCloud has almost none left.
   */
  cacheDir?: string
  /** Size cap of cacheDir (default 1 GiB); least recently used files go first. */
  maxCacheBytes?: number
  /** Per-call yt-dlp timeouts (ms). */
  searchTimeoutMs?: number
  resolveTimeoutMs?: number
  downloadTimeoutMs?: number
  setTimeoutMs?: number
}

interface Memo<T> {
  until: number
  value: Promise<T>
}

export class SoundCloudProvider implements Provider {
  readonly id = SOUNDCLOUD_ID
  readonly name = 'SoundCloud'
  /** Searching costs a yt-dlp run (and playing a candidate a download): only when everything else failed. */
  readonly findTrackMode = 'fallback' as const

  private readonly now: () => number
  private readonly log: (msg: string) => void
  private searches = new Map<string, Memo<ScEntry[]>>()
  private tracks = new Map<string, Memo<ScTrack>>()
  /** Downloads in flight, and the callers following their progress. */
  private downloads = new Map<string, { run: Promise<CachedFile>; followers: Set<(bytes: number, totalBytes: number | null) => void> }>()

  constructor(
    private readonly ytdlp: () => Promise<YtDlp>,
    private readonly opts: SoundCloudProviderOptions = {}
  ) {
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
  }

  private async flat(target: string, extra: string[], opts: ProviderCallOptions = {}): Promise<ScPlaylist> {
    const y = await this.ytdlp()
    return y.json<ScPlaylist>(['--flat-playlist', '-J', ...extra, target], { timeoutMs: this.opts.searchTimeoutMs ?? 60_000, priority: opts.priority ?? 1, signal: opts.signal })
  }

  private search(target: string, extra: string[], opts: ProviderCallOptions = {}): Promise<ScEntry[]> {
    const key = `${target}\u0000${extra.join(' ')}`
    const hit = this.searches.get(key)
    if (hit && !opts.force && this.now() < hit.until) return hit.value
    const value = this.flat(target, extra, opts).then((r) => (r.entries ?? []).filter((e): e is ScEntry => !!e?.id))
    value.catch(() => this.searches.delete(key))
    this.searches.set(key, { until: this.now() + SEARCH_TTL_MS, value })
    if (this.searches.size > 200) this.searches.delete(this.searches.keys().next().value!)
    return value
  }

  /** Full -J for one track (id or "<user>/<slug>"), memoised until shortly before its stream URL expires. */
  track(ref: string, opts: ProviderCallOptions = {}): Promise<ScTrack> {
    const m = this.tracks.get(ref)
    if (m && !opts.force && this.now() < m.until) return m.value
    const url = isTrackId(ref) ? trackApiUrl(ref) : pageUrl(ref)
    const value = this.ytdlp().then((y) =>
      y.json<ScTrack>(['-J', '--no-playlist', '-f', SC_FORMAT, url], { timeoutMs: this.opts.resolveTimeoutMs ?? 45_000, priority: opts.priority ?? 0, signal: opts.signal })
    )
    const entry: Memo<ScTrack> = { until: this.now() + 60_000, value }
    this.tracks.set(ref, entry)
    value.then(
      (t) => {
        const exp = t.url && isProgressive(t.protocol) ? expiryFromUrl(t.url) : null
        entry.until = Math.min(exp != null ? exp - 5 * 60_000 : Infinity, this.now() + TRACK_TTL_MS)
      },
      () => {
        if (this.tracks.get(ref) === entry) this.tracks.delete(ref)
      }
    )
    if (this.tracks.size > 300) this.tracks.delete(this.tracks.keys().next().value!)
    return value
  }

  async findTrack(t: CanonicalTrack, opts: ProviderCallOptions = {}): Promise<SourceCandidate[]> {
    const entries = await this.search(`scsearch10:${trackQuery(t)}`, [], opts)
    // Few candidates: each one that gets resolved may be a download.
    return scoreTracks(entries, t)
      .filter((c) => c.confidence >= 0.45)
      .slice(0, 2)
      .map(({ provider, locator, title, durationMs, confidence }) => ({ provider, locator, title, durationMs, confidence }))
  }

  async searchExternal(q: string, opts: ProviderCallOptions = {}): Promise<ExternalAlbumHit[]> {
    const query = q.trim()
    if (!query) return []
    const url = parseSoundCloudUrl(query)
    if (url) {
      const a = await this.getAlbum((url.set ?? url.track)!, opts)
      return [
        {
          provider: 'soundcloud',
          ref: a.ref,
          title: a.title,
          subtitle: null,
          cover: a.cover,
          trackCount: a.tracks.length,
          totalMs: a.tracks.reduce((s, t) => s + (t.durationMs ?? 0), 0) || null,
          url: isTrackId(a.ref) ? trackApiUrl(a.ref) : pageUrl(a.ref),
          score: 1
        }
      ]
    }
    const withOst = /\b(?:ost|soundtrack|music|bgm)\b/i.test(query) ? query : `${query} OST`
    const base = query.replace(/\b(?:full\s+)?(?:o\.?s\.?t|original\s+soundtrack|soundtrack)\b/gi, ' ').replace(/\s+/g, ' ').trim() || query
    const [songs, full] = await Promise.allSettled([this.search(`scsearch40:${withOst}`, [], opts), this.search(`scsearch20:${base} full soundtrack`, [], opts)])
    if (songs.status === 'rejected' && full.status === 'rejected') throw songs.reason
    const entries: ScEntry[] = []
    for (const r of [songs, full]) if (r.status === 'fulfilled') for (const e of r.value) if (!entries.some((x) => x.id === e.id)) entries.push(e)
    const hits: ExternalAlbumHit[] = []
    for (const e of entries) {
      const h = longUploadHit(e, query)
      if (h) hits.push(h)
    }
    hits.push(...uploadsHits(entries, query))
    return hits.filter((h) => h.score >= 0.25).sort((a, b) => b.score - a.score)
  }

  async getAlbum(ref: string, opts: ProviderCallOptions = {}): Promise<ProviderAlbum> {
    const uploads = parseUploadsRef(ref)
    if (uploads) {
      const [listing, found] = await Promise.allSettled([
        this.flat(`${pageUrl(uploads.user)}/tracks`, ['--playlist-end', '2000'], opts),
        this.search(`scsearch50:${uploads.title}`, [], opts)
      ])
      if (listing.status === 'rejected') throw listing.reason
      const album = uploadsToAlbum(ref, uploads.user, uploads.title, (listing.value.entries ?? []).filter((e): e is ScTrack => !!e?.id), found.status === 'fulfilled' ? found.value : [])
      if (!album.tracks.length) throw new NetError('not_found', `no SoundCloud uploads of "${uploads.title}" by ${uploads.user}`)
      return album
    }
    if (/^[A-Za-z0-9_-]+\/sets\/[A-Za-z0-9_-]+$/.test(ref)) {
      const y = await this.ytdlp()
      // Every entry is extracted (a flat set has no titles); --ignore-errors skips unavailable tracks.
      const r = await y.run(['-J', '--ignore-errors', '--playlist-end', String(SET_MAX_TRACKS), '-f', SC_FORMAT, pageUrl(ref)], {
        timeoutMs: this.opts.setTimeoutMs ?? 300_000,
        priority: opts.priority ?? 0,
        signal: opts.signal,
        allowFailure: true
      })
      let pl: ScPlaylist
      try {
        pl = JSON.parse(r.stdout) as ScPlaylist
      } catch {
        throw new NetError(r.code ? 'not_found' : 'parse', `SoundCloud set ${ref}: ${r.stderr.split(/\r?\n/).find((l) => l.startsWith('ERROR:')) ?? 'yt-dlp printed no JSON'}`)
      }
      const album = setToAlbum(pl, ref, this.now())
      if (!album.tracks.length) throw new NetError('not_found', `SoundCloud set ${ref} has no playable tracks`)
      return album
    }
    if (isTrackId(ref) || /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(ref)) return trackToAlbum(await this.track(ref, opts), ref, this.now())
    throw new NetError('parse', `bad SoundCloud album ref: ${ref}`)
  }

  async resolveStream(locator: string, opts: ProviderCallOptions = {}): Promise<StreamInfo[]> {
    const loc = parseLocator(locator)
    if (this.opts.cacheDir) return [fileStream(await this.download(loc.id, opts), loc)]
    let t = await this.track(loc.id, opts)
    let info = progressiveStream(t, loc, this.now())
    if (info.expiresAt != null && info.expiresAt < this.now() + 60_000) {
      t = await this.track(loc.id, { ...opts, force: true })
      info = progressiveStream(t, loc, this.now())
    }
    return [info]
  }

  // --- download cache ------------------------------------------------------------------------

  private fileName(id: string): string {
    return `sc-${id}`
  }

  /**
   * The cached file for a track, downloading it once (concurrent callers share the run; each one's
   * `onBytes` follows its progress).
   */
  download(id: string, opts: ProviderCallOptions = {}): Promise<CachedFile> {
    let d = this.downloads.get(id)
    if (!d) {
      const followers = new Set<(bytes: number, totalBytes: number | null) => void>()
      const onBytes = (b: number, t: number | null) => {
        for (const fn of followers) fn(b, t)
      }
      const run = this.cached(id)
        .then((hit) => hit ?? this.fetchFile(id, opts, onBytes))
        .finally(() => this.downloads.delete(id))
      d = { run, followers }
      this.downloads.set(id, d)
    }
    const fn = opts.onBytes
    if (!fn) return d.run
    const { run, followers } = d
    followers.add(fn)
    return run.finally(() => followers.delete(fn))
  }

  private async cached(id: string): Promise<CachedFile | null> {
    const dir = this.opts.cacheDir!
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return null
    }
    const prefix = `${this.fileName(id)}.`
    const name = names.find((n) => n.startsWith(prefix) && !/\.(?:part|ytdl|json|tmp)$/i.test(n) && !/\.part-Frag/i.test(n))
    if (!name) return null
    const path = join(dir, name)
    try {
      const st = await stat(path)
      if (!st.isFile() || st.size === 0) return null
      const now = new Date(this.now())
      await utimes(path, now, now).catch(() => {})
      type Meta = { format?: AudioFormat; abr?: number | null; fixed?: boolean }
      const metaPath = join(dir, `${this.fileName(id)}.json`)
      const meta = await readFile(metaPath, 'utf8')
        .then((s) => JSON.parse(s) as Meta)
        .catch(() => ({}) as Meta)
      const ext = /\.([a-z0-9]{2,4})$/i.exec(name)?.[1] ?? ''
      const format = meta.format ?? formatOf({ ext })
      if (format === 'm4a' && !meta.fixed) {
        await fixFragmentedMp4(path).catch(() => null)
        await writeFile(metaPath, JSON.stringify({ ...meta, format, fixed: true })).catch(() => {})
      }
      return { path, format, bitrateKbps: meta.abr ?? null, sizeBytes: st.size }
    } catch {
      return null
    }
  }

  private async fetchFile(id: string, opts: ProviderCallOptions, onBytes: (bytes: number, totalBytes: number | null) => void): Promise<CachedFile> {
    const dir = resolvePath(this.opts.cacheDir!)
    await mkdir(dir, { recursive: true })
    const y = await this.ytdlp()
    const r = await y.run(
      [
        '-f',
        SC_FORMAT,
        '-N',
        '4',
        '--no-playlist',
        '--no-simulate',
        '--max-filesize',
        '400M',
        '-o',
        join(dir, `${this.fileName('%(id)s')}.%(ext)s`),
        '--print',
        '%(id)s\t%(format_id)s\t%(protocol)s\t%(ext)s\t%(acodec)s\t%(abr)s\t%(duration)s',
        '--print',
        'after_move:filepath',
        trackApiUrl(id)
      ],
      // yt-dlp's progress lines measure the download (HLS: its estimate from the segments so far).
      { timeoutMs: this.opts.downloadTimeoutMs ?? 10 * 60_000, priority: opts.priority ?? 0, signal: opts.signal, onProgress: onBytes }
    )
    const out = parseDownloadOutput(r.stdout)
    // The path comes from yt-dlp's output: accept only our own file in our own directory.
    if (!out || resolvePath(out.path) !== join(dir, basename(out.path)) || !basename(out.path).startsWith(`${this.fileName(id)}.`)) {
      throw new NetError('parse', `SoundCloud ${id}: yt-dlp didn't report the downloaded file`)
    }
    const st = await stat(out.path).catch(() => null)
    if (!st?.isFile() || st.size === 0) throw new NetError('not_found', `SoundCloud ${id}: the download left no file`)
    const format = formatOf({ ext: out.ext, acodec: out.acodec })
    const abr = out.abr != null ? Math.round(out.abr) : null
    if (format === 'm4a') {
      const ms = await fixFragmentedMp4(out.path).catch((e) => {
        this.log(`soundcloud: couldn't fix up ${basename(out.path)}: ${(e as Error).message}`)
        return null
      })
      if (ms != null) this.log(`soundcloud: ${basename(out.path)} is ${(ms / 1000).toFixed(1)} s of fragmented MP4 (length written into its header)`)
    }
    await writeFile(join(dir, `${this.fileName(id)}.json`), JSON.stringify({ format, abr, fixed: true })).catch(() => {})
    this.log(`soundcloud: cached ${id} (${(st.size / 1048576).toFixed(1)} MB ${format})`)
    await this.prune(out.path).catch((e) => this.log(`soundcloud: cache prune failed: ${(e as Error).message}`))
    return { path: out.path, format, bitrateKbps: abr, sizeBytes: st.size }
  }

  /** Delete least recently used files past maxCacheBytes (never `keep`). */
  private async prune(keep: string): Promise<void> {
    const dir = resolvePath(this.opts.cacheDir!)
    const max = this.opts.maxCacheBytes ?? DEFAULT_CACHE_BYTES
    const files: { path: string; size: number; at: number; id: string }[] = []
    for (const name of await readdir(dir)) {
      const m = /^sc-(\d+)\.(?!json$)[a-z0-9]{2,5}$/i.exec(name)
      if (!m) continue
      const path = join(dir, name)
      const st = await stat(path).catch(() => null)
      if (st?.isFile()) files.push({ path, size: st.size, at: st.mtimeMs, id: m[1] })
    }
    let total = files.reduce((s, f) => s + f.size, 0)
    for (const f of files.sort((a, b) => a.at - b.at)) {
      if (total <= max) break
      if (f.path === keep || this.downloads.has(f.id)) continue
      await unlink(f.path).catch(() => {})
      await unlink(join(dir, `sc-${f.id}.json`)).catch(() => {})
      total -= f.size
    }
  }
}
