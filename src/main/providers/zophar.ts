// Zophar's Domain (www.zophar.net/music): per-track MP3 renders of emulated game-music rip sets,
// including the PSF/2SF/GSF/USF/3SF families GHOST can't emulate (DESIGN §6.2).
//
// Page shapes (verified 2026-10-14):
//  - Platform listing /music/<platform>[?page=N]: `p.found_stats` "Found 1639 games with 36175 tracks!",
//    `.pagination p.counter` "Page 1 of 9" (200 rows per page), `table#gamelist` rows (tr.regularrow /
//    tr.regularrow_image): td.image img (thumbs_small) | td.name a + span.alternative_names | td.year a |
//    td.developer a. Titles are filed library-style ("7th Saga, The").
//  - Search /music/search?search=<q>: the same table plus a td.console column; year and developer
//    are plain text there.
//  - Album page /music/<platform>/<slug>: #music_cover img (thumbs_large), #music_info h2 and
//    span.infoname / span.infodata pairs (Alternative name, Release date, Console, Developer,
//    Publisher, sometimes Composer, Ripped by, Tagged by), #mass_download (MP3 zip size), and
//    table#tracklist rows: td.number
//    ("101." or empty), td.name, td.length ("m:ss"), td.download a → the MP3 itself. The same list is
//    inline JS (`mediaPath = '…/'`, `tracks = [{track, name, length, file}, …]`). Unknown albums are a
//    plain 404 with an empty body.
//  - Audio: https://fi.zophar.net/soundfiles/<platform>/<slug>/<file> (nginx, Range OK). File names are
//    rawurlencoded (RFC 3986); slugs appear literally, '[' and ']' included. Most renders are 320 kbps
//    CBR (size ÷ listed length on SNES and PSP sets), but not all (an FM Towns set came out ≈250), so
//    streams don't claim a bitrate.
//  - Album pages can lack fields the listing has (an FM Towns set lists 1994 but has no Release date);
//    the catalog keeps the listing's year when the detail has none.
// No Cloudflare and no robots.txt. The index crawl reads listing pages only (≈120 pages for all 36
// platforms); album pages are fetched when an album is opened, and streams need no request at all.

import type { CheerioAPI } from 'cheerio'
import { fragmentText, loadHtml } from './html'
import type { AudioFormat } from '../../shared/types'
import { NetError } from '../net/errors'
import { DAY, TTL, type HttpClient } from '../net/http'
import { formatFromUrl, parseClock, parseSize, titleFromSlug } from './khinsider'
import type {
  AlbumHit,
  IndexPage,
  IndexProvider,
  IndexSection,
  PlatformRef,
  ProviderAlbum,
  ProviderCallOptions,
  ProviderTrack,
  StreamInfo
} from './types'

export const ZOPHAR_ID = 'zophar'
export const ZOPHAR_HOST = 'www.zophar.net'
export const ZOPHAR_BASE = `https://${ZOPHAR_HOST}`
export const ZOPHAR_FILES_BASE = 'https://fi.zophar.net/soundfiles'
/** Rows per platform listing page. */
export const ZOPHAR_PAGE_SIZE = 200
export const ZOPHAR_INDEX_REFRESH_MS = 14 * DAY
export const ZOPHAR_PAGE_DELAY_MS = 1000

/** First path segments under /music/ that are not platforms. */
const NON_PLATFORM_SLUGS = new Set(['letter', 'developer', 'publisher', 'year', 'popular', 'search'])

// ---------------------------------------------------------------------------
// Platforms

const p = (slug: string, name: string): PlatformRef => ({ slug, name })

/**
 * Zophar platform slug → catalog platform. Slugs and names are KHInsider's wherever KHInsider has the
 * platform, so platform filters work across sources. Zophar can't tell GB from GBC rips (both are GBS).
 */
