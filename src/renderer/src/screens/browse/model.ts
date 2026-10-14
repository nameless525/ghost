// Browse data model: paged carousel groups, per-group albums, album details and game rows,
// fetched on demand and cached. Lives at module scope so the carousel's data (and the user's
// place in it) survives leaving and re-entering Browse.
//
// The carousel never awaits anything in its frame loop: it asks for what it needs
// (`ensureGroups`, `albumsFor`, `detailFor`) and gets a synchronous answer (data or
// `undefined` while loading). Arrivals are announced through `subscribe`.
import type { Album, AlbumDetail, BrowseGroup, Game, GroupBy, SortBy } from '@shared/types'
import { ghost } from '../../ghost'

export const PAGE_SIZE = 100

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

type Listener = (e: ModelEvent) => void

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

  private pages = new Map<number, BrowseGroup[]>()
  private pagePending = new Map<number, number>()
  private stalePages = new Set<number>()
  private albums = new Map<string, Album[]>()
  private albumsPending = new Map<string, number>()
  private staleAlbums = new Set<string>()
  private details = new Map<string, AlbumDetail>()
  private detailsPending = new Map<string, Promise<AlbumDetail | null>>()
  private staleDetails = new Set<string>()
  private games = new Map<string, Game | null>()
  private gamesPending = new Set<string>()
  private listeners = new Set<Listener>()

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
    this.started = true
    this.query = { ...q }
    this.gen++
    this.total = null
    this.loading = true
    this.pages.clear()
    this.pagePending.clear()
    this.stalePages.clear()
    this.albums.clear()
    this.albumsPending.clear()
    this.staleAlbums.clear()
    this.emit({ type: 'reset' })
    return this.loadPage(0)
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
      const totalChanged = this.total !== res.total
      this.total = res.total
      this.loading = false
      if (totalChanged) this.emit({ type: 'total', total: res.total })
      this.emit({ type: 'page', page: p })
    } catch (err) {
      if (gen !== this.gen) return
      this.pagePending.delete(p)
      this.loading = false
      if (this.total === null) {
        this.total = 0
        this.emit({ type: 'total', total: 0 })
      }
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Index of a group key among the pages loaded so far, or -1. */
  findLoaded(key: string): number {
    for (const [p, groups] of this.pages) {
      const i = groups.findIndex((g) => g.key === key)
      if (i >= 0) return p * PAGE_SIZE + i
    }
    return -1
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

  /** Albums in a group (synchronous; starts a fetch and returns undefined while loading). */
  albumsFor(key: string): Album[] | undefined {
    const have = this.albums.get(key)
    if ((!have || this.staleAlbums.has(key)) && this.albumsPending.get(key) !== this.gen) void this.loadAlbums(key)
    return have
  }

  isAlbumsLoading(key: string): boolean {
    return this.albumsPending.get(key) === this.gen && !this.albums.has(key)
  }

  async loadAlbums(key: string): Promise<Album[] | null> {
    const have = this.albums.get(key)
    if (have && !this.staleAlbums.has(key)) return have
    const gen = this.gen
    this.albumsPending.set(key, gen)
    try {
      const list = await ghost().catalog.groupAlbums(key, this.query)
      if (gen !== this.gen) return null
      this.albumsPending.delete(key)
      this.staleAlbums.delete(key)
      this.albums.set(key, list)
      this.emit({ type: 'albums', key })
      return list
    } catch (err) {
      if (gen === this.gen) {
        this.albumsPending.delete(key)
        this.albums.set(key, [])
        this.emit({ type: 'albums', key })
        this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
      return null
    }
  }

  detailFor(albumId: string): AlbumDetail | undefined {
    const have = this.details.get(albumId)
    if ((!have || this.staleDetails.has(albumId)) && !this.detailsPending.has(albumId)) void this.loadDetail(albumId)
    return have
  }

  peekDetail(albumId: string): AlbumDetail | undefined {
    return this.details.get(albumId)
  }

  loadDetail(albumId: string): Promise<AlbumDetail | null> {
    const have = this.details.get(albumId)
    if (have && !this.staleDetails.has(albumId)) return Promise.resolve(have)
    const pending = this.detailsPending.get(albumId)
    if (pending) return pending
    const p = ghost()
      .catalog.album(albumId)
      .then((d) => {
        this.detailsPending.delete(albumId)
        this.staleDetails.delete(albumId)
        this.details.set(albumId, d)
        this.emit({ type: 'detail', albumId })
        return d
      })
      .catch((err) => {
        this.detailsPending.delete(albumId)
        this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        return null
      })
    this.detailsPending.set(albumId, p)
    return p
  }

  /** Patch a track inside cached details (likes, downloads) without refetching. */
  patchTrack(trackId: string, patch: Partial<{ liked: boolean; downloaded: boolean }>): string | null {
    for (const [albumId, d] of this.details) {
      const i = d.tracks.findIndex((t) => t.id === trackId)
      if (i >= 0) {
        const tracks = d.tracks.slice()
        tracks[i] = { ...tracks[i], ...patch }
        this.details.set(albumId, { ...d, tracks })
        this.emit({ type: 'detail', albumId })
        return albumId
      }
    }
    return null
  }

  /** Mark one album's detail stale and refetch it (e.g. likes changed elsewhere). */
  refreshDetail(albumId: string): void {
    if (!this.details.has(albumId)) return
    this.staleDetails.add(albumId)
    void this.loadDetail(albumId)
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
