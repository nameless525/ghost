// Test helpers for Browse: fixtures and a fake `window.ghost` whose catalog answers are scripted
// per test (a deferred answer stands for a slow catalog).
import { vi } from 'vitest'
import type { GhostEventName, GhostEvents } from '@shared/api'
import type { Album, AlbumDetail, AlbumPage, BrowseGroup, BrowsePage, BrowseQuery, ID, TrackView } from '@shared/types'
import type { SelInfo } from './store'

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let every settled promise chain run (no timers involved). */
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

export function album(id: ID, extra: Partial<Album> = {}): Album {
  return {
    id,
    gameId: null,
    gameName: null,
    title: `Album ${id}`,
    titleOriginal: null,
    kind: 'ost',
    year: null,
    platforms: [],
    catalogNo: null,
    composers: [],
    cover: null,
    trackCount: null,
    totalMs: null,
    formats: [],
    provider: 'khinsider',
    providerRef: id,
    addedAt: null,
    ...extra
  }
}

export function track(id: ID, albumId: ID, extra: Partial<TrackView> = {}): TrackView {
  return {
    id,
    albumId,
    disc: 1,
    number: 1,
    title: `Track ${id}`,
    titleOriginal: null,
    durationMs: 60_000,
    composers: [],
    albumTitle: `Album ${albumId}`,
    albumKind: 'ost',
    gameId: null,
    gameName: null,
    year: null,
    platforms: [],
    cover: null,
    hero: null,
    accent: null,
    liked: false,
    downloaded: false,
    source: null,
    analysis: null,
    ...extra
  }
}

export function detail(a: Album, trackIds: ID[]): AlbumDetail {
  return { album: a, game: null, tracks: trackIds.map((id, i) => track(id, a.id, { number: i + 1 })) }
}

export function group(key: string, extra: Partial<BrowseGroup> = {}): BrowseGroup {
  const kind = key.slice(0, key.indexOf(':')) as BrowseGroup['kind']
  return { key, kind, title: key, subtitle: null, cover: null, hero: null, accent: null, year: null, platforms: [], albumCount: 1, gameId: null, ...extra }
}

/** A selection as the carousel publishes it. */
export function selOf(g: BrowseGroup, more: Partial<SelInfo> = {}): SelInfo {
  return { id: `0|${g.key}||`, kind: 'group', gi: 0, group: g, albums: null, albumsTotal: null, album: null, detail: null, track: null, trackIndex: -1, ...more }
}

type Handler<E extends GhostEventName> = (payload: GhostEvents[E]) => void

/**
 * A fake GhostAPI with the catalog and player methods Browse uses as mocks (re-script them per
 * test), events sent with `emit`. Installed as `window.ghost` (with real timers on `window`).
 */
export function installGhost() {
  const listeners = new Map<string, Set<Handler<GhostEventName>>>()
  const api = {
    catalog: {
      browse: vi.fn(async (q: BrowseQuery): Promise<BrowsePage> => ({ total: 0, offset: q.offset, groups: [] })),
      groupAlbumPage: vi.fn(async (_key: string, _q: unknown, offset: number, _limit: number): Promise<AlbumPage> => ({ total: 0, offset, albums: [] })),
      album: vi.fn(async (id: ID): Promise<AlbumDetail> => detail(album(id), [`${id}-1`])),
      tracks: vi.fn(async (_ids: ID[]): Promise<TrackView[]> => []),
      game: vi.fn(async () => null)
    },
    player: {
      preview: vi.fn(async () => true),
      stopPreview: vi.fn(async () => {})
    },
    on<E extends GhostEventName>(event: E, cb: Handler<E>): () => void {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(cb as Handler<GhostEventName>)
      return () => void set.delete(cb as Handler<GhostEventName>)
    }
  }
  const emit = <E extends GhostEventName>(event: E, payload: GhostEvents[E]): void => {
    for (const cb of listeners.get(event) ?? []) cb(payload)
  }
  vi.stubGlobal('window', { ghost: api, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
  return { api, emit }
}

/** `browse` answering from a list of group keys (pages of `limit`). */
export function pagesOf(keys: () => string[]): (q: BrowseQuery) => Promise<BrowsePage> {
  return async (q) => {
    const all = keys()
    return { total: all.length, offset: q.offset, groups: all.slice(q.offset, q.offset + q.limit).map((k) => group(k)) }
  }
}

/** `groupAlbumPage` answering from a list of albums. */
export function albumPagesOf(albums: () => Album[]): (key: string, q: unknown, offset: number, limit: number) => Promise<AlbumPage> {
  return async (_key, _q, offset, limit) => {
    const all = albums()
    return { total: all.length, offset, albums: all.slice(offset, offset + limit) }
  }
}
