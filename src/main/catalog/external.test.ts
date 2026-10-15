// External sources end-to-end over fixtures: searchExternal fan-out, importExternal into an
// in-memory catalog (game matching, FTS, sources stored up front, chapter clips), and the
// resolver's fallback to search providers only when an album's own sources failed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { CatalogStatus, ExternalAlbumHit, Settings } from '../../shared/types'
import { NetError } from '../net/errors'
import { ProviderRegistry } from '../providers'
import { ArchiveProvider } from '../providers/archive'
import type { Provider, StreamInfo } from '../providers/types'
import { YouTubeProvider, type YtVideo } from '../providers/youtube'
import type { RunResult, YtDlp } from '../tools/ytdlp'
import { CatalogRepo } from './repo'
import { createCatalogService, guessGameName } from './service'
import { memoryDb, seedSmall } from './testing'

const FX = join(__dirname, '../providers/__fixtures__')
const read = (p: string) => readFileSync(join(FX, p), 'utf8')
const NOW = 1791963800_000 // when the YouTube fixtures were captured (their URLs expire ~6 h later)

function fakeYtDlp(): YtDlp & { calls: string[][] } {
  const hornet = JSON.parse(read('youtube/video-hornet.json')) as YtVideo
  const full = JSON.parse(read('youtube/video-full-ost.json')) as YtVideo
  const calls: string[][] = []
  let runs = 0
  const run = async (args: string[]): Promise<RunResult> => {
    calls.push(args)
    const target = args.at(-1)!
    if (args[0] === '-j') {
      // Every extraction hands out a new URL (as googlevideo does); the first one is the fixture's.
      const n = runs++
      const fresh = (v: YtVideo) => (n ? { ...v, url: `${v.url}&run=${n}` } : v)
      const ids = args.filter((a) => a.startsWith('https://www.youtube.com/watch?v=')).map((a) => a.slice(-11))
      return { stdout: ids.map((id) => JSON.stringify(fresh(id === full.id ? full : { ...hornet, id }))).join('\n'), stderr: '', code: 0 }
    }
    if (target.startsWith('https://www.youtube.com/results')) return { stdout: read('youtube/ytplaylists-hollow-knight.json'), stderr: '', code: 0 }
    if (target.startsWith('ytsearch12:')) return { stdout: read('youtube/ytsearch-full-ost.json'), stderr: '', code: 0 }
    if (target.startsWith('ytsearch10:')) return { stdout: read('youtube/ytsearch-dirtmouth.json'), stderr: '', code: 0 }
    if (target.includes('playlist?list=')) return { stdout: read('youtube/ytplaylist-amellifera.json'), stderr: '', code: 0 }
    throw new NetError('not_found', `no fixture for ${target}`)
  }
  const y = { calls, run, json: async (args: string[]) => JSON.parse((await y.run(args)).stdout) }
  return y as unknown as YtDlp & { calls: string[][] }
}

const extractions = (y: { calls: string[][] }) => y.calls.filter((c) => c[0] === '-j').length

function fakeFetch(): typeof fetch & { urls: string[] } {
  const urls: string[] = []
  const f = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    if (url.startsWith('https://archive.org/advancedsearch.php')) return new Response(read('archive/search-hollow-knight.json'))
    if (url === 'https://archive.org/metadata/hollow-knight-ost') return new Response(read('archive/metadata-hollow-knight-ost.json'))
    if (url.startsWith('https://archive.org/metadata/')) return new Response(JSON.stringify({ metadata: {}, files: [] }))
    return new Response('nope', { status: 404 })
  }) as typeof fetch & { urls: string[] }
  f.urls = urls
  return f
}

/** KHInsider stand-in: resolves every locator to one mp3, or fails on demand. */
function fakeKh(): Provider & { fail: boolean; calls: number } {
  return {
    id: 'khinsider',
    name: 'KHInsider',
    fail: false,
    calls: 0,
    async resolveStream(locator: string): Promise<StreamInfo[]> {
      this.calls++
      if (this.fail) throw new NetError('http', 'HTTP 500 from downloads.khinsider.com')
      return [{ provider: 'khinsider', source: { kind: 'http', url: `https://kh.example/${locator}`, cacheKey: `kh:${locator}` }, format: 'mp3', lossless: false, bitrateKbps: 320, sizeBytes: null, expiresAt: null }]
    }
  }
}

