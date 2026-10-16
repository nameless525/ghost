import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryDb } from '../catalog/testing'
import { isNetError } from '../net/errors'
import { albumKeyOf, localAlbums, LocalLibrary, LocalProvider, matchLocal, musicMetadataReader, rowFromTags, type LocalFileRow, type LocalFs, type ScanProgress, type TagInfo } from './local'
import type { CanonicalTrack } from './types'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ghost-local-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A tiny PCM WAV with a RIFF INFO tag chunk (title / album / artist). */
function wav(seconds: number, tags: { title?: string; album?: string; artist?: string } = {}): Buffer {
  const rate = 8000
  const data = Buffer.alloc(rate * seconds * 2)
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0) // PCM
  fmt.writeUInt16LE(1, 2) // mono
  fmt.writeUInt32LE(rate, 4)
  fmt.writeUInt32LE(rate * 2, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const chunk = (id: string, body: Buffer) => {
    const pad = body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)
    const h = Buffer.alloc(8)
    h.write(id, 0, 'ascii')
    h.writeUInt32LE(body.length, 4)
    return Buffer.concat([h, body, pad])
  }
  const z = (s: string) => Buffer.from(`${s}\0`, 'utf8')
  const info = [tags.title && chunk('INAM', z(tags.title)), tags.album && chunk('IPRD', z(tags.album)), tags.artist && chunk('IART', z(tags.artist))].filter(Boolean) as Buffer[]
  const list = info.length ? chunk('LIST', Buffer.concat([Buffer.from('INFO'), ...info])) : Buffer.alloc(0)
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), list, chunk('data', data)])
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from(Uint32Array.of(body.length).buffer), body])
}

function track(title: string, durationMs: number | null, extra: Partial<CanonicalTrack> = {}): CanonicalTrack {
  return { trackId: '1', title, albumTitle: 'Hollow Knight', gameName: 'Hollow Knight', composers: [], durationMs, disc: 1, number: 1, year: null, platforms: [], albumProvider: 'khinsider', albumRef: 'x', locator: 'x', ...extra }
}

describe('local: rows from tags', () => {
  it('falls back to file / folder names when tags are missing', () => {
    const r = rowFromTags('/m/Hollow Knight OST/02 - Dirtmouth.flac', '/m', { mtimeMs: 1000.4, size: 10 }, {}, 1)
    expect(r).toMatchObject({ title: 'Dirtmouth', album: 'Hollow Knight OST', track_no: 2, format: 'flac', lossless: 1, title_key: 'dirtmouth', album_key: 'hollow knight', mtime_ms: 1000 })
    const t = rowFromTags('/m/x.mp3', '/m', { mtimeMs: 1, size: 10 }, { title: 'Hornet', album: 'Hollow Knight (Original Soundtrack)', durationMs: 167_000, codec: 'MPEG 1 Layer 3' }, 1)
    expect(t).toMatchObject({ title: 'Hornet', album_key: 'hollow knight', format: 'mp3', lossless: 0, duration_ms: 167_000 })
    expect(albumKeyOf('Final Fantasy VI Original Sound Version')).toBe('final fantasy vi')
  })

  it('reads real tags with music-metadata', async () => {
    const d = tmp()
    const f = join(d, 'a.wav')
    writeFileSync(f, wav(2, { title: 'Dirtmouth', album: 'Hollow Knight', artist: 'Christopher Larkin' }))
    const tags = await musicMetadataReader(f)
    expect(tags).toMatchObject({ title: 'Dirtmouth', album: 'Hollow Knight', artist: 'Christopher Larkin', durationMs: 2000, lossless: true })
  })
})

