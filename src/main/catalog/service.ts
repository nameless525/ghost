// CatalogService: the catalog DB, the KHInsider index crawl, lazy album pages, source resolution,
// enrichment and analysis storage, external search/import (YouTube, Internet Archive, Bandcamp) and
// the local-files scan, behind the CatalogAPI contract (src/shared/api.ts).

import { basename, resolve as resolvePath } from 'node:path'
import { parseSearch } from '../../shared/search'
import type { AlbumDetail, BrowsePage, BrowseQuery, CatalogStatus, ExternalAlbumHit, Game, ID, SourceIndexStatus, TrackView } from '../../shared/types'
import { isNetError, NetError } from '../net/errors'
import type { HttpClient } from '../net/http'
import { createDefaultRegistry, type ProviderRegistry } from '../providers'
import { CHIP_ID, ChipProvider } from '../providers/chip'
import { KH_ID } from '../providers/khinsider'
import { LocalProvider, type ScanProgress, type ScanResult } from '../providers/local'
import { SET_MAX_TRACKS } from '../providers/soundcloud'
import { isIndexProvider, type IndexProvider, type Provider, type ProviderAlbum } from '../providers/types'
import type { YtDlp } from '../tools/ytdlp'
import { ChipIndexer, VGMRIPS_REFRESH_MS, type ChipIndexerDeps } from './chip'
import { Crawler } from './crawler'
import { AccentWorker, Enricher } from './enrich'
import type { CatalogDeps, CatalogService } from './index'
import { QueryEngine, reseedRandom } from './query'
import { baseTitle } from './normalize'
import { CatalogRepo, writerPause } from './repo'
import { CLUSTER_VERSION } from './schema'
import { SourceResolver } from './resolver'
import { TaskReporter, TypicalMs } from './tasks'

const DETAIL_TTL_MS = 7 * 24 * 3600_000
const ART_QUEUE_MAX = 60
const EXTERNAL_SEARCH_TIMEOUT_MS = 60_000
const EXTERNAL_HITS_MAX = 40
const LOCAL_FOLDERS_POLL_MS = 4000
/** While the app stays open, sources are checked for a due refresh this often (and at every launch). */
export const REFRESH_CHECK_MS = 24 * 3600_000
/**
 * How often the clock is read for that check. Timers stall while the Mac sleeps but the wall clock
 * doesn't, so a plain 24-hour timer could wait days on a laptop that sleeps every night.
 */
const REFRESH_TICK_MS = 15 * 60_000
/** Rest this long on an album (no other album opened) before its first track's stream is resolved ahead. */
export const PREFETCH_DWELL_MS = 600
/** Site searches remembered (one per distinct query, while a source's first crawl is incomplete). */
const SEARCHED_MAX = 500
/** warmSources resolves at most this many tracks per call. */
const WARM_MAX = 3
/**
 * Typical time to fetch an album's track list, per provider, until this session has measured its
 * own: a page request (KHInsider, Zophar's Domain, Bandcamp), an API call (Internet Archive), a
 * yt-dlp extraction (YouTube, SoundCloud).
 */
