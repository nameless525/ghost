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

/** A path under the test download folder, with this OS's separator (as the manager builds them). */
const dl = (rel: string) => '/dl' + (process.platform === 'win32' ? '\\' + rel.replaceAll('/', '\\') : '/' + rel)

const statuses = (xs: DownloadItem[]) => Object.fromEntries(xs.map((d) => [d.trackId, d.status]))

describe('DownloadManager', () => {
  it('runs at most 3 downloads at once and names files from the template', async () => {
    const t = setup()
    await t.dm.enqueue({ trackIds: ['t1', 't2', 't3', 't4', 't5'] })
    await t.settle()
    expect(t.engine.callsOf('download')).toHaveLength(3)
    expect(statuses(await t.items())).toEqual({ t1: 'downloading', t2: 'downloading', t3: 'downloading', t4: 'queued', t5: 'queued' })
    const first = t.downloadCall(0)
    expect(first.dest).toBe(dl('Chrono Trigger/Chrono Trigger OSV (1995)/1-01 Song 1.mp3'))
    expect(first.source).toEqual(httpSource('t1', 'a').source)
    expect(first.tags).toMatchObject({ title: 'Song 1', album: 'Chrono Trigger OSV', albumArtist: 'Chrono Trigger', genre: 'Video Game', comment: 'GHOST', trackNumber: 1, trackTotal: 6, year: 1995 })
    expect(t.dirs).toContain(dl('Chrono Trigger/Chrono Trigger OSV (1995)'))
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
    t.engine.emit({ type: 'download', downloadId: id, status: 'error', bytes: 0, totalBytes: null, error: 'HTTP 404' })
    await t.settle()
    expect(t.catalog.failedMarks).toEqual([{ trackId: 't1', cacheKey: 't1#a', reason: 'HTTP 404' }])
    expect(t.downloadCall(1).source).toEqual(httpSource('t1', 'b').source)
    expect(t.downloadCall(1).id).not.toBe(id) // each engine attempt has its own id
    expect((await t.byTrack('t1')).status).toBe('downloading')
    t.engine.emit({ type: 'download', downloadId: t.downloadCall(1).id, status: 'error', bytes: 0, totalBytes: null, error: 'disk full' })
    await t.settle()
    expect(await t.byTrack('t1')).toMatchObject({ status: 'error', error: 'disk full' })
    expect(t.bc.of('notify').some((n) => n.kind === 'error' && n.title.includes('Song 1'))).toBe(true)
  })

  it('a 403 (stale URL) re-resolves once and retries the top source before falling back', async () => {
    const t = setup()
    await t.dm.enqueue({ trackIds: ['t1'] })
    await t.settle()
    const { id } = t.downloadCall(0)
    const resolves = t.catalog.resolveCalls.filter((c) => c.trackId === 't1').length
    // the catalog now hands out a refreshed URL for the same source
    t.catalog.sources.set('t1', [httpSource('t1', 'a', { source: { kind: 'http', url: 'https://cdn.example/t1/fresh.mp3', cacheKey: 't1#a' } }), httpSource('t1', 'b')])
    t.engine.emit({ type: 'download', downloadId: id, status: 'error', bytes: 0, totalBytes: null, error: 'stream failed: HTTP 403' })
    await t.settle()
    expect(t.catalog.resolveCalls.filter((c) => c.trackId === 't1').length).toBe(resolves + 1)
    expect(t.downloadCall(1).source).toMatchObject({ url: 'https://cdn.example/t1/fresh.mp3' })
    // a second 403 is a real failure: on to the next source, no more re-resolving
    t.engine.emit({ type: 'download', downloadId: t.downloadCall(1).id, status: 'error', bytes: 0, totalBytes: null, error: 'stream failed: HTTP 403' })
    await t.settle()
    expect(t.downloadCall(2).source).toEqual(httpSource('t1', 'b').source)
    expect(t.catalog.resolveCalls.filter((c) => c.trackId === 't1').length).toBe(resolves + 1)
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
    expect(t.engine.callsOf('cancelDownload')).toEqual([[t.downloadCall(0).id]])
    expect((await t.byTrack('t1')).status).toBe('canceled')
    // a late 'canceled' from the engine is harmless
    t.engine.emit({ type: 'download', downloadId: t.downloadCall(0).id, status: 'canceled', bytes: 0, totalBytes: null })
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
    await t.dm.cancel(active.id)
    expect((await t.byTrack('t1')).status).toBe('done')
  })

  it('avoids path collisions with files on disk and with other downloads in flight', async () => {
    const t = setup({ files: new Set([dl('Chrono Trigger/Chrono Trigger OSV (1995)/1-01 Song 1.mp3')]) })
    t.catalog.addTracks(makeTrack('dupe', { number: 1, title: 'Song 1', gameName: 'Chrono Trigger', albumTitle: 'Chrono Trigger OSV' }))
    t.catalog.addTracks(makeTrack('dupe2', { number: 1, title: 'SONG 1', gameName: 'Chrono Trigger', albumTitle: 'Chrono Trigger OSV' }))
    await t.dm.enqueue({ trackIds: ['t1', 'dupe'] })
    await t.settle()
    expect([0, 1].map((i) => t.downloadCall(i).dest)).toEqual([
      dl('Chrono Trigger/Chrono Trigger OSV (1995)/1-01 Song 1 (2).mp3'),
      dl('Chrono Trigger/Chrono Trigger OSV (1995)/1-01 Song 1 (3).mp3')
    ])
    // In-flight reservations compare case-insensitively (APFS/NTFS are case-insensitive by default).
    const u = setup()
    u.catalog.addTracks(makeTrack('dupe2', { number: 1, title: 'SONG 1', gameName: 'Chrono Trigger', albumTitle: 'Chrono Trigger OSV' }))
    await u.dm.enqueue({ trackIds: ['t1', 'dupe2'] })
    await u.settle()
    expect(u.downloadCall(1).dest).toBe(dl('Chrono Trigger/Chrono Trigger OSV (1995)/1-01 SONG 1 (2).mp3'))
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

  it('queues an album in one transaction, and resumes after a restart in one', async () => {
    const db = memoryDb()
    const begins: string[] = []
    const exec = db.exec.bind(db)
    db.exec = (sql: string) => {
      if (/^BEGIN/i.test(sql)) begins.push(sql)
      return exec(sql)
    }
    const a = setup({ db })
    await a.dm.enqueue({ albumId: 'al1' })
    expect(begins).toHaveLength(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM downloads').get() as { n: number }).n).toBe(6)
    await a.settle()
    a.dm.dispose()
    begins.length = 0
    const b = setup({ db })
    b.dm.resume() // 3 were mid-download: reset to queued together
    expect(begins).toHaveLength(1)
    await b.settle()
  })

  it('a retried item leaves its old batch (persisted, so a restart agrees)', async () => {
    const db = memoryDb()
    const a = setup({ db })
    await a.dm.enqueue({ trackIds: ['t1', 't2'] })
    await a.settle()
    const t1 = await a.byTrack('t1')
    await a.dm.cancel(t1.id)
    await a.dm.retry(t1.id)
    expect((db.prepare('SELECT batch FROM downloads WHERE id = ?').get(t1.id) as { batch: string | null }).batch).toBeNull()
    const t2 = await a.byTrack('t2')
    expect((db.prepare('SELECT batch FROM downloads WHERE id = ?').get(t2.id) as { batch: string | null }).batch).not.toBeNull()
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

  it('a cancel while the tags load launches nothing and frees the file name', async () => {
    const t = setup()
    let release!: () => void
    const held = new Promise<null>((r) => (release = () => r(null)))
    t.catalog.getAnalysis = () => held
    await t.dm.enqueue({ trackIds: ['t1'] })
    await flush()
    const item = await t.byTrack('t1')
    expect(item.status).toBe('resolving')
    await t.dm.cancel(item.id)
    release()
    await t.settle()
    expect(t.engine.callsOf('download')).toHaveLength(0)
    expect((await t.byTrack('t1')).status).toBe('canceled')
    expect(t.lib.library.downloads.get(item.id)!.status).toBe('canceled')
    // the released name goes to the next download that wants it
    t.catalog.getAnalysis = async () => null
    t.catalog.addTracks(makeTrack('again', { number: 1, title: 'Song 1', gameName: 'Chrono Trigger', albumTitle: 'Chrono Trigger OSV' }))
    await t.dm.enqueue({ trackIds: ['again'] })
    await t.settle()
    expect(t.downloadCall(0).dest).toBe(dl('Chrono Trigger/Chrono Trigger OSV (1995)/1-01 Song 1.mp3'))
  })

  it("a canceled attempt's late events and its coroutine can't touch the retry", async () => {
    const t = setup()
    await t.dm.enqueue({ trackIds: ['t1'] })
    await t.settle()
    const old = t.downloadCall(0)
    const rec = await t.byTrack('t1')
    await t.dm.cancel(rec.id)
    let open!: () => void
    t.catalog.gate = new Promise((r) => (open = r))
    await t.dm.retry(rec.id)
    await flush()
    // the old attempt reports while the retry resolves its source...
    t.engine.emit({ type: 'download', downloadId: old.id, status: 'progress', bytes: 1, totalBytes: 2 })
    t.engine.emit({ type: 'download', downloadId: old.id, status: 'canceled', bytes: 0, totalBytes: null })
    expect((await t.byTrack('t1')).status).toBe('resolving')
    // ...a second cancel + retry mid-resolution leaves one coroutine to launch...
    await t.dm.cancel(rec.id)
    await t.dm.retry(rec.id)
    open()
    t.catalog.gate = null
    await t.settle()
    expect(t.engine.callsOf('download')).toHaveLength(2)
    const next = t.downloadCall(1)
    expect(next.id).not.toBe(old.id)
    expect((await t.byTrack('t1')).status).toBe('downloading')
    // ...and once it runs, the old attempt's 'done' is still not this one's
    t.engine.emit({ type: 'download', downloadId: old.id, status: 'done', bytes: 9, totalBytes: 9, path: old.dest })
    expect((await t.byTrack('t1')).status).toBe('downloading')
    t.files.add(next.dest)
    t.engine.emit({ type: 'download', downloadId: next.id, status: 'done', bytes: 9, totalBytes: 9, path: next.dest })
    expect(await t.byTrack('t1')).toMatchObject({ status: 'done', path: next.dest })
  })

  it('an engine that fails at once (the null engine) ends the item in error, never downloading', async () => {
    const t = setup()
    vi.spyOn(t.engine, 'download').mockImplementation((id) => t.engine.emit({ type: 'download', downloadId: id, status: 'error', bytes: 0, totalBytes: null, error: 'Audio engine unavailable: test' }))
    await t.dm.enqueue({ trackIds: ['t1'] })
    await t.settle()
    expect(await t.byTrack('t1')).toMatchObject({ status: 'error', error: 'Audio engine unavailable: test' })
    expect(t.bc.of('downloads:changed').some((xs) => xs.some((d) => d.status === 'downloading'))).toBe(false)
  })

  it('overlapping requests queue each track once', async () => {
    const t = setup()
    await Promise.all([t.dm.enqueue({ trackIds: ['t1'] }), t.dm.enqueue({ trackIds: ['t1'] }), t.dm.enqueue({ albumId: 'al1' })])
    await t.settle()
    expect((await t.items()).map((d) => d.trackId).sort()).toEqual(['t1', 't2', 't3', 't4', 't5', 't6'])
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE track_id = 't1'").get() as { n: number }).n).toBe(1)
    expect(new Set(t.engine.callsOf('download').map((c) => (c[3] as TagInfo).title)).size).toBe(3)
  })

  it("retry won't queue a track a newer download already covers", async () => {
    const t = setup()
    t.catalog.sources.set('t1', [])
    await t.dm.enqueue({ trackIds: ['t1'] })
    await t.settle()
    const failed = await t.byTrack('t1')
    expect(failed.status).toBe('error')
    t.catalog.sources.delete('t1')
    await t.dm.enqueue({ trackIds: ['t1'] })
    await t.settle()
    await t.dm.retry(failed.id)
    await t.settle()
    expect((await t.items()).find((d) => d.id === failed.id)!.status).toBe('error')
    expect(t.engine.callsOf('download')).toHaveLength(1)
    expect(t.bc.last('notify')).toMatchObject({ kind: 'info', title: 'Already downloading' })
    // once that one is on disk, retrying the old failure would only make a copy
    const { id, dest } = t.downloadCall(0)
    t.files.add(dest)
    t.engine.emit({ type: 'download', downloadId: id, status: 'done', bytes: 1, totalBytes: 1, path: dest })
    await t.dm.retry(failed.id)
    expect(t.bc.last('notify')).toMatchObject({ kind: 'info', title: 'Already downloaded' })
    expect(t.engine.callsOf('download')).toHaveLength(1)
  })

  it('names renders .flac, keeps them apart from each other and from FLAC files, and records the path the engine reports', async () => {
    const dir = 'Chrono Trigger/Chrono Trigger OSV (1995)/'
    const t = setup({ files: new Set([dl(dir + '1-01 Song.flac')]) })
    const song = (id: string) => makeTrack(id, { number: 1, title: 'Song', gameName: 'Chrono Trigger', albumTitle: 'Chrono Trigger OSV' })
    t.catalog.addTracks(song('clip'), song('chip'), song('lossless'))
    t.catalog.sources.set('clip', [httpSource('clip', 'a', { format: 'wav', source: { kind: 'file', path: '/rips/Song.wav', clipStartMs: 0, clipEndMs: 900 } })])
    t.catalog.sources.set('chip', [httpSource('chip', 'a', { format: 'chip', source: { kind: 'http', url: 'https://x/set.7z', cacheKey: 'set', archiveEntry: 'Song.nsf', subsong: 2 } })])
    t.catalog.sources.set('lossless', [httpSource('lossless', 'a', { format: 'flac', source: { kind: 'http', url: 'https://x/Song.flac', cacheKey: 'lossless' } })])
    const download = vi.spyOn(t.engine, 'download')
    await t.dm.enqueue({ trackIds: ['clip', 'chip', 'lossless'] })
    await t.settle()
    expect([0, 1, 2].map((i) => t.downloadCall(i).dest)).toEqual([dl(dir + '1-01 Song (2).flac'), dl(dir + '1-01 Song (3).flac'), dl(dir + '1-01 Song (4).flac')])
    expect(download.mock.calls.map((c) => (c as unknown[])[4])).toEqual([{ renderFlac: true }, { renderFlac: true }, { renderFlac: false }])
    // the engine has the last word on the name (it never replaces a file)
    const actual = dl(dir + '1-01 Song (5).flac')
    t.files.add(actual)
    t.engine.emit({ type: 'download', downloadId: t.downloadCall(0).id, status: 'done', bytes: 9, totalBytes: 9, path: actual })
    await t.settle()
    const done = await t.byTrack('clip')
    expect(done).toMatchObject({ status: 'done', path: actual })
    expect(t.lib.library.downloads.get(done.id)!.path).toBe(actual)
    expect(t.lib.library.downloadedPath('clip')).toBe(actual)
  })

  it('reveal and openFolder use the shell', async () => {
    const t = setup()
    await t.dm.enqueue({ trackIds: ['t1'] })
    await t.settle()
    const { id, dest } = t.downloadCall(0)
    t.files.add(dest)
    t.engine.emit({ type: 'download', downloadId: id, status: 'done', bytes: 1, totalBytes: 1, path: dest })
    await t.dm.reveal((await t.byTrack('t1')).id)
    expect(t.shell.revealed).toEqual([dest])
    await t.dm.openFolder()
    expect(t.shell.opened).toEqual(['/dl'])
  })
})
