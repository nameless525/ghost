// Title normalisation (DESIGN §6.4) and album → game clustering without IGDB.
//
// KHInsider lists albums, not games. We derive a game from each album title by stripping the
// soundtrack-ish decoration ("Original Soundtrack", "OST", "(Gamerip)", "(SNES)", "Vol. 2", years,
// editions…). Albums that share the resulting key become one game.

import type { AlbumKind } from '../../shared/types'
import { foldText } from '../../shared/search'

/** Words that mark where the game name ends and the album decoration begins. Cut at the first hit. */
const MARKERS: RegExp[] = [
  /\boriginal\s+(?:(?:video\s+)?game\s+|motion\s+picture\s+|television\s+|anime\s+)?(?:sound\s*track|soundtrack|score|sound\s+version|sound\s+collection|music(?:\s+collection)?)s?\b/i,
  /\bofficial\s+(?:(?:video\s+)?game\s+)?(?:sound\s*track|soundtrack|score|music)\b/i,
  /\b(?:complete|full|definitive|expanded|extended|deluxe|premium|limited|special|digital|unofficial)?\s*(?:(?:video\s+)?game\s+)?(?:sound\s*tracks?|soundtracks?)\b/i,
  /(?:^|\s)o\.?s\.?[tv]\.?(?=$|[\s\-–—:~)\]])/i,
  /\b(?:full\s+)?game\s*rips?\b/i,
  /\bsound\s+(?:collection|selection|box|track\s+collection)\b/i,
  /\bmusic\s+(?:collection|selection|box)\b/i,
  /\barrang(?:e|ed|ement)\s+(?:version|album|tracks|collection|soundtrack)s?\b/i,
  /\b(?:piano|orchestral|jazz|acoustic|guitar|rock|metal|chiptune|8-?bit|vocal|symphonic|lo-?fi)\s+(?:arrange(?:ment)?s?|collection|covers?|album|versions?|selections?)\b/i,
  // Fan re-renders and arrangement series: "X Famicom Sound Version 3", "X on Piano", "X Piano Music".
  /\b(?:(?:super\s+)?famicom|nes|snes|genesis|mega\s+drive|game\s*boy|chiptune|8-?bit|16-?bit|midi)\s+sound\s+versions?\b/i,
  /\bsound\s+versions?\b/i,
  /\bon\s+(?:piano|guitar|harp|organ|strings)\b/i,
  /\b(?:piano|guitar)\s+(?:music|solos?|sheets?|works|pieces|medley)\b/i,
  /\b(?:orchestral|symphonic|live)\s+(?:concert|suite|selections?|album|performance)\b/i,
  /(?:オリジナル[・･\s]*)?(?:サウンド[・･\s]*トラック|サントラ)/
]

/** Decoration that only counts at the very end of a title. */
const TAIL_MARKERS: RegExp[] = [
  /\s*[-–—:~]?\s*\b(?:the\s+)?(?:complete|deluxe|special|limited|collector'?s|expanded|digital|definitive|anniversary|remastered|extended)\s+edition\s*$/i,
  /\s*[-–—:~]?\s*\b(?:remix(?:es)?|arrangements?|covers?|remastered|ost|osv)\s*(?:album|collection|edition)?\s*$/i,
  /\s*[-–—:~]?\s*\b(?:arranged|remixed|re-?orchestrated|reimagined|rearranged)\s*$/i,
  /\s*[-–—:~,]?\s*\b(?:vol(?:ume)?\.?\s*(?:\d+|[ivx]+)|dis[ck]\s*\d+|cd\s*\d+)\s*$/i,
  /\s+[-–—:~]\s+(?:19|20)\d\d\s*$/,
  /\s+[-–—]\s+[^-–—]*\bdlc\b.*$/i,
  /\s+dlc\s*$/i,
  /\s*[-–—:~|/,.]+\s*$/
]

/** "music from X" / "a tribute to X": the game is X. */
const ABOUT_GAME: RegExp[] = [
  /(?:^|[:\-–—~]\s*|\s)(?:music|songs|melodies|themes|selections)\s+(?:from|of|inspired\s+by)\s+(?:the\s+game\s+)?(.{2,})$/i,
  /(?:^|[:\-–—~]\s*|\s)(?:an?\s+)?(?:[\w-]+\s+){0,2}tribute\s+to\s+(.{2,})$/i,
  // "Chronicles of Time: A Chrono Trigger Arrangement Project" → the game is in the subtitle.
  /[:：\-–—~]\s*(?:an?\s+|the\s+)?(.{2,}?)\s+(?:arrangement|remix|tribute|cover|piano|orchestral|fan)\s+(?:project|album|collection|ep)s?$/i
]

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'and', 'my', 'la', 'le', 'el', 'die', 'der', 'das', 'in', 'on', 'to'])

