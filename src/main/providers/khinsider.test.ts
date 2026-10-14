import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectBlock } from '../net/http'
import { isNetError } from '../net/errors'
import {
  coverFromThumb,
  extractComposers,
  khCacheKey,
  KhinsiderProvider,
  mapKhType,
  parseAlbumPage,
  parseBrowsePage,
  parseClock,
  parseKhDate,
  parseLatestPage,
  parseSearchPage,
  parseSize,
  parseTrackPage,
  sectionUrl,
  slugFromHref,
  titleFromSlug,
  trackPageUrl
} from './khinsider'

const fx = (name: string) => readFileSync(join(__dirname, '__fixtures__', 'khinsider', name), 'utf8')

describe('khinsider: small parsers', () => {
  it('dates, clocks, sizes', () => {
    expect(parseKhDate('Mar 15th, 2024')).toBe(Date.UTC(2024, 2, 15))
    expect(parseKhDate('October 14th, 2026')).toBe(Date.UTC(2026, 9, 14))
    expect(parseKhDate('Jan 2nd, 2020')).toBe(Date.UTC(2020, 0, 2))
    expect(parseKhDate('nope')).toBeNull()
    expect(parseClock('6:14')).toBe(374_000)
    expect(parseClock('0:38')).toBe(38_000)
    expect(parseClock('1:02:03')).toBe(3_723_000)
    expect(parseClock('')).toBeNull()
    expect(parseSize('11.98 MB')).toBe(Math.round(11.98 * 1048576))
    expect(parseSize('2,566 MB')).toBe(2566 * 1048576)
    expect(parseSize('900 KB')).toBe(900 * 1024)
    expect(parseSize('-')).toBeNull()
  })

  it('types map to AlbumKind', () => {
    expect(mapKhType('Gamerip')).toBe('gamerip')
    expect(mapKhType('Soundtrack')).toBe('ost')
    expect(mapKhType('Arrangement')).toBe('arrange')
    expect(mapKhType('Remix')).toBe('remix')
    expect(mapKhType('Single')).toBe('single')
    expect(mapKhType('Compilation')).toBe('compilation')
    expect(mapKhType('Inspired By')).toBe('other')
    expect(mapKhType('', 'foo-gamerip-2001')).toBe('gamerip')
    expect(mapKhType(null, 'Some Game')).toBe('ost')
  })

  it('urls, slugs, cache keys', () => {
    expect(sectionUrl('letter:A', 1)).toBe('https://downloads.khinsider.com/game-soundtracks/browse/A')
    expect(sectionUrl('letter:0-9', 3)).toBe('https://downloads.khinsider.com/game-soundtracks/browse/0-9?page=3&orderby=name&orderdirection=ASC')
    expect(sectionUrl('latest', 1)).toBe('https://downloads.khinsider.com/')
    expect(sectionUrl('latest', 2)).toBe('https://downloads.khinsider.com/?page=2')
    expect(slugFromHref('/game-soundtracks/album/chrono-trigger-on-piano-vol.-1-2019')).toBe('chrono-trigger-on-piano-vol.-1-2019')
    expect(slugFromHref('https://downloads.khinsider.com/game-soundtracks/album/x/01.mp3')).toBe('x')
    expect(slugFromHref('/game-soundtracks/browse/A')).toBeNull()
    const loc = 'chrono-trigger-arranged-version-the-brink-of-time-1995/01%2520-%2520Chrono%2520Trigger.mp3'
    expect(trackPageUrl(loc)).toBe('https://downloads.khinsider.com/game-soundtracks/album/chrono-trigger-arranged-version-the-brink-of-time-1995/01%2520-%2520Chrono%2520Trigger.mp3')
    expect(khCacheKey(loc, 'flac')).toBe('kh:chrono-trigger-arranged-version-the-brink-of-time-1995/01 - Chrono Trigger.flac')
    expect(titleFromSlug('disneys-little-einsteins-gba-gamerip-2006')).toBe('Disneys Little Einsteins')
    expect(coverFromThumb('https://x.vgmtreasurechest.com/soundtracks/s/thumbs_small/00%20Front.jpg')).toBe('https://x.vgmtreasurechest.com/soundtracks/s/00%20Front.jpg')
  })
})

