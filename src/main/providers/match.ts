// Candidate → canonical track matching shared by the search-based providers (DESIGN §6.4):
//
//   score = 0.45·title_similarity + 0.35·duration_fit + 0.1·channel_trust + 0.1·quality − penalties
//
// Title similarity works on normalised tokens: the candidate's game-name, channel and "OST" noise
// tokens are ignored unless the canonical title itself contains them. Penalties catch the usual
// not-the-original uploads (remix, cover, piano, 1 hour, slowed, nightcore, reaction, live…).

import { foldText } from '../../shared/search'

export const W = { title: 0.45, duration: 0.35, trust: 0.1, quality: 0.1 } as const
/** Subtracted per penalty hit. */
export const PENALTY_WEIGHT = 0.25

/** Words that decorate upload titles without naming the track. */
const NOISE = new Set([
  'ost', 'osv', 'original', 'soundtrack', 'soundtracks', 'sound', 'track', 'music', 'bgm', 'official', 'audio', 'video', 'hq', 'hd', 'game',
  'from', 'theme', 'version', 'full', 'complete', 'edition', 'remastered', 'by', 'feat', 'ft', 'with', 'the', 'a', 'of', 'and', 'in', 'on', 'to',
  'topic', 'vgm', 'score', 'cd', 'disc', 'disk', 'vol', 'volume', 'no', 'nr', 'pt', 'part', 'ver', 'flac', 'mp3', '1080p', '720p', '4k'
])

