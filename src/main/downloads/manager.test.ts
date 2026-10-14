import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DownloadItem, Settings } from '../../shared/types'
import type { EngineSource, TagInfo } from '../engine/types'
import { createLibrary } from '../library'
import { FakeCatalog, FakeEngine, fakeBroadcast, flush, httpSource, makeAlbum, makeTrack, memoryDb, testSettings } from '../player/testing'
import { DownloadManager } from './manager'

const managers: DownloadManager[] = []
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose()
  vi.useRealTimers()
})

function setup(opts: { db?: ReturnType<typeof memoryDb>; files?: Set<string>; throttleMs?: number } = {}) {
  const engine = new FakeEngine()
  const catalog = new FakeCatalog()
  catalog.albums.set('al1', makeAlbum('al1', { title: 'Chrono Trigger OSV', year: 1995, trackCount: 6, gameName: 'Chrono Trigger' }))
  for (let i = 1; i <= 6; i++) catalog.addTracks(makeTrack(`t${i}`, { number: i, title: `Song ${i}`, gameName: 'Chrono Trigger', albumTitle: 'Chrono Trigger OSV' }))
  catalog.games.set('g1', { id: 'g1', name: 'Chrono Trigger', altNames: [], year: 1995, platforms: ['SNES'], franchise: null, cover: null, hero: null, logo: null, accent: null, albumCount: 1 })
  const bc = fakeBroadcast()
  const db = opts.db ?? memoryDb()
  const settings: Settings = testSettings((s) => {
    s.library.downloadDir = '/dl'
  })
  const files = opts.files ?? new Set<string>()
  const lib = createLibrary({ db, catalog, broadcast: bc.broadcast, getSettings: () => settings, fileExists: (p) => files.has(p) })
  const shell = { revealed: [] as string[], opened: [] as string[] }
  const dirs: string[] = []
  const dm = new DownloadManager({
    engine,
    catalog,
    library: lib.library,
    playlists: lib.playlists,
    getSettings: () => settings,
    broadcast: bc.broadcast,
    shell: {
      showItemInFolder: (p) => void shell.revealed.push(p),
      openPath: async (p) => {
        shell.opened.push(p)
        return ''
      }
    },
    throttleMs: opts.throttleMs ?? 0,
    fileExists: (p) => files.has(p),
    mkdirp: (d) => void dirs.push(d)
  })
  managers.push(dm)
  engine.onEvent((e) => dm.handleEngineEvent(e))
  const settle = async () => {
    await dm.settled()
    await flush()
  }
  const items = async () => dm.list()
  const byTrack = async (trackId: string) => (await dm.list()).find((d) => d.trackId === trackId)!
  const downloadCall = (i: number) => {
    const [id, source, dest, tags] = engine.callsOf('download')[i] as [string, EngineSource, string, TagInfo]
    return { id, source, dest, tags }
  }
  return { engine, catalog, bc, db, settings, files, lib, dm, shell, dirs, settle, items, byTrack, downloadCall }
}

const statuses = (xs: DownloadItem[]) => Object.fromEntries(xs.map((d) => [d.trackId, d.status]))

