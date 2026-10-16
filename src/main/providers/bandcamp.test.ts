import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isNetError, NetError } from '../net/errors'
import type { HttpClient, PageResult } from '../net/http'
import {
  artUrl,
  BandcampProvider,
  canonicalUrl,
  isChallengePage,
  parseAlbumPage,
  parseBandcampUrl,
  parseLength,
  parseLocator,
  parseSearchPage,
  searchUrl,
  streamExpiry
} from './bandcamp'
import type { CanonicalTrack } from './types'

// album-hollow-knight.html: a real album page (2026-10) trimmed to <head> (which carries the
// data-tralbum JSON), session crumbs blanked. challenge.html: what bandcamp.com/search returns
// most of the time. search-hollow-knight-ost-real.html: a real results page from a time it wasn't
// challenged. search-hollow-knight.html: hand-written in the same markup, with more results.
const fx = (name: string) => readFileSync(join(__dirname, '__fixtures__', 'bandcamp', name), 'utf8')
const ALBUM = 'https://christopherlarkin.bandcamp.com/album/hollow-knight-original-soundtrack'

describe('bandcamp: helpers', () => {
  it('urls, expiry, lengths, art', () => {
    expect(searchUrl('hollow knight')).toBe('https://bandcamp.com/search?q=hollow+knight&item_type=a')
    expect(parseBandcampUrl(`${ALBUM}?from=search`)).toBe(ALBUM)
    expect(parseBandcampUrl('https://christopherlarkin.bandcamp.com/track/enter-hallownest')).toBe('https://christopherlarkin.bandcamp.com/track/enter-hallownest')
    expect(parseBandcampUrl('https://christopherlarkin.bandcamp.com/')).toBeNull()
    expect(parseBandcampUrl('https://evil.example/album/x')).toBeNull()
    expect(parseBandcampUrl('hollow knight')).toBeNull()
    expect(canonicalUrl(`${ALBUM}/?from=search&search_item_id=1`)).toBe(ALBUM)
    expect(streamExpiry('https://t4.bcbits.com/stream/x/mp3-128/1?p=0&ts=1792050430&t=abc&token=1792050430_f0e0')).toBe(1792050430000)
    expect(streamExpiry('https://t4.bcbits.com/stream/x')).toBeNull()
    expect(parseLength('26 tracks, 58 minutes')).toEqual({ tracks: 26, ms: 3_480_000 })
    expect(parseLength('12 tracks, 1 hour 4 minutes')).toEqual({ tracks: 12, ms: 3_840_000 })
    expect(artUrl(907743342)).toBe('https://f4.bcbits.com/img/a0907743342_10.jpg')
    expect(parseLocator(`${ALBUM}#3085101441`)).toEqual({ url: ALBUM, trackId: '3085101441' })
  })

  it('recognises the bot-check page and refuses to parse it', () => {
    expect(isChallengePage(fx('challenge.html'))).toBe(true)
    expect(isChallengePage(fx('album-hollow-knight.html'))).toBe(false)
    expect(() => parseSearchPage(fx('challenge.html'), 'hollow knight')).toThrow(/bot check/)
    try {
      parseSearchPage(fx('challenge.html'), 'x')
    } catch (e) {
      expect(isNetError(e, 'blocked')).toBe(true)
    }
  })
})

describe('bandcamp: album page (data-tralbum)', () => {
  const a = parseAlbumPage(fx('album-hollow-knight.html'), `${ALBUM}?from=search`)
  it('album fields', () => {
    expect(a).toMatchObject({
      provider: 'bandcamp',
      ref: ALBUM,
      title: 'Hollow Knight (Original Soundtrack)',
      year: 2017,
      composers: ['Christopher Larkin'],
      kind: 'ost',
      typeLabel: 'Bandcamp',
      cover: 'https://f4.bcbits.com/img/a0907743342_10.jpg',
      formats: ['mp3'],
      externalId: '2306704082'
    })
    expect(a.description).toMatch(/^Beneath the fading town of Dirtmouth/)
  })
  it('tracks with titles, durations and expiring mp3-128 streams', () => {
    expect(a.tracks.length).toBe(26)
    expect(a.tracks.slice(0, 3).map((t) => t.title)).toEqual(['Enter Hallownest', 'Dirtmouth', 'Crossroads'])
    expect(a.tracks[1]).toMatchObject({ number: 2, durationMs: 115_009, locator: `${ALBUM}#1199110903` })
    const s = a.tracks[0].streams![0]
    expect(s).toMatchObject({ provider: 'bandcamp', format: 'mp3', bitrateKbps: 128, lossless: false, expiresAt: 1792050430000 })
    expect(s.source).toMatchObject({ kind: 'http', cacheKey: 'bc:3085101441.mp3', formatHint: 'mp3' })
    expect(s.source.kind === 'http' && s.source.url).toMatch(/^https:\/\/t4\.bcbits\.com\/stream\/.+\/mp3-128\/3085101441\?/)
  })
  it('a page without track data is a parse error', () => {
    expect(() => parseAlbumPage('<html><head><title>x</title></head></html>', ALBUM)).toThrow(/no track data/)
  })
})

