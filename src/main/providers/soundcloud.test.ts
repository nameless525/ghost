import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isNetError, NetError } from '../net/errors'
import type { RunOptions, RunResult, YtDlp } from '../tools/ytdlp'
import { parseDescriptionChapters } from './chapters'
import {
  commonTitle,
  coreTokens,
  expiryFromUrl,
  fileStream,
  fixFragmentedMp4,
  formatOf,
  longUploadHit,
  makeLocator,
  numberAfter,
  parseDownloadOutput,
  parseLocator,
  parseSoundCloudUrl,
  parseUploadsRef,
  progressiveStream,
  SC_FORMAT,
  scoreTracks,
  scTrackTitle,
  setToAlbum,
  SOUNDCLOUD_ID,
  SoundCloudProvider,
  trackToAlbum,
  uploadsHits,
  uploadsRef,
  uploadsToAlbum,
  userOf,
  type ScEntry,
  type ScPlaylist,
  type ScTrack
} from './soundcloud'
import type { CanonicalTrack } from './types'
import { FORCE_REUSE_MS } from './youtube'

// Real `yt-dlp` 2026.08.19 outputs (2026-10-14): `--flat-playlist -J scsearchN:…`, an uploader's flat
// track list, `-J` of one track and of a 12-track set. Thumbnails trimmed to two sizes, descriptions
// cut, and the signed CDN URLs' Policy / Signature replaced by REDACTED.
const raw = (name: string) => readFileSync(join(__dirname, '__fixtures__', 'soundcloud', name), 'utf8')
const fx = <T>(name: string): T => JSON.parse(raw(name)) as T
const entries = (name: string) => fx<ScPlaylist>(name).entries as ScEntry[]
const password = fx<ScTrack>('track-password.json')
/** The same track as if SoundCloud still offered a progressive MP3. */
const progressive: ScTrack = {
  ...password,
  format_id: 'http_mp3_1_0',
  protocol: 'https',
  ext: 'mp3',
  acodec: 'mp3',
  abr: 128,
  filesize: 1_932_000,
  url: 'https://cf-media.sndcdn.com/X7u69wFLVac9.128.mp3?Policy=REDACTED&Signature=REDACTED&expires=1792024090'
}

function canonical(title: string, durationMs: number | null, extra: Partial<CanonicalTrack> = {}): CanonicalTrack {
  return {
    trackId: '1',
    title,
    albumTitle: 'Yu-Gi-Oh! Forbidden Memories',
    gameName: 'Yu-Gi-Oh! Forbidden Memories',
    composers: [],
    durationMs,
    disc: 1,
    number: 1,
    year: 1999,
    platforms: [],
    albumProvider: 'khinsider',
    albumRef: 'yu-gi-oh-forbidden-memories',
    locator: 'x',
    ...extra
  }
}

describe('soundcloud: urls, refs, locators', () => {
  it('pasted URLs', () => {
    expect(parseSoundCloudUrl('https://soundcloud.com/dante-mangone/sets/0101_videogames_ost')).toEqual({ set: 'dante-mangone/sets/0101_videogames_ost' })
    expect(parseSoundCloudUrl('https://m.soundcloud.com/dante-mangone/yu-gi-oh-forbidden-memories-ost-password?in=x')).toEqual({ track: 'dante-mangone/yu-gi-oh-forbidden-memories-ost-password' })
    expect(parseSoundCloudUrl('https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A1071428926')).toEqual({ track: '1071428926' })
    expect(parseSoundCloudUrl('https://api-v2.soundcloud.com/tracks/1071428926')).toEqual({ track: '1071428926' })
    expect(parseSoundCloudUrl('https://soundcloud.com/dante-mangone')).toBeNull()
    expect(parseSoundCloudUrl('https://soundcloud.com/dante-mangone/tracks')).toBeNull()
    expect(parseSoundCloudUrl('https://soundcloud.com/search/sets?q=x')).toBeNull()
    expect(parseSoundCloudUrl('https://example.com/a/b')).toBeNull()
    expect(parseSoundCloudUrl('yu-gi-oh forbidden memories')).toBeNull()
  })

  it('a malformed escape is not a SoundCloud URL (on any host); valid escapes still parse', () => {
    expect(parseSoundCloudUrl('https://soundcloud.com/%E0%A4%A/track')).toBeNull()
    expect(parseSoundCloudUrl('https://api.soundcloud.com/tracks/%E0%A4%A')).toBeNull()
    expect(parseSoundCloudUrl('https://example.com/%E0%A4%A/track')).toBeNull()
    expect(parseSoundCloudUrl('https://soundcloud.com/dante%2Dmangone/yu-gi-oh%5Fost')).toEqual({ track: 'dante-mangone/yu-gi-oh_ost' })
    expect(parseSoundCloudUrl('https://soundcloud.com/dante-mangone/sets/%30101_videogames_ost')).toEqual({ set: 'dante-mangone/sets/0101_videogames_ost' })
  })

  it('locators, uploads refs, uploaders', () => {
    expect(makeLocator('204866926', { startMs: 174_000, endMs: 315_000 })).toBe('204866926#174000-315000')
    expect(parseLocator('204866926#174000-315000')).toEqual({ id: '204866926', clipStartMs: 174_000, clipEndMs: 315_000 })
    expect(parseLocator('1071428926')).toEqual({ id: '1071428926' })
    expect(() => parseLocator('7xkM8mWC4Kk')).toThrow(/bad SoundCloud locator/)
    const ref = uploadsRef('top-kek-406300189', 'Chrono Trigger OST')
    expect(ref).toBe('uploads:top-kek-406300189:Chrono%20Trigger%20OST')
    expect(parseUploadsRef(ref)).toEqual({ user: 'top-kek-406300189', title: 'Chrono Trigger OST' })
    expect(parseUploadsRef('1071428926')).toBeNull()
    expect(userOf(password)).toBe('dante-mangone')
  })

  it('expiry from a signed URL; formats', () => {
    expect(expiryFromUrl(password.url!)).toBe(1_792_024_090_000)
    const policy = Buffer.from('{"Statement":[{"Condition":{"DateLessThan":{"AWS:EpochTime":1792017010}}}]}').toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~')
    expect(expiryFromUrl(`https://cf-media.sndcdn.com/a.128.mp3?Policy=${policy}&Signature=x`)).toBe(1_792_017_010_000)
    expect(expiryFromUrl('https://example.com/a.mp3')).toBeNull()
    expect(formatOf({ ext: 'm4a', acodec: 'mp4a.40.2' })).toBe('m4a')
    expect(formatOf({ ext: 'opus', acodec: 'opus' })).toBe('opus')
    expect(formatOf({ ext: 'mp3', acodec: 'mp3' })).toBe('mp3')
  })
})

