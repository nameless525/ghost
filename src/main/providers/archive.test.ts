import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isNetError } from '../net/errors'
import {
  ArchiveProvider,
  cleanIaTitle,
  downloadUrl,
  hasPlayableAudio,
  IA_INDEX_COLLECTIONS,
  IA_MIN_CONFIDENCE,
  iaAlbumKind,
  iaAudioFormat,
  iaPlatforms,
  iaYear,
  indexPageUrl,
  isFormatDir,
  isGameSoundtrack,
  luceneWords,
  parseIaLength,
  parseIaUrl,
  parseIndexPage,
  parseMetadata,
  parseSearch,
  searchQuery,
  searchUrl,
  type IaFile,
  type IaIndexResponse,
  type IaMetadata,
  type IaSearchResponse
} from './archive'
import { isIndexProvider, type CanonicalTrack } from './types'

// Real archive.org API responses (2026-10), uploader e-mail redacted, fav-* collections trimmed.
const fx = <T>(name: string): T => JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'archive', name), 'utf8')) as T
const search = fx<IaSearchResponse>('search-hollow-knight.json')
const meta = fx<IaMetadata>('metadata-hollow-knight-ost.json')

describe('archive: helpers', () => {
  it('formats, lengths, urls', () => {
    expect(iaAudioFormat('Flac')).toBe('flac')
    expect(iaAudioFormat('24bit Flac')).toBe('flac')
    expect(iaAudioFormat('VBR MP3')).toBe('mp3')
    expect(iaAudioFormat('128Kbps MP3')).toBe('mp3')
    expect(iaAudioFormat('Ogg Vorbis')).toBe('ogg')
    expect(iaAudioFormat('WAVE')).toBe('wav')
    expect(iaAudioFormat('PNG')).toBeNull()
    expect(iaAudioFormat('Spectrogram')).toBeNull()
    expect(iaAudioFormat(undefined, 'a/b.flac')).toBe('flac')
    expect(parseIaLength('89.73')).toBe(89_730)
    expect(parseIaLength('01:30')).toBe(90_000)
    expect(parseIaLength('1:02:03')).toBe(3_723_000)
    expect(parseIaLength('nope')).toBeNull()
    expect(downloadUrl('hollow-knight-ost', 'Disc 1/01. Truth, Beauty & Hatred.flac')).toBe('https://archive.org/download/hollow-knight-ost/Disc%201/01.%20Truth%2C%20Beauty%20%26%20Hatred.flac')
    expect(parseIaUrl('https://archive.org/details/hollow-knight-ost')).toBe('hollow-knight-ost')
    expect(parseIaUrl('https://archive.org/download/hollow-knight-ost/01.flac')).toBe('hollow-knight-ost')
    expect(parseIaUrl('Hollow Knight')).toBeNull()
  })

  it('user text is made Lucene-safe', () => {
    expect(luceneWords('Ys: (Origin) "AND" OR -foo* bar?')).toEqual(['Ys', 'Origin', 'foo', 'bar'])
    const q = searchQuery('Hollow Knight OST')
    expect(q).toContain('title:(Hollow AND Knight)')
    expect(q).toContain('mediatype:(audio)')
    expect(q).toContain('collection:(folksoundomy_gamesoundtracks')
    expect(searchUrl('Hollow Knight OST')).toMatch(/^https:\/\/archive\.org\/advancedsearch\.php\?q=.+&rows=30&page=1&output=json&fl%5B%5D=identifier/)
  })
})

describe('archive: search results', () => {
  const hits = parseSearch(search, 'Hollow Knight OST')
  it('drops items without playable audio (zip/7z-only)', () => {
    const refs = hits.map((h) => h.ref)
    expect(refs).not.toContain('hollow-knight-full-ost.-7z')
    expect(refs).not.toContain('HollowKnightAudio')
    expect(refs).not.toContain('hollow-knight-silksong-every-audio-asset')
  })
  it('keeps Opus-only items (the engine decodes Opus)', () => {
    expect(hits.map((h) => h.ref)).toContain('official-hollow-knight-original-soundtrack-opus')
  })
  it('ranks the game soundtrack above DLC, sequels, sound effects and arrangements', () => {
    const top4 = hits.slice(0, 4).map((h) => h.ref)
    expect(top4).toContain('hollow-knight-ost')
    expect(top4).toContain('official-hollow-knight-original-soundtrack')
    const score = (ref: string) => hits.find((h) => h.ref === ref)!.score
    expect(score('hollow-knight-ost')).toBeGreaterThan(score('hollow-knight-silksong-ost'))
    expect(score('hollow-knight-ost')).toBeGreaterThan(score('hollow-knightgods-nightmares-ost'))
    expect(score('THe-Sounds-of-Hallownest')).toBeLessThan(0.25)
    expect(score('hollow-knight-piano-collections_202512')).toBeLessThan(0.25)
    expect(hits.find((h) => h.ref === 'hollow-knight-ost')).toMatchObject({
      provider: 'archive',
      title: 'Hollow Knight OST',
      subtitle: 'Christopher Larkin',
      cover: 'https://archive.org/services/img/hollow-knight-ost',
      url: 'https://archive.org/details/hollow-knight-ost'
    })
  })
})

