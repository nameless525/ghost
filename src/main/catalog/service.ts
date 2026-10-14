// CatalogService: the catalog DB, the KHInsider index crawl, lazy album pages, source resolution,
// enrichment and analysis storage, behind the CatalogAPI contract (src/shared/api.ts).

import { parseSearch } from '../../shared/search'
import type { AlbumDetail, BrowsePage, BrowseQuery, CatalogStatus, Game, ID, TrackView } from '../../shared/types'
import { artAccent, onArtFetched, trimArtCache } from '../net/art-protocol'
import { isNetError, NetError } from '../net/errors'
import type { HttpClient } from '../net/http'
import { sharedHttp } from '../net/shared'
import { createDefaultRegistry, type ProviderRegistry } from '../providers'
import { isIndexProvider, type IndexProvider } from '../providers/types'
import { Crawler } from './crawler'
import { AccentWorker, Enricher } from './enrich'
import type { CatalogDeps, CatalogService } from './index'
import { QueryEngine, reseedRandom } from './query'
import { CatalogRepo } from './repo'
import { SourceResolver } from './resolver'

const DETAIL_TTL_MS = 7 * 24 * 3600_000
const ART_QUEUE_MAX = 60

/** Test / smoke-script seams. Production uses the defaults. */
export interface CatalogInternals {
  http?: HttpClient
  registry?: ProviderRegistry
  /** fetch for IGDB / SteamGridDB (plain JSON APIs). */
  fetchJson?: typeof fetch
  /** Accent colour for an image URL (default: decode via Electron nativeImage from the art cache). */
  accentOf?: (url: string, bytes?: Buffer) => Promise<string | null>
  /** Subscribe to newly fetched art (default: the ghost-art protocol). */
  onArtFetched?: (fn: (url: string, bytes: Buffer) => void) => () => void
  now?: () => number
  /** Delay before the startup crawl begins (ms). */
  startDelayMs?: number
  crawlPageDelayMs?: number
  crawlSections?: string[]
  crawlMaxPagesPerSection?: number
  /** Don't run IGDB/SGDB/accent background work. */
  disableEnrichment?: boolean
  log?: (msg: string) => void
}

export function createCatalogService(deps: CatalogDeps, internals: CatalogInternals = {}): CatalogService {
  const now = internals.now ?? Date.now
  const log = internals.log ?? ((m: string) => console.log(`[catalog] ${m}`))
  const repo = new CatalogRepo(deps.db, now)
  let registry: ProviderRegistry | null = internals.registry ?? null
  const getRegistry = () => (registry ??= createDefaultRegistry(internals.http ?? sharedHttp()))
  const quality = () => deps.getSettings().sources.quality
  const qe = new QueryEngine(repo, quality)
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
    prewarmTimer = setTimeout(() => {
      prewarmTimer = null
      if (stopped || crawler?.running) return
      for (const group of ['platform', 'year', 'composer', 'franchise'] as const) {
        try {
          qe.browse({ text: '', group, sort: 'title', offset: 0, limit: 1 })
        } catch (e) {
          log(`prewarm ${group}: ${(e as Error).message}`)
        }
      }
    }, ms)
  }
  const notify = () => {
    const indexing = !!crawler?.running
    if (wasIndexing && !indexing) schedulePrewarm(2000)
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
  const accent = new AccentWorker(repo, internals.accentOf ?? artAccent, notify)

  let crawler: Crawler | null = null
  const getCrawler = (): Crawler | null => {
    if (crawler) return crawler
    const p = getRegistry()
      .all()
      .find((x): x is IndexProvider => isIndexProvider(x))
    if (!p) return null
    crawler = new Crawler({
      repo,
      provider: p,
      onProgress: notify,
      log,
      now,
      pageDelayMs: internals.crawlPageDelayMs ?? 750,
      sections: internals.crawlSections,
      maxPagesPerSection: internals.crawlMaxPagesPerSection
    })
    return crawler
  }

  function status(): CatalogStatus {
    const c = counts()
    const cr = crawler
    return {
      indexing: !!cr?.running,
      games: c.games,
      albums: c.albums,
      tracks: c.tracks,
      progress: cr?.running ? (cr.progress ?? 0) : null,
      lastIndexedAt: cr?.lastFinished() ?? repo.get<{ t: number | null }>(`SELECT MAX(finished_at) AS t FROM crawl_jobs WHERE status = 'done'`)?.t ?? null,
      message: cr?.message ?? (enricher.lastError ? `Enrichment: ${enricher.lastError}` : null),
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
    const c = getCrawler()
    const complete = c?.lastFinished() != null
    if (!c || (complete && !c.running)) return
    if ((searched.get(terms) ?? 0) > now() - 3600_000) return
    // Same text already waiting (e.g. a refetch after a status tick): keep its timer.
    if (searchTimer && pendingSearch === terms) return
    if (searchTimer) clearTimeout(searchTimer)
    pendingSearch = terms
    searchTimer = setTimeout(() => {
      searchTimer = null
      pendingSearch = null
      searched.set(terms, now())
      const providers = getRegistry().all().filter((p) => p.searchAlbums)
      for (const p of providers) {
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
    start() {
      stopped = false
      if (!internals.disableEnrichment) {
        unsubscribeArt = (internals.onArtFetched ?? onArtFetched)((url, bytes) => accent.onArtFetched(url, bytes))
        enricher.start()
      }
      timers.push(
        setTimeout(() => {
          if (stopped) return
          // Fresh shuffle for 'random' sort each launch.
          repo.run(`UPDATE games SET rnd = abs(random()) % 2147483647`)
          reseedRandom()
          const c = getCrawler()
          if (c?.start()) log('index crawl started')
          else schedulePrewarm(3000)
          notify()
        }, internals.startDelayMs ?? 1500)
      )
      if (!internals.disableEnrichment && !internals.accentOf) timers.push(setTimeout(() => void trimArtCache().catch(() => {}), 60_000))
    },

    stop() {
      stopped = true
      for (const t of timers) clearTimeout(t)
      timers.length = 0
      crawler?.stop()
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
    },

    async status() {
      return status()
    },

    async reindex() {
      const c = getCrawler()
      if (!c) throw new Error('no indexable provider')
      c.start({ force: true })
      notify()
    },

    async browse(q: BrowseQuery) {
      const page = qe.browse(q)
      afterBrowse(page)
      if (q.text) maybeSiteSearch(q.text)
      return page
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

    getAnalysis(trackId) {
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