const PLATFORMS: Record<string, PlatformRef> = {
  'nintendo-nes-nsf': p('nintendo-nes', 'NES'),
  'nintendo-snes-spc': p('nintendo-snes', 'SNES'),
  'gameboy-gbs': p('gameboy', 'GB'),
  'gameboy-advance-gsf': p('gameboy-advance', 'GBA'),
  'nintendo-64-usf': p('nintendo-64', 'N64'),
  'nintendo-ds-2sf': p('nintendo-ds', 'DS'),
  'nintendo-3ds-3sf': p('nintendo-3ds', '3DS'),
  'nintendo-gamecube-gcn': p('nintendo-gamecube', 'GC'),
  'nintendo-wii': p('nintendo-wii', 'Wii'),
  'playstation-psf': p('playstation', 'PS1'),
  'playstation2-psf2': p('playstation-2', 'PS2'),
  'playstation3-psf3': p('playstation-3', 'PS3'),
  'playstation-portable-psp': p('playstation-portable-psp', 'PSP'),
  'sega-mega-drive-genesis': p('sega-mega-drive-genesis', 'Genesis / Mega Drive'),
  'sega-master-system-vgm': p('sega-master-system', 'Master System'),
  'sega-game-gear-sgc': p('sega-game-gear', 'Game Gear'),
  'sega-saturn-ssf': p('sega-saturn', 'Saturn'),
  'sega-dreamcast-dsf': p('sega-dreamcast', 'Dreamcast'),
  'turbografx-16-hes': p('turbografx-16', 'TurboGrafx-16'),
  xbox: p('xbox', 'Xbox'),
  'xbox-360': p('xbox-360', 'Xbox 360'),
  arcade: p('arcade', 'Arcade'),
  windows: p('windows', 'Windows'),
  'ms-dos': p('ms-dos', 'MS-DOS'),
  amiga: p('amiga', 'Amiga'),
  'commodore-64': p('commodore-64', 'Commodore 64'),
  'pc-9801': p('pc-9801', 'PC-98'),
  'pc-8801': p('pc-8801', 'PC-88'),
  x68000: p('x68000', 'X68000'),
  'fm-towns': p('fm-towns', 'FM Towns'),
  msx2: p('msx2', 'MSX2'),
  'sharp-x1': p('sharp-x1', 'Sharp X1'),
  'atari-st': p('atari-st', 'Atari ST'),
  'atari-8bit': p('atari-8bit', 'Atari 8-bit'),
  spectrum: p('spectrum', 'Spectrum'),
  'cd-i': p('cd-i', 'CD-i'),
  // In the search form's console list but without a listing link; slugs are a guess (unverified).
  'nintendo-switch': p('nintendo-switch', 'Switch'),
  'nintendo-wii-u': p('nintendo-wii-u', 'Wii U'),
  'playstation-4': p('playstation-4', 'PS4'),
  'playstation-vita': p('playstation-vita', 'PS Vita'),
  // Older short slugs still linked from the sidebar (no game count; not crawled).
  nsf: p('nintendo-nes', 'NES'),
  spc: p('nintendo-snes', 'SNES'),
  gbs: p('gameboy', 'GB'),
  gsf: p('gameboy-advance', 'GBA'),
  usf: p('nintendo-64', 'N64'),
  '2sf': p('nintendo-ds', 'DS'),
  nds: p('nintendo-ds', 'DS'),
  psf: p('playstation', 'PS1'),
  psf2: p('playstation-2', 'PS2'),
  hes: p('turbografx-16', 'TurboGrafx-16'),
  kss: p('msx', 'MSX'),
  wsr: p('wonderswan', 'WonderSwan')
}

/**
 * The platform listings an index crawl reads: the 36 that print a "Found N games" count (2026-10-14),
 * consoles first. ≈19.5k games, ≈120 listing pages.
 */
export const ZOPHAR_SECTION_KEYS: readonly string[] = [
  'nintendo-nes-nsf', 'nintendo-snes-spc', 'gameboy-gbs', 'gameboy-advance-gsf', 'nintendo-64-usf', 'nintendo-ds-2sf',
  'nintendo-3ds-3sf', 'nintendo-gamecube-gcn', 'nintendo-wii',
  'playstation-psf', 'playstation2-psf2', 'playstation3-psf3', 'playstation-portable-psp',
  'sega-mega-drive-genesis', 'sega-master-system-vgm', 'sega-game-gear-sgc', 'sega-saturn-ssf', 'sega-dreamcast-dsf',
  'turbografx-16-hes', 'xbox', 'xbox-360', 'arcade',
  'windows', 'ms-dos', 'amiga', 'commodore-64', 'pc-9801', 'pc-8801', 'x68000', 'fm-towns', 'msx2', 'sharp-x1',
  'atari-st', 'atari-8bit', 'spectrum', 'cd-i'
]

