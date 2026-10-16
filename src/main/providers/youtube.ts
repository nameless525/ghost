// YouTube via yt-dlp: the universal fallback (DESIGN §6.2 #6).
//
//  - findTrack: `ytsearch10:<game> <title> OST` with --flat-playlist (id/title/channel/duration
//    only, no format probing), scored per §6.4 (title, duration fit, channel trust, penalties).
//  - resolveStream: `-J -f bestaudio[ext=m4a]/bestaudio[acodec=opus]/bestaudio` → the direct
//    googlevideo URL + yt-dlp's http_headers; expiry from the URL's `expire=`. m4a/AAC preferred:
//    the engine decodes AAC natively. Calls arriving together are batched into one yt-dlp run
//    (each run pays ~3 s of start-up for the standalone binary) and results are memoised until
//    shortly before they expire.
//  - searchExternal: YouTube's playlist search (sp=EgIQAw%3D%3D) + a video search for full-OST
//    uploads, scored for "full OST"/"original soundtrack" and official channels.
//  - getAlbum (import): a playlist becomes tracks from its entries (titles cleaned of game /
//    channel prefixes and numbers); a single video with chapters becomes one track per chapter
//    whose source is the whole video clipped with clipStartMs/clipEndMs (they share one cacheKey,
//    so the video is cached once); a video without chapters is one track.
//
// Locators: '<videoId>' or '<videoId>#<startMs>-<endMs>' for a chapter. Album refs: a playlist id
// or an 11-character video id.

import type { AudioFormat, ExternalAlbumHit } from '../../shared/types'
import { baseTitle } from '../catalog/normalize'
import { NetError } from '../net/errors'
import { classifyYtDlpError, type YtDlp } from '../tools/ytdlp'
import {
  channelTrust,
  cleanTrackTitle,
  combineScore,
  durationFit,
  looksNumbered,
  penaltyHits,
  titleSimilarity,
  tokens
} from './match'
import type { CanonicalTrack, Provider, ProviderAlbum, ProviderCallOptions, ProviderTrack, SourceCandidate, StreamInfo } from './types'

export const YT_ID = 'youtube'
export const YT_FORMAT = 'bestaudio[ext=m4a][protocol=https]/bestaudio[acodec=opus][protocol=https]/bestaudio[protocol=https]/bestaudio[ext=m4a]/bestaudio[acodec=opus]/bestaudio'
/** YouTube search results filter: playlists only. */
export const YT_PLAYLIST_FILTER = 'EgIQAw%253D%253D'
/** A video at least this long counts as a full-OST upload. */
export const FULL_OST_MIN_SEC = 15 * 60
const SEARCH_TTL_MS = 3600_000
const STREAM_MARGIN_MS = 10 * 60_000
/**
 * A forced re-resolve (the stored URL failed) still reuses an extraction this recent: the chapters of
 * one full-OST video share its URL, and each of them being refreshed after one invalidation must not
 * cost a yt-dlp run apiece.
 */
export const FORCE_REUSE_MS = 2 * 60_000

// ---------------------------------------------------------------------------
// yt-dlp JSON shapes (only the fields we read)

export interface YtThumb {
  url: string
  width?: number | null
  height?: number | null
}

export interface YtEntry {
  _type?: string
  ie_key?: string
  id: string
  url?: string
  title?: string | null
  duration?: number | null
  channel?: string | null
  channel_id?: string | null
  uploader?: string | null
  channel_is_verified?: boolean | null
  thumbnails?: YtThumb[] | null
  live_status?: string | null
  availability?: string | null
  description?: string | null
}

export interface YtPlaylist {
  _type?: string
  id: string
  title?: string | null
  channel?: string | null
  uploader?: string | null
  description?: string | null
  thumbnails?: YtThumb[] | null
  playlist_count?: number | null
  webpage_url?: string | null
  entries?: YtEntry[] | null
}

export interface YtChapter {
  start_time: number
  end_time: number
  title?: string | null
}

export interface YtVideo extends YtEntry {
  chapters?: YtChapter[] | null
  thumbnail?: string | null
  ext?: string | null
  acodec?: string | null
  vcodec?: string | null
  abr?: number | null
  tbr?: number | null
  filesize?: number | null
  filesize_approx?: number | null
  http_headers?: Record<string, string> | null
  format_id?: string | null
  protocol?: string | null
  release_year?: number | null
  upload_date?: string | null
  is_live?: boolean | null
  requested_formats?: unknown[] | null
}