describe('local: albums', () => {
  const M = join(tmpdir(), 'ghost-albums-test')
  const at = (path: string, tags: TagInfo = {}) => rowFromTags(join(M, path), M, { mtimeMs: 1, size: 100 }, tags, 1)
  const shape = (rows: LocalFileRow[]) => localAlbums(rows).map((a) => ({ ref: a.ref, title: a.title, tracks: a.tracks.map((t) => `${t.disc}·${t.number} ${t.title}`) }))

  it('groups tagged files by album and album artist, discs together', () => {
    const [a] = localAlbums([
      at('FF7/CD2/01.flac', { title: 'Opening', album: 'Final Fantasy VII OST (Disc 2)', track: 1, codec: 'FLAC' }),
      at('FF7/CD1/02.flac', { title: 'Bombing Mission', album: 'Final Fantasy VII OST (Disc 1)', albumArtist: 'Nobuo Uematsu', track: 2, composer: 'Nobuo Uematsu', codec: 'FLAC' }),
      at('FF7/CD1/01.flac', { title: 'Prelude', album: 'Final Fantasy VII OST (Disc 1)', albumArtist: 'Nobuo Uematsu', track: 1, durationMs: 160_000, codec: 'FLAC' })
    ])
    expect(a).toMatchObject({ provider: 'local', ref: 'final fantasy vii ost|nobuo uematsu', title: 'Final Fantasy VII OST', kind: 'ost', composers: ['Nobuo Uematsu'], formats: ['flac'], totalSizes: { flac: 300 } })
    expect(a.tracks.map((t) => `${t.disc}·${t.number} ${t.title}`)).toEqual(['1·1 Prelude', '1·2 Bombing Mission', '2·1 Opening'])
    expect(a.tracks[0]).toMatchObject({ locator: join(M, 'FF7', 'CD1', '01.flac'), durationMs: 160_000, files: [{ format: 'flac', sizeBytes: 100 }] })
  })

  it('untagged files take their folder’s name; disc folders their parent’s; loose files belong to no album', () => {
    expect(at('Chrono Trigger OST/CD2/01 Corridors of Time.mp3')).toMatchObject({ album: 'Chrono Trigger OST', disc_no: 2, track_no: 1, title: 'Corridors of Time' })
    expect(shape([at('Chrono Trigger OST/CD1/01 Peaceful Days.mp3'), at('Chrono Trigger OST/CD2/01 Corridors of Time.mp3'), at('loose.mp3')])).toEqual([
      { ref: 'chrono trigger ost|', title: 'Chrono Trigger OST', tracks: ['1·1 Peaceful Days', '2·1 Corridors of Time'] }
    ])
    // Files indexed before disc folders were understood: "CD1" as the album.
    const legacy = { ...at('Chrono Trigger OST/CD1/02 Wind Scene.mp3'), album: 'CD1', disc_no: null }
    expect(shape([legacy])).toEqual([{ ref: 'chrono trigger ost|', title: 'Chrono Trigger OST', tracks: ['1·2 Wind Scene'] }])
  })

  it('different album artists, and copies of one album in two folders, are separate albums', () => {
    const hits = (artist: string) => at(`${artist}/1.mp3`, { title: 'One', album: 'Greatest Hits', albumArtist: artist, track: 1 })
    expect(shape([hits('A'), hits('B')]).map((a) => a.ref)).toEqual(['greatest hits|a', 'greatest hits|b'])
    const copy = (dir: string, ext: string) => at(`${dir}/01.${ext}`, { title: 'Enter Hallownest', album: 'Hollow Knight', track: 1 })
    expect(shape([copy('HK FLAC', 'flac'), copy('HK MP3', 'mp3')])).toEqual([
      { ref: `hollow knight||${join(M, 'HK FLAC')}`, title: 'Hollow Knight', tracks: ['1·1 Enter Hallownest'] },
      { ref: `hollow knight||${join(M, 'HK MP3')}`, title: 'Hollow Knight', tracks: ['1·1 Enter Hallownest'] }
    ])
    expect(localAlbums([at('x/1.flac', { title: 'A', album: 'Hollow Knight Piano Collections' })])[0].kind).toBe('arrange')
  })
})