describe('soundcloud: streams', () => {
  it('HLS-only tracks (all of SoundCloud now) have no progressive stream', () => {
    expect(password).toMatchObject({ protocol: 'm3u8_native', format_id: 'hls_aac_160k', ext: 'm4a' })
    expect(() => progressiveStream(password)).toThrow(/m3u8_native/)
    let err: unknown
    try {
      progressiveStream(password)
    } catch (e) {
      err = e
    }
    expect(isNetError(err, 'not_found')).toBe(true)
  })

  it('a progressive format streams directly: headers, expiry, clip', () => {
    const s = progressiveStream(progressive, { clipStartMs: 1000, clipEndMs: 5000 })
    expect(s).toMatchObject({ provider: SOUNDCLOUD_ID, format: 'mp3', lossless: false, bitrateKbps: 128, sizeBytes: null, expiresAt: 1_792_024_090_000 })
    expect(s.source).toMatchObject({ kind: 'http', cacheKey: 'sc:1071428926.mp3', formatHint: 'mp3', clipStartMs: 1000, clipEndMs: 5000 })
    expect(s.source.kind === 'http' && s.source.headers?.['User-Agent']).toMatch(/Mozilla/)
    // no expiry in the URL: assume 30 minutes
    expect(progressiveStream({ ...progressive, url: 'https://cf-media.sndcdn.com/a.mp3' }, {}, 1000).expiresAt).toBe(1000 + 30 * 60_000)
  })

  it('a downloaded file: the two --print lines of the run → file source', () => {
    const out = parseDownloadOutput('1071428926\thls_aac_160k\tm3u8_native\tm4a\tmp4a.40.2\t160\t120.766\n/cache/soundcloud/sc-1071428926.m4a\n')
    expect(out).toEqual({ path: '/cache/soundcloud/sc-1071428926.m4a', ext: 'm4a', acodec: 'mp4a.40.2', abr: 160 })
    expect(parseDownloadOutput('')).toBeNull()
    const s = fileStream({ path: out!.path, format: 'm4a', bitrateKbps: 160, sizeBytes: 2_439_541 }, { clipStartMs: 0, clipEndMs: 60_000 })
    expect(s).toEqual({
      provider: 'soundcloud',
      source: { kind: 'file', path: '/cache/soundcloud/sc-1071428926.m4a', formatHint: 'm4a', clipStartMs: 0, clipEndMs: 60_000 },
      format: 'm4a',
      lossless: false,
      bitrateKbps: 160,
      sizeBytes: null,
      expiresAt: null
    })
  })
})