describe('khinsider: browse / latest / search listings', () => {
  it('letter page', () => {
    const p = parseBrowsePage(fx('browse-A.html'))
    expect(p.totalPages).toBe(12)
    expect(p.page).toBe(1)
    expect(p.totalAlbums).toBe(5895)
    expect(p.items.length).toBe(500)
    const bird = p.items.find((i) => i.ref === 'a-bird-story-linux-macos-windows-gamerip-2014')!
    expect(bird).toMatchObject({
      provider: 'khinsider',
      title: 'A Bird Story',
      titleFromRef: false,
      kind: 'gamerip',
      typeLabel: 'Gamerip',
      year: 2014,
      thumb: 'https://lambda.vgmtreasurechest.com/soundtracks/a-bird-story-linux-macos-windows-gamerip-2014/thumbs_small/cover.jpg',
      cover: 'https://lambda.vgmtreasurechest.com/soundtracks/a-bird-story-linux-macos-windows-gamerip-2014/cover.jpg',
      addedAt: null
    })
    expect(bird.platforms).toEqual([
      { slug: 'linux', name: 'Linux' },
      { slug: 'mac-os', name: 'MacOS' },
      { slug: 'steam', name: 'Steam' },
      { slug: 'windows', name: 'Windows' }
    ])
    // An album without a thumbnail.
    const bbs = p.items.find((i) => i.ref === 'a-bbs-intro-demo-amiga-gamerip-1991')!
    expect(bbs.thumb).toBeNull()
    expect(bbs.platforms).toEqual([{ slug: 'amiga', name: 'Amiga' }])
    // The "top albums" grid above the table must not leak in as rows without type/year.
    expect(p.items.every((i) => i.ref && i.title)).toBe(true)
    const kinds = new Set(p.items.map((i) => i.kind))
    expect([...kinds].sort()).toEqual(expect.arrayContaining(['arrange', 'gamerip', 'ost', 'single']))
  })

  it('latest additions carry their date', () => {
    const p = parseLatestPage(fx('latest-home.html'))
    expect(p.totalPages).toBe(615)
    expect(p.items.length).toBeGreaterThan(50)
    const first = p.items.find((i) => i.ref === 'blue-prince-history-extended-2026')!
    expect(first.addedAt).toBe(Date.UTC(2026, 9, 14))
    expect(first.title).toBe('Blue Prince - History Extended')
    const einsteins = p.items.find((i) => i.ref === 'disneys-little-einsteins-gba-gamerip-2006')!
    expect(einsteins).toMatchObject({ title: "Disney's Little Einsteins", titleFromRef: false, kind: 'gamerip' })
    expect(einsteins.platforms).toEqual([{ slug: 'gameboy-advance', name: 'GBA' }])
    // Later headings get later dates assigned in document order.
    const dates = [...new Set(p.items.map((i) => i.addedAt))]
    expect(dates.length).toBeGreaterThanOrEqual(7)
    expect(dates[0]).toBeGreaterThan(dates[dates.length - 1]!)
  })

  it('a row with an empty title cell falls back to the slug', () => {
    const html = `<div id="pageContent"><table class="albumList"><tr><th></th><th>Album</th><th>Platform</th><th>Type</th><th>Year</th></tr>
      <tr><td class="albumIcon"><a href="/game-soundtracks/album/mystery-game-snes-gamerip-1994"><img src="https://x.vgmtreasurechest.com/soundtracks/mystery-game-snes-gamerip-1994/thumbs_small/c.jpg"></a></td>
      <td> </td><td><a href="/game-soundtracks/nintendo-snes">SNES</a></td><td></td><td>1994</td></tr></table></div>`
    const [hit] = parseBrowsePage(html).items
    expect(hit).toMatchObject({ ref: 'mystery-game-snes-gamerip-1994', title: 'Mystery Game', titleFromRef: true, kind: 'gamerip', year: 1994, typeLabel: null })
  })

  it('search results', () => {
    const hits = parseSearchPage(fx('search-hollow-knight.html'))
    expect(hits.length).toBeGreaterThan(10)
    const ost = hits.find((h) => h.ref === 'hollow-knight-original-soundtrack')!
    expect(ost.title).toBe('Hollow Knight')
    const silksong = hits.find((h) => h.ref === 'hollow-knight-silksong-2025')!
    expect(silksong.title).toBe('Hollow Knight: Silksong')
  })
})

