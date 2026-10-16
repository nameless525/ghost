import { describe, expect, it } from 'vitest'
import { channelTrust, cleanTrackTitle, combineScore, durationFit, looksNumbered, penaltyHits, titleSimilarity, tokens } from './match'

describe('match: duration fit (±2 s full credit, zero at ±15 s)', () => {
  it('is 1 within two seconds', () => {
    expect(durationFit(120_000, 120_000)).toBe(1)
    expect(durationFit(120_000, 122_000)).toBe(1)
    expect(durationFit(120_000, 118_000)).toBe(1)
  })
  it('falls linearly to zero at fifteen seconds', () => {
    expect(durationFit(120_000, 128_500)).toBeCloseTo(0.5, 3)
    expect(durationFit(120_000, 111_500)).toBeCloseTo(0.5, 3)
    expect(durationFit(120_000, 135_000)).toBe(0)
    expect(durationFit(120_000, 3_600_000)).toBe(0)
    expect(durationFit(120_000, 125_000)).toBeCloseTo(1 - 3000 / 13000, 3)
  })
  it('unknown durations are neutral-ish', () => {
    expect(durationFit(null, 120_000)).toBe(0.5)
    expect(durationFit(120_000, null)).toBe(0.3)
  })
})

describe('match: penalty words', () => {
  it('flags not-the-original uploads', () => {
    expect(penaltyHits('Hollow Knight - OST Dirtmouth 1 hour Extended')).toEqual(['extended', 'hours'])
    expect(penaltyHits('Dirtmouth - Hollow Knight OST (10 Hours)')).toEqual(['hours'])
    expect(penaltyHits('Hornet - Hollow Knight for Piano Quartet')).toEqual(['piano', 'orchestral'])
    expect(penaltyHits('Megalovania (Slowed + Reverb)')).toEqual(['slowed'])
    expect(penaltyHits('Gerudo Valley [Nightcore]')).toEqual(['nightcore'])
    expect(penaltyHits('Reacting to the Undertale OST')).toEqual(['reaction'])
    expect(penaltyHits('One Winged Angel (Live at Distant Worlds)')).toEqual(['live'])
    expect(penaltyHits('Bloody Tears (Metal Remix)')).toEqual(['remix', 'style'])
    expect(penaltyHits('Corridors of Time - acoustic guitar cover')).toEqual(['cover', 'instrument'])
    expect(penaltyHits('Hollow Knight Ambience - Dirtmouth')).toEqual(['ambience'])
    expect(penaltyHits('Hollow Knight OST - Dirtmouth')).toEqual([])
    expect(penaltyHits('Enter Hallownest')).toEqual([])
  })
  it('does not penalise words the canonical track has itself', () => {
    expect(penaltyHits('A Bird Story (Piano)', ['A Bird Story (Piano)'])).toEqual([])
    expect(penaltyHits('Dancing Mad (Orchestral Version)', ['Dancing Mad', 'Final Fantasy VI Orchestral Album'])).toEqual([])
    expect(penaltyHits('Live and Learn', ['Live and Learn'])).toEqual([])
  })
  it('each hit costs a quarter of the score', () => {
    const parts = { title: 1, duration: 1, trust: 1, quality: 1 }
    expect(combineScore({ ...parts, penalties: [] })).toBe(1)
    expect(combineScore({ ...parts, penalties: ['remix'] })).toBe(0.75)
    expect(combineScore({ ...parts, penalties: ['remix', 'hours', 'piano', 'slowed', 'live'] })).toBe(0)
    expect(combineScore({ title: 1, duration: 0, trust: 0.3, quality: 0.5, penalties: [] })).toBeCloseTo(0.45 + 0.03 + 0.05, 5)
  })
})

