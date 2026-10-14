import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBrowsePage } from '../providers/khinsider'
import { baseTitle, clusterKeys, franchiseGuess, gameKey, headKey, keyOf, pickGameName, sortKey } from './normalize'

describe('baseTitle / gameKey', () => {
  const cases: [string, string][] = [
    ['A Bird Story Original Soundtrack', 'A Bird Story'],
    ['A Bird Story', 'A Bird Story'],
    ['ACE COMBAT 7: SKIES UNKNOWN ORIGINAL SOUNDTRACK', 'ACE COMBAT 7: SKIES UNKNOWN'],
    ["Assassin's Creed II (Original Game Soundtrack)", "Assassin's Creed II"],
    ["Assassin's Creed IV: Black Flag Game Soundtrack - The Complete Edition", "Assassin's Creed IV: Black Flag"],
    ['Animal Crossing (full gamerip)', 'Animal Crossing'],
    ['Aladdin Original Motion Picture Soundtrack', 'Aladdin'],
    ['Chrono Trigger Arranged Version: The Brink of Time', 'Chrono Trigger'],
    ['Chrono Trigger Symphony Volume 1', 'Chrono Trigger Symphony'],
    ['Chrono Trigger: Orchestral Selections Vol. II', 'Chrono Trigger'],
    ['Chrono Trigger: Time Warp Melodies', 'Chrono Trigger: Time Warp Melodies'],
    ['Hollow Knight - Pale court DLC', 'Hollow Knight'],
    ['Hollow Knight (Original Soundtrack)', 'Hollow Knight'],
    ['Darkest Dungeon II: Kingdoms Original Video Game Soundtrack', 'Darkest Dungeon II: Kingdoms'],
    ["Dandy's World [ALPHA]", "Dandy's World"],
    ['Mega Man X (SNES)', 'Mega Man X'],
    ['Final Fantasy VI Original Sound Version', 'Final Fantasy VI'],
    ['The Legend of Zelda: Ocarina of Time Original Soundtrack', 'The Legend of Zelda: Ocarina of Time'],
    ['Super Mario 64 Soundtrack', 'Super Mario 64'],
    ['Halo 3 OST', 'Halo 3'],
    ['Halo 3 - OST', 'Halo 3'],
    ['Sonic the Hedgehog (Mega Drive / Genesis) (Gamerip) (1991)', 'Sonic the Hedgehog'],
    ['Xenoblade Chronicles 2 Original Soundtrack Vol. 1', 'Xenoblade Chronicles 2'],
    ['Persona 5 Original Soundtrack (Disc 1)', 'Persona 5'],
    ['BEYOND THE FLOW OF TIME: Music from Chrono Trigger', 'Chrono Trigger'],
    ['Chronology: A Jazz Tribute to Chrono Trigger', 'Chrono Trigger'],
    ['The Last of Us Part II Original Soundtrack', 'The Last of Us Part II'],
    ['Chrono Trigger Remixes', 'Chrono Trigger'],
    ['Chrono Trigger [Piano Cover Album]', 'Chrono Trigger'],
    ['NieR:Automata Original Soundtrack', 'NieR:Automata'],
    ['FIFA 2002', 'FIFA 2002'],
    ['OST', 'OST'],
    ['Soundtrack', 'Soundtrack'],
    ['(Untitled)', '(Untitled)'],
    ['A OST in Time', 'A OST in Time'],
    ['A Dance of Fire and Ice - The Official Soundtrack', 'A Dance of Fire and Ice'],
    ['Bastion The Original Soundtrack', 'Bastion'],
    ['Ys OST', 'Ys'],
    ['A Bird Story <OST>', 'A Bird Story'],
    ['<A Bird Story> OST', 'A Bird Story'],
    ['(Gamerip)', '(Gamerip)'],
    ['ゼルダの伝説《サウンドトラック》', 'ゼルダの伝説']
  ]
  it.each(cases)('%s → %s', (title, expected) => {
    expect(baseTitle(title)).toBe(expected)
  })

  it('keys merge spelling variants', () => {
    expect(gameKey('OCTOPATH TRAVELER Original Soundtrack')).toBe(gameKey('Octopath Traveler (Gamerip)'))
    expect(gameKey("Assassin's Creed II")).toBe('assassins creed ii')
    expect(gameKey('Pokémon Red & Blue')).toBe('pokemon red and blue')
    expect(gameKey('The Legend of Zelda')).toBe('legend of zelda')
    expect(gameKey('ＦＩＮＡＬ ＦＡＮＴＡＳＹ Ⅵ')).toBe(gameKey('final fantasy vi'))
    expect(gameKey('NieR:Automata (Gamerip)')).toBe(gameKey('NieR:Automata Original Soundtrack'))
    expect(gameKey('クロノ・トリガー オリジナル・サウンドトラック')).toBe('クロノ トリガー')
    expect(gameKey('ゼルダの伝説 サウンドトラック')).toBe('ゼルダの伝説')
    expect(keyOf('  ')).toBe('')
  })

  it('headKey splits subtitles only', () => {
    expect(headKey('Chrono Trigger: Time Warp Melodies')).toBe('chrono trigger')
    expect(headKey('Persona 5 Royal - Take Over (Single)')).toBe('persona 5 royal')
    expect(headKey('Chrono Trigger')).toBeNull()
  })

  it('sortKey drops leading "The" and punctuation', () => {
    expect(sortKey('The Legend of Zelda')).toBe('legend of zelda')
    expect(sortKey('"Air" Theme')).toBe('air" theme')
    expect(sortKey('.hack//Infection')).toBe('hack//infection')
  })
})

