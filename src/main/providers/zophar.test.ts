import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isNetError, NetError } from '../net/errors'
import type { PageFetchOptions } from '../net/http'
import {
  albumUrl,
  coverFromThumb,
  encodeSegment,
  locatorFromUrl,
  parseAlbumPage,
  parseInlineTracks,
  parseListingPage,
  parseLocator,
  parseSearchPage,
  refFromHref,
  searchUrl,
  sectionUrl,
  streamUrl,
  tidyTitle,
  ZOPHAR_ID,
  ZOPHAR_SECTION_KEYS,
  zopharPlatform,
  ZopharProvider,
  zopharStream
} from './zophar'

const fx = (name: string) => readFileSync(join(__dirname, '__fixtures__', 'zophar', name), 'utf8')

const FF6 = 'nintendo-snes-spc/final-fantasy-vi'
const DRACULA_X = 'nintendo-snes-spc/castlevania-dracula-x-[castlevania-vampires-kiss]'
const FORBIDDEN_MEMORIES = 'playstation-psf/yu-gi-oh-forbidden-memories'

/** The MP3 links exactly as the album page writes them. */
const downloadHrefs = (html: string) => [...html.matchAll(/<td class="download"><a href="([^"]+)"/g)].map((m) => m[1])

describe('zophar: urls, refs and locators', () => {
  it('builds page urls', () => {
    expect(sectionUrl('nintendo-snes-spc', 1)).toBe('https://www.zophar.net/music/nintendo-snes-spc')
    expect(sectionUrl('nintendo-snes-spc', 3)).toBe('https://www.zophar.net/music/nintendo-snes-spc?page=3')
    expect(() => sectionUrl('letter', 1)).toThrow()
    expect(() => sectionUrl('../x', 1)).toThrow()
    expect(searchUrl('yu-gi-oh')).toBe('https://www.zophar.net/music/search?search=yu-gi-oh')
    expect(searchUrl('final fantasy & co')).toBe('https://www.zophar.net/music/search?search=final+fantasy+%26+co')
    expect(albumUrl(FF6)).toBe('https://www.zophar.net/music/nintendo-snes-spc/final-fantasy-vi')
    // Slugs keep their brackets literal, as the site links them.
    expect(albumUrl(DRACULA_X)).toBe('https://www.zophar.net/music/nintendo-snes-spc/castlevania-dracula-x-[castlevania-vampires-kiss]')
    for (const bad of ['final-fantasy-vi', '/x', 'x/', 'a/b/c']) {
      try {
        albumUrl(bad)
        expect.unreachable()
      } catch (e) {
        expect(isNetError(e, 'not_found')).toBe(true)
      }
    }
  })

  it('refs from listing hrefs', () => {
    expect(refFromHref('/music/nintendo-snes-spc/7th-saga-the')).toBe('nintendo-snes-spc/7th-saga-the')
    expect(refFromHref('https://www.zophar.net/music/playstation-psf/yu-gi-oh-forbidden-memories')).toBe(FORBIDDEN_MEMORIES)
    expect(refFromHref('/music/nintendo-snes-spc/castlevania-dracula-x-%5Bcastlevania-vampires-kiss%5D')).toBe(DRACULA_X)
    expect(refFromHref('/music/developer/malibu')).toBeNull()
    expect(refFromHref('/music/year/1994')).toBeNull()
    expect(refFromHref('/music/letter/A')).toBeNull()
    expect(refFromHref('/music/nintendo-snes-spc')).toBeNull()
    expect(refFromHref('/music/a/b/c')).toBeNull()
    expect(refFromHref(undefined)).toBeNull()
  })

  it('encodes file names like PHP rawurlencode', () => {
    expect(encodeSegment("214 Devil's Lab.mp3")).toBe('214%20Devil%27s%20Lab.mp3')
    expect(encodeSegment('#1 & Co (Remix)!*.mp3')).toBe('%231%20%26%20Co%20%28Remix%29%21%2A.mp3')
    expect(encodeSegment('100% Pure+?.mp3')).toBe('100%25%20Pure%2B%3F.mp3')
    expect(encodeSegment('ポケモン センター é.mp3')).toBe('%E3%83%9D%E3%82%B1%E3%83%A2%E3%83%B3%20%E3%82%BB%E3%83%B3%E3%82%BF%E3%83%BC%20%C3%A9.mp3')
    expect(encodeSegment('[Disc 1] ~a_b.c-d~.mp3')).toBe('%5BDisc%201%5D%20~a_b.c-d~.mp3')
  })

  it('locators round-trip to stream urls (odd characters included)', () => {
    const loc = 'nintendo-snes-spc/some-game/#1 & Co (Remix)! ポケモン 100%.mp3'
    expect(parseLocator(loc)).toEqual({ platform: 'nintendo-snes-spc', slug: 'some-game', file: '#1 & Co (Remix)! ポケモン 100%.mp3' })
    const url = streamUrl(loc)
    expect(url).toBe('https://fi.zophar.net/soundfiles/nintendo-snes-spc/some-game/%231%20%26%20Co%20%28Remix%29%21%20%E3%83%9D%E3%82%B1%E3%83%A2%E3%83%B3%20100%25.mp3')
    expect(locatorFromUrl(url)).toBe(loc)
    // A file in a sub-folder keeps its '/'.
    expect(streamUrl('psp/game/disc 1/01 Intro.mp3')).toBe('https://fi.zophar.net/soundfiles/psp/game/disc%201/01%20Intro.mp3')
    expect(locatorFromUrl('https://fi.zophar.net/soundfiles/psp/game/disc%201/01%20Intro.mp3')).toBe('psp/game/disc 1/01 Intro.mp3')
    expect(locatorFromUrl('https://example.com/soundfiles/a/b/c.mp3')).toBeNull()
    for (const bad of ['', 'a/b', 'a//c', '/a/b/c', 'a/b/']) expect(() => parseLocator(bad)).toThrow(/\[parse\]/)
  })

  it('every MP3 link on the fixture pages is rebuilt byte-for-byte from its locator', () => {
    for (const name of ['album-final-fantasy-vi.html', 'album-castlevania-dracula-x.html', 'album-yu-gi-oh-forbidden-memories.html', 'album-fm-towns-blandia-plus.html']) {
      const hrefs = downloadHrefs(fx(name))
      expect(hrefs.length).toBeGreaterThan(10)
      for (const href of hrefs) expect(streamUrl(locatorFromUrl(href)!)).toBe(href)
    }
  })

  it('covers: thumbnails upgrade to the full-size image', () => {
    expect(coverFromThumb('https://fi.zophar.net/soundcovers/nintendo-snes-spc/thumbs_small/snes_7thsaga.jpg')).toBe('https://fi.zophar.net/soundcovers/nintendo-snes-spc/snes_7thsaga.jpg')
    expect(coverFromThumb('https://fi.zophar.net/soundcovers/playstation-psf/thumbs_large/ps1_yugiohforbiddenmemories.jpg')).toBe(
      'https://fi.zophar.net/soundcovers/playstation-psf/ps1_yugiohforbiddenmemories.jpg'
    )
    expect(coverFromThumb(null)).toBeNull()
  })

  it('library-style titles', () => {
    expect(tidyTitle('7th Saga, The')).toBe('The 7th Saga')
    expect(tidyTitle("Bug's Life, A")).toBe("A Bug's Life")
    expect(tidyTitle("Addams Family, The - Pugsley's Scavenger Hunt")).toBe("The Addams Family - Pugsley's Scavenger Hunt")
    expect(tidyTitle('Legend of Zelda, The  [Zelda no Densetsu]')).toBe('The Legend of Zelda [Zelda no Densetsu]')
    expect(tidyTitle('Batman & Robin, The Animated')).toBe('Batman & Robin, The Animated')
    expect(tidyTitle('  Castlevania - Dracula X  [Castlevania - Vampire\u00a0Kiss] ')).toBe('Castlevania - Dracula X [Castlevania - Vampire Kiss]')
  })
})