describe('archive: item metadata → album', () => {
  const a = parseMetadata('hollow-knight-ost', meta)
  it('one track per original file, derivative MP3s as extra formats', () => {
    expect(a).toMatchObject({ provider: 'archive', ref: 'hollow-knight-ost', title: 'Hollow Knight OST', year: 2017, composers: ['Christopher Larkin'], formats: ['flac', 'mp3'], kind: 'ost' })
    expect(a.cover).toBe('https://archive.org/download/hollow-knight-ost/Cover.jpg')
    expect(a.tracks.length).toBe(28)
    expect(a.tracks.slice(0, 3).map((t) => t.title)).toEqual(['Enter Hallownest', 'Dirtmouth', 'Crossroads'])
    expect(a.tracks.map((t) => t.number)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1))
    const d = a.tracks[1]
    expect(d).toMatchObject({ durationMs: 115_010, locator: 'hollow-knight-ost/02. Dirtmouth.flac', composers: ['Christopher Larkin'] })
    expect(d.files).toEqual([
      { format: 'flac', sizeBytes: 8_571_601 },
      { format: 'mp3', sizeBytes: 2_497_879 }
    ])
  })
  it('streams are stable download URLs', () => {
    const [flac, mp3] = a.tracks[1].streams!
    expect(flac).toMatchObject({ provider: 'archive', format: 'flac', lossless: true, sizeBytes: 8_571_601, expiresAt: null })
    expect(flac.source).toEqual({ kind: 'http', url: 'https://archive.org/download/hollow-knight-ost/02.%20Dirtmouth.flac', cacheKey: 'ia:hollow-knight-ost/02. Dirtmouth.flac', formatHint: 'flac' })
    expect(mp3).toMatchObject({ format: 'mp3', lossless: false, bitrateKbps: 173 })
  })
  it('the same track uploaded under different names in two formats is one track', () => {
    // Real item, trimmed to three tracks: "01 - Enter Hallownest.mp3" and
    // "Christopher Larkin - Hollow Knight (Original Soundtrack) - 01 Enter Hallownest.flac" (+ IA's MP3 of the FLAC).
    const b = parseMetadata('official-hollow-knight-original-soundtrack', fx<IaMetadata>('metadata-official-hollow-knight-3-tracks.json'))
    expect(b.tracks.map((t) => [t.number, t.title, t.files.map((f) => f.format).join('+')])).toEqual([
      [1, 'Enter Hallownest', 'flac+mp3'],
      [2, 'Dirtmouth', 'flac+mp3'],
      [3, 'Crossroads', 'flac+mp3']
    ])
    // the uploaded MP3 is kept; IA's derivative MP3 of the FLAC is dropped as a duplicate format
    expect(b.tracks[0].streams![1].source).toMatchObject({ cacheKey: 'ia:official-hollow-knight-original-soundtrack/Hollow Knight - Official Soundtrack/01 - Enter Hallownest.mp3' })
    expect(b.cover).toBe('https://archive.org/download/official-hollow-knight-original-soundtrack/Hollow%20Knight%20-%20Official%20Soundtrack/cover.jpg')
  })

  it('dark / empty items are not found', () => {
    expect(() => parseMetadata('x', {})).toThrow(/unavailable/)
    expect(() => parseMetadata('x', { is_dark: true, files: [] })).toThrow(/unavailable/)
  })
  it('filename-only items: titles from names, multi-format uploads merged, discs from folders', () => {
    const b = parseMetadata('rips', {
      metadata: { title: 'Cool Quest Soundtrack (Gamerip)', creator: ['A; B'], date: '1998' },
      files: [
        { name: 'CD2/01 Final Boss.mp3', source: 'original', format: 'VBR MP3', length: '200.5', size: '100' },
        { name: 'CD1/02 - Cool Quest - Town.flac', source: 'original', format: 'Flac', length: '61', size: '900' },
        { name: 'CD1/02 - Cool Quest - Town.mp3', source: 'original', format: 'VBR MP3', length: '61', size: '90' },
        { name: 'CD1/01 Title Screen.flac', source: 'original', format: 'Flac', length: '30' },
        { name: 'CD1/01 Title Screen.ogg', source: 'derivative', format: 'Ogg Vorbis', original: 'CD1/01 Title Screen.flac' },
        { name: 'cover.png', source: 'original', format: 'PNG' },
        { name: 'rips_meta.xml', source: 'metadata', format: 'Metadata' }
      ]
    })
    expect(b.kind).toBe('gamerip')
    expect(b.year).toBe(1998)
    expect(b.composers).toEqual(['A', 'B'])
    expect(b.cover).toBe('https://archive.org/download/rips/cover.png')
    expect(b.tracks.map((t) => [t.disc, t.number, t.title, t.files.map((f) => f.format).join('+')])).toEqual([
      [1, 1, 'Title Screen', 'flac+ogg'],
      [1, 2, 'Town', 'flac+mp3'],
      [2, 1, 'Final Boss', 'mp3']
    ])
  })
})