describe('soundcloud: findTrack scoring over real search results', () => {
  it('Password: the right upload with the right length wins; extended loops sink', () => {
    const ranked = scoreTracks(entries('scsearch-ygo-ost.json'), canonical('Password', 121_000))
    expect(ranked[0]).toMatchObject({ locator: '1071428926', title: 'Yu-Gi-Oh! Forbidden Memories OST - Password' })
    expect(ranked[0].confidence).toBeGreaterThan(0.8)
    expect(ranked.filter((r) => /EXTENDED/i.test(r.title)).every((r) => r.confidence < 0.3)).toBe(true)
    // long uploads aren't single-track candidates
    expect(ranked.some((r) => r.locator === '1321792111')).toBe(false)
  })

  it('a title that doesn\'t name the game costs confidence', () => {
    const e = entries('scsearch-ygo-ost.json').find((x) => x.id === '1071428926')!
    const [named] = scoreTracks([e], canonical('Password', 121_000))
    const [other] = scoreTracks([{ ...e, id: '1', title: 'Password', genres: [] }], canonical('Password', 121_000))
    expect(other.parts.game).toBe(false)
    expect(other.confidence).toBeLessThan(named.confidence - 0.1)
    expect(coreTokens('Yu-Gi-Oh! Forbidden Memories OST')).toEqual(['yu', 'gi', 'oh', 'forbidden', 'memories'])
  })
})

describe('soundcloud: album-like hits', () => {
  const merged = (...names: string[]) => {
    const out: ScEntry[] = []
    for (const n of names) for (const e of entries(n)) if (!out.some((x) => x.id === e.id)) out.push(e)
    return out
  }

  it('one uploader\'s tracks of the game become an "uploads" album; extended-loop channels sink', () => {
    const hits = uploadsHits(merged('scsearch-ygo-ost.json', 'scsearch-ygo-full.json'), 'yu-gi-oh forbidden memories ost').sort((a, b) => b.score - a.score)
    expect(hits[0]).toMatchObject({
      provider: 'soundcloud',
      ref: 'uploads:dante-mangone:Yu-Gi-Oh!%20Forbidden%20Memories%20OST',
      title: 'Yu-Gi-Oh! Forbidden Memories OST',
      subtitle: 'DEXY',
      trackCount: 4,
      url: 'https://soundcloud.com/dante-mangone/tracks'
    })
    expect(hits[0].score).toBeGreaterThan(0.7)
    expect(hits[0].cover).toMatch(/^https:\/\/i1\.sndcdn\.com\/.+-t500x500\.jpg$/)
    const extended = hits.find((h) => h.subtitle === 'YGO! FM OST Extended')!
    expect(extended.score).toBeLessThan(0.25)
  })

  it('long uploads are albums: a full-album upload scores high, a lofi mix and another game low', () => {
    const list = entries('scsearch-hk-full.json')
    const hits = list.map((e) => longUploadHit(e, 'hollow knight ost')).filter((h) => h != null)
    expect(hits.length).toBe(list.filter((e) => (e.duration ?? 0) >= 900).length)
    const by = (title: RegExp) => hits.find((h) => title.test(h.title))!
    expect(by(/^Hollow Knight Official Soundtrack \(Full Album\)$/)).toMatchObject({ trackCount: null, totalMs: 4_056_367 })
    expect(by(/^Hollow Knight Official Soundtrack \(Full Album\)$/).score).toBeGreaterThan(0.7)
    expect(by(/lofi/).score).toBeLessThan(0.25)
    expect(by(/Transformers/).score).toBeLessThan(0.25)
    expect(longUploadHit(list.find((e) => (e.duration ?? 0) < 900)!, 'hollow knight ost')).toBeNull()
  })

  it('a sequel\'s uploads rank below the game\'s own', () => {
    const hits = uploadsHits(merged('scsearch-hk-ost.json'), 'hollow knight ost')
    const hk = hits.find((h) => h.title === 'Hollow Knight OST')!
    const silksong = hits.find((h) => h.title === 'Hollow Knight Silksong OST')!
    expect(hk.score).toBeGreaterThan(silksong.score)
  })

  it('the shared name of a group of titles', () => {
    expect(commonTitle(['[High Quality] Chrono Trigger OST 04 - Peaceful Days', '[High Quality] Chrono Trigger OST 05 - Memories of Green'])).toBe('Chrono Trigger OST')
    expect(commonTitle(['Widow - Hollow Knight Silksong OST', 'Lace - Hollow Knight Silksong OST'])).toBe('Hollow Knight Silksong OST')
    expect(commonTitle(['Battle', 'Town'])).toBeNull()
    expect(numberAfter('[High Quality] Chrono Trigger OST 04 - Peaceful Days', 'Chrono Trigger OST')).toBe(4)
    expect(numberAfter('Widow - Hollow Knight Silksong OST', 'Hollow Knight Silksong OST')).toBeNull()
    expect(scTrackTitle('[High Quality] Chrono Trigger OST 19 - Frog\'s Theme', { names: ['Chrono Trigger OST'], numbered: true })).toBe("Frog's Theme")
    expect(scTrackTitle('Yu-Gi-Oh! Forbidden Memories OST - Password', { names: ['Yu-Gi-Oh! Forbidden Memories'] })).toBe('Password')
  })
})

