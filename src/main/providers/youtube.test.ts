import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isNetError } from '../net/errors'
import type { RunOptions, RunResult, YtDlp } from '../tools/ytdlp'
import type { CanonicalTrack } from './types'
import {
  batchErrorFor,
  bestThumb,
  expiryFromUrl,
  FORCE_REUSE_MS,
  makeLocator,
  parseJsonLines,
  parseLocator,
  parseStream,
  parseYouTubeUrl,
  playlistHit,
  playlistSearchUrl,
  playlistToAlbum,
  scoreAlbumTitle,
  scoreEntries,
  trackQuery,
  videoHit,
  videoToAlbum,
  YouTubeProvider,
  type YtPlaylist,
  type YtVideo
} from './youtube'

// Real `yt-dlp` outputs (2026.08.19), trimmed (captions/heatmap/most formats dropped) and with the
// client IP in googlevideo URLs replaced by 0.0.0.0.
const fx = <T>(name: string): T => JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'youtube', name), 'utf8')) as T

function track(title: string, durationMs: number | null, extra: Partial<CanonicalTrack> = {}): CanonicalTrack {
  return {
    trackId: '1',
    title,
    albumTitle: 'Hollow Knight',
    gameName: 'Hollow Knight',
    composers: ['Christopher Larkin'],
    durationMs,
    disc: 1,
    number: 1,
    year: 2017,
    platforms: [],
    albumProvider: 'khinsider',
    albumRef: 'hollow-knight',
    locator: 'hollow-knight/x.mp3',
    ...extra
  }
}