describe('zophar: platforms', () => {
  it('maps every crawled listing to a KHInsider-compatible platform', () => {
    expect(ZOPHAR_SECTION_KEYS.length).toBe(36)
    expect(new Set(ZOPHAR_SECTION_KEYS).size).toBe(36)
    const mapped = Object.fromEntries(ZOPHAR_SECTION_KEYS.map((k) => [k, zopharPlatform(k)]))
    expect(mapped).toMatchObject({
      'nintendo-nes-nsf': { slug: 'nintendo-nes', name: 'NES' },
      'nintendo-snes-spc': { slug: 'nintendo-snes', name: 'SNES' },
      'gameboy-gbs': { slug: 'gameboy', name: 'GB' },
      'gameboy-advance-gsf': { slug: 'gameboy-advance', name: 'GBA' },
      'nintendo-ds-2sf': { slug: 'nintendo-ds', name: 'DS' },
      'nintendo-3ds-3sf': { slug: 'nintendo-3ds', name: '3DS' },
      'nintendo-64-usf': { slug: 'nintendo-64', name: 'N64' },
      'nintendo-gamecube-gcn': { slug: 'nintendo-gamecube', name: 'GC' },
      'nintendo-wii': { slug: 'nintendo-wii', name: 'Wii' },
      'playstation-psf': { slug: 'playstation', name: 'PS1' },
      'playstation2-psf2': { slug: 'playstation-2', name: 'PS2' },
      'playstation3-psf3': { slug: 'playstation-3', name: 'PS3' },
      'playstation-portable-psp': { slug: 'playstation-portable-psp', name: 'PSP' },
      'sega-mega-drive-genesis': { slug: 'sega-mega-drive-genesis', name: 'Genesis / Mega Drive' },
      'sega-master-system-vgm': { slug: 'sega-master-system', name: 'Master System' },
      'sega-game-gear-sgc': { slug: 'sega-game-gear', name: 'Game Gear' },
      'sega-saturn-ssf': { slug: 'sega-saturn', name: 'Saturn' },
      'sega-dreamcast-dsf': { slug: 'sega-dreamcast', name: 'Dreamcast' },
      'turbografx-16-hes': { slug: 'turbografx-16', name: 'TurboGrafx-16' },
      xbox: { slug: 'xbox', name: 'Xbox' },
      'xbox-360': { slug: 'xbox-360', name: 'Xbox 360' },
      windows: { slug: 'windows', name: 'Windows' },
      'commodore-64': { slug: 'commodore-64', name: 'Commodore 64' },
      amiga: { slug: 'amiga', name: 'Amiga' },
      arcade: { slug: 'arcade', name: 'Arcade' },
      'pc-9801': { slug: 'pc-9801', name: 'PC-98' },
      x68000: { slug: 'x68000', name: 'X68000' },
      'fm-towns': { slug: 'fm-towns', name: 'FM Towns' },
      'ms-dos': { slug: 'ms-dos', name: 'MS-DOS' },
      'cd-i': { slug: 'cd-i', name: 'CD-i' }
    })
    // Every section has a short label distinct from the others.
    expect(new Set(Object.values(mapped).map((p) => p.name)).size).toBe(36)
  })

  it('aliases and unknown platforms', () => {
    expect(zopharPlatform('kss')).toEqual({ slug: 'msx', name: 'MSX' })
    expect(zopharPlatform('psf2')).toEqual({ slug: 'playstation-2', name: 'PS2' })
    expect(zopharPlatform('Nintendo-SNES-SPC')).toEqual({ slug: 'nintendo-snes', name: 'SNES' })
    expect(zopharPlatform('bandai-wonderswan-wsr', 'Bandai WonderSwan (WSR)')).toEqual({ slug: 'bandai-wonderswan-wsr', name: 'Bandai WonderSwan' })
    expect(zopharPlatform('nec-pc-fx-psf', 'NEC PC-FX (PSF)')).toEqual({ slug: 'nec-pc-fx', name: 'NEC PC-FX' })
    expect(zopharPlatform('virtual-boy-vgm')).toEqual({ slug: 'virtual-boy', name: 'Virtual Boy' })
    // Returned objects are copies (callers may mutate their hits).
    zopharPlatform('xbox').name = 'changed'
    expect(zopharPlatform('xbox').name).toBe('Xbox')
  })
})

