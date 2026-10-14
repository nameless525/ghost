// Download path templating and filename sanitisation that is safe on macOS, Windows and Linux.
//
// Template syntax: `{key}` placeholders, `/` separates folders, e.g.
//   {game}/{album} ({year})/{disc}-{track} {title}
// Keys: game, album, year, disc, track (zero-padded to 2), title, composer, platform, kind, catalog.
// Empty values drop their surrounding brackets ("Album ()" -> "Album"). The extension is appended.
import { homedir } from 'node:os'
import type { AudioFormat } from '../../shared/types'
import type { EngineSource } from '../engine/types'

export type TemplateVars = Partial<Record<'game' | 'album' | 'year' | 'disc' | 'track' | 'title' | 'composer' | 'platform' | 'kind' | 'catalog', string | number | null>>

/** Expand a leading `~` to the home directory (settings may hold a hand-typed path). */
export function expandHome(dir: string): string {
  return /^~(?=$|[\\/])/.test(dir) ? homedir() + dir.slice(1) : dir
}

/** Max bytes (UTF-8) per path segment. NAME_MAX is 255 on every target FS; leave room for " (n)" + ext. */
export const MAX_SEGMENT_BYTES = 180

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

function utf8Truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let out = ''
  let bytes = 0
  for (const ch of s) {
    // Iterating a string yields whole code points, so surrogate pairs are never split.
    const b = Buffer.byteLength(ch, 'utf8')
    if (bytes + b > maxBytes) break
    out += ch
    bytes += b
  }
  return out
}

function trimEdges(s: string): string {
  // Leading dots hide files on Unix; trailing dots/spaces are stripped (or rejected) by Windows.
  return s.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '')
}

/** Make one path segment (a folder or file stem) safe on all three OSes. */
export function sanitizeSegment(input: string, maxBytes = MAX_SEGMENT_BYTES): string {
  let s = String(input ?? '').normalize('NFC')
  s = s
    .replace(/[\t\n\r\v\f]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '') // zero-width + bidi controls
    .replace(/:\s+/g, ' - ')
    .replace(/:/g, '-')
    .replace(/[/\\|]/g, '-')
    .replace(/"/g, "'")
    .replace(/[<>?*]/g, '')
    .replace(/\s+/g, ' ')
  s = trimEdges(s)
  if (s === '' || s === '.' || s === '..') s = '_'
  s = trimEdges(utf8Truncate(s, maxBytes)) || '_'
  // Reserved device names on Windows, including when followed by an extension ("CON.txt").
  const base = s.split('.')[0]
  if (WINDOWS_RESERVED.test(base)) s = base + '_' + s.slice(base.length)
  return s
}

function cleanSegment(seg: string): string {
  let s = seg
  // Brackets left empty by missing values: "Album ()" / "[ - ]".
  for (let i = 0; i < 3; i++) s = s.replace(/[([{]\s*[-–—_,.]*\s*[)\]}]/g, '')
  s = s.replace(/\s+/g, ' ').trim()
  // Dangling separators at the edges: " - Title" / "Title -".
  s = s.replace(/^[\s\-–—_,.]+/, '').replace(/[\s\-–—_,]+$/, '')
  return s
}

const pad2 = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  return Number.isFinite(n) ? String(Math.trunc(n)).padStart(2, '0') : String(v)
}

/**
 * Render a naming template into relative path segments (folders..., file stem), sanitised.
 * The extension is not included.
 */
export function renderTemplateSegments(template: string, vars: TemplateVars): string[] {
  const tpl = (template || '{title}').replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '')
  const value = (key: string): string => {
    const raw = key === 'track' ? pad2(vars.track) : (vars as Record<string, unknown>)[key]
    if (raw === null || raw === undefined) return ''
    // A value must never introduce a new folder level.
    return String(raw).replace(/[/\\]/g, '-')
  }
  const rendered = tpl.replace(/\{(\w+)\}/g, (_, k: string) => value(k.toLowerCase()))
  const parts = rendered.split('/').map(cleanSegment).filter((p) => p !== '' && p !== '.' && p !== '..' && p !== '~')
  if (parts.length === 0) parts.push(cleanSegment(String(vars.title ?? '')) || 'Untitled')
  return parts.map((p) => sanitizeSegment(p))
}

