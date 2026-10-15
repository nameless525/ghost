import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Settings } from '../../shared/types'
import { FakeCatalog, fakeBroadcast, httpSource, makeTrack, memoryDb, testSettings } from '../player/testing'
import { createLibrary } from './index'
import { renderM3U } from './m3u'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const catalog = new FakeCatalog()
  catalog.addTracks(
    makeTrack('a1', { albumId: 'A', albumTitle: 'Alpha', cover: 'https://img/A.jpg', durationMs: 100_000, gameName: 'Alpha Game' }),
    makeTrack('a2', { albumId: 'A', albumTitle: 'Alpha', cover: 'https://img/A.jpg', durationMs: 120_000, gameName: 'Alpha Game' }),
    makeTrack('b1', { albumId: 'B', albumTitle: 'Beta', cover: 'https://img/B.jpg', durationMs: 60_000 }),
    makeTrack('c1', { albumId: 'C', albumTitle: 'Gamma', cover: 'https://img/C.jpg', durationMs: null }),
    makeTrack('d1', { albumId: 'D', albumTitle: 'Delta', cover: 'https://img/D.jpg' }),
    makeTrack('e1', { albumId: 'E', albumTitle: 'Eps', cover: 'https://img/E.jpg' })
  )
  const bc = fakeBroadcast()
  const db = memoryDb()
  const settings: Settings = testSettings()
  const files = new Set<string>()
  const clock = { t: 1_000 }
  const h = createLibrary({ db, catalog, broadcast: bc.broadcast, getSettings: () => settings, now: () => clock.t++, fileExists: (p) => files.has(p) })
  return { ...h, catalog, bc, db, settings, files, clock }
}

const ids = (d: { items: { track: { id: string } }[] }) => d.items.map((i) => i.track.id)

