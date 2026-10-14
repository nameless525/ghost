// CatalogService: the catalog DB, the KHInsider index crawl, lazy album pages, source resolution,
// enrichment and analysis storage, external search/import (YouTube, Internet Archive, Bandcamp) and
// the local-files scan, behind the CatalogAPI contract (src/shared/api.ts).

import { parseSearch } from '../../shared/search'
import type { AlbumDetail, BrowsePage, BrowseQuery, CatalogStatus, ExternalAlbumHit, Game, ID, TrackView } from '../../shared/types'
import { isNetError, NetError } from '../net/errors'
import type { HttpClient } from '../net/http'
import { createDefaultRegistry, type ProviderRegistry } from '../providers'
import { CHIP_ID, ChipProvider } from '../providers/chip'
import { LocalProvider } from '../providers/local'
import { isIndexProvider, type IndexProvider, type ProviderAlbum } from '../providers/types'
import type { YtDlp } from '../tools/ytdlp'
import { ChipIndexer, type ChipIndexerDeps } from './chip'
import { Crawler } from './crawler'
import { AccentWorker, Enricher } from './enrich'
import type { CatalogDeps, CatalogService } from './index'
import { QueryEngine, reseedRandom } from './query'
import { baseTitle } from './normalize'
import { CatalogRepo, writerPause } from './repo'
import { CLUSTER_VERSION } from './schema'
import { SourceResolver } from './resolver'

const DETAIL_TTL_MS = 7 * 24 * 3600_000
const ART_QUEUE_MAX = 60
const EXTERNAL_SEARCH_TIMEOUT_MS = 60_000
const EXTERNAL_HITS_MAX = 40
const LOCAL_FOLDERS_POLL_MS = 4000

/** Test / smoke-script seams. Production uses the defaults. */
export interface CatalogInternals {
  http?: HttpClient
  registry?: ProviderRegistry
  /** fetch for IGDB / SteamGridDB (plain JSON APIs). */
  fetchJson?: typeof fetch
  /** Accent colour for an image URL (default: decode via Electron nativeImage from the art cache). */
  accentOf?: (url: string, bytes?: Buffer) => Promise<string | null>
  /**
   * Subscribe to newly fetched art (default: the ghost-art protocol). Listeners get the bytes, or the
   * accent itself when the art pipeline already computed it (the worker gets just the URL).
   */
  onArtFetched?: (fn: (url: string, bytes?: Buffer, accent?: string | null) => void) => () => void
  /** Trim the art cache a minute after start (default: the ghost-art protocol's; skipped when accentOf is given). */
  trimArtCache?: () => Promise<unknown>
  /** Serve stale bucket aggregations (platform/year/composer/franchise) for this long after the data changed. */
  bucketStaleMs?: number
  now?: () => number
  /** Delay before the startup crawl begins (ms). */
  startDelayMs?: number
  crawlPageDelayMs?: number
  crawlSections?: string[]
  crawlMaxPagesPerSection?: number
  /** Don't run IGDB/SGDB/accent background work. */
  disableEnrichment?: boolean
  /** yt-dlp for the YouTube provider (default: the shared managed instance). */
  ytdlp?: () => Promise<YtDlp>
  /** fetch for archive.org's JSON APIs. */
  sourceFetch?: typeof fetch
  /** Don't scan settings.sources.localFolders. */
  disableLocalScan?: boolean
  /** Chiptune rip index (joshw.info / vgmrips.net): `false` = never crawl; otherwise options. */
  chip?: false | Pick<ChipIndexerDeps, 'hosts' | 'vgmrips' | 'maxPages' | 'pageDelayMs' | 'pages'>
  log?: (msg: string) => void
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NetError('timeout', `${what} took longer than ${Math.round(ms / 1000)} s`)), ms)
    })
  ])
}

// Main-process defaults (Electron net / the ghost-art protocol), loaded lazily so the catalog worker's
// bundle never pulls in Electron: the worker always passes its own transports.
const artProtocol = () => import('../net/art-protocol')