describe('youtube: yt-dlp -J parsing', () => {
  it('a resolved video → m4a EngineSource with headers, bitrate and expiry', () => {
    const v = fx<YtVideo>('video-hornet.json')
    const s = parseStream(v)
    expect(s).toMatchObject({ provider: 'youtube', format: 'm4a', lossless: false, bitrateKbps: 130, sizeBytes: 2_700_832 })
    expect(s.source).toMatchObject({ kind: 'http', cacheKey: 'yt:7xkM8mWC4Kk.m4a', formatHint: 'm4a' })
    expect(s.source.kind === 'http' && s.source.url).toMatch(/^https:\/\/[^/]+\.googlevideo\.com\/videoplayback\?/)
    expect(s.source.kind === 'http' && s.source.headers?.['User-Agent']).toMatch(/Mozilla/)
    expect(s.expiresAt).toBe(1791985343 * 1000)
    expect(s.source.clipStartMs).toBeUndefined()
  })

  it('a chapter clip shares the video cacheKey and carries clip bounds', () => {
    const s = parseStream(fx<YtVideo>('video-full-ost.json'), { clipStartMs: 4_065_000, clipEndMs: 4_188_000 })
    expect(s.source).toMatchObject({ cacheKey: 'yt:CbaFAQbCkdc.m4a', clipStartMs: 4_065_000, clipEndMs: 4_188_000 })
    expect(s.sizeBytes).toBeNull()
  })

  it('opus-only and broken outputs', () => {
    const v = fx<YtVideo>('video-hornet.json')
    const opus = parseStream({ ...v, ext: 'webm', acodec: 'opus', format_id: '251' })
    expect(opus.format).toBe('opus')
    expect(opus.source).toMatchObject({ cacheKey: 'yt:7xkM8mWC4Kk.webm' })
    expect(() => parseStream({ ...v, url: undefined })).toThrow(/no stream URL/)
    expect(() => parseStream({ ...v, protocol: 'm3u8_native' })).toThrow(/m3u8_native/)
    expect(() => parseStream({ ...v, live_status: 'is_live' })).toThrow(/live/)
  })

  it('expiry, locators, URLs, thumbnails', () => {
    expect(expiryFromUrl('https://x.googlevideo.com/videoplayback?expire=1791985343&ei=x')).toBe(1791985343000)
    expect(expiryFromUrl('https://x.googlevideo.com/videoplayback/expire/1791985343/ei/x')).toBe(1791985343000)
    expect(expiryFromUrl('https://example.com/a.mp3')).toBeNull()
    expect(makeLocator('CbaFAQbCkdc', { startMs: 4065000, endMs: 4188000 })).toBe('CbaFAQbCkdc#4065000-4188000')
    expect(parseLocator('CbaFAQbCkdc#4065000-4188000')).toEqual({ id: 'CbaFAQbCkdc', clipStartMs: 4065000, clipEndMs: 4188000 })
    expect(parseLocator('7xkM8mWC4Kk')).toEqual({ id: '7xkM8mWC4Kk' })
    expect(() => parseLocator('nope')).toThrow()
    expect(parseYouTubeUrl('https://www.youtube.com/playlist?list=PLmOldskd2VbKCFNaN2kRCGbFVZaKPpeZ-')).toEqual({ playlist: 'PLmOldskd2VbKCFNaN2kRCGbFVZaKPpeZ-' })
    expect(parseYouTubeUrl('https://youtu.be/7xkM8mWC4Kk?t=3')).toEqual({ video: '7xkM8mWC4Kk' })
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=7xkM8mWC4Kk&list=RD7xkM8mWC4Kk')).toEqual({ video: '7xkM8mWC4Kk' })
    expect(parseYouTubeUrl('https://example.com/watch?v=7xkM8mWC4Kk')).toBeNull()
    expect(parseYouTubeUrl('Hollow Knight OST')).toBeNull()
    expect(playlistSearchUrl('Hollow Knight OST')).toBe('https://www.youtube.com/results?search_query=Hollow+Knight+OST&sp=EgIQAw%253D%253D')
    expect(bestThumb([{ url: 'https://a/s.jpg', width: 10, height: 10 }, { url: 'https://a/l.jpg', width: 100, height: 50 }])).toBe('https://a/l.jpg')
    expect(bestThumb([], 'abcdefghijk')).toBe('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg')
  })

  it('batch output: JSON lines by id, per-id errors', () => {
    const v = fx<YtVideo>('video-hornet.json')
    const out = `${JSON.stringify(v)}\n${JSON.stringify({ ...v, id: 'aaaaaaaaaaa' })}\n`
    expect([...parseJsonLines(out).keys()]).toEqual(['7xkM8mWC4Kk', 'aaaaaaaaaaa'])
    const stderr = 'ERROR: [youtube] bbbbbbbbbbb: Video unavailable. This video is private\nERROR: [youtube] ccccccccccc: Sign in to confirm you’re not a bot'
    expect(batchErrorFor(stderr, 'bbbbbbbbbbb')).toMatch(/Video unavailable/)
    expect(batchErrorFor(stderr, '7xkM8mWC4Kk')).toBeNull()
  })
})