// ---------------------------------------------------------------------------
// Locators, URLs

export function isVideoId(ref: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(ref)
}

export function videoUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`
}

export function playlistUrl(id: string): string {
  return `https://www.youtube.com/playlist?list=${id}`
}

export function playlistSearchUrl(q: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q).replace(/%20/g, '+')}&sp=${YT_PLAYLIST_FILTER}`
}

export interface YtLocator {
  id: string
  clipStartMs?: number
  clipEndMs?: number
}

export function makeLocator(id: string, clip?: { startMs: number; endMs: number }): string {
  return clip ? `${id}#${Math.round(clip.startMs)}-${Math.round(clip.endMs)}` : id
}

export function parseLocator(loc: string): YtLocator {
  const m = /^([A-Za-z0-9_-]{11})(?:#(\d+)-(\d+))?$/.exec(loc.trim())
  if (!m) throw new NetError('parse', `bad YouTube locator: ${loc}`)
  return m[2] != null ? { id: m[1], clipStartMs: Number(m[2]), clipEndMs: Number(m[3]) } : { id: m[1] }
}

/** Pull a playlist id or video id out of a pasted YouTube URL. */
export function parseYouTubeUrl(s: string): { playlist?: string; video?: string } | null {
  let u: URL
  try {
    u = new URL(s.trim())
  } catch {
    return null
  }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/i.test(u.hostname)) return null
  const list = u.searchParams.get('list')
  if (list && /^[A-Za-z0-9_-]{10,}$/.test(list) && !/^(RD|UL|WL|LL)/.test(list)) return { playlist: list }
  const v = u.hostname.endsWith('youtu.be') ? u.pathname.slice(1) : (u.searchParams.get('v') ?? /\/(?:shorts|embed|live)\/([^/?#]+)/.exec(u.pathname)?.[1])
  return v && isVideoId(v) ? { video: v } : null
}

/** Expiry (epoch ms) from a googlevideo URL's `expire=` query param or `/expire/<n>/` path. */
export function expiryFromUrl(url: string): number | null {
  const m = /[?&]expire=(\d{9,})/.exec(url) ?? /\/expire\/(\d{9,})\//.exec(url)
  return m ? Number(m[1]) * 1000 : null
}

export function bestThumb(thumbs: YtThumb[] | null | undefined, fallbackVideoId?: string): string | null {
  const list = (thumbs ?? []).filter((t) => t?.url && /^https?:/.test(t.url))
  if (list.length) {
    const best = [...list].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0]
    return best.url
  }
  return fallbackVideoId ? `https://i.ytimg.com/vi/${fallbackVideoId}/hqdefault.jpg` : null
}

function formatOf(v: YtVideo): AudioFormat {
  const ext = (v.ext ?? '').toLowerCase()
  const ac = (v.acodec ?? '').toLowerCase()
  if (ac.startsWith('opus')) return 'opus'
  if (ac.startsWith('mp4a') || ext === 'm4a' || ext === 'mp4') return 'm4a'
  if (ac.startsWith('vorbis')) return 'ogg'
  if (ac === 'mp3' || ext === 'mp3') return 'mp3'
  if (ext === 'webm') return 'opus'
  return 'unknown'
}

/** yt-dlp -J (with a single selected format) → StreamInfo. */
export function parseStream(v: YtVideo, clip?: { clipStartMs?: number; clipEndMs?: number }): StreamInfo {
  if (!v?.id) throw new NetError('parse', 'yt-dlp JSON without an id')
  if (v.is_live || v.live_status === 'is_live' || v.live_status === 'is_upcoming') throw new NetError('not_found', `${v.id} is a live stream`)
  if (!v.url) {
    if (v.requested_formats?.length) throw new NetError('parse', `${v.id}: yt-dlp picked separate audio/video formats`)
    throw new NetError('parse', `${v.id}: yt-dlp returned no stream URL`)
  }
  const protocol = (v.protocol ?? 'https').toLowerCase()
  if (protocol !== 'https' && protocol !== 'http') throw new NetError('parse', `${v.id}: only a ${protocol} stream is available`)
  const format = formatOf(v)
  const ext = (v.ext ?? (format === 'opus' ? 'webm' : format)).toLowerCase()
  const headers: Record<string, string> = {}
  for (const [k, val] of Object.entries(v.http_headers ?? {})) if (typeof val === 'string') headers[k] = val
  const clipped = clip?.clipStartMs != null && clip?.clipEndMs != null
  const source: StreamInfo['source'] = {
    kind: 'http',
    url: v.url,
    cacheKey: `yt:${v.id}.${ext}`,
    formatHint: format,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(clipped ? { clipStartMs: clip!.clipStartMs, clipEndMs: clip!.clipEndMs } : {})
  }
  const kbps = v.abr ?? v.tbr ?? null
  return {
    provider: YT_ID,
    source,
    format,
    lossless: false,
    bitrateKbps: kbps != null ? Math.round(kbps) : null,
    sizeBytes: clipped ? null : (v.filesize ?? v.filesize_approx ?? null),
    expiresAt: expiryFromUrl(v.url)
  }
}

// ---------------------------------------------------------------------------
// Matching a canonical track

/** `<game> <title> OST` (the album title stands in for the game when there's none). */
export function trackQuery(t: Pick<CanonicalTrack, 'title' | 'gameName' | 'albumTitle'>): string {
  const game = t.gameName || baseTitle(t.albumTitle) || t.albumTitle
  const title = t.title.trim()
  const head = tokens(title).join(' ').includes(tokens(game).join(' ')) ? title : `${game} ${title}`
  return `${head} OST`.replace(/\s+/g, ' ').trim()
}

export interface ScoredEntry extends SourceCandidate {
  channel: string | null
  parts: { title: number; duration: number; trust: number; penalties: string[] }
}

export function scoreEntries(entries: YtEntry[], t: CanonicalTrack): ScoredEntry[] {
  const out: ScoredEntry[] = []
  for (const e of entries) {
    if (!e?.id || !isVideoId(e.id) || !e.title) continue
    if (e.live_status === 'is_live' || e.live_status === 'is_upcoming') continue
    if (/^\[(?:private|deleted) video\]$/i.test(e.title)) continue
    const channel = e.channel ?? e.uploader ?? null
    const title = titleSimilarity(t.title, e.title, { context: [t.gameName, t.albumTitle, baseTitle(t.albumTitle)], channel })
    const duration = durationFit(t.durationMs, e.duration != null ? e.duration * 1000 : null)
    const trust = channelTrust(channel, !!e.channel_is_verified, { composers: t.composers })
    const penalties = penaltyHits(e.title, [t.title, t.albumTitle, t.gameName])
    const confidence = combineScore({ title, duration, trust, quality: 0.5, penalties })
    out.push({
      provider: YT_ID,
      locator: e.id,
      title: e.title,
      durationMs: e.duration != null ? Math.round(e.duration * 1000) : null,
      confidence,
      channel,
      parts: { title, duration, trust, penalties }
    })
  }
  return out.sort((a, b) => b.confidence - a.confidence)
}

// ---------------------------------------------------------------------------
// Album-like search hits

const ALBUM_NOISE = new Set(['ost', 'osv', 'original', 'soundtrack', 'soundtracks', 'sound', 'track', 'tracks', 'music', 'game', 'official', 'full', 'complete', 'playlist', 'album', 'collection', 'all', 'the', 'a', 'of', 'and', 'dlc', 'edition', 'version', 'vgm', 'bgm', 'score', 'hq', 'hd', 'audio', 'video', 'with', 'timestamps', 'tracklist', 'includes', 'plus', 'extra', 'deluxe', 'remastered', 'mp3', 'flac', 'cd', 'disc', 'vol', 'volume'])

/** 0..1 how likely an upload title is the complete, original soundtrack the query names. */
export function scoreAlbumTitle(title: string, query: string, opts: { channel?: string | null; verified?: boolean; kind: 'playlist' | 'video' | 'item' | 'album' }): number {
  const q = tokens(query).filter((x) => !ALBUM_NOISE.has(x))
  const tt = tokens(title)
  const extra = tt.filter((x) => !ALBUM_NOISE.has(x) && !/^\d+$/.test(x))
  let hit = 0
  for (const w of q) if (tt.some((h) => h === w || (w.length >= 5 && h.startsWith(w.slice(0, -1))))) hit++
  const coverage = q.length ? hit / q.length : 0
  // Words the query didn't ask for usually mean another game, a DLC or an arrangement.
  const unmatched = extra.filter((x) => !q.some((w) => x === w || (w.length >= 5 && x.startsWith(w.slice(0, -1))))).length
  let s = 0.55 * coverage - Math.min(0.3, 0.15 * unmatched)
  const t = title.toLowerCase()
  if (/\b(?:full|complete|entire|whole)\s+(?:o\.?s\.?t|soundtrack|original\s+soundtrack|score)\b|\boriginal\s+(?:game\s+)?soundtrack\b|\bofficial\s+soundtrack\b|\boriginal\s+score\b|\bsound\s+version\b|\bosv\b/.test(t)) s += 0.2
  else if (/\bo\.?s\.?t\b|\bsoundtrack\b/.test(t)) s += 0.12
  else if (!/\bmusic\b|\bsongs?\b|\bthemes?\b|\bbgm\b|\bvgm\b|\bscore\b|\balbum\b|サウンドトラック|サントラ/.test(t)) s -= 0.2
  const trust = channelTrust(opts.channel, !!opts.verified)
  if (trust >= 1) s += 0.15
  else if (trust >= 0.85) s += 0.1
  else if (opts.verified) s += 0.05
  if (opts.kind === 'playlist') s += 0.05
  s -= 0.3 * penaltyHits(title, [query]).length
  if (/\bboss(?:es)?\s+(?:themes?|music|battles?)\b|\bbest\s+of\b|\btop\s+\d+\b|\bmy\s+favou?rite/i.test(title) && !/\bboss/i.test(query)) s -= 0.15
  return Math.max(0, Math.min(1, Math.round(s * 1000) / 1000))
}

export function playlistHit(e: YtEntry, query: string): ExternalAlbumHit | null {
  if (!e?.id || !e.title || isVideoId(e.id)) return null
  return {
    provider: 'youtube',
    ref: e.id,
    title: e.title,
    subtitle: e.channel ?? e.uploader ?? null,
    cover: bestThumb(e.thumbnails),
    trackCount: null,
    totalMs: null,
    url: playlistUrl(e.id),
    score: scoreAlbumTitle(e.title, query, { channel: e.channel ?? e.uploader, verified: !!e.channel_is_verified, kind: 'playlist' })
  }
}

export function videoHit(e: YtEntry | YtVideo, query: string): ExternalAlbumHit | null {
  if (!e?.id || !e.title || !isVideoId(e.id)) return null
  if (e.live_status === 'is_live' || e.live_status === 'is_upcoming') return null
  if (e.duration == null || e.duration < FULL_OST_MIN_SEC) return null
  const chapters = (e as YtVideo).chapters?.length ?? null
  return {
    provider: 'youtube',
    ref: e.id,
    title: e.title,
    subtitle: e.channel ?? e.uploader ?? null,
    cover: bestThumb(e.thumbnails, e.id),
    trackCount: chapters,
    totalMs: Math.round(e.duration * 1000),
    url: videoUrl(e.id),
    score: scoreAlbumTitle(e.title, query, { channel: e.channel ?? e.uploader, verified: !!e.channel_is_verified, kind: 'video' })
  }
}

// ---------------------------------------------------------------------------
// Import

function albumKindOf(title: string): ProviderAlbum['kind'] {
  const t = title.toLowerCase()
  if (/\bremix(?:es|ed)?\b/.test(t)) return 'remix'
  if (/\bpiano\b|\borchestra|\barrange|\bcovers?\b|\bacoustic\b|\bjazz\b|\bmetal\b|\bmedley\b/.test(t)) return 'arrange'
  if (/\bgame\s*rip\b/.test(t)) return 'gamerip'
  return 'ost'
}

function topicArtist(channel: string | null | undefined): string | null {
  const m = /^(.+?)\s+-\s+Topic$/i.exec(channel?.trim() ?? '')
  return m ? m[1] : null
}

function albumShell(id: string, title: string, channel: string | null | undefined, cover: string | null, description: string | null, typeLabel: string, year: number | null): Omit<ProviderAlbum, 'tracks'> {
  const artist = topicArtist(channel)
  return {
    provider: YT_ID,
    ref: id,
    title,
    titleFromRef: false,
    platforms: [],
    kind: albumKindOf(title),
    typeLabel,
    year,
    thumb: cover,
    cover,
    catalogNo: null,
    addedAt: null,
    altTitles: [],
    titleOriginal: null,
    developers: [],
    publishers: [],
    composers: artist ? [artist] : [],
    images: cover ? [cover] : [],
    description: description?.trim() || null,
    formats: ['m4a'],
    totalSizes: {},
    externalId: null
  }
}

/** A flat playlist → album; entries become tracks (private/deleted videos dropped). */
export function playlistToAlbum(pl: YtPlaylist): ProviderAlbum {
  const title = pl.title?.trim() || pl.id
  const entries = (pl.entries ?? []).filter((e) => e?.id && isVideoId(e.id) && e.title && !/^\[(?:private|deleted) video\]$/i.test(e.title) && e.live_status !== 'is_upcoming')
  const names = [title, baseTitle(title)]
  const numbered = looksNumbered(entries.map((e) => e.title!))
  const tracks: ProviderTrack[] = entries.map((e, i) => ({
    disc: 1,
    number: i + 1,
    title: cleanTrackTitle(e.title!, { names, channel: e.channel ?? e.uploader, numbered }),
    durationMs: e.duration != null ? Math.round(e.duration * 1000) : null,
    locator: e.id,
    files: [{ format: 'm4a', sizeBytes: null }],
    composers: topicArtist(e.channel) ? [topicArtist(e.channel)!] : []
  }))
  const cover = bestThumb(pl.thumbnails, entries[0]?.id) ?? (entries[0] ? bestThumb(entries[0].thumbnails, entries[0].id) : null)
  return { ...albumShell(pl.id, title, pl.channel ?? pl.uploader, cover, pl.description ?? null, 'YouTube playlist', null), tracks }
}

/** A full video → album: one track per chapter (clipped), or a single track. */
export function videoToAlbum(v: YtVideo): ProviderAlbum {
  const title = v.title?.trim() || v.id
  const names = [title, baseTitle(title)]
  const stream = (() => {
    try {
      return parseStream(v)
    } catch {
      return null
    }
  })()
  const format = stream?.format ?? 'm4a'
  const durMs = v.duration != null ? Math.round(v.duration * 1000) : null
  const chapters = (v.chapters ?? []).filter((c) => Number.isFinite(c.start_time) && Number.isFinite(c.end_time) && c.end_time > c.start_time)
  const numbered = looksNumbered(chapters.map((c) => c.title ?? ''))
  const tracks: ProviderTrack[] =
    chapters.length >= 2
      ? chapters.map((c, i) => {
          const startMs = Math.round(c.start_time * 1000)
          const endMs = Math.round(c.end_time * 1000)
          const raw = (c.title ?? '').trim()
          const untitled = !raw || /^<untitled chapter \d+>$/i.test(raw)
          const clip = { clipStartMs: startMs, clipEndMs: endMs }
          return {
            disc: 1,
            number: i + 1,
            title: untitled ? `Part ${i + 1}` : cleanTrackTitle(raw, { names, channel: v.channel ?? v.uploader, numbered }),
            durationMs: endMs - startMs,
            locator: makeLocator(v.id, { startMs, endMs }),
            files: [{ format, sizeBytes: null }],
            composers: [],
            streams: stream ? [{ ...stream, sizeBytes: null, source: { ...stream.source, ...clip } }] : undefined
          }
        })
      : [
          {
            disc: 1,
            number: 1,
            title: cleanTrackTitle(title, { names: [baseTitle(title)], channel: v.channel ?? v.uploader }),
            durationMs: durMs,
            locator: v.id,
            files: [{ format, sizeBytes: stream?.sizeBytes ?? null }],
            composers: [],
            streams: stream ? [stream] : undefined
          }
        ]
  const cover = bestThumb(v.thumbnails, v.id) ?? v.thumbnail ?? null
  return { ...albumShell(v.id, title, v.channel ?? v.uploader, cover, v.description ?? null, 'YouTube video', null), formats: [format], tracks }
}

// ---------------------------------------------------------------------------
// Provider

/** Parse `yt-dlp -j a b c` output (one JSON object per line), keyed by video id. */
export function parseJsonLines(stdout: string): Map<string, YtVideo> {
  const byId = new Map<string, YtVideo>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue
    try {
      const v = JSON.parse(line) as YtVideo
      if (v?.id) byId.set(v.id, v)
    } catch {
      /* partial line */
    }
  }
  return byId
}

/** The error yt-dlp printed for one id in a batch ("ERROR: [youtube] <id>: …"). */
export function batchErrorFor(stderr: string, id: string): string | null {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith('ERROR:') && l.includes(id))
  return line ?? null
}

