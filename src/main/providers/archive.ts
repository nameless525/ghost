// Internet Archive (archive.org): long tail and older / obscure games (DESIGN §6.2 #5).
// Official APIs only: advancedsearch.php (JSON) for items, /metadata/<identifier> for files.
//
//  - searchExternal: audio items whose title/subject names the game, in soundtrack-ish
//    collections or with soundtrack words; items without a playable audio file are dropped.
//  - getAlbum (import): one track per ORIGINAL audio file; its derivatives (the VBR MP3 IA makes
//    from a FLAC, Ogg…) are alternate formats of the same track. Every format is returned as a
//    ready stream (archive.org download URLs are stable).
//  - findTrack: search items for the game, then match files by title + duration (§6.4).
//  - resolveStream: https://archive.org/download/<identifier>/<file>.
//
// Locators: '<identifier>/<original file name>' (the name may contain '/').

import type { AudioFormat, ExternalAlbumHit } from '../../shared/types'
import { baseTitle } from '../catalog/normalize'
import { NetError } from '../net/errors'
import { GHOST_USER_AGENT } from '../net/http'
import { HostLimiter } from '../net/limiter'
import { cleanTrackTitle, combineScore, durationFit, looksNumbered, penaltyHits, titleSimilarity, tokens } from './match'
import type { CanonicalTrack, Provider, ProviderAlbum, ProviderCallOptions, ProviderTrack, SourceCandidate, StreamInfo } from './types'
import { LOSSLESS_FORMATS } from './types'
import { scoreAlbumTitle } from './youtube'

export const IA_ID = 'archive'
export const IA_BASE = 'https://archive.org'
const CACHE_TTL_MS = 6 * 3600_000

/** Collections that hold game soundtracks. */
export const IA_GAME_COLLECTIONS = ['folksoundomy_gamesoundtracks', 'hifidelity_soundtracks', 'gamesoundtracks', 'video_game_music', 'vgmusic', 'gamemusic', 'soundtracks']

// ---------------------------------------------------------------------------
// API shapes

export interface IaDoc {
  identifier: string
  title?: string | string[]
  creator?: string | string[]
  downloads?: number
  item_size?: number
  collection?: string | string[]
  format?: string | string[]
  year?: string | number
  date?: string
}

export interface IaSearchResponse {
  response?: { numFound?: number; docs?: IaDoc[] }
}

export interface IaFile {
  name: string
  source?: 'original' | 'derivative' | 'metadata' | string
  format?: string
  size?: string
  length?: string
  title?: string
  track?: string
  disc?: string
  album?: string
  artist?: string
  creator?: string
  original?: string
  bitrate?: string
}

export interface IaMetadata {
  metadata?: {
    identifier?: string
    title?: string | string[]
    creator?: string | string[]
    date?: string
    year?: string
    description?: string | string[]
    collection?: string | string[]
    subject?: string | string[]
    mediatype?: string
  }
  files?: IaFile[]
  is_dark?: boolean
}

const arr = (v: string | string[] | undefined | null): string[] => (v == null ? [] : Array.isArray(v) ? v : [v])
const first = (v: string | string[] | undefined | null): string | null => arr(v)[0] ?? null

// ---------------------------------------------------------------------------
// Helpers

/** IA file format label (or extension) → AudioFormat, null for non-audio. */
export function iaAudioFormat(format: string | undefined, name = ''): AudioFormat | null {
  const f = (format ?? '').toLowerCase()
  if (/flac/.test(f)) return 'flac'
  if (/mp3/.test(f)) return 'mp3'
  if (/ogg vorbis/.test(f)) return 'ogg'
  if (/^opus$/.test(f)) return 'opus'
  if (/^wave$/.test(f)) return 'wav'
  if (/apple lossless|^aac$|^m4a$|mpeg4 audio/.test(f)) return 'm4a'
  if (f) return null
  const ext = /\.([a-z0-9]{2,4})$/i.exec(name)?.[1]?.toLowerCase()
  const byExt: Record<string, AudioFormat> = { flac: 'flac', mp3: 'mp3', ogg: 'ogg', oga: 'ogg', opus: 'opus', wav: 'wav', m4a: 'm4a', aac: 'aac' }
  return (ext && byExt[ext]) || null
}

function isLossless(format: string | undefined, af: AudioFormat): boolean {
  return LOSSLESS_FORMATS.has(af) || /apple lossless/i.test(format ?? '')
}

