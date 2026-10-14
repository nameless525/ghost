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
//  - indexSections / fetchIndexPage (IndexProvider): curated game-soundtrack collections enumerated
//    500 items a page; hits carry ref = identifier, so getAlbum / importExternal open them as-is.
//    See "Catalog index" below.
//
// Locators: '<identifier>/<original file name>' (the name may contain '/').

import type { AlbumKind, AudioFormat, ExternalAlbumHit } from '../../shared/types'
import { baseTitle } from '../catalog/normalize'
import { NetError } from '../net/errors'
import { GHOST_USER_AGENT } from '../net/http'
import { HostLimiter } from '../net/limiter'
import { cleanTrackTitle, combineScore, durationFit, KNOWN_LABELS, looksNumbered, penaltyHits, titleSimilarity, tokens } from './match'
import type {
  AlbumHit,
  CanonicalTrack,
  IndexPage,
  IndexProvider,
  IndexSection,
  PlatformRef,
  ProviderAlbum,
  ProviderCallOptions,
  ProviderTrack,
  SourceCandidate,
  StreamInfo
} from './types'
import { LOSSLESS_FORMATS } from './types'
import { scoreAlbumTitle } from './youtube'

export const IA_ID = 'archive'
export const IA_BASE = 'https://archive.org'
const CACHE_TTL_MS = 6 * 3600_000

/** Collections that hold game soundtracks. */
export const IA_GAME_COLLECTIONS = ['folksoundomy_gamesoundtracks', 'hifidelity_soundtracks']

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

/** Format labels that mention an audio codec but aren't playable audio (fingerprints, playlists, zips, previews). */
const NOT_AUDIO_LABEL = /fingerprint|m3u|zip|torrent|sample|spectrogram|peaks|essentia|cue/
/** Generic labels IA gives files it couldn't identify: decide by extension. */
const GENERIC_LABEL = /^(?:unknown|audio|sound|mpeg audio)$/

/** IA file format label (or extension) → AudioFormat, null for non-audio. */
export function iaAudioFormat(format: string | undefined, name = ''): AudioFormat | null {
  const f = (format ?? '').toLowerCase().trim()
  if (f && !GENERIC_LABEL.test(f)) {
    if (NOT_AUDIO_LABEL.test(f)) return null
    if (/flac/.test(f)) return 'flac'
    if (/mp3/.test(f)) return 'mp3'
    if (/ogg vorbis/.test(f)) return 'ogg'
    if (/^opus$/.test(f)) return 'opus'
    if (/^wave$/.test(f)) return 'wav'
    if (/^advanced audio coding$|^aac$/.test(f)) return /\.aac$/i.test(name) ? 'aac' : 'm4a'
    if (/apple lossless|^m4a$|mpeg-?4 audio/.test(f)) return 'm4a'
    return null
  }
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

/** An item whose format list includes one of these has a playable audio file (Opus-only and archive-only items don't). */
const PLAYABLE_ITEM_FORMATS = /flac|mp3|ogg vorbis|wave|apple lossless|^aac$|^m4a$|^mpeg-?4 audio$|^advanced audio coding$/i

export function hasPlayableAudio(formats: string | string[] | undefined): boolean {
  return arr(formats).some((f) => PLAYABLE_ITEM_FORMATS.test(f) && !NOT_AUDIO_LABEL.test(f.toLowerCase()))
}

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
    if (!hasPlayableAudio(d.format)) continue
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

/** "1-05 Title" / "2-112 Title": a disc-track prefix in a file name. */
const DISC_TRACK_PREFIX = /^(\d{1,2})-(\d{2,3})(?=[\s._-])/

function discOf(f: IaFile): number {
  const d = trackNo(f.disc)
  if (d) return d
  const dir = f.name.includes('/') ? f.name.slice(0, f.name.lastIndexOf('/')) : ''
  const m = /(?:^|[\s/_-])(?:disc|disk|cd)\s*[-_]?\s*(\d{1,2})\b/i.exec(dir)
  if (m) return Number(m[1])
  const p = DISC_TRACK_PREFIX.exec(stem(f.name))
  return p && Number(p[1]) > 0 ? Number(p[1]) : 1
}

function stem(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1).replace(/\.[a-z0-9]{2,5}$/i, '')
}

function prefixTrackNo(name: string): number | null {
  const p = DISC_TRACK_PREFIX.exec(stem(name))
  return p ? Number(p[2]) : null
}