function setup(opts: { seed?: boolean } = {}) {
  const clock = { now: NOW }
  const now = () => clock.now
  const settings: Settings = defaultSettings('/tmp/ghost-dl')
  const db = memoryDb()
  const repo = new CatalogRepo(db)
  if (opts.seed !== false) seedSmall(repo)
  const ytdlp = fakeYtDlp()
  const fetchImpl = fakeFetch()
  const kh = fakeKh()
  const registry = new ProviderRegistry()
    .register(kh)
    .register(new ArchiveProvider({ fetch: fetchImpl, now }))
    .register(new YouTubeProvider(async () => ytdlp, { now }))
  const statuses: CatalogStatus[] = []
  const svc = createCatalogService(
    { db, broadcast: ((_e: string, p: CatalogStatus) => statuses.push(p)) as never, getSettings: () => settings },
    { registry, disableEnrichment: true, disableLocalScan: true, now, log: () => {} }
  )
  return { settings, db, repo, svc, ytdlp, fetchImpl, kh, statuses, clock }
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('external search', () => {
  it('fans out to enabled providers in parallel, merges and ranks by score', async () => {
    const { svc, ytdlp, fetchImpl } = setup()
    const hits = await svc.searchExternal('Hollow Knight OST')
    expect(new Set(hits.map((h) => h.provider))).toEqual(new Set(['youtube', 'archive']))
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a))
    expect(hits.length).toBeLessThanOrEqual(40)
    expect(ytdlp.calls.length).toBe(2)
    expect(fetchImpl.urls.length).toBe(1)
    const top = hits.slice(0, 6).map((h) => `${h.provider}:${h.ref}`)
    expect(top).toContain('archive:hollow-knight-ost')
  })

  it('a provider subset, disabled providers, and one provider failing', async () => {
    const { svc, settings, ytdlp } = setup()
    expect(new Set((await svc.searchExternal('Hollow Knight OST', ['archive'])).map((h) => h.provider))).toEqual(new Set(['archive']))
    expect(ytdlp.calls.length).toBe(0)
    settings.sources.disabled = ['youtube']
    expect((await svc.searchExternal('Hollow Knight OST')).every((h) => h.provider === 'archive')).toBe(true)
    settings.sources.disabled = []
    ;(ytdlp as unknown as { run: () => Promise<never> }).run = async () => {
      throw new NetError('network', 'offline')
    }
    expect((await svc.searchExternal('Hollow Knight OST')).every((h) => h.provider === 'archive')).toBe(true)
    settings.sources.disabled = ['archive']
    await expect(svc.searchExternal('Hollow Knight OST')).rejects.toThrow(/offline/)
    expect(await svc.searchExternal('   ')).toEqual([])
  })
})