function fakeFetch(routes: Record<string, unknown>): typeof fetch & { urls: string[] } {
  const urls: string[] = []
  const f = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    const key = Object.keys(routes).find((k) => url.startsWith(k))
    if (!key) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch & { urls: string[] }
  f.urls = urls
  return f
}

describe('archive: provider', () => {
  const t: CanonicalTrack = {
    trackId: '9',
    title: 'Dirtmouth',
    albumTitle: 'Hollow Knight',
    gameName: 'Hollow Knight',
    composers: ['Christopher Larkin'],
    durationMs: 115_000,
    disc: 1,
    number: 2,
    year: 2017,
    platforms: [],
    albumProvider: 'khinsider',
    albumRef: 'hollow-knight',
    locator: 'x'
  }
  const empty = { files: [], metadata: { title: 'x' } }

  it('findTrack: searches the game, reads the best items, matches title + duration', async () => {
    const f = fakeFetch({
      'https://archive.org/advancedsearch.php': search,
      'https://archive.org/metadata/hollow-knight-ost': meta,
      'https://archive.org/metadata/': empty
    })
    const p = new ArchiveProvider({ fetch: f })
    const c = await p.findTrack(t)
    expect(c[0]).toMatchObject({ provider: 'archive', locator: 'hollow-knight-ost/02. Dirtmouth.flac', title: 'Dirtmouth', durationMs: 115_010 })
    expect(c[0].confidence).toBeGreaterThan(0.85)
    expect(f.urls.filter((u) => u.includes('advancedsearch')).length).toBe(1)
    expect(f.urls.filter((u) => u.includes('/metadata/')).length).toBeLessThanOrEqual(3)
    // resolveStream reuses the cached metadata
    const n = f.urls.length
    const s = await p.resolveStream(c[0].locator)
    expect(s.map((x) => x.format)).toEqual(['flac', 'mp3'])
    expect(f.urls.length).toBe(n)
  })

  it('reads its JSON in archive.org\'s turn of the app\'s scheduler when given one', async () => {
    const calls: { url: string; accept?: string; priority?: number }[] = []
    const http = {
      fetchBytes: async (url: string, o: { headers?: Record<string, string>; priority?: number } = {}) => {
        calls.push({ url, accept: o.headers?.Accept, priority: o.priority })
        const body = url.startsWith('https://archive.org/advancedsearch.php') ? search : url.startsWith('https://archive.org/metadata/hollow-knight-ost') ? meta : empty
        return { url, status: 200, bytes: Buffer.from(JSON.stringify(body)), contentType: 'application/json' }
      }
    }
    const c = await new ArchiveProvider({ http }).findTrack(t, { priority: 0 })
    expect(c[0]).toMatchObject({ locator: 'hollow-knight-ost/02. Dirtmouth.flac' })
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every((x) => x.accept === 'application/json' && x.priority === 0)).toBe(true)
  })

  it('findTrack offers no weak matches: a cover / remix, another cut, a partial title at the wrong length', async () => {
    const item = (files: IaFile[]): IaMetadata => ({ metadata: { identifier: 'hk', title: 'Hollow Knight OST' }, files })
    const searchHk: IaSearchResponse = { response: { numFound: 1, docs: [{ identifier: 'hk', title: 'Hollow Knight OST', format: ['VBR MP3'], collection: ['folksoundomy_gamesoundtracks'] }] } }
    const want = { ...t, title: 'Dirtmouth', durationMs: 120_000 }
    const find = (files: IaFile[]) => new ArchiveProvider({ fetch: fakeFetch({ 'https://archive.org/advancedsearch.php': searchHk, 'https://archive.org/metadata/hk': item(files) }) }).findTrack(want)
    const mp3 = (name: string, title: string, length: string): IaFile => ({ name, source: 'original', format: 'VBR MP3', length, title })
    // Scored 0 before: three markers and a length 280 s off.
    expect(await find([mp3('01.mp3', 'Dirtmouth Piano Cover Remix', '400')])).toEqual([])
    // The right title, but over three times as long: not the track.
    expect(await find([mp3('01.mp3', 'Dirtmouth', '400')])).toEqual([])
    expect(await find([mp3('01.mp3', 'Dirtmouth (Piano)', '')])).toEqual([])
    expect(await find([mp3('01.mp3', 'Dirtmouth Town Square at Night', '150')])).toEqual([])
    const [ok] = await find([mp3('01.mp3', 'Dirtmouth', '121.5'), mp3('02.mp3', 'Dirtmouth Piano Cover Remix', '400')])
    expect(ok).toMatchObject({ locator: 'hk/01.mp3', title: 'Dirtmouth' })
    expect(ok.confidence).toBeGreaterThanOrEqual(IA_MIN_CONFIDENCE)
    // An exact title with no length to go on, or a length that differs as a game rip's does, is still offered.
    expect(await find([mp3('01.mp3', 'Dirtmouth', '')])).toHaveLength(1)
    expect(await find([mp3('01.mp3', 'Dirtmouth', '95')])).toHaveLength(1)
  })

  it('resolveStream falls back to the bare download URL when metadata is unavailable', async () => {
    const p = new ArchiveProvider({ fetch: (async () => { throw new Error('offline') }) as unknown as typeof fetch })
    const s = await p.resolveStream('some-item/Disc 1/03 Song.mp3')
    expect(s).toHaveLength(1)
    expect(s[0].source).toMatchObject({ url: 'https://archive.org/download/some-item/Disc%201/03%20Song.mp3', cacheKey: 'ia:some-item/Disc 1/03 Song.mp3' })
  })

  it('searchExternal accepts a pasted item URL; unknown items are not_found', async () => {
    const p = new ArchiveProvider({ fetch: fakeFetch({ 'https://archive.org/metadata/hollow-knight-ost': meta }) })
    const [h] = await p.searchExternal('https://archive.org/details/hollow-knight-ost')
    expect(h).toMatchObject({ provider: 'archive', ref: 'hollow-knight-ost', trackCount: 28, score: 1 })
    await expect(p.getAlbum('nope')).rejects.toSatisfy((e: unknown) => isNetError(e, 'not_found'))
  })
})

