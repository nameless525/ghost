// Modland (ftp.modland.com): original sound-chip files (DESIGN §6.2 #2) indexed from one daily file.
//
// Shapes (verified 2026-10-14 against that day's allmods.zip, 516,165 lines):
//  - https://ftp.modland.com/allmods.zip (≈5.8 MB, regenerated daily; nginx, no robots.txt, Range → 206)
//    holds one deflated entry, `allmods.txt` (≈31 MB, UTF-8, LF): `<size>\t<path under /pub/modules/>`.
//  - The trees GHOST plays (libgme):
//      Nintendo SPC/<composer>/[coop-<co-composer>/]<game>/<song>.spc                 one file per song
//      Video Game Music/<system>/<composer>/[coop-<co-composer>/]<game>/<song>.vgz     one file per song
//      Nintendo Sound Format/<composer>/[coop-<co-composer>/]<game>.nsf               one file, many songs
//      Gameboy Sound System/<composer>/[coop-<co-composer>/]<game>.gbs                one file, many songs
//    '- unknown' is the placeholder composer. Co-composed games live once, under `coop-` folders, but
//    some games are split over several composer folders (EarthBound: Akio Ohmori + Keiichi Suzuki,
//    each with their own songs). The NSF/GBS trees mix game rips with homebrew and covers by
//    chiptune musicians; nothing in the index tells them apart.
//  - A file is https://ftp.modland.com/pub/modules/<path, each segment URL-encoded>.
//
// Not indexed:
//  - HES/ and KSS/ (PC Engine, MSX): loose files with no song list next to them (no .m3u), and neither
//    format stores a song count (libgme reports 256 sub-songs). joshw and Zophar sets cover them.
//  - SGC/: the engine's libgme (0.6.5) has no SGC emulator.
//  - Video Game Music systems whose chips libgme's VGM player lacks (32X PWM, Mega CD PCM, MSX
//    AY/SCC, X68000 OPM, Vectrex, Virtual Boy …): they'd play silent or half-silent.
//  - The PSF/2SF/GSF/USF/SSF/DSF/SID trees (no player), and songs lying directly in a composer
//    folder with no game folder (homebrew one-offs).
//
// Album model: SPC / VGM → one album per game folder (tracks = files), merged across composer folders
// by name. NSF / GBS → one album per file (tracks = sub-songs, counted from the file header with a
// Range request when the album is opened); identical copies under several composer folders merge.
// Refs: 'spc/<game>', 'vgm/<system>/<game>', 'nsf/<path below the format folder>' (NFC, lowercase).
// Locators: the file path ('Nintendo SPC/…/101 - presentiment.spc'), plus '#<sub-song>' (0-based)
// for multi-song files ('Nintendo Sound Format/Koji Kondo/super mario bros 3.nsf#0').

import { crc32, inflateRawSync } from 'node:zlib'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { foldText } from '../../shared/search'
import type { EngineSource } from '../engine/types'
import { isNetError, NetError } from '../net/errors'
import type { HttpClient } from '../net/http'
import { chipSystem, cleanFileTitle } from './chip'
import type { AlbumHit, IndexPage, IndexProvider, IndexSection, PlatformRef, ProviderAlbum, ProviderCallOptions, ProviderTrack, StreamInfo } from './types'

export const MODLAND_ID = 'modland'
export const MODLAND_HOST = 'ftp.modland.com'
export const MODLAND_BASE = `https://${MODLAND_HOST}`
export const MODLAND_FILES_BASE = `${MODLAND_BASE}/pub/modules/`
export const MODLAND_INDEX_URL = `${MODLAND_BASE}/allmods.zip`
/** The index file is regenerated daily but changes slowly: reuse a downloaded copy this long. */
export const MODLAND_INDEX_MAX_AGE_MS = 3 * 24 * 3600_000
/** Albums per index page. */
export const MODLAND_PAGE_SIZE = 500
/** After a failed refresh, keep serving the old index this long before trying again. */
const REFRESH_RETRY_MS = 15 * 60_000
const CACHE_FILE = 'modland-index.txt'
const CACHE_MAGIC = '#GHOST modland-index'
const CACHE_VERSION = 1
/** The engine's default fade (Album loop mode) when a song has a length but no fade. */
const DEFAULT_FADE_MS = 10_000
/** NSFE files are read whole for their song titles; anything bigger isn't one. */
const MAX_NSFE_BYTES = 1024 * 1024

// ---------------------------------------------------------------------------
// Families

export type ModlandFamily = 'spc' | 'vgm' | 'nsf' | 'gbs'

export interface ModlandFamilyDef {
  key: ModlandFamily
  /** Top-level folder under /pub/modules/. */
  root: string
  label: string
  exts: string[]
  /** One file holds every song of the game (tracks are sub-songs). */
  multi: boolean
  /** A <system> folder sits between the root and the composer (Video Game Music). */
  systemLevel: boolean
  /** chipSystem() name of the platform when no tag or system folder says otherwise. */
  defaultSystem: string
}

export const MODLAND_FAMILIES: ModlandFamilyDef[] = [
  { key: 'spc', root: 'Nintendo SPC', label: 'SNES (SPC)', exts: ['spc'], multi: false, systemLevel: false, defaultSystem: 'snes' },
  { key: 'nsf', root: 'Nintendo Sound Format', label: 'NES (NSF)', exts: ['nsf', 'nsfe'], multi: true, systemLevel: false, defaultSystem: 'nes' },
  { key: 'gbs', root: 'Gameboy Sound System', label: 'Game Boy (GBS)', exts: ['gbs'], multi: true, systemLevel: false, defaultSystem: 'gb' },
  { key: 'vgm', root: 'Video Game Music', label: 'Sega and others (VGM)', exts: ['vgz', 'vgm'], multi: false, systemLevel: true, defaultSystem: 'mega drive' }
]

const FAMILY_BY_KEY = new Map(MODLAND_FAMILIES.map((f) => [f.key, f]))
const FAMILY_BY_ROOT = new Map(MODLAND_FAMILIES.map((f) => [f.root, f]))
const MULTI_EXTS = new Set(MODLAND_FAMILIES.filter((f) => f.multi).flatMap((f) => f.exts))

/**
 * `Video Game Music/<system>` folders → chipSystem() name, and whether libgme's VGM player emulates
 * the system's chips (SN76489, YM2612, YM2413 only). Folders not listed are skipped.
 */
