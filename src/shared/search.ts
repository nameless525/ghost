// Search syntax (DESIGN §7.6): free text plus `key op value` filters.
//
//   boss platform=snes intensity>5 length<4m composer="yoko shimomura" -remix
//
// Pure TypeScript with no Node or DOM APIs: the main process compiles the parse result to SQL,
// and the renderer uses the same tokens to highlight the search box. The parser never throws;
// anything it can't understand becomes free text or an `invalid` token with an error message.

export const SEARCH_KEYS = [
  'composer',
  'game',
  'franchise',
  'platform',
  'year',
  'length',
  'bpm',
  'intensity',
  'source',
  'kind',
  'liked',
  'downloaded'
] as const
export type SearchKey = (typeof SEARCH_KEYS)[number]

export type SearchOp = '=' | '!=' | '>' | '<' | '>=' | '<='

export type SearchValueKind = 'text' | 'number' | 'year' | 'duration' | 'bool' | 'kind' | 'source'

export const SEARCH_KEY_KIND: Record<SearchKey, SearchValueKind> = {
  composer: 'text',
  game: 'text',
  franchise: 'text',
  platform: 'text',
  year: 'year',
  length: 'duration',
  bpm: 'number',
  intensity: 'number',
  source: 'source',
  kind: 'kind',
  liked: 'bool',
  downloaded: 'bool'
}

/** Accepted spellings for each key (lowercase). */
export const SEARCH_KEY_ALIASES: Record<string, SearchKey> = {
  composer: 'composer',
  composers: 'composer',
  artist: 'composer',
  comp: 'composer',
  game: 'game',
  franchise: 'franchise',
  series: 'franchise',
  platform: 'platform',
  platforms: 'platform',
  plat: 'platform',
  console: 'platform',
  system: 'platform',
  year: 'year',
  yr: 'year',
  length: 'length',
  len: 'length',
  duration: 'length',
  dur: 'length',
  time: 'length',
  bpm: 'bpm',
  tempo: 'bpm',
  intensity: 'intensity',
  stars: 'intensity',
  star: 'intensity',
  sr: 'intensity',
  difficulty: 'intensity',
  diff: 'intensity',
  source: 'source',
  src: 'source',
  format: 'source',
  fmt: 'source',
  kind: 'kind',
  type: 'kind',
  liked: 'liked',
  like: 'liked',
  fav: 'liked',
  favorite: 'liked',
  favourite: 'liked',
  loved: 'liked',
  downloaded: 'downloaded',
  download: 'downloaded',
  dl: 'downloaded',
  offline: 'downloaded'
}

/** Canonical album kinds accepted by `kind=` (values match AlbumKind in types.ts). */
export const KIND_ALIASES: Record<string, string> = {
  ost: 'ost',
  soundtrack: 'ost',
  soundtracks: 'ost',
  osv: 'ost',
  original: 'ost',
  official: 'ost',
  gamerip: 'gamerip',
  gamerips: 'gamerip',
  rip: 'gamerip',
  rips: 'gamerip',
  arrange: 'arrange',
  arrangement: 'arrange',
  arrangements: 'arrange',
  arranged: 'arrange',
  arr: 'arrange',
  remix: 'remix',
  remixes: 'remix',
  single: 'single',
  singles: 'single',
  compilation: 'compilation',
  compilations: 'compilation',
  other: 'other',
  inspired: 'other',
  'inspired by': 'other'
}

/** `source=` values: audio formats, quality classes and provider ids. */
export const SOURCE_ALIASES: Record<string, string> = {
  flac: 'flac',
  mp3: 'mp3',
  ogg: 'ogg',
  vorbis: 'ogg',
  m4a: 'm4a',
  aac: 'aac',
  opus: 'opus',
  wav: 'wav',
  chip: 'chip',
  chiptune: 'chip',
  lossless: 'lossless',
  lossy: 'lossy',
  khinsider: 'khinsider',
  kh: 'khinsider',
  youtube: 'youtube',
  yt: 'youtube',
  archive: 'archive',
  ia: 'archive',
  bandcamp: 'bandcamp',
  bc: 'bandcamp',
  local: 'local',
  file: 'local',
  files: 'local'
}

export const SOURCE_FORMAT_VALUES = new Set(['flac', 'mp3', 'ogg', 'm4a', 'aac', 'opus', 'wav', 'chip'])

