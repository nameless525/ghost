// Real end-to-end smoke test for the external sources (YouTube via yt-dlp, Internet Archive,
// Bandcamp). Makes sure yt-dlp is available (downloading the official release if needed), runs
// searchExternal, imports the top YouTube playlist into a temp catalog DB, resolves streams and
// checks them with HTTP Range requests. Everything lands in a temp userData dir
// (GHOST_SMOKE_DIR reuses one, so yt-dlp isn't downloaded twice).
//
//   npx esbuild scripts/smoke/sources-smoke.ts --bundle --platform=node --format=esm --external:electron \
//     --outfile=/tmp/ghost-smoke/sources-smoke.mjs \
//     "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
//   npx electron /tmp/ghost-smoke/sources-smoke.mjs
import { app } from 'electron'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatalogRepo } from '../../src/main/catalog/repo'
import { createCatalogService } from '../../src/main/catalog/service'
import { openDb } from '../../src/main/db'
import { sharedYtDlp } from '../../src/main/tools/ytdlp'
import { defaultSettings } from '../../src/shared/defaults'
import type { ExternalAlbumHit } from '../../src/shared/types'
import type { ResolvedSource } from '../../src/main/catalog'

const tmp = process.env.GHOST_SMOKE_DIR || mkdtempSync(join(tmpdir(), 'ghost-sources-smoke-'))
mkdirSync(tmp, { recursive: true })
app.setPath('userData', tmp)
const query = process.env.GHOST_SMOKE_QUERY || 'Hollow Knight OST'
const BANDCAMP_URL = process.env.GHOST_SMOKE_BANDCAMP || 'https://christopherlarkin.bandcamp.com/album/hollow-knight-original-soundtrack'
const CHAPTER_VIDEO = process.env.GHOST_SMOKE_VIDEO || 'https://www.youtube.com/watch?v=CbaFAQbCkdc'

async function rangeCheck(s: ResolvedSource): Promise<Record<string, unknown>> {
  if (s.source.kind !== 'http') return { kind: s.source.kind }
  const t0 = Date.now()
  const res = await fetch(s.source.url, { headers: { ...(s.source.headers ?? {}), Range: 'bytes=0-65535' }, redirect: 'follow' })
  const body = Buffer.from(await res.arrayBuffer())
  return {
    host: new URL(s.source.url).host,
    finalHost: new URL(res.url).host,
    status: res.status,
    contentRange: res.headers.get('content-range'),
    contentType: res.headers.get('content-type'),
    bytes: body.length,
    ms: Date.now() - t0
  }
}

const brief = (h: ExternalAlbumHit) => ({ provider: h.provider, score: h.score, title: h.title, by: h.subtitle, tracks: h.trackCount, mins: h.totalMs ? Math.round(h.totalMs / 60000) : null, ref: h.ref })

