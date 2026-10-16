import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ArchiveListing, EngineSource } from '../engine/types'
import { NetError } from '../net/errors'
import type { HttpClient, PageResult } from '../net/http'
import {
  buildChipTracks,
  chipAlbumHit,
  chipAlbumTitle,
  chipCacheKey,
  chipLocator,
  ChipProvider,
  cleanFileTitle,
  cleanNezTitle,
  composersFromComments,
  isLetterDir,
  joshwPageSets,
  JOSHW_SOURCES,
  joshwSource,
  parseApacheListing,
  parseChipLocator,
  parseListingSize,
  parseNezLine,
  parseNezPlaylist,
  parseNezTime,
  parseRipSetName,
  parseVgmripsListing,
  parseVgmripsPack,
  parseVgmTime,
  splitNezFields,
  uninvertArticle,
  vgmripsTitles
} from './chip'

const dir = join(__dirname, '__fixtures__', 'chip')
const fx = (name: string) => readFileSync(join(dir, name), 'utf8')
const listing = (name: string) => JSON.parse(fx(`listing-${name}.json`)) as ArchiveListing
const src = (host: string) => joshwSource(host)!

function fakeHttp(pages: Record<string, string>): HttpClient & { requests: string[] } {
  const requests: string[] = []
  return {
    requests,
    async pageFetch(url): Promise<PageResult> {
      requests.push(url)
      const v = pages[url]
      if (v === undefined) throw new NetError('not_found', `no fixture for ${url}`)
      return { url, status: 200, html: v, fromCache: false, stale: false, fetchedAt: Date.now() }
    },
    async fetchBytes() {
      throw new Error('not used')
    },
    limiter() {
      throw new Error('not used')
    },
    blockedUntil: () => 0,
    invalidate: async () => {}
  }
}

const sourceOf = (t: { streams?: { source: EngineSource }[] }) => t.streams![0].source as Extract<EngineSource, { kind: 'http' }>

describe('chip: joshw directory listings', () => {
  it('reads the root of a format host: letter directories only', () => {
    const root = parseApacheListing(fx('joshw-nsf-root.html'))
    const dirs = root.filter((d) => d.dir).map((d) => d.name)
    expect(dirs).toEqual(['0-9', ...'abcdefghijklmnopqrstuvwxyz'.split(''), 'zzz_prototypes', 'zzz_unlicensed'])
    expect(root.find((d) => d.name === 'robots.txt')).toMatchObject({ dir: false, sizeBytes: 26 })
    expect(dirs.every(isLetterDir)).toBe(true)
    // kss. has a system level first
    const kss = parseApacheListing(fx('joshw-kss-root.html')).filter((d) => d.dir)
    expect(kss.map((d) => d.name)).toEqual(['Game Gear', 'MSX', 'Master System', 'lost+found'])
    expect(kss.map((d) => d.href)).toContain('Master%20System/')
    expect(isLetterDir('MSX')).toBe(false)
  })

  it('reads set rows with decoded names, sizes and dates', () => {
    const rows = parseApacheListing(fx('joshw-nsf-m.html')).filter((d) => !d.dir)
    expect(rows.length).toBe(128)
    const mm2 = rows.find((r) => r.name.startsWith('Mega Man 2 [RockMan 2'))!
    expect(mm2.name).toBe('Mega Man 2 [RockMan 2 - Dr. Wily no Nazo] (1988-12-24)(Capcom)[NES].7z')
    expect(mm2.href).toBe('Mega%20Man%202%20%5bRockMan%202%20-%20Dr.%20Wily%20no%20Nazo%5d%20(1988-12-24)(Capcom)%5bNES%5d.7z')
    expect(mm2.sizeBytes).toBe(11 * 1024)
    expect(mm2.modified).toBe(Date.UTC(2026, 7, 5, 16, 32))
    // HTML entities in names
    expect(rows.some((r) => r.name === 'Mahjong (1983-08-27)(Nintendo R&D1)(Nintendo)[NES].7z')).toBe(true)
    expect(parseListingSize('285K')).toBe(285 * 1024)
    expect(parseListingSize('1.1G')).toBe(Math.round(1.1 * 1024 ** 3))
    expect(parseListingSize('972')).toBe(972)
    expect(parseListingSize('-')).toBeNull()
  })
})