describe('zophar: listings', () => {
  it('platform listing page (trimmed to 36 of 200 rows; stats and pagination kept)', () => {
    const p = parseListingPage(fx('listing-snes-p1.html'))
    expect(p.page).toBe(1)
    expect(p.totalPages).toBe(9)
    expect(p.totalAlbums).toBe(1639)
    expect(p.items.length).toBe(36)
    // Sidebar / "popular" links never leak in as rows.
    expect(p.items.every((i) => i.ref.startsWith('nintendo-snes-spc/'))).toBe(true)
    const saga = p.items.find((i) => i.ref === 'nintendo-snes-spc/7th-saga-the')!
    expect(saga).toEqual({
      provider: 'zophar',
      ref: 'nintendo-snes-spc/7th-saga-the',
      title: 'The 7th Saga',
      titleFromRef: false,
      platforms: [{ slug: 'nintendo-snes', name: 'SNES' }],
      kind: 'gamerip',
      typeLabel: 'Gamerip',
      year: 1993,
      thumb: 'https://fi.zophar.net/soundcovers/nintendo-snes-spc/thumbs_small/snes_7thsaga.jpg',
      cover: 'https://fi.zophar.net/soundcovers/nintendo-snes-spc/snes_7thsaga.jpg',
      catalogNo: null,
      addedAt: null
    })
    // Row without an image.
    expect(p.items[0]).toMatchObject({ ref: 'nintendo-snes-spc/3-ninjas-kick-back', title: '3 Ninjas Kick Back', year: 1994, thumb: null, cover: null })
    const byRef = (ref: string) => p.items.find((i) => i.ref === `nintendo-snes-spc/${ref}`)!.title
    expect(byRef('add-eye-of-the-beholder')).toBe('AD&D - Eye of the Beholder')
    expect(byRef('adventures-of-batman-robin-the')).toBe('The Adventures of Batman & Robin')
    expect(byRef('bugs-life-a')).toBe("A Bug's Life")
    expect(byRef('castlevania-dracula-x-[castlevania-vampires-kiss]')).toBe("Castlevania - Dracula X [Castlevania - Vampire's Kiss]")
    // Same title, two sets.
    expect(p.items.filter((i) => i.title === 'Casper').map((i) => [i.ref, i.year])).toEqual([
      ['nintendo-snes-spc/casper', 1996],
      ['nintendo-snes-spc/casper-1997', 1997]
    ])
  })

  it('single-page platform listing (no pagination block)', () => {
    const p = parseListingPage(fx('listing-fm-towns.html'))
    expect(p).toMatchObject({ page: 1, totalPages: 1, totalAlbums: 14 })
    expect(p.items.length).toBe(14)
    expect(p.items.every((i) => i.ref.startsWith('fm-towns/') && i.year !== null && i.thumb === null)).toBe(true)
    expect(p.items[0]).toMatchObject({ ref: 'fm-towns/blandia-plus', title: 'Blandia Plus', year: 1994, platforms: [{ slug: 'fm-towns', name: 'FM Towns' }] })
    expect(p.items.map((i) => i.title)).toContain('Mad Stalker: Full Metal Force')
  })

  it('pagination fallbacks', () => {
    const page = (inner: string) => `<html><body><div id="gamelistpage">${inner}<table id="gamelist">
      <tr class="regularrow"><td class="image">&nbsp;</td><td class="name"><a href="/music/fm-towns/some-game">Some Game</a></td><td class="year"></td><td class="developer"></td></tr>
      </table></div></body></html>`
    // Single-page platform: no pagination block.
    expect(parseListingPage(page('<p class="found_stats">Found 14 games with 300 tracks!</p>'))).toMatchObject({ page: 1, totalPages: 1, totalAlbums: 14 })
    // Counter missing but "End" link present.
    expect(
      parseListingPage(page('<p class="found_stats">Found 1,968 games</p><div class="pagination"><ul><li class="pagination-end"><a href="?page=10">&gt;&gt;</a></li></ul></div>'), 4)
    ).toMatchObject({ page: 4, totalPages: 10, totalAlbums: 1968 })
    // Only the count: derive pages from 200 rows per page.
    expect(parseListingPage(page('<p class="found_stats">Found 401 games with 9 tracks!</p>'), 2)).toMatchObject({ page: 2, totalPages: 3, totalAlbums: 401 })
    // Nothing at all.
    const bare = parseListingPage(page(''))
    expect(bare).toMatchObject({ page: 1, totalPages: 1, totalAlbums: null })
    expect(bare.items[0]).toMatchObject({ ref: 'fm-towns/some-game', year: null, platforms: [{ slug: 'fm-towns', name: 'FM Towns' }] })
  })

  it('a page without the listing layout is a parse error', () => {
    expect(() => parseListingPage('<html><body><h1>Maintenance</h1></body></html>')).toThrow(/\[parse\]/)
    expect(() => parseSearchPage('')).toThrow(/\[parse\]/)
  })

  it('search results ("yu-gi-oh")', () => {
    const hits = parseSearchPage(fx('search-yu-gi-oh.html'))
    expect(hits.length).toBe(30)
    expect(hits.every((h) => h.provider === ZOPHAR_ID && h.kind === 'gamerip' && h.title.startsWith('Yu-Gi-Oh'))).toBe(true)
    expect(hits.find((h) => h.ref === FORBIDDEN_MEMORIES)).toMatchObject({
      title: 'Yu-Gi-Oh - Forbidden Memories',
      year: 1999,
      platforms: [{ slug: 'playstation', name: 'PS1' }],
      thumb: 'https://fi.zophar.net/soundcovers/playstation-psf/thumbs_small/ps1_yugiohforbiddenmemories.jpg',
      cover: 'https://fi.zophar.net/soundcovers/playstation-psf/ps1_yugiohforbiddenmemories.jpg'
    })
    // Plain-text (unlinked) year; empty year.
    expect(hits.find((h) => h.ref === 'nintendo-nes-nsf/yu-gi-oh')).toMatchObject({ title: 'Yu-Gi-Oh', year: null, platforms: [{ slug: 'nintendo-nes', name: 'NES' }] })
    expect(hits.find((h) => h.ref === 'nintendo-ds-2sf/yu-gi-oh-duel-monsters-gx-card-almanac')).toMatchObject({ year: 2007, platforms: [{ slug: 'nintendo-ds', name: 'DS' }] })
    const platforms = new Set(hits.map((h) => h.platforms[0].slug))
    expect([...platforms].sort()).toEqual(['gameboy', 'gameboy-advance', 'nintendo-3ds', 'nintendo-ds', 'nintendo-gamecube', 'nintendo-nes', 'nintendo-wii', 'playstation', 'playstation-2', 'playstation-portable-psp'])
  })
})

