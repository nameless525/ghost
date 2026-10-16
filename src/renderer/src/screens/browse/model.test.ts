import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALBUM_PAGE, BrowseModel, type BrowseQueryState, type ModelEvent } from './model'
import { album, albumPagesOf, deferred, detail, flush, installGhost, pagesOf } from './testing'

const query = (text = ''): BrowseQueryState => ({ text, group: 'game', sort: 'title' })

let ghost: ReturnType<typeof installGhost>
beforeEach(() => {
  ghost = installGhost()
  ghost.api.catalog.browse.mockImplementation(pagesOf(() => ['game:1', 'game:2']))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('album lists', () => {
  it('a failed album list is a failure, not an empty group; asked for deliberately it is tried again at once', async () => {
    const m = new BrowseModel()
    await m.setQuery(query())
    const albums = [album('a1'), album('a2')]
    ghost.api.catalog.groupAlbumPage.mockRejectedValueOnce(new Error('The catalog worker was replaced.')).mockImplementation(albumPagesOf(() => albums))

    expect(m.albumsFor('game:1')).toBeUndefined()
    await flush()
    // still nothing (not []), with why; moving onto it again doesn't hammer the catalog
    expect(m.albumsFor('game:1')).toBeUndefined()
    expect(m.albumsError('game:1')).toMatchObject({ message: 'The catalog worker was replaced.', more: false })
    expect(ghost.api.catalog.groupAlbumPage).toHaveBeenCalledTimes(1)

    // Play / Enter on it: straight away
    expect(await m.loadAlbums('game:1')).toEqual(albums)
    expect(m.albumsError('game:1')).toBeNull()
    expect(m.albumsFor('game:1')).toEqual(albums)
  })

  it('a failed album list is fetched again on its own after a while', async () => {
    const m = new BrowseModel()
    await m.setQuery(query())
    ghost.api.catalog.groupAlbumPage.mockRejectedValueOnce(new Error('busy')).mockImplementation(albumPagesOf(() => [album('a1')]))
    m.albumsFor('game:1')
    await flush()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 16_000)
    m.albumsFor('game:1')
    await flush()
    expect(m.albumsFor('game:1')).toEqual([album('a1')])
  })

  it('a retry keeps the list loaded before when the refetch of a stale one fails', async () => {
    const m = new BrowseModel()
    await m.setQuery(query())
    ghost.api.catalog.groupAlbumPage.mockImplementation(albumPagesOf(() => [album('a1')]))
    await m.loadAlbums('game:1')
    m.refresh([], [], [])
    ghost.api.catalog.groupAlbumPage.mockRejectedValueOnce(new Error('busy'))
    m.albumsFor('game:1')
    await flush()
    expect(m.albumsFor('game:1')).toEqual([album('a1')])
  })

  it('pages through a group of more than 1,000 albums: the total is known, the rest loads on request', async () => {
    const m = new BrowseModel()
    await m.setQuery(query())
    const all = Array.from({ length: 1234 }, (_, i) => album(`b${i}`))
    ghost.api.catalog.groupAlbumPage.mockImplementation(albumPagesOf(() => all))

    expect(await m.loadAlbums('platform:snes')).toHaveLength(ALBUM_PAGE)
    expect(m.albumsTotal('platform:snes')).toBe(1234)
    expect(m.hasMoreAlbums('platform:snes')).toBe(true)

    while (m.hasMoreAlbums('platform:snes')) {
      m.moreAlbums('platform:snes')
      m.moreAlbums('platform:snes') // (once per page)
      await flush()
    }
    const loaded = m.albumsFor('platform:snes')!
    expect(loaded).toHaveLength(1234)
    expect(loaded.at(-1)!.id).toBe('b1233')
    expect(ghost.api.catalog.groupAlbumPage.mock.calls.map((c) => c[2])).toEqual([0, 500, 1000])
  })

  it('a next page never lists an album twice; a list that moved meanwhile refetches all that was loaded', async () => {
    const m = new BrowseModel()
    await m.setQuery(query())
    let all = Array.from({ length: 600 }, (_, i) => album(`c${i}`))
    ghost.api.catalog.groupAlbumPage.mockImplementation(albumPagesOf(() => all))
    await m.loadAlbums('year:1995')
    // an album added within the first page: the second page starts with one already listed
    all = [...all.slice(0, 3), album('new'), ...all.slice(3)]
    m.moreAlbums('year:1995')
    await flush()
    const ids = m.albumsFor('year:1995')!.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(600)
    // (that albumsFor() asked for the list again from the top, as many as were loaded)
    expect(ghost.api.catalog.groupAlbumPage.mock.calls.at(-1)!.slice(2)).toEqual([0, 600])
    await flush()
    m.moreAlbums('year:1995')
    await flush()
    expect(m.albumsFor('year:1995')!.map((a) => a.id)).toEqual(all.map((a) => a.id))
    expect(m.hasMoreAlbums('year:1995')).toBe(false)
  })
})

describe('query results', () => {
  it('settled() waits for the first page of the query being run', async () => {
    const m = new BrowseModel()
    await m.setQuery(query())
    const page = deferred<{ total: number; offset: number; groups: [] }>()
    ghost.api.catalog.browse.mockReturnValueOnce(page.promise)
    void m.setQuery(query('beta'))
    let done = false
    void m.settled().then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    page.resolve({ total: 0, offset: 0, groups: [] })
    await flush()
    expect(done).toBe(true)
  })
})

describe('likes and downloads changed anywhere', () => {
  it('patches every cached copy of the track, while nothing in Browse shows it', async () => {
    const m = new BrowseModel()
    await m.setQuery(query())
    const a = album('a')
    const b = album('b')
    ghost.api.catalog.album.mockImplementation(async (id) => (id === 'a' ? detail(a, ['t1', 't2']) : detail(b, ['t9', 't1'])))
    await m.loadDetail('a')
    await m.loadDetail('b')
    ghost.api.catalog.tracks.mockResolvedValue([{ ...detail(a, ['t1']).tracks[0], liked: true, downloaded: true }])

    ghost.emit('library:changed', { kind: 'likes', id: 't1' })
    await flush()
    for (const id of ['a', 'b']) {
      const t = m.peekDetail(id)!.tracks.find((x) => x.id === 't1')!
      expect(t).toMatchObject({ liked: true, downloaded: true })
      expect(m.hasDetail(id)).toBe(true)
    }
  })

  it('a slower, older flag lookup does not undo a newer one', async () => {
    const m = new BrowseModel()
    await m.setQuery(query())
    const a = album('a')
    ghost.api.catalog.album.mockResolvedValue(detail(a, ['t1']))
    await m.loadDetail('a')
    const first = deferred<ReturnType<typeof detail>['tracks']>()
    const t1 = detail(a, ['t1']).tracks[0]
    ghost.api.catalog.tracks.mockReturnValueOnce(first.promise).mockResolvedValueOnce([{ ...t1, liked: false }])
    ghost.emit('library:changed', { kind: 'likes', id: 't1' })
    ghost.emit('library:changed', { kind: 'likes', id: 't1' })
    await flush()
    first.resolve([{ ...t1, liked: true }])
    await flush()
    expect(m.peekDetail('a')!.tracks[0].liked).toBe(false)
  })

  it('a track list fetched across a change is refetched when next needed', async () => {
    const m = new BrowseModel()
    await m.setQuery(query())
    const slow = deferred<ReturnType<typeof detail>>()
    ghost.api.catalog.album.mockReturnValueOnce(slow.promise)
    const p = m.loadDetail('a')
    ghost.emit('library:changed', { kind: 'downloaded', id: 'a-1' })
    slow.resolve(detail(album('a'), ['a-1']))
    await p
    expect(m.hasDetail('a')).toBe(false)
  })

  it('a query filtering on likes goes stale (refetched now, or when Browse is next shown)', async () => {
    const m = new BrowseModel()
    const events: ModelEvent['type'][] = []
    m.subscribe((e) => events.push(e.type))
    await m.setQuery(query('liked=yes'))
    ghost.api.catalog.groupAlbumPage.mockImplementation(albumPagesOf(() => [album('a1')]))
    await m.loadAlbums('game:1')

    ghost.emit('library:changed', { kind: 'likes', id: 't1' })
    expect(events).toContain('stale')
    expect(m.needsRefresh).toBe(true)
    expect(m.isFresh(0)).toBe(false)
    const calls = ghost.api.catalog.groupAlbumPage.mock.calls.length
    m.albumsFor('game:1')
    expect(ghost.api.catalog.groupAlbumPage.mock.calls.length).toBe(calls + 1)

    // the carousel refetching what it shows (refreshData) settles it
    m.refresh([0], ['game:1'], [])
    expect(m.needsRefresh).toBe(false)
  })

  it('a query not filtering on the flag keeps its results', async () => {
    const m = new BrowseModel()
    const events: ModelEvent['type'][] = []
    m.subscribe((e) => events.push(e.type))
    await m.setQuery(query('composer=uematsu'))
    ghost.emit('library:changed', { kind: 'downloaded', id: 't1' })
    expect(events).not.toContain('stale')
    expect(m.isFresh(0)).toBe(true)
    // (history and playlists don't concern Browse)
    ghost.emit('library:changed', { kind: 'history', id: 't1' })
    expect(ghost.api.catalog.tracks).toHaveBeenCalledTimes(1)
  })
})