describe('local: incremental scans', () => {
  it('indexes, skips unchanged files, re-reads changed ones, drops removed files and folders', async () => {
    const root = tmp()
    mkdirSync(join(root, 'Hollow Knight'))
    mkdirSync(join(root, '.hidden'))
    const tags: Record<string, TagInfo> = {
      [join(root, 'Hollow Knight', '01.flac')]: { title: 'Enter Hallownest', album: 'Hollow Knight', durationMs: 90_000, lossless: true, codec: 'FLAC' },
      [join(root, 'Hollow Knight', '02.flac')]: { title: 'Dirtmouth', album: 'Hollow Knight', durationMs: 115_000, lossless: true, codec: 'FLAC' },
      [join(root, 'other.mp3')]: { title: 'Main Theme', album: 'Some Other Game', durationMs: 60_000 }
    }
    for (const p of Object.keys(tags)) writeFileSync(p, 'x')
    writeFileSync(join(root, 'notes.txt'), 'x')
    writeFileSync(join(root, '.hidden', 'secret.mp3'), 'x')
    const reads: string[] = []
    const lib = new LocalLibrary(memoryDb(), {
      readTags: async (p) => {
        reads.push(p)
        if (p.endsWith('other.mp3') && reads.filter((x) => x === p).length > 1) throw new Error('corrupt')
        return tags[p] ?? {}
      }
    })
    const r1 = await lib.scan([root])
    expect(r1).toMatchObject({ files: 3, added: 3, updated: 0, removed: 0, errors: 0 })
    expect(lib.count()).toBe(3)
    expect(reads.length).toBe(3)

    const r2 = await lib.scan([root])
    expect(r2).toMatchObject({ files: 3, added: 0, updated: 0, removed: 0 })
    expect(reads.length).toBe(3)

    // change one file (mtime), remove another
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(root, 'other.mp3'), later, later)
    rmSync(join(root, 'Hollow Knight', '01.flac'))
    const r3 = await lib.scan([root])
    expect(r3).toMatchObject({ files: 2, added: 0, updated: 1, removed: 1, errors: 1, removedPaths: [join(root, 'Hollow Knight', '01.flac')] })
    // an unreadable file is still indexed from its name
    expect(lib.row(join(root, 'other.mp3'))).toMatchObject({ title: 'other', album: null })

    // concurrent scans coalesce
    const [a, b] = await Promise.all([lib.scan([root]), lib.scan([root])])
    expect(a.files).toBe(2)
    expect(b.files).toBe(2)

    // folder removed from settings → its rows go
    const r4 = await lib.scan([])
    expect(r4.removed).toBe(2)
    expect(lib.count()).toBe(0)
  })

  it('reports its phases: walking the folders, reading new files’ tags, done (also when nothing changed)', async () => {
    const root = tmp()
    mkdirSync(join(root, 'A'), { recursive: true })
    for (const n of ['1.mp3', '2.mp3', '3.flac', 'notes.txt']) writeFileSync(join(root, 'A', n), 'x')
    writeFileSync(join(root, '4.ogg'), 'x')
    const lib = new LocalLibrary(memoryDb(), { readTags: async () => ({}) })
    const seen: ScanProgress[] = []
    const r = await lib.scan([root, join(root, 'missing')], { onProgress: (p) => seen.push(p) })
    expect(r.byRoot).toEqual([{ root, files: 4, added: 4 }])
    expect(r.unavailable).toEqual([join(root, 'missing')])
    expect(seen.filter((p) => p.phase === 'walk').map((p) => (p as { found: number }).found)).toEqual([0, 1, 2, 3, 4])
    expect(seen.filter((p) => p.phase === 'tags')).toEqual([
      { phase: 'tags', done: 0, total: 4 },
      { phase: 'tags', done: 4, total: 4 }
    ])
    expect(seen.at(-1)).toEqual({ phase: 'done' })
    seen.length = 0
    await lib.scan([root], { onProgress: (p) => seen.push(p) })
    expect(seen.map((p) => p.phase)).toEqual(['walk', 'walk', 'walk', 'walk', 'walk', 'done'])
    // A failing scan still ends.
    seen.length = 0
    lib.db.close()
    await expect(lib.scan([root], { onProgress: (p) => seen.push(p) })).rejects.toThrow()
    expect(seen.at(-1)).toEqual({ phase: 'done' })
  })

  it('an unavailable folder keeps what was known', async () => {
    const root = tmp()
    writeFileSync(join(root, 'a.mp3'), 'x')
    const lib = new LocalLibrary(memoryDb(), { readTags: async () => ({ title: 'A' }) })
    await lib.scan([root])
    rmSync(root, { recursive: true, force: true })
    const r = await lib.scan([root])
    expect(r.removed).toBe(0)
    expect(lib.count()).toBe(1)
  })
})