export interface YouTubeProviderOptions {
  now?: () => number
  log?: (msg: string) => void
  /** Per-call yt-dlp timeouts (ms). */
  searchTimeoutMs?: number
  resolveTimeoutMs?: number
}

/** One extraction of a video, and the callers still waiting for it. */
interface Job {
  id: string
  /** Callers that can still use it (one without an AbortSignal never leaves). */
  callers: number
  resolve: (v: YtVideo) => void
  reject: (e: unknown) => void
  done: boolean
}

interface VideoMemo {
  validUntil: number
  fetchedAt: number
  value: Promise<YtVideo>
  job: Job
}

const aborted = () => new NetError('aborted', 'request aborted')

export class YouTubeProvider implements Provider {
  readonly id = YT_ID
  readonly name = 'YouTube'
  /** Searching costs a yt-dlp run: only when the album's own sources failed. */
  readonly findTrackMode = 'fallback' as const
  /**
   * A yt-dlp run (~3–5 s), but only reached for imported YouTube albums someone rests on or queues:
   * worth it, since a first play otherwise waits that long, and one run covers every chapter.
   */
  readonly prefetchStreams = true

  private readonly now: () => number
  private readonly log: (msg: string) => void
  private searches = new Map<string, { at: number; value: Promise<YtEntry[]> }>()
  /**
   * Resolved videos, reused until `validUntil` (shortly before the stream URL expires); `fetchedAt`
   * is when the extraction started (in flight) or finished.
   */
  private videos = new Map<string, VideoMemo>()
  private pending: { jobs: Map<string, Job[]>; priorities: Map<string, number>; timer: ReturnType<typeof setTimeout>; priority: 0 | 1 | 2 } | null = null
  /** Batches being extracted, and how to stop each run. */
  private running = new Set<{ jobs: Job[]; ctl: AbortController }>()

