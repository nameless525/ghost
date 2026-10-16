// Local albums in the catalog: a scanned folder's albums become browsable, playable catalog albums
// that follow the files (changes, removals) with stable ids, beside the remote catalog.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { BrowseQuery, Settings } from '../../shared/types'
import { ProviderRegistry } from '../providers'
import { LocalLibrary, LocalProvider, type TagInfo } from '../providers/local'
import type { Provider, StreamInfo } from '../providers/types'
import { LOCAL_ALBUMS_META, syncLocalAlbums } from './local'
import { CatalogRepo } from './repo'
import { SourceResolver } from './resolver'
import { createCatalogService } from './service'
import { memoryDb, seedSmall } from './testing'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A music folder of placeholder files whose tags the test decides. */
function musicFolder() {
  const root = mkdtempSync(join(tmpdir(), 'ghost-local-albums-'))
  dirs.push(root)
  const tags: Record<string, TagInfo> = {}
  let bumps = 0
  return {
    root,
    tags,
    readTags: async (p: string) => tags[p] ?? {},
    add(rel: string, t: TagInfo): string {
      const p = join(root, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, 'x')
      tags[p] = t
      return p
    },
    /** New tags, and a new mtime so the next scan reads them. */
    retag(p: string, t: TagInfo): void {
      tags[p] = t
      const later = new Date(Date.now() + 60_000 * ++bumps)
      utimesSync(p, later, later)
    }
  }
}

function setup(seed = false) {
  const db = memoryDb()
  const repo = new CatalogRepo(db)
  if (seed) seedSmall(repo)
  const music = musicFolder()
  const lib = new LocalLibrary(db, { readTags: music.readTags })
  const scan = async () => {
    const r = await lib.scan([music.root])
    return syncLocalAlbums(repo, lib, [...r.changedPaths, ...r.removedPaths], { pause: async () => {} })
  }
  const albums = () =>
    repo.all<{ id: number; title: string; gone: number; game_id: number | null; game: string | null }>(
      `SELECT a.id, a.title, a.gone, a.game_id, g.name AS game FROM albums a LEFT JOIN games g ON g.id = a.game_id WHERE a.provider = 'local' ORDER BY a.id`
    )
  const tracks = (albumId: number) => repo.all<{ id: number; title: string }>(`SELECT id, title FROM tracks WHERE album_id = ? AND removed = 0 ORDER BY position`, albumId)
  const track = (id: number) => repo.get<{ album_id: number; title: string; removed: number }>(`SELECT album_id, title, removed FROM tracks WHERE id = ?`, id)
  return { db, repo, music, lib, scan, albums, tracks, track }
}

const hk = (title: string, track: number, extra: TagInfo = {}): TagInfo => ({ title, album: 'Hollow Knight (Original Soundtrack)', albumArtist: 'Christopher Larkin', track, durationMs: 100_000 + track * 10_000, lossless: true, codec: 'FLAC', ...extra })

