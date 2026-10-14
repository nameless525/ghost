import { describe, expect, it } from 'vitest'
import type { BrowseQuery } from '../../shared/types'
import { ftsFold, GAME_ALIASES, searchAliases, TITLE_ALIASES } from './aliases'
import { QueryEngine } from './query'
import { CatalogRepo } from './repo'
import { hit, memoryDb, P } from './testing'

describe('ftsFold', () => {
  it('drops apostrophes, spells out ampersands, spaces other punctuation', () => {
    expect(ftsFold("Assassin's Creed")).toBe('assassins creed')
    expect(ftsFold('Ratchet & Clank')).toBe('ratchet and clank')
    expect(ftsFold("Yu-Gi-Oh! 5D's")).toBe('yu gi oh 5ds')
    expect(ftsFold('Pokémon')).toBe('pokémon')
  })
})

describe('searchAliases', () => {
  const g = (s: string) => searchAliases(s, GAME_ALIASES)
  it('runs punctuation-joined words together', () => {
    expect(searchAliases('Yu-Gi-Oh! The Duelists of the Roses')).toContain('yugioh')
    expect(searchAliases('F-Zero GX')).toContain('fzero')
    expect(searchAliases('Q*bert')).toContain('qbert')
    expect(searchAliases('Spider-Man 2')).toContain('spiderman')
    expect(searchAliases('Hollow Knight')).toEqual([])
  })
  it('pairs adjacent words for game names', () => {
    expect(g('Mega Man X')).toContain('megaman')
    expect(g('Star Fox 64')).toContain('starfox')
    expect(searchAliases('Mega Man X', TITLE_ALIASES)).not.toContain('megaman')
  })
  it('swaps roman and arabic sequel numbers', () => {
    expect(g('Final Fantasy VII')).toEqual(expect.arrayContaining(['final fantasy 7', 'ff7', 'ffvii']))
    expect(g('Street Fighter 2')).toEqual(expect.arrayContaining(['street fighter ii', 'sf2']))
    expect(g('Kingdom Hearts II')).toEqual(expect.arrayContaining(['kingdom hearts 2', 'kh2', 'khii']))
    // a leading X is a word, not a ten
    expect(g('X-Men')).not.toContain('10 men')
  })
  it('builds initialisms per title segment', () => {
    const z = g('The Legend of Zelda: Breath of the Wild')
    expect(z).toEqual(expect.arrayContaining(['tloz', 'loz', 'botw']))
    expect(g('Metal Gear Solid 3: Snake Eater')).toContain('mgs3')
    // one-word segments have no initialism
    expect(g('Hollow Knight: Silksong')).toEqual(expect.arrayContaining(['hk']))
    expect(g('Hollow Knight: Silksong')).not.toContain('s')
  })
})

describe('search finds names however they are typed', () => {
  const db = memoryDb()
  const repo = new CatalogRepo(db)
  const qe = new QueryEngine(repo, () => 'lossless')
  const ids = repo.upsertHits(
    [
      hit('yugioh-fm', 'Yu-Gi-Oh! Forbidden Memories', 'gamerip', 1999, [P.ps1]),
      hit('yugioh-5ds', "Yu-Gi-Oh! 5D's Tag Force 4", 'gamerip', 2009, []),
      hit('ff7', 'Final Fantasy VII Original Soundtrack', 'ost', 1997, [P.ps1]),
      hit('ratchet', 'Ratchet & Clank', 'gamerip', 2002, []),
      hit('ac', "Assassin's Creed II", 'ost', 2009, []),
      hit('mmx', 'Mega Man X (SNES)', 'gamerip', 1993, [P.snes]),
      hit('botw', 'The Legend of Zelda: Breath of the Wild Original Soundtrack', 'ost', 2017, [P.switch]),
      hit('robot-wars', 'Battle Rage: The Robot Wars', 'gamerip', 2008, []),
      hit('mother-3', 'Mother 3', 'gamerip', 2006, []),
      hit('cave-story-mother-3', 'Cave Story (Mother 3)', 'remix', 2006, []),
      hit('cave-story', 'Cave Story', 'gamerip', 2004, [])
    ],
    { initial: true }
  )
  repo.assignGames(ids)
  const titles = (text: string) => qe.browse({ text, group: 'game', sort: 'title', offset: 0, limit: 50 } satisfies BrowseQuery).groups.map((x) => x.title)

  it.each([
    ['yugioh', ["Yu-Gi-Oh! 5D's Tag Force 4", 'Yu-Gi-Oh! Forbidden Memories']],
    ['yu gi oh', ["Yu-Gi-Oh! 5D's Tag Force 4", 'Yu-Gi-Oh! Forbidden Memories']],
    ['Yu-Gi-Oh', ["Yu-Gi-Oh! 5D's Tag Force 4", 'Yu-Gi-Oh! Forbidden Memories']],
    ['yugioh 5ds', ["Yu-Gi-Oh! 5D's Tag Force 4"]],
    ["5d's", ["Yu-Gi-Oh! 5D's Tag Force 4"]],
    ['final fantasy 7', ['Final Fantasy VII']],
    ['ff7', ['Final Fantasy VII']],
    ['ratchet and clank', ['Ratchet & Clank']],
    ['ratchet & clank', ['Ratchet & Clank']],
    ['assassins creed 2', ["Assassin's Creed II"]],
    ['megaman x', ['Mega Man X']],
    ['breath wild', ['The Legend of Zelda: Breath of the Wild']],
    ['zelda botw', ['The Legend of Zelda: Breath of the Wild']]
  ])('%s', (text, expected) => {
    expect(titles(text)).toEqual(expected)
  })

  it('whole-word matches rank ahead of substring matches', () => {
    // "botw" is also inside "robotwars" (a word-pair alias); the initialism match comes first.
    expect(titles('botw')).toEqual(['The Legend of Zelda: Breath of the Wild', 'Battle Rage: The Robot Wars'])
    // a game's own name beats an album title that mentions it
    expect(titles('mother 3')).toEqual(['Mother 3', 'Cave Story'])
  })

  it('soundtrack decoration is optional next to other words', () => {
    expect(titles('final fantasy 7 ost')).toEqual(['Final Fantasy VII'])
    expect(titles('mother 3 original soundtrack')).toEqual(['Mother 3', 'Cave Story'])
    // alone it's still a (substring) search term
    expect(titles('soundtrack')).toEqual(['Final Fantasy VII', 'The Legend of Zelda: Breath of the Wild'])
  })

  it('suggests close game names for typos', () => {
    expect(qe.suggest('ratchit and clank')[0]).toBe('Ratchet & Clank')
    expect(qe.suggest('legend of zelda breth of the wild')[0]).toBe('The Legend of Zelda: Breath of the Wild')
    expect(qe.suggest('mega mna')).toContain('Mega Man X')
    // nothing close, or too short to judge
    expect(qe.suggest('qwxz')).toEqual([])
    expect(qe.suggest('zz')).toEqual([])
  })

  it('rebuilds stale documents in the background', async () => {
    repo.setMeta('fts_version', '1')
    expect(repo.ftsStale()).toBe(true)
    db.exec(`DELETE FROM album_fts`)
    expect(titles('yugioh')).toEqual([])
    expect(await repo.rebuildFts(async () => {})).toBe(true)
    expect(repo.ftsStale()).toBe(false)
    expect(titles('yugioh')).toHaveLength(2)
  })
})