export const MODLAND_VGM_SYSTEMS: Record<string, { system: string; playable: boolean }> = {
  'sega megadrive': { system: 'mega drive', playable: true },
  'sega mega drive': { system: 'mega drive', playable: true },
  'sega genesis': { system: 'mega drive', playable: true },
  'sega master system': { system: 'master system', playable: true },
  'sega game gear': { system: 'game gear', playable: true },
  'sega sg-1000': { system: 'sg-1000', playable: true },
  'sega sc-3000': { system: 'sc-3000', playable: true },
  'bbc micro': { system: 'bbc micro', playable: true },
  colecovision: { system: 'colecovision', playable: true },
  // PWM / RF5C164 PCM / AY-3-8910 + SCC / YM2151 / VSU / HuC6280 / 2A03 / YM2610 / YM2203: not in libgme's VGM player.
  'sega 32x': { system: '32x', playable: false },
  'sega mega cd': { system: 'mega cd', playable: false },
  msx: { system: 'msx', playable: false },
  msx1: { system: 'msx', playable: false },
  msx2: { system: 'msx2', playable: false },
  vectrex: { system: 'vectrex', playable: false },
  'nintendo virtual boy': { system: 'virtual boy', playable: false },
  'sharp x68000': { system: 'x68000', playable: false },
  'nec pc-engine': { system: 'pc engine', playable: false },
  'nec pc-9801': { system: 'pc-9801', playable: false },
  'nec pc-8801': { system: 'pc-8801', playable: false },
  'nintendo nes': { system: 'nes', playable: false },
  arcade: { system: 'arcade', playable: false },
  'neo geo': { system: 'neo geo', playable: false }
}

export function modlandFamily(key: string): ModlandFamilyDef | null {
  return FAMILY_BY_KEY.get(key as ModlandFamily) ?? null
}

// ---------------------------------------------------------------------------
// Names

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const natural = (a: string, b: string) => collator.compare(a, b)

/** Ref / dedupe key: NFC, lowercase, single spaces. */
export function modlandKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Letters and digits only (compares "Front Mission - Gun Hazard" with "front mission gun hazard"). */
function alnum(s: string): string {
  return foldText(s).replace(/[^\p{L}\p{N}]+/gu, '')
}

function extOf(path: string): string {
  return /\.([a-z0-9]{1,6})$/i.exec(path)?.[1]?.toLowerCase() ?? ''
}

function stemOf(name: string): string {
  return name.replace(/\.[a-z0-9]{1,6}$/i, '')
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Placeholder composer folders ('- unknown'). */
export function isPlaceholderComposer(name: string): boolean {
  return /^-\s|^-?\s*unknown\s*-?$|^\?+$/i.test(name.trim())
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'vs', 'vs.', 'via', 'with', 'no', 'wo'])
const ROMAN = /^(?:ii|iii|iv|vi|vii|viii|ix|xi|xii|xiii|xiv|xv)$/i
const UPPER_WORDS = new Set(['rpg', 'gb', 'gbc', 'sgb', 'sd', 'dx', 'nba', 'nfl', 'nhl', 'wwf', 'wcw', 'ufo', 'usa', 'tv', 'dj', 'bgm', 'fm', 'psg', 'cd', 'ok', 'msx', 'nes', 'snes', 'pc'])

/**
 * Title-case a name written all in lowercase ("legend of zelda - the triforce" → "Legend of Zelda -
 * The Triforce"). Names with any capital letter are left alone.
 */
