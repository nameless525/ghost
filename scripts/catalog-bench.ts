// Offline catalog benchmark: Browse / search / bucket / suggest / random latencies, worker start-up
// pieces, album writes and (optionally) the FTS rebuild and full re-cluster, against a COPY of a real
// catalog database. Never point it at a database an app instance has open.
//
//   npx esbuild scripts/catalog-bench.ts --bundle --platform=node --format=esm --outfile=<dir>/bench.mjs \
//     "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
//   ELECTRON_RUN_AS_NODE=1 npx electron <dir>/bench.mjs <copy-of-ghost.db> [--runs 15] [--compact] [--heavy] [--json out.json]
//
// --compact first merges the FTS segments as the app does at start-up; --heavy also times
// rebuildFts() and reclusterAll() (they rewrite the copy). Numbers are wall time
// on this thread (what a catalog-worker call costs before the RPC hop).
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowseQuery, GroupBy, SortBy } from '../src/shared/types'
import { QueryEngine } from '../src/main/catalog/query'
import { CatalogRepo } from '../src/main/catalog/repo'
import { openWorkerDb } from '../src/main/catalog/server'
import { parseAlbumPage, parseBrowsePage, parseLatestPage, parseTrackPage } from '../src/main/providers/khinsider'
import { parseAlbumPage as parseZopharAlbum, parseListingPage as parseZopharListing } from '../src/main/providers/zophar'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a))
if (!file) throw new Error('usage: bench.mjs <copy-of-ghost.db> [--runs N] [--heavy] [--json out.json]')
const flag = (k: string) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : null
}
const RUNS = Number(flag('--runs') ?? 15)
const heavy = args.includes('--heavy')
const jsonOut = flag('--json')
const FX = process.env.GHOST_FIXTURES ?? join(process.cwd(), 'src/main/providers/__fixtures__')

const results: Record<string, { first: number; p50: number; p95: number; max: number; n: number }> = {}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const r2 = (x: number) => Math.round(x * 100) / 100

function bench(name: string, fn: () => unknown, runs = RUNS): void {
  const xs: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    xs.push(performance.now() - t0)
  }
  results[name] = { first: r2(xs[0]), p50: r2(pct(xs.slice(1), 50)), p95: r2(pct(xs.slice(1), 95)), max: r2(Math.max(...xs)), n: runs }
}

async function benchAsync(name: string, fn: () => Promise<unknown>, runs = RUNS): Promise<void> {
  const xs: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    xs.push(performance.now() - t0)
  }
  results[name] = { first: r2(xs[0]), p50: r2(pct(xs.slice(1), 50)), p95: r2(pct(xs.slice(1), 95)), max: r2(Math.max(...xs)), n: runs }
}

const t0 = performance.now()
const db = openWorkerDb(file)
const tOpen = performance.now() - t0
const t1 = performance.now()
const repo = new CatalogRepo(db)
const tRepo = performance.now() - t1
const order = ['local', 'chip', 'bandcamp', 'khinsider', 'zophar', 'modland', 'archive', 'youtube', 'soundcloud']
const qe = new QueryEngine(repo, () => 'lossless', { bucketStaleMs: 15_000, sourceOrder: () => order })
const startup: Record<string, number> = { openMs: r2(tOpen), repoMs: r2(tRepo) }
if (args.includes('--compact')) {
  // What the app does once at start-up (service.upgradeIndexes): merge the FTS segments.
  const t = performance.now()
  const r = repo as unknown as { compactFts?: (p: () => Promise<void>) => Promise<number> }
  const steps = r.compactFts ? await r.compactFts(async () => {}) : 0
  startup.compactMs = r2(performance.now() - t)
  startup.compactSteps = steps
}
{
  const t = performance.now()
  qe.browse({ text: '', group: 'game', sort: 'title', offset: 0, limit: 60 })
  startup.firstBrowseMs = r2(performance.now() - t)
  // The first clustering write after start-up (an album opening, a crawl page): it used to load
  // every game key into memory first.
  const some = repo.get<{ id: number }>(`SELECT id FROM albums WHERE gone = 0 ORDER BY id DESC LIMIT 1`)!.id
  db.exec('SAVEPOINT first')
  const t2 = performance.now()
  repo.assignGames([some])
  startup.firstAssignGamesMs = r2(performance.now() - t2)
  db.exec('ROLLBACK TO first')
  db.exec('RELEASE first')
  const h = process.memoryUsage().heapUsed
  startup.heapMB = r2(h / 1048576)
}