describe('zophar: album pages', () => {
  it('normal set: alt name, release year, developer/publisher, cover, numbered files', () => {
    const a = parseAlbumPage(fx('album-yu-gi-oh-forbidden-memories.html'), FORBIDDEN_MEMORIES)
    expect(a).toMatchObject({
      provider: 'zophar',
      ref: FORBIDDEN_MEMORIES,
      title: 'Yu-Gi-Oh - Forbidden Memories',
      titleFromRef: false,
      altTitles: ['Yu-Gi-Oh! - Shin Duel Monsters - Fuuinsareshi Kioku'],
      titleOriginal: null,
      year: 1999,
      platforms: [{ slug: 'playstation', name: 'PS1' }],
      developers: ['KCE Japan'],
      publishers: ['Konami'],
      composers: [],
      kind: 'gamerip',
      typeLabel: 'Gamerip',
      thumb: 'https://fi.zophar.net/soundcovers/playstation-psf/thumbs_large/ps1_yugiohforbiddenmemories.jpg',
      cover: 'https://fi.zophar.net/soundcovers/playstation-psf/ps1_yugiohforbiddenmemories.jpg',
      images: ['https://fi.zophar.net/soundcovers/playstation-psf/ps1_yugiohforbiddenmemories.jpg'],
      description: null,
      formats: ['mp3'],
      totalSizes: { mp3: 54 * 1048576 },
      externalId: null,
      catalogNo: null,
      addedAt: null
    })
    expect(a.tracks.length).toBe(58)
    expect(a.tracks[3]).toEqual({
      disc: 1,
      number: 4,
      title: '04',
      durationMs: 64_000,
      locator: 'playstation-psf/yu-gi-oh-forbidden-memories/04.mp3',
      files: [{ format: 'mp3', sizeBytes: null }],
      composers: [],
      streams: [
        {
          provider: 'zophar',
          source: {
            kind: 'http',
            url: 'https://fi.zophar.net/soundfiles/playstation-psf/yu-gi-oh-forbidden-memories/04.mp3',
            cacheKey: 'zophar:playstation-psf/yu-gi-oh-forbidden-memories/04.mp3',
            formatHint: 'mp3'
          },
          format: 'mp3',
          lossless: false,
          bitrateKbps: null,
          sizeBytes: null,
          expiresAt: null
        }
      ]
    })
    expect(a.tracks.map((t) => t.number)).toEqual(Array.from({ length: 58 }, (_, i) => i + 1))
  })

  it("odd file names: apostrophes, '!', parentheses, split parts (101a/101b) and repeated numbers", () => {
    const a = parseAlbumPage(fx('album-final-fantasy-vi.html'), FF6)
    expect(a).toMatchObject({ title: 'Final Fantasy VI', altTitles: [], year: 1994, developers: ['Square'], publishers: ['Square'], totalSizes: { mp3: 440 * 1048576 } })
    expect(a.tracks.length).toBe(82)
    // "101." + "a Opening Theme (part 1)" on the page; the letter belongs to the file number.
    expect(a.tracks.slice(0, 4).map((t) => t.title)).toEqual(['Opening Theme (part 1)', 'Opening Theme (part 2)', 'Opening Theme (part 3)', 'The Mines of Narshe'])
    const lab = a.tracks.find((t) => t.title === "Devil's Lab")!
    expect(lab).toMatchObject({ number: 47, durationMs: 130_000, locator: "nintendo-snes-spc/final-fantasy-vi/214 Devil's Lab.mp3" })
    expect(lab.streams![0].source).toEqual({
      kind: 'http',
      url: 'https://fi.zophar.net/soundfiles/nintendo-snes-spc/final-fantasy-vi/214%20Devil%27s%20Lab.mp3',
      cacheKey: "zophar:nintendo-snes-spc/final-fantasy-vi/214 Devil's Lab.mp3",
      formatHint: 'mp3'
    })
    expect(a.tracks.find((t) => t.title === 'Save Them!')!.streams![0].source).toMatchObject({ url: 'https://fi.zophar.net/soundfiles/nintendo-snes-spc/final-fantasy-vi/123%20Save%20Them%21.mp3' })
    expect(a.tracks.find((t) => t.title === 'Dancing Mad (Full)')!.durationMs).toBe(691_000)
    // Sequential numbers although the site repeats "999." for the extras.
    expect(a.tracks.map((t) => t.number)).toEqual(Array.from({ length: 82 }, (_, i) => i + 1))
    expect(new Set(a.tracks.map((t) => t.locator)).size).toBe(82)
    expect(a.tracks.every((t) => t.disc === 1 && t.title.length > 0)).toBe(true)
  })

  it('slug with brackets, title with a doubled space and a regional name', () => {
    const a = parseAlbumPage(fx('album-castlevania-dracula-x.html'), DRACULA_X)
    expect(a.title).toBe("Castlevania - Dracula X [Castlevania - Vampire's Kiss]")
    expect(a.altTitles).toEqual(['Akumajou Dracula XX'])
    expect(a.year).toBe(1995)
    expect(a.developers).toEqual(['KCE Osaka'])
    expect(a.publishers).toEqual(['Konami'])
    expect(a.tracks.length).toBe(20)
    expect(a.tracks[6]).toMatchObject({ number: 7, title: 'Opus 13', durationMs: expect.any(Number) })
    expect(a.tracks[0].streams![0].source).toMatchObject({
      url: 'https://fi.zophar.net/soundfiles/nintendo-snes-spc/castlevania-dracula-x-[castlevania-vampires-kiss]/01%20Overture.mp3',
      cacheKey: 'zophar:nintendo-snes-spc/castlevania-dracula-x-[castlevania-vampires-kiss]/01 Overture.mp3'
    })
  })

  it("sparse set: no cover, no release date, composer credits, '#' in file names", () => {
    const a = parseAlbumPage(fx('album-fm-towns-blandia-plus.html'), 'fm-towns/blandia-plus')
    expect(a).toMatchObject({
      title: 'Blandia Plus',
      year: null,
      thumb: null,
      cover: null,
      images: [],
      altTitles: [],
      developers: [],
      publishers: ['Ving'],
      composers: ['Hisao Shiomi', 'Akira Inoue', 'Manabu Namiki'],
      platforms: [{ slug: 'fm-towns', name: 'FM Towns' }],
      totalSizes: { mp3: 72 * 1048576 }
    })
    expect(a.tracks.length).toBe(17)
    expect(a.tracks[0]).toMatchObject({ number: 1, title: 'Track #02', durationMs: 178_000, locator: 'fm-towns/blandia-plus/01_Track #02.mp3' })
    expect(a.tracks[0].streams![0].source).toMatchObject({
      url: 'https://fi.zophar.net/soundfiles/fm-towns/blandia-plus/01_Track%20%2302.mp3',
      cacheKey: 'zophar:fm-towns/blandia-plus/01_Track #02.mp3'
    })
  })

  it('falls back to the inline JS playlist when the track table is missing', () => {
    const html = fx('album-final-fantasy-vi.html')
    const withTable = parseAlbumPage(html, FF6).tracks
    const noTable = html.replace(/<table id="tracklist">[\s\S]*?<\/table>/, '')
    expect(noTable).not.toContain('id="tracklist"')
    const fromJs = parseAlbumPage(noTable, FF6).tracks
    expect(fromJs).toEqual(withTable)
  })

  it('inline JS: escapes, entities, brackets in names, the extension variable, a broken quote', () => {
    const js = (body: string, ext = '') => `<script>
      var index = 0, mediaPath = 'https://fi.zophar.net/soundfiles/sony-x/odd-game/', extension = '${ext}', tracks = [
        ${body}
      ], trackCount = tracks.length;
    </script>`
    const good = parseInlineTracks(
      js(`{"track": 1, "name": "Pok\\u00e9mon [Remix] \\"Live\\"", "length": "1:02", "file": "01%20Pok%C3%A9mon"},
          {"track": 2, "name": "Rock &amp; Roll", "length": "0:00", "file": "02 Rock.mp3"},`, '.mp3')
    )!
    expect(good.mediaPath).toBe('https://fi.zophar.net/soundfiles/sony-x/odd-game/')
    expect(good.tracks).toEqual([
      { name: 'Pokémon [Remix] "Live"', length: '1:02', file: '01%20Pok%C3%A9mon.mp3' },
      { name: 'Rock & Roll', length: '0:00', file: '02 Rock.mp3' }
    ])
    // An unescaped quote breaks JSON; each object is then read field by field.
    const broken = parseInlineTracks(js(`{"name": "Bad "quote" here", "length": "0:10", "file": "03.mp3"}, {"name": "Fine", "length": "0:20", "file": "04.mp3"},`))!
    expect(broken.tracks.map((t) => t.file)).toEqual(['03.mp3', '04.mp3'])
    expect(broken.tracks[1].name).toBe('Fine')
    expect(parseInlineTracks('<html>no player</html>')).toBeNull()

    const page = `<html><body><div id="gamepage"><div id="music_cover"></div><div id="music_info"><h2>Odd Game</h2></div>${js(
      `{"name": "Pok\\u00e9mon", "length": "1:02", "file": "01%20Pok%C3%A9mon.mp3"}, {"name": "", "length": "0:00", "file": "02%20Rock%20%26%20Roll.mp3"}`
    )}</div></body></html>`
    const a = parseAlbumPage(page, 'sony-x/odd-game')
    expect(a).toMatchObject({ title: 'Odd Game', year: null, developers: [], publishers: [], thumb: null, cover: null, images: [], totalSizes: {}, formats: ['mp3'] })
    expect(a.platforms).toEqual([{ slug: 'sony-x', name: 'Sony X' }])
    expect(a.tracks.map((t) => [t.number, t.title, t.durationMs, t.locator])).toEqual([
      [1, 'Pokémon', 62_000, 'sony-x/odd-game/01 Pokémon.mp3'],
      // Empty name → the file name without its number; 0:00 → unknown length.
      [2, 'Rock & Roll', null, 'sony-x/odd-game/02 Rock & Roll.mp3']
    ])
    expect(a.tracks[1].streams![0].source).toMatchObject({ url: 'https://fi.zophar.net/soundfiles/sony-x/odd-game/02%20Rock%20%26%20Roll.mp3' })
  })

  it('unknown album → not_found; foreign pages → parse', () => {
    // Zophar answers unknown albums with a 404 and an empty body.
    for (const html of ['', '  \n', '<div id="gamepage"><div id="music_info"><h2> </h2></div></div>']) {
      try {
        parseAlbumPage(html, 'nintendo-snes-spc/ghost-no-such-game')
        expect.unreachable()
      } catch (e) {
        expect(isNetError(e, 'not_found')).toBe(true)
      }
    }
    expect(() => parseAlbumPage(fx('listing-snes-p1.html'), FF6)).toThrow(/\[parse\]/)
    expect(() => parseAlbumPage('<html><title>Just a moment...</title></html>', FF6)).toThrow(/\[parse\]/)
  })
})

