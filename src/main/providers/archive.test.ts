import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isNetError } from '../net/errors'
import {
  ArchiveProvider,
  downloadUrl,
  iaAudioFormat,
  luceneWords,
  parseIaLength,
  parseIaUrl,
  parseMetadata,
  parseSearch,
  searchQuery,
  searchUrl,
  type IaMetadata,
  type IaSearchResponse
} from './archive'
import type { CanonicalTrack } from './types'

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
    expect(refs).not.toContain('official-hollow-knight-original-soundtrack-opus') // opus-only: the engine can't decode it
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