/** "89.73" (seconds) / "01:30" / "1:02:03" → ms. */
export function parseIaLength(s: string | undefined): number | null {
  if (!s) return null
  const t = s.trim()
  if (/^\d+(?:\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000)
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(t)
  if (!m) return null
  return Math.round(((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000)
}

export function downloadUrl(identifier: string, name: string): string {
  return `${IA_BASE}/download/${encodeURIComponent(identifier)}/${name.split('/').map(encodeURIComponent).join('/')}`
}

export function itemUrl(identifier: string): string {
  return `${IA_BASE}/details/${encodeURIComponent(identifier)}`
}

export function itemThumb(identifier: string): string {
  return `${IA_BASE}/services/img/${encodeURIComponent(identifier)}`
}

export function parseIaUrl(s: string): string | null {
  const m = /^https?:\/\/(?:www\.)?archive\.org\/(?:details|download|embed)\/([A-Za-z0-9._-]+)/i.exec(s.trim())
  return m ? m[1] : null
}

/** User text → Lucene-safe words. */
export function luceneWords(s: string): string[] {
  return s
    .normalize('NFKC')
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w && !/^(?:and|or|not)$/i.test(w))
}

const OST_WORDS_RE = /\b(?:full\s+|complete\s+|original\s+)?(?:o\.?s\.?t|soundtrack|original\s+sound\s*track|sound\s*track)\b/gi

export function searchQuery(q: string): string {
  const base = q.replace(OST_WORDS_RE, ' ').trim() || q
  const words = luceneWords(base)
  const w = words.length ? words.join(' AND ') : '*'
  const coll = IA_GAME_COLLECTIONS.join(' OR ')
  return `mediatype:(audio) AND (title:(${w}) OR subject:(${w})) AND (title:(soundtrack OR ost OR osv OR music OR score OR gamerip OR bgm) OR subject:(soundtrack OR ost OR "video game music" OR "game music" OR vgm OR "video game") OR collection:(${coll}))`
}

export function searchUrl(q: string, rows = 30): string {
  const p = new URLSearchParams({ q: searchQuery(q), rows: String(rows), page: '1', output: 'json' })
  for (const f of ['identifier', 'title', 'creator', 'downloads', 'item_size', 'collection', 'format', 'year', 'date']) p.append('fl[]', f)
  return `${IA_BASE}/advancedsearch.php?${p.toString()}`
}

const PLAYABLE_ITEM_FORMATS = /flac|mp3|ogg vorbis|wave|apple lossless|^aac$|^m4a$/i

export function scoreDoc(d: IaDoc, query: string): number {
  const title = first(d.title) ?? d.identifier
  let s = scoreAlbumTitle(title, query, { channel: first(d.creator), kind: 'item' })
  const colls = arr(d.collection)
  if (colls.some((c) => IA_GAME_COLLECTIONS.includes(c))) s += 0.05
  if (d.downloads && d.downloads > 0) s += Math.min(0.05, Math.log10(d.downloads) / 80)
  if (/\b(?:every\s+audio\s+asset|sound\s*effects?|sfx|ripped\s+assets?|voice\s+lines?|sounds\s+of)\b/i.test(title) && !/\b(?:sfx|effects?|sounds)\b/i.test(query)) s -= 0.25
  return Math.max(0, Math.min(1, Math.round(s * 1000) / 1000))
}

export function parseSearch(json: IaSearchResponse, query: string): ExternalAlbumHit[] {
  const docs = json.response?.docs ?? []
  const out: ExternalAlbumHit[] = []
  for (const d of docs) {
    if (!d?.identifier) continue
    if (!arr(d.format).some((f) => PLAYABLE_ITEM_FORMATS.test(f))) continue
    const creator = arr(d.creator).join(', ') || null
    out.push({
      provider: 'archive',
      ref: d.identifier,
      title: first(d.title) ?? d.identifier,
      subtitle: creator,
      cover: itemThumb(d.identifier),
      trackCount: null,
      totalMs: null,
      url: itemUrl(d.identifier),
      score: scoreDoc(d, query)
    })
  }
  return out.sort((a, b) => b.score - a.score)
}

function trackNo(s: string | undefined): number | null {
  const m = /^\s*(\d{1,4})/.exec(s ?? '')
  return m ? Number(m[1]) : null
}

function discOf(f: IaFile): number {
  const d = trackNo(f.disc)
  if (d) return d
  const dir = f.name.includes('/') ? f.name.slice(0, f.name.lastIndexOf('/')) : ''
  const m = /(?:^|[\s/_-])(?:disc|disk|cd)\s*[-_]?\s*(\d{1,2})\b/i.exec(dir)
  return m ? Number(m[1]) : 1
}

function stem(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1).replace(/\.[a-z0-9]{2,5}$/i, '')
}

const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function streamOf(identifier: string, f: IaFile, af: AudioFormat, durationMs: number | null): StreamInfo {
  const size = f.size ? Number(f.size) : null
  const br = f.bitrate ? Number(f.bitrate) : null
  return {
    provider: IA_ID,
    source: { kind: 'http', url: downloadUrl(identifier, f.name), cacheKey: `ia:${identifier}/${f.name}`, formatHint: af },
    format: af,
    lossless: isLossless(f.format, af),
    bitrateKbps: br && Number.isFinite(br) ? Math.round(br) : size && durationMs ? Math.round((size * 8) / durationMs) : null,
    sizeBytes: size && Number.isFinite(size) ? size : null,
    expiresAt: null
  }
}

/** /metadata/<id> → album: one track per original audio file, derivatives as extra formats. */
export function parseMetadata(identifier: string, json: IaMetadata): ProviderAlbum {
  if (!json || json.is_dark || !json.files) throw new NetError('not_found', `Internet Archive item ${identifier} is unavailable`)
  const md = json.metadata ?? {}
  const title = first(md.title) ?? identifier
  const files = json.files.filter((f) => f?.name && !/(^|\/)__/.test(f.name))
  const audio = files.filter((f) => iaAudioFormat(f.format, f.name))
  const audioNames = new Set(audio.map((f) => f.name))
  // Originals (and derivatives of non-audio originals, e.g. the MP3 of a video) are the tracks.
  const primaries = audio.filter((f) => f.source !== 'derivative' || !f.original || !audioNames.has(f.original))
  // Same file uploaded in several formats ("01 X.flac" + "01 X.mp3"): one track, best format first.
  const rank = (f: IaFile) => ['flac', 'wav', 'm4a', 'mp3', 'ogg', 'aac', 'opus'].indexOf(iaAudioFormat(f.format, f.name)!)
  // One upload in several formats is one track: same path minus extension ("01 X.flac" + "01 X.mp3"),
  // or the same disc / track number / title tag ("Artist - Album - 01 X.flac" + "01 - X.mp3").
  const groups: IaFile[][] = []
  const byKey = new Map<string, IaFile[]>()
  for (const f of primaries) {
    const no = trackNo(f.track)
    const keys = [`p:${f.name.replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase()}`]
    if (no != null && f.title?.trim()) keys.push(`t:${discOf(f)}|${no}|${tokens(f.title).join(' ')}`)
    const g = keys.map((k) => byKey.get(k)).find(Boolean)
    if (g) g.push(f)
    else groups.push([f])
    for (const k of keys) byKey.set(k, g ?? groups[groups.length - 1])
  }
  const main: IaFile[] = []
  const derivs = new Map<string, IaFile[]>()
  const owner = new Map<string, string>()
  for (const group of groups) {
    group.sort((a, b) => rank(a) - rank(b))
    main.push(group[0])
    derivs.set(group[0].name, group.slice(1))
    for (const f of group) owner.set(f.name, group[0].name)
  }
  for (const f of audio) {
    if (f.source !== 'derivative' || !f.original || !owner.has(f.original)) continue
    const o = owner.get(f.original)!
    derivs.set(o, [...(derivs.get(o) ?? []), f])
  }
  const numbered = looksNumbered(main.map((f) => stem(f.name)))
  const albumTag = main.map((f) => f.album).find(Boolean) ?? null
  const names = [title, baseTitle(title), albumTag, albumTag ? baseTitle(albumTag) : null]
  const rows = main.map((f) => {
    // One stream per format: originals first, then IA's derivatives.
    const seenFmt = new Set<AudioFormat>()
    const fmts = [f, ...(derivs.get(f.name) ?? [])].filter((x) => {
      const af = iaAudioFormat(x.format, x.name)!
      if (seenFmt.has(af)) return false
      seenFmt.add(af)
      return true
    })
    const durationMs = fmts.map((x) => parseIaLength(x.length)).find((x) => x != null) ?? null
    const t = fmts.map((x) => x.title).find((x) => x && x.trim()) ?? null
    return {
      f,
      disc: discOf(f),
      no: trackNo(f.track) ?? fmts.map((x) => trackNo(x.track)).find((x) => x != null) ?? null,
      title: t ? t.trim() : cleanTrackTitle(stem(f.name).replace(/_/g, ' '), { names, numbered }),
      durationMs,
      fmts,
      composer: fmts.map((x) => x.artist ?? x.creator).find(Boolean) ?? null
    }
  })
  rows.sort((a, b) => a.disc - b.disc || (a.no ?? 1e6) - (b.no ?? 1e6) || natural.compare(a.f.name, b.f.name))
  const perDisc = new Map<number, number>()
  const tracks: ProviderTrack[] = rows.map((r) => {
    const n = (perDisc.get(r.disc) ?? 0) + 1
    perDisc.set(r.disc, n)
    const streams = r.fmts.map((x) => streamOf(identifier, x, iaAudioFormat(x.format, x.name)!, r.durationMs))
    return {
      disc: r.disc,
      number: r.no ?? n,
      title: r.title,
      durationMs: r.durationMs,
      locator: `${identifier}/${r.f.name}`,
      files: streams.map((s) => ({ format: s.format, sizeBytes: s.sizeBytes })),
      composers: r.composer ? [r.composer] : [],
      streams
    }
  })
  const images = files.filter((f) => /^(?:jpe?g|png)$/i.test(f.format ?? '') && f.source === 'original')
  const coverFile = images.find((f) => /cover|folder|front|album|art/i.test(f.name)) ?? images[0]
  const cover = coverFile ? downloadUrl(identifier, coverFile.name) : itemThumb(identifier)
  const yearRaw = md.year ?? md.date
  const year = yearRaw && /^(\d{4})/.test(yearRaw) ? Number(yearRaw.slice(0, 4)) : null
  const formats = [...new Set(tracks.flatMap((t) => t.files.map((f) => f.format)))]
  const totalSizes: Partial<Record<AudioFormat, number>> = {}
  for (const t of tracks) for (const f of t.files) if (f.sizeBytes) totalSizes[f.format] = (totalSizes[f.format] ?? 0) + f.sizeBytes
  const creators = arr(md.creator).flatMap((c) => c.split(/\s*[;,]\s*/)).filter(Boolean)
  const t = title.toLowerCase()
  return {
    provider: IA_ID,
    ref: identifier,
    title,
    titleFromRef: false,
    platforms: [],
    kind: /\brip\b|gamerip/.test(t) ? 'gamerip' : /\bremix/.test(t) ? 'remix' : /\barrange|\bpiano\b|\borchestra/.test(t) ? 'arrange' : 'ost',
    typeLabel: 'Internet Archive',
    year: year && year >= 1970 && year <= 2100 ? year : null,
    thumb: itemThumb(identifier),
    cover,
    catalogNo: null,
    addedAt: null,
    altTitles: albumTag && albumTag !== title ? [albumTag] : [],
    titleOriginal: null,
    developers: [],
    publishers: [],
    composers: creators,
    images: [cover],
    description: (first(md.description) ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000) || null,
    formats,
    totalSizes,
    externalId: identifier,
    tracks
  }
}

// ---------------------------------------------------------------------------
// Provider

export interface ArchiveProviderOptions {
  fetch?: typeof fetch
  now?: () => number
  log?: (msg: string) => void
}

export class ArchiveProvider implements Provider {
  readonly id = IA_ID
  readonly name = 'Internet Archive'
  readonly findTrackMode = 'fallback' as const

  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly limiter = new HostLimiter({ concurrency: 2, spacingMs: 250 })
  private cache = new Map<string, { at: number; value: Promise<unknown> }>()

  constructor(opts: ArchiveProviderOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
  }

  private getJson<T>(url: string, opts: ProviderCallOptions = {}): Promise<T> {
    const c = this.cache.get(url)
    if (c && !opts.force && this.now() - c.at < CACHE_TTL_MS) return c.value as Promise<T>
    const value = this.limiter.schedule(async () => {
      const timeout = AbortSignal.timeout(20_000)
      let res: Response
      try {
        res = await this.fetchImpl(url, { headers: { 'User-Agent': GHOST_USER_AGENT, Accept: 'application/json' }, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout })
      } catch (e) {
        if (opts.signal?.aborted) throw new NetError('aborted', 'request aborted', { url })
        if (timeout.aborted) throw new NetError('timeout', `timed out fetching ${url}`, { url })
        throw new NetError('network', `network error fetching ${url}: ${(e as Error).message}`, { url, cause: e })
      }
      if (res.status === 404) throw new NetError('not_found', `not found: ${url}`, { status: 404, url })
      if (res.status === 429) this.limiter.pause(10_000)
      if (!res.ok) throw new NetError('http', `HTTP ${res.status} from ${url}`, { status: res.status, url })
      return (await res.json()) as T
    }, opts.priority ?? 1, opts.signal)
    value.catch(() => this.cache.delete(url))
    this.cache.set(url, { at: this.now(), value })
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!)
    return value
  }

  metadata(identifier: string, opts: ProviderCallOptions = {}): Promise<IaMetadata> {
    return this.getJson<IaMetadata>(`${IA_BASE}/metadata/${encodeURIComponent(identifier)}`, opts)
  }

  async searchExternal(q: string, opts: ProviderCallOptions = {}): Promise<ExternalAlbumHit[]> {
    const query = q.trim()
    if (!query) return []
    const id = parseIaUrl(query)
    if (id) {
      const a = parseMetadata(id, await this.metadata(id, opts))
      return [{ provider: 'archive', ref: id, title: a.title, subtitle: a.composers.join(', ') || null, cover: a.cover, trackCount: a.tracks.length, totalMs: a.tracks.reduce((s, t) => s + (t.durationMs ?? 0), 0) || null, url: itemUrl(id), score: 1 }]
    }
    return parseSearch(await this.getJson<IaSearchResponse>(searchUrl(query), opts), query).filter((h) => h.score >= 0.25)
  }

  async getAlbum(ref: string, opts: ProviderCallOptions = {}): Promise<ProviderAlbum> {
    const album = parseMetadata(ref, await this.metadata(ref, opts))
    if (!album.tracks.length) throw new NetError('not_found', `Internet Archive item ${ref} has no playable audio files`)
    return album
  }

  async findTrack(t: CanonicalTrack, opts: ProviderCallOptions = {}): Promise<SourceCandidate[]> {
    const game = t.gameName || baseTitle(t.albumTitle) || t.albumTitle
    const hits = (await this.getJson<IaSearchResponse>(searchUrl(game, 12), opts).then((j) => parseSearch(j, game))).filter((h) => h.score >= 0.4).slice(0, 3)
    const out: SourceCandidate[] = []
    for (const h of hits) {
      let album: ProviderAlbum
      try {
        album = parseMetadata(h.ref, await this.metadata(h.ref, opts))
      } catch {
        continue
      }
      for (const tr of album.tracks) {
        const title = titleSimilarity(t.title, tr.title, { context: [game, album.title, t.albumTitle] })
        if (title < 0.5) continue
        const duration = durationFit(t.durationMs, tr.durationMs)
        const lossless = tr.files.some((f) => LOSSLESS_FORMATS.has(f.format))
        const confidence = combineScore({ title, duration, trust: 0.5, quality: lossless ? 1 : 0.6, penalties: penaltyHits(`${tr.title} ${album.title}`, [t.title, t.albumTitle, t.gameName]) })
        out.push({ provider: IA_ID, locator: tr.locator, title: tr.title, durationMs: tr.durationMs, confidence })
      }
    }
    return out.sort((a, b) => b.confidence - a.confidence).slice(0, 5)
  }

  async resolveStream(locator: string, opts: ProviderCallOptions = {}): Promise<StreamInfo[]> {
    const i = locator.indexOf('/')
    if (i <= 0) throw new NetError('parse', `bad Internet Archive locator: ${locator}`)
    const id = locator.slice(0, i)
    const name = locator.slice(i + 1)
    try {
      const album = parseMetadata(id, await this.metadata(id, opts))
      const tr = album.tracks.find((x) => x.locator === locator)
      if (tr?.streams?.length) return tr.streams
      if (!album.tracks.length) throw new NetError('not_found', `no audio in ${id}`)
    } catch (e) {
      if ((e as NetError).code === 'not_found') throw e
      // Metadata unavailable: the download URL is stable, so fall back to it alone.
    }
    const af = iaAudioFormat(undefined, name)
    if (!af) throw new NetError('not_found', `${locator} is not an audio file`)
    return [streamOf(id, { name }, af, null)]
  }
}