describe('zophar: streams', () => {
  it('StreamInfo for a locator', () => {
    expect(zopharStream('gameboy-gbs/some-game/01 Title Screen.mp3')).toEqual({
      provider: 'zophar',
      source: { kind: 'http', url: 'https://fi.zophar.net/soundfiles/gameboy-gbs/some-game/01%20Title%20Screen.mp3', cacheKey: 'zophar:gameboy-gbs/some-game/01 Title Screen.mp3', formatHint: 'mp3' },
      format: 'mp3',
      lossless: false,
      bitrateKbps: null,
      sizeBytes: null,
      expiresAt: null
    })
    // An unexpected extension is passed through rather than mislabelled.
    expect(zopharStream('x/y/01.ogg')).toMatchObject({ format: 'ogg', source: { formatHint: 'ogg' } })
  })
})

describe('zophar: provider with a fake HTTP client', () => {
  const pages: Record<string, string> = {
    'https://www.zophar.net/music/nintendo-snes-spc': fx('listing-snes-p1.html'),
    'https://www.zophar.net/music/nintendo-snes-spc?page=2': fx('listing-snes-p1.html').replace(/Page 1 of 9/g, 'Page 2 of 9'),
    'https://www.zophar.net/music/search?search=yu-gi-oh': fx('search-yu-gi-oh.html'),
    'https://www.zophar.net/music/nintendo-snes-spc/final-fantasy-vi': fx('album-final-fantasy-vi.html'),
    'https://www.zophar.net/music/nintendo-snes-spc/castlevania-dracula-x-[castlevania-vampires-kiss]': fx('album-castlevania-dracula-x.html'),
    'https://www.zophar.net/music/playstation-psf/cached-garbage': '<html><body>half a page'
  }
  const calls: { url: string; opts: PageFetchOptions }[] = []
  const invalidated: string[] = []
  const http = {
    pageFetch: async (url: string, opts: PageFetchOptions = {}) => {
      calls.push({ url, opts })
      const html = pages[url]
      // The real client turns Zophar's 404 for unknown albums into a not_found NetError.
      if (html === undefined) throw new NetError('not_found', `not found: ${url}`, { status: 404, url })
      return { url, status: 200, html, fromCache: url.includes('cached-garbage'), stale: false, fetchedAt: 0 }
    },
    fetchBytes: async () => {
      throw new Error('no')
    },
    limiter: () => {
      throw new Error('no')
    },
    blockedUntil: () => 0,
    invalidate: async (url: string) => {
      invalidated.push(url)
    }
  }
  const z = new ZopharProvider(http as never)

  it('identity and index sections', () => {
    expect(z.id).toBe('zophar')
    expect(z.name).toBe("Zophar's Domain")
    const sections = z.indexSections()
    expect(sections.length).toBe(36)
    expect(sections[0]).toEqual({ key: 'nintendo-nes-nsf', label: 'NES' })
    expect(sections.find((s) => s.key === 'playstation-psf')).toEqual({ key: 'playstation-psf', label: 'PS1' })
    expect(sections.every((s) => s.maxPages === undefined)).toBe(true)
    // Crawl politeness for the catalog crawler.
    expect(z.indexRefreshMs).toBe(14 * 24 * 3600_000)
    expect(z.indexPageDelayMs).toBe(1500)
  })

  it('fetchIndexPage: background priority and the browse TTL', async () => {
    calls.length = 0
    const p1 = await z.fetchIndexPage('nintendo-snes-spc', 1)
    expect(p1).toMatchObject({ page: 1, totalPages: 9, totalAlbums: 1639 })
    expect(p1.items.length).toBe(36)
    const p2 = await z.fetchIndexPage('nintendo-snes-spc', 2, { force: true })
    expect(p2.page).toBe(2)
    expect(calls.map((c) => c.url)).toEqual(['https://www.zophar.net/music/nintendo-snes-spc', 'https://www.zophar.net/music/nintendo-snes-spc?page=2'])
    expect(calls[0].opts).toMatchObject({ ttlMs: 24 * 3600_000, priority: 2 })
    expect(calls[1].opts).toMatchObject({ force: true })
  })

  it('searchAlbums', async () => {
    calls.length = 0
    expect(await z.searchAlbums('   ')).toEqual([])
    expect(calls.length).toBe(0)
    const hits = await z.searchAlbums(' yu-gi-oh ')
    expect(hits.length).toBe(30)
    expect(calls[0].opts).toMatchObject({ ttlMs: 3600_000, priority: 0 })
  })

  it('getAlbum, then streams come from the album with no further requests', async () => {
    calls.length = 0
    const album = await z.getAlbum(FF6)
    expect(album.tracks.length).toBe(82)
    expect(calls[0].opts).toMatchObject({ ttlMs: 7 * 24 * 3600_000, priority: 0 })
    const dx = await z.getAlbum(DRACULA_X, { priority: 1 })
    expect(dx.tracks.length).toBe(20)
    expect(calls[1]).toMatchObject({ url: 'https://www.zophar.net/music/nintendo-snes-spc/castlevania-dracula-x-[castlevania-vampires-kiss]', opts: { priority: 1 } })

    calls.length = 0
    const t = album.tracks.find((x) => x.title === "Devil's Lab")!
    const streams = await z.resolveStream(t.locator)
    expect(streams).toEqual(t.streams)
    expect(calls.length).toBe(0)
    await expect(z.resolveStream('nope')).rejects.toThrow(/\[parse\]/)
  })

  it('unknown album → not_found; a broken cached page is dropped', async () => {
    await expect(z.getAlbum('nintendo-snes-spc/ghost-no-such-game')).rejects.toSatisfy((e: unknown) => isNetError(e, 'not_found'))
    await expect(z.getAlbum('not-a-ref')).rejects.toSatisfy((e: unknown) => isNetError(e, 'not_found'))
    await expect(z.getAlbum('playstation-psf/cached-garbage')).rejects.toThrow(/\[parse\]/)
    expect(invalidated).toEqual(['https://www.zophar.net/music/playstation-psf/cached-garbage'])
  })
})