/** A folder that only names a format / quality ("FLAC", "MP3 320kbps", "24bit-96kHz", "64kbps"). */
export function isFormatDir(seg: string): boolean {
  if (!/[a-z0-9]/i.test(seg)) return false
  const rest = seg
    .toLowerCase()
    .replace(/\b(?:flac|mp3|ogg|vorbis|wav|wave|opus|aac|m4a|alac|lossless|lossy|hi-?res|cd|quality|version|files?|audio|vbr|cbr|v0|v2|\d{2,3}\s*-?\s*bits?|\d{2,3}(?:[.,]\d)?\s*k(?:hz)?|\d{2,3}\s*kbps|\d{3})\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
  return rest === ''
}

/** The same upload in several formats lives at the same path once format folders and the extension are dropped. */
function pathKey(name: string): string {
  const parts = name.replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase().split('/')
  const file = parts.pop()!
  return [...parts.filter((p) => !isFormatDir(p)), file].join('/')
}

/** Rough quality of a file, to pick the best of several copies in one format. */
function fileQuality(f: IaFile): number {
  const br = Number(f.bitrate)
  if (br > 0) return br
  const size = Number(f.size)
  const ms = parseIaLength(f.length)
  if (size > 0 && ms) return (size * 8) / ms
  return size > 0 ? size / 1e6 : 0
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
  const rawTitle = first(md.title)?.trim() || null
  const { title, catalogNo } = rawTitle ? cleanIaTitle(rawTitle) : { title: identifier, catalogNo: null }
  const description = (first(md.description) ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
  const files = json.files.filter((f) => f?.name && !/(^|\/)__/.test(f.name))
  const audio = files.filter((f) => iaAudioFormat(f.format, f.name))
  const audioNames = new Set(audio.map((f) => f.name))
  // Originals (and derivatives of non-audio originals, e.g. the MP3 of a video) are the tracks.
  const primaries = audio.filter((f) => f.source !== 'derivative' || !f.original || !audioNames.has(f.original))
  // Same file uploaded in several formats ("01 X.flac" + "01 X.mp3"): one track, best format first,
  // and of several copies in one format (64/96/128 kbps folders) the best one.
  const rank = (f: IaFile) => ['flac', 'wav', 'm4a', 'mp3', 'ogg', 'aac', 'opus'].indexOf(iaAudioFormat(f.format, f.name)!)
  // One upload in several formats is one track: same path minus extension and format folders
  // ("01 X.flac" + "01 X.mp3", "FLAC/01 X.flac" + "MP3/01 X.mp3"), or the same disc / track number /
  // title tag ("Artist - Album - 01 X.flac" + "01 - X.mp3").
  const groups: IaFile[][] = []
  const byKey = new Map<string, IaFile[]>()
  for (const f of primaries) {
    const no = trackNo(f.track)
    const keys = [`p:${pathKey(f.name)}`]
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
    group.sort((a, b) => rank(a) - rank(b) || fileQuality(b) - fileQuality(a))
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
      no: trackNo(f.track) ?? fmts.map((x) => trackNo(x.track)).find((x) => x != null) ?? prefixTrackNo(f.name),
      title: t ? t.trim() : cleanTrackTitle(stem(f.name).replace(/_/g, ' '), { names, numbered }),
      durationMs,
      fmts,
      composer: fmts.map((x) => x.artist ?? x.creator).find(Boolean) ?? null
    }
  })
  rows.sort((a, b) => a.disc - b.disc || (a.no ?? 1e6) - (b.no ?? 1e6) || natural.compare(a.f.name, b.f.name))
  // Tag numbers that repeat within a disc (several discs tagged without disc numbers, a set of
  // alternate takes) can't be shown as-is: number those discs by position instead. When the tags
  // name different totals ("3/28", "3/37": discs merged without disc tags) their order means
  // nothing either, so such a disc is ordered by file name.
  const seenNo = new Map<number, Set<number>>()
  const totals = new Map<number, Set<string>>()
  const renumber = new Set<number>()
  for (const r of rows) {
    if (r.no == null) continue
    const s = seenNo.get(r.disc) ?? new Set<number>()
    if (s.has(r.no)) renumber.add(r.disc)
    s.add(r.no)
    seenNo.set(r.disc, s)
    const total = /(?:\/|\bof\s+)(\d+)/.exec(r.f.track ?? '')?.[1]
    if (total) totals.set(r.disc, (totals.get(r.disc) ?? new Set()).add(total))
  }
  const byName = new Set([...renumber].filter((d) => (totals.get(d)?.size ?? 0) > 1))
  if (byName.size) rows.sort((a, b) => a.disc - b.disc || (byName.has(a.disc) ? 0 : (a.no ?? 1e6) - (b.no ?? 1e6)) || natural.compare(a.f.name, b.f.name))
  const perDisc = new Map<number, number>()
  const tracks: ProviderTrack[] = rows.map((r) => {
    const n = (perDisc.get(r.disc) ?? 0) + 1
    perDisc.set(r.disc, n)
    const number = renumber.has(r.disc) ? n : (r.no ?? n)
    const streams = r.fmts.map((x) => streamOf(identifier, x, iaAudioFormat(x.format, x.name)!, r.durationMs))
    return {
      disc: r.disc,
      number,
      title: stripTrackNumber(r.title, [number, r.no]),
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
  const formats = [...new Set(tracks.flatMap((t) => t.files.map((f) => f.format)))]
  const totalSizes: Partial<Record<AudioFormat, number>> = {}
  for (const t of tracks) for (const f of t.files) if (f.sizeBytes) totalSizes[f.format] = (totalSizes[f.format] ?? 0) + f.sizeBytes
  const creators = arr(md.creator).flatMap((c) => c.split(/\s*[;,]\s*/)).filter(Boolean)
  const subjects = iaSubjects(md.subject)
  return {
    provider: IA_ID,
    ref: identifier,
    title,
    titleFromRef: !rawTitle,
    platforms: iaPlatforms(rawTitle ?? '', subjects),
    kind: iaAlbumKind(rawTitle ?? '', subjects, description),
    typeLabel: 'Internet Archive',
    year: iaYear(md.year, md.date),
    thumb: itemThumb(identifier),
    cover,
    catalogNo,
    addedAt: null,
    altTitles: [rawTitle && rawTitle !== title ? rawTitle : null, albumTag && albumTag !== title ? albumTag : null].filter((x): x is string => !!x),
    titleOriginal: null,
    developers: [],
    publishers: [],
    composers: creators,
    images: [cover],
    description: description.slice(0, 2000) || null,
    formats,
    totalSizes,
    externalId: identifier,
    tracks
  }
}

/** "01 Asteroid Dance" (title tag that repeats the track number) → "Asteroid Dance". */
function stripTrackNumber(title: string, numbers: (number | null)[]): string {
  const m = /^0*(\d{1,3})(?:\s*[-.):_]\s*|\s+)(?=\S)/.exec(title)
  if (!m || !numbers.includes(Number(m[1]))) return title
  const rest = title.slice(m[0].length).trim()
  return /[\p{L}\p{N}]/u.test(rest) ? rest : title
}

// ---------------------------------------------------------------------------
// Catalog index (IndexProvider): curated game-soundtrack collections, enumerated with
// advancedsearch.php (500 items a page, sorted by identifier so pages are stable). Hits carry only
// what the listing has; track lists come from /metadata/<identifier> when an album is opened.
// (Not the scrape API: on 2026-10-14 its `total_only=true` answered 1,556 for every collection,
// whatever `q` said; advancedsearch's numFound was right for all of them.)
//
//  - folksoundomy_gamesoundtracks: a game-soundtrack collection; everything with playable audio
//    except untitled / single-track uploads and items that are clearly something else.
//  - hifidelity_soundtracks: film / TV / game soundtracks mixed; only items that look like games
//    (subjects, title, description, creator) are kept.
//  - hifidelity_potpourri: a 200k-item grab bag; only the slice tagged with game-music subjects.
//  - gametracks is left out: one BGM per item (826 games, a third with a single track), almost all
//    GB/SNES, which the chip-rip provider covers completely.

export interface IaIndexDoc extends IaDoc {
  subject?: string | string[]
  description?: string | string[]
  mediatype?: string
}

export interface IaIndexResponse {
  response?: { numFound?: number; start?: number; docs?: IaIndexDoc[] }
}

export interface IaIndexCollection {
  /** Section key (the collection identifier). */
  key: string
  label: string
  /** advancedsearch query for the section. */
  query: string
  /** Mixed collection: keep only items that look like game soundtracks. */
  gamesOnly: boolean
}

const GAME_MUSIC_SUBJECTS = '"video game music" OR "video game soundtrack" OR "video game ost" OR "game soundtrack" OR "game music" OR "game ost" OR gamerip OR vgm'

export const IA_INDEX_COLLECTIONS: IaIndexCollection[] = [
  { key: 'folksoundomy_gamesoundtracks', label: 'Folksoundomy game soundtracks', query: 'collection:folksoundomy_gamesoundtracks', gamesOnly: false },
  { key: 'hifidelity_soundtracks', label: 'High Fidelity soundtracks', query: 'collection:hifidelity_soundtracks', gamesOnly: true },
  { key: 'hifidelity_potpourri', label: 'High Fidelity potpourri', query: `collection:hifidelity_potpourri AND subject:(${GAME_MUSIC_SUBJECTS})`, gamesOnly: true }
]

export const IA_INDEX_ROWS = 500
const INDEX_FIELDS = ['identifier', 'title', 'creator', 'date', 'year', 'subject', 'description', 'format', 'mediatype']

export function indexPageUrl(c: IaIndexCollection, page: number, rows = IA_INDEX_ROWS): string {
  const p = new URLSearchParams({ q: c.query })
  for (const f of INDEX_FIELDS) p.append('fl[]', f)
  p.append('sort[]', 'identifier asc')
  p.set('rows', String(rows))
  p.set('page', String(page))
  p.set('output', 'json')
  return `${IA_BASE}/advancedsearch.php?${p.toString()}`
}

/** Subjects come as one "a; b; c" string or an array of them. */
export function iaSubjects(v: string | string[] | undefined): string[] {
  return arr(v)
    .flatMap((s) => s.split(/\s*;\s*/))
    .map((s) => s.trim())
    .filter(Boolean)
}

function plainText(v: string | string[] | undefined): string {
  return arr(v)
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function iaYear(year: string | number | undefined, date: string | undefined): number | null {
  for (const v of [year, date]) {
    const m = /^\s*(\d{4})/.exec(String(v ?? ''))
    const y = m ? Number(m[1]) : null
    if (y && y >= 1970 && y <= 2100) return y
  }
  return null
}

// Titles -------------------------------------------------------------------

/** A bracket group that only names the upload's format / quality: "[FLAC]", "(MP3 & FLAC)", "(FLAC 96KHz 24bit)", "(Opus ~128)". */
const FORMAT_GROUP = /\s*[[(（](?:\s*(?:\.?(?:flac|mp3|wav|m4a|aac|alac|ogg|opus)|\d{2,3}\s*-?\s*bits?|\d{2,3}(?:[.,]\d)?\s*k(?:hz)?|\d{2,3}\s*kbps|v0|320|~\s*\d{2,3}|hi-?res|lossless|mp3\s+version|flac\s+version|version|and|&|\+|\/|,)\s*)+[\])）]/gi
/** "[ARCJ-12] Title", "{MJCA-00050} Title": a leading catalog number. */
const LEADING_CATALOG = /^\s*[[{(]\s*([A-Z]{2,6}-\d{1,6}(?:[~-]\d{1,4})?)\s*[\]})]\s*/
/** "KONAMI: Castlevania…", "Popcap Games: Bejeweled…": a developer prefix some uploaders add. */
const DEVELOPER_PREFIX =
  /^(?:konami|capcom|sega|namco|bandai\s+namco|square|squaresoft|enix|square\s+enix|hudson(?:\s+soft)?|taito|nintendo|atlus|koei|tecmo|irem|jaleco|sunsoft|data\s+east|snk|technos|natsume|(?:[\p{L}\p{N}&.'-]+\s){0,2}[\p{L}\p{N}&.'-]+\s(?:games|soft|software|interactive|studios?))\s*:\s+(?=\S)/iu

/** Conservative display title: format tags, a leading catalog number and a developer prefix go; everything else stays. */
export function cleanIaTitle(raw: string): { title: string; catalogNo: string | null } {
  let s = raw.replace(/\s+/g, ' ').trim()
  if (!/\s/.test(s) && /_/.test(s)) s = s.replace(/_+/g, ' ').trim()
  let catalogNo: string | null = null
  const cat = LEADING_CATALOG.exec(s)
  if (cat && /[\p{L}]/u.test(s.slice(cat[0].length))) {
    catalogNo = cat[1]
    s = s.slice(cat[0].length)
  }
  const noFmt = s.replace(FORMAT_GROUP, ' ').replace(/\s+/g, ' ').trim()
  if (/[\p{L}\p{N}]/u.test(noFmt)) s = noFmt
  const noDev = s.replace(DEVELOPER_PREFIX, '')
  if (noDev !== s && /[\p{L}\p{N}]{2}/u.test(noDev)) s = noDev
  s = s.replace(/\s+([,.:;!?)\]])/g, '$1').replace(/\s+[-–—:|,]+$|[\s:|,]+$/u, '').trim()
  return { title: s || raw.trim(), catalogNo }
}

// Platforms ----------------------------------------------------------------

const P = (slug: string, name: string): PlatformRef => ({ slug, name })
// KHInsider's slugs and names, so IA albums group with KHInsider's in Browse.
const PLATFORM_ALIASES: Record<string, PlatformRef> = {}
for (const [ref, aliases] of [
  [P('nintendo-snes', 'SNES'), ['snes', 'super nintendo', 'super nintendo entertainment system', 'super famicom', 'sfc']],
  [P('nintendo-nes', 'NES'), ['nes', 'nintendo entertainment system']],
  [P('family-computer', 'Family Computer'), ['famicom', 'family computer', 'fc']],
  [P('nintendo-64', 'N64'), ['n64', 'nintendo 64']],
  [P('nintendo-gamecube', 'GC'), ['gamecube', 'game cube', 'gcn', 'ngc']],
  [P('nintendo-wii', 'Wii'), ['wii']],
  [P('nintendo-wii-u', 'Wii U'), ['wii u', 'wiiu']],
  [P('nintendo-switch', 'Switch'), ['switch', 'nintendo switch']],
  [P('switch-2', 'Switch 2'), ['switch 2', 'nintendo switch 2']],
  [P('gameboy', 'GB'), ['gb', 'game boy', 'gameboy']],
  [P('gameboy-color', 'GBC'), ['gbc', 'game boy color', 'gameboy color']],
  [P('gameboy-advance', 'GBA'), ['gba', 'game boy advance', 'gameboy advance']],
  [P('nintendo-ds', 'DS'), ['ds', 'nds', 'nintendo ds']],
  [P('nintendo-3ds', '3DS'), ['3ds', 'nintendo 3ds']],
  [P('playstation', 'PS1'), ['ps1', 'psx', 'psone', 'ps one', 'playstation', 'playstation 1', 'sony playstation']],
  [P('playstation-2', 'PS2'), ['ps2', 'playstation 2']],
  [P('playstation-3', 'PS3'), ['ps3', 'playstation 3']],
  [P('playstation-4', 'PS4'), ['ps4', 'playstation 4']],
  [P('playstation-5', 'PS5'), ['ps5', 'playstation 5']],
  [P('playstation-portable-psp', 'PSP'), ['psp', 'playstation portable']],
  [P('playstation-vita', 'PS Vita'), ['ps vita', 'psvita', 'vita', 'playstation vita']],
  [P('xbox', 'Xbox'), ['xbox']],
  [P('xbox-360', 'Xbox 360'), ['xbox 360', 'x360']],
  [P('xbox-one', 'Xbox One'), ['xbox one']],
  [P('xbox-series-x', 'Xbox Series X/S'), ['xbox series x', 'xbox series x/s', 'xbox series']],
  [P('sega-mega-drive-genesis', 'Genesis / Mega Drive'), ['genesis', 'mega drive', 'megadrive', 'mega drive/genesis', 'genesis/mega drive', 'md']],
  [P('sega-cd', 'Sega CD'), ['sega cd', 'mega cd', 'mega-cd']],
  [P('sega-32x', '32X'), ['32x']],
  [P('sega-saturn', 'Saturn'), ['saturn', 'sega saturn']],
  [P('sega-dreamcast', 'Dreamcast'), ['dreamcast']],
  [P('sega-master-system', 'Master System'), ['master system', 'sms', 'mark iii']],
  [P('sega-game-gear', 'Game Gear'), ['game gear', 'gg']],
  [P('turbografx-16', 'TurboGrafx-16'), ['pc engine', 'pce', 'turbografx', 'turbografx-16', 'turbografx 16', 'pc engine cd', 'turbo cd']],
  [P('arcade', 'Arcade'), ['arcade']],
  [P('msx', 'MSX'), ['msx']],
  [P('msx2', 'MSX2'), ['msx2']],
  [P('pc-9801', 'PC-98'), ['pc-98', 'pc98', 'pc-9801']],
  [P('pc-8801', 'PC-88'), ['pc-88', 'pc88', 'pc-8801']],
  [P('x68000', 'X68000'), ['x68000', 'x68k']],
  [P('fm-towns', 'FM Towns'), ['fm towns']],
  [P('amiga', 'Amiga'), ['amiga', 'commodore amiga']],
  [P('commodore-64', 'Commodore 64'), ['c64', 'commodore 64']],
  [P('spectrum', 'Spectrum'), ['zx spectrum', 'spectrum']],
  [P('atari-st', 'Atari ST'), ['atari st']],
  [P('amstrad-cpc', 'Amstrad CPC'), ['amstrad cpc', 'amstrad', 'cpc']],
  [P('3do', '3DO'), ['3do']],
  [P('neo-geo', 'Neo Geo'), ['neo geo', 'neogeo', 'neo-geo', 'neo geo aes', 'neo geo mvs']],
  [P('ms-dos', 'MS-DOS'), ['ms-dos', 'msdos', 'dos']],
  [P('windows', 'Windows'), ['pc', 'windows', 'microsoft windows', 'pc windows']],
  [P('mac-os', 'MacOS'), ['mac', 'macos', 'mac os', 'mac os x']],
  [P('linux', 'Linux'), ['linux']],
  [P('ios', 'iOS'), ['ios', 'iphone']],
  [P('android', 'Android'), ['android']],
  [P('mobile', 'Mobile'), ['mobile']]
] as [PlatformRef, string[]][])
  for (const a of aliases) PLATFORM_ALIASES[a] = ref

function platformOf(text: string): PlatformRef | null {
  const t = text
    .toLowerCase()
    .replace(/\s+(?:version|ver\.?|port|edition|release)$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return PLATFORM_ALIASES[t] ?? PLATFORM_ALIASES[t.replace(/^(?:nintendo|sega|sony|microsoft|nec|snk|commodore|atari|sharp|fujitsu)\s+/, '')] ?? null
}

/** Platforms named by a subject ("SNES", "Sega Genesis") or a title tag ("(Wii U)", "[SEGA Mega Drive]", "(PS3,Windows)", "~NES Version~"). */
export function iaPlatforms(title: string, subjects: string[]): PlatformRef[] {
  const out: PlatformRef[] = []
  const add = (p: PlatformRef | null) => {
    if (p && !out.some((x) => x.slug === p.slug)) out.push(p)
  }
  for (const g of title.matchAll(/[[(（~]([^\])）~]{1,60})[\])）~]/g)) for (const part of g[1].split(/\s*(?:[,/&+|]|\band\b)\s*/i)) add(platformOf(part))
  for (const s of subjects) add(platformOf(s))
  return out
}

// Kind ---------------------------------------------------------------------

const RIP_RE = /\bgame\s*-?\s*rips?\b|\bgamerips?\b|\bripped\b/
const MEDIA_RIP_RE = /\b(?:cd|vinyl|lp|cassette|tape|flac|eac|web|digital)\s*-?\s*rips?\b/
const RIP_DESC_RE = /\b(?:ripped|extracted)\s+(?:directly\s+)?from\s+(?:the\s+)?(?:game|rom|iso|disc\s+image|game\s+files)|\bgame(?:'s|s)?\s+files\b|\bin-?\s*game\s+(?:music|audio|rip)|\bgame\s*-?\s*rips?\b|\bgamerips?\b/

/** Album kind from the item's title (as getAlbum always did), then its subjects and description for game rips. */
export function iaAlbumKind(title: string, subjects: string[] = [], description = ''): AlbumKind {
  const t = title.toLowerCase()
  if (RIP_RE.test(t) || (/\brip\b/.test(t) && !MEDIA_RIP_RE.test(t))) return 'gamerip'
  if (/\bremix/.test(t)) return 'remix'
  if (/\barrange|\bpiano\b|\borchestra/.test(t)) return 'arrange'
  if (subjects.some((s) => /\bgame\s*-?\s*rips?\b|\bgamerips?\b/i.test(s))) return 'gamerip'
  if (RIP_DESC_RE.test(description.slice(0, 1500).toLowerCase())) return 'gamerip'
  return 'ost'
}

// Game or not (mixed collections) ----------------------------------------------

const GAME_SUBJECT = /\b(?:video\s*-?\s*games?|videogames?|computer\s+games?|pc\s+games?|(?:video\s*)?game\s+(?:soundtracks?|music|osts?|bgm|scores?|audio|rips?)|vgm|gamerips?|game\s*-?\s*rips?|nintendo|sega|playstation|xbox|famicom|game\s*boy|gameboy|visual\s+novels?|eroge|jrpg)\b/
/** Tagged "game", "games", "flash game", "adventure game studio games". */
const GAME_SUBJECT_TAG = /(?:^|\s)games?$/
const GAME_SUBJECT_WEAK = /\b(?:chiptunes?|chip\s*music|8\s*-?\s*bit|16\s*-?\s*bit|rpg|indie\s+games?|mobile\s+games?|retro\s*gam\w*|steam|doujin|games?)\b/
/** A whole subject that files the item under film / TV / theatre / radio / live recordings. */
const OTHER_SUBJECT =
  /^(?:(?:original\s+)?(?:films?|movies?|motion\s+pictures?|cinema|tv|television|tv\s+series|tv\s+shows?|sitcoms?|broadway|musicals?|musical\s+theat(?:re|er)|cast\s+recordings?|original\s+cast|theat(?:re|er)|documentar(?:y|ies)|netflix|hbo|bbc|disney|pixar|dreamworks|anime|drama\s+cd|radio|live|live\s+music|concerts?|bootlegs?|star\s+trek|doctor\s+who)(?:\s+(?:soundtracks?|scores?|music|osts?|themes?|songs?))?|film\s+scores?|movie\s+soundtracks?)$/
/** Never an album: podcasts, radio shows, audiobooks. */
const NOT_ALBUM_SUBJECT = /\bpodcasts?\b|^radio\s+(?:shows?|programs?|programmes?)$|^audiobooks?$|^interviews?$/
const GAME_TITLE =
  /\b(?:video\s*-?\s*game|videogame|computer\s+game|(?:original\s+)?game\s+(?:soundtrack|music|ost|bgm|rip|score|audio)|gamerip|game\s*-?\s*rip|music\s+from\s+the\s+(?:[\w.'&-]+\s+){0,4}game|sound\s+version|osv|sound\s+selection|sound\s+box)\b/
const BRAND_TITLE = /\b(?:nintendo|sega|playstation|xbox|game\s*boy|famicom|super\s+nintendo|dreamcast|gamecube)\b/
const OTHER_TITLE =
  /\b(?:motion\s+picture|(?:music|songs|soundtrack|score)\s+(?:from|of)\s+the\s+(?:film|movie|series|tv\s+series|television\s+series|motion\s+picture|musical|play)|original\s+(?:television|tv|broadway|london|cast|series)|film\s+score|the\s+movie|season\s+\d+|live\s+(?:at|in|from)\b|in\s+concert|walkthrough|longplay|playthrough|let'?s\s+play|gameplay)\b|\b\d{4}-\d{2}-\d{2}\b/
const GAME_DESC =
  /\b(?:video\s*-?\s*games?|videogames?|computer\s+games?|game\s+(?:soundtrack|music|files|rip|ost)|gamerips?|game\s*-?\s*rips?|vgmdb\.net\/album|khinsider|ripped\s+(?:directly\s+)?from\s+the\s+game|in-?\s*game|playstation|xbox|game\s*boy|super\s+nintendo|famicom|nintendo\s+(?:switch|ds|3ds|wii|64)|sega\s+(?:genesis|saturn|dreamcast|mega\s+drive|cd))\b/
const GAME_DESC_WEAK = /\b(?:the|this|a)\s+game(?:'s)?\b|\bgames?\s+(?:by|from|developed|published|released)\b|\bplayers?\b|\blevels?\b|\bboss(?:es)?\b/
const OTHER_DESC =
  /\b(?:motion\s+picture|(?:the|this)\s+(?:film|movie|musical)|feature\s+film|directed\s+by|tv\s+(?:series|show)|television\s+(?:series|show)|broadway|cast\s+recording|imdb\.com|anime\s+series|live\s+(?:recording|show|concert|set)|setlist|soundboard)\b/
/** Stock / production-music listings ("Track Summary … ISRC … Keywords: … trailer advertisement"). */
const STOCK_DESC = /\btrack\s+summary\b|\bisrc:.*\bkeywords:|\bstock\s+music\b|\broyalty[-\s]free\b|\bproduction\s+music\b|\blibrary\s+music\b|\btrailer\s+advertisement\b/
/** Game companies (creator field). */
const GAME_CREATOR =
  /\b(?:nintendo|sega|capcom|konami|square(?:\s*enix|soft)?|enix|namco|bandai|atlus|falcom|hudson|taito|koei|tecmo|blizzard|electronic\s+arts|ea\s+games|ubisoft|activision|bethesda|valve|id\s+software|rare|hal\s+laboratory|game\s*freak|sonic\s+team|treasure|snk|irem|data\s+east|sunsoft|jaleco|chunsoft|level-?5|mihoyo|hoyoverse|devsisters|supergiant|team\s+cherry|popcap|zeptolab|rovio|supercell|gameloft|epic\s+games|riot\s+games|cd\s+projekt|rockstar|naughty\s+dog|insomniac|platinum\s*games|from\s*software|toaplan|compile|technos|natsume|tose|alphadream|intelligent\s+systems|camelot|aquaplus|nippon\s+ichi|gust|idea\s+factory|arc\s+system\s+works|vanillaware|grasshopper|tt\s+games|traveller'?s\s+tales|eidos|westwood|origin\s+systems|sierra|lucasarts|infogrames|psygnosis|codemasters|team\s*17|bullfrog|mojang|c418|toby\s+fox|yuzo\s+koshiro|koji\s+kondo|nobuo\s+uematsu|yoko\s+shimomura|motoi\s+sakuraba|tim\s+follin|david\s+wise|grant\s+kirkhope|jake\s+kaufman|manami\s+matsumae)\b|\b(?:games|game\s+studios?)\b/

// Known game labels / composers (match.ts), minus labels that release film soundtracks too.
const GAME_LABEL_KEYS = new Set(KNOWN_LABELS.filter((l) => !['sony music', 'mondo', 'playstation', 'xbox', 'ea'].includes(l)).map((l) => tokens(l).join(' ')))

function creatorIsLabel(creator: string): boolean {
  return creator.split(/\s*(?:[;,&/]|\band\b)\s*/).some((c) => GAME_LABEL_KEYS.has(tokens(c).join(' ')))
}

export interface IaGameSignals {
  game: number
  other: number
  /** At least one non-weak game signal (subject / title / description / creator). */
  strong: boolean
  reasons: string[]
}

/** How much an item looks like a video game soundtrack vs film / TV / other music. */
export function iaGameSignals(d: Pick<IaIndexDoc, 'title' | 'subject' | 'description' | 'creator'>): IaGameSignals {
  const reasons: string[] = []
  let game = 0
  let other = 0
  let strong = false
  const hit = (cond: boolean, pts: number, why: string, neg = false) => {
    if (!cond) return
    if (neg) other += pts
    else {
      game += pts
      if (pts >= 2) strong = true
    }
    reasons.push(`${neg ? '-' : '+'}${pts} ${why}`)
  }
  const title = (first(d.title) ?? '').toLowerCase()
  const subjects = iaSubjects(d.subject).map((s) => s.toLowerCase())
  const desc = plainText(d.description).slice(0, 1500).toLowerCase()
  const creator = arr(d.creator).join(' ; ').toLowerCase()
  hit(subjects.some((s) => GAME_SUBJECT.test(s)), 3, 'subject')
  hit(subjects.some((s) => platformOf(s) && !['pc', 'windows', 'mobile', 'mac', 'linux', 'ios', 'android', 'dos'].includes(s)), 2, 'platform subject')
  hit(!subjects.some((s) => GAME_SUBJECT.test(s)) && subjects.some((s) => GAME_SUBJECT_TAG.test(s)), 2, 'tagged game')
  hit(subjects.some((s) => GAME_SUBJECT_WEAK.test(s)), 1, 'weak subject')
  hit(subjects.some((s) => OTHER_SUBJECT.test(s)), 3, 'film/tv subject', true)
  hit(subjects.some((s) => NOT_ALBUM_SUBJECT.test(s)) || /\bpodcast\b|\bradio\s+show\b/.test(title), 10, 'podcast / radio', true)
  hit(GAME_TITLE.test(title), 3, 'title')
  hit(iaPlatforms(title, []).length > 0 || BRAND_TITLE.test(title), 2, 'platform in title')
  hit(OTHER_TITLE.test(title), 3, 'film/tv/live title', true)
  hit(GAME_DESC.test(desc), 2, 'description')
  hit(GAME_DESC_WEAK.test(desc), 1, 'weak description')
  hit(OTHER_DESC.test(desc), 2, 'film/tv description', true)
  hit(STOCK_DESC.test(desc), 10, 'stock / production music', true)
  hit(GAME_CREATOR.test(creator) || creatorIsLabel(creator), 2, 'game company / composer')
  return { game, other, strong, reasons }
}

export function isGameSoundtrack(d: Pick<IaIndexDoc, 'title' | 'subject' | 'description' | 'creator'>): boolean {
  const s = iaGameSignals(d)
  // Strong evidence that outweighs any film / TV hint, or some evidence and no such hint at all.
  return (s.game >= 3 && s.game - s.other >= 2) || (s.strong && s.other === 0)
}

// Hits ---------------------------------------------------------------------

const SFX_ONLY = /\b(?:sound\s*effects?|sfx|voice\s*(?:lines|clips|files)|every\s+audio\s+asset|ripped\s+assets?)\b/i
const MUSIC_WORDS = /\b(?:o\.?s\.?t|soundtracks?|music|bgm|score|songs?|themes?)\b/i
/** "01. Title", "02 Title", "1 20. Title": an upload titled like a single track. */
const STRAY_TRACK = /^(?:0\d\.?\s|\d{1,2}\.\s|\d{1,2}\s\d{1,2}\.\s)/
const ALBUM_WORDS = /\b(?:o\.?s\.?t|soundtracks?|album|collection|complete|full|vol(?:ume)?\.?\s*\d|dis[ck]\s*\d)\b/i

/** One listing row → AlbumHit, or null for items that aren't a playable game album. */
export function indexHit(d: IaIndexDoc, c: Pick<IaIndexCollection, 'gamesOnly'>): AlbumHit | null {
  if (!d?.identifier || !hasPlayableAudio(d.format)) return null
  const raw = first(d.title)?.trim() || null
  if (raw && !/\p{L}/u.test(raw)) return null
  if (raw && SFX_ONLY.test(raw) && !MUSIC_WORDS.test(raw)) return null
  // A stray single track ("01. Splattack!", "12. Pirate Land") isn't an album.
  if (raw && STRAY_TRACK.test(raw) && !ALBUM_WORDS.test(raw)) return null
  if (c.gamesOnly) {
    if (!isGameSoundtrack(d)) return null
  } else {
    // Curated collection: only drop what is clearly something else (anime drama CDs, podcasts, live sets).
    const s = iaGameSignals(d)
    if (s.other >= 3 && s.game < 2) return null
  }
  const { title, catalogNo } = raw ? cleanIaTitle(raw) : { title: d.identifier, catalogNo: null }
  const subjects = iaSubjects(d.subject)
  return {
    provider: IA_ID,
    ref: d.identifier,
    title,
    titleFromRef: !raw,
    platforms: iaPlatforms(raw ?? '', subjects),
    kind: iaAlbumKind(raw ?? '', subjects, plainText(d.description)),
    typeLabel: null,
    year: iaYear(d.year, d.date),
    thumb: itemThumb(d.identifier),
    cover: itemThumb(d.identifier),
    catalogNo,
    addedAt: null
  }
}

export function parseIndexPage(json: IaIndexResponse, c: IaIndexCollection, page: number, rows = IA_INDEX_ROWS): IndexPage {
  const r = json?.response
  if (!r || !Array.isArray(r.docs)) throw new NetError('parse', `unexpected advancedsearch response for ${c.key}`)
  const total = r.numFound ?? r.docs.length
  const items: AlbumHit[] = []
  for (const d of r.docs) {
    const h = indexHit(d, c)
    if (h && !items.some((x) => x.ref === h.ref)) items.push(h)
  }
  return { items, page, totalPages: Math.max(1, Math.ceil(total / rows)), totalAlbums: c.gamesOnly ? null : total }
}

// ---------------------------------------------------------------------------
// Provider

export interface ArchiveProviderOptions {
  fetch?: typeof fetch
  now?: () => number
  log?: (msg: string) => void
  /** Collections crawled as catalog sections (default IA_INDEX_COLLECTIONS; [] = no index). */
  indexCollections?: IaIndexCollection[]
  /** Minimum gap between index page requests (ms). IA asks for reasonable rates: default 1 s. */
  indexSpacingMs?: number
}

interface FetchHow {
  /** Keep the parsed response in the in-memory cache (default true; index pages are big and read once). */
  cache?: boolean
  limiter?: HostLimiter
  timeoutMs?: number
}

export class ArchiveProvider implements IndexProvider {
  readonly id = IA_ID
  readonly name = 'Internet Archive'
  readonly findTrackMode = 'fallback' as const

  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly limiter = new HostLimiter({ concurrency: 2, spacingMs: 250 })
  /** Background index crawl: one request at a time, ≥1 s apart, separate from interactive lookups. */
  private readonly indexLimiter: HostLimiter
  private readonly collections: IaIndexCollection[]
  private cache = new Map<string, { at: number; value: Promise<unknown> }>()

  constructor(opts: ArchiveProviderOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
    this.collections = opts.indexCollections ?? IA_INDEX_COLLECTIONS
    this.indexLimiter = new HostLimiter({ concurrency: 1, spacingMs: opts.indexSpacingMs ?? 1000 })
  }

  private getJson<T>(url: string, opts: ProviderCallOptions = {}, how: FetchHow = {}): Promise<T> {
    const useCache = how.cache !== false
    const c = useCache ? this.cache.get(url) : undefined
    if (c && !opts.force && this.now() - c.at < CACHE_TTL_MS) return c.value as Promise<T>
    const limiter = how.limiter ?? this.limiter
    const value = limiter.schedule(async () => {
      const timeout = AbortSignal.timeout(how.timeoutMs ?? 20_000)
      let res: Response
      try {
        res = await this.fetchImpl(url, { headers: { 'User-Agent': GHOST_USER_AGENT, Accept: 'application/json' }, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout })
      } catch (e) {
        if (opts.signal?.aborted) throw new NetError('aborted', 'request aborted', { url })
        if (timeout.aborted) throw new NetError('timeout', `timed out fetching ${url}`, { url })
        throw new NetError('network', `network error fetching ${url}: ${(e as Error).message}`, { url, cause: e })
      }
      if (res.status === 404) throw new NetError('not_found', `not found: ${url}`, { status: 404, url })
      if (res.status === 429 || res.status === 503) {
        this.limiter.pause(10_000)
        this.indexLimiter.pause(60_000)
      }
      if (!res.ok) throw new NetError('http', `HTTP ${res.status} from ${url}`, { status: res.status, url })
      try {
        return (await res.json()) as T
      } catch (e) {
        throw new NetError('parse', `Internet Archive sent something that isn't JSON (${url})`, { url, cause: e })
      }
    }, opts.priority ?? 1, opts.signal)
    if (!useCache) return value
    value.catch(() => this.cache.delete(url))
    this.cache.set(url, { at: this.now(), value })
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!)
    return value
  }

  indexSections(): IndexSection[] {
    return this.collections.map((c) => ({ key: c.key, label: c.label }))
  }

  /** One page (500 items before filtering) of a curated collection, 1-based like the crawler's pages. */
  async fetchIndexPage(sectionKey: string, page: number, opts: ProviderCallOptions = {}): Promise<IndexPage> {
    const c = this.collections.find((x) => x.key === sectionKey)
    if (!c) throw new NetError('not_found', `unknown Internet Archive index section: ${sectionKey}`)
    if (!Number.isInteger(page) || page < 1) throw new NetError('parse', `bad index page ${page} for ${sectionKey}`)
    const json = await this.getJson<IaIndexResponse>(indexPageUrl(c, page), { ...opts, priority: opts.priority ?? 2 }, { cache: false, limiter: this.indexLimiter, timeoutMs: 60_000 })
    return parseIndexPage(json, c, page)
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