describe('playlists', () => {
  it('create / get / list with derived meta (count, duration, up to 4 distinct covers)', async () => {
    const t = setup()
    const p = await t.playlists.create('  Road   trip ', { trackIds: ['a1', 'a2', 'b1', 'c1', 'd1', 'e1', 'missing'], description: 'vibes' })
    expect(p.name).toBe('Road trip')
    expect(p.kind).toBe('manual')
    expect(p.description).toBe('vibes')
    expect(p.trackCount).toBe(6) // the unknown track is hidden
    expect(p.durationMs).toBe(100_000 + 120_000 + 60_000 + 0 + 180_000 + 180_000)
    expect(p.covers).toEqual(['https://img/A.jpg', 'https://img/B.jpg', 'https://img/C.jpg', 'https://img/D.jpg'])
    const d = await t.playlists.get(p.id)
    expect(ids(d)).toEqual(['a1', 'a2', 'b1', 'c1', 'd1', 'e1'])
    expect(new Set(d.items.map((i) => i.uid)).size).toBe(6)
    const empty = await t.playlists.create('')
    expect(empty.name).toBe('Untitled playlist')
    const list = await t.playlists.list()
    expect(list.map((x) => x.id)).toEqual([empty.id, p.id]) // most recently updated first
    expect(list[1].trackCount).toBe(6)
    expect(t.bc.of('library:changed')).toContainEqual({ kind: 'playlists', id: p.id })
  })

  it('addTracks at the end and at a position, removeItems, moveItem keep a stable uid and contiguous order', async () => {
    const t = setup()
    const p = await t.playlists.create('Mix', { trackIds: ['a1', 'b1'] })
    await t.playlists.addTracks(p.id, ['c1'])
    await t.playlists.addTracks(p.id, ['d1', 'e1'], 1)
    let d = await t.playlists.get(p.id)
    expect(ids(d)).toEqual(['a1', 'd1', 'e1', 'b1', 'c1'])
    const uidOf = (id: string) => d.items.find((i) => i.track.id === id)!.uid
    const c1 = uidOf('c1')
    await t.playlists.moveItem(p.id, 4, 0)
    d = await t.playlists.get(p.id)
    expect(ids(d)).toEqual(['c1', 'a1', 'd1', 'e1', 'b1'])
    expect(uidOf('c1')).toBe(c1)
    await t.playlists.moveItem(p.id, 1, 3)
    d = await t.playlists.get(p.id)
    expect(ids(d)).toEqual(['c1', 'd1', 'e1', 'a1', 'b1'])
    await t.playlists.removeItems(p.id, [uidOf('d1'), uidOf('a1')])
    d = await t.playlists.get(p.id)
    expect(ids(d)).toEqual(['c1', 'e1', 'b1'])
    const positions = t.db.prepare('SELECT position FROM playlist_items WHERE playlist_id = ? ORDER BY position').all(p.id) as { position: number }[]
    expect(positions.map((r) => r.position)).toEqual([0, 1, 2])
    await t.playlists.addTracks(p.id, ['a1'], 99) // clamped to the end
    expect(ids(await t.playlists.get(p.id))).toEqual(['c1', 'e1', 'b1', 'a1'])
    // appends say so (once each); inserts at a position are undos and stay quiet
    const added = t.bc.of('notify').filter((n) => n.title === 'Added to Mix')
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ body: '1 track', ephemeral: true })
  })

  it('allows the same track twice with distinct item uids', async () => {
    const t = setup()
    const p = await t.playlists.create('Loop', { trackIds: ['a1', 'a1'] })
    const d = await t.playlists.get(p.id)
    expect(ids(d)).toEqual(['a1', 'a1'])
    await t.playlists.removeItems(p.id, [d.items[0].uid])
    expect((await t.playlists.get(p.id)).items.map((i) => i.uid)).toEqual([d.items[1].uid])
  })

  it('update renames, duplicate copies items, delete removes items too', async () => {
    const t = setup()
    const p = await t.playlists.create('One', { trackIds: ['a1', 'b1'] })
    const u = await t.playlists.update(p.id, { name: 'Uno', description: null })
    expect(u.name).toBe('Uno')
    expect(u.updatedAt).toBeGreaterThan(p.updatedAt)
    const dup = await t.playlists.duplicate(p.id)
    expect(dup.name).toBe('Uno (copy)')
    expect(ids(await t.playlists.get(dup.id))).toEqual(['a1', 'b1'])
    await t.playlists.delete(p.id)
    await expect(t.playlists.get(p.id)).rejects.toThrow(/not found/)
    expect((t.db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(p.id) as { n: number }).n).toBe(0)
    expect((await t.playlists.list()).map((x) => x.id)).toEqual([dup.id])
  })

  it('smart playlists evaluate their query through the catalog and are read-only', async () => {
    const t = setup()
    t.catalog.smart = (q) => (q === 'platform=snes' ? ['b1', 'a2', 'b1'] : [])
    const p = await t.playlists.create('SNES', { query: 'platform=snes' })
    expect(p.kind).toBe('smart')
    expect(p.query).toBe('platform=snes')
    expect(p.trackCount).toBe(2)
    expect(ids(await t.playlists.get(p.id))).toEqual(['b1', 'a2'])
    await expect(t.playlists.addTracks(p.id, ['a1'])).rejects.toThrow(/query/)
    await expect(t.playlists.removeItems(p.id, ['x'])).rejects.toThrow(/query/)
    expect((await t.playlists.list())[0].trackCount).toBe(2)
    // clearing the query turns it into a manual playlist with the current results
    const m = await t.playlists.update(p.id, { query: null })
    expect(m.kind).toBe('manual')
    expect(ids(await t.playlists.get(p.id))).toEqual(['b1', 'a2'])
    // and setting one makes it smart again
    const s = await t.playlists.update(p.id, { query: 'platform=snes' })
    expect(s.kind).toBe('smart')
    const dup = await t.playlists.duplicate(p.id)
    expect(dup.kind).toBe('smart')
    expect(dup.query).toBe('platform=snes')
  })

  it('exports an .m3u8 with durations, local paths for downloads and stream URLs otherwise', async () => {
    const t = setup()
    const dir = mkdtempSync(join(tmpdir(), 'ghost-m3u-'))
    tmpDirs.push(dir)
    t.settings.library.downloadDir = dir
    const local = join(dir, 'Alpha Game', 'Alpha (1995)', '1-01 Track a1.flac')
    t.files.add(local)
    t.library.noteDownloaded('a1', local)
    t.catalog.resolveErrors.set('c1', 'offline')
    const p = await t.playlists.create('Trip: Day/1', { trackIds: ['a1', 'b1', 'c1'] })
    const path = await t.playlists.exportM3U(p.id)
    expect(path).toBe(join(dir, 'Trip - Day-1.m3u8'))
    const text = readFileSync(path, 'utf8')
    expect(text).toBe(
      [
        '#EXTM3U',
        '#PLAYLIST:Trip: Day/1',
        '#EXTINF:100,Alpha Game - Track a1',
        'Alpha Game/Alpha (1995)/1-01 Track a1.flac',
        '#EXTINF:60,Game One - Track b1',
        httpSource('b1', 'a').source.kind === 'http' ? (httpSource('b1', 'a').source as { url: string }).url : '',
        '# unavailable: Game One - Track c1',
        ''
      ].join('\n')
    )
  })

  it('renderM3U uses -1 for unknown durations and strips newlines', () => {
    expect(renderM3U('a\nb', [{ durationMs: null, title: 'x\ny', artist: null, location: '/m/x.mp3' }])).toBe('#EXTM3U\n#PLAYLIST:a b\n#EXTINF:-1,x y\n/m/x.mp3\n')
  })
})