describe('DownloadManager', () => {
  it('runs at most 3 downloads at once and names files from the template', async () => {
    const t = setup()
    await t.dm.enqueue({ trackIds: ['t1', 't2', 't3', 't4', 't5'] })
    await t.settle()
    expect(t.engine.callsOf('download')).toHaveLength(3)
    expect(statuses(await t.items())).toEqual({ t1: 'downloading', t2: 'downloading', t3: 'downloading', t4: 'queued', t5: 'queued' })
    const first = t.downloadCall(0)
    expect(first.dest).toBe('/dl/Chrono Trigger/Chrono Trigger OSV (1995)/1-01 Song 1.mp3')
    expect(first.source).toEqual(httpSource('t1', 'a').source)
    expect(first.tags).toMatchObject({ title: 'Song 1', album: 'Chrono Trigger OSV', albumArtist: 'Chrono Trigger', genre: 'Video Game', comment: 'GHOST', trackNumber: 1, trackTotal: 6, year: 1995 })
    expect(t.dirs).toContain('/dl/Chrono Trigger/Chrono Trigger OSV (1995)')
    expect(t.catalog.resolveCalls[0].opts).toMatchObject({ quality: 'lossless' })
    // list order: newest batch first, tracks in enqueue order within it
    expect((await t.items()).map((d) => d.trackId)).toEqual(['t1', 't2', 't3', 't4', 't5'])
  })

  it('tracks progress, completes, records the download and starts the next queued item', async () => {
    const t = setup()
    await t.dm.enqueue({ trackIds: ['t1', 't2', 't3', 't4'] })
    await t.settle()
    const { id, dest } = t.downloadCall(0)
    t.engine.emit({ type: 'download', downloadId: id, status: 'progress', bytes: 2_500_000, totalBytes: 5_000_000 })
    let d = await t.byTrack('t1')
    expect(d.progress).toBeCloseTo(0.5)
    expect(d.totalBytes).toBe(5_000_000)
    t.engine.emit({ type: 'download', downloadId: id, status: 'progress', bytes: 5_000_000, totalBytes: 5_000_000 })
    expect((await t.byTrack('t1')).status).toBe('tagging')
    t.files.add(dest)
    t.engine.emit({ type: 'download', downloadId: id, status: 'done', bytes: 5_000_000, totalBytes: 5_000_000, path: dest })
    await t.settle()
    d = await t.byTrack('t1')
    expect(d).toMatchObject({ status: 'done', progress: 1, path: dest, error: null })
    expect(t.lib.library.downloadedPath('t1')).toBe(dest)
    expect(t.lib.library.decorateOne(makeTrack('t1')).downloaded).toBe(true)
    expect(t.bc.of('library:changed')).toContainEqual({ kind: 'downloaded', id: 't1' })
    expect(t.engine.callsOf('download')).toHaveLength(4) // t4 started
    expect(t.bc.last('downloads:changed')!.find((x) => x.trackId === 't1')!.status).toBe('done')
  })

  it('falls back to the next source on an engine error, then fails with a notification', async () => {
    const t = setup()
    await t.dm.enqueue({ trackIds: ['t1'] })
    await t.settle()
    const { id } = t.downloadCall(0)
    t.engine.emit({ type: 'download', downloadId: id, status: 'error', bytes: 0, totalBytes: null, error: 'HTTP 403' })
    await t.settle()
    expect(t.catalog.failedMarks).toEqual([{ trackId: 't1', cacheKey: 't1#a', reason: 'HTTP 403' }])
    expect(t.downloadCall(1).source).toEqual(httpSource('t1', 'b').source)
    expect(t.downloadCall(1).id).toBe(id)
    expect((await t.byTrack('t1')).status).toBe('downloading')
    t.engine.emit({ type: 'download', downloadId: id, status: 'error', bytes: 0, totalBytes: null, error: 'disk full' })
    await t.settle()
    expect(await t.byTrack('t1')).toMatchObject({ status: 'error', error: 'disk full' })
    expect(t.bc.of('notify').some((n) => n.kind === 'error' && n.title.includes('Song 1'))).toBe(true)
  })

  it('fails cleanly when no source resolves', async () => {
    const t = setup()
    t.catalog.sources.set('t2', [])
    t.catalog.resolveErrors.set('t3', 'KHInsider is down')
    await t.dm.enqueue({ trackIds: ['t2'] })
    await t.dm.enqueue({ trackIds: ['t3'] })
    await t.settle()
    expect(await t.byTrack('t2')).toMatchObject({ status: 'error', error: 'No downloadable source found.' })
    expect(await t.byTrack('t3')).toMatchObject({ status: 'error', error: 'KHInsider is down' })
    expect(t.engine.callsOf('download')).toHaveLength(0)
  })

  it('cancel stops active and queued items; retry re-queues them', async () => {
    const t = setup()
    await t.dm.enqueue({ trackIds: ['t1', 't2', 't3', 't4'] })
    await t.settle()
    const active = await t.byTrack('t1')
    const queued = await t.byTrack('t4')
    await t.dm.cancel(queued.id)
    expect((await t.byTrack('t4')).status).toBe('canceled')
    await t.dm.cancel(active.id)
    await t.settle()
    expect(t.engine.callsOf('cancelDownload')).toEqual([[active.id]])
    expect((await t.byTrack('t1')).status).toBe('canceled')
    // a late 'canceled' from the engine is harmless
    t.engine.emit({ type: 'download', downloadId: active.id, status: 'canceled', bytes: 0, totalBytes: null })
    expect((await t.byTrack('t1')).status).toBe('canceled')
    // t4 was canceled while queued, so nothing new started
    expect(t.engine.callsOf('download')).toHaveLength(3)
    await t.dm.retry(active.id)
    await t.settle()
    expect((await t.byTrack('t1')).status).toBe('downloading')
    expect(t.engine.callsOf('download')).toHaveLength(4)
    // done items can't be canceled
    const { id, dest } = t.downloadCall(3)
    t.engine.emit({ type: 'download', downloadId: id, status: 'done', bytes: 1, totalBytes: 1, path: dest })
    await t.dm.cancel(id)
    expect((await t.byTrack('t1')).status).toBe('done')
  })

  it('avoids path collisions with files on disk and with other downloads in flight', async () => {
    const t = setup({ files: new Set(['/dl/Chrono Trigger/Chrono Trigger OSV (1995)/1-01 Song 1.mp3']) })
    t.catalog.addTracks(makeTrack('dupe', { number: 1, title: 'Song 1', gameName: 'Chrono Trigger', albumTitle: 'Chrono Trigger OSV' }))
    t.catalog.addTracks(makeTrack('dupe2', { number: 1, title: 'SONG 1', gameName: 'Chrono Trigger', albumTitle: 'Chrono Trigger OSV' }))
    await t.dm.enqueue({ trackIds: ['t1', 'dupe'] })
    await t.settle()
    expect([0, 1].map((i) => t.downloadCall(i).dest)).toEqual([
      '/dl/Chrono Trigger/Chrono Trigger OSV (1995)/1-01 Song 1 (2).mp3',
      '/dl/Chrono Trigger/Chrono Trigger OSV (1995)/1-01 Song 1 (3).mp3'
    ])
    // In-flight reservations compare case-insensitively (APFS/NTFS are case-insensitive by default).
    const u = setup()
    u.catalog.addTracks(makeTrack('dupe2', { number: 1, title: 'SONG 1', gameName: 'Chrono Trigger', albumTitle: 'Chrono Trigger OSV' }))
    await u.dm.enqueue({ trackIds: ['t1', 'dupe2'] })
    await u.settle()
    expect(u.downloadCall(1).dest).toBe('/dl/Chrono Trigger/Chrono Trigger OSV (1995)/1-01 SONG 1 (2).mp3')
  })

  it('enqueues albums and playlists as a batch with one aggregated notification', async () => {
    const t = setup()
    await t.dm.enqueue({ albumId: 'al1' })
    await t.settle()
    expect((await t.items()).map((d) => d.trackId)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6'])
    for (let i = 0; i < 6; i++) {
      await t.settle()
      const { id, dest } = t.downloadCall(i)
      t.files.add(dest)
      t.engine.emit({ type: 'download', downloadId: id, status: 'done', bytes: 10, totalBytes: 10, path: dest })
    }
    await t.settle()
    const notes = t.bc.of('notify')
    const batchIds = new Set(notes.map((n) => n.id))
    expect(batchIds.size).toBe(1) // progress updates and the final card share one id
    expect(notes[0].kind).toBe('progress')
    expect(notes[notes.length - 1]).toMatchObject({ kind: 'success', title: 'Downloaded Chrono Trigger OSV', body: '6 tracks' })

    const pl = await t.lib.playlists.create('Faves', { trackIds: ['t1', 't2'] })
    t.bc.clear()
    await t.dm.enqueue({ playlistId: pl.id })
    expect(t.bc.last('notify')).toMatchObject({ kind: 'info', title: 'Nothing new to download' })
  })

  it('skips tracks that are already downloaded or queued', async () => {
    const t = setup()
    await t.dm.enqueue({ trackIds: ['t1'] })
    await t.dm.enqueue({ trackIds: ['t1', 't2'] })
    await t.settle()
    expect((await t.items()).map((d) => d.trackId).sort()).toEqual(['t1', 't2'])
  })

  it('clearFinished hides finished items but keeps the downloaded record', async () => {
    const t = setup()
    t.catalog.sources.set('t2', [])
    await t.dm.enqueue({ trackIds: ['t1', 't2', 't3'] })
    await t.settle()
    const { id, dest } = t.downloadCall(0)
    t.files.add(dest)
    t.engine.emit({ type: 'download', downloadId: id, status: 'done', bytes: 1, totalBytes: 1, path: dest })
    await t.settle()
    await t.dm.clearFinished()
    expect((await t.items()).map((d) => d.trackId)).toEqual(['t3'])
    expect(t.lib.library.isDownloaded('t1')).toBe(true)
    expect((await t.lib.api.downloaded()).map((x) => x.id)).toEqual(['t1'])
  })

  it('resumes interrupted downloads after a restart', async () => {
    const db = memoryDb()
    const a = setup({ db })
    await a.dm.enqueue({ trackIds: ['t1', 't2', 't3', 't4'] })
    await a.settle()
    a.dm.dispose() // quit mid-download
    const b = setup({ db })
    expect(statuses(await b.items())).toEqual({ t1: 'downloading', t2: 'downloading', t3: 'downloading', t4: 'queued' })
    b.dm.resume()
    await b.settle()
    expect(b.engine.callsOf('download')).toHaveLength(3)
    expect(statuses(await b.items())).toEqual({ t1: 'downloading', t2: 'downloading', t3: 'downloading', t4: 'queued' })
  })

  it('throttles downloads:changed to at most 4 per second', async () => {
    vi.useFakeTimers()
    const t = setup({ throttleMs: 250 })
    await t.dm.enqueue({ trackIds: ['t1'] })
    await vi.advanceTimersByTimeAsync(1000)
    await t.dm.settled()
    const { id } = t.downloadCall(0)
    t.bc.clear()
    for (let i = 1; i <= 100; i++) {
      t.engine.emit({ type: 'download', downloadId: id, status: 'progress', bytes: i * 1000, totalBytes: 200_000 })
      await vi.advanceTimersByTimeAsync(10)
    }
    const n = t.bc.of('downloads:changed').length
    expect(n).toBeGreaterThanOrEqual(3)
    expect(n).toBeLessThanOrEqual(5) // 1 s of events
    await vi.advanceTimersByTimeAsync(300)
    expect(t.bc.last('downloads:changed')![0].bytes).toBe(100_000) // trailing update delivered
  })

  it('reveal and openFolder use the shell', async () => {
    const t = setup()
    await t.dm.enqueue({ trackIds: ['t1'] })
    await t.settle()
    const { id, dest } = t.downloadCall(0)
    t.files.add(dest)
    t.engine.emit({ type: 'download', downloadId: id, status: 'done', bytes: 1, totalBytes: 1, path: dest })
    await t.dm.reveal(id)
    expect(t.shell.revealed).toEqual([dest])
    await t.dm.openFolder()
    expect(t.shell.opened).toEqual(['/dl'])
  })
})
