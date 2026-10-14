// Real end-to-end smoke test for the catalog against downloads.khinsider.com.
// Crawls ONE letter page, fetches ONE album page, resolves ONE track's audio URLs, and exercises
// the ghost-art:// protocol. Everything lands in a temp userData dir.
//
//   npx esbuild scripts/catalog-smoke.ts --bundle --platform=node --format=esm --external:electron \
//     --outfile=/tmp/ghost-smoke/smoke.mjs \
//     "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
//   npx electron /tmp/ghost-smoke/smoke.mjs
import { app, nativeImage, net } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { createCatalogService } from '../src/main/catalog/service'
import { openDb } from '../src/main/db'
import { artAccent, handleArtProtocol, registerArtScheme } from '../src/main/net/art-protocol'
import { defaultSettings } from '../src/shared/defaults'
import type { CatalogStatus } from '../src/shared/types'

const tmp = process.env.GHOST_SMOKE_DIR || mkdtempSync(join(tmpdir(), 'ghost-smoke-'))
app.setPath('userData', tmp)
registerArtScheme()

const letter = process.env.GHOST_SMOKE_LETTER || 'A'
const query = process.env.GHOST_SMOKE_QUERY || 'bird story'

function solidPng(r: number, g: number, b: number, size = 4): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function until(cond: () => Promise<boolean>, ms: number): Promise<void> {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function main(): Promise<void> {
  handleArtProtocol()
  const out: Record<string, unknown> = { tmp }

  // nativeImage.toBitmap() byte order (accent extraction assumes BGRA).
  const bmp = nativeImage.createFromBuffer(solidPng(255, 0, 0)).toBitmap()
  out.bitmapOrder = bmp[2] === 255 && bmp[0] === 0 ? 'bgra' : bmp[0] === 255 ? 'rgba' : `unknown ${[...bmp.subarray(0, 4)]}`

  const db = openDb(join(tmp, 'ghost.db'))
  const settings = defaultSettings(join(tmp, 'downloads'))
  const statuses: CatalogStatus[] = []
  const svc = createCatalogService(
    { db, broadcast: ((_e: string, p: CatalogStatus) => statuses.push(p)) as never, getSettings: () => settings },
    { crawlSections: [`letter:${letter}`], crawlMaxPagesPerSection: 1, startDelayMs: 0, crawlPageDelayMs: 0 }
  )

  // 1. Crawl one letter page.
  let t0 = Date.now()
  svc.start()
  await until(async () => {
    const s = await svc.status()
    return s.albums > 0 && !s.indexing
  }, 120_000)
  const st = await svc.status()
  out.crawl = { letter, ms: Date.now() - t0, albums: st.albums, games: st.games, statusEvents: statuses.length, lastMessage: statuses.at(-1)?.message ?? null }

  // 2. Browse + fetch one album page.
  const page = await svc.browse({ text: query, group: 'game', sort: 'title', offset: 0, limit: 10 })
  out.browse = page.groups.map((g) => `${g.title} [${g.subtitle}] albums=${g.albumCount} cover=${g.cover ? 'yes' : 'no'}`)
  const albums = await svc.groupAlbums(page.groups[0].key, { text: query, group: 'game', sort: 'title' })
  t0 = Date.now()
  const detail = await svc.album(albums[0].id)
  out.album = {
    ms: Date.now() - t0,
    title: detail.album.title,
    kind: detail.album.kind,
    year: detail.album.year,
    platforms: detail.album.platforms,
    formats: detail.album.formats,
    composers: detail.album.composers,
    cover: detail.album.cover,
    tracks: detail.tracks.length,
    first: detail.tracks.slice(0, 3).map((t) => `${t.disc}-${t.number} ${t.title} (${Math.round((t.durationMs ?? 0) / 1000)}s) ${t.source?.format}`)
  }

  // 3. Resolve one track.
  t0 = Date.now()
  const sources = await svc.resolveSources(detail.tracks[0].id, { quality: 'lossless' })
  out.resolve = { ms: Date.now() - t0, sources: sources.map((s) => ({ format: s.format, kbps: s.bitrateKbps, source: s.source })) }

  // 4. The audio CDN answers Range requests.
  const first = sources[0]?.source
  if (first?.kind === 'http') {
    const r = await net.fetch(first.url, { headers: { Range: 'bytes=0-1023', Referer: first.headers?.Referer ?? '' } })
    out.audioRange = { status: r.status, contentRange: r.headers.get('content-range'), bytes: (await r.arrayBuffer()).byteLength }
  }

  // 5. ghost-art:// protocol (fetch, cache, CORS) + accent colour.
  if (detail.album.cover) {
    const artUrl = `ghost-art://img/?u=${encodeURIComponent(detail.album.cover)}`
    t0 = Date.now()
    const a1 = await net.fetch(artUrl)
    const b1 = (await a1.arrayBuffer()).byteLength
    const ms1 = Date.now() - t0
    t0 = Date.now()
    const a2 = await net.fetch(artUrl)
    const b2 = (await a2.arrayBuffer()).byteLength
    out.art = {
      status: a1.status,
      type: a1.headers.get('content-type'),
      cors: a1.headers.get('access-control-allow-origin'),
      cache: a1.headers.get('cache-control'),
      bytes: b1,
      firstMs: ms1,
      cachedMs: Date.now() - t0,
      cachedBytes: b2,
      accent: await artAccent(detail.album.cover)
    }
    const small = await net.fetch(`${artUrl}&w=128`)
    out.artResized = { status: small.status, bytes: (await small.arrayBuffer()).byteLength }
  }
  await new Promise((r) => setTimeout(r, 300))
  out.gameAfterArt = await svc.game(detail.game!.id)

  // 6. Search syntax over the crawled page.
  out.search = {
    'kind=gamerip year<2000': (await svc.browse({ text: 'kind=gamerip year<2000', group: 'game', sort: 'year', offset: 0, limit: 3 })).groups.map((g) => g.title),
    'platform=snes': (await svc.browse({ text: 'platform=snes', group: 'game', sort: 'title', offset: 0, limit: 3 })).total
  }

  svc.stop()
  console.log('\n===== GHOST catalog smoke =====\n' + JSON.stringify(out, null, 2))
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((e) => {
    console.error('SMOKE FAILED:', e)
    app.exit(1)
  })