function defaultOnArtFetched(fn: (url: string, bytes?: Buffer, accent?: string | null) => void): () => void {
  let off: (() => void) | null = null
  let dead = false
  void artProtocol()
    .then((m) => {
      if (!dead) off = m.onArtAccent((url, hex) => fn(url, undefined, hex))
    })
    .catch(() => {})
  return () => {
    dead = true
    off?.()
  }
}

/** The process-wide HTTP client of the main process (net/shared), loaded on first use. */
function lazySharedHttp(): HttpClient {
  let loaded: HttpClient | null = null
  let p: Promise<HttpClient> | null = null
  const get = () => (p ??= import('../net/shared').then((m) => (loaded = m.sharedHttp())))
  return {
    pageFetch: async (url, opts) => (await get()).pageFetch(url, opts),
    fetchBytes: async (url, opts) => (await get()).fetchBytes(url, opts),
    invalidate: async (url) => (await get()).invalidate(url),
    limiter: (host) => {
      if (!loaded) throw new Error('HTTP client not loaded yet')
      return loaded.limiter(host)
    },
    blockedUntil: (host) => loaded?.blockedUntil(host) ?? 0
  }
}

/** The game an imported album belongs to, when the user didn't say: its title minus OST decoration. */
export function guessGameName(album: Pick<ProviderAlbum, 'title'>, hit?: Pick<ExternalAlbumHit, 'title'>): string {
  for (const t of [album.title, hit?.title]) {
    if (!t) continue
    const b = baseTitle(t)
      .replace(/\s*[-–—|:~]\s*(?:playlist|full|complete|all\s+tracks?|album|official)\b.*$/i, '')
      .replace(/\s*\+\s*(?:dlc|extras?|bonus).*$/i, '')
      .replace(/\s+(?:full|complete|entire|whole|official)\s*$/i, '')
      .trim()
    if (b && /[\p{L}\p{N}]/u.test(b)) return b
  }
  return album.title
}