describe('youtube: findTrack scoring over real search results', () => {
  it('query is "<game> <title> OST"', () => {
    expect(trackQuery(track('Dirtmouth', 115_000))).toBe('Hollow Knight Dirtmouth OST')
    expect(trackQuery(track('Hollow Knight', 97_000))).toBe('Hollow Knight OST')
    expect(trackQuery(track('Prelude', null, { gameName: null, albumTitle: 'Final Fantasy VI Original Sound Version' }))).toBe('Final Fantasy VI Prelude OST')
  })

  it('Dirtmouth: the clean upload with the right length wins; 1-hour / 10-hour / ambience uploads sink', () => {
    const entries = fx<YtPlaylist>('ytsearch-dirtmouth.json').entries!
    const ranked = scoreEntries(entries, track('Dirtmouth', 115_000))
    expect(ranked[0]).toMatchObject({ locator: 'NSlkW1fFkyo', title: 'Hollow Knight OST - Dirtmouth' })
    expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.8)
    const byId = new Map(ranked.map((r) => [r.locator, r]))
    for (const id of ['xZWZRu50Nfc', 'Cz5xwU2H4VU', 'hKsG2vnZeQo', 'htMUbQMsdQQ', 'gz1JCVNP7Gk']) {
      expect(byId.get(id)!.confidence, id).toBeLessThan(0.6)
      expect(byId.get(id)!.parts.penalties.length, id).toBeGreaterThan(0)
    }
    // Composer's own (verified) upload with the wrong length: trusted, but the duration doesn't fit.
    expect(byId.get('9Vdv01LsnQM')!.parts.trust).toBe(0.9)
    expect(byId.get('9Vdv01LsnQM')!.parts.duration).toBe(0)
  })

  it('Hornet: same-named arrangements and medleys lose to the original', () => {
    const ranked = scoreEntries(fx<YtPlaylist>('ytsearch-hornet.json').entries!, track('Hornet', 167_000))
    expect(ranked[0].locator).toBe('7xkM8mWC4Kk')
    const quartet = ranked.find((r) => r.locator === 'G_iO5IHnBTE')!
    expect(quartet.parts.penalties).toEqual(['piano', 'orchestral'])
    expect(quartet.confidence).toBeLessThan(0.4)
    const medley = ranked.find((r) => r.locator === 'KJ4ZS14hs-M')!
    expect(medley.confidence).toBeLessThan(ranked[0].confidence - 0.3)
  })

  it('without a known duration, title + channel decide', () => {
    const ranked = scoreEntries(fx<YtPlaylist>('ytsearch-dirtmouth.json').entries!, track('Dirtmouth', null))
    expect(ranked[0].parts.title).toBe(1)
    expect(ranked[0].parts.penalties).toEqual([])
  })
})