export interface SearchFilter {
  key: SearchKey
  op: SearchOp
  /** Value as typed (quotes removed). */
  value: string
  /** NFKC-folded lowercase value; canonical id for kind/source. */
  text: string
  /**
   * Numeric value: ms for length, plain number for year/bpm/intensity.
   * For `=`/`!=` on numeric keys the value is a half-open range [num, max).
   */
  num: number | null
  max: number | null
  bool: boolean | null
}

export type SearchTokenType = 'text' | 'phrase' | 'exclude' | 'key' | 'op' | 'value' | 'invalid'

export interface SearchToken {
  type: SearchTokenType
  /** Exact source slice. */
  text: string
  start: number
  end: number
}

export interface SearchError {
  start: number
  end: number
  message: string
}

export interface ParsedSearch {
  /** Free-text words and quoted phrases (folded). All must match. */
  terms: string[]
  /** Negated free text (`-word`, `-"a phrase"`). */
  excludes: string[]
  filters: SearchFilter[]
  /** Non-whitespace tokens in source order, for syntax highlighting. */
  tokens: SearchToken[]
  errors: SearchError[]
  /** No terms, excludes or filters. */
  empty: boolean
}

/** Fold text for matching: NFKC (full-width → ASCII, compatibility forms) + lowercase + trimmed spaces. */
export function foldText(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

const OPS: [string, SearchOp][] = [
  ['>=', '>='],
  ['<=', '<='],
  ['!=', '!='],
  ['<>', '!='],
  ['=>', '>='],
  ['=<', '<='],
  ['==', '='],
  ['=', '='],
  [':', '='],
  ['>', '>'],
  ['<', '<']
]

const QUOTE_PAIRS: Record<string, string> = { '"': '"', '“': '”', '”': '”', '「': '」', '『': '』', "'": "'" }
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c)
const isKeyChar = (c: string | undefined) => c !== undefined && /[a-z_]/i.test(c)

function readOp(s: string, i: number): [SearchOp, number] | null {
  for (const [lit, op] of OPS) if (s.startsWith(lit, i)) return [op, lit.length]
  return null
}

/** Read a quoted string starting at `i` (which is a quote). Returns [content, endIndex, closed]. */
function readQuoted(s: string, i: number): [string, number, boolean] {
  const close = QUOTE_PAIRS[s[i]]
  let j = i + 1
  while (j < s.length && s[j] !== close) j++
  if (j < s.length) return [s.slice(i + 1, j), j + 1, true]
  return [s.slice(i + 1), s.length, false]
}

/** Read until whitespace. */
function readWord(s: string, i: number): number {
  let j = i
  while (j < s.length && !isSpace(s[j])) j++
  return j
}

// ---------------------------------------------------------------------------
// Value parsing

/** Parse a duration like `4m`, `3:30`, `240s`, `240`, `4m30s`, `4.5m`, `1h2m`. Returns ms and the precision (ms) of the smallest unit typed. */
export function parseDuration(input: string): { ms: number; unit: number } | null {
  const s = foldText(input).replace(/\s+/g, '')
  if (!s) return null
  // h:mm:ss / m:ss
  let m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d+))?$/.exec(s)
  if (m) {
    const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number)
    if (parts.slice(1).some((p) => p >= 60)) return null
    const secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
    const frac = m[4] ? Number('0.' + m[4]) : 0
    return { ms: Math.round((secs + frac) * 1000), unit: m[4] ? 1 : 1000 }
  }
  // unit sequence: 1h2m3s, 4.5m, 240s, 240 (seconds)
  const re = /(\d+(?:\.\d+)?)(hours|hour|hrs|hr|h|minutes|minute|mins|min|ms|m|seconds|second|secs|sec|s)?/y
  let pos = 0
  let total = 0
  let unit = 1000
  let any = false
  while (pos < s.length) {
    re.lastIndex = pos
    m = re.exec(s)
    if (!m || m[0].length === 0) return null
    const n = Number(m[1])
    const u = m[2] ?? 's'
    const scale = u === 'ms' ? 1 : u.startsWith('h') ? 3600_000 : u.startsWith('m') ? 60_000 : 1000
    total += n * scale
    unit = m[1].includes('.') ? Math.max(1, scale / Math.pow(10, m[1].split('.')[1].length)) : scale
    any = true
    pos = re.lastIndex
  }
  if (!any || !Number.isFinite(total)) return null
  return { ms: Math.round(total), unit }
}