describe('khinsider: album pages', () => {
  it('arrangement with alt title, catalog number, publisher, images, MP3+FLAC', () => {
    const a = parseAlbumPage(fx('album-brink-of-time.html'), 'chrono-trigger-arranged-version-the-brink-of-time-1995')
    expect(a.title).toBe('Chrono Trigger Arranged Version: The Brink of Time')
    expect(a.altTitles).toEqual(['クロノ・トリガー アレンジ・ヴァージョン ザ・ブリンク・オブ・タイム'])
    expect(a.titleOriginal).toBe('クロノ・トリガー アレンジ・ヴァージョン ザ・ブリンク・オブ・タイム')
    expect(a.platforms).toEqual([{ slug: 'nintendo-snes', name: 'SNES' }])
    expect(a.year).toBe(1995)
    expect(a.catalogNo).toBe('PSCN-5024')
    expect(a.publishers).toEqual(['NTT Publishing'])
    expect(a.developers).toEqual([])
    expect(a.kind).toBe('arrange')
    expect(a.typeLabel).toBe('Arrangement')
    expect(a.addedAt).toBe(Date.UTC(2024, 2, 15))
    expect(a.externalId).toBe('61295')
    expect(a.formats).toEqual(['mp3', 'flac'])
    expect(a.totalSizes).toEqual({ mp3: 100 * 1048576, flac: 328 * 1048576 })
    expect(a.images.length).toBe(9)
    expect(a.cover).toBe('https://nu.vgmtreasurechest.com/soundtracks/chrono-trigger-arranged-version-the-brink-of-time-1995/00%20Front.jpg')
    expect(a.thumb).toBe('https://nu.vgmtreasurechest.com/soundtracks/chrono-trigger-arranged-version-the-brink-of-time-1995/thumbs/00%20Front.jpg')
    expect(a.tracks.length).toBe(10)
    expect(a.tracks[0]).toEqual({
      disc: 1,
      number: 1,
      title: 'Chrono Trigger',
      durationMs: 374_000,
      locator: 'chrono-trigger-arranged-version-the-brink-of-time-1995/01%2520-%2520Chrono%2520Trigger.mp3',
      files: [
        { format: 'mp3', sizeBytes: Math.round(11.98 * 1048576) },
        { format: 'flac', sizeBytes: Math.round(42.91 * 1048576) }
      ],
      composers: []
    })
    expect(a.tracks.map((t) => t.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('multi-disc OST with CD column and credits in the description', () => {
    const a = parseAlbumPage(fx('album-ace-combat-7.html'), 'ace-combat-7-skies-unknown-original-soundtrack')
    expect(a.title).toBe('ACE COMBAT 7: SKIES UNKNOWN ORIGINAL SOUNDTRACK')
    expect(a.kind).toBe('ost')
    expect(a.catalogNo).toBe('SRIN-1162')
    expect(a.platforms.map((p) => p.name)).toEqual(['PS4', 'Switch', 'Windows', 'Xbox One'])
    expect(a.tracks.length).toBe(125)
    const discs = [...new Set(a.tracks.map((t) => t.disc))]
    expect(discs).toEqual([1, 2, 3, 4, 5, 6])
    const last = a.tracks[a.tracks.length - 1]
    expect(last).toMatchObject({ disc: 6, number: 20, title: '2019 DLC Trailer', durationMs: 38_000 })
    expect(a.tracks.find((t) => t.disc === 2)!.number).toBe(1)
    expect(a.composers.slice(0, 3)).toEqual(['Ryo Watanabe', 'Mitsuhiro Kitadani', 'Keiki Kobayashi'])
    expect(a.composers.every((c) => !c.includes('*') && !c.includes('['))).toBe(true)
    expect(a.description).toContain('Music:')
  })

  it('gamerip without # column, OGG format, developer + publisher', () => {
    const a = parseAlbumPage(fx('album-a-bird-story-gamerip.html'), 'a-bird-story-linux-macos-windows-gamerip-2014')
    expect(a.title).toBe('A Bird Story')
    expect(a.kind).toBe('gamerip')
    expect(a.developers).toEqual(['Freebird Games'])
    expect(a.publishers).toEqual(['Freebird Games'])
    expect(a.formats).toEqual(['mp3', 'ogg'])
    expect(a.images.length).toBe(2)
    expect(a.cover).toBe('https://lambda.vgmtreasurechest.com/soundtracks/a-bird-story-linux-macos-windows-gamerip-2014/cover.jpg')
    expect(a.tracks.length).toBe(46)
    expect(a.tracks.slice(0, 3).map((t) => t.number)).toEqual([1, 2, 3])
    expect(a.tracks[0]).toMatchObject({ title: 'A Bird Story (Piano)', durationMs: 203_000 })
    expect(a.tracks[0].files.map((f) => f.format)).toEqual(['mp3', 'ogg'])
  })

  it('OST with N/A catalog number and "Music by" credit', () => {
    const a = parseAlbumPage(fx('album-hollow-knight.html'), 'hollow-knight-original-soundtrack')
    expect(a.title).toBe('Hollow Knight')
    expect(a.altTitles).toEqual(['Hollow Knight (Original Soundtrack)'])
    expect(a.titleOriginal).toBeNull()
    expect(a.catalogNo).toBeNull()
    expect(a.year).toBe(2017)
    expect(a.composers).toEqual(['Christopher Larkin'])
    expect(a.tracks.length).toBe(26)
    expect(a.addedAt).toBe(Date.UTC(2020, 0, 2))
  })

  it('missing album → not_found', () => {
    try {
      parseAlbumPage(fx('album-not-found.html'), 'nope')
      expect.unreachable()
    } catch (e) {
      expect(isNetError(e, 'not_found')).toBe(true)
    }
  })

  it('a block page is not mistaken for an album', () => {
    expect(() => parseAlbumPage(fx('cloudflare-block.html'), 'x')).toThrow(/\[parse\]/)
  })
})

describe('khinsider: track pages', () => {
  it('mp3 + flac links with sizes', () => {
    const files = parseTrackPage(fx('track-brink-of-time-01.html'))
    expect(files).toEqual([
      { format: 'mp3', url: 'https://nu.vgmtreasurechest.com/soundtracks/chrono-trigger-arranged-version-the-brink-of-time-1995/axiyvfqo/01%20-%20Chrono%20Trigger.mp3', sizeBytes: Math.round(11.98 * 1048576) },
      { format: 'flac', url: 'https://nu.vgmtreasurechest.com/soundtracks/chrono-trigger-arranged-version-the-brink-of-time-1995/axiyvfqo/01%20-%20Chrono%20Trigger.flac', sizeBytes: Math.round(42.9 * 1048576) }
    ])
  })

  it('mp3 + ogg', () => {
    const files = parseTrackPage(fx('track-a-bird-story.html'))
    expect(files.map((f) => f.format)).toEqual(['mp3', 'ogg'])
    expect(files[1].url).toMatch(/^https:\/\/lambda\.vgmtreasurechest\.com\/.+\.ogg$/)
  })

  it('a page without links is a parse error', () => {
    expect(() => parseTrackPage(fx('album-not-found.html'))).toThrow()
  })
})

describe('khinsider: block detection', () => {
  it('detects the Cloudflare block page', () => {
    const h = new Headers({ server: 'cloudflare', 'content-type': 'text/html' })
    expect(detectBlock(403, h, fx('cloudflare-block.html'))).toBe(true)
    expect(detectBlock(200, h, fx('album-hollow-knight.html'))).toBe(false)
    expect(detectBlock(200, new Headers({ 'cf-mitigated': 'challenge' }), '')).toBe(true)
    expect(detectBlock(403, new Headers(), '<html><title>Just a moment...</title>')).toBe(true)
  })
})

describe('khinsider: composer heuristics', () => {
  it('handles common credit lines', () => {
    expect(extractComposers('Music by Christopher Larkin\nViola: Timothy Cheel')).toEqual(['Christopher Larkin'])
    expect(extractComposers('Composer: Yasunori Mitsuda, Nobuo Uematsu & Noriko Matsueda')).toEqual(['Yasunori Mitsuda', 'Nobuo Uematsu', 'Noriko Matsueda'])
    expect(extractComposers('Composed by Koji Kondo')).toEqual(['Koji Kondo'])
    expect(extractComposers('作曲：光田康典')).toEqual(['光田康典'])
    expect(extractComposers('Music:\nRyo Watanabe* (1.01,3.01~02)\nKeiki Kobayashi (1.03~10)\n\nArrange:\nX')).toEqual(['Ryo Watanabe', 'Keiki Kobayashi'])
    expect(extractComposers('Music Director: Someone\nMusic Production Services: Studio')).toEqual([])
    expect(extractComposers(null)).toEqual([])
  })
})

describe('khinsider: provider with a fake HTTP client', () => {
  const pages: Record<string, string> = {
    'https://downloads.khinsider.com/game-soundtracks/browse/A': fx('browse-A.html'),
    'https://downloads.khinsider.com/game-soundtracks/album/hollow-knight-original-soundtrack': fx('album-hollow-knight.html'),
    'https://downloads.khinsider.com/game-soundtracks/album/chrono-trigger-arranged-version-the-brink-of-time-1995/01%2520-%2520Chrono%2520Trigger.mp3': fx('track-brink-of-time-01.html')
  }
  const http = {
    pageFetch: async (url: string) => {
      const html = pages[url]
      if (!html) throw new Error(`unexpected ${url}`)
      return { url, status: 200, html, fromCache: false, stale: false, fetchedAt: 0 }
    },
    fetchBytes: async () => {
      throw new Error('no')
    },
    limiter: () => {
      throw new Error('no')
    },
    blockedUntil: () => 0,
    invalidate: async () => {}
  }
  const kh = new KhinsiderProvider(http as never)

  it('index sections cover # and every letter plus latest', () => {
    const keys = kh.indexSections().map((s) => s.key)
    expect(keys).toContain('letter:0-9')
    expect(keys).toContain('letter:Z')
    expect(keys[0]).toBe('latest')
    expect(keys.length).toBe(28)
  })

  it('fetchIndexPage / getAlbum / resolveStream', async () => {
    const page = await kh.fetchIndexPage('letter:A', 1)
    expect(page.items.length).toBe(500)
    const album = await kh.getAlbum('hollow-knight-original-soundtrack')
    expect(album.tracks.length).toBe(26)
    const streams = await kh.resolveStream('chrono-trigger-arranged-version-the-brink-of-time-1995/01%2520-%2520Chrono%2520Trigger.mp3')
    expect(streams.map((s) => s.format)).toEqual(['mp3', 'flac'])
    expect(streams[1]).toMatchObject({
      provider: 'khinsider',
      lossless: true,
      source: {
        kind: 'http',
        cacheKey: 'kh:chrono-trigger-arranged-version-the-brink-of-time-1995/01 - Chrono Trigger.flac',
        headers: { Referer: 'https://downloads.khinsider.com/' },
        formatHint: 'flac'
      }
    })
  })
})