export function smartTitle(s: string): string {
  if (/\p{Lu}/u.test(s) || !/\p{Ll}/u.test(s)) return s
  const words = s.split(/(\s+)/)
  let first = true
  let afterBreak = false
  return words
    .map((w) => {
      if (!w.trim()) return w
      const bare = w.replace(/^[("'[]+|[)"'\],:;!?]+$/g, '')
      let out: string
      if (ROMAN.test(bare) || UPPER_WORDS.has(bare)) out = w.replace(bare, bare.toUpperCase())
      else if (!first && !afterBreak && !/^[([]/.test(w) && SMALL_WORDS.has(bare)) out = w
      else out = w.replace(/(^|[-./&(["])(\p{Ll})/gu, (_, p: string, c: string) => p + c.toUpperCase())
      first = false
      afterBreak = /^[-~:]$/.test(w) || /[:(]$/.test(w)
      return out
    })
    .join('')
}

/** Short codes written in capitals when they make up a whole tag ("(pal)" → "(PAL)"). */
const UPPER_TAGS = new Set(['pal', 'ntsc', 'jp', 'jpn', 'us', 'usa', 'eu', 'eur', 'sms', 'gg', 'msx', 'msx2', 'scc', 'fm', 'psg', 'opll', 'sgx', 'pc-fx', 'vs', 'fds', 'sgb', 'gbc'])

/** Tags that only name a sound chip (stripped from titles). */
const CHIP_TAGS = new Set(['n106', 'n163', 'namco 106', 'namco 163', 'vrc6', 'vrc7', 'mmc5', 'fme7', 'fme-7', '5b', 'sunsoft 5b', 'vrc6 + vrc7'])
/** Tags that name the platform: family → tag → chipSystem() name. */
const PLATFORM_TAGS: Partial<Record<ModlandFamily, Record<string, string>>> = {
  spc: { sgb: 'sgb' },
  nsf: { fds: 'fds', 'famicom disk system': 'fds', vs: 'vs' },
  gbs: { gbc: 'gbc', cgb: 'gbc', sgb: 'sgb' }
}

export interface ModlandName {
  title: string
  /** chipSystem() name when a tag named the platform. */
  system: string | null
}

/**
 * Album title from a game folder or multi-song file stem: tidies spacing, drops sound-chip tags
 * ("(vrc7)") and platform tags ("(fds)", "(SGB)") that become the platform, keeps everything else
 * ("(Prototype)", "(FM)", "(1987)"), and title-cases all-lowercase names.
 */
export function modlandTitle(name: string, family: ModlandFamily): ModlandName {
  let s = (/\s/.test(name.trim()) ? name : name.replace(/_+/g, ' ')).replace(/\s+/g, ' ').trim()
  const kept: string[] = []
  let system: string | null = null
  const platformTags = PLATFORM_TAGS[family] ?? {}
  let m: RegExpExecArray | null
  while ((m = /\s*[([]([^()[\]]*)[)\]]$/.exec(s)) && m.index > 0) {
    const tag = m[1].trim().toLowerCase()
    if (platformTags[tag]) system ??= platformTags[tag]
    else if (!(family === 'nsf' && CHIP_TAGS.has(tag))) kept.unshift(m[0].trim())
    s = s.slice(0, m.index)
  }
  const base = smartTitle(s.trim())
  const tags = kept.map((t) => (UPPER_TAGS.has(t.slice(1, -1).trim().toLowerCase()) ? t.toUpperCase() : smartTitle(t)))
  const title = [base, ...tags].filter(Boolean).join(' ').trim()
  return { title: title || name.trim(), system }
}

/** Platform of an album: a title tag wins, then the VGM system folder, then the family default. */
export function modlandPlatform(family: ModlandFamily, tagSystem: string | null, systemFolder: string | null = null): PlatformRef {
  const def = FAMILY_BY_KEY.get(family)!
  const name = tagSystem ?? (systemFolder ? (MODLAND_VGM_SYSTEMS[modlandKey(systemFolder)]?.system ?? systemFolder) : def.defaultSystem)
  return chipSystem(name)!.platform
}

// ---------------------------------------------------------------------------
// Track titles (one file per song)

function sharedDashPrefix(stems: string[]): string {
  const first = stems[0]
  const cuts: number[] = []
  for (let i = first.indexOf(' - '); i > 0; i = first.indexOf(' - ', i + 1)) cuts.push(i + 3)
  for (const cut of cuts.reverse()) {
    const p = first.slice(0, cut).toLowerCase()
    if (stems.every((s) => s.length > cut && s.toLowerCase().startsWith(p) && s.slice(cut).trim())) return first.slice(0, cut)
  }
  return ''
}

function gameKeysOf(gameTitle: string): Set<string> {
  const keys = new Set<string>()
  const add = (s: string) => {
    const k = alnum(s)
    if (k.length >= 2) keys.add(k)
  }
  add(gameTitle)
  add(gameTitle.replace(/\s*[([].*$/, ''))
  add(gameTitle.split(' - ')[0])
  return keys
}

export interface CleanTrackTitle {
  number: number | null
  title: string
}

/**
 * Song titles from file stems of one game: drops a "<game> - " prefix every file shares ("plok! -
 * beach"), reads track numbers ("101 - presentiment", "beyond oasis - 32 - confession", "07"),
 * names numbered dumps ("mppp-14", "makeruna! makendou (18)") "Track N", and title-cases.
 */
export function modlandTrackTitles(stems: string[], gameTitle: string): CleanTrackTitle[] {
  const keys = gameKeysOf(gameTitle)
  let prefix = stems.length >= 2 ? sharedDashPrefix(stems) : ''
  if (prefix && stems.length < 3 && !keys.has(alnum(prefix.slice(0, -3)))) prefix = ''
  const stripped = stems.map((stem) => {
    if (prefix) return stem.slice(prefix.length).trim()
    for (let i = stem.indexOf(' - '); i > 0; i = stem.indexOf(' - ', i + 1)) {
      if (keys.has(alnum(stem.slice(0, i))) && stem.slice(i + 3).trim()) return stem.slice(i + 3).trim()
    }
    // "earthbound (battle01)": the game, then the song in brackets.
    const paren = /^(.+?)\s*\(([^()]*\p{L}[^()]*)\)$/u.exec(stem.trim())
    if (paren && keys.has(alnum(paren[1]))) return paren[2].trim()
    return stem.trim()
  })
  // Numbered dumps: every name is "<same head>-NN" / "<same head> (NN)", or one whose head is the game.
  const dump = (s: string) => /^(.*?)\s*\((\d{1,3})\)$/.exec(s) ?? /^([a-z][a-z0-9]{0,7})[_-](\d{1,3})$/i.exec(s)
  const dumps = stripped.map(dump)
  const heads = new Set(dumps.map((d) => (d ? alnum(d[1]) : null)))
  const allDumps = dumps.every(Boolean) && (heads.size === 1 && stems.length >= 2 ? true : [...heads].every((h) => h != null && (keys.has(h) || h === '')))
  return stripped.map((s, i) => {
    if (allDumps) {
      const n = Number(dumps[i]![2])
      return { number: n, title: `Track ${n}` }
    }
    if (/^\d{1,3}$/.test(s)) return { number: Number(s), title: `Track ${Number(s)}` }
    const c = cleanFileTitle(s)
    return { number: c.number, title: smartTitle(c.title) || `Track ${i + 1}` }
  })
}

// ---------------------------------------------------------------------------
// Zip (one entry, stored or deflated)

/** The bytes of one entry of a zip file (first entry whose base name matches `name`, else the first file). */
export function extractZipEntry(zip: Buffer, name?: string): { name: string; data: Buffer } {
  const parse = (msg: string) => new NetError('parse', `bad zip: ${msg}`)
  if (zip.length < 22) throw parse('too short')
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw parse('no end of central directory')
  const count = zip.readUInt16LE(eocd + 10)
  const cdOffset = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw parse('zip64 is not supported')
  let p = cdOffset
  let pick: { name: string; method: number; flags: number; crc: number; csize: number; usize: number; local: number } | null = null
  for (let k = 0; k < count; k++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw parse('broken central directory')
    const flags = zip.readUInt16LE(p + 8)
    const nameLen = zip.readUInt16LE(p + 28)
    const entryName = zip.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
    const e = {
      name: entryName,
      method: zip.readUInt16LE(p + 10),
      flags,
      crc: zip.readUInt32LE(p + 16),
      csize: zip.readUInt32LE(p + 20),
      usize: zip.readUInt32LE(p + 24),
      local: zip.readUInt32LE(p + 42)
    }
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32)
    if (entryName.endsWith('/')) continue
    if (name ? baseName(entryName).toLowerCase() === name.toLowerCase() : true) {
      pick = e
      break
    }
  }
  if (!pick) throw parse(name ? `no ${name} inside` : 'empty')
  if (pick.flags & 1) throw parse('encrypted entry')
  const l = pick.local
  if (l + 30 > zip.length || zip.readUInt32LE(l) !== 0x04034b50) throw parse('broken local header')
  const start = l + 30 + zip.readUInt16LE(l + 26) + zip.readUInt16LE(l + 28)
  if (start + pick.csize > zip.length) throw parse('truncated')
  const raw = zip.subarray(start, start + pick.csize)
  let data: Buffer
  if (pick.method === 0) data = Buffer.from(raw)
  else if (pick.method === 8) {
    try {
      data = inflateRawSync(raw)
    } catch (e) {
      throw new NetError('parse', `bad zip: ${(e as Error).message}`, { cause: e })
    }
  } else throw parse(`compression method ${pick.method} is not supported`)
  if (data.length !== pick.usize) throw parse(`size mismatch (${data.length} ≠ ${pick.usize})`)
  if (crc32(data) >>> 0 !== pick.crc >>> 0) throw parse('CRC mismatch')
  return { name: pick.name, data }
}

// ---------------------------------------------------------------------------
// Index lines

const ROOT_PREFIXES = MODLAND_FAMILIES.map((f) => Buffer.from(`${f.root}/`, 'utf8'))

/**
 * Keep only the lines of allmods.txt under the indexed format folders (≈57k of 516k lines, ≈4.6 MB).
 * Works on bytes so the 31 MB text is never turned into one string.
 */
export function filterModlandLines(text: Buffer): Buffer {
  const keep: [number, number][] = []
  let total = 0
  const firstBytes = new Set(ROOT_PREFIXES.map((b) => b[0]))
  for (let s = 0; s < text.length; ) {
    let e = text.indexOf(10, s)
    if (e < 0) e = text.length
    const tab = text.indexOf(9, s)
    if (tab > s && tab < e) {
      const p = tab + 1
      if (firstBytes.has(text[p])) {
        for (const pre of ROOT_PREFIXES) {
          if (e - p > pre.length && text.compare(pre, 0, pre.length, p, p + pre.length) === 0) {
            let end = e
            if (text[end - 1] === 13) end--
            keep.push([s, end])
            total += end - s + 1
            break
          }
        }
      }
    }
    s = e + 1
  }
  const out = Buffer.allocUnsafe(total)
  let o = 0
  for (const [s, e] of keep) {
    o += text.copy(out, o, s, e)
    out[o++] = 10
  }
  return out
}

/** Calls `fn(size, path)` for each `<size>\t<path>` line ('#' lines and junk are skipped). */
export function forEachModlandLine(text: Buffer | string, fn: (size: number, path: string) => void): void {
  const buf = typeof text === 'string' ? Buffer.from(text, 'utf8') : text
  for (let s = 0; s < buf.length; ) {
    let e = buf.indexOf(10, s)
    if (e < 0) e = buf.length
    let end = e
    if (buf[end - 1] === 13) end--
    if (buf[s] !== 35) {
      const tab = buf.indexOf(9, s)
      if (tab > s && tab < end) {
        let size = 0
        let ok = true
        for (let i = s; i < tab; i++) {
          const c = buf[i] - 48
          if (c < 0 || c > 9) {
            ok = false
            break
          }
          size = size * 10 + c
        }
        if (ok && end > tab + 1) fn(size, buf.toString('utf8', tab + 1, end))
      }
    }
    s = e + 1
  }
}

// ---------------------------------------------------------------------------
// Index

export interface ModlandFile {
  /** Path below the member's dir ('101 - presentiment.spc', 'super mario bros 3.nsf'). */
  rel: string
  size: number
}

/** One composer folder's share of an album. */
export interface ModlandMember {
  /** Path of the game folder (SPC/VGM) or of the folder holding the file (NSF/GBS). */
  dir: string
  composers: string[]
  placeholder: boolean
  files: ModlandFile[]
}

export interface ModlandAlbumEntry {
  family: ModlandFamily
  ref: string
  title: string
  platform: PlatformRef
  composers: string[]
  /** Preferred first (a named composer before '- unknown', then by path). */
  members: ModlandMember[]
  fileCount: number
  sizeBytes: number
  /** foldText(title) and its letters and digits only, for search. */
  search: string
  squash: string
}

export interface ModlandIndex {
  fetchedAt: number
  /** Per family, sorted by title (the paging order). */
  byFamily: Map<ModlandFamily, ModlandAlbumEntry[]>
  byRef: Map<string, ModlandAlbumEntry>
  /** Files kept per family, and lines skipped (unplayable systems, loose songs, other extensions). */
  files: Record<ModlandFamily, number>
  skipped: number
}

interface Pending {
  family: ModlandFamilyDef
  ref: string
  name: string
  system: string | null
  members: Map<string, ModlandMember>
}

function composersOf(composer: string | null, middle: string[]): { composers: string[]; placeholder: boolean } {
  const out: string[] = []
  const placeholder = composer == null || isPlaceholderComposer(composer)
  if (composer && !placeholder) out.push(composer.trim())
  for (const m of middle) {
    const c = /^coop-(.+)$/i.exec(m)?.[1]?.trim()
    if (c && !isPlaceholderComposer(c) && !out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c)
  }
  return { composers: out, placeholder }
}

const memberOrder = (a: ModlandMember, b: ModlandMember) => Number(a.placeholder) - Number(b.placeholder) || natural(a.dir, b.dir)

/**
 * Group index lines into albums. Lines may be the whole allmods.txt or the filtered cache; anything
 * outside the indexed trees is skipped.
 */
export function buildModlandIndex(text: Buffer | string, fetchedAt: number): ModlandIndex {
  const pending = new Map<string, Pending>()
  const files: Record<ModlandFamily, number> = { spc: 0, vgm: 0, nsf: 0, gbs: 0 }
  let skipped = 0
  forEachModlandLine(text, (size, path) => {
    const segs = path.split('/')
    const fam = FAMILY_BY_ROOT.get(segs[0])
    if (!fam || !fam.exts.includes(extOf(path))) return void skipped++
    let rest = segs.slice(1)
    let systemFolder: string | null = null
    if (fam.systemLevel) {
      systemFolder = rest[0]
      const sys = MODLAND_VGM_SYSTEMS[modlandKey(systemFolder ?? '')]
      if (!sys?.playable) return void skipped++
      rest = rest.slice(1)
    }
    if (rest.some((s) => !s.trim())) return void skipped++
    let ref: string
    let name: string
    let dir: string
    let rel: string
    let who: { composers: string[]; placeholder: boolean }
    if (fam.multi) {
      // <composer>/[coop-…/]<game>.nsf (or a bare <game>.nsf)
      const file = rest[rest.length - 1]
      who = composersOf(rest.length >= 2 ? rest[0] : null, rest.slice(1, -1))
      ref = `${fam.key}/${modlandKey(rest.join('/'))}`
      name = stemOf(file)
      dir = segs.slice(0, segs.length - 1).join('/')
      rel = file
    } else {
      // <composer>/[coop-…/]<game>/<song>: the game is the first folder after the composer that isn't a coop- folder.
      let g = 1
      while (g < rest.length - 1 && /^coop-/i.test(rest[g])) g++
      if (rest.length < 3 || g >= rest.length - 1) return void skipped++
      who = composersOf(rest[0], rest.slice(1, g))
      name = rest[g].trim()
      // '- misc' and similar: odds and ends of no particular game.
      if (/^-\s/.test(name)) return void skipped++
      ref = fam.systemLevel ? `${fam.key}/${modlandKey(systemFolder!)}/${modlandKey(name)}` : `${fam.key}/${modlandKey(name)}`
      const head = segs.length - rest.length
      dir = segs.slice(0, head + g + 1).join('/')
      rel = rest.slice(g + 1).join('/')
    }
    files[fam.key]++
    let p = pending.get(ref)
    if (!p) {
      p = { family: fam, ref, name, system: systemFolder, members: new Map() }
      pending.set(ref, p)
    }
    let m = p.members.get(dir)
    if (!m) {
      m = { dir, composers: who.composers, placeholder: who.placeholder, files: [] }
      p.members.set(dir, m)
    }
    m.files.push({ rel, size })
  })

  // Multi-song files: identical copies (same name and size) under several composer folders are one album.
  const byCopy = new Map<string, Pending[]>()
  for (const p of pending.values()) {
    if (!p.family.multi) continue
    const m = [...p.members.values()][0]
    const k = `${p.family.key}\u0000${modlandKey(p.name)}.${extOf(m.files[0].rel)}\u0000${m.files[0].size}`
    const list = byCopy.get(k)
    if (list) list.push(p)
    else byCopy.set(k, [p])
  }
  for (const list of byCopy.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => memberOrder([...a.members.values()][0], [...b.members.values()][0]))
    const keep = list[0]
    const km = [...keep.members.values()][0]
    for (const other of list.slice(1)) {
      for (const om of other.members.values()) for (const c of om.composers) if (!km.composers.some((x) => x.toLowerCase() === c.toLowerCase())) km.composers.push(c)
      pending.delete(other.ref)
      files[other.family.key]--
    }
  }

  const byFamily = new Map<ModlandFamily, ModlandAlbumEntry[]>(MODLAND_FAMILIES.map((f) => [f.key, []]))
  const byRef = new Map<string, ModlandAlbumEntry>()
  for (const p of pending.values()) {
    const members = [...p.members.values()].sort(memberOrder)
    // Multi-song albums are one file (case variants of a path collapse into one ref: keep the biggest).
    if (p.family.multi && (members.length > 1 || members[0].files.length > 1)) {
      const all = members.flatMap((m) => m.files.map((f) => ({ m, f })))
      all.sort((a, b) => b.f.size - a.f.size)
      members.splice(0, members.length, { ...all[0].m, files: [all[0].f] })
    }
    const composers: string[] = []
    for (const m of members) for (const c of m.composers) if (!composers.some((x) => x.toLowerCase() === c.toLowerCase())) composers.push(c)
    const nameFrom = p.family.multi ? stemOf(members[0].files[0].rel) : baseName(members[0].dir)
    const { title, system } = modlandTitle(nameFrom, p.family.key)
    const fileCount = members.reduce((n, m) => n + m.files.length, 0)
    const entry: ModlandAlbumEntry = {
      family: p.family.key,
      ref: p.ref,
      title,
      platform: modlandPlatform(p.family.key, system, p.system),
      composers,
      members,
      fileCount,
      sizeBytes: members.reduce((n, m) => n + m.files.reduce((s, f) => s + f.size, 0), 0),
      search: foldText(title),
      squash: alnum(title)
    }
    byFamily.get(p.family.key)!.push(entry)
    byRef.set(entry.ref, entry)
  }
  for (const list of byFamily.values()) list.sort((a, b) => natural(a.title, b.title) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
  return { fetchedAt, byFamily, byRef, files, skipped }
}

/**
 * NSF files under named composer folders are mostly chiptune musicians' own tracks and covers
 * (RushJet1, Tsu…), with real game rips (Kinuyo Yamashita…) in between; no path rule separates
 * them. Those albums are kept only for games the catalog already knows (KHInsider and Zophar crawl
 * first), and obvious fan works are dropped outright.
 */
export function isMusicianFolder(a: Pick<ModlandAlbumEntry, 'family' | 'members'>): boolean {
  return a.family === 'nsf' && a.members.every((m) => !m.placeholder)
}
const FAN_WORK = /\b(?:remix(?:es)?|covers?|arrange(?:d|ment)?s?|tribute|medley|originals?|demo|album|ep|chiptunes?)\b/i

export function modlandAlbumHit(a: ModlandAlbumEntry): AlbumHit {
  return {
    ...(isMusicianFolder(a) ? { onlyForKnownGame: true } : {}),
    provider: MODLAND_ID,
    ref: a.ref,
    title: a.title,
    titleFromRef: false,
    platforms: [a.platform],
    kind: 'gamerip',
    typeLabel: 'Chip rip',
    year: null,
    thumb: null,
    cover: null,
    catalogNo: null,
    addedAt: null
  }
}

// ---------------------------------------------------------------------------
// Locators and streams

/** https URL of a file (each path segment URL-encoded). */
export function modlandFileUrl(path: string): string {
  return MODLAND_FILES_BASE + path.split('/').map(encodeURIComponent).join('/')
}

export function modlandLocator(path: string, subsong?: number | null): string {
  return subsong != null ? `${path}#${subsong}` : path
}

export function parseModlandLocator(locator: string): { path: string; subsong: number | null } | null {
  const m = /^(.+)#(\d+)$/.exec(locator)
  const sub = m && MULTI_EXTS.has(extOf(m[1])) ? { path: m[1], subsong: Number(m[2]) } : { path: locator, subsong: null }
  const root = sub.path.split('/')[0]
  const fam = FAMILY_BY_ROOT.get(root)
  if (!fam || !fam.exts.includes(extOf(sub.path)) || sub.path.split('/').some((s) => !s || s === '.' || s === '..')) return null
  if (fam.multi !== (sub.subsong != null)) return null
  return sub
}

export function modlandSource(path: string, subsong: number | null): EngineSource {
  const source: EngineSource = { kind: 'http', url: modlandFileUrl(path), cacheKey: `modland:${path}`, formatHint: extOf(path) }
  if (subsong != null) source.subsong = subsong
  return source
}

export function modlandStream(path: string, subsong: number | null, sizeBytes: number | null): StreamInfo {
  // Like the chip provider's rips: rendered live, not a lossless file.
  return { provider: MODLAND_ID, source: modlandSource(path, subsong), format: 'chip', lossless: false, bitrateKbps: null, sizeBytes, expiresAt: null }
}

// ---------------------------------------------------------------------------
// Multi-song file headers

export interface ChipFileInfo {
  /** Songs in the file (after an NSFE playlist, when there is one). */
  songs: number
  /** Song the file starts with (0-based). */
  first: number
  title: string | null
  artist: string | null
  copyright: string | null
  /** NSFE: per-song title and length (album-mode estimate: length + fade). */
  tracks: { title: string | null; durationMs: number | null }[] | null
}

const PLACEHOLDER_TEXT = /^(?:<\s*\?\s*>|\?+|n\/?a|unknown|-+|none)$/i

function decodeText(b: Buffer): string | null {
  const end = b.indexOf(0)
  const raw = end >= 0 ? b.subarray(0, end) : b
  let s: string
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    try {
      s = new TextDecoder('shift_jis', { fatal: true }).decode(raw)
    } catch {
      s = raw.toString('latin1')
    }
  }
  s = s.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s && !PLACEHOLDER_TEXT.test(s) ? s : null
}

/** NSF header (0x80 bytes): 'NESM\x1a', songs at 6, first song (1-based) at 7, strings at 0x0E/0x2E/0x4E. */
export function parseNsfHeader(b: Buffer): ChipFileInfo | null {
  if (b.length < 0x6e || b.toString('latin1', 0, 5) !== 'NESM\x1a') return null
  const songs = Math.max(1, b[6])
  return {
    songs,
    first: Math.min(songs - 1, Math.max(0, b[7] - 1)),
    title: decodeText(b.subarray(0x0e, 0x2e)),
    artist: decodeText(b.subarray(0x2e, 0x4e)),
    copyright: decodeText(b.subarray(0x4e, 0x6e)),
    tracks: null
  }
}

/** GBS header (0x70 bytes): 'GBS', version, songs at 4, first song (1-based) at 5, strings at 0x10/0x30/0x50. */
export function parseGbsHeader(b: Buffer): ChipFileInfo | null {
  if (b.length < 0x70 || b.toString('latin1', 0, 3) !== 'GBS') return null
  const songs = Math.max(1, b[4])
  return {
    songs,
    first: Math.min(songs - 1, Math.max(0, b[5] - 1)),
    title: decodeText(b.subarray(0x10, 0x30)),
    artist: decodeText(b.subarray(0x30, 0x50)),
    copyright: decodeText(b.subarray(0x50, 0x70)),
    tracks: null
  }
}

/**
 * NSFE: 'NSFE' then chunks (u32 size, 4-char id, data): INFO (songs at 8, first song 0-based at 9),
 * auth (game, artist, copyright, ripper), tlbl (titles), time / fade (s32 ms, -1 = unset), plst
 * (play order; libgme then numbers sub-songs by playlist position).
 */
export function parseNsfe(b: Buffer): ChipFileInfo | null {
  if (b.length < 8 || b.toString('latin1', 0, 4) !== 'NSFE') return null
  let info: Buffer | null = null
  let auth: (string | null)[] = []
  let tlbl: (string | null)[] = []
  let time: number[] = []
  let fade: number[] = []
  let plst: number[] | null = null
  const strings = (d: Buffer) => {
    const out: (string | null)[] = []
    let s = 0
    for (let i = 0; i < d.length; i++) {
      if (d[i] === 0) {
        out.push(decodeText(d.subarray(s, i)))
        s = i + 1
      }
    }
    if (s < d.length) out.push(decodeText(d.subarray(s)))
    return out
  }
  const ints = (d: Buffer) => Array.from({ length: Math.floor(d.length / 4) }, (_, i) => d.readInt32LE(i * 4))
  for (let p = 4; p + 8 <= b.length; ) {
    const size = b.readUInt32LE(p)
    const id = b.toString('latin1', p + 4, p + 8)
    const data = b.subarray(p + 8, Math.min(b.length, p + 8 + size))
    p += 8 + size
    if (id === 'NEND') break
    if (id === 'INFO') info = data
    else if (id === 'auth') auth = strings(data)
    else if (id === 'tlbl') tlbl = strings(data)
    else if (id === 'time') time = ints(data)
    else if (id === 'fade') fade = ints(data)
    else if (id === 'plst') plst = [...data]
  }
  if (!info || info.length < 9) return null
  const total = Math.max(1, info[8])
  const order = plst?.length ? plst : Array.from({ length: total }, (_, i) => i)
  const tracks = order.map((t) => {
    const len = time[t]
    const f = fade[t]
    return { title: tlbl[t] ?? null, durationMs: len != null && len > 0 ? len + (f != null && f >= 0 ? f : DEFAULT_FADE_MS) : null }
  })
  return {
    songs: order.length,
    first: plst?.length ? 0 : Math.min(total - 1, info.length > 9 ? info[9] : 0),
    title: auth[0] ?? null,
    artist: auth[1] ?? null,
    copyright: auth[2] ?? null,
    tracks
  }
}

export function parseChipHeader(ext: string, b: Buffer): ChipFileInfo | null {
  if (ext === 'nsfe') return parseNsfe(b)
  if (ext === 'nsf') return parseNsfHeader(b)
  if (ext === 'gbs') return parseGbsHeader(b)
  return null
}

/** "1988 Nintendo" / "(C)1993 Hudson Soft" → year and publisher. */
export function parseCopyright(s: string | null): { year: number | null; publisher: string | null } {
  if (!s) return { year: null, publisher: null }
  const y = /\b(19[7-9]\d|20[0-4]\d)\b/.exec(s)
  const publisher = s
    .replace(/\b(19|20)\d\d(?:\s*[-,/]\s*(19|20)?\d\d)*\b/g, ' ')
    .replace(/©|\(c\)|\bcopyright\b|℗/gi, ' ')
    .replace(/^[\s,.\-/]+|[\s,.\-/]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return { year: y ? Number(y[1]) : null, publisher: publisher && /\p{L}/u.test(publisher) ? publisher : null }
}

function splitArtists(s: string | null): string[] {
  if (!s) return []
  return s
    .split(/\s*(?:,|;|&|\/|\band\b)\s*/i)
    .map((n) => n.trim())
    .filter((n) => n.length >= 2 && !PLACEHOLDER_TEXT.test(n))
}

const NON_LATIN = /[\u0400-\u04ff\u0370-\u03ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff66-\uff9f]/

// ---------------------------------------------------------------------------
// Album detail

/** Tracks of a one-file-per-song album (SPC / VGM), natural order, numbered "101 …" → disc 1 track 1. */
export function folderTracks(a: ModlandAlbumEntry): ProviderTrack[] {
  const seen = new Set<string>()
  const files: { path: string; rel: string; size: number }[] = []
  for (const m of a.members) {
    for (const f of m.files) {
      const k = modlandKey(f.rel)
      if (seen.has(k)) continue
      seen.add(k)
      files.push({ path: `${m.dir}/${f.rel}`, rel: f.rel, size: f.size })
    }
  }
  files.sort((x, y) => natural(baseName(x.rel), baseName(y.rel)) || natural(x.path, y.path))
  const names = modlandTrackTitles(
    files.map((f) => stemOf(baseName(f.rel))),
    a.title
  )
  // Three-digit numbers across (most of) the set are disc + track ("101 …", "201 …"); unnumbered
  // files (sound effects, extras) sort last and continue the numbering.
  const nums = names.map((n) => n.number).filter((n): n is number => n != null)
  const discNumbered = nums.length >= 2 && nums.length * 2 >= names.length && nums.every((n) => n >= 101 && n < 1000 && n % 100 !== 0)
  let disc = 1
  let prev = 0
  return files.map((f, i) => {
    const n = names[i].number
    if (n == null) prev++
    else if (!discNumbered) prev = n
    else {
      if (Math.floor(n / 100) !== disc) disc = Math.floor(n / 100)
      prev = n % 100
    }
    return {
      disc,
      number: prev,
      title: names[i].title,
      durationMs: null,
      locator: modlandLocator(f.path),
      files: [{ format: 'chip', sizeBytes: f.size }],
      composers: [],
      streams: [modlandStream(f.path, null, f.size)]
    }
  })
}

/** Tracks of a multi-song file (NSF / NSFE / GBS) from its header. */
export function multiTracks(path: string, size: number | null, info: ChipFileInfo, albumTitle: string): ProviderTrack[] {
  const out: ProviderTrack[] = []
  for (let i = 0; i < info.songs; i++) {
    const t = info.tracks?.[i]
    out.push({
      disc: 1,
      number: i + 1,
      title: t?.title || (info.songs === 1 ? albumTitle : `Song ${i + 1}`),
      durationMs: t?.durationMs ?? null,
      locator: modlandLocator(path, i),
      files: [{ format: 'chip', sizeBytes: size }],
      composers: [],
      streams: [modlandStream(path, i, size)]
    })
  }
  return out
}

export function modlandAlbum(a: ModlandAlbumEntry, tracks: ProviderTrack[], info: ChipFileInfo | null = null): ProviderAlbum {
  const hit = modlandAlbumHit(a)
  let title = a.title
  const altTitles: string[] = []
  // The header's title is usually the same name better written ("Super Mario Bros. 3" for "super mario bros 3").
  if (info?.title) {
    const bare = a.title.replace(/(?:\s*[([][^()[\]]*[)\]])+$/, '')
    if (alnum(info.title) === alnum(a.title) && !/[([]/.test(a.title)) title = info.title
    else if (alnum(info.title) !== alnum(a.title) && alnum(info.title) !== alnum(bare)) altTitles.push(info.title)
  }
  const { year, publisher } = parseCopyright(info?.copyright ?? null)
  const composers = a.composers.length ? a.composers : splitArtists(info?.artist ?? null)
  return {
    ...hit,
    title,
    year,
    altTitles,
    titleOriginal: altTitles.find((t) => NON_LATIN.test(t)) ?? null,
    developers: [],
    publishers: publisher ? [publisher] : [],
    composers,
    images: [],
    description: null,
    formats: ['chip'],
    totalSizes: { chip: a.sizeBytes },
    externalId: null,
    tracks
  }
}

// ---------------------------------------------------------------------------
// Cache file: '#GHOST modland-index v1 fetchedAt=<ms>' then the kept allmods.txt lines.

export function encodeModlandCache(lines: Buffer, fetchedAt: number): Buffer {
  return Buffer.concat([Buffer.from(`${CACHE_MAGIC} v${CACHE_VERSION} fetchedAt=${fetchedAt}\n`, 'utf8'), lines])
}

export function decodeModlandCacheHeader(buf: Buffer): { fetchedAt: number } | null {
  const nl = buf.indexOf(10)
  const head = buf.toString('utf8', 0, nl < 0 ? Math.min(buf.length, 200) : nl)
  const m = new RegExp(`^${CACHE_MAGIC} v(\\d+) fetchedAt=(\\d+)`).exec(head)
  if (!m || Number(m[1]) !== CACHE_VERSION) return null
  return { fetchedAt: Number(m[2]) }
}

// ---------------------------------------------------------------------------
// Provider

export interface ModlandProviderDeps {
  http: HttpClient
  /** Directory for the parsed index cache. */
  cacheDir: string
  log?: (msg: string) => void
  now?: () => number
}

const tick = () => new Promise<void>((r) => setImmediate(r))

export class ModlandProvider implements IndexProvider {
  readonly id = MODLAND_ID
  readonly name = 'Modland'
  /** The crawl only re-reads the in-memory index; it's worth repeating when the download is due. */
  readonly indexRefreshMs = MODLAND_INDEX_MAX_AGE_MS
  readonly indexPageDelayMs = 0
  /** Named NSF folders are kept only for known games: let Zophar's / IA's games land first. */
  readonly indexAfterOthers = true
  readonly indexEstimateMs = 15_000

  private index: ModlandIndex | null = null
  private loading: Promise<ModlandIndex> | null = null
  private cacheLoading: Promise<ModlandIndex | null> | null = null
  private retryAt = 0
  private headers = new Map<string, Promise<ChipFileInfo>>()
  private readonly now: () => number
  private readonly log: (msg: string) => void

  constructor(private readonly deps: ModlandProviderDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
  }

  indexSections(): IndexSection[] {
    return MODLAND_FAMILIES.map((f) => ({ key: f.key, label: f.label }))
  }

  /**
   * The index: from memory, else the disk cache, else (or when older than MODLAND_INDEX_MAX_AGE_MS)
   * a download. `allowStale`: any index in memory or on disk will do (album lookups, search).
   */
  async loadIndex(opts: { force?: boolean; priority?: ProviderCallOptions['priority']; allowStale?: boolean } = {}): Promise<ModlandIndex> {
    if (!opts.force) {
      const idx = opts.allowStale ? await this.fromCache() : this.index
      if (idx && (opts.allowStale || this.fresh(idx) || this.now() < this.retryAt)) return idx
    }
    this.loading ??= this.load(!!opts.force, opts.priority ?? 2).finally(() => {
      this.loading = null
    })
    return this.loading
  }

  /** The index in memory, else the one on disk (whatever its age), else null. */
  private fromCache(): Promise<ModlandIndex | null> {
    if (this.index) return Promise.resolve(this.index)
    this.cacheLoading ??= this.readCache()
      .then((c) => {
        if (c && !this.index) this.index = c
        return this.index
      })
      .finally(() => {
        this.cacheLoading = null
      })
    return this.cacheLoading
  }

  private fresh(i: { fetchedAt: number }): boolean {
    return this.now() - i.fetchedAt < MODLAND_INDEX_MAX_AGE_MS
  }

  private cachePath(): string {
    return join(this.deps.cacheDir, CACHE_FILE)
  }

  private async readCache(): Promise<ModlandIndex | null> {
    let buf: Buffer
    try {
      buf = await readFile(this.cachePath())
    } catch {
      return null
    }
    const head = decodeModlandCacheHeader(buf)
    if (!head) return null
    const t0 = performance.now()
    const idx = buildModlandIndex(buf, head.fetchedAt)
    this.log(`index cache: ${idx.byRef.size} albums in ${Math.round(performance.now() - t0)} ms`)
    return idx
  }

  private async load(force: boolean, priority: NonNullable<ProviderCallOptions['priority']>): Promise<ModlandIndex> {
    const cached = await this.fromCache()
    if (cached && !force && this.fresh(cached)) return cached
    try {
      const idx = await this.download(priority)
      this.index = idx
      this.retryAt = 0
      return idx
    } catch (e) {
      if (this.index && !isNetError(e, 'aborted')) {
        this.log(`index refresh failed, keeping the copy from ${new Date(this.index.fetchedAt).toISOString()}: ${(e as Error).message}`)
        this.retryAt = this.now() + REFRESH_RETRY_MS
        return this.index
      }
      throw e
    }
  }

  private async download(priority: NonNullable<ProviderCallOptions['priority']>): Promise<ModlandIndex> {
    const res = await this.deps.http.fetchBytes(MODLAND_INDEX_URL, { priority, timeoutMs: 180_000, retries: 2 })
    const fetchedAt = this.now()
    const t0 = performance.now()
    const { data } = extractZipEntry(res.bytes, 'allmods.txt')
    await tick()
    const lines = filterModlandLines(data)
    await tick()
    const idx = buildModlandIndex(lines, fetchedAt)
    const ms = Math.round(performance.now() - t0)
    if (!idx.byRef.size) throw new NetError('parse', 'allmods.txt has none of the expected folders', { url: MODLAND_INDEX_URL })
    const counts = MODLAND_FAMILIES.map((f) => `${f.key} ${idx.byFamily.get(f.key)!.length}/${idx.files[f.key]}`).join(', ')
    this.log(`index: ${res.bytes.length} B zip → ${data.length} B text → ${lines.length} B kept; albums/files ${counts}; ${ms} ms`)
    try {
      await mkdir(this.deps.cacheDir, { recursive: true })
      const tmp = `${this.cachePath()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(tmp, encodeModlandCache(lines, fetchedAt))
      await rename(tmp, this.cachePath())
    } catch (e) {
      this.log(`index cache write failed: ${(e as Error).message}`)
    }
    return idx
  }

  async fetchIndexPage(sectionKey: string, page: number, opts: ProviderCallOptions = {}): Promise<IndexPage> {
    const fam = modlandFamily(sectionKey)
    if (!fam) throw new Error(`unknown Modland index section ${sectionKey}`)
    // A refresh only happens at the start of a section, so pages of one section share one index.
    const idx = await this.loadIndex({ force: opts.force && page <= 1, priority: opts.priority, allowStale: page > 1 })
    if (opts.signal?.aborted) throw new NetError('aborted', 'request aborted')
    const list = idx.byFamily.get(fam.key) ?? []
    const totalPages = Math.max(1, Math.ceil(list.length / MODLAND_PAGE_SIZE))
    const items = list
      .slice((page - 1) * MODLAND_PAGE_SIZE, page * MODLAND_PAGE_SIZE)
      .filter((a) => !(isMusicianFolder(a) && FAN_WORK.test(a.title)))
      .map(modlandAlbumHit)
    return { items, page, totalPages, totalAlbums: list.length }
  }

  /** Title search over the index (every word must appear; punctuation-insensitive). */
  async searchAlbums(q: string, opts: ProviderCallOptions = {}): Promise<AlbumHit[]> {
    const query = foldText(q)
    if (!query) return []
    const idx = await this.loadIndex({ priority: opts.priority ?? 0, allowStale: true })
    const words = query.split(' ').filter(Boolean)
    const squashed = alnum(query)
    const out: AlbumHit[] = []
    for (const list of idx.byFamily.values()) {
      for (const a of list) {
        if (words.every((w) => a.search.includes(w)) || (squashed.length >= 3 && a.squash.includes(squashed))) out.push(modlandAlbumHit(a))
        if (out.length >= 200) return out
      }
    }
    return out
  }

  private fileInfo(path: string, size: number | null, opts: ProviderCallOptions): Promise<ChipFileInfo> {
    let p = this.headers.get(path)
    if (!p) {
      p = this.readHeader(path, size, opts)
      p.catch(() => this.headers.delete(path))
      this.headers.set(path, p)
      if (this.headers.size > 256) this.headers.delete(this.headers.keys().next().value!)
    }
    return p
  }

  private async readHeader(path: string, size: number | null, opts: ProviderCallOptions): Promise<ChipFileInfo> {
    const ext = extOf(path)
    const url = modlandFileUrl(path)
    if (ext === 'nsfe' && size != null && size > MAX_NSFE_BYTES) throw new NetError('parse', `${path} is too big for an NSFE`, { url })
    // NSF / GBS headers fit in 128 bytes; NSFE metadata is spread over the file (they're small).
    const headers = ext === 'nsfe' ? undefined : { Range: 'bytes=0-127' }
    const res = await this.deps.http.fetchBytes(url, { headers, priority: opts.priority ?? 0, signal: opts.signal })
    const info = parseChipHeader(ext, res.bytes)
    if (!info) throw new NetError('parse', `not a valid ${ext.toUpperCase()} file: ${path}`, { url })
    return info
  }

  async getAlbum(ref: string, opts: ProviderCallOptions = {}): Promise<ProviderAlbum> {
    const idx = await this.loadIndex({ priority: opts.priority ?? 0, allowStale: true })
    const a = idx.byRef.get(ref)
    if (!a) throw new NetError('not_found', `Modland has no "${ref}"`)
    const fam = FAMILY_BY_KEY.get(a.family)!
    if (!fam.multi) return modlandAlbum(a, folderTracks(a))
    const m = a.members[0]
    const f = m.files[0]
    const path = `${m.dir}/${f.rel}`
    const info = await this.fileInfo(path, f.size, opts)
    const album = modlandAlbum(a, [], info)
    album.tracks = multiTracks(path, f.size, info, album.title)
    return album
  }

  async resolveStream(locator: string): Promise<StreamInfo[]> {
    const l = parseModlandLocator(locator)
    if (!l) throw new NetError('parse', `bad Modland locator: ${locator}`)
    return [modlandStream(l.path, l.subsong, null)]
  }
}