  constructor(
    private readonly ytdlp: () => Promise<YtDlp>,
    private readonly opts: YouTubeProviderOptions = {}
  ) {
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
  }

  private async flat(target: string, extra: string[], opts: ProviderCallOptions = {}): Promise<YtPlaylist> {
    const y = await this.ytdlp()
    return y.json<YtPlaylist>(['--flat-playlist', '-J', ...extra, target], { timeoutMs: this.opts.searchTimeoutMs ?? 45_000, priority: opts.priority ?? 1, signal: opts.signal })
  }

  private search(target: string, extra: string[], opts: ProviderCallOptions = {}): Promise<YtEntry[]> {
    const key = `${target}\u0000${extra.join(' ')}`
    const hit = this.searches.get(key)
    if (hit && !opts.force && this.now() - hit.at < SEARCH_TTL_MS) return hit.value
    const value = this.flat(target, extra, opts).then((r) => r.entries ?? [])
    value.catch(() => this.searches.delete(key))
    this.searches.set(key, { at: this.now(), value })
    if (this.searches.size > 200) this.searches.delete(this.searches.keys().next().value!)
    return value
  }

  async findTrack(t: CanonicalTrack, opts: ProviderCallOptions = {}): Promise<SourceCandidate[]> {
    const entries = await this.search(`ytsearch10:${trackQuery(t)}`, [], opts)
    return scoreEntries(entries, t)
      .filter((c) => c.confidence >= 0.3)
      .slice(0, 5)
      .map(({ provider, locator, title, durationMs, confidence }) => ({ provider, locator, title, durationMs, confidence }))
  }