async function main(): Promise<void> {
  const out: Record<string, unknown> = { tmp }

  // 1. yt-dlp
  let t0 = Date.now()
  const y = await sharedYtDlp()
  const bin = await y.ensure()
  out.ytdlp = { ...bin, ms: Date.now() - t0 }

  const db = openDb(join(tmp, 'ghost.db'))
  const settings = defaultSettings(join(tmp, 'downloads'))
  const svc = createCatalogService({ db, broadcast: (() => {}) as never, getSettings: () => settings }, { disableEnrichment: true, disableLocalScan: true })

  // 2. searchExternal
  t0 = Date.now()
  const hits = await svc.searchExternal(query)
  out.search = { query, ms: Date.now() - t0, count: hits.length, byProvider: Object.fromEntries(['youtube', 'archive', 'bandcamp'].map((p) => [p, hits.filter((h) => h.provider === p).length])), top: hits.slice(0, 12).map(brief) }
  try {
    await svc.searchExternal(query, ['bandcamp'])
    out.bandcampSearch = 'ok'
  } catch (e) {
    out.bandcampSearch = (e as Error).message
  }

  // 3. import the top YouTube playlist, resolve a track, Range-check it
  const pl = hits.find((h) => h.provider === 'youtube' && h.url.includes('playlist?list='))
  if (!pl) throw new Error('no YouTube playlist hit')
  t0 = Date.now()
  const imported = await svc.importExternal(pl)
  out.youtubeImport = {
    ms: Date.now() - t0,
    album: imported.album.title,
    game: imported.game?.name,
    tracks: imported.tracks.length,
    first: imported.tracks.slice(0, 5).map((t) => `${t.number}. ${t.title} (${t.durationMs ? Math.round(t.durationMs / 1000) : '?'} s)`)
  }
  const ytTrack = imported.tracks[Math.min(1, imported.tracks.length - 1)]
  t0 = Date.now()
  const ytSources = await svc.resolveSources(ytTrack.id)
  out.youtubeResolve = { track: ytTrack.title, ms: Date.now() - t0, sources: ytSources.map((s) => ({ provider: s.provider, format: s.format, kbps: s.bitrateKbps, cacheKey: s.source.kind === 'http' ? s.source.cacheKey : null })), range: await rangeCheck(ytSources[0]) }
  const browse = await svc.browse({ text: imported.game?.name ?? 'hollow knight', group: 'game', sort: 'title', offset: 0, limit: 5 })
  out.browseAfterImport = browse.groups.map((g) => `${g.title} (${g.albumCount} album${g.albumCount === 1 ? '' : 's'})`)

  // 4. a chaptered full-OST video → clipped tracks
  t0 = Date.now()
  const [vh] = await svc.searchExternal(CHAPTER_VIDEO, ['youtube'])
  const vid = await svc.importExternal(vh)
  const chapterSources = await svc.resolveSources(vid.tracks[Math.min(1, vid.tracks.length - 1)].id)
  const cs = chapterSources[0]?.source
  out.chapters = { ms: Date.now() - t0, video: vh.title, tracks: vid.tracks.length, sample: vid.tracks.slice(0, 4).map((t) => t.title), clip: cs && cs.kind === 'http' ? { cacheKey: cs.cacheKey, clipStartMs: cs.clipStartMs, clipEndMs: cs.clipEndMs } : null }

  // 5. Internet Archive: import the top item, resolve a file, Range-check it
  const ia = hits.find((h) => h.provider === 'archive')
  if (ia) {
    t0 = Date.now()
    const a = await svc.importExternal(ia)
    const iaSources = await svc.resolveSources(a.tracks[0].id)
    out.archive = { ms: Date.now() - t0, item: ia.ref, tracks: a.tracks.length, track: a.tracks[0].title, sources: iaSources.map((s) => `${s.format}${s.lossless ? ' (lossless)' : ''}`), url: iaSources[0].source.kind === 'http' ? iaSources[0].source.url : null, range: await rangeCheck(iaSources[0]) }
  }

  // 6. Bandcamp via a pasted album URL
  try {
    t0 = Date.now()
    const [bh] = await svc.searchExternal(BANDCAMP_URL, ['bandcamp'])
    const b = await svc.importExternal(bh)
    const bs = await svc.resolveSources(b.tracks[0].id)
    out.bandcamp = { ms: Date.now() - t0, album: b.album.title, tracks: b.tracks.length, track: b.tracks[0].title, range: await rangeCheck(bs[0]) }
  } catch (e) {
    out.bandcamp = { error: (e as Error).message }
  }

  // 7. Resolver fallback with real searches: a KHInsider track whose page doesn't exist.
  {
    const repo = new CatalogRepo(db)
    const hit = { provider: 'khinsider', ref: 'ghost-smoke-missing-album', title: 'Hollow Knight', titleFromRef: false, platforms: [], kind: 'ost' as const, typeLabel: null, year: 2017, thumb: null, cover: null, catalogNo: null, addedAt: null }
    const [albumId] = repo.upsertHits([hit], { initial: false })
    repo.applyAlbumDetail(albumId, {
      ...hit,
      altTitles: [],
      titleOriginal: null,
      developers: [],
      publishers: [],
      composers: ['Christopher Larkin'],
      images: [],
      description: null,
      formats: ['mp3'],
      totalSizes: {},
      externalId: null,
      tracks: [{ disc: 1, number: 6, title: 'Hornet', durationMs: 167_000, locator: 'ghost-smoke-missing-album/06%2520Hornet.mp3', files: [{ format: 'mp3', sizeBytes: null }], composers: [] }]
    })
    const trackId = String(repo.get<{ id: number }>(`SELECT id FROM tracks WHERE album_id = ?`, albumId)!.id)
    const fb: Record<string, unknown> = {}
    t0 = Date.now()
    const first = await svc.resolveSources(trackId)
    fb.defaultOrder = { ms: Date.now() - t0, sources: first.map((s) => `${s.provider}:${s.format}@${s.confidence}`) }
    settings.sources.disabled = ['archive', 'bandcamp']
    t0 = Date.now()
    const yt = await svc.resolveSources(trackId)
    fb.youtubeOnly = { ms: Date.now() - t0, sources: yt.map((s) => `${s.provider}:${s.source.kind === 'http' ? s.source.cacheKey : ''}@${s.confidence}`), range: yt[0] ? await rangeCheck(yt[0]) : null }
    t0 = Date.now()
    await svc.resolveSources(trackId)
    fb.cachedRepeatMs = Date.now() - t0
    settings.sources.disabled = []
    out.fallback = fb
  }

  out.status = await svc.status()
  console.log(JSON.stringify(out, null, 2))
}

app.whenReady().then(() =>
  main()
    .then(() => app.exit(0))
    .catch((e) => {
      console.error('SMOKE FAILED:', e)
      app.exit(1)
    })
)