describe('franchiseGuess', () => {
  it.each([
    ['Final Fantasy VI', 'Final Fantasy'],
    ['The Legend of Zelda: Ocarina of Time', 'The Legend of Zelda'],
    ['Mega Man X', 'Mega Man'],
    ['Mega Man 2', 'Mega Man'],
    ['ACE COMBAT 7: SKIES UNKNOWN', 'ACE COMBAT'],
    ['Halo', 'Halo'],
    ['Tetris 99', 'Tetris']
  ])('%s → %s', (name, expected) => {
    expect(franchiseGuess(name)).toBe(expected)
  })
  it('too short', () => {
    expect(franchiseGuess('X2')).toBeNull()
  })
})

describe('clustering', () => {
  it('merges OST + gamerip + arrangement-with-subtitle into one game; keeps sequels separate', () => {
    const albums = [
      { id: 1, title: 'Chrono Trigger Original Sound Version', kind: 'ost' as const },
      { id: 2, title: 'Chrono Trigger (SNES) (Gamerip)', kind: 'gamerip' as const },
      { id: 3, title: 'Chrono Trigger: Time Warp Melodies', kind: 'arrange' as const },
      { id: 4, title: 'Chrono Trigger Arranged Version: The Brink of Time', kind: 'arrange' as const },
      { id: 5, title: 'Chrono Cross Original Soundtrack', kind: 'ost' as const },
      { id: 6, title: 'Hollow Knight', kind: 'ost' as const },
      { id: 7, title: 'Hollow Knight: Silksong', kind: 'ost' as const },
      { id: 8, title: 'Hollow Knight: Gods & Nightmares', kind: 'ost' as const },
      { id: 9, title: 'Hollow Knight - Lazy Moonkin', kind: 'arrange' as const }
    ]
    const keys = clusterKeys(albums)
    expect(new Set([1, 2, 3, 4].map((id) => keys.get(id))).size).toBe(1)
    expect(keys.get(5)).not.toBe(keys.get(1))
    expect(keys.get(7)).not.toBe(keys.get(6))
    expect(keys.get(8)).not.toBe(keys.get(6))
    expect(keys.get(9)).toBe(keys.get(6))
  })

  it('pickGameName prefers OST / mixed case / short', () => {
    expect(
      pickGameName([
        { title: 'ACE COMBAT 7: SKIES UNKNOWN ORIGINAL SOUNDTRACK', kind: 'ost', year: 2019 },
        { title: 'Ace Combat 7: Skies Unknown (Gamerip)', kind: 'gamerip', year: 2019 }
      ])
    ).toBe('Ace Combat 7: Skies Unknown')
    expect(
      pickGameName([
        { title: 'a highland song Original Score', kind: 'ost', year: 2023 },
        { title: 'A Highland Song', kind: 'gamerip', year: 2023 }
      ])
    ).toBe('A Highland Song')
    expect(
      pickGameName([
        { title: 'Chrono Trigger: Orchestral Selections', kind: 'arrange', year: 2015 },
        { title: 'Chrono Trigger Original Sound Version', kind: 'ost', year: 1995 }
      ])
    ).toBe('Chrono Trigger')
  })

  it('real letter page: clusters 500 albums into fewer games with sane names', () => {
    const page = parseBrowsePage(readFileSync(join(__dirname, '../providers/__fixtures__/khinsider/browse-A.html'), 'utf8'))
    const keys = clusterKeys(page.items.map((h, i) => ({ id: i, title: h.title, kind: h.kind })))
    const games = new Set(keys.values())
    expect(games.size).toBeLessThan(page.items.length)
    expect(games.size).toBeGreaterThan(page.items.length * 0.5)
    expect([...games].every((k) => k.length > 0)).toBe(true)
    const bird = page.items.map((h, i) => [h.title, keys.get(i)] as const).filter(([t]) => /^A Bird Story/.test(t))
    expect(new Set(bird.map(([, k]) => k)).size).toBe(1)
  })
})
