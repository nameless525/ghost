import { describe, expect, it } from 'vitest'
import type { QueueItem, TrackView } from '@shared/types'
import { addsMatch, fold, highlightRanges, matchIndices, queryWords, queueTexts, trackText } from './queue-search'

const track = (title: string, more: Partial<TrackView> = {}): TrackView => ({
  id: title,
  albumId: 'a',
  disc: 1,
  number: 1,
  title,
  titleOriginal: null,
  durationMs: 60000,
  composers: [],
  albumTitle: 'Album',
  albumKind: 'ost',
  gameId: null,
  gameName: null,
  year: null,
  platforms: [],
  cover: null,
  hero: null,
  accent: null,
  liked: false,
  downloaded: false,
  source: null,
  analysis: null,
  ...more
})

/** The highlighted pieces of `text`. */
const marked = (text: string, query: string) => highlightRanges(text, queryWords(query)).map(([s, e]) => text.slice(s, e))

describe('fold', () => {
  it('ignores case, accents and punctuation', () => {
    expect(fold('Pokémon')).toBe('pokemon')
    expect(fold('Battle ~ Mid-Boss')).toBe('battle  midboss')
    expect(fold("Frog's Theme")).toBe('frogs theme')
    expect(fold('Ōkami')).toBe('okami')
  })
  it('folds letters NFKD keeps whole, and & as and', () => {
    expect(fold('Ødegaard Æther Straße')).toBe('odegaard aether strasse')
    expect(fold('Dungeons & Dragons')).toBe('dungeons  and  dragons')
  })
  it('keeps Japanese voicing marks (only Latin accents are dropped)', () => {
    expect(fold('ガ')).not.toBe(fold('カ'))
    expect(fold('ｶﾞ')).toBe(fold('ガ'))
  })
})

describe('queryWords', () => {
  it('splits, folds and drops empty words', () => {
    expect(queryWords('  Battle   MID ')).toEqual(['battle', 'mid'])
    expect(queryWords('~ - !')).toEqual([])
  })
  it('drops words another word already covers, longest first', () => {
    expect(queryWords('bat battle b')).toEqual(['battle'])
    expect(queryWords('the theme')).toEqual(['theme'])
  })
})

describe('matching', () => {
  const items: QueueItem[] = [
    track('Battle ~ Mid-Boss', { gameName: 'Chrono Trigger', composers: ['Yasunori Mitsuda'] }),
    track('Peaceful Days', { gameName: 'Chrono Trigger', albumTitle: 'Chrono Trigger OSV' }),
    track('Boss Battle', { gameName: 'Pokémon Red', composers: ['Junichi Masuda'] }),
    track('ハイラル城', { titleOriginal: 'Hyrule Castle', gameName: 'Zelda' })
  ].map((t, i) => ({ uid: `u${i}`, track: t }))
  const texts = queueTexts(items)
  const find = (q: string) => matchIndices(texts, queryWords(q))

  it('needs every word, in any field', () => {
    expect(find('battle mid')).toEqual([0])
    expect(find('battle')).toEqual([0, 2])
    expect(find('chrono mitsuda')).toEqual([0])
    expect(find('osv')).toEqual([1])
    expect(find('pokemon masuda')).toEqual([2])
    expect(find('castle')).toEqual([3])
    expect(find('battle zelda')).toEqual([])
  })
  it('is forgiving with punctuation', () => {
    expect(find('midboss')).toEqual([0])
    expect(find('mid-boss')).toEqual([0])
  })
  it('an empty query matches nothing (the caller shows the whole list)', () => {
    expect(find('')).toEqual([])
  })
  it('caches by track object and by content', () => {
    const t = track('Same', { gameName: 'Game' })
    const a = trackText(t)
    expect(trackText(t)).toBe(a)
    expect(trackText({ ...t })).toBe(a)
  })
})

