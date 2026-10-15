// Chiptune rip archives (DESIGN §6.2 #2): original sound-chip music (NSF, SPC, GBS, HES, KSS,
// VGM/VGZ) that the engine emulates straight out of the rip set's archive, with real loop points.
//
// Sources (structures verified 2026-10):
//  - joshw.info (HCS64), one subdomain per format: nsf. spc. gbs. hes. kss. Apache autoindex
//    listings; the root holds letter directories (0-9/, a/ … z/, zzz_prototypes/, zzz_unlicensed/;
//    kss. has a system level first: MSX/, Master System/, Game Gear/) with one .7z per game:
//      `Title [Alt Title] (YYYY-MM-DD)(Developer)(Publisher)[System][extra].7z`
//      (kss.: `Title (System)(YYYY)(Developer)(Publisher).7z`)
//    Sets ship NEZPlug .m3u playlists (sub-song, title, length, fade). Not indexed: spc. [SNSF]
//    and hes. [TCD]/[PC-FX] sets (PSF / CD audio), and the other subdomains (wii. gcn. pc. switch.
//    psf. 2sf. …): streamed audio or PSF-family rips in 100 MB–GB archives the engine would have
//    to download whole before listing them.
//    Note: joshw's robots.txt disallows all crawling. We only read the letter listings (a few
//    hundred small pages a month, one request at a time, cached) and fetch an archive only when
//    the user opens that album.
//  - vgmrips.net: VGM packs. /packs/latest?p=N lists every pack (20 per page): title, zip URL,
//    song count, size, chips, systems, developers, publishers, composers. A pack page
//    (/packs/pack/<slug>) lists each track: file, title, "total + loop" time. libgme only emulates
//    SN76489 / YM2612 / YM3438 / YM2413 VGMs, so packs using any other chip are skipped.
//
// Indexing reads listings only. `getAlbum` lists the archive with the engine's `inspectArchive`
// (which fetches it once into the stream cache) and builds one track per playlist line or file;
// every track's source is the archive plus an entry and sub-song, so it resolves offline.
//
// Album refs: '<host><path>' of the joshw archive ('spc.joshw.info/c/Chrono%20Trigger%20…7z') or
// of the vgmrips pack page ('vgmrips.net/packs/pack/<slug>').
// Track locators: '<archive url>#e=<entry>&s=<sub-song>' (see `chipLocator`).

import { loadHtml } from './html'
import { foldText } from '../../shared/search'
import type { ArchiveListing, EngineSource } from '../engine/types'
import { NetError } from '../net/errors'
import type { HttpClient } from '../net/http'
import type { AlbumHit, PlatformRef, Provider, ProviderAlbum, ProviderCallOptions, ProviderTrack, StreamInfo } from './types'

export const CHIP_ID = 'chip'
export const VGMRIPS_HOST = 'vgmrips.net'
export const VGMRIPS_BASE = `https://${VGMRIPS_HOST}`
/** Rip sets bigger than this are left out of the index (chip sets are KB-sized; big ones are CD audio). */
export const CHIP_MAX_SET_BYTES = 32 * 1024 * 1024
/** Listing pages change slowly. */
const LISTING_TTL_MS = 24 * 3600_000
const PACK_TTL_MS = 7 * 24 * 3600_000
/** The engine's default fade (Album loop mode) when a playlist line has a length but no fade. */
const DEFAULT_FADE_MS = 10_000

// ---------------------------------------------------------------------------
// Systems

export interface ChipSystem {
  /** Short label for album titles: 'SNES', 'Game Boy', 'Master System'. */
  label: string
  /** Catalog platform (KHInsider's slug and name where KHInsider has one). */
  platform: PlatformRef
}

const sys = (label: string, slug: string, name = label): ChipSystem => ({ label, platform: { slug, name } })

const SYSTEMS: Record<string, ChipSystem> = {
  nes: sys('NES', 'nintendo-nes'),
  'nintendo entertainment system': sys('NES', 'nintendo-nes'),
  fc: sys('Famicom', 'family-computer', 'Family Computer'),
  'family computer': sys('Famicom', 'family-computer', 'Family Computer'),
  fds: sys('Famicom Disk System', 'famicom-disk-system', 'FDS'),
  'famicom disk system': sys('Famicom Disk System', 'famicom-disk-system', 'FDS'),
  vs: sys('VS. System', 'arcade', 'Arcade'),
  pc10: sys('PlayChoice-10', 'arcade', 'Arcade'),
  snes: sys('SNES', 'nintendo-snes'),
  'super nintendo': sys('SNES', 'nintendo-snes'),
  'super famicom': sys('SNES', 'nintendo-snes'),
  gb: sys('Game Boy', 'gameboy', 'GB'),
  'game boy': sys('Game Boy', 'gameboy', 'GB'),
  sgb: sys('Super Game Boy', 'gameboy', 'GB'),
  gbc: sys('Game Boy Color', 'gameboy-color', 'GBC'),
  'game boy color': sys('Game Boy Color', 'gameboy-color', 'GBC'),
  pce: sys('PC Engine', 'turbografx-16', 'TurboGrafx-16'),
  'pc engine': sys('PC Engine', 'turbografx-16', 'TurboGrafx-16'),
  'turbografx-16': sys('TurboGrafx-16', 'turbografx-16'),
  sgx: sys('SuperGrafx', 'supergrafx'),
  supergrafx: sys('SuperGrafx', 'supergrafx'),
  msx: sys('MSX', 'msx'),
  msx2: sys('MSX2', 'msx2'),
  'msx2+': sys('MSX2+', 'msx2', 'MSX2'),
  'msx turbo r': sys('MSX turbo R', 'msx2', 'MSX2'),
  sms: sys('Master System', 'sega-master-system'),
  'master system': sys('Master System', 'sega-master-system'),
  'mark iii': sys('Master System', 'sega-master-system'),
  gg: sys('Game Gear', 'sega-game-gear'),
  'game gear': sys('Game Gear', 'sega-game-gear'),
  'sg-1000': sys('SG-1000', 'sg-1000'),
  'sc-3000': sys('SC-3000', 'sg-1000', 'SG-1000'),
  md: sys('Mega Drive', 'sega-mega-drive-genesis', 'Genesis'),
  'mega drive': sys('Mega Drive', 'sega-mega-drive-genesis', 'Genesis'),
  genesis: sys('Genesis', 'sega-mega-drive-genesis', 'Genesis'),
  'mega drive / genesis': sys('Mega Drive', 'sega-mega-drive-genesis', 'Genesis'),
  'sega cd': sys('Sega CD', 'sega-cd'),
  'mega cd': sys('Mega CD', 'sega-cd', 'Sega CD'),
  '32x': sys('32X', 'sega-32x'),
  'sega pico': sys('Pico', 'sega-pico'),
  'arcade machine': sys('Arcade', 'arcade'),
  arcade: sys('Arcade', 'arcade'),
  colecovision: sys('ColecoVision', 'colecovision'),
  'neo geo pocket': sys('Neo Geo Pocket', 'neo-geo-pocket'),
  'bbc micro': sys('BBC Micro', 'bbc-micro'),
  'pc/at': sys('PC', 'ibm-pc', 'IBM PC'),
  'ibm pc': sys('PC', 'ibm-pc', 'IBM PC'),
  'tandy 1000': sys('Tandy 1000', 'ibm-pc', 'IBM PC'),
  'pc-9801': sys('PC-98', 'pc-9801', 'PC-98'),
  'pc-8801': sys('PC-88', 'pc-8801', 'PC-88'),
  x68000: sys('X68000', 'x68000'),
  'fm towns': sys('FM Towns', 'fm-towns')
}

