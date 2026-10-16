// Browse data model: paged carousel groups, per-group albums, album details and game rows,
// fetched on demand and cached. Lives at module scope so the carousel's data (and the user's
// place in it) survives leaving and re-entering Browse.
//
// The carousel never awaits anything in its frame loop: it asks for what it needs
// (`ensureGroups`, `albumsFor`, `detailFor`) and gets a synchronous answer (data or
// `undefined` while loading). Arrivals are announced through `subscribe`.
import { parseSearch } from '@shared/search'
import type { Album, AlbumDetail, BrowseGroup, Game, GroupBy, ID, SortBy } from '@shared/types'
import { ghost } from '../../ghost'

export const PAGE_SIZE = 100
/** Albums per request of a group's album list: platform and year buckets hold thousands, the rest load as the carousel nears the end. */
export const ALBUM_PAGE = 500

// Cache bounds. The model lives for the whole session, and random jumps (F2) through a 93k-game
// catalog would otherwise keep every page, album list and track list ever seen (details were
// never dropped, not even on a new query). Evicted entries simply refetch when needed again.
/** Pages of groups kept per query (the ones nearest the carousel's view survive). */
const MAX_PAGES = 48
/** Album lists (per group) kept per query. */
const MAX_ALBUM_LISTS = 300
/** Album details (track lists), least recently used dropped first. */
const MAX_DETAILS = 160
/** A track list that failed to load isn't fetched again on its own before this (moving onto it again). */
const DETAIL_RETRY_MS = 15_000
/** Likewise a group's album list (or its next page). */
const ALBUMS_RETRY_MS = 15_000
const MAX_GAMES = 600

/** Map insertion order as recency: move `key` to the back. */
function touch<K, V>(m: Map<K, V>, key: K, v: V): void {
  m.delete(key)
  m.set(key, v)
}

export interface BrowseQueryState {
  text: string
  group: GroupBy
  sort: SortBy
}

export type ModelEvent =
  /** The query changed: every group is unknown until the first page arrives. */
  | { type: 'reset' }
  | { type: 'total'; total: number }
  | { type: 'page'; page: number }
  | { type: 'albums'; key: string }
  | { type: 'detail'; albumId: string }
  | { type: 'game'; gameId: string }
  | { type: 'error'; message: string }
  /** Likes or downloads changed under a query filtering on them (or for unnamed tracks): what's shown may be out of date. */
  | { type: 'stale' }

type Listener = (e: ModelEvent) => void

/** A group's albums as far as they're loaded, and how many it has. */
interface AlbumList {
  albums: Album[]
  total: number
}

/** A group's album list fetch: from the top (offset 0, replacing the list) or its next page. */
interface AlbumJob {
  offset: number
  p: Promise<Album[] | null>
}

const sameQuery = (a: BrowseQueryState, b: BrowseQueryState) => a.text === b.text && a.group === b.group && a.sort === b.sort

export class BrowseModel {
  query: BrowseQueryState = { text: '', group: 'game', sort: 'title' }
  /** Bumps on every query change; stale responses are dropped. */
  gen = 0
  total: number | null = null
  /** True until the first page of the current query arrives. */
  loading = false
  /** Last catalog revision this data reflects. */
  revision: number | null = null
  /** Set once anything has been fetched (so re-entering Browse restores instantly). */
  started = false
  /** The current query's first page failed (the catalog couldn't be read): why. */
  pageError: string | null = null
  /** What's loaded went out of date ('stale') and no carousel has refetched it yet: the next one does when it mounts. */
  needsRefresh = false