describe('highlightRanges', () => {
  it('maps matches back to the original text', () => {
    expect(marked('Battle ~ Mid-Boss', 'battle mid')).toEqual(['Battle', 'Mid'])
    expect(marked('Battle ~ Mid-Boss', 'midboss')).toEqual(['Mid-Boss'])
    expect(marked('Pokémon Red', 'pokemon')).toEqual(['Pokémon'])
  })
  it('marks every occurrence and merges overlaps', () => {
    expect(marked('Boss Battle Boss', 'boss')).toEqual(['Boss', 'Boss'])
    expect(marked('Battle', 'batt ttle')).toEqual(['Battle'])
  })
  it('keeps decomposed accents and surrogate pairs whole', () => {
    expect(marked('Pokeḿon', 'pokemon')).toEqual(['Pokeḿon'])
    expect(marked('𝄞 Clef', 'clef')).toEqual(['Clef'])
    expect(marked('Ægis', 'ae')).toEqual(['Æ'])
  })
  it('nothing to mark', () => {
    expect(highlightRanges('Battle', [])).toEqual([])
    expect(marked('Battle', 'zelda')).toEqual([])
  })
})

describe('addsMatch', () => {
  it('only when the field shows a word the visible text lacks', () => {
    const w = queryWords('battle mitsuda')
    expect(addsMatch('Yasunori Mitsuda', 'Battle · Chrono Trigger', w)).toBe(true)
    expect(addsMatch('Battle Album', 'Battle · Chrono Trigger', w)).toBe(false)
    expect(addsMatch(null, 'x', w)).toBe(false)
  })
})

describe('performance', () => {
  it('filters a 5,000-track queue fast', () => {
    const words = ['battle', 'theme', 'town', 'field', 'boss', 'castle', 'overworld', 'ending']
    const games = ['Chrono Trigger', 'Final Fantasy VI', 'Pokémon Red', 'The Legend of Zelda', 'Mother 3', 'Kingdom Hearts II', 'Ōkami', 'Mega Man X']
    const items: QueueItem[] = Array.from({ length: 5000 }, (_, i) => ({
      uid: `u${i}`,
      track: track(`${words[i % 8]} ${words[(i * 7) % 8]} ~ Part ${i}`, {
        gameName: games[i % 8],
        albumTitle: `${games[i % 8]} Original Soundtrack`,
        composers: ['Yasunori Mitsuda', 'Nobuo Uematsu'].slice(0, 1 + (i % 2)),
        titleOriginal: i % 5 ? null : 'バトル'
      })
    }))
    const time = (fn: () => void, runs = 20) => {
      fn()
      const t0 = performance.now()
      for (let i = 0; i < runs; i++) fn()
      return (performance.now() - t0) / runs
    }
    // cold index (every track folded) vs warm (cached), then one keystroke's filter
    const t0 = performance.now()
    const texts = queueTexts(items)
    const cold = performance.now() - t0
    const warm = time(() => queueTexts(items))
    const reordered = items.map((q) => ({ ...q, track: { ...q.track } }))
    const shifted = time(() => queueTexts(reordered), 1)
    const filter1 = time(() => matchIndices(texts, queryWords('b')))
    const filter3 = time(() => matchIndices(texts, queryWords('battle chrono mitsuda')))
    const miss = time(() => matchIndices(texts, queryWords('zzzz')))
    console.log(
      `queue search, 5000 tracks: index cold ${cold.toFixed(2)} ms, warm ${warm.toFixed(2)} ms, after a reorder ${shifted.toFixed(2)} ms; ` +
        `filter "b" ${filter1.toFixed(2)} ms, "battle chrono mitsuda" ${filter3.toFixed(2)} ms, no match ${miss.toFixed(2)} ms`
    )
    expect(matchIndices(texts, queryWords('battle chrono mitsuda')).length).toBeGreaterThan(0)
    expect(filter3).toBeLessThan(16)
  })
})