const ALBUM_MS: Record<string, number> = { khinsider: 900, zophar: 700, modland: 800, bandcamp: 900, archive: 1000, youtube: 4000, soundcloud: 4000 }
/** Opening a chiptune set before its archive downloads (main reports the download itself). */
const CHIP_OPEN_MS = 900
/** A SoundCloud set import extracts every track: about this long each. */
const SC_SET_TRACK_MS = 1000

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
  /** Check for due source refreshes this often while running (default REFRESH_CHECK_MS)… */
  refreshCheckMs?: number
  /** …reading the clock this often (default REFRESH_TICK_MS). */
  refreshTickMs?: number
  crawlPageDelayMs?: number
  crawlSections?: string[]
  crawlMaxPagesPerSection?: number
  /** Don't run IGDB/SGDB/accent background work. */
  disableEnrichment?: boolean
  /** yt-dlp for the YouTube provider (default: the shared managed instance). */
  ytdlp?: () => Promise<YtDlp>
  /** fetch for archive.org's JSON APIs. */
  sourceFetch?: typeof fetch
  /** Where sources keep downloaded indexes (Modland's file list); without it Modland is off. */
  sourcesCacheDir?: string
  /** Don't scan settings.sources.localFolders. */
  disableLocalScan?: boolean
  /**
   * Resolve the first track's stream of an album opened and rested on for this long (ms), ahead of
   * a likely play; unset = never (the worker sets PREFETCH_DWELL_MS).
   */
  prefetchDwellMs?: number
  /** Chiptune rip index (joshw.info / vgmrips.net): `false` = never crawl; otherwise options. */
  chip?: false | Pick<ChipIndexerDeps, 'hosts' | 'vgmrips' | 'maxPages' | 'pageDelayMs' | 'pages'>
  log?: (msg: string) => void
}

