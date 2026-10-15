// KHInsider (downloads.khinsider.com): the main catalog source (DESIGN §6.2).
//
// Page shapes (verified 2026-10):
//  - Letter index  /game-soundtracks/browse/<A..Z|0-9>[?page=N&orderby=name&orderdirection=ASC]
//    `table.albumList` rows: icon (thumbs_small img) | title link | platform links | type | year.
//    "Found N albums!" + `.pagination .counter` "Page 1 of 12" (500 rows per page).
//  - Home page "Latest Soundtracks": `h3.latestSoundtrackHeading` (date) followed by an albumList table.
//  - Search /search?search=<q>: one albumList table (title cell may carry "[CATALOG-NO]").
//  - Album page /game-soundtracks/album/<slug>: h2 title, p.albuminfoAlternativeTitles, an info
//    paragraph (Platforms/Year/Catalog Number/Developed by/Published by/Total Filesize/Date Added/
//    Album type), .albumImage links, `#songlist` (header decides columns: CD, #, Song Name ×2, one
//    column per format), Description. Unknown albums render "Ooops! No such album" with HTTP 200.
//  - Track page /game-soundtracks/album/<slug>/<file>.mp3: `a > span.songDownloadLink` per format
//    pointing at *.vgmtreasurechest.com (any HTTP client, supports Range).

import type { CheerioAPI } from 'cheerio'
import { childElements, findAll, findFirst, fragmentText, linkWithHref, loadHtml, tag, textOf, type DomNode } from './html'
import type { AlbumKind, AudioFormat } from '../../shared/types'
import { NetError } from '../net/errors'
import { TTL, type HttpClient } from '../net/http'
import type {
  AlbumHit,
  IndexPage,
  IndexProvider,
  IndexSection,
  PlatformRef,
  ProviderAlbum,
  ProviderCallOptions,
  ProviderTrack,
  ProviderTrackFile,
  StreamInfo
} from './types'
import { LOSSLESS_FORMATS } from './types'

