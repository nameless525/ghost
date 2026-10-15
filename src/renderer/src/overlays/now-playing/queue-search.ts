// Queue search: pure matching and highlighting (QueueList's search field).
//
// Text is folded before comparing: case, accents (NFKD minus combining marks, plus a few letters
// NFKD keeps whole: ø æ œ ß …), punctuation and symbols are ignored, and "&" reads as "and".
// So "battle mid" finds "Battle ~ Mid-Boss", "midboss" finds it too, and "pokemon" finds Pokémon.
// A query is a list of words; a track matches when every word occurs somewhere in its title,
// original title, game, album or composers.
//
// Each queue item's folded text is built once and cached by track object (the player store keeps
// unchanged tracks' identity across pushes) and by content (a reorder hands every shifted row a
// new object with the same text), so filtering is one substring scan per word.
import type { QueueItem, TrackView } from '@shared/types'

const MARKS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g
const PUNCT = /[\p{P}\p{S}]/gu
const LETTERS: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', ı: 'i', þ: 'th', ħ: 'h' }
const SPECIAL = /[øæœßđðłıþħ]/g
const ASCII = /^[\x00-\x7f]*$/

/** Fold text for matching (see the header). Also used for the query. */
export function fold(s: string): string {
  if (ASCII.test(s)) return s.toLowerCase().replace(/&/g, ' and ').replace(PUNCT, '')
  return s
    .normalize('NFKD')
    .replace(MARKS, '')
    .toLowerCase()
    .replace(SPECIAL, (c) => LETTERS[c])
    .replace(/&/g, ' and ')
    .replace(PUNCT, '')
}

/** The query's words, folded; words contained in another word are dropped (they'd match anyway). */
export function queryWords(query: string): string[] {
  const words = [...new Set(query.split(/\s+/).map(fold).flatMap((w) => w.split(/\s+/)).filter(Boolean))]
  return words.filter((w) => !words.some((o) => o !== w && o.includes(w))).sort((a, b) => b.length - a.length)
}

/** The fields a queue row is searched by, joined; '\n' keeps words from running across fields. */
function rawText(t: TrackView): string {
  return `${t.title}\n${t.titleOriginal ?? ''}\n${t.gameName ?? ''}\n${t.albumTitle}\n${t.composers.join('\n')}`
}

const byTrack = new WeakMap<TrackView, string>()
const byText = new Map<string, string>()

/** A track's folded search text (cached). */
export function trackText(t: TrackView): string {
  let text = byTrack.get(t)
  if (text !== undefined) return text
  const raw = rawText(t)
  text = byText.get(raw)
  if (text === undefined) {
    if (byText.size > 50_000) byText.clear()
    text = fold(raw)
    byText.set(raw, text)
  }
  byTrack.set(t, text)
  return text
}

/** Folded search text per queue item, in queue order. */
export function queueTexts(queue: readonly QueueItem[]): string[] {
  const out = new Array<string>(queue.length)
  for (let i = 0; i < queue.length; i++) out[i] = trackText(queue[i].track)
  return out
}

/** True when `text` (folded) contains every word. */
export function matchesAll(text: string, words: readonly string[]): boolean {
  for (const w of words) if (!text.includes(w)) return false
  return true
}

/** Indices (ascending) of the texts that contain every word. */
export function matchIndices(texts: readonly string[], words: readonly string[]): number[] {
  const out: number[] = []
  if (!words.length) return out
  for (let i = 0; i < texts.length; i++) if (matchesAll(texts[i], words)) out.push(i)
  return out
}

export type Range = [start: number, end: number]

const COMBINING = /\p{M}/u

/**
 * Where the words occur in `text` (original, unfolded), as merged [start, end) ranges. The text is
 * folded character by character so every match maps back to the characters it came from.
 */
export function highlightRanges(text: string, words: readonly string[]): Range[] {
  if (!text || !words.length) return []
  let folded = ''
  const from: number[] = []
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i)
    let ch: string
    let f: string
    if (c < 0x80) {
      ch = text[i]
      f = c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ? ch : c === 38 ? ' and ' : fold(ch)
    } else {
      ch = String.fromCodePoint(text.codePointAt(i)!)
      f = fold(ch)
    }
    for (let k = 0; k < f.length; k++) from.push(i)
    folded += f
    i += ch.length
  }
  const ranges: Range[] = []
  for (const w of words) {
    for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + w.length)) {
      const last = from[at + w.length - 1]
      let end = last + (text.codePointAt(last)! > 0xffff ? 2 : 1)
      // keep a decomposed accent with its letter
      while (end < text.length && COMBINING.test(text[end])) end++
      ranges.push([from[at], end])
    }
  }
  if (ranges.length < 2) return ranges
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Range[] = [ranges[0]]
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1]
    if (ranges[i][0] <= prev[1]) prev[1] = Math.max(prev[1], ranges[i][1])
    else merged.push(ranges[i])
  }
  return merged
}

/** True when `field` contains one of the words that `shown` (already on screen) doesn't. */
export function addsMatch(field: string | null | undefined, shown: string, words: readonly string[]): boolean {
  if (!field) return false
  const f = fold(field)
  const s = fold(shown)
  return words.some((w) => !s.includes(w) && f.includes(w))
}