// ---------------------------------------------------------------------------
// Catalog index (curated collections). Fixtures: real advancedsearch.php pages (2026-10-14),
// trimmed to a mix of kept and dropped items, descriptions cut to 600 characters.

const section = (key: string) => IA_INDEX_COLLECTIONS.find((c) => c.key === key)!

describe('archive: index helpers', () => {
  it('format labels: MPEG-4 / AAC are audio; fingerprints, playlists, zips and previews are not', () => {
    expect(iaAudioFormat('MPEG-4 Audio', 'a.m4a')).toBe('m4a')
    expect(iaAudioFormat('Apple Lossless Audio', 'a.m4a')).toBe('m4a')
    expect(iaAudioFormat('Advanced Audio Coding', 'a.aac')).toBe('aac')
    expect(iaAudioFormat('Flac FingerPrint', 'a.ffp')).toBeNull()
    expect(iaAudioFormat('64Kbps MP3 ZIP', 'a.zip')).toBeNull()
    expect(iaAudioFormat('VBR M3U', 'a.m3u')).toBeNull()
    expect(iaAudioFormat('MP3 Sample', 'a.mp3')).toBeNull()
    expect(iaAudioFormat('Unknown', 'a.opus')).toBe('opus')
    expect(iaAudioFormat('Unknown', 'a.nsf')).toBeNull()
    expect(hasPlayableAudio(['Metadata', 'MPEG-4 Audio'])).toBe(true)
    expect(hasPlayableAudio(['ZIP', '64Kbps MP3 ZIP', 'Flac FingerPrint'])).toBe(false)
    expect(hasPlayableAudio(['Opus', 'PNG'])).toBe(true)
    expect(hasPlayableAudio('VBR MP3')).toBe(true)
  })

  it('titles lose format tags, a leading catalog number and a developer prefix, nothing else', () => {
    expect(cleanIaTitle('Call of Cthulhu (2018) Original Soundtrack (320Kbps/MP3)')).toEqual({ title: 'Call of Cthulhu (2018) Original Soundtrack', catalogNo: null })
    expect(cleanIaTitle('Mario Kart World: Unofficial Soundtrack [MP3 & FLAC]').title).toBe('Mario Kart World: Unofficial Soundtrack')
    expect(cleanIaTitle('Virtua Fighter - Full Soundtrack [SEGA Mega Drive 32X] (FLAC 96KHz 24bit)').title).toBe('Virtua Fighter - Full Soundtrack [SEGA Mega Drive 32X]')
    expect(cleanIaTitle('Doom 1993 OST (.FLAC)').title).toBe('Doom 1993 OST')
    expect(cleanIaTitle('[ARCJ-12] Arc the Lad Original Game Soundtrack (1995)')).toEqual({ title: 'Arc the Lad Original Game Soundtrack (1995)', catalogNo: 'ARCJ-12' })
    expect(cleanIaTitle('Kolibri Games: Idle Miner Tycoon soundtrack (2016)').title).toBe('Idle Miner Tycoon soundtrack (2016)')
    expect(cleanIaTitle('HUDSON SOFT: STAR SOLDIER [Vanishing Earth] ORIGINAL & ARRANGED SOUNDTRACK (1998)').title).toBe('STAR SOLDIER [Vanishing Earth] ORIGINAL & ARRANGED SOUNDTRACK (1998)')
    // not a developer prefix; Japanese-style dashes and full-width characters stay
    expect(cleanIaTitle('Electronic Arts Music from the Games: Beats/Electronica').title).toBe('Electronic Arts Music from the Games: Beats/Electronica')
    expect(cleanIaTitle('Motoi Sakuraba Live 2006 -Valkyrie Profile 2-').title).toBe('Motoi Sakuraba Live 2006 -Valkyrie Profile 2-')
    expect(cleanIaTitle('Super Real Mahjong P VI (スーパーリアル麻雀Ｐ VI)').title).toBe('Super Real Mahjong P VI (スーパーリアル麻雀Ｐ VI)')
    expect(cleanIaTitle('Sonic_Adventure_OST').title).toBe('Sonic Adventure OST')
    expect(cleanIaTitle('[FLAC]').title).toBe('[FLAC]')
  })

  it('platforms from subjects and title tags, with KHInsider slugs', () => {
    expect(iaPlatforms('Socom Confrontation full Soundtrack (PS3,Windows) (gamerip)', [])).toEqual([
      { slug: 'playstation-3', name: 'PS3' },
      { slug: 'windows', name: 'Windows' }
    ])
    expect(iaPlatforms('(1994) The Lion King - Soundtrack [Nintendo Super Famicom / Super Nintendo Entertainment System]', [])).toEqual([{ slug: 'nintendo-snes', name: 'SNES' }])
    expect(iaPlatforms("Castlevania II: Simon's Quest ~NES Version~ Game Rip (1988)", [])).toEqual([{ slug: 'nintendo-nes', name: 'NES' }])
    expect(iaPlatforms('Sonic 3D Blast', ['Sega Genesis', 'Sega Saturn', 'soundtrack'])).toEqual([
      { slug: 'sega-mega-drive-genesis', name: 'Genesis / Mega Drive' },
      { slug: 'sega-saturn', name: 'Saturn' }
    ])
    // words that merely contain a platform name don't count
    expect(iaPlatforms('Genesis Live in Concert (1977)', ['progressive rock', 'switchblade'])).toEqual([])
  })

  it('kind: title first (as getAlbum always did), then gamerip subjects / descriptions; CD rips are not game rips', () => {
    expect(iaAlbumKind('Cool Quest Soundtrack (Gamerip)')).toBe('gamerip')
    expect(iaAlbumKind('Rainbow Six Vegas OST 2006 cd rip')).toBe('ost')
    expect(iaAlbumKind('ROCKMAN SOUND BOX 2', ['rockman'], '.FLAC rip using Exact Audio Copy CPCA-10362-71')).toBe('ost')
    expect(iaAlbumKind('Mega Man X Music Collection', ['mega man', 'gamerip soundtrack'])).toBe('gamerip')
    expect(iaAlbumKind('Splatoon 3 Original Soundtrack', [], 'This is a collection of music ripped from the game files of Splatoon 3')).toBe('gamerip')
    expect(iaAlbumKind('Resident Evil Original Soundtrack Remix')).toBe('remix')
    expect(iaAlbumKind('Kingdom Hearts Piano Collections')).toBe('arrange')
    expect(iaYear(undefined, '2013-01-01T00:00:00Z')).toBe(2013)
    expect(iaYear('1998', '2023-02-16T00:00:00Z')).toBe(1998)
    expect(iaYear(undefined, '0000-01-01')).toBeNull()
  })

  it('game or not: film / TV / podcasts / stock music lose even with game words', () => {
    expect(isGameSoundtrack({ title: 'Some Game OST', subject: ['video game music'] })).toBe(true)
    expect(isGameSoundtrack({ title: 'Psychonauts - Soundtrack', subject: ['Peter McConnell', 'Psychonauts', 'game', 'music', 'soundtrack'], creator: 'Double Fine Productions' })).toBe(true)
    expect(isGameSoundtrack({ title: 'Drive (Original Motion Picture Soundtrack)', subject: ['soundtrack', 'film'] })).toBe(false)
    expect(isGameSoundtrack({ title: 'Pixelated Audio 55 - Granada', subject: ['VGM', 'video game music', 'SNES', 'video game music podcast'] })).toBe(false)
    expect(isGameSoundtrack({ title: 'Opacity', subject: ['chiptune', 'experimental', 'soundtrack'] })).toBe(false)
  })
})