export const KH_ID = 'khinsider'
export const KH_HOST = 'downloads.khinsider.com'
export const KH_BASE = `https://${KH_HOST}`
export const KH_REFERER = `${KH_BASE}/`
export const KH_LETTERS = ['0-9', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')]
/** How many pages of the "Latest Soundtracks" feed an index crawl reads (≈8 days per page). */
export const KH_LATEST_PAGES = 3

const MB = 1024 * 1024
const NON_PLATFORM_SLUGS = new Set(['album', 'browse', 'publisher', 'developer', 'composer', 'year', 'gamerips', 'ost', 'singles', 'arrangements', 'remixes', 'compilations', 'inspired-by'])

// ---------------------------------------------------------------------------
// URLs

export function albumUrl(slug: string): string {
  return `${KH_BASE}/game-soundtracks/album/${slug}`
}

/** Locator = '<album slug>/<file segment exactly as linked (double-encoded)>'. */
export function trackPageUrl(locator: string): string {
  const i = locator.indexOf('/')
  if (i <= 0) throw new NetError('parse', `bad KHInsider locator: ${locator}`)
  return `${KH_BASE}/game-soundtracks/album/${locator.slice(0, i)}/${locator.slice(i + 1)}`
}

export function sectionUrl(key: string, page: number): string {
  if (key === 'latest') return page <= 1 ? `${KH_BASE}/` : `${KH_BASE}/?page=${page}`
  const m = /^letter:(.+)$/.exec(key)
  if (!m) throw new Error(`unknown KHInsider index section ${key}`)
  const base = `${KH_BASE}/game-soundtracks/browse/${encodeURIComponent(m[1])}`
  return page <= 1 ? base : `${base}?page=${page}&orderby=name&orderdirection=ASC`
}

export function searchUrl(q: string): string {
  return `${KH_BASE}/search?search=${encodeURIComponent(q).replace(/%20/g, '+')}`
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Stable engine cache key for a KHInsider file: 'kh:<slug>/<decoded file stem>.<fmt>'. */
export function khCacheKey(locator: string, format: AudioFormat): string {
  const i = locator.indexOf('/')
  const slug = locator.slice(0, i)
  const file = safeDecode(safeDecode(locator.slice(i + 1)))
  const stem = file.replace(/\.[a-z0-9]{2,5}$/i, '')
  return `kh:${slug}/${stem}.${format}`
}

export function slugFromHref(href: string | undefined | null): string | null {
  if (!href) return null
  const m = /^(?:https?:\/\/[^/]+)?\/game-soundtracks\/album\/([^/?#]+)/.exec(href)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Small parsers

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

/** "Mar 15th, 2024" / "October 14th, 2026" → epoch ms (UTC midnight). */
export function parseKhDate(s: string | null | undefined): number | null {
  if (!s) return null
  const m = /([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s)
  if (!m) return null
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()]
  if (mon === undefined) return null
  return Date.UTC(Number(m[3]), mon, Number(m[2]))
}

/** "6:14" / "1:02:03" → ms. */
export function parseClock(s: string | null | undefined): number | null {
  if (!s) return null
  const m = /^\s*(?:(\d+):)?(\d+):(\d{2})\s*$/.exec(s)
  if (!m) return null
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000
}

/** "11.98 MB" / "2,566 MB" / "900 KB" → bytes (KHInsider uses binary units). */
export function parseSize(s: string | null | undefined): number | null {
  if (!s) return null
  const m = /([\d.,]+)\s*(KB|MB|GB|B)\b/i.exec(s)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const unit = m[2].toUpperCase()
  const mult = unit === 'GB' ? 1024 * MB : unit === 'MB' ? MB : unit === 'KB' ? 1024 : 1
  return Math.round(n * mult)
}

export function parseFormatLabel(s: string): AudioFormat {
  const l = s.trim().toLowerCase()
  if (l === 'mp3') return 'mp3'
  if (l === 'flac') return 'flac'
  if (l === 'ogg' || l === 'vorbis') return 'ogg'
  if (l === 'm4a' || l === 'alac') return 'm4a'
  if (l === 'aac') return 'aac'
  if (l === 'opus') return 'opus'
  if (l === 'wav') return 'wav'
  return 'unknown'
}

export function formatFromUrl(url: string): AudioFormat {
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)
  return m ? parseFormatLabel(m[1]) : 'unknown'
}

/** Map KHInsider's "Album type" to our AlbumKind. Untyped albums are guessed from the title. */
export function mapKhType(label: string | null | undefined, titleOrSlug = ''): AlbumKind {
  const l = (label ?? '').trim().toLowerCase()
  if (l.startsWith('gamerip')) return 'gamerip'
  if (l.startsWith('soundtrack')) return 'ost'
  if (l.startsWith('arrange')) return 'arrange'
  if (l.startsWith('remix')) return 'remix'
  if (l.startsWith('single')) return 'single'
  if (l.startsWith('compilation')) return 'compilation'
  if (l.startsWith('inspired')) return 'other'
  if (l) return 'other'
  const t = titleOrSlug.toLowerCase()
  if (/game ?rip|\brip\b/.test(t)) return 'gamerip'
  if (/remix/.test(t)) return 'remix'
  if (/arrange/.test(t)) return 'arrange'
  return 'ost'
}

const SLUG_NOISE = new Set([
  'gamerip', 'rip', 'ost', 'soundtrack', 'original',
  'gba', 'gb', 'gbc', 'nds', 'ds', '3ds', 'nes', 'snes', 'n64', 'gc', 'wii', 'switch', 'psp', 'vita', 'ps1', 'ps2', 'ps3', 'ps4', 'ps5',
  'pc', 'windows', 'macos', 'mac', 'linux', 'android', 'ios', 'mobile', 'steam', 'xbox', 'arcade', 'genesis', 'saturn', 'dreamcast'
])

/** Best-effort title from a slug ('disneys-little-einsteins-gba-gamerip-2006' → 'Disneys Little Einsteins'). */
export function titleFromSlug(slug: string): string {
  const words = safeDecode(slug).split(/[-_]+/).filter(Boolean)
  while (words.length > 1 && (/^(19|20)\d\d$/.test(words[words.length - 1]) || SLUG_NOISE.has(words[words.length - 1].toLowerCase()))) words.pop()
  return words.map((w) => (w.length <= 2 && /^[ivx]+$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ')
}

/** Upgrade a listing thumbnail (…/thumbs_small/x.jpg) to the full-size image (…/x.jpg). */
export function coverFromThumb(thumb: string | null): string | null {
  if (!thumb) return null
  return thumb.replace(/\/thumbs(?:_small)?\//, '/')
}

function cleanText(s: string): string {
  return s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

function absUrl(href: string | undefined): string | null {
  if (!href) return null
  try {
    return new URL(href, KH_BASE).toString()
  } catch {
    return null
  }
}

const NON_LATIN = /[\u0400-\u04ff\u0370-\u03ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff66-\uff9f]/

// ---------------------------------------------------------------------------
// Composer heuristics (KHInsider has no structured composer field on most pages; credits live in
// the free-text description).

const COMPOSER_LINE = [
  /^(?:music\s+)?compos(?:er|ers|ed)(?:\s*\(s\))?(?:\s+by)?\s*[:：]?\s*(.*)$/i,
  /^music\s+(?:by|composed\s+by|written\s+by|&\s*arrangements?\s+by)\s*[:：]?\s*(.*)$/i,
  /^(?:original\s+)?music\s*[:：]\s*(.*)$/i,
  /^(?:作曲|作曲者|音楽)\s*[:：]\s*(.*)$/
]

function splitNames(s: string): string[] {
  return s
    .replace(/\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, ' ')
    .split(/\s*(?:,|、|;|\/|&|＆|・|\band\b|\bwith\b)\s*/i)
    .map((n) => n.replace(/\s+/g, ' ').trim().replace(/\s*[*※]+$/, ''))
    .filter((n) => n.length >= 2 && n.length <= 40 && !/\d\.\d|^\d+$|https?:/i.test(n) && /\p{L}/u.test(n))
}

export function extractComposers(description: string | null | undefined): string[] {
  if (!description) return []
  const lines = description.split(/\r?\n/).map((l) => l.trim())
  const out: string[] = []
  const seen = new Set<string>()
  const push = (names: string[]) => {
    for (const n of names) {
      const k = n.toLowerCase()
      if (!seen.has(k)) {
        seen.add(k)
        out.push(n)
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    for (const re of COMPOSER_LINE) {
      const m = re.exec(lines[i])
      if (!m) continue
      const rest = m[1].trim()
      if (rest) push(splitNames(rest))
      else {
        // "Music:" followed by one name per line until a blank line or the next heading.
        for (let j = i + 1; j < lines.length && j < i + 25; j++) {
          const l = lines[j]
          if (!l || /[:：]$/.test(l) || /^=/.test(l)) break
          push(splitNames(l).slice(0, 1))
        }
      }
      break
    }
  }
  return out.slice(0, 12)
}

// ---------------------------------------------------------------------------
// Listings

function parsePlatformLinks($: CheerioAPI, el: Parameters<CheerioAPI>[0]): PlatformRef[] {
  const out: PlatformRef[] = []
  $(el)
    .find('a[href]')
    .each((_, a) => {
      const m = /^\/game-soundtracks\/([a-z0-9-]+)\/?$/i.exec($(a).attr('href') ?? '')
      if (!m || NON_PLATFORM_SLUGS.has(m[1])) return
      const name = cleanText($(a).text())
      if (name && !out.some((p) => p.slug === m[1])) out.push({ slug: m[1].toLowerCase(), name })
    })
  return out
}

/** Platform links in a listing cell (the tree-walking twin of parsePlatformLinks). */
function platformLinks(cell: DomNode | undefined): PlatformRef[] {
  const out: PlatformRef[] = []
  for (const a of findAll(cell, linkWithHref)) {
    const m = /^\/game-soundtracks\/([a-z0-9-]+)\/?$/i.exec(a.attribs?.href ?? '')
    if (!m || NON_PLATFORM_SLUGS.has(m[1])) continue
    const name = cleanText(textOf(a))
    if (name && !out.some((p) => p.slug === m[1])) out.push({ slug: m[1].toLowerCase(), name })
  }
  return out
}

const albumLink = (e: DomNode) => e.name === 'a' && (e.attribs?.href ?? '').includes('/game-soundtracks/album/')

// Walks the parsed tree directly (see html.ts): ~500 rows per letter page.
function parseAlbumListTable(table: DomNode, addedAt: number | null): AlbumHit[] {
  const rows = findAll(table, tag('tr'))
  let col = { title: 1, platform: 2, type: 3, year: 4 }
  const header = rows.find((r) => childElements(r, 'th').length > 0)
  if (header) {
    const labels = childElements(header, 'th').map((th) => cleanText(textOf(th)).toLowerCase())
    const find = (re: RegExp, d: number) => {
      const i = labels.findIndex((l) => re.test(l))
      return i >= 0 ? i : d
    }
    col = { title: find(/album/, 1), platform: find(/platform/, 2), type: find(/type/, 3), year: find(/year/, 4) }
  }
  const out: AlbumHit[] = []
  for (const r of rows) {
    const tds = childElements(r, 'td')
    if (tds.length < 3) continue
    let slug: string | null = null
    for (const a of findAll(r, linkWithHref)) {
      slug = slugFromHref(a.attribs?.href)
      if (slug) break
    }
    if (!slug) continue
    const titleCell = tds[col.title]
    const catalog = /\[([^\]]+)\]/.exec(cleanText(findAll(titleCell, tag('span')).map(textOf).join('')))
    const titleText = cleanText(textOf(findFirst(titleCell, albumLink)))
    const thumb = absUrl(findFirst(tds[0], tag('img'))?.attribs?.src) ?? null
    const typeLabel = cleanText(textOf(tds[col.type])) || null
    const yearM = /\b(\d{4})\b/.exec(cleanText(textOf(tds[col.year])))
    const title = titleText || titleFromSlug(slug)
    out.push({
      provider: KH_ID,
      ref: slug,
      title,
      titleFromRef: !titleText,
      platforms: platformLinks(tds[col.platform]),
      kind: mapKhType(typeLabel, `${title} ${slug}`),
      typeLabel,
      year: yearM ? Number(yearM[1]) : null,
      thumb,
      cover: coverFromThumb(thumb),
      catalogNo: catalog ? catalog[1].trim() : null,
      addedAt
    })
  }
  return out
}

function parsePagination($: CheerioAPI): { page: number; totalPages: number; totalAlbums: number | null } {
  const counter = cleanText($('.pagination .counter').first().text())
  const m = /Page\s+(\d+)\s+of\s+(\d+)/i.exec(counter)
  const found = /Found\s+([\d,]+)\s+(?:matching\s+)?albums/i.exec($('#pageContent').text())
  return {
    page: m ? Number(m[1]) : 1,
    totalPages: m ? Number(m[2]) : 1,
    totalAlbums: found ? Number(found[1].replace(/,/g, '')) : null
  }
}

function assertNotBlockedLooking($: CheerioAPI): void {
  if (!$('#pageContent').length) throw new NetError('parse', 'unexpected KHInsider page layout (no #pageContent)')
}

/** Letter index page (and any other plain album listing). */
export function parseBrowsePage(html: string): IndexPage {
  const $ = loadHtml(html)
  assertNotBlockedLooking($)
  const items: AlbumHit[] = []
  $('table.albumList').each((_, t) => {
    items.push(...parseAlbumListTable(t as DomNode, null))
  })
  const p = parsePagination($)
  return { items: dedupeHits(items), ...p }
}

/** Home page "Latest Soundtracks": rows carry the date they were added. */
export function parseLatestPage(html: string): IndexPage {
  const $ = loadHtml(html)
  assertNotBlockedLooking($)
  const items: AlbumHit[] = []
  let current: number | null = null
  $('#pageContent')
    .find('h3.latestSoundtrackHeading, table.albumList')
    .each((_, el) => {
      if ($(el).is('h3')) current = parseKhDate($(el).text())
      else items.push(...parseAlbumListTable(el as DomNode, current))
    })
  const p = parsePagination($)
  return { items: dedupeHits(items), ...p }
}

export function parseSearchPage(html: string): AlbumHit[] {
  return parseBrowsePage(html).items
}

function dedupeHits(items: AlbumHit[]): AlbumHit[] {
  const seen = new Set<string>()
  return items.filter((h) => (seen.has(h.ref) ? false : (seen.add(h.ref), true)))
}

// ---------------------------------------------------------------------------
// Album page

function htmlLines($: CheerioAPI, el: Parameters<CheerioAPI>[0]): string[] {
  const html = $(el).html() ?? ''
  return html.split(/<br\s*\/?>/i).map((frag) => frag)
}

function textOfFragment(frag: string): string {
  return cleanText(fragmentText(frag))
}

export function parseAlbumPage(html: string, slug: string): ProviderAlbum {
  const $ = loadHtml(html)
  const content = $('#pageContent')
  if (!content.length) throw new NetError('parse', 'unexpected KHInsider album page layout (no #pageContent)')
  const h2 = cleanText(content.find('h2').first().text())
  if (/^ooops/i.test(h2) || /No such album/i.test(cleanText(content.text()).slice(0, 400))) {
    throw new NetError('not_found', `KHInsider has no album "${slug}"`)
  }
  if (!h2) throw new NetError('parse', `no title on KHInsider album page ${slug}`)

  // Alternative titles (one per line).
  const altTitles: string[] = []
  content.find('p.albuminfoAlternativeTitles').each((_, p) => {
    for (const frag of htmlLines($, p)) {
      const t = textOfFragment(frag)
      if (t && t !== h2 && !altTitles.includes(t)) altTitles.push(t)
    }
  })

  // Info paragraph: label/value lines separated by <br>.
  const info = content
    .find('p')
    .filter((_, p) => /Platforms:|Album type:|Number of Files:|Year:/i.test($(p).text()))
    .first()
  let platforms: PlatformRef[] = []
  let year: number | null = null
  let catalogNo: string | null = null
  let typeLabel: string | null = null
  let addedAt: number | null = null
  const developers: string[] = []
  const publishers: string[] = []
  let infoComposers: string[] = []
  const totalSizes: Partial<Record<AudioFormat, number>> = {}
  for (const frag of htmlLines($, info)) {
    const text = textOfFragment(frag)
    const m = /^([A-Za-z ()]+?)\s*:\s*(.*)$/.exec(text)
    if (!m) continue
    const label = m[1].toLowerCase()
    const value = m[2].trim()
    const $f = loadHtml(`<div>${frag}</div>`)
    const links = $f('a')
      .toArray()
      .map((a) => cleanText($f(a).text()))
      .filter(Boolean)
    if (label === 'platforms' || label === 'platform') platforms = parsePlatformLinks($f, $f('div'))
    else if (label === 'year') year = /\d{4}/.test(value) ? Number(/\d{4}/.exec(value)![0]) : null
    else if (label === 'catalog number') catalogNo = value && !/^n\/?a$/i.test(value) ? value : null
    else if (label === 'developed by') developers.push(...(links.length ? links : value.split(/\s*,\s*/)).filter(Boolean))
    else if (label === 'published by') publishers.push(...(links.length ? links : value.split(/\s*,\s*/)).filter(Boolean))
    else if (/^compos(ed by|ers?)$/.test(label)) infoComposers = (links.length ? links : value.split(/\s*,\s*/)).filter(Boolean)
    else if (label === 'album type') typeLabel = value || null
    else if (label === 'date added') addedAt = parseKhDate(value)
    else if (label === 'total filesize') {
      const re = /([\d.,]+\s*[KMG]?B)\s*\(([A-Za-z0-9]+)\)/gi
      let sm: RegExpExecArray | null
      while ((sm = re.exec(value))) {
        const fmt = parseFormatLabel(sm[2])
        const b = parseSize(sm[1])
        if (fmt !== 'unknown' && b !== null) totalSizes[fmt] = b
      }
    }
  }

  // Images: full-size link + thumbnail.
  const images: string[] = []
  let thumb: string | null = null
  content.find('.albumImage').each((_, d) => {
    const full = absUrl($(d).find('a').attr('href'))
    const small = absUrl($(d).find('img').attr('src'))
    if (full && !images.includes(full)) images.push(full)
    thumb ??= small
  })

  // Description (credits live here).
  let description: string | null = null
  content.find('h2').each((_, h) => {
    if (description === null && /^description$/i.test(cleanText($(h).text()))) {
      const p = $(h).nextAll('p').first()
      if (p.length) {
        const lines = htmlLines($, p).map(textOfFragment)
        description = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() || null
      }
    }
  })

  const tracks = parseSongList($, slug)
  const formats: AudioFormat[] = []
  for (const t of tracks) for (const f of t.files) if (!formats.includes(f.format)) formats.push(f.format)
  for (const f of Object.keys(totalSizes) as AudioFormat[]) if (!formats.includes(f)) formats.push(f)

  const idm = /\/cp\/add_album\/(\d+)/.exec(html)
  const composers = infoComposers.length ? infoComposers : extractComposers(description)
  const titleOriginal = altTitles.find((t) => NON_LATIN.test(t)) ?? null
  return {
    provider: KH_ID,
    ref: slug,
    title: h2,
    titleFromRef: false,
    platforms,
    kind: mapKhType(typeLabel, `${h2} ${slug}`),
    typeLabel,
    year,
    thumb,
    cover: images[0] ?? null,
    catalogNo,
    addedAt,
    altTitles,
    titleOriginal,
    developers,
    publishers,
    composers,
    images,
    description,
    formats,
    totalSizes,
    externalId: idm ? idm[1] : null,
    tracks
  }
}

const hasClass = (e: DomNode, c: string) => (e.attribs?.class ?? '').split(/\s+/).includes(c)

// Walks the parsed tree directly (see html.ts): up to a few hundred rows.
function parseSongList($: CheerioAPI, slug: string): ProviderTrack[] {
  const tables = $('#songlist').toArray() as DomNode[]
  if (!tables.length) return []
  const rows = tables.flatMap((t) => findAll(t, tag('tr')))
  // Expand header colspans into one label per cell.
  const labels: string[] = []
  const header = rows.find((r) => r.attribs?.id === 'songlist_header')
  for (const th of childElements(header, 'th')) {
    const span = Math.max(1, Number(th.attribs?.colspan ?? 1) || 1)
    const l = cleanText(textOf(th)).toLowerCase()
    for (let i = 0; i < span; i++) labels.push(l)
  }
  const discCol = labels.indexOf('cd')
  const numCol = labels.indexOf('#')
  const nameCol = labels.indexOf('song name')
  const formatCols: { index: number; format: AudioFormat }[] = []
  labels.forEach((l, i) => {
    const f = parseFormatLabel(l)
    if (f !== 'unknown') formatCols.push({ index: i, format: f })
  })

  const own = new RegExp(`/game-soundtracks/album/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.+)$`)
  const out: ProviderTrack[] = []
  const perDisc = new Map<number, number>()
  for (const tr of rows) {
    const id = tr.attribs?.id
    if (id === 'songlist_header' || id === 'songlist_footer') continue
    const tds = childElements(tr, 'td')
    if (!tds.length) continue
    // Title cell: the first clickable cell linking to a track page.
    let titleIdx = nameCol >= 0 && nameCol < tds.length ? nameCol : -1
    if (titleIdx < 0 || !findFirst(tds[titleIdx], linkWithHref)) {
      titleIdx = tds.findIndex((td) => hasClass(td, 'clickable-row') && !!findFirst(td, linkWithHref))
    }
    if (titleIdx < 0) continue
    const a = findFirst(tds[titleIdx], linkWithHref)!
    const href = a.attribs?.href ?? ''
    const m = own.exec(href) ?? /\/game-soundtracks\/album\/[^/]+\/(.+)$/.exec(href)
    if (!m) continue
    const title = cleanText(textOf(a))
    const durationMs = parseClock(textOf(tds[titleIdx + 1]))
    const disc = discCol >= 0 ? Number(cleanText(textOf(tds[discCol]))) || 1 : 1
    const n = numCol >= 0 ? parseInt(cleanText(textOf(tds[numCol])), 10) : NaN
    const seq = (perDisc.get(disc) ?? 0) + 1
    perDisc.set(disc, seq)
    const files: ProviderTrackFile[] = formatCols.length
      ? formatCols.map((c) => ({ format: c.format, sizeBytes: parseSize(textOf(tds[c.index])) }))
      : [{ format: formatFromUrl(href), sizeBytes: parseSize(textOf(tds[titleIdx + 2])) }]
    out.push({
      disc,
      number: Number.isFinite(n) && n > 0 ? n : seq,
      title: title || safeDecode(safeDecode(m[1])).replace(/\.[a-z0-9]+$/i, ''),
      durationMs,
      locator: `${slug}/${m[1]}`,
      files,
      composers: []
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Track page

export interface TrackPageFile {
  format: AudioFormat
  url: string
  sizeBytes: number | null
}

export function parseTrackPage(html: string): TrackPageFile[] {
  const $ = loadHtml(html)
  const out: TrackPageFile[] = []
  $('a[href]').each((_, a) => {
    if (!$(a).find('.songDownloadLink').length) return
    const url = absUrl($(a).attr('href'))
    if (!url) return
    const label = /download as\s+([A-Za-z0-9]+)/i.exec($(a).text())
    let format = formatFromUrl(url)
    if (format === 'unknown' && label) format = parseFormatLabel(label[1])
    const size = /\(([\d.,]+\s*[KMG]?B)\)/i.exec($(a).parent().text())
    if (!out.some((f) => f.url === url)) out.push({ format, url, sizeBytes: parseSize(size?.[1]) })
  })
  if (!out.length) {
    const src = absUrl($('audio#audio').attr('src') ?? $('audio').first().attr('src'))
    if (src) out.push({ format: formatFromUrl(src), url: src, sizeBytes: null })
  }
  if (!out.length) {
    if (/No such (album|song)/i.test($('#pageContent').text())) throw new NetError('not_found', 'KHInsider track page not found')
    throw new NetError('parse', 'no audio links on KHInsider track page')
  }
  return out
}

// ---------------------------------------------------------------------------
// Provider

export class KhinsiderProvider implements IndexProvider {
  readonly id = KH_ID
  readonly name = 'KHInsider'

  /** A stream is one track-page request away: resolved ahead of a likely play (see SourceResolver.prefetch). */
  readonly prefetchStreams = true

  constructor(private http: HttpClient) {}

  /** A full first read of the index (for the setup time estimate). */
  readonly indexEstimateMs = 7 * 60_000

  indexSections(): IndexSection[] {
    return [
      { key: 'latest', label: 'Latest additions', maxPages: KH_LATEST_PAGES },
      ...KH_LETTERS.map((l) => ({ key: `letter:${l}`, label: l === '0-9' ? '#' : l }))
    ]
  }

  async fetchIndexPage(sectionKey: string, page: number, opts: ProviderCallOptions = {}): Promise<IndexPage> {
    const url = sectionUrl(sectionKey, page)
    const r = await this.http.pageFetch(url, { ttlMs: TTL.browse, priority: opts.priority ?? 2, force: opts.force, signal: opts.signal })
    try {
      return sectionKey === 'latest' ? parseLatestPage(r.html) : parseBrowsePage(r.html)
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

  async resolveStream(locator: string, opts: ProviderCallOptions = {}): Promise<StreamInfo[]> {
    const r = await this.http.pageFetch(trackPageUrl(locator), { ttlMs: 0, cache: false, allowStale: false, priority: opts.priority ?? 0, signal: opts.signal })
    return parseTrackPage(r.html).map((f) => ({
      provider: KH_ID,
      source: {
        kind: 'http' as const,
        url: f.url,
        cacheKey: khCacheKey(locator, f.format),
        headers: { Referer: KH_REFERER },
        formatHint: f.format
      },
      format: f.format,
      lossless: LOSSLESS_FORMATS.has(f.format),
      bitrateKbps: null,
      sizeBytes: f.sizeBytes,
      expiresAt: null
    }))
  }
}