/** Shrink the longest segments until `base/<segments>.ext` fits within maxLen characters. */
export function fitPathLength(baseDir: string, segments: string[], ext: string, maxLen: number): string[] {
  const segs = [...segments]
  const sep = 1
  const total = () => baseDir.length + segs.reduce((n, s) => n + sep + s.length, 0) + (ext ? ext.length + 1 : 0) + 4 // + " (n)"
  let guard = 0
  while (total() > maxLen && guard++ < 1000) {
    let longest = 0
    for (let i = 1; i < segs.length; i++) if (segs[i].length > segs[longest].length) longest = i
    const cur = segs[longest]
    if (cur.length <= 8) break
    const over = total() - maxLen
    const keep = Math.max(8, cur.length - Math.max(1, over))
    segs[longest] = sanitizeSegment(Array.from(cur).slice(0, keep).join(''))
  }
  return segs
}

export interface BuildPathOptions {
  baseDir: string
  template: string
  vars: TemplateVars
  ext: string
  platform?: NodeJS.Platform
}

/** Absolute destination path for a download (without collision handling). */
export function buildDownloadPath({ baseDir, template, vars, ext, platform = process.platform }: BuildPathOptions): string {
  const sep = platform === 'win32' ? '\\' : '/'
  const base = baseDir.replace(/[\\/]+$/, '')
  // Windows MAX_PATH (260 incl. NUL) unless long paths are enabled; macOS PATH_MAX is 1024.
  const maxLen = platform === 'win32' ? 259 : platform === 'darwin' ? 1023 : 4095
  const segs = fitPathLength(base, renderTemplateSegments(template, vars), ext, maxLen)
  const cleanExt = ext.replace(/^\.+/, '').toLowerCase()
  return base + sep + segs.join(sep) + (cleanExt ? '.' + cleanExt : '')
}

/** Append " (2)", " (3)", ... before the extension until `taken` says the path is free. */
export function uniquePath(path: string, taken: (p: string) => boolean): string {
  if (!taken(path)) return path
  const m = /^(.*?)(\.[^./\\]{1,8})?$/.exec(path)!
  const stem = m[1]
  const ext = m[2] ?? ''
  for (let i = 2; i < 10000; i++) {
    const p = `${stem} (${i})${ext}`
    if (!taken(p)) return p
  }
  return `${stem} (${Date.now().toString(36)})${ext}`
}

const AUDIO_EXTS = new Set([
  'mp3', 'flac', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'webm', 'mka', 'wav', 'aif', 'aiff', 'alac', 'wma',
  // chiptune and game-engine formats
  'nsf', 'nsfe', 'spc', 'gbs', 'vgm', 'vgz', 'hes', 'kss', 'ay', 'sap', 'gym', 'adx', 'hca', 'brstm', 'bcstm', 'bfstm',
  'fsb', 'wem', 'mod', 'xm', 'it', 's3m', 'umx', 'psf', 'psf2', 'minipsf', '2sf', 'mini2sf', 'usf', 'miniusf', 'gsf',
  'minigsf', 'ssf', 'minissf'
])

const FORMAT_EXT: Record<AudioFormat, string> = {
  mp3: 'mp3',
  flac: 'flac',
  m4a: 'm4a',
  aac: 'm4a',
  ogg: 'ogg',
  opus: 'opus',
  wav: 'wav',
  chip: 'bin',
  unknown: 'bin'
}

function extOf(pathOrUrl: string): string | null {
  let p = pathOrUrl
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) p = decodeURIComponent(new URL(p).pathname)
  } catch {
    /* not a URL */
  }
  const m = /\.([a-z0-9]{1,8})$/i.exec(p.split(/[\\/]/).pop() ?? '')
  return m ? m[1].toLowerCase() : null
}

/** File extension for a source, preferring what the stream actually is (saved as-is, never re-encoded). */
export function extensionFor(format: AudioFormat, source: EngineSource): string {
  const fromLoc = extOf(source.kind === 'http' ? source.url : source.path)
  if (fromLoc && AUDIO_EXTS.has(fromLoc)) return fromLoc
  const hint = source.formatHint?.toLowerCase().replace(/^\./, '')
  if (hint && AUDIO_EXTS.has(hint)) return hint
  return FORMAT_EXT[format] ?? 'bin'
}