export function createCatalogService(deps: CatalogDeps, internals: CatalogInternals = {}): CatalogService {
  const now = internals.now ?? Date.now
  const log = internals.log ?? ((m: string) => console.log(`[catalog] ${m}`))
  const repo = new CatalogRepo(deps.db, now)
  let registry: ProviderRegistry | null = internals.registry ?? null
  const getRegistry = () =>
    (registry ??= createDefaultRegistry(internals.http ?? lazySharedHttp(), {
      db: deps.db,
      ytdlp: internals.ytdlp,
      fetch: internals.sourceFetch,
      inspectArchive: deps.inspectArchive,
      log: (m) => log(`sources: ${m}`)
    }))
  const quality = () => deps.getSettings().sources.quality
  const qe = new QueryEngine(repo, quality, { bucketStaleMs: internals.bucketStaleMs ?? 0 })
  const resolver = new SourceResolver({ repo, registry: lazyRegistry(getRegistry), getSettings: deps.getSettings, now, log })

  // --- status broadcast (throttled) -----------------------------------------------------------
  let lastSent = 0
  let pending: ReturnType<typeof setTimeout> | null = null
  let countsCache: { at: number; rev: number; v: ReturnType<CatalogRepo['counts']> } | null = null
  const counts = () => {
    if (!countsCache || countsCache.rev !== repo.revision || now() - countsCache.at > 2000) countsCache = { at: now(), rev: repo.revision, v: repo.counts() }
    return countsCache.v
  }
  // Bucket groupings (platform/year/composer/franchise) aggregate the whole catalog (~50 ms cold);
  // compute the unfiltered ones while idle so the first switch to those groupings is instant.
  let wasIndexing = false
  let prewarmTimer: ReturnType<typeof setTimeout> | null = null
  const schedulePrewarm = (ms: number) => {
    if (prewarmTimer) clearTimeout(prewarmTimer)
    prewarmTimer = setTimeout(async () => {
      prewarmTimer = null
      // In small chunks (the catalog keeps answering Browse meanwhile).
      await repo.preloadGameMaps().catch((e) => log(`prewarm games: ${(e as Error).message}`))
      for (const group of ['platform', 'year', 'composer', 'franchise'] as const) {
        if (stopped || crawler?.running) return
        try {
          await qe.warmBuckets(group)
        } catch (e) {
          log(`prewarm ${group}: ${(e as Error).message}`)
        }
      }
    }, ms)
  }
  let chipIndexer: ChipIndexer | null = null
  let chipTimer: ReturnType<typeof setTimeout> | null = null
  let chipForce = false
  const notify = () => {
    const indexing = !!crawler?.running
    if (wasIndexing && !indexing) {
      // One source's crawl finished: the next source's, or (all done) the chiptune rip index (it
      // matches against the games the others found) and the bucket prewarm.
      chipTimer ??= setTimeout(() => {
        chipTimer = null
        if (nextCrawl()) return
        schedulePrewarm(2000)
        maybeStartChip()
      }, 1000)
    }
    wasIndexing = indexing
    if (pending) return
    const wait = Math.max(0, 400 - (now() - lastSent))
    pending = setTimeout(() => {
      pending = null
      lastSent = now()
      try {
        deps.broadcast('catalog:status', status())
      } catch (e) {
        log(`status broadcast failed: ${(e as Error).message}`)
      }
    }, wait)
  }

  const enricher = new Enricher({ repo, getSettings: deps.getSettings, fetch: internals.fetchJson, onChange: notify, log, now })
  const accent = new AccentWorker(repo, internals.accentOf ?? (async (url, bytes) => (await artProtocol()).artAccent(url, bytes)), notify)

  // --- index crawls --------------------------------------------------------------------------
  // The first registered index provider (KHInsider) builds the catalog; the others (Zophar's
  // Domain, Modland, Internet Archive collections) crawl after it, one at a time, each on its own
  // refresh period. Disabled sources aren't crawled.
  const crawlers = new Map<string, Crawler>()
  /** The crawl running now (or the last one that ran). */
  let crawler: Crawler | null = null
  const forceCrawl = new Set<string>()
  const indexProviders = (): IndexProvider[] => getRegistry().all().filter(isIndexProvider)
  const crawlerFor = (p: IndexProvider): Crawler => {
    let c = crawlers.get(p.id)
    if (!c) {
      const primary = indexProviders()[0] === p
      c = new Crawler({
        repo,
        provider: p,
        primary,
        onProgress: notify,
        log: (m) => log(primary ? m : `${p.id}: ${m}`),
        now,
        pageDelayMs: internals.crawlPageDelayMs ?? p.indexPageDelayMs ?? 750,
        sections: internals.crawlSections,
        maxPagesPerSection: internals.crawlMaxPagesPerSection
      })
      crawlers.set(p.id, c)
    }
    return c
  }
  /** The main catalog source's crawler. */
  const getCrawler = (): Crawler | null => {
    const p = indexProviders()[0]
    return p ? crawlerFor(p) : null
  }
  /** Start the first source whose index is stale (or forced, or interrupted). False if none needs it. */
  function nextCrawl(): boolean {
    if (stopped || crawler?.running) return false
    const disabled = new Set(deps.getSettings().sources.disabled)
    for (const p of indexProviders()) {
      if (disabled.has(p.id)) continue
      const c = crawlerFor(p)
      const force = forceCrawl.delete(p.id)
      if (c.start({ force })) {
        crawler = c
        log(`${p.id} index crawl started`)
        return true
      }
    }
    return false
  }

  // --- chiptune rip index (after the main crawl, lower priority) ------------------------------
  const getChipIndexer = (): ChipIndexer | null => {
    if (chipIndexer) return chipIndexer
    if (internals.chip === false) return null
    const p = getRegistry().get(CHIP_ID)
    if (!(p instanceof ChipProvider)) return null
    chipIndexer = new ChipIndexer({ repo, provider: p, onProgress: notify, log, now, joshwEnabled: () => deps.getSettings().sources.crawlJoshw === true, ...(internals.chip ?? {}) })
    return chipIndexer
  }
  function maybeStartChip(): void {
    if (stopped || crawler?.running) return
    if (deps.getSettings().sources.disabled.includes(CHIP_ID)) return
    const c = getChipIndexer()
    if (c?.start({ force: chipForce })) {
      chipForce = false
      log('chiptune rip index started')
    }
  }

  function status(): CatalogStatus {
    const c = counts()
    const cr = crawler
    const chip = chipIndexer?.running ? chipIndexer : null
    return {
      indexing: !!cr?.running || !!chip,
      games: c.games,
      albums: c.albums,
      tracks: c.tracks,
      progress: cr?.running ? (cr.progress ?? 0) : chip ? (chip.progress ?? 0) : null,
      lastIndexedAt: getCrawler()?.lastFinished() ?? repo.get<{ t: number | null }>(`SELECT MAX(finished_at) AS t FROM crawl_jobs WHERE status = 'done'`)?.t ?? null,
      message: (cr?.running ? cr.message : null) ?? chip?.message ?? cr?.message ?? (enricher.lastError ? `Enrichment: ${enricher.lastError}` : null),
      enrichment: enricher.status(),
      revision: repo.revision
    }
  }

  // --- album pages ----------------------------------------------------------------------------
  const detailInflight = new Map<number, Promise<void>>()
  function fetchDetail(albumId: number, priority: 0 | 1 | 2, force = false): Promise<void> {
    const existing = detailInflight.get(albumId)
    if (existing) return existing
    const st = repo.albumState(albumId)
    if (!st) return Promise.reject(new NetError('not_found', `no album ${albumId}`))
    const provider = getRegistry().get(st.provider)
    if (!provider?.getAlbum) return Promise.resolve()
    const p = provider
      .getAlbum(st.provider_ref, { priority, force })
      .then((d) => {
        repo.applyAlbumDetail(albumId, d)
        storeProviderStreams(albumId, d)
        notify()
      })
      .catch((e: unknown) => {
        if (isNetError(e, 'not_found')) repo.markAlbumError(albumId, (e as Error).message, true)
        else if (!isNetError(e, 'blocked') && !isNetError(e, 'aborted')) repo.markAlbumError(albumId, (e as Error).message)
        throw e
      })
      .finally(() => detailInflight.delete(albumId))
    detailInflight.set(albumId, p)
    return p
  }

  /**
   * Streams the provider already gave us with the album (IA files, Bandcamp URLs, a YouTube
   * video's chapters, a chip rip set's archive entries) become sources now, so the first play
   * doesn't need another round-trip.
   */
  function storeProviderStreams(albumId: number, album: ProviderAlbum): void {
    if (!album.tracks.some((t) => t.streams?.length)) return
    const byLocator = new Map(repo.all<{ id: number; locator: string }>(`SELECT id, locator FROM tracks WHERE album_id = ? AND removed = 0`, albumId).map((r) => [r.locator, r.id]))
    for (const t of album.tracks) {
      const id = byLocator.get(t.locator)
      if (id != null && t.streams?.length) resolver.storeStreams(id, album.provider, t.streams.map((info) => ({ info, locator: t.locator, confidence: 1 })), t.durationMs)
    }
  }

  // Low-priority album-page fetches so groups without art fill in progressively.
  const artQueue: number[] = []
  let artBusy = false
  function queueArt(albumIds: number[]): void {
    for (const id of albumIds) if (!artQueue.includes(id)) artQueue.push(id)
    if (artQueue.length > ART_QUEUE_MAX) artQueue.splice(0, artQueue.length - ART_QUEUE_MAX)
    void pumpArt()
  }
  async function pumpArt(): Promise<void> {
    if (artBusy) return
    artBusy = true
    try {
      while (artQueue.length && !stopped) {
        // Newest requests first: the user is looking at them now.
        const id = artQueue.pop()!
        await fetchDetail(id, 2).catch((e) => log(`art fill for album ${id}: ${(e as Error).message}`))
      }
    } finally {
      artBusy = false
    }
  }

  function afterBrowse(page: BrowsePage): void {
    const gameIds: number[] = []
    const needArt: number[] = []
    for (const g of page.groups) {
      if (g.gameId) gameIds.push(Number(g.gameId))
      if (g.cover) continue
      if (g.kind === 'album') {
        const id = Number(g.key.slice(6))
        const st = repo.get<{ detail_at: number | null; art_checked_at: number | null }>(`SELECT detail_at, art_checked_at FROM albums WHERE id = ?`, id)
        if (st && !st.detail_at && !st.art_checked_at) needArt.push(id)
      } else if (g.gameId) {
        const a = repo.get<{ id: number }>(
          `SELECT id FROM albums WHERE game_id = ? AND gone = 0 AND detail_at IS NULL AND art_checked_at IS NULL ORDER BY kind_rank, sort_year LIMIT 1`,
          Number(g.gameId)
        )
        if (a) needArt.push(a.id)
      }
    }
    if (needArt.length) queueArt(needArt.reverse())
    if (!internals.disableEnrichment && gameIds.length) {
      enricher.want(gameIds)
      accent.want(page.groups.filter((g) => g.gameId).map((g) => ({ gameId: Number(g.gameId), cover: g.cover, accent: g.accent })))
    }
  }

  // While the first index crawl is incomplete, also ask the provider's own search so typing a game
  // name finds it right away (debounced: the renderer browses on every keystroke).
  const searched = new Map<string, number>()
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let pendingSearch: string | null = null
  function maybeSiteSearch(text: string): void {
    const terms = parseSearch(text).terms.join(' ').trim()
    if ([...terms].length < 3) return
    // Only sources whose own index isn't complete yet (or is being refreshed) are asked.
    const disabled = new Set(deps.getSettings().sources.disabled)
    const incomplete = (p: IndexProvider) => {
      const c = crawlerFor(p)
      return c.running || c.lastFinished() == null
    }
    const providers = indexProviders().filter((p) => p.searchAlbums && !disabled.has(p.id) && incomplete(p))
    if (!providers.length) return
    if ((searched.get(terms) ?? 0) > now() - 3600_000) return
    // Same text already waiting (e.g. a refetch after a status tick): keep its timer.
    if (searchTimer && pendingSearch === terms) return
    if (searchTimer) clearTimeout(searchTimer)
    pendingSearch = terms
    searchTimer = setTimeout(() => {
      searchTimer = null
      pendingSearch = null
      searched.set(terms, now())
      for (const p of providers) {
        const complete = crawlerFor(p).lastFinished() != null
        p.searchAlbums!(terms, { priority: 0 })
          .then((hits) => {
            if (stopped || !hits.length) return
            const ids = repo.upsertHits(hits, { initial: !complete })
            repo.assignGames(ids)
            repo.revision++
            notify()
          })
          .catch((e) => log(`${p.id} search "${terms}": ${(e as Error).message}`))
      }
    }, 600)
  }

  // --- local files ----------------------------------------------------------------------------
  // Scan settings.sources.localFolders at startup and whenever the list changes (incremental).
  let localKey: string | null = null
  let localPoll: ReturnType<typeof setInterval> | null = null
  function checkLocalFolders(force = false): void {
    if (internals.disableLocalScan || stopped) return
    const folders = deps.getSettings().sources.localFolders ?? []
    const key = JSON.stringify(folders)
    if (!force && key === localKey) return
    localKey = key
    const local = getRegistry().get('local')
    const lib = local instanceof LocalProvider ? local.library : null
    if (!lib || (!folders.length && lib.count() === 0)) return
    lib
      .scan(folders)
      .then((r) => {
        if (r.added || r.updated || r.removed || r.errors) log(`local files: ${r.files} in ${r.roots.length} folder(s), +${r.added} ~${r.updated} -${r.removed}, ${r.errors} unreadable (${r.ms} ms)`)
        if (r.removedPaths.length) {
          repo.tx(() => {
            for (const p of r.removedPaths) repo.run(`DELETE FROM sources WHERE provider = 'local' AND path = ?`, p)
          })
          repo.revision++
          notify()
        }
      })
      .catch((e) => log(`local files scan failed: ${(e as Error).message}`))
  }

  // --- external import (YouTube / Internet Archive / Bandcamp) -----------------------------------
  async function searchExternal(query: string, only?: ExternalAlbumHit['provider'][]): Promise<ExternalAlbumHit[]> {
    const q = query.trim()
    if (!q) return []
    const wanted = only?.length ? new Set<string>(only) : null
    const providers = getRegistry()
      .ordered(deps.getSettings().sources)
      .filter((p) => p.searchExternal && (!wanted || wanted.has(p.id)))
    if (!providers.length) return []
    const settled = await Promise.allSettled(providers.map((p) => withTimeout(p.searchExternal!(q, { priority: 0 }), EXTERNAL_SEARCH_TIMEOUT_MS, `${p.name} search`)))
    const hits: ExternalAlbumHit[] = []
    const errors: unknown[] = []
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') hits.push(...r.value)
      else {
        errors.push(r.reason)
        log(`${providers[i].id} external search "${q}": ${(r.reason as Error).message}`)
      }
    })
    if (!hits.length && errors.length) throw errors[0]
    const order = providers.map((p) => p.id)
    const seen = new Set<string>()
    return hits
      .filter((h) => {
        const k = `${h.provider}\u0000${h.ref}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      .sort((a, b) => b.score - a.score || order.indexOf(a.provider) - order.indexOf(b.provider))
      .slice(0, EXTERNAL_HITS_MAX)
  }

  async function importExternal(hit: ExternalAlbumHit, opts: { gameName?: string } = {}): Promise<AlbumDetail> {
    const provider = getRegistry().get(hit?.provider)
    if (!provider?.getAlbum) throw new Error(`Importing from ${hit?.provider ?? 'that source'} isn't supported.`)
    const d = await provider.getAlbum(hit.ref, { priority: 0, force: true })
    if (!d.tracks.length) throw new NetError('not_found', `"${hit.title}" has nothing playable`)
    const album: ProviderAlbum = { ...d, cover: d.cover ?? hit.cover, thumb: d.thumb ?? hit.cover, images: d.images.length ? d.images : hit.cover ? [hit.cover] : [] }
    const [albumId] = repo.upsertHits([album], { initial: false })
    repo.pinAlbumToGame(albumId, opts.gameName?.trim() || guessGameName(album, hit))
    repo.applyAlbumDetail(albumId, album)
    storeProviderStreams(albumId, album)
    repo.revision++
    notify()
    log(`imported ${album.provider} "${album.title}" (${album.tracks.length} tracks) as album ${albumId}`)
    return service.album(String(albumId))
  }

  /**
   * After an update changed the search-text format or the clustering rules: rebuild the FTS
   * documents / re-cluster once, in the background (paced; Browse keeps answering meanwhile).
   * A crawl that is about to run re-clusters at its end anyway.
   */
  async function upgradeIndexes(): Promise<void> {
    try {
      if (repo.ftsStale()) {
        const t0 = now()
        if (!(await repo.rebuildFts(writerPause, () => stopped))) return
        log(`search index rebuilt in ${Math.round((now() - t0) / 100) / 10} s`)
        repo.revision++
        notify()
      }
      if (repo.meta('cluster_version') !== String(CLUSTER_VERSION)) {
        if (!crawler?.running && repo.counts().albums > 0) {
          const t0 = now()
          await repo.reclusterAll()
          log(`games re-clustered in ${Math.round((now() - t0) / 100) / 10} s`)
          notify()
        } else if (!crawler?.running) repo.setMeta('cluster_version', String(CLUSTER_VERSION))
      }
    } catch (e) {
      log(`index upgrade failed: ${(e as Error).message}`)
    }
  }

  // --- lifecycle --------------------------------------------------------------------------------
  let stopped = false
  const timers: ReturnType<typeof setTimeout>[] = []
  let unsubscribeArt: (() => void) | null = null

  const trackViews = (ids: number[]): TrackView[] => {
    const out: TrackView[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      out.push(...repo.toTrackViews(repo.trackRows(`t.id IN (${chunk.map(() => '?').join(',')})`, chunk), quality()))
    }
    return out
  }

  const service: CatalogService = {
    searchExternal,
    importExternal,

    start() {
      stopped = false
      localKey = null
      timers.push(setTimeout(() => checkLocalFolders(true), (internals.startDelayMs ?? 1500) + 500))
      if (!internals.disableLocalScan) {
        localPoll = setInterval(() => checkLocalFolders(), LOCAL_FOLDERS_POLL_MS)
        localPoll.unref?.()
      }
      if (!internals.disableEnrichment) {
        unsubscribeArt = (internals.onArtFetched ?? defaultOnArtFetched)((url, bytes, hex) => accent.onArtFetched(url, bytes, hex))
        enricher.start()
      }
      timers.push(
        setTimeout(() => {
          if (stopped) return
          // Fresh shuffle for 'random' sort each launch (a seeded hash order; no rows are rewritten).
          reseedRandom()
          void upgradeIndexes()
          if (!nextCrawl()) {
            schedulePrewarm(3000)
            maybeStartChip()
          }
          notify()
        }, internals.startDelayMs ?? 1500)
      )
      const trim = internals.trimArtCache ?? (internals.accentOf ? null : async () => (await artProtocol()).trimArtCache())
      if (!internals.disableEnrichment && trim) timers.push(setTimeout(() => void trim().catch(() => {}), 60_000))
    },

    stop() {
      stopped = true
      for (const t of timers) clearTimeout(t)
      timers.length = 0
      for (const c of crawlers.values()) c.stop()
      chipIndexer?.stop()
      if (chipTimer) clearTimeout(chipTimer)
      chipTimer = null
      enricher.stop()
      accent.stop()
      unsubscribeArt?.()
      unsubscribeArt = null
      if (pending) clearTimeout(pending)
      pending = null
      if (prewarmTimer) clearTimeout(prewarmTimer)
      prewarmTimer = null
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = null
      if (localPoll) clearInterval(localPoll)
      localPoll = null
    },

    async status() {
      return status()
    },

    async reindex() {
      const ps = indexProviders()
      if (!ps.length) throw new Error('no indexable provider')
      // Every source re-reads its whole index, one after another; the chip index follows (see notify).
      for (const p of ps) if (!crawlers.get(p.id)?.running) forceCrawl.add(p.id)
      chipForce = true
      chipIndexer?.stop()
      nextCrawl()
      notify()
    },

    async browse(q: BrowseQuery) {
      const page = qe.browse(q)
      afterBrowse(page)
      if (q.text) maybeSiteSearch(q.text)
      return page
    },

    async suggest(text, limit) {
      return qe.suggest(text, limit)
    },

    async sources() {
      const albums = new Map(repo.all<{ provider: string; n: number }>(`SELECT provider, COUNT(*) AS n FROM albums WHERE gone = 0 GROUP BY provider`).map((r) => [r.provider, r.n]))
      const ids = new Set([...getRegistry().all().map((p) => p.id), ...albums.keys()])
      return [...ids].map((id) => {
        const p = getRegistry().get(id)
        const c = p && isIndexProvider(p) ? crawlerFor(p) : null
        return { id, albums: albums.get(id) ?? 0, lastIndexedAt: c?.lastFinished() ?? null, indexing: !!c?.running || (id === CHIP_ID && !!chipIndexer?.running) }
      })
    },

    async groupAlbums(groupKey, q) {
      return qe.groupAlbums(groupKey, q)
    },

    async album(albumId: ID): Promise<AlbumDetail> {
      const id = Number(albumId)
      const st = Number.isFinite(id) ? repo.albumState(id) : undefined
      if (!st) throw new NetError('not_found', `no album ${albumId}`)
      const hasTracks = !!repo.get<{ n: number }>(`SELECT 1 AS n FROM tracks WHERE album_id = ? AND removed = 0 LIMIT 1`, id)
      if (!st.detail_at || !hasTracks) {
        try {
          await fetchDetail(id, 0)
        } catch (e) {
          if (!hasTracks) throw e
          log(`album ${id}: using cached tracks (${(e as Error).message})`)
        }
      } else if (now() - st.detail_at > DETAIL_TTL_MS) {
        void fetchDetail(id, 1).catch((e) => log(`album ${id} refresh: ${(e as Error).message}`))
      }
      const album = repo.album(id)
      if (!album) throw new NetError('not_found', `no album ${albumId}`)
      const game = album.gameId ? repo.game(Number(album.gameId)) : null
      const tracks = repo.toTrackViews(repo.trackRows('t.album_id = ? AND t.removed = 0', [id], 'ORDER BY t.position'), quality())
      if (game && !internals.disableEnrichment) {
        enricher.want([Number(game.id)])
        accent.want([{ gameId: Number(game.id), cover: game.cover, accent: game.accent }])
      }
      return { album, game, tracks }
    },

    async game(gameId: ID): Promise<Game | null> {
      const g = repo.game(Number(gameId))
      if (g && !internals.disableEnrichment) enricher.want([Number(gameId)])
      return g
    },

    async tracks(trackIds: ID[]) {
      const ids = trackIds.map(Number).filter(Number.isFinite)
      const byId = new Map(trackViews(ids).map((t) => [t.id, t]))
      return trackIds.map((id) => byId.get(String(Number(id)))).filter((t): t is TrackView => !!t)
    },

    async searchTracks(text, limit = 50) {
      return qe.searchTracks(text, limit)
    },

    async random(text = '') {
      return qe.random(text)
    },

    async getAnalysis(trackId) {
      const id = Number(trackId)
      return Number.isFinite(id) ? repo.getAnalysis(id) : null
    },

    recordAnalysis(trackId, result) {
      const id = Number(trackId)
      if (!Number.isFinite(id) || !repo.get(`SELECT 1 FROM tracks WHERE id = ?`, id)) return
      repo.recordAnalysis(id, result)
      notify()
    },

    resolveSources(trackId, opts) {
      return resolver.resolve(trackId, opts)
    },

    markSourceFailed(trackId, cacheKey, reason) {
      resolver.markFailed(trackId, cacheKey, reason)
    },

    async albumOf(trackId) {
      const r = repo.get<{ album_id: number }>(`SELECT album_id FROM tracks WHERE id = ?`, Number(trackId))
      if (!r) return null
      const album = repo.album(r.album_id)
      if (!album) return null
      return { album, game: album.gameId ? repo.game(Number(album.gameId)) : null }
    },

    async queryTrackIds(query, limit) {
      return qe.queryTrackIds(query, limit)
    }
  }
  return service
}

/** Defer creating providers (and the HTTP client) until something needs them. */
function lazyRegistry(get: () => ProviderRegistry): ProviderRegistry {
  return new Proxy({} as ProviderRegistry, {
    get: (_t, prop) => {
      const r = get()
      const v = (r as unknown as Record<string | symbol, unknown>)[prop]
      return typeof v === 'function' ? v.bind(r) : v
    }
  })
}