  /**
   * Full -J for one video. Memoised until shortly before its URL expires; calls arriving together
   * share one yt-dlp run. `force` skips the memo unless it is in flight or under FORCE_REUSE_MS old.
   * A caller whose `signal` aborts is let go at once; the video leaves its batch once no caller is
   * left, and a running batch's yt-dlp is stopped once none of its videos has one.
   */
  video(id: string, opts: ProviderCallOptions = {}): Promise<YtVideo> {
    if (opts.signal?.aborted) return Promise.reject(aborted())
    const m = this.videos.get(id)
    const now = this.now()
    if (m && (opts.force ? now - m.fetchedAt < FORCE_REUSE_MS : now < m.validUntil)) return this.follow(m, opts.signal)
    let job!: Job
    const value = new Promise<YtVideo>((resolve, reject) => {
      job = { id, callers: 0, resolve, reject, done: false }
    })
    const entry: VideoMemo = { validUntil: now + 60_000, fetchedAt: now, value, job }
    this.videos.delete(id)
    this.videos.set(id, entry)
    value.then(
      (v) => {
        const exp = v.url ? expiryFromUrl(v.url) : null
        entry.fetchedAt = this.now()
        entry.validUntil = exp != null ? exp - STREAM_MARGIN_MS : this.now() + 30 * 60_000
      },
      () => {
        if (this.videos.get(id) === entry) this.videos.delete(id)
      }
    )
    if (this.videos.size > 300) this.videos.delete(this.videos.keys().next().value!)
    this.enqueue(job, opts.priority ?? 0)
    return this.follow(entry, opts.signal)
  }