describe('archive: index pages', () => {
  it('sections: the curated collections; gametracks (single BGMs) is not one', () => {
    const p = new ArchiveProvider({ fetch: fakeFetch({}) })
    expect(isIndexProvider(p)).toBe(true)
    expect(p.indexSections().map((s) => s.key)).toEqual(['folksoundomy_gamesoundtracks', 'hifidelity_soundtracks', 'hifidelity_potpourri'])
    expect(p.indexSections().every((s) => s.maxPages == null && s.label.length > 0)).toBe(true)
    expect(new ArchiveProvider({ indexCollections: [] }).indexSections()).toEqual([])
  })

  it('page URL: advancedsearch, 500 rows, sorted by identifier, the fields hits are built from', () => {
    const u = new URL(indexPageUrl(section('hifidelity_soundtracks'), 3))
    expect(u.origin + u.pathname).toBe('https://archive.org/advancedsearch.php')
    expect(u.searchParams.get('q')).toBe('collection:hifidelity_soundtracks')
    expect(u.searchParams.getAll('fl[]')).toEqual(['identifier', 'title', 'creator', 'date', 'year', 'subject', 'description', 'format', 'mediatype'])
    expect(u.searchParams.get('sort[]')).toBe('identifier asc')
    expect(u.searchParams.get('rows')).toBe('500')
    expect(u.searchParams.get('page')).toBe('3')
    expect(u.searchParams.get('output')).toBe('json')
    expect(new URL(indexPageUrl(section('hifidelity_potpourri'), 1)).searchParams.get('q')).toMatch(/^collection:hifidelity_potpourri AND subject:\("video game music" OR /)
  })

  it('hifidelity_soundtracks (film / TV / game mixed): only game soundtracks are kept', () => {
    const page = parseIndexPage(fx<IaIndexResponse>('index-hifidelity-p1.json'), section('hifidelity_soundtracks'), 1)
    expect(page).toMatchObject({ page: 1, totalPages: 9, totalAlbums: null })
    expect(page.items.map((h) => h.ref)).toEqual([
      '007-from-russia-with-love-original-score',
      '007-nightfire-music-from-the-electronic-arts-game',
      '01-cris-velasco-and-sascha-dikiciyan-ascent',
      '01-title-first-circuit',
      '02._20211122',
      '04.-rotterdam-nation',
      '07-summit-no-more-running-mix',
      '07.ScrapBrainZone',
      '08-minecraft_202302',
      '1-33-creditsalego-city-undercover-original-soundtrack-wii-u-2013',
      '1080-snowboarding-original-sound-track'
    ])
    // dropped: Drive, Candy Candy (anime), Star Trek, The Warriors, Brother Bear 2, Jesus Christ Superstar,
    // a walkthrough recording, "01 Roxanne", royalty-free / stock-music uploads and a 7z-only item
    const refs = new Set(page.items.map((h) => h.ref))
    for (const r of ['01-kavinsky-lovefoxxx-nightcall', '01-candy-candy-92-op-movie', '01.wheremyheartwilltakeme', '009.-blaster-master-boy-walkthrough_202302', 'android_202001', 'aristotleTechnetium', 'Aloneinthedarkost'])
      expect(refs.has(r), r).toBe(false)
    expect(page.items.find((h) => h.ref === '07.ScrapBrainZone')).toEqual({
      provider: 'archive',
      ref: '07.ScrapBrainZone',
      title: 'Sonic the Hedgehog - Full Soundtrack (PAL Version) [SEGA Mega Drive]',
      titleFromRef: false,
      platforms: [{ slug: 'sega-mega-drive-genesis', name: 'Genesis / Mega Drive' }],
      kind: 'ost',
      typeLabel: null,
      year: 1991,
      thumb: 'https://archive.org/services/img/07.ScrapBrainZone',
      cover: 'https://archive.org/services/img/07.ScrapBrainZone',
      catalogNo: null,
      addedAt: null
    })
    expect(page.items.find((h) => h.ref === '02._20211122')!.title).toBe('Katamari Fortissimo Damacy (Katamari Damacy OST)')
    expect(page.items.find((h) => h.ref === '04.-rotterdam-nation')!.platforms.map((p) => p.name)).toContain('PS1')
  })

  it('folksoundomy_gamesoundtracks (curated): drops only unplayable, untitled, stray-track and clearly non-game items', () => {
    const page = parseIndexPage(fx<IaIndexResponse>('index-folksoundomy-p1.json'), section('folksoundomy_gamesoundtracks'), 1)
    expect(page).toMatchObject({ page: 1, totalPages: 4, totalAlbums: 1556 })
    const refs = page.items.map((h) => h.ref)
    expect(refs).not.toContain('00-label') // ZIP only
    expect(refs).not.toContain('0005_20231115') // titled "0005"
    expect(refs).not.toContain('01.-splattack') // "01. Splattack!": one track
    expect(refs).not.toContain('19-pale-blue-ending') // a video, no audio derivative
    expect(refs.length).toBe(9)
    const by = (ref: string) => page.items.find((h) => h.ref === ref)!
    expect(by('01-teddy-boy-blues')).toMatchObject({ title: 'B.B. QUEENS: SING!! SEGA Game Music presented by B.B. Queens (1992)', catalogNo: 'BVRR-1', year: 1992, kind: 'ost' })
    expect(by('03-bloody-tears')).toMatchObject({ kind: 'gamerip', year: 1990 })
    expect(by('05-smb-3-original-ver.').title).toMatch(/^Super Mario Bros\. 3 -G\.S\.M\. \(FC\) Nintendo 1-/)
    expect(by('05-smb-3-original-ver.').platforms).toEqual([{ slug: 'family-computer', name: 'Family Computer' }])
    expect(by('186-mc-2-1-hi')).toMatchObject({ kind: 'gamerip', platforms: [{ slug: 'playstation-3', name: 'PS3' }, { slug: 'windows', name: 'Windows' }] })
    expect(by('21-citadel')).toMatchObject({ title: 'STAR SOLDIER [Vanishing Earth] ORIGINAL & ARRANGED SOUNDTRACK (1998)', kind: 'arrange' })
    expect(by('1994_The_Lion_King_-_Soundtrack_Nintendo_Super_Famicom_Super_Nintendo_Entertainment_System').platforms).toEqual([{ slug: 'nintendo-snes', name: 'SNES' }])
  })

  it('hifidelity_potpourri: the game-music subject slice of a grab-bag collection', () => {
    const page = parseIndexPage(fx<IaIndexResponse>('index-potpourri-p3.json'), section('hifidelity_potpourri'), 3)
    expect(page).toMatchObject({ page: 3, totalPages: 3, totalAlbums: null })
    expect(page.items.map((h) => h.title)).toContain('Tekken 3 OST')
    expect(page.items.length).toBe(6)
  })

  it('a malformed response is a parse error', () => {
    expect(() => parseIndexPage({} as IaIndexResponse, section('hifidelity_soundtracks'), 1)).toThrow(/unexpected advancedsearch response/)
  })

  it('fetchIndexPage: one uncached request per page, spaced, background priority; unknown sections are not_found', async () => {
    const f = fakeFetch({ 'https://archive.org/advancedsearch.php': fx('index-hifidelity-p1.json') })
    const starts: number[] = []
    const timed = (async (input: string | URL | Request, init?: RequestInit) => {
      starts.push(Date.now())
      return f(input, init)
    }) as typeof fetch
    const p = new ArchiveProvider({ fetch: timed, indexSpacingMs: 60 })
    const [a, b] = await Promise.all([p.fetchIndexPage('hifidelity_soundtracks', 1), p.fetchIndexPage('hifidelity_soundtracks', 1)])
    expect(a.items.length).toBe(11)
    expect(b.items.length).toBe(11)
    expect(f.urls.length).toBe(2) // index pages are not cached (big, read once per crawl)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(50)
    expect(new URL(f.urls[0]).searchParams.get('page')).toBe('1')
    await expect(p.fetchIndexPage('gametracks', 1)).rejects.toSatisfy((e: unknown) => isNetError(e, 'not_found'))
    await expect(p.fetchIndexPage('hifidelity_soundtracks', 0)).rejects.toSatisfy((e: unknown) => isNetError(e, 'parse'))
  })
})

describe('archive: getAlbum on collection items', () => {
  it('"1-01 …" / "2-01 …" file names are discs', () => {
    const a = parseMetadata('1-33-creditsalego-city-undercover-original-soundtrack-wii-u-2013', fx<IaMetadata>('metadata-lego-city-discs.json'))
    expect(a.platforms).toEqual([{ slug: 'nintendo-wii-u', name: 'Wii U' }])
    expect(a.tracks.map((t) => [t.disc, t.number, t.title])).toEqual([
      [1, 1, 'Lego City Undercover'],
      [1, 2, 'Main Menu'],
      [1, 3, 'Loading...'],
      [2, 1, 'Special Assignment Complete (Unused)'],
      [2, 2, 'Detective (Beta)']
    ])
  })

  it('MPEG-4 Audio uploads are playable m4a tracks', () => {
    const a = parseMetadata('Kirby-Planet-Robobot-Original-Soundtrack', fx<IaMetadata>('metadata-kirby-m4a.json'))
    expect(a.formats).toEqual(['m4a'])
    expect(a.tracks.map((t) => [t.disc, t.number, t.title])).toEqual([
      [1, 1, 'The Revolving Star is a Planet'],
      [1, 2, 'First Contact'],
      [2, 44, 'No Regrets, Right?'],
      [2, 45, 'The Galaxy-wide Notorius Hartmann: The Last Recital of Previous Night']
    ])
    expect(a.tracks[0].streams![0]).toMatchObject({ format: 'm4a', lossless: false, sizeBytes: 7_435_670 })
    expect(a.cover).toBe('https://archive.org/download/Kirby-Planet-Robobot-Original-Soundtrack/Cover.jpeg')
  })

  it('the same tracks in 64/96/128 kbps folders are one track each, best copy first', () => {
    const a = parseMetadata('pvz-ost-opus', fx<IaMetadata>('metadata-pvz-opus-bitrates.json'))
    expect(a.tracks.map((t) => t.title)).toEqual(["Crazy Dave's Greeting", 'Crazy Dave (Intro Theme)'])
    expect(a.tracks[0].locator).toBe("pvz-ost-opus/unzipped/128kbps/01 - Crazy Dave's Greeting.opus")
    expect(a.tracks[0].files).toEqual([{ format: 'opus', sizeBytes: 143_057 }])
  })

  it('a FLAC fingerprint is not a track; title tags that repeat the track number lose it', () => {
    const a = parseMetadata('tyrian-original-soundtrack', fx<IaMetadata>('metadata-tyrian-fingerprint.json'))
    expect(a.tracks.map((t) => [t.number, t.title, t.files.map((f) => f.format).join('+')])).toEqual([
      [1, 'Asteroid Dance, Part 1', 'flac+mp3+ogg'],
      [2, 'Asteroid Dance, Part 2', 'flac+mp3+ogg']
    ])
  })

  it('discs merged without disc tags ("24/28", "22/37"): ordered by name, numbered by position', () => {
    const a = parseMetadata('splatoon-3-ost-rip-organized-v2', fx<IaMetadata>('metadata-splatoon-merged-discs.json'))
    expect(a.kind).toBe('gamerip')
    expect(a.tracks.map((t) => t.number)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(a.tracks.map((t) => t.title).slice(0, 3)).toEqual(['#35 caught (Kettle)', '#35 caught (Spotted)', '#35 caught'])
  })

  it('partly tagged items: every track keeps a number of its own', () => {
    const flac = (name: string, title: string, track?: string, disc?: string): IaFile => ({ name, source: 'original', format: 'Flac', title, track, disc })
    const numbers = (files: IaFile[]) => parseMetadata('x', { metadata: { title: 'X' }, files }).tracks.map((t) => [t.disc, t.number, t.title])
    // A tag equal to another file's position: 2 and 2 before.
    expect(numbers([flac('01.flac', 'Start', '2'), flac('02.flac', 'Missing tag')])).toEqual([
      [1, 2, 'Start'],
      [1, 3, 'Missing tag']
    ])
    // Untagged files continue after high tags, before or after them in name order.
    expect(numbers([flac('a.flac', 'Intro'), flac('b.flac', 'Ten', '10'), flac('c.flac', 'Eleven', '11'), flac('d.flac', 'Outro')])).toEqual([
      [1, 10, 'Ten'],
      [1, 11, 'Eleven'],
      [1, 12, 'Intro'],
      [1, 13, 'Outro']
    ])
    // A numbered set: an untagged file keeps its name's number, unless a tag has it already.
    const set = (bonusTag?: string) => [flac('01 A.flac', 'A', '1'), flac('02 B.flac', 'B', '2'), flac('03 C.flac', 'C', bonusTag), flac('05 E.flac', 'E')]
    expect(numbers(set()).map((r) => r[1])).toEqual([1, 2, 3, 5])
    expect(numbers(set('5')).map((r) => [r[1], r[2]])).toEqual([
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
      [4, 'E']
    ])
    // Fully tagged discs keep their numbers; discs number separately.
    expect(numbers([flac('a.flac', 'One', '1', '1'), flac('b.flac', 'Three', '3', '1'), flac('c.flac', 'Other One', '1', '2'), flac('d.flac', 'Extra', undefined, '2')])).toEqual([
      [1, 1, 'One'],
      [1, 3, 'Three'],
      [2, 1, 'Other One'],
      [2, 2, 'Extra']
    ])
  })

  it('format folders', () => {
    for (const d of ['FLAC', 'MP3 320kbps', '24bit-96kHz', '64kbps', 'mp3 (V0)', 'Hi-Res FLAC']) expect(isFormatDir(d), d).toBe(true)
    for (const d of ['Disc 1', 'CD1', 'Bonus', 'Hollow Knight - Official Soundtrack', '1993 - DOOM']) expect(isFormatDir(d), d).toBe(false)
  })
})