describe('soundcloud: albums', () => {
  it('an uploads album: the uploader\'s tracks of the game in OST order, covers left out, durations where the search had them', () => {
    const a = uploadsToAlbum('uploads:top-kek-406300189:Chrono%20Trigger%20OST', 'top-kek-406300189', 'Chrono Trigger OST', entries('user-tracks-topkek.json'), entries('scsearch-ct-ost.json'))
    expect(a).toMatchObject({ provider: 'soundcloud', title: 'Chrono Trigger OST', typeLabel: 'SoundCloud uploads', kind: 'ost' })
    expect(a.tracks.slice(0, 4).map((t) => [t.number, t.title])).toEqual([
      [4, 'Peaceful Days'],
      [5, 'Memories of Green'],
      [6, 'Guardia Millenial Fair'],
      [7, "Gato's Song"]
    ])
    expect(a.tracks.map((t) => t.title)).toContain("Frog's Theme")
    expect(a.tracks.some((t) => /cover|für boris|mega ?man/i.test(t.title))).toBe(false)
    const numbers = a.tracks.map((t) => t.number)
    expect(numbers).toEqual([...numbers].sort((x, y) => x - y))
    expect(a.tracks[0]).toMatchObject({ locator: '314586281', durationMs: 168_832, files: [{ format: 'm4a', sizeBytes: null }] })
    expect(a.tracks[1].durationMs).toBeNull()
    expect(a.cover).toMatch(/t500x500\.jpg$/)
  })

  it('one HLS track → a single-track album without ready streams', () => {
    const a = trackToAlbum(password, '1071428926')
    expect(a).toMatchObject({ provider: 'soundcloud', ref: '1071428926', title: 'Yu-Gi-Oh! Forbidden Memories OST - Password', year: 2021, formats: ['m4a'], typeLabel: 'SoundCloud track' })
    expect(a.tracks).toEqual([{ disc: 1, number: 1, title: 'Password', durationMs: 120_766, locator: '1071428926', files: [{ format: 'm4a', sizeBytes: null }], composers: [], streams: undefined }])
  })

  it('a long upload with a timestamped track list → clipped chapters sharing one source', () => {
    const got = entries('scsearch-tracklist.json').find((e) => /Season 7/.test(e.title!))!
    const a = trackToAlbum({ ...progressive, id: got.id, title: got.title, description: got.description, duration: got.duration })
    expect(a.tracks.length).toBe(24)
    expect(a.tracks.slice(0, 2).map((t) => [t.title, t.locator, t.durationMs])).toEqual([
      ['Main Titles (Game of Thrones Theme)', `${got.id}#0-113000`, 113_000], // cleanTrackTitle drops "(… Theme)" brackets
      ['Dragonstone', `${got.id}#113000-419000`, 306_000]
    ])
    expect(a.tracks[1].streams![0].source).toMatchObject({ kind: 'http', cacheKey: `sc:${got.id}.mp3`, clipStartMs: 113_000, clipEndMs: 419_000 })
    expect(new Set(a.tracks.map((t) => (t.streams![0].source as { cacheKey: string }).cacheKey)).size).toBe(1)
  })

  it('a set → one track per entry', () => {
    const a = setToAlbum(fx<ScPlaylist>('set-dexy-12.json'), 'dante-mangone/sets/0101_videogames_ost')
    expect(a).toMatchObject({ ref: 'dante-mangone/sets/0101_videogames_ost', typeLabel: 'SoundCloud set' })
    expect(a.tracks.length).toBe(12)
    expect(a.tracks[5]).toMatchObject({ number: 6, title: 'Yu-Gi-Oh! Forbidden Memories OST - Inside the Puzzle', locator: '1071421225', durationMs: 116_578, streams: undefined })
  })
})

describe('soundcloud: track lists in descriptions (./chapters)', () => {
  it('"00:00 - 2:54 - Title" ranges', () => {
    const e = entries('scsearch-tracklist.json').find((x) => /Indie Game/.test(x.title!))!
    const ch = parseDescriptionChapters(e.description, e.duration)
    expect(ch.length).toBe(24)
    expect(ch[0]).toEqual({ startMs: 0, endMs: 174_000, title: "Maybe You'll Get Some, Maybe You Won't." })
    expect(ch.at(-1)).toEqual({ startMs: 3_928_000, endMs: 4_219_066, title: 'Sympathetic Syntax' })
  })

  it('"Title - 1:02:03", "[00:00] Title", and what isn\'t a track list', () => {
    expect(parseDescriptionChapters('Tracklist:\n[00:00] Intro\n[01:30] Town\n1:02:03 Final Boss', 4000)).toEqual([
      { startMs: 0, endMs: 90_000, title: 'Intro' },
      { startMs: 90_000, endMs: 3_723_000, title: 'Town' },
      { startMs: 3_723_000, endMs: 4_000_000, title: 'Final Boss' }
    ])
    expect(parseDescriptionChapters('Opening - 0:00\nField (1:45)', 300).map((c) => c.title)).toEqual(['Opening', 'Field'])
    expect(parseDescriptionChapters('0:00 A\n1:00 B', null)).toEqual([]) // no duration, no end
    expect(parseDescriptionChapters('Released 2010, runs 1:15:00 in total', 5000)).toEqual([])
    expect(parseDescriptionChapters('2:00 A\n3:00 B', 600)).toEqual([]) // doesn't start at the beginning
    expect(parseDescriptionChapters('0:00 A\n5:00 B\n1:00 C\n2:00 D', 600)).toEqual([]) // not one ordered list
  })
})