  /** One caller's wait on an extraction, which it gives up when `signal` aborts. */
  private follow(entry: VideoMemo, signal?: AbortSignal): Promise<YtVideo> {
    const job = entry.job
    if (job.done) return entry.value
    job.callers++
    if (!signal) return entry.value
    return new Promise<YtVideo>((resolve, reject) => {
      const onAbort = () => {
        reject(aborted())
        if (--job.callers === 0) this.cancel(job)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.value.then(
        (v) => {
          signal.removeEventListener('abort', onAbort)
          resolve(v)
        },
        (e) => {
          signal.removeEventListener('abort', onAbort)
          reject(e)
        }
      )
    })
  }

  /** Nobody waits for this extraction any more: out of its batch, and a run nobody waits on stops. */
  private cancel(job: Job): void {
    if (job.done) return
    job.done = true
    job.reject(aborted())
    const p = this.pending
    const queued = p?.jobs.get(job.id)
    if (p && queued?.includes(job)) {
      if (queued.length > 1) queued.splice(queued.indexOf(job), 1)
      else {
        p.jobs.delete(job.id)
        p.priorities.delete(job.id)
      }
      if (!p.jobs.size) {
        clearTimeout(p.timer)
        this.pending = null
      }
      return
    }
    for (const b of this.running) if (b.jobs.includes(job) && b.jobs.every((j) => j.done)) b.ctl.abort()
  }

  private enqueue(job: Job, priority: 0 | 1 | 2): void {
    if (!this.pending) this.pending = { jobs: new Map(), priorities: new Map(), timer: setTimeout(() => void this.flush(), 25), priority }
    const p = this.pending
    p.priority = Math.min(p.priority, priority) as 0 | 1 | 2
    p.jobs.set(job.id, [...(p.jobs.get(job.id) ?? []), job])
    p.priorities.set(job.id, Math.min(p.priorities.get(job.id) ?? priority, priority))
    if (p.jobs.size >= 8) {
      clearTimeout(p.timer)
      void this.flush()
    }
  }

  private async flush(): Promise<void> {
    const p = this.pending
    if (!p) return
    this.pending = null
    // The most urgent first: yt-dlp extracts them in order, and each is handed over as soon as
    // its line is printed, so a track someone is waiting for never waits for a warm-up batched
    // with it.
    const ids = [...p.jobs.keys()].sort((a, b) => p.priorities.get(a)! - p.priorities.get(b)!)
    const batch = { jobs: [...p.jobs.values()].flat(), ctl: new AbortController() }
    this.running.add(batch)
    const settle = (id: string, ok: YtVideo | null, err?: unknown) => {
      for (const j of p.jobs.get(id) ?? []) {
        if (j.done) continue
        j.done = true
        if (ok) j.resolve(ok)
        else j.reject(err)
      }
    }
    try {
      const y = await this.ytdlp()
      // -j prints one JSON object per video; --ignore-errors keeps going past an unavailable one.
      const r = await y.run(['-j', '--no-playlist', '--ignore-errors', '-f', YT_FORMAT, ...ids.map(videoUrl)], {
        timeoutMs: this.opts.resolveTimeoutMs ?? 30_000 + 10_000 * ids.length,
        priority: p.priority,
        signal: batch.ctl.signal,
        allowFailure: true,
        onLine: (line) => {
          for (const [id, v] of parseJsonLines(line)) if (p.jobs.has(id)) settle(id, v)
        }
      })
      const byId = parseJsonLines(r.stdout)
      for (const id of ids) {
        const v = byId.get(id)
        if (v) settle(id, v)
        else {
          const line = batchErrorFor(r.stderr, id) ?? (ids.length === 1 ? r.stderr : '')
          const err = line ? classifyYtDlpError(line) : new NetError('not_found', `YouTube video ${id} is unavailable`)
          this.log(`resolve ${id}: ${err.message}`)
          settle(id, null, err)
        }
      }
    } catch (e) {
      for (const id of ids) settle(id, null, e)
    } finally {
      this.running.delete(batch)
    }
  }

  async resolveStream(locator: string, opts: ProviderCallOptions = {}): Promise<StreamInfo[]> {
    const loc = parseLocator(locator)
    let info = parseStream(await this.video(loc.id, opts), loc)
    if (info.expiresAt != null && info.expiresAt < this.now() + 60_000) info = parseStream(await this.video(loc.id, { ...opts, force: true }), loc)
    return [info]
  }

  async searchExternal(q: string, opts: ProviderCallOptions = {}): Promise<ExternalAlbumHit[]> {
    const query = q.trim()
    if (!query) return []
    const url = parseYouTubeUrl(query)
    if (url?.playlist) {
      const a = await this.getAlbum(url.playlist, opts)
      return [{ provider: 'youtube', ref: a.ref, title: a.title, subtitle: a.composers[0] ?? null, cover: a.cover, trackCount: a.tracks.length, totalMs: a.tracks.reduce((s, t) => s + (t.durationMs ?? 0), 0) || null, url: playlistUrl(a.ref), score: 1 }]
    }
    if (url?.video) {
      const v = await this.video(url.video, opts)
      const a = videoToAlbum(v)
      return [{ provider: 'youtube', ref: v.id, title: a.title, subtitle: v.channel ?? v.uploader ?? null, cover: a.cover, trackCount: a.tracks.length, totalMs: v.duration != null ? Math.round(v.duration * 1000) : null, url: videoUrl(v.id), score: 1 }]
    }
    const base = query.replace(/\b(?:full\s+)?(?:o\.?s\.?t|original\s+soundtrack|soundtrack)\b/gi, ' ').replace(/\s+/g, ' ').trim() || query
    const [playlists, videos] = await Promise.allSettled([
      this.search(playlistSearchUrl(/\b(?:ost|soundtrack|music)\b/i.test(query) ? query : `${query} OST`), ['--playlist-end', '15'], opts),
      this.search(`ytsearch12:${base} full OST`, [], opts)
    ])
    if (playlists.status === 'rejected' && videos.status === 'rejected') throw playlists.reason
    const hits: ExternalAlbumHit[] = []
    if (playlists.status === 'fulfilled') for (const e of playlists.value) pushHit(hits, playlistHit(e, query))
    if (videos.status === 'fulfilled') for (const e of videos.value) pushHit(hits, videoHit(e, query))
    return hits.filter((h) => h.score >= 0.25).sort((a, b) => b.score - a.score)
  }

  async getAlbum(ref: string, opts: ProviderCallOptions = {}): Promise<ProviderAlbum> {
    if (isVideoId(ref)) return videoToAlbum(await this.video(ref, opts))
    const pl = await this.flat(playlistUrl(ref), [], opts)
    const album = playlistToAlbum(pl)
    if (!album.tracks.length) throw new NetError('not_found', `YouTube playlist ${ref} has no playable videos`)
    return album
  }
}

function pushHit(out: ExternalAlbumHit[], h: ExternalAlbumHit | null): void {
  if (h && !out.some((x) => x.ref === h.ref)) out.push(h)
}