const q = (text: string, group: GroupBy = 'game', sort: SortBy = 'title', offset = 0, limit = 60): BrowseQuery => ({ text, group, sort, offset, limit })

// Unfiltered browse in every sort.
for (const sort of ['title', 'year', 'recent', 'length', 'intensity', 'random'] as SortBy[]) {
  bench(`browse game '' ${sort}`, () => qe.browse(q('', 'game', sort)))
  bench(`browse album '' ${sort}`, () => qe.browse(q('', 'album', sort)))
}
bench(`browse game '' title @40000`, () => qe.browse(q('', 'game', 'title', 40_000)))

// Searches: whole words, initialisms, short terms, CJK, filters, soft terms, many matches.
const SEARCHES = [
  'final fantasy',
  'zelda',
  'mario',
  'pokemon',
  'ff7',
  'kh2',
  'botw',
  'chrono trigger ost',
  'mother 3',
  'sonic 2',
  'yugioh',
  'megaman',
  'battle',
  'the',
  'ys',
  'a',
  'クロノ',
  'platform=snes',
  'mario year<2000',
  'composer=uematsu',
  'kingdom hearts -remix',
  'source=zophar castlevania'
]
for (const text of SEARCHES) {
  bench(`search game "${text}"`, () => qe.browse(q(text)))
  bench(`search album "${text}"`, () => qe.browse(q(text, 'album')))
}
// The renderer browses on every keystroke.
const typing = ['f', 'fi', 'fin', 'fina', 'final', 'final ', 'final f', 'final fa', 'final fan', 'final fant', 'final fanta', 'final fantas', 'final fantasy']
bench(`typing "final fantasy" (13 browses)`, () => {
  for (const t of typing) qe.browse(q(t))
}, 5)

// Bucket groupings: cold (cache cleared through a fresh engine), then cached.
for (const group of ['platform', 'year', 'composer', 'franchise'] as GroupBy[]) {
  bench(`bucket ${group} cold`, () => new QueryEngine(repo, () => 'lossless', { bucketStaleMs: 15_000 }).browse(q('', group)), 5)
  bench(`bucket ${group} warm`, () => qe.browse(q('', group)))
  bench(`bucket ${group} "mario" cold`, () => new QueryEngine(repo, () => 'lossless', { bucketStaleMs: 15_000 }).browse(q('mario', group)), 5)
}

// groupAlbums: the biggest game, a platform, a year, a composer.
const big = repo.get<{ id: number }>(`SELECT id FROM games ORDER BY album_count DESC LIMIT 1`)!.id
const mid = repo.get<{ id: number }>(`SELECT id FROM games WHERE album_count BETWEEN 4 AND 8 LIMIT 1`)!.id
bench(`groupAlbums biggest game`, () => qe.groupAlbums(`game:${big}`, { text: '', group: 'game', sort: 'title' }))
bench(`groupAlbums typical game`, () => qe.groupAlbums(`game:${mid}`, { text: '', group: 'game', sort: 'title' }))
bench(`groupAlbums typical game "ost"`, () => qe.groupAlbums(`game:${mid}`, { text: 'ost', group: 'game', sort: 'title' }))
bench(`groupAlbums platform snes`, () => qe.groupAlbums(`platform:nintendo-snes`, { text: '', group: 'platform', sort: 'title' }))
bench(`groupAlbums year 1995`, () => qe.groupAlbums(`year:1995`, { text: '', group: 'year', sort: 'title' }))
const comp = repo.get<{ k: string }>(`SELECT name_fold AS k FROM album_composers GROUP BY name_fold ORDER BY COUNT(*) DESC LIMIT 1`)?.k
if (comp) bench(`groupAlbums top composer`, () => qe.groupAlbums(`composer:${comp}`, { text: '', group: 'composer', sort: 'title' }))