describe('local: folders and files that can’t be read', () => {
  /** The real filesystem, except for the paths given an error code (EACCES: no permission; ENOENT: gone). */
  function failing(): LocalFs & { readdirFails: Record<string, string>; statFails: Record<string, string> } {
    const err = (code: string) => Object.assign(new Error(`${code}: test`), { code })
    const fs = {
      readdirFails: {} as Record<string, string>,
      statFails: {} as Record<string, string>,
      readdir: async (dir: string, opts: { withFileTypes: true }) => {
        if (fs.readdirFails[dir]) throw err(fs.readdirFails[dir])
        return readdir(dir, opts)
      },
      stat: async (p: string) => {
        if (fs.statFails[p]) throw err(fs.statFails[p])
        return stat(p)
      }
    }
    return fs
  }
  async function setup() {
    const root = tmp()
    const files = [join(root, 'A', '1.mp3'), join(root, 'A', '2.mp3'), join(root, 'B', '1.mp3'), join(root, 'B', '2.mp3')]
    for (const f of files) {
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, 'x')
    }
    const fs = failing()
    const lib = new LocalLibrary(memoryDb(), { readTags: async (p) => ({ title: basename(p) }), fs })
    expect(await lib.scan([root])).toMatchObject({ files: 4, added: 4 })
    return { root, files, fs, lib, paths: () => lib.rows().map((r) => r.path) }
  }

  it('an unreadable subfolder keeps its files while readable ones still update', async () => {
    const { root, files, fs, lib, paths } = await setup()
    fs.readdirFails[join(root, 'A')] = 'EACCES'
    rmSync(files[2])
    const later = new Date(Date.now() + 60_000)
    utimesSync(files[3], later, later)
    const r = await lib.scan([root])
    expect(r).toMatchObject({ removed: 1, removedPaths: [files[2]], updated: 1, changedPaths: [files[3]], incomplete: [root], unavailable: [] })
    expect(paths()).toEqual([files[0], files[1], files[3]])
    // Readable again: nothing was lost, nothing to re-read.
    delete fs.readdirFails[join(root, 'A')]
    expect(await lib.scan([root])).toMatchObject({ files: 3, added: 0, updated: 0, removed: 0, incomplete: [] })
  })

  it('a subfolder that vanished while scanning is gone', async () => {
    const { root, files, fs, lib, paths } = await setup()
    fs.readdirFails[join(root, 'A')] = 'ENOENT'
    expect(await lib.scan([root])).toMatchObject({ removed: 2, incomplete: [] })
    expect(paths()).toEqual([files[2], files[3]])
  })

  it('a folder that can’t be listed is unavailable and keeps everything', async () => {
    const { root, fs, lib } = await setup()
    fs.readdirFails[root] = 'EACCES'
    expect(await lib.scan([root])).toMatchObject({ files: 0, removed: 0, unavailable: [root], byRoot: [] })
    expect(lib.count()).toBe(4)
  })

  it('a file that can’t be looked at is kept; one that vanished is gone', async () => {
    const { root, files, fs, lib, paths } = await setup()
    fs.statFails[files[0]] = 'EIO'
    fs.statFails[files[1]] = 'ENOENT'
    expect(await lib.scan([root])).toMatchObject({ removed: 1, removedPaths: [files[1]], incomplete: [root] })
    expect(paths()).toEqual([files[0], files[2], files[3]])
  })
})