describe('bandcamp: search results', () => {
  it('a real results page', () => {
    const hits = parseSearchPage(fx('search-hollow-knight-ost-real.html'), 'Hollow Knight')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      provider: 'bandcamp',
      ref: 'https://christopherlarkin.bandcamp.com/album/hollow-knight-silksong-ost-sample',
      title: 'Hollow Knight: Silksong (OST Sample)',
      subtitle: 'Christopher Larkin',
      trackCount: 2,
      totalMs: 360_000,
      cover: 'https://f4.bcbits.com/img/a3113085259_10.jpg'
    })
  })

  it('albums only, canonical URLs, scored', () => {
    const hits = parseSearchPage(fx('search-hollow-knight.html'), 'hollow knight')
    expect(hits.map((h) => h.ref)).toEqual([
      ALBUM,
      'https://christopherlarkin.bandcamp.com/album/hollow-knight-gods-nightmares',
      'https://example-pianist.bandcamp.com/album/hollow-knight-piano-collection'
    ])
    expect(hits[0]).toMatchObject({ provider: 'bandcamp', title: 'Hollow Knight (Original Soundtrack)', subtitle: 'Christopher Larkin', trackCount: 26, totalMs: 3_480_000, cover: 'https://f4.bcbits.com/img/a0907743342_10.jpg', url: ALBUM })
    expect(hits[0].score).toBeGreaterThan(0.7)
    expect(hits[2].score).toBeLessThan(0.3) // piano collection
  })
})

function fakeHttp(pages: Record<string, string | Error>): HttpClient & { requests: string[] } {
  const requests: string[] = []
  return {
    requests,
    async pageFetch(url): Promise<PageResult> {
      requests.push(url)
      const v = pages[url]
      if (v instanceof Error) throw v
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

describe('bandcamp: provider', () => {
  const now = () => 1791963800_000
  const t: CanonicalTrack = {
    trackId: '3',
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

  it('findTrack: album search → album page → title + duration match; resolveStream returns the signed URL', async () => {
    const http = fakeHttp({ [searchUrl('Hollow Knight')]: fx('search-hollow-knight.html'), [ALBUM]: fx('album-hollow-knight.html') })
    const p = new BandcampProvider(http, { now })
    const c = await p.findTrack(t)
    expect(c[0]).toMatchObject({ provider: 'bandcamp', locator: `${ALBUM}#1199110903`, title: 'Dirtmouth' })
    expect(c[0].confidence).toBeGreaterThan(0.85)
    const [s] = await p.resolveStream(c[0].locator)
    expect(s.source).toMatchObject({ cacheKey: 'bc:1199110903.mp3' })
    expect(s.expiresAt).toBe(1792050430000)
  })

  it('findTrack offers nothing for another cut of the piece (under half or over twice its length)', async () => {
    const http = fakeHttp({ [searchUrl('Hollow Knight')]: fx('search-hollow-knight.html'), [ALBUM]: fx('album-hollow-knight.html') })
    const p = new BandcampProvider(http, { now })
    expect(await p.findTrack({ ...t, durationMs: 40_000 })).toEqual([])
    expect(await p.findTrack({ ...t, durationMs: 400_000 })).toEqual([])
  })

  it('a challenged search is `blocked` and backs off without hammering', async () => {
    const http = fakeHttp({ [searchUrl('Hollow Knight')]: fx('challenge.html'), [searchUrl('hollow knight')]: fx('challenge.html') })
    const p = new BandcampProvider(http, { now })
    await expect(p.findTrack(t)).rejects.toSatisfy((e: unknown) => isNetError(e, 'blocked'))
    await expect(p.searchExternal('hollow knight')).rejects.toSatisfy((e: unknown) => isNetError(e, 'blocked'))
    expect(http.requests.length).toBe(1)
  })

  it('searchExternal searches the name without "OST"', async () => {
    const http = fakeHttp({ [searchUrl('Hollow Knight')]: fx('search-hollow-knight.html') })
    const hits = await new BandcampProvider(http, { now }).searchExternal('Hollow Knight OST')
    expect(http.requests).toEqual([searchUrl('Hollow Knight')])
    expect(hits[0].ref).toBe(ALBUM)
  })

  it('a pasted album URL works even while search is challenged', async () => {
    const http = fakeHttp({ [ALBUM]: fx('album-hollow-knight.html') })
    const p = new BandcampProvider(http, { now })
    const [h] = await p.searchExternal(`${ALBUM}?from=search`)
    expect(h).toMatchObject({ provider: 'bandcamp', ref: ALBUM, trackCount: 26, score: 1 })
    expect((await p.getAlbum(h.ref)).tracks).toHaveLength(26)
  })
})