describe('local albums: a fresh install with nothing but a music folder', () => {
  it('a tagged album is browsable, filterable, searchable and plays from its files', async () => {
    const settings: Settings = defaultSettings('/tmp/ghost-dl')
    const music = musicFolder()
    const first = music.add('Celeste/01 Prologue.flac', { title: 'Prologue', album: 'Celeste Original Soundtrack', albumArtist: 'Lena Raine', track: 1, durationMs: 90_000, lossless: true, codec: 'FLAC' })
    music.add('Celeste/02 Resurrections.flac', { title: 'Resurrections', album: 'Celeste Original Soundtrack', albumArtist: 'Lena Raine', track: 2, durationMs: 250_000, lossless: true, codec: 'FLAC' })
    settings.sources.localFolders = [music.root]
    const db = memoryDb()
    const lib = new LocalLibrary(db, { readTags: music.readTags })
    const svc = createCatalogService(
      { db, broadcast: (() => {}) as never, getSettings: () => settings },
      { registry: new ProviderRegistry().register(new LocalProvider(lib)), startDelayMs: 0, disableEnrichment: true, chip: false, log: () => {} }
    )
    const q: BrowseQuery = { text: '', group: 'game', sort: 'title', offset: 0, limit: 20 }
    svc.start()
    try {
      const t0 = Date.now()
      while (!(await svc.browse(q)).groups.length) {
        if (Date.now() - t0 > 10_000) throw new Error('the local album never showed up')
        await new Promise((r) => setTimeout(r, 10))
      }
      const [game] = (await svc.browse(q)).groups
      expect(game).toMatchObject({ title: 'Celeste', albumCount: 1 })
      expect(await svc.status()).toMatchObject({ games: 1, albums: 1, tracks: 2 })
      const [album] = await svc.groupAlbums(game.key, q)
      expect(album).toMatchObject({ title: 'Celeste Original Soundtrack', provider: 'local', kind: 'ost', trackCount: 2, totalMs: 340_000, formats: ['flac'], composers: ['Lena Raine'] })
      // Source filters and search see it.
      expect((await svc.browse({ ...q, text: 'source:local' })).groups.map((g) => g.title)).toEqual(['Celeste'])
      expect((await svc.browse({ ...q, text: 'source:khinsider' })).groups).toEqual([])
      expect((await svc.searchTracks('resurrections')).map((t) => t.title)).toEqual(['Resurrections'])
      const d = await svc.album(album.id)
      expect(d.tracks.map((t) => t.title)).toEqual(['Prologue', 'Resurrections'])
      expect(d.tracks[0].source).toMatchObject({ provider: 'local', format: 'flac', lossless: true })
      const sources = await svc.resolveSources(d.tracks[0].id)
      expect(sources.map((s) => s.provider)).toEqual(['local'])
      expect(sources[0].source).toEqual({ kind: 'file', path: first, formatHint: 'flac' })
    } finally {
      svc.stop()
    }
  }, 15_000)
})