describe('local: matching', () => {
  const row = (p: Partial<LocalFileRow>): LocalFileRow => ({
    path: '/m/x.flac',
    root: '/m',
    mtime_ms: 0,
    size: 1,
    title: 'Dirtmouth',
    album: 'Hollow Knight',
    artist: null,
    album_artist: null,
    composer: null,
    track_no: 2,
    disc_no: 1,
    duration_ms: 115_000,
    format: 'flac',
    bitrate: 900,
    lossless: 1,
    title_key: 'dirtmouth',
    album_key: 'hollow knight',
    ...p
  })

  it('same album + title + length → high confidence', () => {
    const [m] = matchLocal([row({})], track('Dirtmouth', 115_000))
    expect(m).toMatchObject({ provider: 'local', locator: '/m/x.flac', albumMatch: true })
    expect(m.confidence).toBe(1)
  })
  it('album named differently but same game key still matches', () => {
    const [m] = matchLocal([row({ album: 'Hollow Knight (Original Soundtrack)', album_key: albumKeyOf('Hollow Knight (Original Soundtrack)') })], track('Dirtmouth', 115_000, { albumTitle: 'Hollow Knight OST' }))
    expect(m.albumMatch).toBe(true)
  })
  it('a same-named track from another album needs a matching duration', () => {
    const other = row({ title: 'Main Theme', title_key: 'main theme', album: 'Other Game', album_key: 'other game', duration_ms: 60_000 })
    expect(matchLocal([other], track('Main Theme', 200_000))).toEqual([])
    expect(matchLocal([other], track('Main Theme', null))).toEqual([])
    expect(matchLocal([other], track('Main Theme', 60_500))[0].albumMatch).toBe(false)
  })
  it('different titles do not match', () => {
    expect(matchLocal([row({ title: 'Crossroads', title_key: 'crossroads' })], track('Dirtmouth', 115_000))).toEqual([])
  })
  it('another numbered variant on the same album is not this track', () => {
    const ct = { albumTitle: 'Chrono Trigger', gameName: 'Chrono Trigger' }
    const at = (title: string) => row({ path: `/m/${title}.flac`, title, title_key: title.toLowerCase(), album: 'Chrono Trigger', album_key: 'chrono trigger', duration_ms: 140_000 })
    expect(matchLocal([at('Boss Battle 2')], track('Boss Battle 1', 140_000, ct))).toEqual([])
    expect(matchLocal([at('Boss Battle 2'), at('Boss Battle 1')], track('Boss Battle 1', 140_000, ct)).map((m) => m.locator)).toEqual(['/m/Boss Battle 1.flac'])
    expect(matchLocal([at('Stage 2')], track('Stage II', 140_000, ct))[0]).toMatchObject({ albumMatch: true, confidence: 1 })
  })

  it('hundreds of same-named tracks elsewhere never hide the album’s own', async () => {
    const lib = new LocalLibrary(memoryDb())
    const insert = lib.db.prepare(
      `INSERT INTO local_files (path, root, mtime_ms, size, title, album, artist, album_artist, composer, track_no, disc_no, duration_ms, format, bitrate, lossless, title_key, album_key, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const put = (path: string, tags: TagInfo) => {
      const r = rowFromTags(path, '/music', { mtimeMs: 1, size: 1000 }, tags, 1)
      insert.run(r.path, r.root, r.mtime_ms, r.size, r.title, r.album, r.artist, r.album_artist, r.composer, r.track_no, r.disc_no, r.duration_ms, r.format, r.bitrate, r.lossless, r.title_key, r.album_key, r.scanned_at)
    }
    for (let i = 0; i < 600; i++) put(`/music/a-other-${String(i).padStart(3, '0')}.flac`, { title: 'Main Theme', album: `Other ${i}`, durationMs: 120_000 })
    put('/music/wanted.flac', { title: 'Main Theme', album: 'My Game', durationMs: 120_000 })
    // One album bigger than the cap, its wanted track listed last.
    for (let i = 0; i < 600; i++) put(`/music/big/${String(i).padStart(3, '0')}.flac`, { title: `Track ${i}`, album: 'Big Game', durationMs: 60_000 })
    put('/music/big/zzz.flac', { title: 'Finale', album: 'Big Game', durationMs: 200_000 })
    const p = new LocalProvider(lib)
    const mine = { albumTitle: 'My Game', gameName: 'My Game' }
    expect(lib.candidates({ title: 'Main Theme', durationMs: 120_000, ...mine }).map((r) => r.path)).toContain('/music/wanted.flac')
    const [best] = await p.findTrack(track('Main Theme', 120_000, mine))
    expect(best).toMatchObject({ locator: '/music/wanted.flac', confidence: 1 })
    const [finale] = await p.findTrack(track('Finale', 200_000, { albumTitle: 'Big Game', gameName: 'Big Game' }))
    expect(finale?.locator).toBe('/music/big/zzz.flac')
    // Same-named tracks of other albums come closest length first (only a convincing length lets them match).
    put('/music/zz-close.flac', { title: 'Main Theme', album: 'Elsewhere', durationMs: 90_500 })
    const [near] = await p.findTrack(track('Main Theme', 90_000, { albumTitle: 'Not Here', gameName: 'Not Here' }))
    expect(near).toMatchObject({ locator: '/music/zz-close.flac' })
  })

  it('provider: DB candidates → file sources; a vanished file is not_found', async () => {
    const root = tmp()
    const f = join(root, 'Dirtmouth.wav')
    writeFileSync(f, wav(1, { title: 'Dirtmouth', album: 'Hollow Knight' }))
    const lib = new LocalLibrary(memoryDb())
    await lib.scan([root])
    const p = new LocalProvider(lib)
    expect(p.findTrackMode).toBe('always')
    const [c] = await p.findTrack(track('Dirtmouth', 1000))
    expect(c).toMatchObject({ provider: 'local', locator: f })
    const [s] = await p.resolveStream(c.locator)
    expect(s).toMatchObject({ provider: 'local', format: 'wav', lossless: true, source: { kind: 'file', path: f, formatHint: 'wav' } })
    rmSync(f)
    await expect(p.resolveStream(f)).rejects.toSatisfy((e: unknown) => isNetError(e, 'not_found'))
  })
})