const FORMAT_SUFFIX = /-(?:nsf|spc|gbs|gsf|usf|2sf|3sf|gcn|psf\d?|ssf|dsf|sgc|vgm|hes|kss)$/

/**
 * Catalog platform for a Zophar platform slug. Unknown slugs keep their own slug (minus the rip-format
 * suffix) and take their name from Zophar's console label ("Nintendo Switch", "Playstation 4 (PS4)").
 */
export function zopharPlatform(slug: string, label?: string | null): PlatformRef {
  const known = PLATFORMS[slug.toLowerCase()]
  if (known) return { ...known }
  const s = slug.toLowerCase().replace(FORMAT_SUFFIX, '') || slug.toLowerCase()
  const name = cleanText((label ?? '').replace(/\s*\([^)]*\)\s*$/, '')) || titleFromSlug(s)
  return { slug: s, name }
}

// ---------------------------------------------------------------------------
// URLs, refs and locators
//
// Album ref = '<platform slug>/<game slug>' and track locator = '<platform>/<game>/<file name>', all
// percent-decoded; URLs are rebuilt with the site's own encoding.

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** PHP rawurlencode (RFC 3986 unreserved characters only), which Zophar uses for file names. */
export function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Slugs as the site links them: encoded like file names, but '[' and ']' stay literal. */
function encodeSlug(s: string): string {
  return encodeSegment(s).replace(/%5B/g, '[').replace(/%5D/g, ']')
}

function splitRef(ref: string): [string, string] | null {
  const i = ref.indexOf('/')
  if (i <= 0 || i === ref.length - 1 || ref.indexOf('/', i + 1) >= 0) return null
  return [ref.slice(0, i), ref.slice(i + 1)]
}

export function albumUrl(ref: string): string {
  const parts = splitRef(ref)
  if (!parts) throw new NetError('not_found', `bad Zophar album ref: ${ref}`)
  return `${ZOPHAR_BASE}/music/${encodeSlug(parts[0])}/${encodeSlug(parts[1])}`
}

export function sectionUrl(key: string, page: number): string {
  if (!/^[a-z0-9-]+$/.test(key) || NON_PLATFORM_SLUGS.has(key)) throw new Error(`unknown Zophar index section ${key}`)
  const base = `${ZOPHAR_BASE}/music/${key}`
  return page <= 1 ? base : `${base}?page=${page}`
}

export function searchUrl(q: string): string {
  return `${ZOPHAR_BASE}/music/search?search=${encodeURIComponent(q).replace(/%20/g, '+')}`
}

export interface ZopharLocator {
  platform: string
  slug: string
  /** File name (decoded); may in theory contain '/' for files in a sub-folder. */
  file: string
}

export function parseLocator(locator: string): ZopharLocator {
  const i = locator.indexOf('/')
  const j = i > 0 ? locator.indexOf('/', i + 1) : -1
  if (i <= 0 || j <= i + 1 || j === locator.length - 1) throw new NetError('parse', `bad Zophar locator: ${locator}`)
  return { platform: locator.slice(0, i), slug: locator.slice(i + 1, j), file: locator.slice(j + 1) }
}

/** Direct MP3 URL for a locator. */
export function streamUrl(locator: string): string {
  const { platform, slug, file } = parseLocator(locator)
  return `${ZOPHAR_FILES_BASE}/${encodeSlug(platform)}/${encodeSlug(slug)}/${file.split('/').map(encodeSegment).join('/')}`
}