describe('local albums: following the files', () => {
  it('a local-only album joins an existing catalog; one the catalog knows joins its game', async () => {
    const { repo, music, scan, albums } = setup(true)
    const before = repo.counts()
    const hkGame = repo.get<{ game_id: number }>(`SELECT game_id FROM albums WHERE provider = 'khinsider' AND provider_ref = 'hollow-knight-ost'`)!.game_id
    music.add('Undertale/01.mp3', { title: 'Once Upon a Time', album: 'UNDERTALE Soundtrack', albumArtist: 'Toby Fox', track: 1 })
    music.add('HK/02.flac', hk('Dirtmouth', 2))
    expect(await scan()).toEqual({ written: 2, withdrawn: 0 })
    expect(albums().map((a) => [a.title, a.game])).toEqual([
      ['Hollow Knight (Original Soundtrack)', 'Hollow Knight'],
      ['UNDERTALE Soundtrack', 'UNDERTALE']
    ])
    expect(albums()[0].game_id).toBe(hkGame)
    expect(repo.counts()).toEqual({ games: before.games + 1, albums: before.albums + 2, tracks: before.tracks + 2 })
    // The remote albums are untouched.
    expect(repo.get<{ n: number }>(`SELECT COUNT(*) AS n FROM albums WHERE provider = 'khinsider' AND gone = 0`)!.n).toBe(before.albums)
  })

  it('changes and removals reconcile, and track ids survive them', async () => {
    const { music, scan, albums, tracks, track } = setup()
    const f1 = music.add('HK/01.flac', hk('Enter Hallownest', 1))
    const f2 = music.add('HK/02.flac', hk('Dirtmouth', 2))
    const f3 = music.add('HK/03.flac', hk('Crossroads', 3))
    expect(await scan()).toEqual({ written: 1, withdrawn: 0 })
    const [a] = albums()
    const [t1, t2, t3] = tracks(a.id).map((t) => t.id)
    expect(await scan()).toBeNull() // nothing changed: nothing to write

    // Retagged into another album: its track (and id) moves there.
    music.retag(f3, { ...hk('Crossroads', 1), album: 'Hollow Knight: Gods & Nightmares' })
    expect(await scan()).toEqual({ written: 2, withdrawn: 0 })
    const b = albums().find((x) => x.title === 'Hollow Knight: Gods & Nightmares')!
    expect(tracks(b.id)).toEqual([{ id: t3, title: 'Crossroads' }])
    expect(tracks(a.id).map((t) => t.id)).toEqual([t1, t2])

    // Retitled: the same track.
    music.retag(f1, hk('Enter Hallownest (2017)', 1))
    await scan()
    expect(tracks(a.id)).toEqual([
      { id: t1, title: 'Enter Hallownest (2017)' },
      { id: t2, title: 'Dirtmouth' }
    ])

    // A file deleted: its track goes; its album stays while it has others.
    rmSync(f2)
    expect(await scan()).toEqual({ written: 1, withdrawn: 0 })
    expect(tracks(a.id).map((t) => t.id)).toEqual([t1])
    expect(track(t2)).toMatchObject({ removed: 1 })

    // The album's last file deleted: the album is withdrawn (and its game with it).
    rmSync(f1)
    expect(await scan()).toEqual({ written: 0, withdrawn: 1 })
    expect(albums().find((x) => x.id === a.id)).toMatchObject({ gone: 1, game: null })
    expect(track(t1)).toMatchObject({ removed: 1 })

    // The file back: the same album and track again.
    music.add('HK/01.flac', hk('Enter Hallownest', 1))
    expect(await scan()).toEqual({ written: 1, withdrawn: 0 })
    expect(albums().find((x) => x.id === a.id)).toMatchObject({ gone: 0, game: 'Hollow Knight' })
    expect(tracks(a.id)).toEqual([{ id: t1, title: 'Enter Hallownest' }])
  })

  it('a sync that didn’t finish (or a new grouping version) rewrites everything at the next scan', async () => {
    const { repo, music, scan } = setup()
    music.add('HK/01.flac', hk('Enter Hallownest', 1))
    music.add('Celeste/01.flac', { title: 'Prologue', album: 'Celeste' })
    expect(await scan()).toEqual({ written: 2, withdrawn: 0 })
    expect(await scan()).toBeNull()
    repo.setMeta(LOCAL_ALBUMS_META, null)
    expect(await scan()).toEqual({ written: 2, withdrawn: 0 })
  })

  it('a remote album’s tracks still play from a matching local file first', async () => {
    const { repo, music, lib, scan, albums, tracks } = setup(true)
    const file = music.add('HK/02.flac', { ...hk('Dirtmouth', 2), album: 'Hollow Knight', durationMs: 140_000 })
    await scan()
    const kh: Provider = {
      id: 'khinsider',
      name: 'KHInsider',
      async resolveStream(locator): Promise<StreamInfo[]> {
        return [{ provider: 'khinsider', source: { kind: 'http', url: `https://kh.example/${locator}`, cacheKey: `kh:${locator}` }, format: 'mp3', lossless: false, bitrateKbps: 320, sizeBytes: null, expiresAt: null }]
      }
    }
    const settings = defaultSettings('/tmp/x')
    const resolver = new SourceResolver({ repo, registry: new ProviderRegistry().register(new LocalProvider(lib)).register(kh), getSettings: () => settings })
    const remote = repo.get<{ id: number }>(`SELECT t.id FROM tracks t JOIN albums a ON a.id = t.album_id WHERE a.provider = 'khinsider' AND t.title = 'Dirtmouth'`)!.id
    const viaRemote = await resolver.resolve(String(remote))
    expect(viaRemote.map((s) => s.provider)).toEqual(['local', 'khinsider'])
    expect(viaRemote[0]).toMatchObject({ source: { kind: 'file', path: file }, confidence: 1 })
    // The local copy is its own album in the same game, playing the same file.
    const [own] = albums()
    expect(own.game_id).toBe(repo.get<{ game_id: number }>(`SELECT game_id FROM albums WHERE provider_ref = 'hollow-knight-ost'`)!.game_id)
    const viaLocal = await resolver.resolve(String(tracks(own.id)[0].id))
    expect(viaLocal.map((s) => [s.provider, s.source.kind === 'file' ? s.source.path : null])).toEqual([['local', file]])
  })
})