// A synthetic fragmented MP4 shaped like yt-dlp's HLS download of a SoundCloud track
// (ftyp, moov with zero durations + mvex/trex, then styp/sidx/moof/mdat per segment).
function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const h = Buffer.alloc(8)
  h.writeUInt32BE(8 + body.length)
  h.write(type, 4, 'latin1')
  return Buffer.concat([h, body])
}
const u32 = (...n: number[]) => {
  const b = Buffer.alloc(4 * n.length)
  n.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4))
  return b
}
const fullBox = (version: number, flags: number) => u32(((version << 24) | flags) >>> 0)
function fragmentedMp4(segments: { samples: number; durations?: number[] }[]): Buffer {
  const moov = box(
    'moov',
    box('mvhd', fullBox(0, 0), u32(0, 0, 1000, 0), Buffer.alloc(80)),
    box('trak', box('tkhd', fullBox(0, 3), u32(0, 0, 1, 0, 0), Buffer.alloc(60)), box('mdia', box('mdhd', fullBox(0, 0), u32(0, 0, 44100, 0), Buffer.alloc(4)))),
    box('mvex', box('trex', fullBox(0, 0), u32(1, 1, 1024, 0, 0)))
  )
  const segs = segments.map((seg, i) => {
    const perSample = seg.durations ? seg.durations.flatMap((d) => [d, 300]) : Array.from({ length: seg.samples }, () => 300)
    const trun = box('trun', fullBox(0, seg.durations ? 0x301 : 0x201), u32(seg.samples, 0), u32(...perSample))
    return Buffer.concat([
      box('styp', Buffer.from('msdhmsdhmsix', 'latin1')),
      box('sidx', fullBox(0, 0), u32(1, 44100, 0, 0, 0, 1, 1000, 441_000, 0)),
      box('moof', box('mfhd', fullBox(0, 0), u32(i + 1)), box('traf', box('tfhd', fullBox(0, 0x020000), u32(1)), trun)),
      box('mdat', Buffer.alloc(64))
    ])
  })
  return Buffer.concat([box('ftyp', Buffer.from('iso6\0\0\0\0iso6mp41', 'latin1')), moov, ...segs])
}