describe('external import', () => {
  const playlistHit: ExternalAlbumHit = {
    provider: 'youtube',
    ref: 'PLmOldskd2VbKCFNaN2kRCGbFVZaKPpeZ-',
    title: 'Hollow Knight OST - Playlist',
    subtitle: 'Amellifera',
    cover: 'https://i.ytimg.com/vi/243Uguc-6mQ/hqdefault.jpg',
    trackCount: null,
    totalMs: null,
    url: 'https://www.youtube.com/playlist?list=PLmOldskd2VbKCFNaN2kRCGbFVZaKPpeZ-',
    score: 0.9
  }

  it('a YouTube playlist joins the existing game, shows up in browse + FTS, bumps the revision', async () => {
    const { svc, repo, statuses } = setup()
    const before = await svc.browse({ text: 'hollow knight', group: 'game', sort: 'title', offset: 0, limit: 10 })
    const hkBefore = before.groups.find((g) => g.title === 'Hollow Knight')!
    const rev = (await svc.status()).revision!
    const d = await svc.importExternal(playlistHit)
    expect(d.album).toMatchObject({ provider: 'youtube', providerRef: playlistHit.ref, title: 'Hollow Knight OST - Playlist', trackCount: 26, kind: 'ost', formats: ['m4a'] })
    expect(d.album.addedAt).toBe(NOW)
    expect(d.game?.id).toBe(hkBefore.gameId)
    expect(d.game?.name).toBe('Hollow Knight')
    expect(d.tracks).toHaveLength(26)
    expect(d.tracks[1]).toMatchObject({ title: 'Dirtmouth', durationMs: 116_000, gameName: 'Hollow Knight', source: { provider: 'youtube', format: 'm4a' } })
    expect((await svc.status()).revision!).toBeGreaterThan(rev)
    await until(() => statuses.length > 0)
    // browse: same game, one more album; the noisy playlist title didn't rename the game
    const after = await svc.browse({ text: 'hollow knight', group: 'game', sort: 'title', offset: 0, limit: 10 })
    const hk = after.groups.find((g) => g.gameId === hkBefore.gameId)!
    expect(hk.title).toBe('Hollow Knight')
    expect(hk.albumCount).toBe(hkBefore.albumCount + 1)
    expect((await svc.groupAlbums(hk.key, { text: '', group: 'game', sort: 'title' })).map((a) => a.provider)).toContain('youtube')
    // FTS over track titles
    expect((await svc.searchTracks('"enter hallownest"')).map((t) => t.albumId)).toContain(d.album.id)
    expect(await svc.queryTrackIds('"queen\'s gardens"')).toContain(d.tracks.find((t) => t.title === "Queen's Gardens")!.id)
    // survives a full re-cluster
    await repo.reclusterAll(async () => {})
    expect((await svc.album(d.album.id)).game?.id).toBe(hkBefore.gameId)
    // importing again updates in place
    const again = await svc.importExternal(playlistHit)
    expect(again.album.id).toBe(d.album.id)
    expect(again.tracks.map((t) => t.id)).toEqual(d.tracks.map((t) => t.id))
  })

  it('an Internet Archive item stores its streams at import: playing needs no further requests', async () => {
    const { svc, fetchImpl } = setup()
    const d = await svc.importExternal(
      { provider: 'archive', ref: 'hollow-knight-ost', title: 'Hollow Knight OST', subtitle: 'Christopher Larkin', cover: null, trackCount: null, totalMs: null, url: 'https://archive.org/details/hollow-knight-ost', score: 0.9 },
      { gameName: 'Hollow Knight' }
    )
    expect(d.tracks).toHaveLength(28)
    expect(d.album.formats).toEqual(['flac', 'mp3'])
    expect(d.tracks[0].source).toMatchObject({ provider: 'archive', format: 'flac', lossless: true })
    const n = fetchImpl.urls.length
    const list = await svc.resolveSources(d.tracks[1].id, { quality: 'lossless' })
    expect(fetchImpl.urls.length).toBe(n)
    expect(list.map((s) => `${s.provider}:${s.format}`)).toEqual(['archive:flac', 'archive:mp3'])
    expect(list[0].source).toMatchObject({ kind: 'http', url: 'https://archive.org/download/hollow-knight-ost/02.%20Dirtmouth.flac', cacheKey: 'ia:hollow-knight-ost/02. Dirtmouth.flac' })
    expect((await svc.resolveSources(d.tracks[1].id, { quality: 'high' }))[0].format).toBe('mp3')
  })

  it('a full-OST video with chapters: one track per chapter, clipped sources sharing one cache key', async () => {
    const { svc, ytdlp } = setup({ seed: false })
    const d = await svc.importExternal(
      { provider: 'youtube', ref: 'CbaFAQbCkdc', title: 'Hollow Knight Full OST - Original Soundtrack Complete Edition, Includes All DLC Music + Extra Tracks', subtitle: 'That Music Guy', cover: null, trackCount: 23, totalMs: 6_644_000, url: 'https://www.youtube.com/watch?v=CbaFAQbCkdc', score: 0.8 },
      {}
    )
    // a new game named from the title, not "Hollow Knight Full OST - …"
    expect(d.game?.name).toBe('Hollow Knight')
    expect(d.tracks).toHaveLength(23)
    expect(d.tracks[1]).toMatchObject({ title: 'Hive Knight', durationMs: 123_000 })
    const calls = ytdlp.calls.length
    const [s] = await svc.resolveSources(d.tracks[1].id)
    expect(ytdlp.calls.length).toBe(calls) // stored at import
    expect(s.source).toMatchObject({ kind: 'http', cacheKey: 'yt:CbaFAQbCkdc.m4a', clipStartMs: 4_065_000, clipEndMs: 4_188_000 })
    const [s2] = await svc.resolveSources(d.tracks[2].id)
    expect(s2.source).toMatchObject({ cacheKey: 'yt:CbaFAQbCkdc.m4a', clipStartMs: 4_188_000 })
  })

  it('after a 403, refreshing one chapter refreshes the whole video: one yt-dlp run, every chapter gets the new URL', async () => {
    const { svc, ytdlp, clock, db } = setup({ seed: false })
    const d = await svc.importExternal(
      { provider: 'youtube', ref: 'CbaFAQbCkdc', title: 'Hollow Knight Full OST', subtitle: null, cover: null, trackCount: 23, totalMs: 6_644_000, url: 'https://www.youtube.com/watch?v=CbaFAQbCkdc', score: 0.8 },
      {}
    )
    const [a, b, c] = d.tracks
    const [sa] = await svc.resolveSources(a.id)
    const key = (sa.source as { cacheKey: string }).cacheKey
    clock.now += 60 * 60_000 // an hour later the address changed: the stored URL is refused
    svc.markSourceFailed(a.id, key, 'stream failed: HTTP 403')
    expect((db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE needs_refresh = 1`).get() as { n: number }).n).toBe(23)
    const before = extractions(ytdlp)
    const [fa] = await svc.resolveSources(a.id, { exclude: [] })
    expect(extractions(ytdlp)).toBe(before + 1)
    const url = (fa.source as { url: string }).url
    expect(url).toContain('&run=')
    // The other chapters were refreshed with it: no further runs, same URL, their own clips.
    const [fb] = await svc.resolveSources(b.id)
    const [fc] = await svc.resolveSources(c.id)
    expect(extractions(ytdlp)).toBe(before + 1)
    expect(fb.source).toMatchObject({ url, cacheKey: key, clipStartMs: 4_065_000, clipEndMs: 4_188_000 })
    expect(fc.source).toMatchObject({ url, clipStartMs: 4_188_000 })
    expect((db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE needs_refresh = 1`).get() as { n: number }).n).toBe(0)
  })

  it('stale fallback URLs behind a healthy source refresh in the background without holding up playback', async () => {
    const { svc, ytdlp, db } = setup()
    const hk = (await svc.browse({ text: 'hollow knight', group: 'album', sort: 'title', offset: 0, limit: 10 })).groups.find((g) => g.title === 'Hollow Knight')!
    const dirtmouth = (await svc.album(hk.key.split(':')[1])).tracks.find((t) => t.title === 'Dirtmouth')!
    await svc.resolveSources(dirtmouth.id)
    // A YouTube copy found earlier, since marked for refresh (another YouTube URL got a 403).
    db.prepare(
      `INSERT INTO sources (track_id, provider, locator, cache_key, url, format, confidence, verified_at, expires_at, needs_refresh)
       VALUES (?, 'youtube', '9Vdv01LsnQM', 'yt:9Vdv01LsnQM.m4a', 'https://old.example/yt', 'm4a', 0.8, ?, ?, 1)`
    ).run(Number(dirtmouth.id), NOW, NOW + 3 * 3600_000)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const run = ytdlp.run.bind(ytdlp)
    ytdlp.run = (async (args: string[], o?: unknown) => {
      await gate
      return run(args, o as never)
    }) as typeof ytdlp.run
    const list = await svc.resolveSources(dirtmouth.id) // returns while yt-dlp is still held
    expect(list.map((s) => s.provider)).toEqual(['khinsider', 'youtube'])
    release()
    const url = () => (db.prepare(`SELECT url FROM sources WHERE provider = 'youtube' AND track_id = ?`).get(Number(dirtmouth.id)) as { url: string }).url
    await until(() => url() !== 'https://old.example/yt')
    expect(url()).toContain('googlevideo')
  })

  it('an explicit game name creates that game; unknown providers are rejected', async () => {
    const { svc } = setup()
    const d = await svc.importExternal(playlistHit, { gameName: 'Hallownest Chronicles' })
    expect(d.game?.name).toBe('Hallownest Chronicles')
    expect(d.album.gameName).toBe('Hallownest Chronicles')
    await expect(svc.importExternal({ ...playlistHit, provider: 'bandcamp' })).rejects.toThrow(/isn't supported/)
  })

  it('guesses game names from upload titles', () => {
    expect(guessGameName({ title: 'Hollow Knight OST + DLC - Playlist' })).toBe('Hollow Knight')
    expect(guessGameName({ title: 'Hollow Knight (Original Soundtrack)' })).toBe('Hollow Knight')
    expect(guessGameName({ title: 'Celeste Original Soundtrack' })).toBe('Celeste')
    expect(guessGameName({ title: 'Hollow Knight: Silksong (Original Soundtrack)' })).toBe('Hollow Knight: Silksong')
  })
})