bench(`random ''`, () => qe.random(''))
bench(`random "mario"`, () => qe.random('mario'))
bench(`suggest "kingdon hearts"`, () => qe.suggest('kingdon hearts'))
bench(`suggest "chrno triger"`, () => qe.suggest('chrno triger'))
bench(`searchTracks "battle"`, () => qe.searchTracks('battle', 50))
bench(`queryTrackIds "length<2m"`, () => qe.queryTrackIds('length<2m', 1000))
bench(`counts()`, () => repo.counts())

// Parsing (cheerio) per page.
const read = (p: string) => readFileSync(join(FX, p), 'utf8')
try {
  const browseA = read('khinsider/browse-A.html')
  const latest = read('khinsider/latest-home.html')
  const album = read('khinsider/album-ace-combat-7.html')
  const track = read('khinsider/track-brink-of-time-01.html')
  bench(`parse kh browse page (500 rows)`, () => parseBrowsePage(browseA))
  bench(`parse kh latest page`, () => parseLatestPage(latest))
  bench(`parse kh album page (ace combat 7)`, () => parseAlbumPage(album, 'ace-combat-7-skies-unknown-original-soundtrack-2019'))
  bench(`parse kh track page`, () => parseTrackPage(track))
  const zl = 'zophar/listing-snes-p1.html'
  try {
    bench(`parse zophar listing`, () => parseZopharListing(read(zl), 1))
  } catch {
    /* fixture name differs */
  }
  void parseZopharAlbum
} catch (e) {
  console.error(`parse benches skipped: ${(e as Error).message}`)
}

// Writes: an album page applied to the catalog (album open), in a transaction rolled back after.
try {
  const html = read('khinsider/album-ace-combat-7.html')
  const d = parseAlbumPage(html, 'ace-combat-7-skies-unknown-original-soundtrack-2019')
  const id = repo.albumIdByRef('khinsider', d.ref) ?? repo.get<{ id: number }>(`SELECT id FROM albums WHERE provider = 'khinsider' LIMIT 1`)!.id
  bench(`applyAlbumDetail (${d.tracks.length} tracks)`, () => {
    db.exec('SAVEPOINT bench')
    try {
      repo.applyAlbumDetail(id, d)
    } finally {
      db.exec('ROLLBACK TO bench')
      db.exec('RELEASE bench')
    }
  }, 8)
} catch (e) {
  console.error(`write bench skipped: ${(e as Error).message}`)
}

const heavyOut: Record<string, number> = {}
if (heavy) {
  let t = performance.now()
  await repo.rebuildFts(async () => {})
  heavyOut.rebuildFtsS = r2((performance.now() - t) / 1000)
  t = performance.now()
  await repo.reclusterAll(async () => {})
  heavyOut.reclusterS = r2((performance.now() - t) / 1000)
  const live = repo.get<{ n: number }>(`SELECT (page_count - freelist_count) * page_size AS n FROM pragma_page_count, pragma_freelist_count, pragma_page_size`)!.n
  heavyOut.liveMB = r2(live / 1048576)
}
{
  const live = repo.get<{ n: number }>(`SELECT (page_count - freelist_count) * page_size AS n FROM pragma_page_count, pragma_freelist_count, pragma_page_size`)!.n
  startup.liveMB = r2(live / 1048576)
}

startup.preparedStatements = (repo as unknown as { stmts: Map<string, unknown> }).stmts.size
db.close()
const size = statSync(file).size
const out = { file, sizeMB: r2(size / 1048576), startup, heavy: heavyOut, results }
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1))
console.log(`startup ${JSON.stringify(startup)} heavy ${JSON.stringify(heavyOut)} size ${out.sizeMB} MB`)
const w = Math.max(...Object.keys(results).map((k) => k.length))
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(w)}  first ${String(v.first).padStart(8)}  p50 ${String(v.p50).padStart(8)}  p95 ${String(v.p95).padStart(8)} ms`)