describe('likes, history, downloaded, decoration', () => {
  it('toggleLike persists, decorates TrackViews and lists newest first', async () => {
    const t = setup()
    const changed: string[][] = []
    t.library.onTracksChanged((x) => changed.push(x))
    expect(await t.api.toggleLike('a1')).toBe(true)
    expect(await t.api.toggleLike('b1')).toBe(true)
    expect((await t.api.liked()).map((x) => x.id)).toEqual(['b1', 'a1'])
    expect((await t.api.liked()).every((x) => x.liked)).toBe(true)
    expect(t.library.decorate([makeTrack('a1'), makeTrack('c1')]).map((x) => x.liked)).toEqual([true, false])
    expect(await t.api.toggleLike('a1')).toBe(false)
    expect((await t.api.liked()).map((x) => x.id)).toEqual(['b1'])
    expect(changed).toEqual([['a1'], ['b1'], ['a1']])
    expect(t.bc.of('library:changed').filter((e) => e.kind === 'likes')).toHaveLength(3)
    // persisted: a fresh Library over the same DB sees the like
    const again = createLibrary({ db: t.db, catalog: t.catalog, broadcast: t.bc.broadcast, getSettings: () => t.settings })
    expect(again.library.isLiked('b1')).toBe(true)
  })

  it('history returns entries newest first with ms played', async () => {
    const t = setup()
    const r1 = t.library.recordPlay('a1', 100, 30_000)
    t.library.recordPlay('b1', 200, 31_000)
    t.library.recordPlay('missing', 250, 31_000)
    t.library.updatePlay(r1, 95_000)
    t.library.recordPlay('a1', 300, 40_000)
    const h = await t.api.history()
    expect(h.map((e) => [e.track.id, e.playedAt, e.msPlayed])).toEqual([
      ['a1', 300, 40_000],
      ['b1', 200, 31_000],
      ['a1', 100, 95_000]
    ])
    expect((await t.api.history(1)).length).toBe(1)
  })

  it('downloaded() lists existing files and forgets ones deleted outside the app', async () => {
    const t = setup()
    t.files.add('/m/a1.mp3')
    t.files.add('/m/b1.mp3')
    // the download manager writes the row, then tells the library
    for (const [id, path] of [
      ['a1', '/m/a1.mp3'],
      ['b1', '/m/b1.mp3']
    ]) {
      t.library.downloads.insert({ id: `d-${id}`, trackId: id, title: id, gameName: null, albumTitle: '', cover: null, status: 'done', progress: 1, bytes: 1, totalBytes: 1, path, error: null, createdAt: 1, format: 'mp3', batch: null, finishedAt: t.clock.t })
      t.library.noteDownloaded(id, path)
    }
    expect(t.library.decorateOne(makeTrack('a1')).downloaded).toBe(true)
    expect(t.library.downloadedPath('a1')).toBe('/m/a1.mp3')
    expect((await t.api.downloaded()).map((x) => x.id)).toEqual(['b1', 'a1'])
    t.files.delete('/m/a1.mp3')
    expect(t.library.downloadedPath('a1')).toBeNull()
    expect((await t.api.downloaded()).map((x) => x.id)).toEqual(['b1'])
    expect(t.library.isDownloaded('a1')).toBe(false)
    // survives a restart (rebuilt from the downloads table)
    const again = createLibrary({ db: t.db, catalog: t.catalog, broadcast: t.bc.broadcast, getSettings: () => t.settings, fileExists: (p) => t.files.has(p) })
    expect(again.library.isDownloaded('b1')).toBe(true)
    expect(again.library.isDownloaded('a1')).toBe(false)
  })
})