function parseNumber(input: string): { n: number; unit: number } | null {
  const s = foldText(input).replace(/(★|\*|stars?|bpm)$/u, '').trim()
  if (!/^-?\d+(\.\d+)?$|^-?\.\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  const dec = s.includes('.') ? s.split('.')[1].length : 0
  return { n, unit: Math.pow(10, -dec) }
}

function parseYear(input: string): { from: number; to: number } | null {
  const s = foldText(input)
  let m = /^(\d{4})$/.exec(s)
  if (m) return { from: Number(m[1]), to: Number(m[1]) + 1 }
  m = /^(\d{2})$/.exec(s)
  if (m) {
    const y = Number(m[1])
    const full = y >= 70 ? 1900 + y : 2000 + y
    return { from: full, to: full + 1 }
  }
  // decades: 1990s, 90s, 199x
  m = /^(\d{3})(?:0s|x)$/.exec(s)
  if (m) return { from: Number(m[1]) * 10, to: Number(m[1]) * 10 + 10 }
  m = /^(\d)0s$/.exec(s)
  if (m) {
    const d = Number(m[1])
    const base = d >= 7 ? 1900 + d * 10 : 2000 + d * 10
    return { from: base, to: base + 10 }
  }
  return null
}

const BOOL_TRUE = new Set(['true', 'yes', 'y', '1', 'on', 't', '✓'])
const BOOL_FALSE = new Set(['false', 'no', 'n', '0', 'off', 'f'])

type ValueResult = { ok: true; filter: SearchFilter } | { ok: false; message: string }

function buildFilter(key: SearchKey, op: SearchOp, raw: string): ValueResult {
  const kind = SEARCH_KEY_KIND[key]
  const text = foldText(raw)
  const base: SearchFilter = { key, op, value: raw, text, num: null, max: null, bool: null }
  const isRangeOp = op === '>' || op === '<' || op === '>=' || op === '<='
  switch (kind) {
    case 'text': {
      if (isRangeOp) return { ok: false, message: `${key} only supports = and !=` }
      if (!text) return { ok: false, message: `missing ${key}` }
      return { ok: true, filter: base }
    }
    case 'kind': {
      if (isRangeOp) return { ok: false, message: 'kind only supports = and !=' }
      const k = KIND_ALIASES[text]
      if (!k) return { ok: false, message: `unknown kind "${raw}" (ost, gamerip, arrange, remix, single, compilation)` }
      return { ok: true, filter: { ...base, text: k } }
    }
    case 'source': {
      if (isRangeOp) return { ok: false, message: 'source only supports = and !=' }
      const v = SOURCE_ALIASES[text]
      if (!v) return { ok: false, message: `unknown source "${raw}"` }
      return { ok: true, filter: { ...base, text: v } }
    }
    case 'bool': {
      if (isRangeOp) return { ok: false, message: `${key} is yes/no` }
      let b: boolean
      if (BOOL_TRUE.has(text)) b = true
      else if (BOOL_FALSE.has(text)) b = false
      else return { ok: false, message: `${key} expects yes or no` }
      // normalise `liked!=yes` to `liked=no`
      if (op === '!=') b = !b
      return { ok: true, filter: { ...base, op: '=', bool: b } }
    }
    case 'year': {
      const y = parseYear(raw)
      if (!y) return { ok: false, message: 'year expects e.g. 1995, 95 or 1990s' }
      if (op === '=' || op === '!=') return { ok: true, filter: { ...base, num: y.from, max: y.to } }
      // > 1990s means after the decade; < 1990s before it; >= / <= include it.
      const num = op === '>' ? y.to - 1 : op === '<=' ? y.to - 1 : y.from
      return { ok: true, filter: { ...base, num } }
    }
    case 'duration': {
      const d = parseDuration(raw)
      if (!d) return { ok: false, message: 'length expects e.g. 4m, 3:30 or 240s' }
      if (op === '=' || op === '!=') return { ok: true, filter: { ...base, num: d.ms, max: d.ms + d.unit } }
      return { ok: true, filter: { ...base, num: d.ms } }
    }
    case 'number': {
      const n = parseNumber(raw)
      if (!n) return { ok: false, message: `${key} expects a number` }
      if (op === '=' || op === '!=') {
        const half = n.unit / 2
        return { ok: true, filter: { ...base, num: n.n - half, max: n.n + half } }
      }
      return { ok: true, filter: { ...base, num: n.n } }
    }
  }
}

// ---------------------------------------------------------------------------
// Parser

export function parseSearch(input: string | null | undefined): ParsedSearch {
  const s = input ?? ''
  const out: ParsedSearch = { terms: [], excludes: [], filters: [], tokens: [], errors: [], empty: true }
  const tok = (type: SearchTokenType, start: number, end: number) => {
    if (end > start) out.tokens.push({ type, text: s.slice(start, end), start, end })
  }
  const addTerm = (raw: string, exclude: boolean) => {
    const t = foldText(raw)
    // Skip pure punctuation ("-", "~") so it can't match everything.
    if (!t || !/[\p{L}\p{N}]/u.test(t)) return
    ;(exclude ? out.excludes : out.terms).push(t)
  }

  let i = 0
  while (i < s.length) {
    if (isSpace(s[i])) {
      i++
      continue
    }
    const start = i

    // Quoted phrase.
    if (QUOTE_PAIRS[s[i]] && s[i] !== "'") {
      const [content, end] = readQuoted(s, i)
      tok('phrase', start, end)
      addTerm(content, false)
      i = end
      continue
    }

    // Exclusion: -word or -"phrase".
    if (s[i] === '-' && i + 1 < s.length && !isSpace(s[i + 1]) && s[i + 1] !== '-') {
      if (QUOTE_PAIRS[s[i + 1]] && s[i + 1] !== "'") {
        const [content, end] = readQuoted(s, i + 1)
        tok('exclude', start, end)
        addTerm(content, true)
        i = end
      } else {
        const end = readWord(s, i + 1)
        tok('exclude', start, end)
        addTerm(s.slice(i + 1, end), true)
        i = end
      }
      continue
    }

    // Possible filter: key chars followed by an operator (optionally after spaces, except ':').
    let k = i
    while (k < s.length && isKeyChar(s[k])) k++
    const keyText = s.slice(i, k).toLowerCase()
    const key = k > i ? SEARCH_KEY_ALIASES[keyText] : undefined
    if (key) {
      let j = k
      while (j < s.length && isSpace(s[j])) j++
      const opHit = readOp(s, j)
      const spacedBeforeOp = j > k
      if (opHit && !(spacedBeforeOp && opHit[0] === '=' && s[j] === ':')) {
        const [op, opLen] = opHit
        const opStart = j
        const opEnd = j + opLen
        let v = opEnd
        // Allow spaces after the operator, but not after ':' (avoids "Game: The Movie").
        if (s[opStart] !== ':') while (v < s.length && isSpace(s[v])) v++
        let valueRaw = ''
        let valueEnd = v
        if (v < s.length && QUOTE_PAIRS[s[v]] && s[v] !== "'") {
          const [content, end] = readQuoted(s, v)
          valueRaw = content
          valueEnd = end
        } else if (v < s.length && !isSpace(s[v])) {
          valueEnd = readWord(s, v)
          valueRaw = s.slice(v, valueEnd)
        }
        if (s[opStart] === ':' && !valueRaw) {
          // "word:" followed by a space is ordinary text (e.g. "Kirby: Planet Robobot").
        } else {
          tok('key', i, k)
          tok('op', opStart, opEnd)
          if (!valueRaw) {
            // Incomplete filter while typing (`platform=`): ignore it quietly.
            i = valueEnd
            continue
          }
          const res = buildFilter(key, op, valueRaw)
          if (res.ok) {
            tok('value', v, valueEnd)
            out.filters.push(res.filter)
          } else {
            tok('invalid', v, valueEnd)
            out.errors.push({ start: v, end: valueEnd, message: res.message })
          }
          i = valueEnd
          continue
        }
      }
    }

    // Unknown key with an operator (`foo=bar`) or plain word: free text.
    const end = readWord(s, i)
    tok('text', start, end)
    addTerm(s.slice(start, end), false)
    i = end
  }

  out.empty = out.terms.length === 0 && out.excludes.length === 0 && out.filters.length === 0
  return out
}

/** Inverse of parseSearch for one filter: a canonical `key op value` string. */
export function formatFilter(f: Pick<SearchFilter, 'key' | 'op' | 'value'>): string {
  const v = /\s/.test(f.value) ? `"${f.value}"` : f.value
  return `${f.key}${f.op}${v}`
}