describe('match: title similarity', () => {
  const ctx = { context: ['Hollow Knight', 'Hollow Knight Original Soundtrack'] }
  it('ignores game names, OST noise, track numbers and channel names', () => {
    expect(titleSimilarity('Dirtmouth', 'Hollow Knight OST - Dirtmouth', ctx)).toBe(1)
    expect(titleSimilarity('Dirtmouth', 'Hollow Knight Original Soundtrack 02 - "Dirtmouth" (HQ)', ctx)).toBe(1)
    expect(titleSimilarity('Dirtmouth', 'Dirtmouth', { ...ctx, channel: 'Christopher Larkin - Topic' })).toBe(1)
    expect(titleSimilarity('Enter Hallownest', 'Christopher Larkin - Enter Hallownest', { ...ctx, channel: 'Christopher Larkin' })).toBe(1)
  })
  it('normalises case, accents, apostrophes and roman numerals', () => {
    expect(titleSimilarity("Queen's Gardens", 'HOLLOW KNIGHT OST - QUEENS GARDENS', ctx)).toBe(1)
    expect(titleSimilarity('Pokémon Center', 'Pokemon Center', {})).toBe(1)
    expect(titleSimilarity('Final Fantasy VII Main Theme', 'Final Fantasy 7 Main Theme', {})).toBe(1)
  })
  it('extra words cost precision; missing words cost recall', () => {
    const extra = titleSimilarity('Dirtmouth', 'Dirtmouth Ambience Rain Wind Sounds', ctx)
    expect(extra).toBeLessThan(1)
    expect(extra).toBeGreaterThan(0.75)
    expect(titleSimilarity('Truth, Beauty and Hatred', 'Truth Beauty', ctx)).toBeLessThan(0.8)
    expect(titleSimilarity('Dirtmouth', 'Crossroads', ctx)).toBe(0)
  })
  it('a one-letter typo in a long word still matches', () => {
    expect(titleSimilarity('Hallownest', 'Halownest', {})).toBe(1)
  })
  it('another numbered variant is another track; track numbers and game names are not variants', () => {
    expect(titleSimilarity('Boss Battle 1', 'Boss Battle 2', {})).toBe(0)
    expect(titleSimilarity('Stage II', 'Stage 3', {})).toBe(0)
    expect(titleSimilarity('Final Fantasy VII Main Theme', 'Final Fantasy VIII Main Theme', {})).toBe(0)
    expect(titleSimilarity('Ending (Part 1)', 'Ending (Part 2) [2017]', {})).toBe(0)
    // A leading track number is decoration, even when it happens to be the wanted variant's number.
    expect(titleSimilarity('Boss Battle 1', '01 - Boss Battle 2', {})).toBe(0)
    expect(titleSimilarity('Boss Battle 1', '02 - Boss Battle 1', {})).toBe(1)
    expect(titleSimilarity('Dirtmouth', '02 - Dirtmouth', ctx)).toBe(1)
    // Arabic and Roman numerals name the same variant.
    expect(titleSimilarity('Stage II', 'Stage 2', {})).toBe(1)
    expect(titleSimilarity('Boss Battle 2', 'Chrono Trigger OST 02 - Boss Battle II', { context: ['Chrono Trigger'] })).toBe(1)
    // The number in a game's name doesn't name a variant, nor does a name's first word ("I" reads as 1).
    expect(titleSimilarity('Boss Battle 1', 'Boss Battle 1 - Mega Man 2 OST', { context: ['Mega Man 2'] })).toBe(1)
    expect(titleSimilarity('Boss Battle 1', 'Mega Man 2 - Boss Battle', { context: ['Mega Man 2'] })).toBeGreaterThan(0.6)
    expect(titleSimilarity('I Will Be Here', 'I Will Be Here (Part 2)', {})).toBeGreaterThan(0.6)
  })
  it('tokens', () => {
    expect(tokens('Hornet + Daughter of Hallownest & Co.')).toEqual(['hornet', 'daughter', 'of', 'hallownest', 'and', 'co'])
  })
})

describe('match: channel trust', () => {
  it('Topic channels > composer / label channels > verified > anyone', () => {
    expect(channelTrust('Christopher Larkin - Topic')).toBe(1)
    expect(channelTrust('Christopher Larkin', true, { composers: ['Christopher Larkin'] })).toBe(0.9)
    expect(channelTrust('Square Enix Music')).toBe(0.85)
    expect(channelTrust('Materia Collective')).toBe(0.85)
    expect(channelTrust('Random Uploader', true)).toBe(0.6)
    expect(channelTrust('Random Uploader')).toBe(0.3)
    expect(channelTrust(null)).toBe(0.3)
  })
})