describe('soundcloud: fragmented MP4 fix-up', () => {
  it('sums the fragments into mvhd / tkhd / mdhd and turns every sidx into free, in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghost-sc-fmp4-'))
    try {
      const path = join(dir, 'sc-1.m4a')
      const durations = Array.from({ length: 100 }, () => 1000)
      const buf = fragmentedMp4([{ samples: 431 }, { samples: 431 }, { samples: 100, durations }])
      writeFileSync(path, buf)
      const total = 431 * 1024 * 2 + 100 * 1000
      expect(await fixFragmentedMp4(path)).toBe(Math.round((total * 1000) / 44100))
      const out = readFileSync(path)
      expect(out.length).toBe(buf.length)
      expect(out.includes(Buffer.from('sidx'))).toBe(false)
      const at = (type: string, offset: number) => out.readUInt32BE(out.indexOf(Buffer.from(type, 'latin1')) + 4 + offset)
      expect(at('mdhd', 4 + 4 + 4 + 4)).toBe(total) // version/flags, created, modified, timescale, duration
      expect(at('mvhd', 16)).toBe(Math.round((total * 1000) / 44100))
      expect(at('tkhd', 20)).toBe(Math.round((total * 1000) / 44100))
      // not a fragmented MP4: left alone
      writeFileSync(path, Buffer.alloc(1000))
      expect(await fixFragmentedMp4(path)).toBeNull()
      expect(readFileSync(path).equals(Buffer.alloc(1000))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** A YtDlp stand-in that answers from fixtures and records calls. */
function fakeYtDlp(answer: (args: string[]) => RunResult | Error): YtDlp & { calls: string[][] } {
  const calls: string[][] = []
  const y = {
    calls,
    async run(args: string[], _opts?: RunOptions): Promise<RunResult> {
      calls.push(args)
      await new Promise((r) => setTimeout(r, 5))
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

const ok = (stdout: string): RunResult => ({ stdout, stderr: '', code: 0 })

describe('soundcloud: provider over a fake yt-dlp', () => {
  const now = () => 1_792_017_000_000
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'ghost-sc-test-'))
    dirs.push(d)
    return d
  }

  it('searchExternal: a song search and a full-soundtrack search, merged and ranked', async () => {
    const y = fakeYtDlp((args) => {
      const target = args.at(-1)!
      if (target === 'scsearch40:yu-gi-oh forbidden memories ost') return ok(raw('scsearch-ygo-ost.json'))
      if (target === 'scsearch20:yu-gi-oh forbidden memories full soundtrack') return ok(raw('scsearch-ygo-full.json'))
      return new Error(`unexpected ${target}`)
    })
    const p = new SoundCloudProvider(async () => y, { now })
    const hits = await p.searchExternal('yu-gi-oh forbidden memories ost')
    expect(y.calls.map((c) => c.slice(0, 2))).toEqual([
      ['--flat-playlist', '-J'],
      ['--flat-playlist', '-J']
    ])
    expect(hits[0]).toMatchObject({ provider: 'soundcloud', title: 'Yu-Gi-Oh! Forbidden Memories OST', subtitle: 'DEXY' })
    expect(hits.every((h) => h.score >= 0.25)).toBe(true)
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a))
    await p.searchExternal('yu-gi-oh forbidden memories ost')
    expect(y.calls).toHaveLength(2) // cached
  })

  it('a pasted set URL imports the set (full extraction, errors skipped)', async () => {
    const y = fakeYtDlp(() => ({ stdout: raw('set-dexy-12.json'), stderr: 'ERROR: [soundcloud] 1: unavailable', code: 1 }))
    const p = new SoundCloudProvider(async () => y, { now })
    const [h] = await p.searchExternal('https://soundcloud.com/dante-mangone/sets/0101_videogames_ost')
    expect(h).toMatchObject({ ref: 'dante-mangone/sets/0101_videogames_ost', trackCount: 12, score: 1, url: 'https://soundcloud.com/dante-mangone/sets/0101_videogames_ost' })
    expect(y.calls[0]).toEqual(['-J', '--ignore-errors', '--playlist-end', '200', '-f', SC_FORMAT, 'https://soundcloud.com/dante-mangone/sets/0101_videogames_ost'])
  })

  it('getAlbum: an uploads ref reads the uploader\'s track list and a search for durations', async () => {
    const y = fakeYtDlp((args) => {
      const target = args.at(-1)!
      if (target === 'https://soundcloud.com/top-kek-406300189/tracks') return ok(raw('user-tracks-topkek.json'))
      if (target === 'scsearch50:Chrono Trigger OST') return ok(raw('scsearch-ct-ost.json'))
      return new Error(`unexpected ${target}`)
    })
    const p = new SoundCloudProvider(async () => y, { now })
    const a = await p.getAlbum('uploads:top-kek-406300189:Chrono%20Trigger%20OST')
    expect(a.tracks[0]).toMatchObject({ number: 4, title: 'Peaceful Days' })
    expect(y.calls.find((c) => c.at(-1)!.endsWith('/tracks'))).toEqual(['--flat-playlist', '-J', '--playlist-end', '2000', 'https://soundcloud.com/top-kek-406300189/tracks'])
    await expect(p.getAlbum('nope nope')).rejects.toSatisfy((e: unknown) => isNetError(e, 'parse'))
  })

  it('findTrack: one search, at most two candidates (each may become a download)', async () => {
    const y = fakeYtDlp(() => ok(raw('scsearch-ygo-ost.json')))
    const p = new SoundCloudProvider(async () => y, { now })
    expect(p.findTrackMode).toBe('fallback')
    const c = await p.findTrack(canonical('Password', 121_000))
    expect(y.calls[0]).toEqual(['--flat-playlist', '-J', 'scsearch10:Yu-Gi-Oh! Forbidden Memories Password OST'])
    expect(c.length).toBeLessThanOrEqual(2)
    expect(c[0]).toMatchObject({ provider: 'soundcloud', locator: '1071428926', durationMs: 120_766 })
  })

  it('resolveStream without a cache dir: progressive streams play, HLS-only tracks are not_found', async () => {
    const y = fakeYtDlp((args) => ok(JSON.stringify(args.at(-1)!.endsWith('/1071428926') ? password : { ...progressive, id: '42' })))
    const p = new SoundCloudProvider(async () => y, { now })
    await expect(p.resolveStream('1071428926')).rejects.toSatisfy((e: unknown) => isNetError(e, 'not_found'))
    const [s] = await p.resolveStream('42#0-60000')
    expect(s.source).toMatchObject({ kind: 'http', cacheKey: 'sc:42.mp3', clipStartMs: 0, clipEndMs: 60_000 })
    expect(y.calls[1]).toEqual(['-J', '--no-playlist', '-f', SC_FORMAT, 'https://api.soundcloud.com/tracks/42'])
    await p.resolveStream('42')
    expect(y.calls).toHaveLength(2) // memoised until shortly before the URL expires
  })

  it('resolveStream with a cache dir: one download per track, reused, shared by chapters; the cache is pruned', async () => {
    const dir = tmp()
    const y = fakeYtDlp((args) => {
      const id = /tracks\/(\d+)$/.exec(args.at(-1)!)![1]
      const template = args[args.indexOf('-o') + 1]
      const path = template.replace('%(id)s', id).replace('%(ext)s', 'm4a')
      writeFileSync(path, Buffer.alloc(id === '1' ? 3000 : 1000))
      return ok(`${id}\thls_aac_160k\tm3u8_native\tm4a\tmp4a.40.2\t160\t120.766\n${path}\n`)
    })
    const p = new SoundCloudProvider(async () => y, { now, cacheDir: dir, maxCacheBytes: 3500 })
    const [a, b] = await Promise.all([p.resolveStream('1071428926#0-60000'), p.resolveStream('1071428926#60000-120766')])
    expect(y.calls).toHaveLength(1)
    expect(y.calls[0]).toEqual(expect.arrayContaining(['--no-simulate', '--print', 'after_move:filepath', '-f', SC_FORMAT, 'https://api.soundcloud.com/tracks/1071428926']))
    const path = join(dir, 'sc-1071428926.m4a')
    expect(a[0]).toEqual({ provider: 'soundcloud', source: { kind: 'file', path, formatHint: 'm4a', clipStartMs: 0, clipEndMs: 60_000 }, format: 'm4a', lossless: false, bitrateKbps: 160, sizeBytes: null, expiresAt: null })
    expect(b[0].source).toMatchObject({ path, clipStartMs: 60_000 })
    // a new provider (app restart) finds the file and its sidecar without running yt-dlp
    const again = await new SoundCloudProvider(async () => y, { now, cacheDir: dir }).resolveStream('1071428926')
    expect(again[0]).toMatchObject({ source: { kind: 'file', path }, bitrateKbps: 160, sizeBytes: 1000 })
    expect(y.calls).toHaveLength(1)
    // over the cap: least recently used files go, never the one just downloaded
    utimesSync(path, new Date(2020, 0, 1), new Date(2020, 0, 1))
    await p.resolveStream('2')
    await p.resolveStream('1')
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(dir, 'sc-1071428926.json'))).toBe(false)
    expect(statSync(join(dir, 'sc-1.m4a')).size).toBe(3000)
  })

  it('a download reports its bytes to every caller waiting on it', async () => {
    const dir = tmp()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let report: RunOptions['onProgress']
    const y = {
      async run(args: string[], opts?: RunOptions): Promise<RunResult> {
        report = opts?.onProgress
        await gate
        const path = args[args.indexOf('-o') + 1].replace('%(id)s', '7').replace('%(ext)s', 'mp3')
        writeFileSync(path, Buffer.alloc(100))
        return ok(`7\thttp_mp3_128\thttp\tmp3\tmp3\t128\t60\n${path}\n`)
      }
    } as unknown as YtDlp
    const p = new SoundCloudProvider(async () => y, { now, cacheDir: dir })
    const a: number[] = []
    const b: [number, number | null][] = []
    const first = p.resolveStream('7', { onBytes: (n) => a.push(n) })
    const second = p.resolveStream('7#0-30000', { onBytes: (n, t) => b.push([n, t]) })
    for (let i = 0; i < 100 && !report; i++) await new Promise((r) => setTimeout(r, 5))
    report!(50, 100)
    report!(100, 100)
    release()
    await Promise.all([first, second])
    expect(a).toEqual([50, 100])
    expect(b).toEqual([
      [50, 100],
      [100, 100]
    ])
  })

  /** A yt-dlp stand-in that downloads `bytes` for each track (an mp3), or fails as `fail` says. */
  const downloader = (bytes: (id: string) => Buffer, fail?: (id: string, path: string) => Error | null) =>
    fakeYtDlp((args) => {
      const id = /tracks\/(\d+)$/.exec(args.at(-1)!)![1]
      const path = args[args.indexOf('-o') + 1].replace('%(id)s', id).replace('%(ext)s', 'mp3')
      const err = fail?.(id, path)
      if (err) return err
      writeFileSync(path, bytes(id))
      return ok(`${id}\thttp_mp3_128\thttp\tmp3\tmp3\t128\t60\n${path}\n`)
    })

  it('a forced resolve (the file failed to play) downloads the track again; chapters failing together cost one download', async () => {
    const dir = tmp()
    let t = now()
    const path = join(dir, 'sc-42.mp3')
    writeFileSync(path, 'not an audio file')
    writeFileSync(join(dir, 'sc-42.json'), JSON.stringify({ format: 'mp3', abr: 128, fixed: true }))
    const good = Buffer.alloc(500, 1)
    const y = downloader(() => good)
    const p = new SoundCloudProvider(async () => y, { now: () => t, cacheDir: dir })
    // A plain resolve hands over the cached file…
    expect((await p.resolveStream('42'))[0].source).toMatchObject({ kind: 'file', path })
    expect(y.calls).toHaveLength(0)
    // …which fails to play: the upload's chapters are resolved again, past the cache, together.
    const [a, b] = await Promise.all([p.resolveStream('42#0-30000', { force: true }), p.resolveStream('42#30000-60000', { force: true })])
    expect(y.calls).toHaveLength(1)
    expect(y.calls[0]).toContain('--force-overwrites')
    expect(readFileSync(path).equals(good)).toBe(true)
    expect(a[0].source).toMatchObject({ path, clipStartMs: 0 })
    expect(b[0].source).toMatchObject({ path, clipStartMs: 30_000 })
    // A chapter whose failure comes in a moment later gets the new file…
    t += 60_000
    await p.resolveStream('42#60000-90000', { force: true })
    expect(y.calls).toHaveLength(1)
    // …a failure later on downloads it again, and so does one after a restart.
    t += FORCE_REUSE_MS
    await p.resolveStream('42', { force: true })
    expect(y.calls).toHaveLength(2)
    await new SoundCloudProvider(async () => y, { now: () => t, cacheDir: dir }).resolveStream('42', { force: true })
    expect(y.calls).toHaveLength(3)
    expect(readdirSync(dir).sort()).toEqual(['sc-42.json', 'sc-42.mp3'])
  })

  it('what unfinished downloads leave counts toward the cap; it goes at startup and after a failure', async () => {
    const dir = tmp()
    // An earlier session's interrupted download.
    writeFileSync(join(dir, 'sc-7.m4a.part-Frag3'), Buffer.alloc(2048))
    writeFileSync(join(dir, 'sc-7.m4a.ytdl'), '{}')
    writeFileSync(join(dir, 'unrelated.txt'), 'not ours')
    const y = downloader(
      () => Buffer.alloc(64),
      (id, path) => {
        if (id !== '99') return null
        writeFileSync(`${path}.part`, Buffer.alloc(4096))
        return new NetError('timeout', 'yt-dlp timed out after 600 s')
      }
    )
    const p = new SoundCloudProvider(async () => y, { now, cacheDir: dir, maxCacheBytes: 128 })
    await expect(p.resolveStream('99')).rejects.toSatisfy((e: unknown) => isNetError(e, 'timeout'))
    expect(readdirSync(dir)).toEqual(['unrelated.txt'])
    // Left while this session runs (another process's, say): the next prune counts it, and it goes first.
    writeFileSync(join(dir, 'sc-97.mp3.part'), Buffer.alloc(4096))
    await p.resolveStream('98')
    expect(readdirSync(dir).sort()).toEqual(['sc-98.json', 'sc-98.mp3', 'unrelated.txt'])
  })

  it('a sweep never touches a download that is still running', async () => {
    const dir = tmp()
    let begun!: () => void
    const started = new Promise<void>((r) => (begun = r))
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const y = {
      async run(args: string[]): Promise<RunResult> {
        const id = /tracks\/(\d+)$/.exec(args.at(-1)!)![1]
        const path = args[args.indexOf('-o') + 1].replace('%(id)s', id).replace('%(ext)s', 'mp3')
        writeFileSync(`${path}.part`, Buffer.alloc(10))
        if (id !== '5') throw new NetError('network', 'connection reset')
        begun()
        await gate
        renameSync(`${path}.part`, path)
        return ok(`5\thttp_mp3_128\thttp\tmp3\tmp3\t128\t60\n${path}\n`)
      }
    } as unknown as YtDlp
    const p = new SoundCloudProvider(async () => y, { now, cacheDir: dir })
    const running = p.resolveStream('5')
    await started
    await expect(p.resolveStream('6')).rejects.toSatisfy((e: unknown) => isNetError(e, 'network'))
    expect(readdirSync(dir)).toEqual(['sc-5.mp3.part'])
    release()
    expect((await running)[0].source).toMatchObject({ path: join(dir, 'sc-5.mp3') })
  })

  it('a download that reports a path outside the cache dir is refused', async () => {
    const dir = tmp()
    const y = fakeYtDlp(() => ok('5\thls_aac_160k\tm3u8_native\tm4a\tmp4a.40.2\t160\t1\n/etc/passwd\n'))
    const p = new SoundCloudProvider(async () => y, { now, cacheDir: dir })
    await expect(p.resolveStream('5')).rejects.toSatisfy((e: unknown) => isNetError(e, 'parse'))
  })
})