function slugify(s: string): string {
  return foldText(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** A joshw system tag ('SNES', 'GBC', 'SMS') or a vgmrips system name ('Mega Drive') → ChipSystem. */
export function chipSystem(name: string | null | undefined): ChipSystem | null {
  const n = (name ?? '').trim()
  if (!n) return null
  const known = SYSTEMS[n.toLowerCase()]
  if (known) return known
  return sys(n, slugify(n) || 'other', n)
}

// ---------------------------------------------------------------------------
// Sources

export interface JoshwSource {
  host: string
  /** Rip format, shown in album titles ('NSF rip'). */
  format: 'NSF' | 'SPC' | 'GBS' | 'HES' | 'KSS'
  /** System tags of sets that aren't chip rips the engine plays (PSF family, CD audio). */
  skipTags: string[]
  /** System when a set names none. */
  defaultSystem: string
}

export const JOSHW_SOURCES: JoshwSource[] = [
  { host: 'nsf.joshw.info', format: 'NSF', skipTags: [], defaultSystem: 'NES' },
  { host: 'spc.joshw.info', format: 'SPC', skipTags: ['SNSF'], defaultSystem: 'SNES' },
  { host: 'gbs.joshw.info', format: 'GBS', skipTags: ['GSF'], defaultSystem: 'GB' },
  { host: 'hes.joshw.info', format: 'HES', skipTags: ['TCD', 'PC-FX', 'PCFX', 'SCD', 'CD', 'ACD'], defaultSystem: 'PCE' },
  { host: 'kss.joshw.info', format: 'KSS', skipTags: [], defaultSystem: 'MSX' }
]

export function joshwSource(host: string): JoshwSource | null {
  return JOSHW_SOURCES.find((s) => s.host === host.toLowerCase()) ?? null
}

/** vgmrips chip slugs libgme's VGM player emulates (SN76489 PSG family, YM2612/YM3438, YM2413). */
export const VGM_PLAYABLE_CHIPS = new Set(['sn76489', 'sega-vdp-psg', 'ncr8496', 'ym2612', 'ym3438', 'ym2413', 'opll-ym2413'])

/** One rip set (an archive of one game's music) as listed by a source. */
export interface ChipSet {
  source: 'joshw' | 'vgmrips'
  /** Album provider_ref. */
  ref: string
  /** The .7z / .zip to fetch, when the listing names it. */
  archiveUrl: string | null
  /** Game title ("The Legend of Zelda - A Link to the Past"). */
  title: string
  altTitles: string[]
  system: ChipSystem | null
  /** 'NSF', 'SPC', 'VGM', … */
  format: string
  year: number | null
  /** Extra descriptors for the album title: 'JP', 'Prototype', 'alt'. */
  variant: string[]
  sizeBytes: number | null
  trackCount: number | null
  developers: string[]
  publishers: string[]
  composers: string[]
  cover: string | null
  thumb: string | null
}

/** "Chrono Trigger (SNES SPC rip)", "Mega Man 6 (NES NSF rip, JP)". */
export function chipAlbumTitle(s: Pick<ChipSet, 'title' | 'system' | 'format' | 'variant'>): string {
  const what = [s.system?.label, s.format].filter(Boolean).join(' ')
  return `${s.title} (${what} rip${s.variant.length ? `, ${s.variant.join(', ')}` : ''})`
}

export function chipAlbumHit(s: ChipSet): AlbumHit {
  return {
    provider: CHIP_ID,
    ref: s.ref,
    title: chipAlbumTitle(s),
    titleFromRef: false,
    platforms: s.system ? [s.system.platform] : [],
    kind: 'gamerip',
    typeLabel: `${s.format} rip`,
    year: s.year,
    thumb: s.thumb ?? s.cover,
    cover: s.cover,
    catalogNo: null,
    addedAt: null
  }
}

// ---------------------------------------------------------------------------
// Apache directory listings (joshw)

export interface DirEntry {
  /** The href as linked (percent-encoded, relative). */
  href: string
  /** Decoded file or directory name (no trailing '/'). */
  name: string
  dir: boolean
  sizeBytes: number | null
  modified: number | null
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** "285K" / "1.1G" / "972" → bytes. */
export function parseListingSize(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([KMGT])?$/i.exec(s.trim())
  if (!m) return null
  const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[(m[2] ?? '').toUpperCase() as 'K'] ?? 1
  return Math.round(Number(m[1]) * mult)
}

/** Rows of an Apache autoindex page (`<pre>` style), minus the parent link and sort links. */
export function parseApacheListing(html: string): DirEntry[] {
  const out: DirEntry[] = []
  const re = /<a href="([^"]+)">([^<]*)<\/a>\s*(\d{4}-\d\d-\d\d \d\d:\d\d)?\s*([\d.]+[KMGT]?|-)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = decodeEntities(m[1])
    if (href.startsWith('?') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('..')) continue
    const dir = href.endsWith('/')
    const name = safeDecode(dir ? href.slice(0, -1) : href)
    if (!name) continue
    const modified = m[3] ? Date.parse(`${m[3].replace(' ', 'T')}:00Z`) : NaN
    out.push({ href, name, dir, sizeBytes: m[4] && m[4] !== '-' ? parseListingSize(m[4]) : null, modified: Number.isFinite(modified) ? modified : null })
  }
  return out
}