describe('chip: set names → title / system / year', () => {
  it('parses the HCS64 naming scheme', () => {
    expect(parseRipSetName('Mega Man 2 [RockMan 2 - Dr. Wily no Nazo] (1988-12-24)(Capcom)[NES].7z')).toEqual({
      title: 'Mega Man 2',
      altTitles: ['RockMan 2 - Dr. Wily no Nazo'],
      date: '1988-12-24',
      year: 1988,
      developers: ['Capcom'],
      publishers: ['Capcom'],
      systemTag: 'NES',
      tags: [],
      qualifiers: [],
      region: null
    })
    const cv = parseRipSetName('Castlevania - Dracula X [Akumajou Dracula XX] [Castlevania - Vampire\'s Kiss] (1995-07-21)(KCE Osaka)(Konami)[SNES].7z')!
    expect(cv).toMatchObject({ title: 'Castlevania - Dracula X', altTitles: ['Akumajou Dracula XX', "Castlevania - Vampire's Kiss"], year: 1995, developers: ['KCE Osaka'], publishers: ['Konami'], systemTag: 'SNES' })
    expect(parseRipSetName('Chrono Trigger (1995-03-11)(Square)[SNES].7z')).toMatchObject({ title: 'Chrono Trigger', year: 1995, systemTag: 'SNES' })
    // the system after the companies, in parentheses
    expect(parseRipSetName('Chrono Trigger (1995-03-11)(Square)(SNES).7z')).toMatchObject({ title: 'Chrono Trigger', year: 1995, developers: ['Square'], publishers: ['Square'], systemTag: 'SNES' })
  })

  it('handles qualifiers, regions, extra tags, placeholders and unknown dates', () => {
    expect(parseRipSetName('Mega Man 2 [RockMan 2 - Dr. Wily no Nazo] (Game Genie)(1988-12-24)(Capcom)[NES].7z')).toMatchObject({ title: 'Mega Man 2', qualifiers: ['Game Genie'] })
    expect(parseRipSetName('Mega Man 6 JP [RockMan 6 - Shijou Saidai no Tatakai!!] (1993-11-05)(Capcom)[NES].7z')).toMatchObject({ title: 'Mega Man 6', region: 'JP' })
    expect(parseRipSetName('Claymates (1993-11-20)(Visual Concepts)(Interplay)[SNES][SNSF].7z')).toMatchObject({ systemTag: 'SNES', tags: ['SNSF'] })
    expect(parseRipSetName('California Games II (1993-01)(Silicon Sorcery)(DTMC)[SNES][mod].7z')).toMatchObject({ year: 1993, tags: ['mod'] })
    expect(parseRipSetName('Captain Tsubasa III - Koutei no Chousen (1992-07-12)(-)(Tecmo)[SNES].7z')).toMatchObject({ developers: [], publishers: ['Tecmo'] })
    expect(parseRipSetName('Caravan Shooting Collection (1995-07-07)(Hudson, Tecmo)(Hudson)[SNES].7z')).toMatchObject({ developers: ['Hudson', 'Tecmo'], publishers: ['Hudson'] })
    expect(parseRipSetName('Cheap de Gorgeous (19xx)(-)(Nintendo)[SNES].7z')).toMatchObject({ title: 'Cheap de Gorgeous', date: '19xx', year: null, publishers: ['Nintendo'] })
    expect(parseRipSetName('Creepy Bird (Homebrew)(2014)(Piko Interactive)[SNES].7z')).toMatchObject({ title: 'Creepy Bird', qualifiers: ['Homebrew'], year: 2014 })
    expect(parseRipSetName('SD Gundam - Gashapon Wars (Taikenban) (2005-12-01)(Banpresto)[GC].7z')).toMatchObject({ title: 'SD Gundam - Gashapon Wars', qualifiers: ['Taikenban'] })
    // a parenthesised part of the real title stays in it
    expect(parseRipSetName('Gradius (Gofer no Yabou) (1988)(Konami)[MSX].7z')).toMatchObject({ title: 'Gradius (Gofer no Yabou)' })
    expect(parseRipSetName('readme.txt')).toBeNull()
  })

  it('un-inverts articles', () => {
    expect(parseRipSetName('Magic Candle, The (1992-03-06)(Japan Soft Technology)(Sammy)[NES].7z')!.title).toBe('The Magic Candle')
    expect(parseRipSetName('Mafat Conspiracy, The [Golgo 13 - The Riddle of Icarus] (1990-06)(Aicom)(VIC Tokai)[NES].7z')).toMatchObject({ title: 'The Mafat Conspiracy', altTitles: ['Golgo 13 - The Riddle of Icarus'] })
    expect(uninvertArticle('Legend of Zelda, The - A Link to the Past')).toBe('The Legend of Zelda - A Link to the Past')
    expect(uninvertArticle('Simpsons, The - Bart vs. the World')).toBe('The Simpsons - Bart vs. the World')
    expect(uninvertArticle('Hello, World')).toBe('Hello, World')
  })

  it('reads the KSS naming scheme (system in parentheses)', () => {
    expect(parseRipSetName('Madou Monogatari (MSX)(1990)(Compile).7z')).toMatchObject({ title: 'Madou Monogatari', systemTag: 'MSX', year: 1990, developers: ['Compile'], publishers: ['Compile'] })
    expect(parseRipSetName('Simpsons, The - Bart vs. the World (SMS)(1993)(Imagineering)(Arc Developments)(Flying Edge).7z')).toMatchObject({
      title: 'The Simpsons - Bart vs. the World',
      systemTag: 'SMS',
      developers: ['Imagineering', 'Arc Developments'],
      publishers: ['Flying Edge']
    })
  })

  it('turns letter pages into chip sets, skipping non-chip rips', () => {
    const spc = joshwPageSets(src('spc.joshw.info'), { path: '/c/', group: null }, fx('joshw-spc-c.html'))
    expect(spc.sets.length).toBe(76)
    expect(spc.skipped).toBe(2) // the [SNSF] sets
    const ct = spc.sets.find((s) => s.title === 'Chrono Trigger')!
    expect(ct).toMatchObject({
      source: 'joshw',
      ref: 'spc.joshw.info/c/Chrono%20Trigger%20(1995-03-11)(Square)%5bSNES%5d.7z',
      archiveUrl: 'https://spc.joshw.info/c/Chrono%20Trigger%20(1995-03-11)(Square)%5bSNES%5d.7z',
      format: 'SPC',
      year: 1995,
      sizeBytes: 285 * 1024,
      variant: []
    })
    expect(ct.system).toEqual({ label: 'SNES', platform: { slug: 'nintendo-snes', name: 'SNES' } })
    expect(chipAlbumTitle(ct)).toBe('Chrono Trigger (SNES SPC rip)')
    expect(chipAlbumHit(ct)).toMatchObject({ provider: 'chip', ref: ct.ref, title: 'Chrono Trigger (SNES SPC rip)', kind: 'gamerip', typeLabel: 'SPC rip', platforms: [{ slug: 'nintendo-snes', name: 'SNES' }] })

    const nsf = joshwPageSets(src('nsf.joshw.info'), { path: '/m/', group: null }, fx('joshw-nsf-m.html'))
    const titles = nsf.sets.filter((s) => s.title.startsWith('Mega Man')).map(chipAlbumTitle)
    expect(titles).toContain('Mega Man 2 (NES NSF rip)')
    expect(titles).toContain('Mega Man 2 (NES NSF rip, Game Genie)')
    expect(titles).toContain('Mega Man 6 (NES NSF rip, JP)')

    const hes = joshwPageSets(src('hes.joshw.info'), { path: '/b/', group: null }, fx('joshw-hes-b.html'))
    expect(hes.sets.every((s) => s.sizeBytes! < 1024 * 1024)).toBe(true) // the CD-audio [TCD] sets are out
    expect(hes.skipped).toBeGreaterThan(10)
    expect(hes.sets.find((s) => s.title === 'Bonk\'s Adventure')).toMatchObject({ altTitles: ['PC Genjin'], system: { label: 'PC Engine' } })

    const kss = joshwPageSets(src('kss.joshw.info'), { path: '/MSX/m/', group: 'MSX' }, fx('joshw-kss-msx-m.html'))
    expect(kss.sets.find((s) => s.title === 'Metal Gear 2 - Solid Snake')).toMatchObject({ format: 'KSS', year: 1990, system: { label: 'MSX' }, ref: 'kss.joshw.info/MSX/m/Metal%20Gear%202%20-%20Solid%20Snake%20(MSX)(1990)(Konami).7z' })
  })
})