describe('resolver fallback to search providers', () => {
  it('normal plays never search; failed or excluded album sources fall back in provider order, and cached candidates are reused', async () => {
    const { svc, kh, ytdlp, fetchImpl, settings, db, clock } = setup()
    const hk = (await svc.browse({ text: 'hollow knight', group: 'album', sort: 'title', offset: 0, limit: 10 })).groups.find((g) => g.title === 'Hollow Knight')!
    const album = await svc.album(hk.key.split(':')[1])
    const dirtmouth = album.tracks.find((t) => t.title === 'Dirtmouth')!

    // 1. KHInsider works: no search anywhere.
    const ok = await svc.resolveSources(dirtmouth.id)
    expect(ok.map((s) => s.provider)).toEqual(['khinsider'])
    expect(ytdlp.calls.length).toBe(0)
    expect(fetchImpl.urls.length).toBe(0)

    // 2. KHInsider's source failed and re-resolving it fails: Internet Archive (before YouTube in the order) steps in.
    kh.fail = true
    svc.markSourceFailed(dirtmouth.id, (ok[0].source as { cacheKey: string }).cacheKey, 'HTTP 404')
    const fb = await svc.resolveSources(dirtmouth.id)
    expect(fb[0].provider).toBe('archive')
    expect(fb[0].source).toMatchObject({ cacheKey: 'ia:hollow-knight-ost/02. Dirtmouth.flac' })
    expect(fb.at(-1)!.provider).toBe('khinsider') // still listed, demoted
    expect(ytdlp.calls.length).toBe(0) // archive was enough
    expect(fb[0].confidence).toBeLessThan(1)

    // 3. Archive disabled and the KHInsider key excluded: YouTube searches once, resolves the top candidates in one run.
    settings.sources.disabled = ['archive']
    const excl = [(ok[0].source as { cacheKey: string }).cacheKey]
    const yt = await svc.resolveSources(dirtmouth.id, { exclude: excl })
    expect(yt[0].provider).toBe('youtube')
    // The seeded Dirtmouth is 2:20, which no upload matches; the composer's own channel wins on trust.
    expect(yt.filter((s) => s.provider === 'youtube').map((s) => (s.source as { cacheKey: string }).cacheKey)).toEqual(['yt:9Vdv01LsnQM.m4a', 'yt:NSlkW1fFkyo.m4a'])
    const searches = ytdlp.calls.filter((c) => c.at(-1)!.startsWith('ytsearch10:'))
    expect(searches).toEqual([['--flat-playlist', '-J', 'ytsearch10:Hollow Knight Dirtmouth OST']])
    expect(ytdlp.calls.filter((c) => c[0] === '-j')).toHaveLength(1)

    // 4. Again: cached YouTube source, no new search or resolve.
    const n = ytdlp.calls.length
    const again = await svc.resolveSources(dirtmouth.id, { exclude: excl })
    expect(again[0].provider).toBe('youtube')
    expect(ytdlp.calls.length).toBe(n)

    // 4b. A YouTube URL refused with 403 (stale: bound to an IP this machine no longer has): every
    // stored YouTube URL is due for refresh, and re-resolving runs yt-dlp again instead of handing
    // back the memoised (stale) URL.
    clock.now += 5 * 60_000 // (an extraction under 2 minutes old would be reused)
    svc.markSourceFailed(dirtmouth.id, (again[0].source as { cacheKey: string }).cacheKey, 'stream failed: HTTP 403')
    expect((db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE provider = 'youtube' AND needs_refresh = 0`).get() as { n: number }).n).toBe(0)
    const resolvesBefore = ytdlp.calls.filter((c) => c[0] === '-j').length
    const fresh = await svc.resolveSources(dirtmouth.id, { exclude: excl })
    expect(fresh[0].provider).toBe('youtube')
    expect(ytdlp.calls.filter((c) => c[0] === '-j').length).toBe(resolvesBefore + 1)

    // 5. YouTube disabled too: nothing left, so KHInsider's error surfaces.
    settings.sources.disabled = ['archive', 'youtube']
    await expect(svc.resolveSources(dirtmouth.id, { exclude: excl })).rejects.toThrow(/HTTP 500/)
    settings.sources.disabled = []
  })
})
