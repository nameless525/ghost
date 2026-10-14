// Search aliases: extra spellings indexed next to a name so the ways people actually type game
// titles find them (DESIGN §6.6). All outputs are folded with ftsFold, ready for ftsDoc.
//
//   "Yu-Gi-Oh! 5D's"           → "yugioh"                (punctuation-joined runs)
//   "Mega Man X"               → "megaman", "manx"        (adjacent word pairs; games only)
//   "Final Fantasy VII"        → "final fantasy 7", "ff7", "ffvii"
//   "Street Fighter 2"         → "street fighter ii", "sf2"
//   "The Legend of Zelda: Breath of the Wild" → "tloz", "loz", "botw"

import { foldText } from '../../shared/search'

/** Folded search text: lowercase, apostrophes dropped, "&" → "and", other punctuation → space. */
export function ftsFold(s: string): string {
  return foldText(s)
    .replace(/['’‘`´]/g, '')
    .replace(/[&＆]/g, ' and ')
    .replace(/[^\p{L}\p{N}\p{M}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20 }
const ARABIC: Record<string, string> = Object.fromEntries(Object.entries(ROMAN).map(([r, n]) => [String(n), r]))

const isLatinWord = (w: string) => /^[a-z][a-z]+$/.test(w)

export interface AliasOptions {
  /** Adjacent word pairs run together ("mega man" → "megaman"). */
  pairs?: boolean
  /** Roman ↔ arabic sequel numbers. */
  numerals?: boolean
  /** Initialisms per title segment ("ff7", "botw"). */
  acronyms?: boolean
}

export const GAME_ALIASES: AliasOptions = { pairs: true, numerals: true, acronyms: true }
export const TITLE_ALIASES: AliasOptions = { numerals: true }

/** Alternative folded spellings of `name` (never including the plain folded name itself). */
export function searchAliases(name: string | null | undefined, opts: AliasOptions = {}): string[] {
  if (!name) return []
  const base = ftsFold(name)
  if (!base) return []
  const out = new Set<string>()
  const add = (s: string) => {
    if (s.length >= 2 && s !== base) out.add(s)
  }

  // Punctuation-joined runs: "yu-gi-oh!" → "yugioh", "q*bert" → "qbert", "f-zero" → "fzero".
  for (const raw of foldText(name).replace(/['’‘`´]/g, '').split(' ')) {
    const parts = raw.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean)
    if (parts.length > 1) add(parts.join(''))
  }

  const words = base.split(' ')
  if (opts.pairs) {
    for (let i = 0; i + 1 < words.length && i < 6; i++) {
      const a = words[i]
      const b = words[i + 1]
      if (isLatinWord(a) && isLatinWord(b) && a.length + b.length >= 5) add(a + b)
    }
  }

  if (opts.numerals) {
    let toArabic = false
    let toRoman = false
    const arabic = words.map((w, i) => {
      // A lone "v"/"x" only counts as a numeral after a word ("Final Fantasy X", not "X-Men").
      if (ROMAN[w] && i > 0) {
        toArabic = true
        return String(ROMAN[w])
      }
      return w
    })
    const roman = words.map((w, i) => {
      if (ARABIC[w] && i > 0) {
        toRoman = true
        return ARABIC[w]
      }
      return w
    })
    if (toArabic) add(arabic.join(' '))
    if (toRoman) add(roman.join(' '))
  }

  if (opts.acronyms) {
    // Segments split at subtitles: "Metal Gear Solid 3: Snake Eater" → ["metal gear solid 3", "snake eater"].
    const segments = foldText(name)
      .replace(/['’‘`´]/g, '')
      .split(/\s*(?::|：|\s[-–—~]\s|~)\s*/)
      .map(ftsFold)
      .filter(Boolean)
    segments.forEach((seg, si) => {
      const ws = seg.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w))
      if (ws.length < 2) return
      const letters = ws.filter((w) => !/^\d+$/.test(w) && !(ROMAN[w] && ws.indexOf(w) > 0))
      if (letters.length < 2) return
      const initial = (w: string, i: number) => (/^\d+$/.test(w) ? w : ROMAN[w] && i > 0 ? null : w[0])
      const asIs = ws.map((w, i) => (/^\d+$/.test(w) || (ROMAN[w] && i > 0) ? w : w[0])).join('')
      const asArabic = ws.map((w, i) => initial(w, i) ?? String(ROMAN[w])).join('')
      // Subtitle initialisms need 3+ letters to be distinctive ("botw", "oot"); the head can be 2 ("ff", "kh").
      const min = si === 0 ? 2 : 3
      for (const a of [asIs, asArabic]) if (a.length >= min) add(a)
      if (ws[0] === 'the' && ws.length > 2) {
        const rest = ws.slice(1).map((w, i) => initial(w, i + 1) ?? String(ROMAN[w])).join('')
        if (rest.length >= min) add(rest)
      }
    })
  }
  return [...out]
}