describe('chip: vgmrips', () => {
  it('parses the pack list: titles, zip, chips, systems, credits, pages', () => {
    const l = parseVgmripsListing(fx('vgmrips-latest.html'))
    expect(l.packs.length).toBe(20)
    expect(l.page).toBe(0)
    expect(l.totalPages).toBe(224)
    const dracula = l.packs[0]
    expect(dracula.set).toMatchObject({
      source: 'vgmrips',
      ref: 'vgmrips.net/packs/pack/bram-stoker-s-dracula-sega-mega-cd',
      archiveUrl: "https://vgmrips.net/files/MegaDrive/Bram_Stoker%27s_Dracula_%28Sega_Mega_CD%29.zip",
      title: "Bram Stoker's Dracula",
      format: 'VGM',
      trackCount: 8,
      developers: ['Psygnosis'],
      publishers: ['Sony Imagesoft'],
      composers: ['Mike Clarke']
    })
    expect(dracula.set.sizeBytes).toBe(Math.round(233.08 * 1024))
    expect(dracula.set.cover).toMatch(/^https:\/\/vgmrips\.net\/packs\/images\/small\//)
    expect(dracula.chips).toEqual(['rf5c164'])
    expect(dracula.playable).toBe(false) // libgme has no RF5C164
    const kicker = l.packs.find((p) => p.set.title === 'Kicker')!
    expect(kicker.set.altTitles).toEqual(["Shao-lin's Road"])
    expect(kicker.playable).toBe(true) // SN76489
    expect(l.packs.filter((p) => p.playable).map((p) => p.set.title)).toEqual(['BC Racers', 'Dinosaur', 'Road Fighter', 'Kicker'])
    expect(vgmripsTitles('Journey to Silius (U, E, A) / Raf World (J)')).toEqual(['Journey to Silius', 'Raf World'])
    expect(vgmripsTitles('Kicker (W) / Shao-lin\'s Road (J)')).toEqual(['Kicker', "Shao-lin's Road"])
    expect(vgmripsTitles('Chalvo 55: Super Puzzle Action')).toEqual(['Chalvo 55: Super Puzzle Action'])
  })

  it('parses a pack page: tracks with file names and loop-aware lengths', () => {
    const p = parseVgmripsPack(fx('vgmrips-pack-silius.html'))
    expect(p).toMatchObject({
      title: 'Journey to Silius',
      altTitles: ['Raf World'],
      systems: ['Nintendo Entertainment System', 'Family Computer'],
      chips: ['nes-apu'],
      composers: ['Naoki Kodaka'],
      developers: ['Tokai Engineering'],
      publishers: ['Sunsoft', 'Mattel'],
      year: 1990,
      zipUrl: 'https://vgmrips.net/files/NES/Journey_to_Silius_%28NES%29.zip'
    })
    expect(p.cover).toBe('https://vgmrips.net/files/NES/Journey_to_Silius_%28NES%29_US.png')
    expect(p.tracks.length).toBe(12)
    // "1:19 + 1:18" = 79 s through the first loop, +78 s second loop, +10 s fade
    expect(p.tracks[0]).toEqual({ number: 1, title: 'Title', file: '01 Title.vgz', durationMs: 167_000 })
    expect(p.tracks[1]).toEqual({ number: 2, title: 'Opening', file: '02 Opening.vgz', durationMs: 68_000 }) // no loop
    expect(p.tracks[2].file).toBe('03 Stage 1, Final Stage.vgz')
    const d = parseVgmripsPack(fx('vgmrips-pack-dinosaur.html'))
    expect(d).toMatchObject({ title: 'Dinosaur', year: 1991, chips: ['ym3438'] })
    expect(d.tracks.length).toBe(35)
    expect(parseVgmTime('3:05 + 2:39')).toEqual({ totalMs: 185_000, loopMs: 159_000 })
    expect(parseVgmTime('1:08')).toEqual({ totalMs: 68_000, loopMs: null })
    expect(parseVgmTime('')).toBeNull()
  })
})

describe('chip: NEZPlug playlists', () => {
  it('parses time formats', () => {
    expect(parseNezTime('0:41.167')).toBe(41_167)
    expect(parseNezTime('1:16.830')).toBe(76_830)
    expect(parseNezTime('0:0:40.009')).toBe(40_009)
    expect(parseNezTime('0:01:17.149')).toBe(77_149)
    expect(parseNezTime('1:02:03')).toBe(3_723_000)
    expect(parseNezTime('1:13')).toBe(73_000)
    expect(parseNezTime('10')).toBe(10_000)
    expect(parseNezTime('0')).toBe(0)
    expect(parseNezTime('1:00-')).toBe(60_000)
    expect(parseNezTime(' 0:05.5 ')).toBe(5_500)
    expect(parseNezTime('')).toBeNull()
    expect(parseNezTime('soon')).toBeNull()
  })

  it('splits fields on unescaped commas only', () => {
    expect(splitNezFields('GBS,14,Ending (Part 2)\\, 100000 Points,0:14,,10')).toEqual(['GBS', '14', 'Ending (Part 2), 100000 Points', '0:14', '', '10'])
    expect(splitNezFields('a\\\\,b')).toEqual(['a\\', 'b'])
  })

  it('parses lines: decimal and hex tracks, escaped and stray commas, partial timing', () => {
    expect(parseNezLine('Mega Man 2.nsf::NSF,6,Flash Man Stage,1:16.830,,0:12.799')).toEqual({
      file: 'Mega Man 2.nsf',
      type: 'NSF',
      track: 6,
      hex: false,
      title: 'Flash Man Stage',
      lengthMs: 76_830,
      loopMs: null,
      loopIsStart: false,
      fadeMs: 12_799,
      loopCount: null
    })
    expect(parseNezLine('Game.kss::KSS,$0C,Dr. Wily Stage 1,1:41,,10,')).toMatchObject({ track: 12, hex: true, title: 'Dr. Wily Stage 1', lengthMs: 101_000, fadeMs: 10_000 })
    expect(parseNezLine('set\\Game.gbs::GBS,3,Title, with comma,2:00,1:00-,5')).toMatchObject({ file: 'set/Game.gbs', title: 'Title, with comma', lengthMs: 120_000, loopMs: 60_000, loopIsStart: true, fadeMs: 5000 })
    expect(parseNezLine('DMG-TRA-0.gbs::GBS,14,B-Type Game: Level 9 High 5 Ending (Part 2)\\, 100000 Points,0:0:14.478,,0:0:10')).toMatchObject({
      track: 14,
      title: 'B-Type Game: Level 9 High 5 Ending (Part 2), 100000 Points',
      lengthMs: 14_478,
      fadeMs: 10_000
    })
    expect(parseNezLine('Game.nsf::NSF,1,One,1:00,0:30,5,2')).toMatchObject({ lengthMs: 60_000, loopMs: 30_000, fadeMs: 5000, loopCount: 2 })
    expect(parseNezLine('Madou.kss::KSS,$02,[魔導物語 OPLL]プロローグ')).toMatchObject({ track: 2, hex: true, title: '[魔導物語 OPLL]プロローグ', lengthMs: null, fadeMs: null })
    expect(parseNezLine('Game.nsf::NSF,3,,1:00,,5')).toMatchObject({ track: 3, title: '', lengthMs: 60_000, fadeMs: 5000 })
    // a numeric title stays a title (one field is always kept for it)
    expect(parseNezLine('Game.nsf::NSF,4,1999')).toMatchObject({ title: '1999', lengthMs: null })
    expect(parseNezLine('# comment')).toBeNull()
    expect(parseNezLine('01 Plain.vgz')).toBeNull()
    expect(parseNezLine('Game.nsf::NSF,x,Bad')).toBeNull()
  })

  it('separates header comments, NEZPlug lines and plain entries', () => {
    const p = parseNezPlaylist('﻿# Rockman 2\r\n# Music by Manami Matsumae, Takashi Tateishi\r\n\r\nMM2.nsf::NSF,1,Opening,0:41.167,,0\r\n01 Plain.vgz\r\n')
    expect(p.comments).toEqual(['Rockman 2', 'Music by Manami Matsumae, Takashi Tateishi'])
    expect(p.lines.map((l) => l.title)).toEqual(['Opening'])
    expect(p.plain).toEqual(['01 Plain.vgz'])
    expect(composersFromComments(p.comments)).toEqual(['Manami Matsumae', 'Takashi Tateishi'])
    expect(composersFromComments(['@TITLE       Tetris v1.0', '@COMPOSER    Hirokazu Tanaka', 'Composer: A & B'])).toEqual(['Hirokazu Tanaka', 'A', 'B'])
  })

  it('strips the tag suffix of per-track playlists', () => {
    expect(cleanNezTitle('Title Screen - Kazumi Totaka - Kaeru no Tame ni Kane wa Naru - ©1992-09-14 Intelligent Systems, Nintendo')).toEqual({ title: 'Title Screen', composer: 'Kazumi Totaka' })
    expect(cleanNezTitle('Stage 1 - Boss - Composer - Game - ©1990 Pub')).toEqual({ title: 'Stage 1 - Boss', composer: 'Composer' })
    expect(cleanNezTitle('B-Type Game - Level 9 High 0 Ending')).toEqual({ title: 'B-Type Game - Level 9 High 0 Ending', composer: null })
  })
})

describe('chip: tracks from an archive listing', () => {
  const url = 'https://nsf.joshw.info/m/Mega%20Man%202.7z'

  it('NSF set with a full NEZPlug playlist: one track per line, 1-based decimal tracks', () => {
    const b = buildChipTracks(listing('mm2-nsf'), { archiveUrl: url, gameTitle: 'Mega Man 2' })
    expect(b.tracks.length).toBe(23)
    expect(b.composers).toEqual(['Manami Matsumae', 'Takashi Tateishi'])
    const nsf = 'Mega Man 2 [RockMan 2 - Dr. Wily no Nazo] (1988-12-24)(Capcom).nsf'
    expect(b.tracks.map((t) => t.title).slice(0, 6)).toEqual(['Opening', 'Title', 'Pass Word', 'Stage Select', 'Game Start', 'Flash Man Stage'])
    const flash = b.tracks[5]
    expect(flash).toMatchObject({ disc: 1, number: 6, durationMs: 76_830 + 12_799, files: [{ format: 'chip', sizeBytes: 16_592 }] })
    expect(sourceOf(flash)).toEqual({ kind: 'http', url, cacheKey: 'chip:nsf.joshw.info/m/Mega%20Man%202.7z', archiveEntry: nsf, formatHint: 'nsf', subsong: 5 })
    expect(flash.streams![0]).toMatchObject({ provider: 'chip', format: 'chip', expiresAt: null })
    expect(parseChipLocator(flash.locator)).toEqual({ url, entry: nsf, subsong: 5 })
    // playlist order, not track order: "Boss" is NSF track 16, "Game Over" track 17
    expect(b.tracks.find((t) => t.title === 'Boss')!.streams![0].source.subsong).toBe(15)
    expect(b.tracks[22]).toMatchObject({ title: 'Game Over', number: 23 })
    expect(sourceOf(b.tracks[22]).subsong).toBe(16)
    // per-track .m3u files duplicate the full playlist and are ignored
    expect(new Set(b.tracks.map((t) => t.locator)).size).toBe(23)
  })

  it('GBS set numbered from 0, with two revisions of the file: both revisions are kept', () => {
    const b = buildChipTracks(listing('tetris-gbs'), { archiveUrl: url })
    expect(b.tracks[0]).toMatchObject({ title: 'Title', durationMs: 40_009 })
    expect(sourceOf(b.tracks[0])).toMatchObject({ archiveEntry: 'DMG-TRA-0.gbs', subsong: 0 })
    expect(sourceOf(b.tracks[1])).toMatchObject({ archiveEntry: 'DMG-TRA-0.gbs', subsong: 1 })
    expect(b.tracks[1].durationMs).toBe(77_149 + 10_000)
    // Equal titles don't make equal audio: v1.1's full playlist follows v1.0's, its repeated titles
    // named after its file. The per-track playlists only repeat songs of the two.
    expect(b.tracks.length).toBe(34)
    const v11 = b.tracks.filter((t) => sourceOf(t).archiveEntry === 'DMG-TRA-1.gbs')
    expect(v11.length).toBe(17)
    expect(v11.slice(0, 3).map((t) => [t.number, t.title])).toEqual([
      [18, 'Title (DMG-TRA-1)'],
      [19, 'A-Type Music (version 1.1)'],
      [20, 'B-Type Music (DMG-TRA-1)']
    ])
    expect(new Set(b.tracks.map((t) => t.locator)).size).toBe(34)
    expect(b.tracks.find((t) => t.title.startsWith('B-Type Game: Level 9 High 5 Ending (Part 2)'))!.title).toBe('B-Type Game: Level 9 High 5 Ending (Part 2), 100000 Points')
    expect(b.composers).toEqual(['Hirokazu Tanaka'])
  })

  it('per-track playlists only: their order, cleaned titles, composer from the tags', () => {
    const b = buildChipTracks(listing('kaeru-gbs'), { archiveUrl: url })
    expect(b.tracks.length).toBe(32)
    expect(b.tracks.slice(0, 3).map((t) => [t.title, sourceOf(t).subsong])).toEqual([
      ['Title Screen', 0],
      ["What's Your Name", 2],
      ['A Princely Duel', 6]
    ])
    expect(b.tracks[0].durationMs).toBe(73_000 + 10_000)
    expect(b.composers).toEqual(['Kazumi Totaka'])
  })

  it('KSS set: hex tracks, 0-based, shared title prefix folded into a suffix', () => {
    const b = buildChipTracks(listing('madou-kss'), { archiveUrl: url })
    expect(b.tracks.length).toBe(22)
    expect(b.tracks[0]).toMatchObject({ title: 'プロローグ (OPLL)', durationMs: null })
    expect(sourceOf(b.tracks[0]).subsong).toBe(2)
    expect(b.tracks[21].title).toBe('ゲームオーバー (PSG)')
  })

  it('SPC set: one track per file, disc + track numbering, cleaned file names', () => {
    const b = buildChipTracks(listing('ct-spc'), { archiveUrl: url, gameTitle: 'Chrono Trigger' })
    expect(b.tracks.length).toBe(92)
    expect(b.tracks[0]).toMatchObject({ disc: 1, number: 1, title: 'Presentiment', durationMs: null })
    expect(sourceOf(b.tracks[0])).toMatchObject({ archiveEntry: '101 Presentiment.spc', formatHint: 'spc' })
    expect(sourceOf(b.tracks[0]).subsong).toBeUndefined()
    expect(b.tracks.some((t) => t.disc === 2)).toBe(true)
    expect(b.tracks.find((t) => t.title === 'Corridors of Time')).toBeTruthy()
  })

  it('VGM packs: plain .m3u order, smspower names, vgmrips titles and lengths', () => {
    const sonic = buildChipTracks(listing('sonic-sms-vgm'), { archiveUrl: url })
    expect(sonic.tracks.map((t) => t.title).slice(0, 3)).toEqual(['Title Screen', 'Act Start', 'Green Hill Zone'])
    expect(sonic.tracks[2].number).toBe(3)
    const pack = parseVgmripsPack(fx('vgmrips-pack-silius.html'))
    const silius = buildChipTracks(listing('silius-vgm'), { archiveUrl: url, pack: pack.tracks })
    expect(silius.tracks.length).toBe(12)
    expect(silius.tracks[2]).toMatchObject({ number: 3, title: 'Stage 1, Final Stage', durationMs: pack.tracks[2].durationMs })
    expect(sourceOf(silius.tracks[2]).archiveEntry).toBe('03 Stage 1, Final Stage.vgz')
  })

  it('multi-song files without a playlist or a header: one track per file, NSFe preferred over its NSF', () => {
    const b = buildChipTracks(
      { entries: [{ path: 'Game.nsf', size: 100 }, { path: 'Game.nsfe', size: 120 }, { path: 'info.txt', size: 5 }], playlists: [{ path: 'info.txt', text: 'hi' }] },
      { archiveUrl: url, gameTitle: 'Some Game' }
    )
    expect(b.tracks.map((t) => [t.title, sourceOf(t).archiveEntry, sourceOf(t).subsong])).toEqual([['Some Game', 'Game.nsfe', undefined]])
  })

  const songs = (b: { tracks: { title: string; streams?: { source: EngineSource }[] }[] }) => b.tracks.map((t) => `${sourceOf(t).archiveEntry}#${sourceOf(t).subsong ?? '-'} ${t.title}`)
  const file = (path: string, head?: Buffer) => ({ path, size: 100, ...(head ? { head: new Uint8Array(head) } : {}) })

  it('playlist lines name files relative to the playlist; a name two folders share names neither', () => {
    const entries = [file('JP/game.nsf'), file('US/game.nsf'), file('US/extra/x.nsf')]
    const b = buildChipTracks(
      {
        entries,
        playlists: [
          { path: 'JP/set.m3u', text: 'game.nsf::NSF,1,JP Opening\ngame.nsf::NSF,3,JP Ending\n../US/extra/x.nsf::NSF,1,Extra' },
          { path: 'US/set.m3u', text: 'game.nsf::NSF,1,US Opening\nUS/game.nsf::NSF,2,US Ending' }
        ]
      },
      { archiveUrl: url }
    )
    expect(songs(b)).toEqual(['JP/game.nsf#0 JP Opening', 'JP/game.nsf#2 JP Ending', 'US/extra/x.nsf#0 Extra', 'US/game.nsf#0 US Opening', 'US/game.nsf#1 US Ending'])
    // At the root, "game.nsf" could be either file (and "../" leaves the archive): no guess.
    const root = buildChipTracks({ entries, playlists: [{ path: 'set.m3u', text: 'game.nsf::NSF,1,Opening\ngame.nsf::NSF,2,Ending\n../game.nsf::NSF,3,Out' }] }, { archiveUrl: url })
    expect(songs(root)).toEqual(['JP/game.nsf#- game', 'US/extra/x.nsf#- x', 'US/game.nsf#- game (US/game)'])
    // One file of that name anywhere: found by name.
    const moved = buildChipTracks({ entries: [file('rip/game.nsf')], playlists: [{ path: 'set.m3u', text: 'game.nsf::NSF,1,Opening\ngame.nsf::NSF,2,Ending' }] }, { archiveUrl: url })
    expect(songs(moved)).toEqual(['rip/game.nsf#0 Opening', 'rip/game.nsf#1 Ending'])
  })

  it('a full playlist sets the order without hiding other songs: one-song playlists and files no playlist covers follow', () => {
    const b = buildChipTracks(
      {
        entries: [file('main.nsf'), file('bonus.nsf'), file('bonus.spc'), file('02 Extra.vgm')],
        playlists: [
          { path: 'main.m3u', text: 'main.nsf::NSF,1,Opening\nmain.nsf::NSF,2,Ending' },
          // per-track playlists of songs the full one has, and one of a song it hasn't
          { path: '01 Opening.m3u', text: 'main.nsf::NSF,1,Opening,1:00' },
          { path: '03 Bonus Song.m3u', text: 'bonus.nsf::NSF,1,' }
        ]
      },
      { archiveUrl: url, gameTitle: 'Game' }
    )
    expect(b.tracks.map((t) => [t.number, `${sourceOf(t).archiveEntry}#${sourceOf(t).subsong ?? '-'}`, t.title])).toEqual([
      [1, 'main.nsf#0', 'Opening'],
      [2, 'main.nsf#1', 'Ending'],
      [3, 'bonus.nsf#0', 'Bonus Song'],
      [4, '02 Extra.vgm#-', 'Extra'],
      [5, 'bonus.spc#-', 'bonus']
    ])
  })

  it('songs of different files with the same title all stay; a repeated reference to one song is one track', () => {
    const b = buildChipTracks(
      {
        entries: [file('FM.kss'), file('PSG.kss')],
        playlists: [
          { path: 'FM.m3u', text: 'FM.kss::KSS,0,Opening\nFM.kss::KSS,1,Ending' },
          { path: 'PSG.m3u', text: 'PSG.kss::KSS,0,Opening\nPSG.kss::KSS,1,Ending\nPSG.kss::KSS,0,Opening' },
          { path: 'Opening.m3u', text: 'FM.kss::KSS,0,Opening' }
        ]
      },
      { archiveUrl: url }
    )
    expect(songs(b)).toEqual(['FM.kss#0 Opening', 'FM.kss#1 Ending', 'PSG.kss#0 Opening (PSG)', 'PSG.kss#1 Ending (PSG)'])
  })

  it('a multi-song file without a playlist: a track per song from its header, titled from an NSFe', () => {
    const nsf = (n: number) => {
      const b = Buffer.alloc(0x80)
      b.write('NESM\x1a', 0, 'latin1')
      b[6] = n
      b[7] = 1
      return b
    }
    const gbs = Buffer.alloc(0x70)
    gbs.write('GBS', 0, 'latin1')
    gbs[4] = 2
    gbs[5] = 1
    const chunk = (id: string, data: Buffer) => {
      const h = Buffer.alloc(8)
      h.writeUInt32LE(data.length, 0)
      h.write(id, 4, 'latin1')
      return Buffer.concat([h, data])
    }
    const times = Buffer.alloc(8)
    times.writeInt32LE(60_000, 0)
    times.writeInt32LE(-1, 4)
    const nsfe = Buffer.concat([Buffer.from('NSFE', 'latin1'), chunk('INFO', Buffer.from([0, 0x80, 0, 0x80, 0, 0x80, 0, 0, 2, 0])), chunk('tlbl', Buffer.from('Overworld\0Dungeon\0')), chunk('time', times), chunk('NEND', Buffer.alloc(0))])
    const one = (entries: ReturnType<typeof file>[]) => buildChipTracks({ entries, playlists: [] }, { archiveUrl: url, gameTitle: 'Game' })
    expect(songs(one([file('Game.nsf', nsf(3))]))).toEqual(['Game.nsf#0 Song 1', 'Game.nsf#1 Song 2', 'Game.nsf#2 Song 3'])
    expect(one([file('Game.nsf', nsf(3))]).tracks.map((t) => t.number)).toEqual([1, 2, 3])
    const titled = one([file('Game.nsf', nsf(2)), file('Game.nsfe', nsfe)])
    expect(titled.tracks.map((t) => [`${sourceOf(t).archiveEntry}#${sourceOf(t).subsong}`, t.title, t.durationMs])).toEqual([
      ['Game.nsfe#0', 'Overworld', 60_000 + 10_000],
      ['Game.nsfe#1', 'Dungeon', null]
    ])
    // Two files: each song's title says which file it is from.
    expect(songs(one([file('A.gbs', gbs), file('B.gbs', gbs)]))).toEqual(['A.gbs#0 Song 1', 'A.gbs#1 Song 2', 'B.gbs#0 Song 1 (B)', 'B.gbs#1 Song 2 (B)'])
    // One song, or a header that says nothing of the count (HES, KSS): one track, the first song.
    expect(songs(one([file('Game.nsf', nsf(1))]))).toEqual(['Game.nsf#- Game'])
    expect(songs(one([file('Game.hes', Buffer.from('HESM'))]))).toEqual(['Game.hes#- Game'])
    // A playlist decides for the file it covers.
    expect(songs(buildChipTracks({ entries: [file('Game.nsf', nsf(3))], playlists: [{ path: 'Game.m3u', text: 'Game.nsf::NSF,2,Only' }] }, { archiveUrl: url }))).toEqual(['Game.nsf#1 Only'])
  })

  it('file name cleaning: takes a name without its extension, keeps every dot in it', () => {
    expect(cleanFileTitle('101 Presentiment')).toEqual({ number: 101, title: 'Presentiment' })
    expect(cleanFileTitle('01.Opening')).toEqual({ number: 1, title: 'Opening' })
    expect(cleanFileTitle('01 - Title')).toEqual({ number: 1, title: 'Title' })
    expect(cleanFileTitle('Sonic The Hedgehog - 03 - Green Hill Zone')).toEqual({ number: 3, title: 'Green Hill Zone' })
    expect(cleanFileTitle('Green_Hill_Zone')).toEqual({ number: null, title: 'Green Hill Zone' })
    expect(cleanFileTitle('3D World Runner')).toEqual({ number: null, title: '3D World Runner' })
    // Short titles after a dot were taken for an extension ("01.Intro" → "01").
    for (const t of ['A', 'Up', 'End', 'Boss', 'Intro', 'Ending']) expect(cleanFileTitle(`01.${t}`)).toEqual({ number: 1, title: t })
    expect(cleanFileTitle('Super Mario Bros.3')).toEqual({ number: null, title: 'Super Mario Bros.3' })
    expect(cleanFileTitle('07 Dr. Wily')).toEqual({ number: 7, title: 'Dr. Wily' })
  })
})

describe('ChipProvider', () => {
  it('lists joshw pages (expanding grouping directories) and their sets', async () => {
    const http = fakeHttp({
      'https://kss.joshw.info/': fx('joshw-kss-root.html'),
      'https://kss.joshw.info/Game%20Gear/': '<pre><a href="a/">a/</a> 2010-01-05 05:49 -</pre>',
      'https://kss.joshw.info/MSX/': '<pre><a href="m/">m/</a> 2013-07-07 10:02 -\n<a href="zzz_unknown/">zzz_unknown/</a> 2013-07-07 10:02 -</pre>',
      'https://kss.joshw.info/Master%20System/': '<pre><a href="s/">s/</a> 2010-01-05 05:49 -</pre>',
      'https://kss.joshw.info/MSX/m/': fx('joshw-kss-msx-m.html')
    })
    const p = new ChipProvider({ http })
    const pages = await p.joshwPages(src('kss.joshw.info'))
    expect(pages).toEqual([
      { path: '/Game%20Gear/a/', group: 'Game Gear' },
      { path: '/MSX/m/', group: 'MSX' },
      { path: '/MSX/zzz_unknown/', group: 'MSX' },
      { path: '/Master%20System/s/', group: 'Master System' }
    ])
    const page = await p.fetchJoshwPage(src('kss.joshw.info'), pages[1])
    expect(page.sets.length).toBe(15)
    expect(http.requests).not.toContain('https://kss.joshw.info/lost%2Bfound/')
  })

  it('getAlbum (joshw): lists the archive through the engine and builds the tracks', async () => {
    const inspected: EngineSource[] = []
    const p = new ChipProvider({
      http: fakeHttp({}),
      inspectArchive: async (s) => {
        inspected.push(s)
        return listing('mm2-nsf')
      }
    })
    const ref = 'nsf.joshw.info/m/Mega%20Man%202%20%5bRockMan%202%20-%20Dr.%20Wily%20no%20Nazo%5d%20(1988-12-24)(Capcom)%5bNES%5d.7z'
    const a = await p.getAlbum(ref)
    const archive = `https://${ref}`
    expect(inspected).toEqual([{ kind: 'http', url: archive, cacheKey: `chip:${ref}` }])
    expect(a).toMatchObject({
      provider: 'chip',
      ref,
      title: 'Mega Man 2 (NES NSF rip)',
      kind: 'gamerip',
      year: 1988,
      altTitles: ['RockMan 2 - Dr. Wily no Nazo'],
      developers: ['Capcom'],
      publishers: ['Capcom'],
      composers: ['Manami Matsumae', 'Takashi Tateishi'],
      formats: ['chip'],
      platforms: [{ slug: 'nintendo-nes', name: 'NES' }]
    })
    expect(a.tracks.length).toBe(23)
    expect(chipCacheKey(archive)).toBe(`chip:${ref}`)
    // resolveStream rebuilds the same source from the locator, offline
    const [s] = await p.resolveStream(a.tracks[5].locator)
    expect(s.source).toEqual(a.tracks[5].streams![0].source)
  })

  it('getAlbum (vgmrips): reads the pack page, then the zip', async () => {
    const ref = 'vgmrips.net/packs/pack/journey-to-silius-nes'
    const http = fakeHttp({ [`https://${ref}`]: fx('vgmrips-pack-silius.html') })
    const inspected: string[] = []
    const p = new ChipProvider({
      http,
      inspectArchive: async (s) => {
        inspected.push(s.kind === 'http' ? s.cacheKey : '')
        return listing('silius-vgm')
      }
    })
    const a = await p.getAlbum(ref)
    expect(inspected).toEqual(['chip:vgmrips.net/files/NES/Journey_to_Silius_%28NES%29.zip'])
    expect(a).toMatchObject({ title: 'Journey to Silius (NES VGM rip)', year: 1990, composers: ['Naoki Kodaka'], cover: 'https://vgmrips.net/files/NES/Journey_to_Silius_%28NES%29_US.png' })
    expect(a.tracks.map((t) => t.title).slice(0, 2)).toEqual(['Title', 'Opening'])
    expect(a.tracks[0].durationMs).toBe(167_000)
  })

  it('getAlbum without an engine, unknown refs and bad locators fail clearly', async () => {
    const p = new ChipProvider({ http: fakeHttp({}) })
    await expect(p.getAlbum('spc.joshw.info/c/Chrono%20Trigger%20(1995-03-11)(Square)%5bSNES%5d.7z')).rejects.toThrow(/audio engine/)
    await expect(p.getAlbum('example.com/x.7z')).rejects.toThrow(/unknown/)
    await expect(p.resolveStream('nope')).rejects.toThrow(/locator/)
    const gone = new ChipProvider({ http: fakeHttp({}), inspectArchive: async () => Promise.reject(new Error('HTTP 404 from https://x')) })
    await expect(gone.getAlbum('gbs.joshw.info/k/Kaeru.7z')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('locators round-trip entries with any characters', () => {
    const entry = 'set/01 Stage #1 & 2 (100%).vgz'
    const loc = chipLocator('https://vgmrips.net/files/A.zip', entry, 3)
    expect(parseChipLocator(loc)).toEqual({ url: 'https://vgmrips.net/files/A.zip', entry, subsong: 3 })
    expect(parseChipLocator(chipLocator('https://x/y.7z', 'a.spc'))).toEqual({ url: 'https://x/y.7z', entry: 'a.spc', subsong: null })
    expect(JOSHW_SOURCES.map((s) => s.host)).toEqual(['nsf.joshw.info', 'spc.joshw.info', 'gbs.joshw.info', 'hes.joshw.info', 'kss.joshw.info'])
  })
})