describe('youtube: album search + import', () => {
  it('playlist search: complete OST playlists rank above 1-hour / piano / other-game playlists', () => {
    const entries = fx<YtPlaylist>('ytplaylists-hollow-knight.json').entries!
    const hits = entries.map((e) => playlistHit(e, 'Hollow Knight OST')!).sort((a, b) => b.score - a.score)
    const top = hits.slice(0, 6).map((h) => h.title)
    expect(top).toContain('Hollow Knight OST - Playlist')
    expect(top).toContain('Hollow Knight (Original Soundtrack)')
    const score = (t: string) => hits.find((h) => h.title === t)!.score
    expect(score('Hollow Knight OST - Playlist')).toBeGreaterThan(score('Hollow Knight - OST 1 hour'))
    expect(score('Hollow Knight OST - Playlist')).toBeGreaterThan(score('Hollow Knight - Piano Tutorials'))
    expect(score('Hollow Knight OST - Playlist')).toBeGreaterThan(score('Silksong OST'))
    expect(score('Hollow Knight OST - Playlist')).toBeGreaterThan(score('Hollow Knight Boss Themes'))
    // a gameplay-stream playlist that merely carries the game's name
    expect(score('Hollow Knight OST - Playlist')).toBeGreaterThan(score('Hollow Knight') + 0.2)
    expect(score('Hollow Knight OST: 1 hour collection')).toBeLessThan(0.5)
    expect(hits[0]).toMatchObject({ provider: 'youtube', url: expect.stringMatching(/^https:\/\/www\.youtube\.com\/playlist\?list=PL/) })
    expect(hits[0].cover).toMatch(/^https:\/\/i\.ytimg\.com\//)
  })

  it('video search: only long uploads count as albums, full-OST titles score high', () => {
    const entries = fx<YtPlaylist>('ytsearch-full-ost.json').entries!
    const hits = entries.map((e) => videoHit(e, 'Hollow Knight OST')).filter((h) => h != null)
    expect(hits.length).toBe(entries.filter((e) => (e.duration ?? 0) >= 900).length)
    const best = hits.sort((a, b) => b.score - a.score)[0]
    expect(best.title).toMatch(/Hollow Knight/)
    expect(best.totalMs).toBeGreaterThan(3_600_000)
    expect(videoHit({ id: '7xkM8mWC4Kk', title: 'Hollow Knight OST - Hornet', duration: 167 }, 'Hollow Knight OST')).toBeNull()
    expect(scoreAlbumTitle('Hollow Knight • Relaxing Music with Ambiance (Rain, Fire, Night, Snow)', 'Hollow Knight OST', { kind: 'video' })).toBeLessThan(
      scoreAlbumTitle('Hollow Knight Full OST', 'Hollow Knight OST', { kind: 'video' })
    )
  })

  it('a playlist becomes an album with cleaned track titles', () => {
    const a = playlistToAlbum(fx<YtPlaylist>('ytplaylist-amellifera.json'))
    expect(a).toMatchObject({ provider: 'youtube', ref: 'PLmOldskd2VbKCFNaN2kRCGbFVZaKPpeZ-', title: 'Hollow Knight OST - Playlist', kind: 'ost', typeLabel: 'YouTube playlist', formats: ['m4a'] })
    expect(a.tracks.length).toBe(26)
    expect(a.tracks.slice(0, 4).map((t) => t.title)).toEqual(['Enter Hallownest', 'Dirtmouth', 'Crossroads', 'False Knight'])
    expect(a.tracks.map((t) => t.title)).toContain("Queen's Gardens")
    expect(a.tracks.at(-1)!.title).toBe('Hollow Knight')
    expect(a.tracks[1]).toMatchObject({ number: 2, durationMs: 116_000, locator: 'NSlkW1fFkyo', files: [{ format: 'm4a', sizeBytes: null }] })
    expect(a.tracks[0].streams).toBeUndefined()
    expect(a.cover).toMatch(/^https:\/\//)
  })

  it('a full-OST video with chapters becomes one clipped track per chapter', () => {
    const v = fx<YtVideo>('video-full-ost.json')
    const a = videoToAlbum(v)
    expect(a.tracks.length).toBe(v.chapters!.length)
    expect(a.tracks[0]).toMatchObject({ title: 'Part 1', durationMs: 4_065_000, locator: 'CbaFAQbCkdc#0-4065000' })
    expect(a.tracks[1]).toMatchObject({ title: 'Hive Knight', durationMs: 123_000, locator: 'CbaFAQbCkdc#4065000-4188000' })
    const s = a.tracks[1].streams![0]
    expect(s.source).toMatchObject({ kind: 'http', cacheKey: 'yt:CbaFAQbCkdc.m4a', clipStartMs: 4_065_000, clipEndMs: 4_188_000 })
    // every chapter shares the one cache key
    expect(new Set(a.tracks.map((t) => (t.streams![0].source as { cacheKey: string }).cacheKey)).size).toBe(1)
  })

  it('a video without chapters is a single track', () => {
    const v = fx<YtVideo>('video-hornet.json')
    const a = videoToAlbum(v)
    expect(a.tracks).toHaveLength(1)
    expect(a.tracks[0]).toMatchObject({ title: 'Hornet', locator: '7xkM8mWC4Kk', durationMs: 167_000 })
    expect(a.tracks[0].streams![0].source.clipStartMs).toBeUndefined()
  })
})

/** A YtDlp stand-in that answers from fixtures and records calls. */
function fakeYtDlp(answer: (args: string[]) => RunResult | Error): YtDlp & { calls: string[][] } {
  const calls: string[][] = []
  const y = {
    calls,
    async run(args: string[], _opts?: RunOptions): Promise<RunResult> {
      calls.push(args)
      const r = answer(args)
      if (r instanceof Error) throw r
      return r
    },
    async json<T>(args: string[], opts?: RunOptions): Promise<T> {
      return JSON.parse((await y.run(args, opts)).stdout) as T
    }
  }
  return y as unknown as YtDlp & { calls: string[][] }
}

describe('youtube: provider over a fake yt-dlp', () => {
  const hornet = fx<YtVideo>('video-hornet.json')
  const full = fx<YtVideo>('video-full-ost.json')
  const now = () => 1791963800_000

  it('resolveStream batches concurrent ids into one run and memoises until expiry', async () => {
    const y = fakeYtDlp((args) => {
      const ids = args.filter((a) => a.startsWith('https://www.youtube.com/watch?v=')).map((a) => a.slice(-11))
      const out = ids.filter((id) => id !== 'zzzzzzzzzzz').map((id) => JSON.stringify(id === full.id ? full : { ...hornet, id }))
      return { stdout: out.join('\n'), stderr: ids.includes('zzzzzzzzzzz') ? 'ERROR: [youtube] zzzzzzzzzzz: Sign in to confirm you’re not a bot' : '', code: ids.includes('zzzzzzzzzzz') ? 1 : 0 }
    })
    const p = new YouTubeProvider(async () => y, { now })
    const [a, b, c, d] = await Promise.allSettled([
      p.resolveStream('7xkM8mWC4Kk'),
      p.resolveStream('CbaFAQbCkdc#4065000-4188000'),
      p.resolveStream('CbaFAQbCkdc#4188000-4307000'),
      p.resolveStream('zzzzzzzzzzz')
    ])
    expect(y.calls).toHaveLength(1)
    expect(y.calls[0]).toEqual(expect.arrayContaining(['-j', '--no-playlist', '--ignore-errors', '-f']))
    expect(a.status === 'fulfilled' && a.value[0].source).toMatchObject({ cacheKey: 'yt:7xkM8mWC4Kk.m4a' })
    expect(b.status === 'fulfilled' && b.value[0].source).toMatchObject({ cacheKey: 'yt:CbaFAQbCkdc.m4a', clipStartMs: 4065000, clipEndMs: 4188000 })
    expect(c.status === 'fulfilled' && c.value[0].source).toMatchObject({ clipStartMs: 4188000 })
    // sign-in walls are `blocked` — skipped, never worked around
    expect(d.status).toBe('rejected')
    expect(isNetError(d.status === 'rejected' ? d.reason : null, 'blocked')).toBe(true)
    // memoised
    await p.resolveStream('7xkM8mWC4Kk')
    expect(y.calls).toHaveLength(1)
  })

  it('a batched resolve is handed over when its own line is printed, the most urgent first', async () => {
    // A warm-up (background) and a track someone waits for, batched into one run: the wanted one
    // goes first and resolves while the warm-up is still being extracted.
    let finish!: () => void
    const rest = new Promise<void>((r) => (finish = r))
    const calls: string[][] = []
    const y = {
      async run(args: string[], opts?: RunOptions): Promise<RunResult> {
        calls.push(args)
        const lines = args.filter((a) => a.startsWith('https://www.youtube.com/watch?v=')).map((a) => JSON.stringify({ ...hornet, id: a.slice(-11) }))
        opts?.onLine?.(lines[0])
        await rest
        for (const l of lines.slice(1)) opts?.onLine?.(l)
        return { stdout: lines.join('\n'), stderr: '', code: 0 }
      }
    } as unknown as YtDlp
    const p = new YouTubeProvider(async () => y, { now })
    const warm = p.resolveStream('aaaaaaaaaaa', { priority: 2 })
    const wanted = await p.resolveStream('7xkM8mWC4Kk', { priority: 0 })
    expect(wanted[0].source).toMatchObject({ cacheKey: 'yt:7xkM8mWC4Kk.m4a' })
    expect(calls).toHaveLength(1)
    expect(calls[0].filter((a) => a.startsWith('https://')).map((a) => a.slice(-11))).toEqual(['7xkM8mWC4Kk', 'aaaaaaaaaaa'])
    finish()
    expect((await warm)[0].source).toMatchObject({ cacheKey: 'yt:aaaaaaaaaaa.m4a' })
  })

  it('a forced resolve reuses an extraction under two minutes old (chapters of one video refresh with one run)', async () => {
    let t = now()
    const y = fakeYtDlp((args) => {
      const ids = args.filter((a) => a.startsWith('https://www.youtube.com/watch?v=')).map((a) => a.slice(-11))
      return { stdout: ids.map((id) => JSON.stringify(id === full.id ? full : { ...hornet, id })).join('\n'), stderr: '', code: 0 }
    })
    const p = new YouTubeProvider(async () => y, { now: () => t })
    await p.resolveStream('CbaFAQbCkdc#4065000-4188000')
    expect(y.calls).toHaveLength(1)
    t += 30 * 60_000
    // A stored URL failed: the first forced resolve extracts again…
    await p.resolveStream('CbaFAQbCkdc#4065000-4188000', { force: true })
    expect(y.calls).toHaveLength(2)
    // …and the video's other chapters, refreshed right after, reuse that extraction.
    t += 60_000
    await Promise.all([p.resolveStream('CbaFAQbCkdc#4188000-4307000', { force: true }), p.resolveStream('CbaFAQbCkdc#0-120000', { force: true })])
    expect(y.calls).toHaveLength(2)
    // Two minutes on, forcing extracts again.
    t += FORCE_REUSE_MS
    await p.resolveStream('CbaFAQbCkdc#4188000-4307000', { force: true })
    expect(y.calls).toHaveLength(3)
  })

  it('findTrack runs one flat search and returns scored candidates', async () => {
    const y = fakeYtDlp((args) => ({ stdout: readFileSync(join(__dirname, '__fixtures__', 'youtube', 'ytsearch-dirtmouth.json'), 'utf8'), stderr: '', code: 0 }))
    const p = new YouTubeProvider(async () => y, { now })
    const c = await p.findTrack(track('Dirtmouth', 115_000))
    expect(y.calls[0]).toEqual(['--flat-playlist', '-J', 'ytsearch10:Hollow Knight Dirtmouth OST'])
    expect(c[0]).toMatchObject({ provider: 'youtube', locator: 'NSlkW1fFkyo' })
    expect(c.every((x) => x.confidence >= 0.3)).toBe(true)
    await p.findTrack(track('Dirtmouth', 115_000))
    expect(y.calls).toHaveLength(1) // cached
  })

  it('searchExternal merges playlist and video searches; getAlbum imports a playlist', async () => {
    const y = fakeYtDlp((args) => {
      const target = args.at(-1)!
      const file = target.startsWith('https://www.youtube.com/results') ? 'ytplaylists-hollow-knight.json' : target.startsWith('ytsearch') ? 'ytsearch-full-ost.json' : 'ytplaylist-amellifera.json'
      return { stdout: readFileSync(join(__dirname, '__fixtures__', 'youtube', file), 'utf8'), stderr: '', code: 0 }
    })
    const p = new YouTubeProvider(async () => y, { now })
    const hits = await p.searchExternal('Hollow Knight OST')
    expect(hits.length).toBeGreaterThan(8)
    expect(hits.some((h) => h.url.includes('playlist?list='))).toBe(true)
    expect(hits.some((h) => h.url.includes('watch?v='))).toBe(true)
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a))
    expect(y.calls.map((c) => c.at(-1))).toEqual(['https://www.youtube.com/results?search_query=Hollow+Knight+OST&sp=EgIQAw%253D%253D', 'ytsearch12:Hollow Knight full OST'])
    const album = await p.getAlbum('PLmOldskd2VbKCFNaN2kRCGbFVZaKPpeZ-')
    expect(album.tracks).toHaveLength(26)
    expect(y.calls.at(-1)).toEqual(['--flat-playlist', '-J', 'https://www.youtube.com/playlist?list=PLmOldskd2VbKCFNaN2kRCGbFVZaKPpeZ-'])
  })
})