describe('match: title cleanup', () => {
  const names = ['Hollow Knight', 'Hollow Knight OST - Playlist']
  it('removes game prefixes / suffixes and OST decoration', () => {
    expect(cleanTrackTitle('Hollow Knight OST - Enter Hallownest', { names })).toBe('Enter Hallownest')
    expect(cleanTrackTitle("Hollow Knight OST - Queen's Gardens", { names })).toBe("Queen's Gardens")
    expect(cleanTrackTitle('Dirtmouth - Hollow Knight OST', { names })).toBe('Dirtmouth')
    // "Theme" / "Music" / "Score" are track-name words unless they follow the game's name
    expect(cleanTrackTitle("Frog's Theme")).toBe("Frog's Theme")
    expect(cleanTrackTitle('Battle (Main Theme)')).toBe('Battle (Main Theme)')
    expect(cleanTrackTitle('Theme of Love')).toBe('Theme of Love')
    expect(cleanTrackTitle('Chrono Trigger Music - Corridors of Time', { names: ['Chrono Trigger'] })).toBe('Corridors of Time')
    expect(cleanTrackTitle('Corridors of Time [Official Music Video]')).toBe('Corridors of Time')
    expect(cleanTrackTitle('Corridors of Time - OST')).toBe('Corridors of Time')
    expect(cleanTrackTitle('Chrono Trigger (Chronos Theme)', { names: ['Chrono Trigger'] })).toBe('Chronos Theme')
    expect(cleanTrackTitle('(Untitled)')).toBe('(Untitled)')
    expect(cleanTrackTitle('Crossroads (Hollow Knight OST)', { names })).toBe('Crossroads')
    expect(cleanTrackTitle('[Hollow Knight] Greenpath', { names })).toBe('Greenpath')
    expect(cleanTrackTitle('Hollow Knight: Soul Sanctum | Official Soundtrack', { names })).toBe('Soul Sanctum')
    expect(cleanTrackTitle('Hollow Knight - Hollow Knight', { names })).toBe('Hollow Knight')
  })
  it('removes track numbers', () => {
    expect(cleanTrackTitle('01. Enter Hallownest')).toBe('Enter Hallownest')
    expect(cleanTrackTitle('03 - Crossroads')).toBe('Crossroads')
    expect(cleanTrackTitle('Track 5: Greenpath')).toBe('Greenpath')
    expect(cleanTrackTitle('1-03 Crossroads')).toBe('Crossroads')
    expect(cleanTrackTitle('07 Reflection')).toBe('Reflection')
    expect(cleanTrackTitle('Hollow Knight OST - 03 - Crossroads (HQ)', { names })).toBe('Crossroads')
    expect(cleanTrackTitle('10 Daughter of Hallownest', { numbered: true })).toBe('Daughter of Hallownest')
  })
  it('keeps titles that only look like decoration', () => {
    expect(cleanTrackTitle('1-Up')).toBe('1-Up')
    expect(cleanTrackTitle('99 Luftballons')).toBe('99 Luftballons')
    expect(cleanTrackTitle('Hollow Knight', { names })).toBe('Hollow Knight')
    expect(cleanTrackTitle('OST')).toBe('OST')
  })
  it('strips channel names and noise brackets', () => {
    expect(cleanTrackTitle('Christopher Larkin - Mantis Lords', { channel: 'Christopher Larkin - Topic' })).toBe('Mantis Lords')
    expect(cleanTrackTitle('Mantis Lords (Official Audio)')).toBe('Mantis Lords')
    expect(cleanTrackTitle('"Radiance"')).toBe('Radiance')
  })
  it('detects numbered lists', () => {
    expect(looksNumbered(['01 A', '02 B', '03 C', 'Bonus'])).toBe(true)
    expect(looksNumbered(['A', 'B', '3 C'])).toBe(false)
  })
})
