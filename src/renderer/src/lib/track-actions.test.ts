import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogStatus, Playlist } from '@shared/types'

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const state = { liked: 0, revision: 1, extra: [] as unknown[] }
  const api = {
    on: (event: string, cb: (payload: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(cb)
      return () => listeners.get(event)!.delete(cb)
    },
    catalog: { status: async () => ({ revision: state.revision }) },
    library: { playlists: { list: async () => [] as unknown[] } }
  }
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((cb) => cb(payload))
  return { api, emit, listeners, state }
})
vi.mock('../ghost', () => ({ ghost: () => h.api }))

const smart = (trackCount: number): Playlist => ({
  id: 'liked-smart',
  name: 'Everything I like',
  description: null,
  kind: 'smart',
  query: 'liked=true',
  trackCount,
  durationMs: trackCount * 60000,
  covers: [],
  createdAt: 0,
  updatedAt: 0
})

let list: ReturnType<typeof vi.fn>

async function load() {
  vi.resetModules()
  const m = await import('./track-actions')
  m.initPlaylistCache()
  await vi.advanceTimersByTimeAsync(0)
  return m
}

describe('playlist cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    h.listeners.clear()
    h.state.liked = 0
    h.state.revision = 1
    list = vi.fn(async () => [smart(h.state.liked)])
    h.api.library.playlists.list = list as never
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a smart card follows likes while the Playlists tab shows', async () => {
    const m = await load()
    const release = m.watchPlaylistCache()
    expect(m.usePlaylistCache.getState().playlists[0].trackCount).toBe(0)
    h.state.liked = 1
    h.emit('library:changed', { kind: 'likes', id: 't1' })
    h.emit('library:changed', { kind: 'likes', id: 't2' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(list).toHaveBeenCalledTimes(2)
    expect(m.usePlaylistCache.getState().playlists[0].trackCount).toBe(1)
    release()
  })

  it('refetches a change made while nobody looked as soon as the cards show', async () => {
    const m = await load()
    h.state.liked = 3
    h.emit('library:changed', { kind: 'downloaded' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(list).toHaveBeenCalledTimes(1)
    const release = m.watchPlaylistCache()
    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledTimes(2)
    expect(m.usePlaylistCache.getState().playlists[0].trackCount).toBe(3)
    // nothing new since: showing them again costs nothing
    release()
    m.watchPlaylistCache()
    await vi.advanceTimersByTimeAsync(5000)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('catalog revisions refresh, coalesced while indexing ticks them', async () => {
    const m = await load()
    m.watchPlaylistCache()
    const status = (revision: number) => h.emit('catalog:status', { revision } as CatalogStatus)
    status(1) // the revision the first fetch already reflects
    await vi.advanceTimersByTimeAsync(5000)
    expect(list).toHaveBeenCalledTimes(1)
    // a revision every 100 ms for 1.5 s: one refetch a second at most, the last one included
    for (let r = 2; r < 17; r++) {
      status(r)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(list).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('ignores history, and likes when no playlist is smart', async () => {
    list = vi.fn(async () => [{ ...smart(0), kind: 'manual', query: null }])
    h.api.library.playlists.list = list as never
    const m = await load()
    m.watchPlaylistCache()
    h.emit('library:changed', { kind: 'history' })
    h.emit('library:changed', { kind: 'likes' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(list).toHaveBeenCalledTimes(1)
    // playlist edits still refetch quickly
    h.emit('library:changed', { kind: 'playlists', id: 'liked-smart' })
    await vi.advanceTimersByTimeAsync(80)
    expect(list).toHaveBeenCalledTimes(2)
  })
})