  private pages = new Map<number, BrowseGroup[]>()
  private pagePending = new Map<number, number>()
  private stalePages = new Set<number>()
  private albums = new Map<string, AlbumList>()
  private albumsPending = new Map<string, AlbumJob>()
  private staleAlbums = new Set<string>()
  /** Album lists (`more`: their next page) that failed: shown as such, and not fetched again on their own for a while. */
  private albumErrors = new Map<string, { message: string; at: number; more: boolean }>()
  private details = new Map<string, AlbumDetail>()
  private detailsPending = new Map<string, Promise<AlbumDetail | null>>()
  private staleDetails = new Set<string>()
  /** When each pending album list / track list fetch started (epoch ms), for progress estimates. */
  private albumsStarted = new Map<string, number>()
  private detailStarted = new Map<string, number>()
  /** Track lists that failed to load: shown as such, and not fetched again on their own for a while. */
  private detailErrors = new Map<string, { message: string; at: number }>()
  private games = new Map<string, Game | null>()
  private gamesPending = new Set<string>()
  private listeners = new Set<Listener>()
  /** Centre of the last ensureGroups() range: page eviction keeps what's near it. */
  private focusPage = 0
  /** The current query's first page (settled() waits for it). */
  private firstPage: Promise<void> = Promise.resolve()
  /** Bumps on every like/download change: a track list fetched across one may carry old flags. */
  private libraryEpoch = 0
  /** The flag lookup each changed track waits on (a slower, older answer is dropped). */
  private flagAsked = new Map<string, number>()
  private flagSeq = 0
  private unwatch: (() => void) | null = null

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private emit(e: ModelEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e)
      } catch (err) {
        console.error('[browse] model listener threw', err)
      }
    }
  }

  // ---------------------------------------------------------------- query / pages

  /** Change the query. Returns a promise for the first page. No-op if unchanged (unless `force`). */
  setQuery(q: BrowseQueryState, force = false): Promise<void> {
    if (!force && this.started && sameQuery(q, this.query)) return Promise.resolve()
    this.watchLibrary()
    this.started = true
    this.query = { ...q }
    this.gen++
    this.total = null
    this.loading = true
    this.pageError = null
    this.pages.clear()
    this.pagePending.clear()
    this.stalePages.clear()
    this.albums.clear()
    this.albumsPending.clear()
    this.albumsStarted.clear()
    this.staleAlbums.clear()
    this.albumErrors.clear()
    this.emit({ type: 'reset' })
    return (this.firstPage = this.loadPage(0))
  }

  /** Resolves once the current query's first page is in (or failed): at once when it already is. */
  settled(): Promise<void> {
    return this.loading ? this.firstPage : Promise.resolve()
  }

  /** Re-run the current query (e.g. after an import). Keeps nothing. */
  reload(): Promise<void> {
    return this.setQuery(this.query, true)
  }

  group(i: number): BrowseGroup | null {
    const p = this.pages.get(Math.floor(i / PAGE_SIZE))
    return p?.[i % PAGE_SIZE] ?? null
  }

  hasPage(p: number): boolean {
    return this.pages.has(p)
  }

  /** Ask for every page touching [from, to]. */
  ensureGroups(from: number, to: number): void {
    if (this.total === null) return
    const last = Math.max(0, Math.ceil(this.total / PAGE_SIZE) - 1)
    const a = Math.max(0, Math.floor(from / PAGE_SIZE))
    const b = Math.min(last, Math.floor(Math.max(from, to) / PAGE_SIZE))
    this.focusPage = (a + b) >> 1
    for (let p = a; p <= b; p++) {
      if ((!this.pages.has(p) || this.stalePages.has(p)) && this.pagePending.get(p) !== this.gen) void this.loadPage(p)
    }
  }

  /** Resolve once the page containing group `i` is loaded. */
  async loadGroup(i: number): Promise<BrowseGroup | null> {
    const p = Math.floor(i / PAGE_SIZE)
    if (!this.pages.has(p)) await this.loadPage(p)
    return this.group(i)
  }

  private async loadPage(p: number): Promise<void> {
    const gen = this.gen
    this.pagePending.set(p, gen)
    try {
      const res = await ghost().catalog.browse({ ...this.query, offset: p * PAGE_SIZE, limit: PAGE_SIZE })
      if (gen !== this.gen) return
      this.pagePending.delete(p)
      this.stalePages.delete(p)
      this.pages.set(p, res.groups)
      this.trimPages(p)
      const totalChanged = this.total !== res.total
      this.total = res.total
      this.loading = false
      this.pageError = null
      if (totalChanged) this.emit({ type: 'total', total: res.total })
      this.emit({ type: 'page', page: p })
    } catch (err) {
      if (gen !== this.gen) return
      this.pagePending.delete(p)
      this.loading = false
      if (this.total === null) {
        this.pageError = err instanceof Error ? err.message : String(err)
        this.total = 0
        this.emit({ type: 'total', total: 0 })
      }
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Drop the pages farthest from the view (never the one just loaded or its neighbours). */
  private trimPages(keep: number): void {
    if (this.pages.size <= MAX_PAGES) return
    const far = [...this.pages.keys()]
      .filter((p) => Math.abs(p - this.focusPage) > 2 && p !== keep)
      .sort((x, y) => Math.abs(y - this.focusPage) - Math.abs(x - this.focusPage))
    for (const p of far.slice(0, this.pages.size - MAX_PAGES)) {
      this.pages.delete(p)
      this.stalePages.delete(p)
    }
  }

  /** Index of a group key among the pages loaded so far (`fresh`: only those no refresh still waits on), or -1. */
  findLoaded(key: string, fresh = false): number {
    for (const [p, groups] of this.pages) {
      if (fresh && this.stalePages.has(p)) continue
      const i = groups.findIndex((g) => g.key === key)
      if (i >= 0) return p * PAGE_SIZE + i
    }
    return -1
  }

  /** Page `p` is loaded and current (no refresh waits on it). */
  isFresh(p: number): boolean {
    return this.pages.has(p) && !this.stalePages.has(p)
  }

  /** Some page of the current query is on its way. */
  pagesPending(): boolean {
    for (const gen of this.pagePending.values()) if (gen === this.gen) return true
    return false
  }

  /** Scan pages (loading them as needed, up to `maxPages`) for a group key. */
  async locate(key: string, maxPages = 40): Promise<number> {
    const hit = this.findLoaded(key)
    if (hit >= 0) return hit
    const gen = this.gen
    if (this.total === null) await this.loadPage(0)
    const pages = Math.min(maxPages, Math.ceil((this.total ?? 0) / PAGE_SIZE))
    for (let p = 0; p < pages; p++) {
      if (gen !== this.gen) return -1
      if (!this.pages.has(p)) await this.loadPage(p)
      const i = this.pages.get(p)?.findIndex((g) => g.key === key) ?? -1
      if (i >= 0) return p * PAGE_SIZE + i
    }
    return -1
  }

  // ---------------------------------------------------------------- albums / details

  /** Albums in a group, as far as they're loaded (synchronous; starts a fetch and returns undefined while loading). */
  albumsFor(key: string): Album[] | undefined {
    const have = this.albums.get(key)
    if ((!have || this.staleAlbums.has(key)) && !this.albumsPending.has(key) && !this.albumsError(key)) void this.fetchAlbums(key, 0)
    if (have) touch(this.albums, key, have)
    return have?.albums
  }

  /** How many albums the group has (albumsFor() holds fewer until the rest is paged in), or null before its list loads. */
  albumsTotal(key: string): number | null {
    return this.albums.get(key)?.total ?? null
  }

  /** The group has albums beyond those loaded. */
  hasMoreAlbums(key: string): boolean {
    const have = this.albums.get(key)
    return !!have && have.albums.length < have.total
  }

  /** The carousel nears the end of a group's loaded albums: fetch the next ones. */
  moreAlbums(key: string): void {
    const have = this.albums.get(key)
    if (!have || have.albums.length >= have.total || this.staleAlbums.has(key) || this.albumsPending.has(key) || this.albumsError(key)) return
    void this.fetchAlbums(key, have.albums.length)
  }

  isAlbumsLoading(key: string): boolean {
    return this.albumsPending.has(key) && !this.albums.has(key)
  }

  /** The group's albums, fetched when not loaded (or out of date). Asked for deliberately: a recent failure is tried again at once. */
  loadAlbums(key: string): Promise<Album[] | null> {
    const have = this.albums.get(key)
    if (have && !this.staleAlbums.has(key)) return Promise.resolve(have.albums)
    const retry = this.albumErrors.delete(key)
    const p = this.fetchAlbums(key, 0)
    // rows that said it failed show the wait instead
    if (retry) this.emit({ type: 'albums', key })
    return p
  }

  /** Why the group's album list (`more`: its next page) couldn't be loaded, if that happened recently (loadAlbums tries again). */
  albumsError(key: string): { message: string; more: boolean } | null {
    const e = this.albumErrors.get(key)
    if (!e) return null
    if (Date.now() - e.at < ALBUMS_RETRY_MS) return e
    this.albumErrors.delete(key)
    return null
  }

  /** Try a failed album list (or its next page) again now (rows waiting on it show the wait instead of the failure). */
  retryAlbums(key: string): void {
    const e = this.albumErrors.get(key)
    if (!e) return
    this.albumErrors.delete(key)
    if (e.more) this.moreAlbums(key)
    else void this.fetchAlbums(key, 0)
    this.emit({ type: 'albums', key })
  }

  private fetchAlbums(key: string, offset: number): Promise<Album[] | null> {
    // A refetch from the top replaces a next page on its way; anything else joins the fetch running.
    const pending = this.albumsPending.get(key)
    if (pending && (pending.offset === 0 || offset > 0)) return pending.p
    const have = this.albums.get(key)
    // From the top, as many as are loaded already: a refresh keeps the carousel's place in a long list.
    const limit = offset ? ALBUM_PAGE : Math.max(ALBUM_PAGE, have?.albums.length ?? 0)
    const job: AlbumJob = { offset, p: Promise.resolve(null) }
    job.p = ghost()
      .catalog.groupAlbumPage(key, this.query, offset, limit)
      .then(
        (page) => {
          if (this.albumsPending.get(key) !== job) return null
          this.albumsPending.delete(key)
          this.albumsStarted.delete(key)
          this.albumErrors.delete(key)
          const cur = this.albums.get(key)
          if (offset && !cur) return null
          let albums = page.albums
          if (cur && offset) {
            // Albums added above since the list loaded push some onto this page again: not listed
            // twice, and the list is fetched again from the top when next shown.
            const seen = new Set(cur.albums.map((a) => a.id))
            const fresh = page.albums.filter((a) => !seen.has(a.id))
            if (fresh.length < page.albums.length) this.staleAlbums.add(key)
            albums = [...cur.albums, ...fresh]
          } else this.staleAlbums.delete(key)
          touch(this.albums, key, { albums, total: Math.max(page.total, albums.length) })
          this.trim(this.albums, MAX_ALBUM_LISTS, this.staleAlbums)
          this.emit({ type: 'albums', key })
          return albums
        },
        (err) => {
          if (this.albumsPending.get(key) !== job) return null
          this.albumsPending.delete(key)
          this.albumsStarted.delete(key)
          const message = err instanceof Error ? err.message : String(err)
          // Not an empty list: rows say it failed (a list loaded before stays), and it's tried again later.
          if (this.albumErrors.size > 200) this.albumErrors.clear()
          this.albumErrors.set(key, { message, at: Date.now(), more: offset > 0 })
          this.emit({ type: 'albums', key })
          this.emit({ type: 'error', message })
          return null
        }
      )
    this.albumsPending.set(key, job)
    this.albumsStarted.set(key, Date.now())
    return job.p
  }

  detailFor(albumId: string): AlbumDetail | undefined {
    const have = this.details.get(albumId)
    if ((!have || this.staleDetails.has(albumId)) && !this.detailsPending.has(albumId) && !this.detailError(albumId)) void this.loadDetail(albumId)
    if (have) touch(this.details, albumId, have)
    return have
  }

  peekDetail(albumId: string): AlbumDetail | undefined {
    return this.details.get(albumId)
  }

  /** The album's track list is cached and current (loadDetail answers without fetching). */
  hasDetail(albumId: string): boolean {
    return this.details.has(albumId) && !this.staleDetails.has(albumId)
  }

  /** Why the album's track list couldn't be loaded, if that happened recently (an explicit loadDetail tries again). */
  detailError(albumId: string): string | null {
    const e = this.detailErrors.get(albumId)
    if (!e) return null
    if (Date.now() - e.at < DETAIL_RETRY_MS) return e.message
    this.detailErrors.delete(albumId)
    return null
  }

  /** When the pending fetch of an album's track list started (epoch ms), or null if none is pending. */
  detailSince(albumId: string): number | null {
    return this.detailStarted.get(albumId) ?? null
  }

  /** When the pending fetch of a group's album list (or its next page) started (epoch ms), or null if none is pending. */
  albumsSince(key: string): number | null {
    return this.albumsPending.has(key) ? (this.albumsStarted.get(key) ?? null) : null
  }

  /** When the pending fetch of a long list's next albums started (epoch ms), or null if none is pending. */
  moreSince(key: string): number | null {
    return (this.albumsPending.get(key)?.offset ?? 0) > 0 ? (this.albumsStarted.get(key) ?? null) : null
  }

  /** Keep `m` to `max` entries, dropping the least recently stored/used. */
  private trim<V>(m: Map<string, V>, max: number, stale?: Set<string>): void {
    for (const k of m.keys()) {
      if (m.size <= max) break
      m.delete(k)
      stale?.delete(k)
    }
  }

  loadDetail(albumId: string): Promise<AlbumDetail | null> {
    const have = this.details.get(albumId)
    if (have && !this.staleDetails.has(albumId)) return Promise.resolve(have)
    const pending = this.detailsPending.get(albumId)
    if (pending) return pending
    const epoch = this.libraryEpoch
    const p = ghost()
      .catalog.album(albumId)
      .then((d) => {
        this.detailsPending.delete(albumId)
        this.detailStarted.delete(albumId)
        this.detailErrors.delete(albumId)
        this.staleDetails.delete(albumId)
        // likes or downloads changed while it was on its way: its flags may be old (refetched when next needed)
        if (epoch !== this.libraryEpoch) this.staleDetails.add(albumId)
        touch(this.details, albumId, d)
        this.trim(this.details, MAX_DETAILS, this.staleDetails)
        this.emit({ type: 'detail', albumId })
        return d
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        this.detailsPending.delete(albumId)
        this.detailStarted.delete(albumId)
        if (this.detailErrors.size > 200) this.detailErrors.clear()
        this.detailErrors.set(albumId, { message, at: Date.now() })
        // Rows waiting on it stop loading (they say it failed).
        this.emit({ type: 'detail', albumId })
        this.emit({ type: 'error', message })
        return null
      })
    this.detailsPending.set(albumId, p)
    this.detailStarted.set(albumId, Date.now())
    return p
  }

  /** Try a track list that failed again now (rows waiting on it show the wait instead of the failure). */
  retryDetail(albumId: string): Promise<AlbumDetail | null> {
    this.detailErrors.delete(albumId)
    const p = this.loadDetail(albumId)
    this.emit({ type: 'detail', albumId })
    return p
  }

  /** Patch a track in every cached detail holding it (likes, downloads) without refetching. */
  patchTrack(trackId: string, patch: Partial<{ liked: boolean; downloaded: boolean }>): string | null {
    let first: string | null = null
    for (const [albumId, d] of this.details) {
      const i = d.tracks.findIndex((t) => t.id === trackId)
      if (i < 0) continue
      first ??= albumId
      const t = d.tracks[i]
      if ((patch.liked ?? t.liked) === t.liked && (patch.downloaded ?? t.downloaded) === t.downloaded) continue
      const tracks = d.tracks.slice()
      tracks[i] = { ...t, ...patch }
      this.details.set(albumId, { ...d, tracks })
      this.emit({ type: 'detail', albumId })
    }
    return first
  }

  // ---------------------------------------------------------------- likes / downloads (anywhere in the app)

  /** Hear library changes for as long as the model lives (Browse shown or not). */
  private watchLibrary(): void {
    if (this.unwatch) return
    this.unwatch = ghost().on('library:changed', (e) => this.libraryChanged(e.kind, e.id))
  }

  /** A track's like or download changed (no `trackId`: some tracks'). */
  libraryChanged(kind: string, trackId?: ID): void {
    if (kind !== 'likes' && kind !== 'downloaded') return
    this.libraryEpoch++
    const key = kind === 'likes' ? 'liked' : 'downloaded'
    // A query filtering on the flag may now match other groups and albums; unknown tracks: refetch what's shown.
    if (!trackId || parseSearch(this.query.text).filters.some((f) => f.key === key)) this.invalidate()
    if (trackId) void this.refreshFlags(trackId)
  }

  /** Results may no longer match the query: the carousel refetches what it shows now (or when Browse is next shown). */
  private invalidate(): void {
    for (const p of this.pages.keys()) this.stalePages.add(p)
    for (const k of this.albums.keys()) this.staleAlbums.add(k)
    this.needsRefresh = true
    this.emit({ type: 'stale' })
  }

  /** Read a changed track's flags and patch every cached copy; a track list it can't patch refetches when next needed. */
  private async refreshFlags(trackId: ID): Promise<void> {
    const seq = ++this.flagSeq
    this.flagAsked.set(trackId, seq)
    let t: { liked: boolean; downloaded: boolean } | undefined
    try {
      ;[t] = await ghost().catalog.tracks([trackId])
    } catch {
      t = undefined
    }
    if (this.flagAsked.get(trackId) !== seq) return
    this.flagAsked.delete(trackId)
    if (t) {
      this.patchTrack(trackId, { liked: t.liked, downloaded: t.downloaded })
      return
    }
    for (const [albumId, d] of this.details) {
      if (!d.tracks.some((x) => x.id === trackId)) continue
      this.staleDetails.add(albumId)
      this.emit({ type: 'detail', albumId })
    }
  }

  // ---------------------------------------------------------------- games (original titles)

  game(gameId: string): Game | null | undefined {
    if (!this.games.has(gameId) && !this.gamesPending.has(gameId)) {
      this.gamesPending.add(gameId)
      ghost()
        .catalog.game(gameId)
        .then((g) => {
          this.gamesPending.delete(gameId)
          this.games.set(gameId, g)
          this.trim(this.games, MAX_GAMES)
          this.emit({ type: 'game', gameId })
        })
        .catch(() => {
          this.gamesPending.delete(gameId)
          this.games.set(gameId, null)
        })
    }
    return this.games.get(gameId)
  }

  /** The original-language title of a game, if the catalog knows one (non-Latin alt name). */
  originalTitle(gameId: string | null, name: string): string | null {
    if (!gameId) return null
    const g = this.game(gameId)
    if (!g) return null
    return pickOriginal(name, g.altNames)
  }

  // ---------------------------------------------------------------- revision refresh

  /**
   * Catalog data changed underneath us: refetch loaded pages (keeping the old data on screen
   * until the new arrives) and mark albums/details stale so they refetch when next needed.
   */
  refresh(visiblePages: number[], keepAlbums: string[], keepDetails: string[]): void {
    this.needsRefresh = false
    for (const p of this.pages.keys()) this.stalePages.add(p)
    for (const k of this.albums.keys()) this.staleAlbums.add(k)
    for (const k of this.details.keys()) this.staleDetails.add(k)
    for (const p of visiblePages) if (this.pagePending.get(p) !== this.gen) void this.loadPage(p)
    if (!visiblePages.length) void this.loadPage(0)
    for (const k of keepAlbums) void this.loadAlbums(k)
    for (const id of keepDetails) void this.loadDetail(id)
  }
}

const NON_LATIN = /[぀-ヿ㐀-鿿가-힯Ѐ-ӿ฀-๿]/

/** Prefer an alt name in a non-Latin script (the original Japanese/Korean/Chinese title). */
export function pickOriginal(name: string, alts: string[]): string | null {
  const hit = alts.find((a) => a && a !== name && NON_LATIN.test(a))
  return hit ?? null
}

/** The single model instance (module scope = survives re-entering Browse). */
export const browseModel = new BrowseModel()