/** "A", "A and B", "A, B and C". */
function listNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
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
      cacheDir: internals.sourcesCacheDir,
      log: (m) => log(`sources: ${m}`)
    }))
  const quality = () => deps.getSettings().sources.quality
  const qe = new QueryEngine(repo, quality, { bucketStaleMs: internals.bucketStaleMs ?? 0, sourceOrder: () => deps.getSettings().sources.order })
  const resolver = new SourceResolver({ repo, registry: lazyRegistry(getRegistry), getSettings: deps.getSettings, now, log, onStep: deps.onResolveStep })
  // Waits with a bar of their own (the 'progress' event): album track lists, imports, folder scans.
  const tasks = new TaskReporter((p) => deps.broadcast('progress', p))
  const albumMs = new TypicalMs(ALBUM_MS, 1000)

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
  let wasCrawling = 0
  let prewarmTimer: ReturnType<typeof setTimeout> | null = null
  const schedulePrewarm = (ms: number) => {
    if (prewarmTimer) clearTimeout(prewarmTimer)
    prewarmTimer = setTimeout(async () => {
      prewarmTimer = null
      // In small chunks (the catalog keeps answering Browse meanwhile).
      for (const group of ['platform', 'year', 'composer', 'franchise'] as const) {
        if (stopped || anyCrawling()) return
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
    const crawling = running().length
    if (crawling < wasCrawling) {
      // A crawl finished: start whatever was waiting for it; once nothing is left, the chiptune rip
      // index (it matches against the games the others found) and the bucket prewarm.
      chipTimer ??= setTimeout(() => {
        chipTimer = null
        if (scheduleCrawls()) return
        endSetupNotice()
        schedulePrewarm(2000)
        maybeStartChip()
      }, 1000)
    }
    wasCrawling = crawling
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
  // KHInsider builds the catalog first, alone (the others' albums join its games). Then the other
  // index providers (Zophar's Domain, the Internet Archive collections…) crawl together: they're
  // different hosts, each paced politely on its own. Sources flagged `indexAfterOthers` (Modland,
  // which keeps some albums only for games the others know) follow them. Each re-reads on its own
  // refresh period; disabled sources aren't crawled.
  const crawlers = new Map<string, Crawler>()
  const forceCrawl = new Set<string>()
  const running = (): Crawler[] => [...crawlers.values()].filter((c) => c.running)
  const anyCrawling = () => running().length > 0
  /** Index providers in crawl order: KHInsider (the main catalog) first, then registration order. */
  const indexProviders = (): IndexProvider[] => {
    const all = getRegistry().all().filter(isIndexProvider)
    return [...all.filter((p) => p.id === KH_ID), ...all.filter((p) => p.id !== KH_ID)]
  }
  const crawlerFor = (p: IndexProvider): Crawler => {
    let c = crawlers.get(p.id)
    if (!c) {
      const primary = p.id === KH_ID
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
  const enabledIndexProviders = () => {
    const disabled = new Set(deps.getSettings().sources.disabled)
    return indexProviders().filter((p) => !disabled.has(p.id))
  }
  /** Due to crawl: running, or wanting to (stale, forced, or an interrupted job to resume). */
  const due = (p: IndexProvider) => {
    const c = crawlerFor(p)
    return c.running || c.wants(forceCrawl.has(p.id))
  }

  /** Start every crawl allowed to run now. Returns whether anything is crawling. */
  function scheduleCrawls(): boolean {
    if (stopped) return false
    const ps = enabledIndexProviders()
    const start = (p: IndexProvider) => {
      const c = crawlerFor(p)
      if (c.running || !c.start({ force: forceCrawl.has(p.id) })) return
      forceCrawl.delete(p.id)
      log(`${p.id} index crawl started${c.initial ? ' (first time)' : ''}`)
      if (c.initial) beginSetupNotice()
    }
    const main = ps.find((p) => p.id === KH_ID)
    if (main && due(main)) {
      start(main)
      return anyCrawling()
    }
    const rest = ps.filter((p) => p !== main && due(p))
    const together = rest.filter((p) => !p.indexAfterOthers)
    for (const p of together.length ? together : rest) start(p)
    return anyCrawling()
  }

  // --- refresh checks -------------------------------------------------------------------------
  // At launch, and then every REFRESH_CHECK_MS while the app stays open, each source is checked
  // against its own refresh period (an interrupted crawl resumes too). Turning a source on in
  // Settings starts it right away; turning one off stops its crawl (it resumes when turned back on).
  const checkEveryMs = internals.refreshCheckMs ?? REFRESH_CHECK_MS
  let lastCheck: number | null = null
  let checkTick: ReturnType<typeof setInterval> | null = null
  let disabledKey = ''
  const disabledNow = () => JSON.stringify([...deps.getSettings().sources.disabled].sort())

  /** Start whatever is due: the index crawls, or the chiptune rip index once nothing else crawls. */
  function startDue(): boolean {
    if (scheduleCrawls()) return true
    maybeStartChip()
    return false
  }
  /** The launch / daily check. Returns whether anything is crawling. */
  function checkDue(): boolean {
    lastCheck = now()
    disabledKey = disabledNow()
    return startDue()
  }
  /** Settings changed: follow sources turned on or off. */
  function onSourcesToggled(): void {
    if (stopped || lastCheck == null) return // the launch check reads the current list anyway
    const key = disabledNow()
    if (key === disabledKey) return
    disabledKey = key
    const off = new Set(deps.getSettings().sources.disabled)
    for (const [id, c] of crawlers) if (off.has(id)) c.stop()
    if (off.has(CHIP_ID)) chipIndexer?.stop()
    startDue()
    notify()
  }
  /** When a source's next background refresh starts if the app stays open: the first check after it's due. */
  function nextRefreshAt(c: Crawler): number | null {
    if (lastCheck == null) return null
    const next = lastCheck + checkEveryMs
    if (c.wants()) return next
    const dueAt = (c.lastFinished() ?? 0) + c.refreshEveryMs
    return dueAt <= next ? next : next + Math.ceil((dueAt - next) / checkEveryMs) * checkEveryMs
  }

  // One-time setup notices: when a source is added for the first time, say so (and that it won't
  // happen again); when the last first-time crawl ends, say the catalog is ready.
  const SETUP_NOTICE = 'catalog-setup'
  let setupNotice = false
  function beginSetupNotice(): void {
    if (setupNotice) return
    setupNotice = true
    const adding = enabledIndexProviders().filter((p) => due(p) && (crawlerFor(p).running ? crawlerFor(p).initial : crawlerFor(p).wouldBeInitial()))
    // Expected length: KHInsider alone, then the rest in parallel, then the after-others ones.
    const est = (ps: IndexProvider[]) => Math.max(0, ...ps.map((p) => p.indexEstimateMs ?? 60_000))
    const ms = est(adding.filter((p) => p.id === KH_ID)) + est(adding.filter((p) => p.id !== KH_ID && !p.indexAfterOthers)) + est(adding.filter((p) => p.indexAfterOthers))
    const mins = Math.max(1, Math.round(ms / 60_000))
    deps.broadcast('notify', {
      id: SETUP_NOTICE,
      kind: 'info',
      title: 'Setting up your catalog',
      body: `Adding ${listNames(adding.map((p) => p.name))} for the first time (about ${mins} min). This only happens once: afterwards each source refreshes quietly in the background. Browse and playback work meanwhile.`
    })
  }
  function endSetupNotice(): void {
    if (!setupNotice) return
    setupNotice = false
    const c = repo.counts()
    deps.broadcast('notify', {
      id: SETUP_NOTICE,
      kind: 'success',
      title: 'Your catalog is ready',
      body: `${c.games.toLocaleString('en-US')} games and ${c.albums.toLocaleString('en-US')} albums. From now on sources refresh in the background every few days, with no waiting.`
    })
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
    if (stopped || anyCrawling()) return
    if (deps.getSettings().sources.disabled.includes(CHIP_ID)) return
    const c = getChipIndexer()
    if (c?.start({ force: chipForce })) {
      chipForce = false
      log('chiptune rip index started')
    }
  }

  /** When the chiptune rip listings were last read (they keep their own page log). */
  function chipLastRead(): number | null {
    try {
      return repo.get<{ t: number | null }>(`SELECT MAX(fetched_at) AS t FROM chip_pages WHERE error IS NULL`)?.t ?? null
    } catch {
      return null // no chip tables yet
    }
  }

  /** Every enabled index source and what its crawl is doing, plus the chip index while it runs. */
  function sourceStatuses(): SourceIndexStatus[] {
    const disabled = new Set(deps.getSettings().sources.disabled)
    // Queued behind a crawl that's running (or one that just ended): it starts when that's done. A
    // source that comes due while nothing runs is idle until the next check (nextRefreshAt).
    const underway = anyCrawling() || chipTimer != null
    const out: SourceIndexStatus[] = indexProviders().map((p) => {
      const c = crawlerFor(p)
      const off = disabled.has(p.id)
      const waiting = !off && !c.running && underway && c.wants(forceCrawl.has(p.id))
      return {
        id: p.id,
        name: p.name,
        state: off ? 'off' : c.running ? 'running' : waiting ? 'waiting' : 'idle',
        initial: c.running ? c.initial : waiting ? c.wouldBeInitial() : false,
        progress: c.running ? c.progress : null,
        detail: c.running ? c.detail : null,
        etaMs: c.running ? c.etaMs : null,
        lastIndexedAt: c.lastFinished(),
        refreshEveryMs: c.refreshEveryMs,
        nextRefreshAt: off || c.running || waiting ? null : nextRefreshAt(c)
      }
    })
    const chip = chipIndexer
    if (chip?.running)
      out.push({ id: CHIP_ID, name: 'Chiptune rips', state: 'running', initial: false, progress: chip.progress, detail: null, etaMs: null, lastIndexedAt: chipLastRead(), refreshEveryMs: VGMRIPS_REFRESH_MS })
    return out
  }

  /** Time left for everything due, when every part can be estimated (else null). */
  function totalEta(srcs: SourceIndexStatus[]): number | null {
    let parallel = 0
    let after = 0
    for (const s of srcs) {
      if (s.state === 'running') {
        if (s.etaMs == null) return null
        parallel = Math.max(parallel, s.etaMs)
      } else if (s.state === 'waiting') {
        const p = getRegistry().get(s.id)
        const est = p && isIndexProvider(p) ? (p.indexEstimateMs ?? null) : null
        if (est == null) return null
        after = Math.max(after, est)
      }
    }
    return parallel + after
  }

  /**
   * Sources of the current indexing round (everything that ran or waited since the catalog was last
   * idle), so overall progress only moves forward as sources finish. Weighted by expected length.
   */
  const round = new Set<string>()
  function roundProgress(srcs: SourceIndexStatus[], active: SourceIndexStatus[]): number | null {
    if (!active.length) {
      round.clear()
      return null
    }
    for (const x of active) round.add(x.id)
    let sum = 0
    let weight = 0
    for (const x of srcs) {
      if (!round.has(x.id)) continue
      const p = getRegistry().get(x.id)
      const w = (p && isIndexProvider(p) ? p.indexEstimateMs : null) ?? 60_000
      sum += w * (x.state === 'running' ? (x.progress ?? 0) : x.state === 'waiting' ? 0 : 1)
      weight += w
    }
    return weight ? sum / weight : null
  }

  function status(): CatalogStatus {
    const c = counts()
    const srcs = sourceStatuses()
    const active = srcs.filter((x) => x.state === 'running' || x.state === 'waiting')
    const crawling = srcs.filter((x) => x.state === 'running')
    const setup = active.some((x) => x.initial)
    const names = listNames(crawling.map((x) => x.name))
    const message = crawling.length
      ? crawling.length === 1 && crawling[0].detail
        ? `${setup ? 'Adding' : 'Refreshing'} ${crawling[0].name}… ${crawling[0].detail}`
        : `${setup ? 'Adding' : 'Refreshing'} ${names}…`
      : null
    return {
      indexing: crawling.length > 0,
      games: c.games,
      albums: c.albums,
      tracks: c.tracks,
      progress: roundProgress(srcs, active),
      lastIndexedAt: getCrawler()?.lastFinished() ?? repo.get<{ t: number | null }>(`SELECT MAX(finished_at) AS t FROM crawl_jobs WHERE status = 'done'`)?.t ?? null,
      message: message ?? (enricher.lastError ? `Enrichment: ${enricher.lastError}` : null),
      enrichment: enricher.status(),
      revision: repo.revision,
      sources: srcs,
      setup,
      etaMs: active.length ? totalEta(active) : null
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
    const t0 = now()
    // Someone is waiting (priority 0): a chiptune set's download through the engine reports to their bar.
    const p = provider
      .getAlbum(st.provider_ref, priority === 0 ? { priority, force, progressKey: `album:${albumId}` } : { priority, force })
      .then((d) => {
        // Learn how long this source takes when asked interactively (background fetches queue behind others).
        if (priority === 0 && provider.id !== CHIP_ID) albumMs.record(provider.id, now() - t0)
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
    // One transaction for the whole album (a Zophar or Internet Archive album stores every track's stream).
    repo.tx(() => {
      for (const t of album.tracks) {
        const id = byLocator.get(t.locator)
        if (id != null && t.streams?.length) resolver.storeStreams(id, album.provider, t.streams.map((info) => ({ info, locator: t.locator, confidence: 1 })), t.durationMs)
      }
    })
  }

  // The album the user rests on: its first track's stream is resolved ahead of a likely "play"
  // (one polite request, only for providers whose resolve is a page fetch; see SourceResolver.prefetch).
  // A play from that album before the dwell is up (playAlbum, a preview) makes it moot.
  let dwellTimer: ReturnType<typeof setTimeout> | null = null
  let dwellAlbum: number | null = null
  function prefetchAfterDwell(albumId: number, trackId: string | undefined): void {
    const dwell = internals.prefetchDwellMs
    if (dwell == null) return
    cancelDwell()
    if (!trackId || stopped) return
    dwellAlbum = albumId
    dwellTimer = setTimeout(() => {
      dwellTimer = null
      dwellAlbum = null
      void resolver.prefetch(Number(trackId)).catch((e) => log(`prefetch of track ${trackId}: ${(e as Error).message}`))
    }, dwell)
  }
  function cancelDwell(): void {
    if (dwellTimer) clearTimeout(dwellTimer)
    dwellTimer = null
    dwellAlbum = null
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
      if (searched.size > SEARCHED_MAX) searched.delete(searched.keys().next().value!)
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

  /** The first step of opening an album whose track list isn't here yet. */
  function albumStep(provider: Provider) {
    // A chiptune set: then main reports the archive's download and unpacking (spans continue from here).
    if (provider.id === CHIP_ID) return { label: 'Opening the chiptune set', fraction: null, expectMs: CHIP_OPEN_MS, span: [0, 0.1] as [number, number] }
    return { label: `Loading tracks from ${provider.name}`, fraction: null, expectMs: albumMs.get(provider.id) }
  }

  // --- local files ----------------------------------------------------------------------------
  // Scan settings.sources.localFolders at startup and whenever the list changes (incremental). The
  // list is checked when settings arrive (deps.onSettingsChanged), or polled without it.
  let localKey: string | null = null
  let localPoll: ReturnType<typeof setInterval> | null = null
  let offSettings: (() => void) | null = null
  const count = (n: number) => n.toLocaleString('en-US')
  const scanProgress = (p: ScanProgress): void => {
    if (p.phase === 'done') tasks.done('scan')
    else if (p.phase === 'walk') tasks.step('scan', { label: 'Looking for music files', detail: p.found ? `${count(p.found)} found` : null, fraction: null, expectMs: null, span: [0, 0.15] })
    else tasks.step('scan', { label: 'Reading tags', detail: `${count(p.done)} of ${count(p.total)} files`, fraction: p.total ? p.done / p.total : null, expectMs: null, span: [0.15, 1] })
  }
  /** `startup`: the launch rescan (quiet); otherwise the user changed the folder list. */
  function checkLocalFolders(startup = false): void {
    if (internals.disableLocalScan || stopped) return
    // Settings can arrive before the launch scan: that one reads the current list anyway.
    if (!startup && localKey === null) return
    const folders = deps.getSettings().sources.localFolders ?? []
    const key = JSON.stringify(folders)
    if (!startup && key === localKey) return
    const before = localKey ? (JSON.parse(localKey) as string[]).map((f) => resolvePath(f)) : []
    localKey = key
    const local = getRegistry().get('local')
    const lib = local instanceof LocalProvider ? local.library : null
    if (!lib || (!folders.length && lib.count() === 0)) return
    const added = startup ? [] : [...new Set(folders.map((f) => resolvePath(f)))].filter((f) => !before.includes(f))
    lib
      .scan(folders, { onProgress: scanProgress })
      .then((r) => {
        if (!startup) scanNotice(r, added)
        if (r.added || r.updated || r.removed || r.errors) log(`local files: ${r.files} in ${r.roots.length} folder(s), +${r.added} ~${r.updated} -${r.removed}, ${r.errors} unreadable (${r.ms} ms)`)
        if (r.removedPaths.length) {
          repo.tx(() => {
            for (const p of r.removedPaths) repo.run(`DELETE FROM sources WHERE provider = 'local' AND path = ?`, p)
          })
          repo.revision++
          notify()
        }
      })
      .catch((e) => {
        log(`local files scan failed: ${(e as Error).message}`)
        if (!startup) deps.broadcast('notify', { id: 'local-scan', kind: 'error', title: 'Couldn’t scan your music folders', body: (e as Error).message })
      })
  }

  /** What a scan the user asked for (a folder added or removed) did, in one notice. */
  function scanNotice(r: ScanResult, added: string[]): void {
    const tracks = (n: number) => `${count(n)} track${n === 1 ? '' : 's'}`
    const names = (roots: string[]) => listNames(roots.map((f) => basename(f) || f))
    const unreadable = r.errors ? `${count(r.errors)} file${r.errors === 1 ? '' : 's'} couldn’t be read, so they’re listed by file name.` : undefined
    const missing = added.filter((f) => r.unavailable.includes(f))
    const fresh = r.byRoot.filter((x) => added.includes(x.root))
    const found = fresh.filter((x) => x.files > 0)
    const empty = fresh.filter((x) => x.files === 0)
    let n: { kind: 'success' | 'info' | 'error'; title: string; body?: string } | null = null
    if (missing.length) n = { kind: 'error', title: `Couldn’t open ${names(missing)}`, body: 'Check that the folder exists and that GHOST may read it.' }
    else if (found.length) {
      const total = found.reduce((s, x) => s + x.added, 0)
      const where = names(found.map((x) => x.root))
      n = total ? { kind: 'success', title: `Added ${tracks(total)} from ${where}`, body: unreadable } : { kind: 'info', title: `No new music files in ${where}` }
    }
    else if (empty.length) n = { kind: 'info', title: `No music files in ${names(empty.map((x) => x.root))}`, body: 'GHOST looks for MP3, FLAC, M4A, AAC, Ogg, Opus, WAV and AIFF files, in subfolders too.' }
    else if (r.removed) n = { kind: 'info', title: `Removed ${tracks(r.removed)} from your local files` }
    else if (r.added) n = { kind: 'success', title: `Added ${tracks(r.added)} from your music folders`, body: unreadable }
    if (n) deps.broadcast('notify', { id: 'local-scan', ...n })
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

  /** How long importing a hit usually takes: its provider's album fetch, or per track for a SoundCloud set. */
  function importExpectMs(hit: ExternalAlbumHit): number {
    const n = Math.min(SET_MAX_TRACKS, Math.max(0, hit.trackCount ?? 0))
    if (hit.provider === 'soundcloud') {
      if (/\/sets\//.test(hit.ref)) return 3000 + SC_SET_TRACK_MS * (n || 20)
      // An uploader's tracks: their whole upload list plus a search.
      if (hit.ref.startsWith('uploads:')) return 8000
    }
    // A YouTube playlist (not a video id) lists every entry.
    if (hit.provider === 'youtube' && !/^[\w-]{11}$/.test(hit.ref)) return albumMs.get('youtube') + 30 * n
    return albumMs.get(hit.provider)
  }

  async function importExternal(hit: ExternalAlbumHit, opts: { gameName?: string } = {}): Promise<AlbumDetail> {
    const provider = getRegistry().get(hit?.provider)
    if (!provider?.getAlbum) throw new Error(`Importing from ${hit?.provider ?? 'that source'} isn't supported.`)
    const key = `import:${hit.provider}:${hit.ref}`
    tasks.step(key, { label: `Importing from ${provider.name}`, fraction: null, expectMs: importExpectMs(hit) })
    try {
      return await importHit(provider, hit, opts)
    } finally {
      tasks.done(key)
    }
  }

  async function importHit(provider: Provider, hit: ExternalAlbumHit, opts: { gameName?: string }): Promise<AlbumDetail> {
    const d = await provider.getAlbum!(hit.ref, { priority: 0, force: true })
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
      const credits = repo.cleanStoredCredits()
      if (credits) {
        log(`cleaned the composer credits of ${credits} albums / tracks`)
        repo.revision++
        notify()
      }
      if (repo.ftsStale()) {
        const t0 = now()
        if (!(await repo.rebuildFts(writerPause, () => stopped))) return
        log(`search index rebuilt in ${Math.round((now() - t0) / 100) / 10} s`)
        repo.revision++
        notify()
      }
      if (repo.meta('cluster_version') !== String(CLUSTER_VERSION)) {
        if (!anyCrawling() && repo.counts().albums > 0) {
          const t0 = now()
          await repo.reclusterAll()
          log(`games re-clustered in ${Math.round((now() - t0) / 100) / 10} s`)
          notify()
        } else if (!anyCrawling()) repo.setMeta('cluster_version', String(CLUSTER_VERSION))
      }
      // Search indexes left fragmented by earlier bulk writes (nothing to do unless they regrew since their last merge).
      const t0 = now()
      const steps = await repo.compactFts(writerPause, () => stopped)
      if (steps > 2) log(`search index compacted in ${Math.round((now() - t0) / 100) / 10} s (${steps} steps)`)
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
      offSettings?.()
      const onSettings = () => {
        checkLocalFolders()
        onSourcesToggled()
      }
      offSettings = deps.onSettingsChanged?.(onSettings) ?? null
      if (!offSettings) {
        localPoll = setInterval(onSettings, LOCAL_FOLDERS_POLL_MS)
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
          if (!checkDue()) schedulePrewarm(3000)
          notify()
        }, internals.startDelayMs ?? 1500)
      )
      checkTick = setInterval(
        () => {
          if (!stopped && lastCheck != null && now() - lastCheck >= checkEveryMs) checkDue()
        },
        Math.min(internals.refreshTickMs ?? REFRESH_TICK_MS, checkEveryMs)
      )
      checkTick.unref?.()
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
      cancelDwell()
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = null
      if (localPoll) clearInterval(localPoll)
      localPoll = null
      if (checkTick) clearInterval(checkTick)
      checkTick = null
      lastCheck = null
      offSettings?.()
      offSettings = null
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
      scheduleCrawls()
      notify()
    },

    async browse(q: BrowseQuery) {
      await qe.prepare(q)
      const page = qe.browse(q)
      afterBrowse(page)
      if (q.text) maybeSiteSearch(q.text)
      return page
    },

    async suggest(text, limit) {
      return qe.suggest(text, limit)
    },

    async sources() {
      const albums = repo.albumsPerSource()
      const ids = new Set([...getRegistry().all().map((p) => p.id), ...albums.keys()])
      return [...ids].map((id) => {
        const p = getRegistry().get(id)
        const c = p && isIndexProvider(p) ? crawlerFor(p) : null
        if (id === CHIP_ID) return { id, albums: albums.get(id) ?? 0, lastIndexedAt: chipLastRead(), indexing: !!chipIndexer?.running }
        return { id, albums: albums.get(id) ?? 0, lastIndexedAt: c?.lastFinished() ?? null, indexing: !!c?.running }
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
        const provider = getRegistry().get(st.provider)
        const key = `album:${id}`
        if (provider?.getAlbum) tasks.step(key, albumStep(provider))
        try {
          await fetchDetail(id, 0)
        } catch (e) {
          if (!hasTracks) throw e
          log(`album ${id}: using cached tracks (${(e as Error).message})`)
        } finally {
          tasks.done(key)
        }
      } else if (now() - st.detail_at > DETAIL_TTL_MS) {
        void fetchDetail(id, 1).catch((e) => log(`album ${id} refresh: ${(e as Error).message}`))
      }
      const album = repo.album(id)
      if (!album) throw new NetError('not_found', `no album ${albumId}`)
      const game = album.gameId ? repo.game(Number(album.gameId)) : null
      const tracks = repo.toTrackViews(repo.trackRows('t.album_id = ? AND t.removed = 0', [id], 'ORDER BY t.position'), quality())
      if (!tracks.length) {
        // The source lists it but has no files (Zophar has a few empty sets): hide it from Browse
        // instead of offering an album that silently plays nothing.
        const name = getRegistry().get(st.provider)?.name ?? st.provider
        const msg = `${name} lists “${album.title}” but has no tracks for it.`
        repo.markAlbumError(id, msg, true)
        notify()
        throw new NetError('not_found', msg)
      }
      prefetchAfterDwell(id, tracks[0]?.id)
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
      if (dwellAlbum != null && repo.get<{ a: number }>(`SELECT album_id AS a FROM tracks WHERE id = ?`, Number(trackId))?.a === dwellAlbum) cancelDwell()
      return resolver.resolve(trackId, opts)
    },

    markSourceFailed(trackId, cacheKey, reason) {
      resolver.markFailed(trackId, cacheKey, reason)
    },

    warmSources(trackIds) {
      // A few tracks at most, one after another (each may be a page request to the source).
      const ids = trackIds.slice(0, WARM_MAX).map(Number).filter(Number.isFinite)
      void (async () => {
        for (const id of ids) {
          if (stopped) return
          await resolver.prefetch(id).catch((e) => log(`warming track ${id}: ${(e as Error).message}`))
        }
      })()
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