/** Fold, strip accents and punctuation, split into tokens. */
export function tokens(s: string | null | undefined): string[] {
  if (!s) return []
  const t = foldText(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .replace(/&|＆/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return t ? t.split(' ') : []
}

function lev1(a: string, b: string): boolean {
  // Edit distance ≤ 1.
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else {
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

function tokenEq(a: string, b: string): boolean {
  if (a === b) return true
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) === Number(b)
  return a.length >= 5 && b.length >= 5 && lev1(a, b)
}

const ROMAN: Record<string, string> = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' }
function canon(t: string): string {
  return ROMAN[t] ?? t
}

export interface SimilarityContext {
  /** Game / album names whose tokens may decorate the candidate title. */
  context?: (string | null | undefined)[]
  /** Uploader / channel / artist name (also ignorable). */
  channel?: string | null
}

/**
 * How well a candidate title names the canonical track (0..1). Recall of the canonical tokens
 * dominates; extra unexplained words in the candidate cost a little precision.
 */
export function titleSimilarity(canonical: string, candidate: string, ctx: SimilarityContext = {}): number {
  const want = tokens(canonical).map(canon)
  if (!want.length) return 0
  const wantSet = new Set(want)
  const ignorable = new Set<string>()
  for (const c of ctx.context ?? []) for (const t of tokens(c)) if (!wantSet.has(canon(t))) ignorable.add(canon(t))
  for (const t of tokens(ctx.channel?.replace(/\s+-\s+topic$/i, ''))) if (!wantSet.has(canon(t))) ignorable.add(canon(t))
  const have = tokens(candidate)
    .map(canon)
    .filter((t) => wantSet.has(t) || !(ignorable.has(t) || NOISE.has(t) || /^\d+$/.test(t)))
  if (!have.length) return 0
  const used = new Array(have.length).fill(false)
  let hit = 0
  for (const w of want) {
    const i = have.findIndex((h, k) => !used[k] && tokenEq(w, h))
    if (i >= 0) {
      used[i] = true
      hit++
    }
  }
  const recall = hit / want.length
  const precision = hit / have.length
  return Math.round((0.75 * recall + 0.25 * precision) * 1000) / 1000
}

/** Full credit within ±2 s, falling linearly to zero at ±15 s. Unknown expected duration is neutral. */
export function durationFit(expectedMs: number | null | undefined, actualMs: number | null | undefined): number {
  if (expectedMs == null || expectedMs <= 0) return 0.5
  if (actualMs == null || actualMs <= 0) return 0.3
  const d = Math.abs(expectedMs - actualMs)
  if (d <= 2000) return 1
  if (d >= 15000) return 0
  return Math.round((1 - (d - 2000) / 13000) * 1000) / 1000
}

/** Not-the-original markers: each costs PENALTY_WEIGHT unless the canonical text has it too. */
export const PENALTIES: [string, RegExp][] = [
  ['remix', /\bremix(?:es|ed)?\b|\brmx\b|\bbootleg\b/],
  ['cover', /\bcovers?\b|\bcovered\b|\btribute\b/],
  ['piano', /\bpiano\b/],
  ['orchestral', /\borchestra(?:l|ted)?\b|\bsymphon(?:y|ic)\b|\bquartet\b|\bensemble\b/],
  ['extended', /\bextended\b|\bextension\b/],
  ['hours', /\b\d+\s*(?:h|hr|hrs|hour|hours)\b|\bone\s+hour\b|\bhour\s+(?:loop|version)\b/],
  ['slowed', /\bslowed\b|\breverb\b|\bsped\s+up\b|\bspeed\s+up\b|\bpitched\b|\bdaycore\b/],
  ['nightcore', /\bnightcore\b/],
  ['reaction', /\breact(?:ion|ions|s|ing)?\b/],
  ['live', /\blive\b|\bconcert\b|\bperformance\b|\bperformed\b/],
  ['instrument', /\bacoustic\b|\bguitar\b|\bviolin\b|\bcello\b|\bflute\b|\bocarina\b|\bharp\b|\bsax(?:ophone)?\b|\bkalimba\b|\baccordion\b/],
  ['chip', /\b8\s*-?\s*bit\b|\b16\s*-?\s*bit\b|\bchiptune\b|\bnes\s+remix\b/],
  ['lofi', /\blo\s*-?\s*fi\b|\bchill\s*hop\b/],
  ['karaoke', /\bkaraoke\b|\binstrumental\b|\bbacking\s+track\b/],
  ['musicbox', /\bmusic\s+box\b/],
  ['ambience', /\bambien(?:ce|t)\b|\bsleep\b|\brelax(?:ing)?\b|\bstudy(?:ing)?\b|\brain\b/],
  ['tutorial', /\btutorial\b|\bsynthesia\b|\bsheet\s+music\b|\blesson\b|\bhow\s+to\s+play\b/],
  ['arrange', /\barrange(?:d|ment|ments)?\b|\brearrange|\breorchestrat|\bmedley\b|\bmash\s*-?\s*up\b|\breimagined\b|\bre-?imagined\b/],
  ['style', /\bfan\s*-?\s*made\b|\bremake\b|\bmetal\b|\brock\s+version\b|\bjazz\b|\btrap\b|\bedm\b|\b8d\b|\bbass\s+boosted\b|\bepic\s+version\b|\bhardstyle\b|\bphonk\b|\bsynthwave\b/],
  ['loop', /\bloop(?:ed|s)?\b/],
  ['gameplay', /\bgameplay\b|\bwalkthrough\b|\bplaythrough\b|\blet'?s\s+play\b|\bspeedrun\b|\blongplay\b/],
  ['ai', /\bai\b|\bsuno\b/]
]

/** Penalty tags whose marker appears in `candidate` but in none of the reference texts. */
export function penaltyHits(candidate: string, reference: (string | null | undefined)[] = []): string[] {
  const c = foldText(candidate)
  const refs = reference.filter((r): r is string => !!r).map((r) => foldText(r))
  const out: string[] = []
  for (const [tag, re] of PENALTIES) {
    if (re.test(c) && !refs.some((r) => re.test(r))) out.push(tag)
  }
  return out
}

/** Known official publisher / label / composer channels (lowercase, compared on keyOf-like folding). */
export const KNOWN_LABELS = [
  'square enix music', 'square enix', 'nintendo', 'sega', 'capcom', 'capcom channel', 'bandai namco', 'bandai namco entertainment', 'konami',
  'atlus', 'falcom', 'nihon falcom', 'koei tecmo', 'sony music', 'playstation', 'xbox', 'bethesda', 'blizzard entertainment', 'riot games music',
  'devolver digital', 'annapurna interactive', 'team cherry', 'supergiant games', 'materia collective', 'laced records', 'brave wave',
  'brave wave productions', 'data discs', 'ship to shore', 'ship to shore phonograph co', 'black screen records', 'mondo', 'iam8bit',
  'fangamer', 'lost in cult', 'scarlet moon records', 'hyperduck soundworks', 'mick gordon', 'toby fox', 'lena raine', 'darren korb',
  'austin wintory', 'c418', 'disasterpeace', 'yoko shimomura', 'nobuo uematsu', 'yasunori mitsuda', 'koji kondo', 'christopher larkin',
  'akira yamaoka', 'jesper kyd', 'inon zur', 'garry schyman', 'gareth coker', 'kevin penkin', 'ben prunty', 'danny baranowsky', 'jim guthrie',
  'grant kirkhope', 'david wise', 'motoi sakuraba', 'hitoshi sakimoto', 'yuzo koshiro', 'masato nakamura', 'hiroki kikuta', 'keiichi okabe',
  'ys net', 'monster siren records', 'hoyofair', 'hoyoverse', 'hoyo-mix', 'hoyomix', 'mihoyo', 'cygames', 'level-5', 'game freak', 'the pokemon company',
  'ubisoft', 'ubisoft music', 'electronic arts', 'ea', 'activision', 'rockstar games', 'cd projekt red', 'valve', 'id software', 'remedy entertainment'
]
const LABEL_KEYS = new Set(KNOWN_LABELS.map((l) => tokens(l).join(' ')))

export interface TrustContext {
  composers?: string[]
  /** Album artists / publishers / developers. */
  artists?: string[]
}

/** 0..1: "<Artist> - Topic" (official distributor upload) > composer/label channel > verified > anyone. */
export function channelTrust(channel: string | null | undefined, verified = false, ctx: TrustContext = {}): number {
  if (!channel) return verified ? 0.6 : 0.3
  if (/\s-\sTopic$/i.test(channel.trim())) return 1
  const key = tokens(channel.replace(/\b(?:official|music|channel|records|vevo)\b/gi, ' ')).join(' ')
  const fullKey = tokens(channel).join(' ')
  const people = [...(ctx.composers ?? []), ...(ctx.artists ?? [])].map((n) => tokens(n).join(' ')).filter((k) => k.length >= 3)
  if (people.some((p) => p === key || p === fullKey || (key.length >= 4 && (p.includes(key) || key.includes(p))))) return 0.9
  if (LABEL_KEYS.has(fullKey) || LABEL_KEYS.has(key)) return 0.85
  return verified ? 0.6 : 0.3
}

export interface ScoreParts {
  title: number
  duration: number
  trust: number
  quality: number
  penalties: string[]
}

export function combineScore(p: ScoreParts): number {
  const base = W.title * p.title + W.duration * p.duration + W.trust * p.trust + W.quality * p.quality
  return Math.max(0, Math.min(1, Math.round((base - PENALTY_WEIGHT * p.penalties.length) * 1000) / 1000))
}

// ---------------------------------------------------------------------------
// Title cleanup (playlist entries, file names, chapters)

const OST_WORDS = String.raw`(?:full\s+|complete\s+|official\s+|original\s+)*(?:o\.?s\.?t\.?|o\.?s\.?v\.?|soundtrack|sound\s*track|original\s+soundtrack|original\s+score|score|music|bgm|vgm|theme)`
/**
 * The unambiguous soundtrack words. "Theme", "Music" and "Score" are also ordinary words of track
 * names ("Frog's Theme", "Battle (Main Theme)"), so they only count as noise next to a game name.
 */
const OST_CORE = String.raw`(?:full\s+|complete\s+|official\s+|original\s+)*(?:o\.?s\.?t\.?|o\.?s\.?v\.?|soundtrack|sound\s*track|original\s+soundtrack|original\s+score|bgm|vgm)`
const BRACKET_NOISE = new RegExp(
  String.raw`\s*[([【〔{]\s*(?:[^)\]】〕}]*\b(?:${OST_CORE}|official|audio|hq|hd|lyrics?|(?:music\s+)?video|visuali[sz]er|remaster(?:ed)?|1080p|720p|4k|high\s+quality|flac|mp3)\b[^)\]】〕}]*|\s*)[)\]】〕}]\s*`,
  'giu'
)

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A loose regex for a name: words joined by any run of separators, case-insensitive. */
function nameRe(name: string): string | null {
  const words = name
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean)
    .map(escapeRe)
  return words.length ? words.join(String.raw`[\s\p{P}\p{S}]*`) : null
}

export interface CleanTitleContext {
  /** Game / album names that may prefix or suffix the title. */
  names?: (string | null | undefined)[]
  /** Uploader / channel name (" - Topic" is stripped). */
  channel?: string | null
  /** The list is numbered ("10 Title"): strip a bare leading number too. */
  numbered?: boolean
}

/** Whether most titles in a list start with a bare track number ("01 Title", "12 Title"). */
export function looksNumbered(titles: string[]): boolean {
  if (titles.length < 3) return false
  const n = titles.filter((t) => /^\s*\d{1,3}\s+\S/.test(t)).length
  return n / titles.length >= 0.6
}

/**
 * Clean an upload / file title down to the track name:
 * "Hollow Knight OST - 03 - Crossroads (HQ)" → "Crossroads"; "01. Enter Hallownest" → "Enter Hallownest".
 */
export function cleanTrackTitle(raw: string, ctx: CleanTitleContext = {}): string {
  const original = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
  let s = original
  if (!s) return raw
  const SEP = String.raw`\s*(?:[-–—:|~/•·]+|\s)\s*`
  const strip = (re: RegExp) => {
    const next = s.replace(re, '').trim()
    if (/[\p{L}\p{N}]/u.test(next)) s = next
  }
  strip(BRACKET_NOISE)
  const names = [...(ctx.names ?? []), ctx.channel?.replace(/\s+-\s+topic$/i, '')].filter((n): n is string => !!n && n.trim().length >= 2)
  // Longest names first so "Hollow Knight: Silksong" goes before "Hollow Knight".
  names.sort((a, b) => b.length - a.length)
  for (let pass = 0; pass < 2; pass++) {
    for (const n of names) {
      const r = nameRe(n)
      if (!r) continue
      // Prefix: "<name> [OST] - title", "[<name>] title", "<name>: title".
      strip(new RegExp(String.raw`^[[(【]?\s*${r}\s*(?:${OST_WORDS})?\s*[\])】]?${SEP}`, 'iu'))
      // Suffix: "title - <name> [OST]", "title (<name> OST)", "title | <name>".
      strip(new RegExp(String.raw`(?:${SEP}|\s*[([【]\s*)${r}(?:\s*${OST_WORDS})?\s*[\])】]?\s*$`, 'iu'))
    }
    // Bare "OST - title" / "title - OST" left behind.
    strip(new RegExp(String.raw`^${OST_CORE}${SEP}`, 'iu'))
    strip(new RegExp(String.raw`${SEP}${OST_CORE}\s*$`, 'iu'))
    strip(new RegExp(String.raw`\s*[([【]\s*${OST_CORE}\s*[\])】]\s*$`, 'iu'))
    // Track numbers: "01. ", "1 - ", "03) ", "Track 5: ", "#12 ", "1-03 ", "[03] ".
    strip(/^(?:track|tr\.?|no\.?|#)\s*\d{1,3}\s*[.:)\-–—]?\s+/iu)
    strip(/^\d{1,2}-\d{2,3}\.?\s+/u)
    strip(/^[[(]\d{1,3}[\])]\s*/u)
    strip(/^\d{1,3}\s*(?:[.)_:]\s*|[-–—]\s+)/u)
    strip(/^0\d{1,2}\s+/u)
    if (ctx.numbered) strip(/^\d{1,3}\s+/u)
  }
  // Wrapping quotes, or brackets left alone once a name was stripped ("Chrono Trigger (Chronos Theme)").
  const b = s !== original && /^[([【]([^()[\]【】]+)[)\]】]$/u.exec(s)
  if (b && /[\p{L}\p{N}]/u.test(b[1])) s = b[1].trim()
  const q = /^["“'‘「『](.+)["”'’」』]$/u.exec(s)
  if (q && /[\p{L}\p{N}]/u.test(q[1])) s = q[1].trim()
  s = s.replace(/^[\s\-–—:|~/•·]+|[\s\-–—:|~/•·]+$/gu, '').trim()
  return s || original
}