/** Letter-level directories ("a/", "0-9/", "zzz_unlicensed/") hold sets; anything else is a grouping level (kss.: "MSX/"). */
export function isLetterDir(name: string): boolean {
  return /^(?:[a-z]|0-9|#|zzz[_ ].+)$/i.test(name)
}

// ---------------------------------------------------------------------------
// joshw set names

export interface RipSetName {
  title: string
  altTitles: string[]
  /** As written: '1988-12-24', '1995-03', '1990', '19xx'. */
  date: string | null
  year: number | null
  /** From the parentheses after the date: all but the last name developers, the last the publisher (one name: both). */
  developers: string[]
  publishers: string[]
  /** The system tag ('NES', 'SNES', 'SMS'), from the first trailing [..] or a (..) before the date. */
  systemTag: string | null
  /** Other trailing [..] tags ('alt', 'mod', 'SNSF'). */
  tags: string[]
  /** Parenthesised qualifiers before the date ('Game Genie', 'Prototype', 'Homebrew'). */
  qualifiers: string[]
  /** Region suffix of the title ('JP'). */
  region: string | null
}

const DATE_RE = /^(?:19|20)[\dx?]{2}(?:-[\dx?]{2}){0,2}$/i
const QUALIFIER_RE = /^(?:game genie|prototype|proto|beta|alpha|demo|sample|trial(?: version)?|taikenban|homebrew|unl(?:icensed)?|unreleased|pirate|hack|kiosk|bootleg|aftermarket|virtual console|e-reader|v\d[\w.]*|rev(?:ision)? ?\w+|\w+ version)$/i
const KNOWN_SYSTEM_TAGS = new Set(['nes', 'fds', 'vs', 'pc10', 'snes', 'gb', 'gbc', 'sgb', 'pce', 'sgx', 'msx', 'msx2', 'msx2+', 'sms', 'gg', 'sg-1000', 'sc-3000', 'md', 'tcd', 'pc-fx', 'pcfx', 'snsf', 'gsf'])
const REGION_RE = /\s+(JP|JPN|EU|EUR|US|USA|KR|KOR|BR|DE|FR|ES|IT|AU|CN|TW|SE|NL|AS)$/
const ARTICLES = 'The|A|An|Le|La|Les|L\'|Die|Der|Das|El|Los|Las|Il|Lo'

/** "Magic Candle, The" → "The Magic Candle"; "Legend of Zelda, The - A Link to the Past" → "The Legend of Zelda - A Link to the Past". */
export function uninvertArticle(s: string): string {
  const m = new RegExp(`^(.+?),\\s+(${ARTICLES})(?=$|\\s+[-:~]\\s|:)(.*)$`, 'i').exec(s)
  if (!m) return s
  const art = m[2].endsWith("'") ? m[2] : `${m[2]} `
  return `${art}${m[1]}${m[3]}`.trim()
}

/** Parse a joshw set file name (see the header comment for the shapes). Null if it isn't an archive. */
export function parseRipSetName(fileName: string): RipSetName | null {
  let s = fileName.trim()
  if (!/\.(7z|zip|rar)$/i.test(s)) return null
  s = s.replace(/\.(7z|zip|rar)$/i, '').trim()
  const tags: string[] = []
  let m: RegExpExecArray | null
  while ((m = /\s*\[([^[\]]*)\]$/.exec(s)) && m.index > 0) {
    tags.unshift(m[1].trim())
    s = s.slice(0, m.index)
  }
  const parens: string[] = []
  while ((m = /\s*\(([^()]*)\)$/.exec(s)) && m.index > 0) {
    parens.unshift(m[1].trim())
    s = s.slice(0, m.index)
  }
  // The first trailing tag is the system ('NES', 'SNES', 'GBC'); long ones are alternative titles.
  let systemTag: string | null = tags.length && (KNOWN_SYSTEM_TAGS.has(tags[0].toLowerCase()) || /^[A-Z0-9][A-Z0-9+-]{0,7}$/.test(tags[0])) ? tags.shift()! : null
  const altFromTags = tags.filter((t) => /\s/.test(t) || t.length > 10)
  for (const t of altFromTags) tags.splice(tags.indexOf(t), 1)
  const dateIdx = parens.findIndex((p) => DATE_RE.test(p))
  const before = dateIdx >= 0 ? parens.slice(0, dateIdx) : parens
  const after: string[] = []
  for (const p of dateIdx >= 0 ? parens.slice(dateIdx + 1) : []) {
    // "(1995-03-11)(Square)(SNES)": a system named after the companies.
    if (!systemTag && KNOWN_SYSTEM_TAGS.has(p.toLowerCase())) systemTag = p
    else after.push(p)
  }
  const qualifiers: string[] = []
  let titleTail = ''
  for (const p of before) {
    if (!systemTag && KNOWN_SYSTEM_TAGS.has(p.toLowerCase())) systemTag = p
    else if (QUALIFIER_RE.test(p)) qualifiers.push(p)
    else titleTail += ` (${p})`
  }
  const date = dateIdx >= 0 ? parens[dateIdx] : null
  const year = date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null
  const names = (p: string) => p.split(/\s*,\s*/).filter((c) => c && c !== '-')
  const developers = after.length > 1 ? after.slice(0, -1).flatMap(names) : after.flatMap(names)
  const publishers = after.length ? names(after[after.length - 1]) : []
  // Alternative titles ride in [..] inside the title part.
  const altTitles: string[] = [...altFromTags]
  let title = (s + titleTail)
    .replace(/\s*\[([^[\]]+)\]/g, (_, a: string) => {
      altTitles.push(a.trim())
      return ''
    })
    .replace(/\s+/g, ' ')
    .trim()
  let region: string | null = null
  const r = REGION_RE.exec(title)
  if (r && r.index > 0) {
    region = r[1]
    title = title.slice(0, r.index).trim()
  }
  title = uninvertArticle(title)
  if (!title) return null
  return { title, altTitles: altTitles.map(uninvertArticle).filter((a) => a && a !== title), date, year, developers, publishers, systemTag, tags, qualifiers, region }
}

/** A joshw listing row → ChipSet (null when it isn't a playable chip set). */
export function joshwSet(src: JoshwSource, dirPath: string, e: DirEntry, groupSystem: string | null = null): ChipSet | null {
  if (e.dir) return null
  const n = parseRipSetName(e.name)
  if (!n) return null
  const skip = new Set(src.skipTags.map((t) => t.toLowerCase()))
  if ([n.systemTag, ...n.tags].some((t) => t && skip.has(t.toLowerCase()))) return null
  if (e.sizeBytes != null && e.sizeBytes > CHIP_MAX_SET_BYTES) return null
  const dir = dirPath.endsWith('/') ? dirPath : `${dirPath}/`
  const path = `${dir.startsWith('/') ? '' : '/'}${dir}${e.href}`
  const variant = [n.region, ...n.qualifiers, ...n.tags].filter((x): x is string => !!x)
  return {
    source: 'joshw',
    ref: `${src.host}${path}`,
    archiveUrl: `https://${src.host}${path}`,
    title: n.title,
    altTitles: n.altTitles,
    system: chipSystem(n.systemTag ?? groupSystem ?? src.defaultSystem),
    format: src.format,
    year: n.year,
    variant,
    sizeBytes: e.sizeBytes,
    trackCount: null,
    developers: n.developers,
    publishers: n.publishers,
    composers: [],
    cover: null,
    thumb: null
  }
}

// ---------------------------------------------------------------------------
// vgmrips

/** "Journey to Silius (U, E, A) / Raf World (J)" → ["Journey to Silius", "Raf World"]. */
export function vgmripsTitles(raw: string): string[] {
  return raw
    .split(/\s+\/\s+/)
    .map((t) =>
      t
        .replace(/\s*\((?:[A-Z]{1,3}|World)(?:\s*,\s*(?:[A-Z]{1,3}|World))*\)\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
}

function textOf($: ReturnType<typeof loadHtml>, el: Parameters<ReturnType<typeof loadHtml>>[0]): string {
  return $(el).text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

function absVgmUrl(href: string | undefined): string | null {
  if (!href) return null
  try {
    return new URL(href, `${VGMRIPS_BASE}/packs/`).toString()
  } catch {
    return null
  }
}

/** "233.08 KB" → bytes. */
function parseHumanSize(s: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*([KMG])i?B/i.exec(s)
  if (!m) return null
  return Math.round(Number(m[1]) * { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase() as 'K'])
}

export interface VgmripsListing {
  packs: { set: ChipSet; chips: string[]; playable: boolean }[]
  /** 0-based page shown. */
  page: number
  totalPages: number
}

/** One page of /packs/latest (or any pack listing with the same `div.result` rows). */
export function parseVgmripsListing(html: string): VgmripsListing {
  const $ = loadHtml(html)
  const packs: VgmripsListing['packs'] = []
  $('div.result').each((_, row) => {
    const r = $(row)
    const link = r
      .find('h2 a[href*="/packs/pack/"]')
      .filter((_, a) => !($(a).attr('href') ?? '').includes('#'))
      .first()
    const href = link.attr('href')
    const slug = href ? /\/packs\/pack\/([^/?#]+)/.exec(href)?.[1] : null
    if (!slug) return
    const names = vgmripsTitles(textOf($, link))
    if (!names.length) return
    const dl = r.find('a.download').first()
    const small = textOf($, dl.find('small'))
    const songs = Number(/(\d+)\s+songs?/i.exec(small)?.[1] ?? NaN)
    const badges = (cls: string) =>
      r
        .find(`tr.${cls} a`)
        .map((_, a) => textOf($, a))
        .get()
        .filter(Boolean)
    const chips = r
      .find('tr.chips a')
      .map((_, a) => /\/packs\/chip\/([^/?#]+)/.exec($(a).attr('href') ?? '')?.[1] ?? '')
      .get()
      .filter(Boolean)
    const systems = badges('systems')
    const img = absVgmUrl(r.find('.image img').first().attr('src'))
    const system = systems.map((s) => SYSTEMS[s.toLowerCase()]).find(Boolean) ?? chipSystem(systems[0])
    packs.push({
      set: {
        source: 'vgmrips',
        ref: `${VGMRIPS_HOST}/packs/pack/${slug}`,
        archiveUrl: absVgmUrl(dl.attr('href')),
        title: names[0],
        altTitles: names.slice(1),
        system,
        format: 'VGM',
        year: null,
        variant: [],
        sizeBytes: parseHumanSize(small),
        trackCount: Number.isFinite(songs) ? songs : null,
        developers: badges('developers'),
        publishers: badges('publishers'),
        composers: badges('composers'),
        cover: img,
        thumb: img
      },
      chips,
      playable: chips.length > 0 && chips.every((c) => VGM_PLAYABLE_CHIPS.has(c))
    })
  })
  const pageNums = $('ul.pagination a[href*="p="]')
    .map((_, a) => Number(/[?&]p=(\d+)/.exec($(a).attr('href') ?? '')?.[1] ?? NaN))
    .get()
    .filter(Number.isFinite)
  const active = Number(textOf($, $('ul.pagination li.active').first())) || 1
  const totalPages = Math.max(active, ...pageNums.map((p) => p + 1), packs.length ? 1 : 0)
  return { packs, page: active - 1, totalPages }
}

export interface VgmPackTrack {
  number: number
  title: string
  /** File name inside the pack zip ('01 Title.vgz'). */
  file: string
  /** Album-mode length estimate: total + one more loop + the default fade. */
  durationMs: number | null
}

export interface VgmPack {
  title: string
  altTitles: string[]
  systems: string[]
  chips: string[]
  composers: string[]
  developers: string[]
  publishers: string[]
  year: number | null
  zipUrl: string | null
  cover: string | null
  tracks: VgmPackTrack[]
}

/** "1:19 + 1:18" → { total: 79000, loop: 78000 }. */
export function parseVgmTime(s: string): { totalMs: number; loopMs: number | null } | null {
  const parts = s.split('+').map((p) => p.trim())
  const ms = (t: string) => {
    const m = /^(?:(\d+):)?(\d+):(\d\d)$/.exec(t)
    return m ? ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : null
  }
  const total = ms(parts[0] ?? '')
  if (total == null) return null
  const loop = parts[1] ? ms(parts[1]) : null
  return { totalMs: total, loopMs: loop }
}

export function parseVgmripsPack(html: string): VgmPack {
  const $ = loadHtml(html)
  const h1 = textOf($, $('h1').first())
  if (!h1) throw new NetError('parse', 'no title on vgmrips pack page')
  const names = vgmripsTitles(h1)
  const badgeLinks = (re: RegExp) =>
    $('#beforePlaylist a')
      .filter((_, a) => re.test($(a).attr('href') ?? ''))
      .map((_, a) => textOf($, a))
      .get()
      .filter(Boolean)
  const tracks: VgmPackTrack[] = []
  $('tr[data-vgmurl]').each((i, tr) => {
    const t = $(tr)
    const url = t.attr('data-vgmurl') ?? ''
    const file = safeDecode(url.split('/').pop() ?? '')
    if (!file) return
    const title = textOf($, t.find('td.title a').first()) || file.replace(/\.[^.]+$/, '')
    const time = parseVgmTime(textOf($, t.find('td.title .time').first()))
    const dataDur = Number(t.attr('data-duration'))
    const durationMs = time ? time.totalMs + (time.loopMs ? time.loopMs + DEFAULT_FADE_MS : 0) : Number.isFinite(dataDur) && dataDur > 0 ? Math.round(dataDur * 1000) : null
    const number = Number(t.attr('data-order') ?? /\d+/.exec(textOf($, t.find('td.number')))?.[0] ?? i + 1) || i + 1
    tracks.push({ number, title, file, durationMs })
  })
  const companies = $('#beforePlaylist section.companies')
  const year = Number(/Release date:\s*((?:19|20)\d\d)/i.exec(textOf($, companies))?.[1] ?? NaN)
  const zip = $('a[href$=".zip"]')
    .map((_, a) => $(a).attr('href'))
    .get()
    .find((h) => /\/files\//.test(h))
  const pubs = companies
    .find('a[href*="/packs/company/"]')
    .filter((_, a) => ($(a).attr('href') ?? '').includes('?publisher'))
    .map((_, a) => textOf($, a))
    .get()
  const devs = companies
    .find('a[href*="/packs/company/"]')
    .filter((_, a) => !($(a).attr('href') ?? '').includes('?publisher'))
    .map((_, a) => textOf($, a))
    .get()
  return {
    title: names[0] ?? h1,
    altTitles: names.slice(1),
    systems: badgeLinks(/\/packs\/system\//),
    chips: $('#beforePlaylist a[href*="/packs/chip/"]')
      .map((_, a) => /\/packs\/chip\/([^/?#]+)/.exec($(a).attr('href') ?? '')?.[1] ?? '')
      .get()
      .filter(Boolean),
    composers: badgeLinks(/\/packs\/composer\//),
    developers: devs,
    publishers: pubs,
    year: Number.isFinite(year) ? year : null,
    zipUrl: absVgmUrl(zip),
    cover: absVgmUrl($('meta[property="og:image"]').attr('content')),
    tracks
  }
}

// ---------------------------------------------------------------------------
// NEZPlug playlists

export interface NezLine {
  file: string
  /** 'NSF', 'GBS', 'KSS', … as written. */
  type: string
  /** Track number as written; `hex` = it had a `$` prefix (hex, 0-based). */
  track: number
  hex: boolean
  title: string
  lengthMs: number | null
  /** Loop length, or (`loopIsStart`) the loop start when written with a trailing '-'. */
  loopMs: number | null
  loopIsStart: boolean
  fadeMs: number | null
  loopCount: number | null
}

/** NEZPlug time: 'h:mm:ss.fff', 'm:ss', 'ss', '0:0:40.009' → ms. */
export function parseNezTime(s: string | undefined | null): number | null {
  const t = (s ?? '').trim().replace(/-$/, '').trim()
  if (!t) return null
  if (!/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(t)) return null
  const parts = t.split(':')
  let sec = 0
  for (const p of parts) sec = sec * 60 + Number(p)
  return Number.isFinite(sec) ? Math.round(sec * 1000) : null
}

/** Split on commas that aren't escaped (`\,`), then unescape. */
export function splitNezFields(s: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length && (s[i + 1] === ',' || s[i + 1] === '\\')) {
      cur += s[++i]
      continue
    }
    if (c === ',') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out
}

const TIME_FIELD_RE = /^\s*(?:\d+(?::\d+){0,2}(?:\.\d+)?)?-?\s*$/

/** One `file::TYPE,track,title,length,loop,fade,loopcount` line, or null (comments, plain lines). */
export function parseNezLine(line: string): NezLine | null {
  const t = line.trim()
  if (!t || t.startsWith('#')) return null
  const sep = t.indexOf('::')
  if (sep <= 0) return null
  const file = t.slice(0, sep).trim().replace(/\\/g, '/')
  const fields = splitNezFields(t.slice(sep + 2))
  if (fields.length < 2) return null
  const type = fields[0].trim()
  const tf = fields[1].trim()
  let track: number
  let hex = false
  if (tf.startsWith('$')) {
    track = parseInt(tf.slice(1), 16)
    hex = true
  } else track = /^\d+$/.test(tf) ? Number(tf) : NaN
  if (!Number.isFinite(track)) return null
  const rest = fields.slice(2)
  // Timing fields are counted from the right, so a title with stray (unescaped) commas survives.
  let k = 0
  while (k < 4 && rest.length - k > 1 && TIME_FIELD_RE.test(rest[rest.length - 1 - k])) k++
  const title = rest.slice(0, rest.length - k).join(',').trim()
  const timing = rest.slice(rest.length - k)
  const loopRaw = (timing[1] ?? '').trim()
  const count = Number((timing[3] ?? '').trim())
  return {
    file,
    type,
    track,
    hex,
    title,
    lengthMs: parseNezTime(timing[0]),
    loopMs: parseNezTime(loopRaw),
    loopIsStart: loopRaw.endsWith('-'),
    fadeMs: parseNezTime(timing[2]),
    loopCount: (timing[3] ?? '').trim() && Number.isFinite(count) ? count : null
  }
}

export interface NezPlaylist {
  lines: NezLine[]
  /** `#` comment lines (album / artist / composer headers), without the '#'. */
  comments: string[]
  /** Plain (non-NEZPlug) entries: file names in play order. */
  plain: string[]
}

export function parseNezPlaylist(text: string): NezPlaylist {
  const out: NezPlaylist = { lines: [], comments: [], plain: [] }
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const l = raw.trim()
    if (!l) continue
    if (l.startsWith('#')) {
      out.comments.push(l.slice(1).trim())
      continue
    }
    const n = parseNezLine(l)
    if (n) out.lines.push(n)
    else if (!l.includes('::')) out.plain.push(l.replace(/\\/g, '/'))
  }
  return out
}

/** Per-track playlists append the tags: "Title - Composer - Game - ©1992 Publisher" → "Title". */
export function cleanNezTitle(raw: string): { title: string; composer: string | null } {
  const t = raw.replace(/\s+/g, ' ').trim()
  const parts = t.split(' - ')
  if (parts.length >= 4 && /^(?:©|\(c\)|℗|\uFFFD|(?:19|20)\d\d)/i.test(parts[parts.length - 1].trim())) {
    return { title: parts.slice(0, parts.length - 3).join(' - ').trim(), composer: parts[parts.length - 3].trim() || null }
  }
  return { title: t, composer: null }
}

/** Composer names from playlist header comments ('Music by A, B', '@COMPOSER A'). */
export function composersFromComments(comments: string[]): string[] {
  const out: string[] = []
  for (const c of comments) {
    const m = /^(?:@?composer|music(?:\s+by)?|composed\s+by|composition)\s*[:=]?\s+(.+)$/i.exec(c.trim())
    if (!m) continue
    for (const n of m[1].split(/\s*(?:,|;|&|\/|\band\b)\s*/i)) {
      const name = n.trim()
      if (name && name.length < 60 && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Tracks from an archive listing

/** libgme formats holding several songs in one file (sub-songs). */
const MULTI_EXTS = new Set(['nsf', 'nsfe', 'gbs', 'hes', 'kss', 'ay', 'sap'])
/** One song per file: libgme (SPC, VGM, GYM), libopenmpt (trackers), vgmstream (game-engine audio). */
const SINGLE_EXTS = new Set([
  'spc', 'vgm', 'vgz', 'gym',
  'mod', 'xm', 'it', 's3m', 'mptm', 'umx', 'mo3',
  'adx', 'hca', 'brstm', 'bcstm', 'bfstm', 'bwav', 'fsb', 'wem', 'dsp', 'ast', 'hps', 'adp', 'at3', 'xwav'
])

function extOf(path: string): string {
  return /\.([a-z0-9]{1,6})$/i.exec(path)?.[1]?.toLowerCase() ?? ''
}
function baseName(path: string): string {
  return path.split('/').pop() ?? path
}
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

export function isChipEntry(path: string): boolean {
  const e = extOf(path)
  return MULTI_EXTS.has(e) || SINGLE_EXTS.has(e)
}

/** Locator of one song inside an archive. */
export function chipLocator(archiveUrl: string, entry: string, subsong?: number | null): string {
  const q = new URLSearchParams({ e: entry })
  if (subsong != null) q.set('s', String(subsong))
  return `${archiveUrl}#${q.toString()}`
}

export function parseChipLocator(locator: string): { url: string; entry: string; subsong: number | null } | null {
  const i = locator.indexOf('#')
  if (i <= 0) return null
  const url = locator.slice(0, i)
  if (!/^https?:\/\//i.test(url)) return null
  const q = new URLSearchParams(locator.slice(i + 1))
  const entry = q.get('e')
  if (!entry) return null
  const s = q.get('s')
  const subsong = s != null && /^\d+$/.test(s) ? Number(s) : null
  return { url, entry, subsong }
}

/** Engine cache key of an archive: 'chip:<host><path>'. */
export function chipCacheKey(archiveUrl: string): string {
  const u = new URL(archiveUrl)
  return `chip:${u.host}${u.pathname}`
}

export function chipSource(archiveUrl: string, entry: string, subsong?: number | null): EngineSource {
  const source: EngineSource = { kind: 'http', url: archiveUrl, cacheKey: chipCacheKey(archiveUrl), archiveEntry: entry }
  const ext = extOf(entry)
  if (ext) source.formatHint = ext
  if (subsong != null) source.subsong = subsong
  return source
}

export function chipStream(archiveUrl: string, entry: string, subsong: number | null, sizeBytes: number | null): StreamInfo {
  return { provider: CHIP_ID, source: chipSource(archiveUrl, entry, subsong), format: 'chip', lossless: false, bitrateKbps: null, sizeBytes, expiresAt: null }
}

/** "101 Presentiment" → { disc: null, number: 101, title }; "Sonic - 03 - Green Hill Zone" → 3. */
export function cleanFileTitle(stem: string): { number: number | null; title: string } {
  let s = stem.replace(/\.[a-z0-9]{1,6}$/i, '').trim()
  if (!/\s/.test(s) && /_/.test(s)) s = s.replace(/_/g, ' ')
  // "Game - 03 - Title" (smspower packs)
  let m = /^(.*?)\s+-\s+(\d{1,3})\s+-\s+(.+)$/.exec(s)
  if (m && m[1].trim()) return { number: Number(m[2]), title: m[3].trim() }
  // "01 Title", "101 Title", "01. Title", "01 - Title", "1-01 Title"
  m = /^(?:\d{1,2}-)?(\d{1,4})(?:\s*[.)_-]\s*|\s+)(.+)$/.exec(s)
  if (m && /\p{L}/u.test(m[2])) return { number: Number(m[1]), title: m[2].trim() }
  return { number: null, title: s }
}

export interface BuildTracksOptions {
  archiveUrl: string
  /** vgmrips pack page tracks: titles and lengths by file name. */
  pack?: VgmPackTrack[]
  /** Game title: the track title of a set that is one multi-song file without a playlist. */
  gameTitle?: string | null
}

export interface BuiltTracks {
  tracks: ProviderTrack[]
  composers: string[]
  /** Total size of the playable entries. */
  sizeBytes: number
}

const normTitle = (s: string) => foldText(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * KSS sets prefix every title with "[Game MODE]" ("[魔導物語 OPLL]プロローグ"): drop the part all
 * titles share and keep what differs as a suffix ("プロローグ (OPLL)").
 */
function stripBracketPrefixes(tracks: ProviderTrack[]): void {
  if (tracks.length < 2) return
  const parts = tracks.map((t) => /^\[([^\]]+)\]\s*(.+)$/.exec(t.title))
  if (parts.some((p) => !p)) return
  const words = parts.map((p) => p![1].trim().split(/\s+/))
  let common = 0
  while (words.every((w) => common < w.length && w[common] === words[0][common])) common++
  if (!common) return
  tracks.forEach((t, i) => {
    const rest = words[i].slice(common).join(' ')
    t.title = rest ? `${parts[i]![2].trim()} (${rest})` : parts[i]![2].trim()
  })
}

/**
 * Tracks of a rip set from its archive listing:
 *  - NEZPlug playlists (NSF / GBS / HES / KSS sets): one track per line, in the full playlist's
 *    order (per-track playlists only when there is no full one), with sub-song, title and length;
 *  - otherwise one track per playable file (SPC sets, VGM packs, plain multi-song files), in the
 *    order of a plain .m3u if there is one, else by name.
 */
export function buildChipTracks(listing: ArchiveListing, o: BuildTracksOptions): BuiltTracks {
  const entries = listing.entries.filter((e) => isChipEntry(e.path))
  const sizeOf = new Map(entries.map((e) => [e.path, e.size]))
  const byBase = new Map<string, string>()
  for (const e of [...entries].sort((a, b) => natural(a.path, b.path))) {
    const k = baseName(e.path).toLowerCase()
    if (!byBase.has(k)) byBase.set(k, e.path)
  }
  const resolve = (file: string): string | null => {
    const hit = byBase.get(baseName(file).toLowerCase())
    if (hit) return hit
    // A playlist naming a file that was renamed: fall back to the only file of that type.
    const ext = extOf(file)
    const same = entries.filter((e) => extOf(e.path) === ext && MULTI_EXTS.has(ext))
    return same.length === 1 ? same[0].path : null
  }
  const playlists = listing.playlists
    .filter((p) => /\.m3u8?$/i.test(p.path))
    .sort((a, b) => natural(a.path, b.path))
    .map((p) => ({ path: p.path, ...parseNezPlaylist(p.text) }))
  const composers = composersFromComments(playlists.flatMap((p) => p.comments))
  const addComposer = (c: string | null) => {
    if (c && !composers.some((x) => x.toLowerCase() === c.toLowerCase())) composers.push(c)
  }
  const tracks: ProviderTrack[] = []
  const stream = (entry: string, subsong: number | null) => chipStream(o.archiveUrl, entry, subsong, sizeOf.get(entry) ?? null)
  const push = (entry: string, subsong: number | null, title: string, durationMs: number | null, number: number, disc = 1) => {
    tracks.push({
      disc,
      number,
      title,
      durationMs,
      locator: chipLocator(o.archiveUrl, entry, subsong),
      files: [{ format: 'chip', sizeBytes: sizeOf.get(entry) ?? null }],
      composers: [],
      streams: [stream(entry, subsong)]
    })
  }

  // --- NEZPlug playlists ---------------------------------------------------------------------
  const nez = playlists.map((p) => ({ ...p, resolved: p.lines.map((l) => ({ l, entry: MULTI_EXTS.has(extOf(l.file)) || MULTI_EXTS.has(l.type.toLowerCase()) ? resolve(l.file) : null })).filter((x) => x.entry) }))
  const anyNez = nez.some((p) => p.resolved.length)
  if (anyNez) {
    // Decimal track numbers are 1-based (libgme), except KSS, and except sets that number from 0
    // (HCS GBS sets do: "DMG-TRA-0.gbs::GBS,0,Title").
    const zeroBased = new Map<string, boolean>()
    for (const p of nez)
      for (const { l, entry } of p.resolved) {
        if (l.type.toUpperCase() === 'KSS' || (!l.hex && l.track === 0)) zeroBased.set(entry!, true)
      }
    const full = nez.filter((p) => p.resolved.length >= 2)
    const use = full.length ? full : nez.filter((p) => p.resolved.length)
    const seen = new Set<string>()
    const titleOwner = new Map<string, string>()
    for (const p of use) {
      for (const { l, entry } of p.resolved) {
        const sub = l.hex ? l.track : zeroBased.get(entry!) ? l.track : l.track - 1
        if (sub < 0) continue
        const key = `${entry}\u0000${sub}`
        if (seen.has(key)) continue
        const { title: cleaned, composer } = cleanNezTitle(l.title)
        addComposer(composer)
        const fromName = !full.length && p.resolved.length === 1 ? cleanFileTitle(baseName(p.path).replace(/\.m3u8?$/i, '')).title : ''
        const title = cleaned || fromName || `Track ${tracks.length + 1}`
        // The same song in another revision of the file (Tetris v1.0 / v1.1): keep the first.
        const nt = normTitle(title)
        const owner = titleOwner.get(nt)
        if (owner && owner !== entry) continue
        if (!owner) titleOwner.set(nt, entry!)
        seen.add(key)
        const duration = l.lengthMs != null && l.lengthMs > 0 ? l.lengthMs + (l.fadeMs ?? DEFAULT_FADE_MS) : null
        push(entry!, sub, title, duration, tracks.length + 1)
      }
    }
    stripBracketPrefixes(tracks)
    return { tracks, composers, sizeBytes: entries.reduce((s, e) => s + e.size, 0) }
  }

  // --- one track per file ----------------------------------------------------------------------
  const ordered: string[] = []
  for (const p of playlists)
    for (const f of p.plain) {
      const e = byBase.get(baseName(f).toLowerCase())
      if (e && !ordered.includes(e)) ordered.push(e)
    }
  for (const e of [...entries].sort((a, b) => natural(a.path, b.path))) if (!ordered.includes(e.path)) ordered.push(e.path)
  // An .nsfe next to the same-named .nsf carries titles and a playlist: play that one.
  const stems = new Set(ordered.filter((p) => extOf(p) === 'nsfe').map((p) => p.replace(/\.nsfe$/i, '').toLowerCase()))
  const files = ordered.filter((p) => !(extOf(p) === 'nsf' && stems.has(p.replace(/\.nsf$/i, '').toLowerCase())))
  const packByFile = new Map((o.pack ?? []).map((t) => [t.file.toLowerCase(), t]))
  const parsed = files.map((path) => {
    const pk = packByFile.get(baseName(path).toLowerCase())
    const c = cleanFileTitle(baseName(path))
    return { path, pk, c }
  })
  // Three-digit numbering across the whole set is disc + track ("101 …", "201 …").
  const nums = parsed.map((x) => x.c.number)
  const discNumbered = parsed.length > 1 && nums.every((n) => n != null && n >= 101 && n < 1000 && n % 100 !== 0)
  parsed.forEach(({ path, pk, c }, i) => {
    const multi = MULTI_EXTS.has(extOf(path))
    const title = pk?.title || (multi && files.length === 1 && o.gameTitle ? o.gameTitle : c.title) || `Track ${i + 1}`
    const n = pk?.number ?? c.number
    const disc = discNumbered && n != null ? Math.floor(n / 100) : 1
    const number = discNumbered && n != null ? n % 100 : (n ?? i + 1)
    push(path, null, title, pk?.durationMs ?? null, number, disc)
  })
  return { tracks, composers, sizeBytes: entries.reduce((s, e) => s + e.size, 0) }
}

// ---------------------------------------------------------------------------
// Provider

export interface ChipProviderDeps {
  http: HttpClient
  /** The engine's archive lister (fetches the archive into the stream cache). */
  inspectArchive?: (source: EngineSource) => Promise<ArchiveListing>
  log?: (msg: string) => void
}

export interface ChipListingPage {
  sets: ChipSet[]
  /** Rows that aren't playable chip sets (other formats, unsupported chips, too big). */
  skipped: number
}

export class ChipProvider implements Provider {
  readonly id = CHIP_ID
  readonly name = 'Chiptune rips'

  constructor(private readonly deps: ChipProviderDeps) {}

  /** Set listing pages of a joshw host: its letter directories ('/a/', '/MSX/a/'). */
  async joshwPages(src: JoshwSource, opts: ProviderCallOptions = {}): Promise<{ path: string; group: string | null }[]> {
    const root = parseApacheListing((await this.deps.http.pageFetch(`https://${src.host}/`, { ttlMs: LISTING_TTL_MS, priority: opts.priority ?? 2, signal: opts.signal, force: opts.force })).html)
    const out: { path: string; group: string | null }[] = []
    for (const d of root) {
      if (!d.dir || /^lost\+found$/i.test(d.name)) continue
      if (isLetterDir(d.name)) {
        out.push({ path: `/${d.href}`, group: null })
        continue
      }
      // A grouping level (kss.: MSX/, Master System/, Game Gear/): its letter directories.
      const sub = parseApacheListing((await this.deps.http.pageFetch(`https://${src.host}/${d.href}`, { ttlMs: LISTING_TTL_MS, priority: opts.priority ?? 2, signal: opts.signal, force: opts.force })).html)
      for (const s of sub) if (s.dir && isLetterDir(s.name)) out.push({ path: `/${d.href}${s.href}`, group: d.name })
    }
    return out
  }

  /** Sets in one joshw listing page. */
  async fetchJoshwPage(src: JoshwSource, page: { path: string; group: string | null }, opts: ProviderCallOptions = {}): Promise<ChipListingPage> {
    const res = await this.deps.http.pageFetch(`https://${src.host}${page.path}`, { ttlMs: LISTING_TTL_MS, priority: opts.priority ?? 2, signal: opts.signal, force: opts.force })
    return joshwPageSets(src, page, res.html)
  }

  /** One page (0-based) of vgmrips' pack list; packs whose chips libgme can't play are skipped. */
  async fetchVgmripsPage(page: number, opts: ProviderCallOptions = {}): Promise<ChipListingPage & { totalPages: number }> {
    const url = page > 0 ? `${VGMRIPS_BASE}/packs/latest?p=${page}` : `${VGMRIPS_BASE}/packs/latest`
    const res = await this.deps.http.pageFetch(url, { ttlMs: LISTING_TTL_MS, priority: opts.priority ?? 2, signal: opts.signal, force: opts.force })
    const l = parseVgmripsListing(res.html)
    if (!l.packs.length && !/class="result/.test(res.html)) throw new NetError('parse', `no packs on ${url}`)
    const sets = l.packs.filter((p) => p.playable && p.set.archiveUrl).map((p) => p.set)
    return { sets, skipped: l.packs.length - sets.length, totalPages: l.totalPages }
  }

  private async inspect(archiveUrl: string): Promise<ArchiveListing> {
    if (!this.deps.inspectArchive) throw new Error('Chiptune rips need the audio engine, which is unavailable.')
    try {
      return await this.deps.inspectArchive({ kind: 'http', url: archiveUrl, cacheKey: chipCacheKey(archiveUrl) })
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      if (/\b404\b|\b410\b|not found/i.test(msg)) throw new NetError('not_found', `rip set is gone: ${archiveUrl}`, { url: archiveUrl, cause: e })
      throw new NetError('network', `couldn't fetch the rip set ${archiveUrl}: ${msg}`, { url: archiveUrl, cause: e })
    }
  }

  async getAlbum(ref: string, opts: ProviderCallOptions = {}): Promise<ProviderAlbum> {
    const slash = ref.indexOf('/')
    const host = slash > 0 ? ref.slice(0, slash).toLowerCase() : ''
    if (host === VGMRIPS_HOST) return this.getVgmripsAlbum(ref, opts)
    const src = joshwSource(host)
    if (!src) throw new NetError('not_found', `unknown chiptune rip set: ${ref}`)
    const path = ref.slice(slash)
    const dir = path.slice(0, path.lastIndexOf('/') + 1)
    const file = path.slice(dir.length)
    const groupDir = dir.split('/').filter(Boolean)
    const set = joshwSet(src, dir, { href: file, name: safeDecode(file), dir: false, sizeBytes: null, modified: null }, groupDir.length > 1 ? safeDecode(groupDir[0]) : null)
    if (!set?.archiveUrl) throw new NetError('not_found', `not a playable rip set: ${ref}`)
    const listing = await this.inspect(set.archiveUrl)
    const built = buildChipTracks(listing, { archiveUrl: set.archiveUrl, gameTitle: set.title })
    if (!built.tracks.length) throw new NetError('not_found', `"${set.title}" has nothing playable`)
    return this.album(set, built)
  }

  private async getVgmripsAlbum(ref: string, opts: ProviderCallOptions): Promise<ProviderAlbum> {
    const url = `https://${ref}`
    const res = await this.deps.http.pageFetch(url, { ttlMs: PACK_TTL_MS, priority: opts.priority ?? 0, signal: opts.signal, force: opts.force })
    const pack = parseVgmripsPack(res.html)
    if (!pack.zipUrl) throw new NetError('parse', `no download on ${url}`)
    const system = pack.systems.map((s) => SYSTEMS[s.toLowerCase()]).find(Boolean) ?? chipSystem(pack.systems[0])
    const set: ChipSet = {
      source: 'vgmrips',
      ref,
      archiveUrl: pack.zipUrl,
      title: pack.title,
      altTitles: pack.altTitles,
      system,
      format: 'VGM',
      year: pack.year,
      variant: [],
      sizeBytes: null,
      trackCount: pack.tracks.length || null,
      developers: pack.developers,
      publishers: pack.publishers,
      composers: pack.composers,
      cover: pack.cover,
      thumb: pack.cover
    }
    const listing = await this.inspect(pack.zipUrl)
    const built = buildChipTracks(listing, { archiveUrl: pack.zipUrl, pack: pack.tracks, gameTitle: pack.title })
    if (!built.tracks.length) throw new NetError('not_found', `"${pack.title}" has nothing playable`)
    return this.album(set, built)
  }

  private album(set: ChipSet, built: BuiltTracks): ProviderAlbum {
    const hit = chipAlbumHit(set)
    const composers = set.composers.length ? set.composers : built.composers
    return {
      ...hit,
      altTitles: set.altTitles,
      titleOriginal: null,
      developers: set.developers,
      publishers: set.publishers,
      composers,
      images: set.cover ? [set.cover] : [],
      description: null,
      formats: ['chip'],
      totalSizes: { chip: built.sizeBytes },
      externalId: null,
      tracks: built.tracks
    }
  }

  async resolveStream(locator: string): Promise<StreamInfo[]> {
    const l = parseChipLocator(locator)
    if (!l) throw new NetError('parse', `bad chiptune locator: ${locator}`)
    return [chipStream(l.url, l.entry, l.subsong, null)]
  }
}

/** Sets in a joshw letter listing. */
export function joshwPageSets(src: JoshwSource, page: { path: string; group: string | null }, html: string): ChipListingPage {
  const rows = parseApacheListing(html).filter((e) => !e.dir)
  const sets: ChipSet[] = []
  for (const e of rows) {
    const s = joshwSet(src, page.path, e, page.group)
    if (s) sets.push(s)
  }
  return { sets, skipped: rows.length - sets.length }
}