/** '/music/<platform>/<slug>' (relative or absolute) → '<platform>/<slug>'. */
export function refFromHref(href: string | undefined | null): string | null {
  if (!href) return null
  const m = /^(?:https?:\/\/(?:www\.)?zophar\.net)?\/music\/([^/?#]+)\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(href.trim())
  if (!m || NON_PLATFORM_SLUGS.has(m[1].toLowerCase())) return null
  return `${safeDecode(m[1])}/${safeDecode(m[2])}`
}

/** A soundfiles URL (or the inline `mediaPath` + file) → locator. */
export function locatorFromUrl(url: string): string | null {
  const m = /^(?:https?:)?\/\/fi\.zophar\.net\/soundfiles\/([^/?#]+)\/([^/?#]+)\/([^?#]+)$/i.exec(url.trim())
  if (!m) return null
  return [m[1], m[2], ...m[3].split('/')].map(safeDecode).join('/')
}

/** Listing thumbnail or album-page image (…/thumbs_small/x.jpg, …/thumbs_large/x.jpg) → full-size (…/x.jpg). */
export function coverFromThumb(thumb: string | null): string | null {
  if (!thumb) return null
  return thumb.replace(/\/thumbs_(?:small|large)\//, '/')
}

// ---------------------------------------------------------------------------
// Small parsers

function cleanText(s: string): string {
  return s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Zophar files titles library-style: "7th Saga, The" → "The 7th Saga", "Legend of Zelda, The - …" →
 * "The Legend of Zelda - …". Regional variants carry a bare suffix ("Adventure Island JP"); it's
 * bracketed so the album keeps it but the game clusters with the other releases.
 */
export function tidyTitle(s: string): string {
  let t = cleanText(s)
  t = t.replace(/\s+(JP|EU|EUR)$/, ' ($1)')
  const m = /^(.+?),\s+(The|A|An)(?=$|\s+[-:[(])(.*)$/.exec(t)
  return m ? `${m[2]} ${m[1]}${m[3]}` : t
}

function absUrl(href: string | undefined): string | null {
  if (!href) return null
  try {
    return new URL(href, ZOPHAR_BASE).toString()
  } catch {
    return null
  }
}

function yearOf(s: string | null | undefined): number | null {
  const m = /\b(19[5-9]\d|20\d\d)\b/.exec(s ?? '')
  return m ? Number(m[1]) : null
}

/** "1:31" → ms; a 0:00 length means unknown. */
function lengthMs(s: string | null | undefined): number | null {
  const ms = parseClock(s)
  return ms ? ms : null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Entities in inline-JS strings (the HTML parser decodes everything else). */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all
    }
    return ENTITIES[e.toLowerCase()] ?? all
  })
}

const NON_LATIN = /[\u0400-\u04ff\u0370-\u03ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff66-\uff9f]/

// ---------------------------------------------------------------------------
// Listings (platform pages and search results share table#gamelist)

function assertZopharLayout($: CheerioAPI): void {
  if (!$('#gamelistpage').length) throw new NetError('parse', "unexpected Zophar's Domain page layout (no #gamelistpage)")
}

function parseGameList($: CheerioAPI): AlbumHit[] {
  const out: AlbumHit[] = []
  const seen = new Set<string>()
  $('table#gamelist tr').each((_, tr) => {
    const row = $(tr)
    const a = row.find('td.name a[href]').first()
    const ref = refFromHref(a.attr('href'))
    if (!ref || seen.has(ref)) return
    seen.add(ref)
    const platformSlug = ref.slice(0, ref.indexOf('/'))
    const titleText = tidyTitle(a.text())
    const thumb = absUrl(row.find('td.image img').attr('src'))
    out.push({
      provider: ZOPHAR_ID,
      ref,
      title: titleText || titleFromSlug(ref.slice(ref.indexOf('/') + 1)),
      titleFromRef: !titleText,
      platforms: [zopharPlatform(platformSlug, row.find('td.console').text())],
      kind: 'gamerip',
      typeLabel: 'Gamerip',
      year: yearOf(row.find('td.year').text()),
      thumb,
      cover: coverFromThumb(thumb),
      catalogNo: null,
      addedAt: null
    })
  })
  return out
}

/** "Page 1 of 9" when the listing paginates; else the "End" link, else "Found N games" ÷ 200. */
function parseStats($: CheerioAPI, requestedPage: number): Pick<IndexPage, 'page' | 'totalPages' | 'totalAlbums'> {
  const found = /Found\s+([\d,]+)\s+games?/i.exec(cleanText($('p.found_stats').first().text()))
  const totalAlbums = found ? Number(found[1].replace(/,/g, '')) : null
  const counter = /Page\s+(\d+)\s+of\s+(\d+)/i.exec(cleanText($('.pagination p.counter').first().text()))
  if (counter) return { page: Number(counter[1]), totalPages: Math.max(1, Number(counter[2])), totalAlbums }
  const end = /[?&]page=(\d+)/.exec($('.pagination li.pagination-end a[href]').first().attr('href') ?? '')
  const totalPages = end ? Number(end[1]) : totalAlbums !== null ? Math.max(1, Math.ceil(totalAlbums / ZOPHAR_PAGE_SIZE)) : 1
  return { page: Math.max(1, requestedPage), totalPages, totalAlbums }
}

/** A platform listing page (/music/<platform>[?page=N]). */
export function parseListingPage(html: string, requestedPage = 1): IndexPage {
  const $ = loadHtml(html)
  assertZopharLayout($)
  return { items: parseGameList($), ...parseStats($, requestedPage) }
}

export function parseSearchPage(html: string): AlbumHit[] {
  const $ = loadHtml(html)
  assertZopharLayout($)
  return parseGameList($)
}

// ---------------------------------------------------------------------------
// Album page

/** One entry of the inline JS playlist. */
export interface InlineTrack {
  name: string
  length: string
  /** File name as written in the JS (usually already rawurlencoded). */
  file: string
}

/** Index just past the ']' closing the array that opens at `from` (names may contain brackets). */
function arrayEnd(s: string, from: number): number {
  let depth = 0
  let inString = false
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '[') depth++
    else if (c === ']' && --depth === 0) return i + 1
  }
  return s.length
}

/** The inline player's `mediaPath` + `tracks = […]`, or null when the page has none. */
export function parseInlineTracks(html: string): { mediaPath: string; tracks: InlineTrack[] } | null {
  const mp = /mediaPath\s*=\s*(['"])(.*?)\1/.exec(html)
  const start = /\btracks\s*=\s*\[/.exec(html)
  if (!mp || !start) return null
  const ext = /\bextension\s*=\s*(['"])(.*?)\1/.exec(html)?.[2] ?? ''
  const from = start.index + start[0].length - 1
  const body = html.slice(from, arrayEnd(html, from))
  let raw: { name?: unknown; length?: unknown; file?: unknown }[] | null = null
  try {
    raw = JSON.parse(body.replace(/,\s*\]$/, ']'))
  } catch {
    // Not valid JSON (a stray quote in a name?): read each object's fields on their own.
    raw = []
    const str = (block: string, key: string) => {
      const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(block)
      if (!m) return undefined
      try {
        return JSON.parse(`"${m[1]}"`) as string
      } catch {
        return m[1]
      }
    }
    for (const block of body.match(/\{[^{}]*\}/g) ?? []) raw.push({ name: str(block, 'name'), length: str(block, 'length'), file: str(block, 'file') })
  }
  const tracks: InlineTrack[] = []
  for (const t of raw ?? []) {
    if (typeof t?.file !== 'string' || !t.file) continue
    const file = ext && !/\.[a-z0-9]{2,4}$/i.test(t.file) ? t.file + ext : t.file
    tracks.push({ name: typeof t.name === 'string' ? decodeEntities(t.name) : '', length: typeof t.length === 'string' ? t.length : '', file })
  }
  return { mediaPath: mp[2], tracks }
}

/**
 * Track title from the name cell. Split tracks put their letter in the file name ("101a Opening
 * Theme (part 1).mp3") and the site shows "101." + "a Opening Theme (part 1)": drop the stray letter.
 */
function trackTitle(name: string, numberCell: string, file: string, seq: number): string {
  let t = cleanText(name)
  const stem = (file.split('/').pop() ?? file).replace(/\.[a-z0-9]{2,4}$/i, '')
  const num = /^(\d+)/.exec(cleanText(numberCell))?.[1]
  const suffix = /^(\d+)([a-z]{1,2})\s/i.exec(stem)
  if (suffix && (!num || Number(num) === Number(suffix[1])) && t.startsWith(`${suffix[2]} `)) t = t.slice(suffix[2].length + 1).trim()
  if (!t) t = cleanText(stem.replace(/^\d+[a-z]{0,2}\s+/i, ''))
  return t || `Track ${seq}`
}

/** StreamInfo for a locator: the MP3 lives at a stable URL, so no request is needed. */
export function zopharStream(locator: string): StreamInfo {
  const fmt = formatFromUrl(parseLocator(locator).file)
  const format: AudioFormat = fmt === 'unknown' ? 'mp3' : fmt
  return {
    provider: ZOPHAR_ID,
    source: { kind: 'http', url: streamUrl(locator), cacheKey: `${ZOPHAR_ID}:${locator}`, formatHint: format },
    format,
    lossless: false,
    bitrateKbps: null,
    sizeBytes: null,
    expiresAt: null
  }
}

function makeTrack(locator: string, title: string, durationMs: number | null, seq: number): ProviderTrack {
  const stream = zopharStream(locator)
  return {
    disc: 1,
    // Zophar's numbers repeat ("101." for parts a/b/c, "999." for extras) or are blank: use the order.
    number: seq,
    title,
    durationMs,
    locator,
    files: [{ format: stream.format, sizeBytes: null }],
    composers: [],
    streams: [stream]
  }
}

function parseTrackTable($: CheerioAPI): ProviderTrack[] {
  const out: ProviderTrack[] = []
  const seen = new Set<string>()
  $('table#tracklist tr').each((_, tr) => {
    const row = $(tr)
    const href = row.find('td.download a[href]').first().attr('href')
    const locator = href ? locatorFromUrl(absUrl(href) ?? href) : null
    if (!locator || seen.has(locator)) return
    seen.add(locator)
    const seq = out.length + 1
    const title = trackTitle(row.find('td.name').text(), row.find('td.number').text(), parseLocator(locator).file, seq)
    out.push(makeTrack(locator, title, lengthMs(row.find('td.length').text()), seq))
  })
  return out
}

function parseInlineTrackList(html: string): ProviderTrack[] {
  const inline = parseInlineTracks(html)
  if (!inline) return []
  const base = inline.mediaPath.endsWith('/') ? inline.mediaPath : `${inline.mediaPath}/`
  const out: ProviderTrack[] = []
  const seen = new Set<string>()
  for (const t of inline.tracks) {
    const locator = locatorFromUrl(base + t.file)
    if (!locator || seen.has(locator)) continue
    seen.add(locator)
    const seq = out.length + 1
    out.push(makeTrack(locator, trackTitle(t.name, '', parseLocator(locator).file, seq), lengthMs(t.length), seq))
  }
  return out
}

/** Names from an info value: one per link, else comma-separated text. */
function infoNames($: CheerioAPI, el: Parameters<CheerioAPI>[0]): string[] {
  const links = $(el)
    .find('a')
    .toArray()
    .map((a) => cleanText($(a).text()))
    .filter(Boolean)
  const names = links.length ? links : cleanText($(el).text()).split(/\s*,\s*/)
  return [...new Set(names.filter(Boolean))]
}

export function parseAlbumPage(html: string, ref: string): ProviderAlbum {
  // Unknown albums are a 404 with an empty body; anything else without #gamepage is a layout change.
  if (!html.trim()) throw new NetError('not_found', `Zophar's Domain has no album "${ref}"`)
  const $ = loadHtml(html)
  const page = $('#gamepage')
  if (!page.length) throw new NetError('parse', "unexpected Zophar's Domain album page layout (no #gamepage)")
  const info = page.find('#music_info')
  const rawTitle = cleanText(info.find('h2').first().text())
  if (!rawTitle) throw new NetError('not_found', `Zophar's Domain has no album "${ref}"`)
  const title = tidyTitle(rawTitle)

  const altTitles: string[] = []
  let year: number | null = null
  let consoleLabel: string | null = null
  const developers: string[] = []
  const publishers: string[] = []
  const composers: string[] = []
  info.find('p').each((_, el) => {
    const label = cleanText($(el).find('span.infoname').first().text()).replace(/:$/, '').toLowerCase()
    const data = $(el).find('span.infodata').first()
    if (!label || !data.length) return
    if (label.startsWith('alternative name')) {
      for (const frag of (data.html() ?? '').split(/<br\s*\/?>/i)) {
        const t = tidyTitle(fragmentText(frag))
        if (t && t !== title && !altTitles.includes(t)) altTitles.push(t)
      }
    } else if (label === 'release date') year = yearOf(data.find('a[href*="/music/year/"]').first().text()) ?? yearOf(data.text())
    else if (label === 'console') consoleLabel = cleanText(data.text()) || null
    else if (label === 'developer') developers.push(...infoNames($, data))
    else if (label === 'publisher') publishers.push(...infoNames($, data))
    // Some sets credit composers ("Composer: Hisao Shiomi, Akira Inoue, Manabu Namiki").
    else if (label === 'composer' || label === 'composers') composers.push(...infoNames($, data))
  })
  const large = absUrl(page.find('#music_cover img').first().attr('src'))
  const cover = coverFromThumb(large)

  // "Download all files as MP3 (54 MB)": the zip of the MP3s, i.e. about their total size.
  const totalSizes: Partial<Record<AudioFormat, number>> = {}
  page.find('#mass_download a').each((_, a) => {
    const m = /as\s+MP3\s*\(([\d.,]+\s*[KMG]?B)\)/i.exec(cleanText($(a).text()))
    const bytes = m ? parseSize(m[1]) : null
    if (bytes) totalSizes.mp3 = bytes
  })

  let tracks = parseTrackTable($)
  if (!tracks.length) tracks = parseInlineTrackList(html)
  const formats = [...new Set(tracks.map((t) => t.files[0].format))]

  const parts = splitRef(ref)
  const platformSlug = parts?.[0] ?? (tracks[0] ? parseLocator(tracks[0].locator).platform : '')
  return {
    provider: ZOPHAR_ID,
    ref,
    title,
    titleFromRef: false,
    platforms: platformSlug ? [zopharPlatform(platformSlug, consoleLabel)] : [],
    kind: 'gamerip',
    typeLabel: 'Gamerip',
    year,
    thumb: large,
    cover,
    catalogNo: null,
    addedAt: null,
    altTitles,
    titleOriginal: altTitles.find((t) => NON_LATIN.test(t)) ?? null,
    developers,
    publishers,
    composers,
    images: cover ? [cover] : [],
    description: null,
    formats: formats.length ? formats : ['mp3'],
    totalSizes,
    externalId: null,
    tracks
  }
}

// ---------------------------------------------------------------------------
// Provider

export class ZopharProvider implements IndexProvider {
  readonly id = ZOPHAR_ID
  readonly name = "Zophar's Domain"
  /** Streams are built from the locator (no request). */
  readonly streamsFromLocator = true
  /** New sets trickle in (a few a week) and land anywhere in the A–Z listings: a full re-read every two weeks. */
  readonly indexRefreshMs = ZOPHAR_INDEX_REFRESH_MS
  /** A small hobby site: a 1 s pause after each listing page, on top of its 1 s host spacing (≈120 pages, about 4 minutes). */
  readonly indexPageDelayMs = ZOPHAR_PAGE_DELAY_MS
  readonly indexEstimateMs = 3 * 60_000

  constructor(private http: HttpClient) {}

  indexSections(): IndexSection[] {
    return ZOPHAR_SECTION_KEYS.map((key) => ({ key, label: zopharPlatform(key).name }))
  }

  async fetchIndexPage(sectionKey: string, page: number, opts: ProviderCallOptions = {}): Promise<IndexPage> {
    const url = sectionUrl(sectionKey, page)
    const r = await this.http.pageFetch(url, { ttlMs: TTL.browse, priority: opts.priority ?? 2, force: opts.force, signal: opts.signal })
    try {
      return parseListingPage(r.html, page)
    } catch (e) {
      if (r.fromCache) await this.http.invalidate(url)
      throw e
    }
  }

  async searchAlbums(q: string, opts: ProviderCallOptions = {}): Promise<AlbumHit[]> {
    const query = q.trim()
    if (!query) return []
    const r = await this.http.pageFetch(searchUrl(query), { ttlMs: TTL.search, priority: opts.priority ?? 0, signal: opts.signal, force: opts.force })
    return parseSearchPage(r.html)
  }

  async getAlbum(ref: string, opts: ProviderCallOptions = {}): Promise<ProviderAlbum> {
    const url = albumUrl(ref)
    const r = await this.http.pageFetch(url, { ttlMs: TTL.album, priority: opts.priority ?? 0, signal: opts.signal, force: opts.force })
    try {
      return parseAlbumPage(r.html, ref)
    } catch (e) {
      if (r.fromCache) await this.http.invalidate(url)
      throw e
    }
  }

  /** The MP3 URL follows from the locator: no request. */
  async resolveStream(locator: string): Promise<StreamInfo[]> {
    return [zopharStream(locator)]
  }
}