/** A head worth keeping as a game name: has letters/digits and isn't just an article. */
function isSubstantial(head: string): boolean {
  const k = keyOf(head)
  return k.length >= 1 && !STOPWORDS.has(k)
}

function stripBrackets(s: string): string {
  // Repeatedly remove (…) […] {…} 【…】 segments, but never everything.
  let prev: string
  let out = s
  do {
    prev = out
    const next = out.replace(/\s*[([{【（<〈《][^()[\]{}【】（）<>〈〉《》]*[)\]}】）>〉》]\s*/g, ' ').trim()
    if (next.length >= 2) out = next
    else break
  } while (out !== prev)
  return out
}

/**
 * Clean an album title down to the game name, preserving case:
 * "ACE COMBAT 7: SKIES UNKNOWN ORIGINAL SOUNDTRACK" → "ACE COMBAT 7: SKIES UNKNOWN".
 */
export function baseTitle(title: string): string {
  const r = cleanTitle(title, true)
  // "<A Bird Story> OST": stripping brackets left only decoration, so unwrap them instead.
  if (DECORATION_ONLY.test(r) && /[([{【（<〈《]/.test(title)) {
    const r2 = cleanTitle(title.replace(/[()[\]{}【】（）<>〈〉《》]/g, ' '), false)
    if (!DECORATION_ONLY.test(r2)) return r2
  }
  return r
}

const DECORATION_ONLY = /^\s*(?:o\.?s\.?[tv]\.?|(?:original\s+)?(?:sound\s*track|soundtrack|score|music|sound\s+version)s?|(?:full\s+)?game\s*rips?)?\s*$/i

function cleanTitle(title: string, brackets: boolean): string {
  let s = title.normalize('NFKC').replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
  if (!s) return s
  for (const re of ABOUT_GAME) {
    const m = re.exec(s)
    if (m && m.index > 0 && m[1].trim().length >= 2) {
      s = m[1].trim()
      break
    }
  }
  if (brackets) s = stripBrackets(s)
  for (const re of MARKERS) {
    const m = re.exec(s)
    if (m && m.index > 0) {
      // Drop a dangling article left by the cut ("A Dance of Fire and Ice - The Official Soundtrack").
      const head = s
        .slice(0, m.index)
        .replace(/(?:\s*[-–—:~,]+\s+(?:the|an?)|\s+the)\s*$/i, '')
        .trim()
      if (isSubstantial(head)) s = head
    }
  }
  for (let i = 0; i < 4; i++) {
    const before = s
    for (const re of TAIL_MARKERS) {
      const next = s.replace(re, '').trim()
      if (next.replace(/[^\p{L}\p{N}]/gu, '').length >= 1) s = next
    }
    if (s === before) break
  }
  return s.trim() || title.trim()
}

/** Comparison key: folded, accents and punctuation removed, "&" → "and", leading "the" dropped. */
export function keyOf(name: string): string {
  let s = foldText(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
  s = s
    .replace(/&|＆/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  s = s.replace(/^the\s+/, '')
  return s
}

/** Game clustering key for an album title. */
export function gameKey(title: string): string {
  return keyOf(baseTitle(title)) || keyOf(title) || foldText(title)
}

/** Kinds whose subtitle names the album rather than the game ("Chrono Trigger: Orchestral Selections"). */
export const MERGEABLE_KINDS = new Set<AlbumKind>(['arrange', 'remix', 'single', 'compilation', 'other'])

/** Key of the part before the first ':' / ' - ' / '~' (null if there is no such split). */
export function headKey(title: string): string | null {
  const base = baseTitle(title)
  const m = /^(.+?)\s*(?::|：|\s[-–—~]\s|~)\s*\S/.exec(base)
  if (!m) return null
  const k = keyOf(m[1])
  return k && k !== keyOf(base) && k.length >= 2 ? k : null
}

/** Sort key: folded, leading "the"/punctuation removed. */
export function sortKey(name: string): string {
  const k = foldText(name)
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/^the\s+/, '')
  // Titles that don't start with a Latin letter or digit (symbol art, other scripts) sort after Z,
  // so an A–Z browse opens on recognisable names.
  return /^[a-z0-9]/.test(k) ? k : '\u{10ffff}' + k
}

const ROMAN_OR_NUMBER = /\s+(?:\d+(?:\.\d+)?|[ivxlc]+|hd|remastered|remake|reloaded|returns|origins|2d|3d|dx|plus|\+|deluxe|ex|zero)$/i

/** Heuristic franchise name: the head before a subtitle, minus trailing sequel numbers. */
export function franchiseGuess(name: string): string | null {
  let s = baseTitle(name)
  const m = /^(.+?)\s*(?::|：|\s[-–—~]\s)/.exec(s)
  if (m) s = m[1]
  for (let i = 0; i < 3; i++) s = s.replace(ROMAN_OR_NUMBER, '').trim()
  s = s.replace(/[\s\-–—:~,.!]+$/, '').trim()
  return s.replace(/[^\p{L}\p{N}]/gu, '').length >= 3 ? s : null
}

const KIND_RANK: Record<AlbumKind, number> = { ost: 0, gamerip: 1, compilation: 2, arrange: 3, remix: 4, single: 5, other: 6 }
export function kindRank(k: AlbumKind): number {
  return KIND_RANK[k] ?? 9
}

function isShouty(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, '')
  return letters.length >= 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()
}

/** 0 = normal casing, 1 = starts lowercase ("a highland song"), 2 = ALL CAPS. */
function casingPenalty(s: string): number {
  if (isShouty(s)) return 2
  const first = /\p{L}/u.exec(s)?.[0]
  return first && first !== first.toUpperCase() ? 1 : 0
}

export interface NameCandidate {
  title: string
  kind: AlbumKind
  year: number | null
}

/** Pick the game's display name from its albums: OST/gamerip first, not ALL CAPS, earliest, shortest. */
export function pickGameName(albums: NameCandidate[]): string {
  const cands = albums.map((a) => ({ name: baseTitle(a.title), a }))
  cands.sort((x, y) => {
    const sx = casingPenalty(x.name)
    const sy = casingPenalty(y.name)
    if (sx !== sy) return sx - sy
    const kx = Math.min(kindRank(x.a.kind), 2)
    const ky = Math.min(kindRank(y.a.kind), 2)
    if (kx !== ky) return kx - ky
    if (x.name.length !== y.name.length) return x.name.length - y.name.length
    return (x.a.year ?? 9999) - (y.a.year ?? 9999)
  })
  return cands[0]?.name ?? ''
}

export interface ClusterInput {
  id: number
  title: string
  kind: AlbumKind
}

/**
 * Assign every album a game key. Albums of mergeable kinds whose head ("X: subtitle") matches a
 * game that has an OST or gamerip are folded into that game.
 */
export function clusterKeys(albums: ClusterInput[], existingPrimaryKeys?: ReadonlySet<string>): Map<number, string> {
  const keys = new Map<number, string>()
  const primary = new Set<string>(existingPrimaryKeys ?? [])
  for (const a of albums) {
    const k = gameKey(a.title)
    keys.set(a.id, k)
    if (!MERGEABLE_KINDS.has(a.kind)) primary.add(k)
  }
  for (const a of albums) {
    if (!MERGEABLE_KINDS.has(a.kind)) continue
    const k = keys.get(a.id)!
    if (primary.has(k)) continue
    const h = headKey(a.title)
    if (h && primary.has(h)) keys.set(a.id, h)
  }
  return keys
}
