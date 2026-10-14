import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryDb } from '../catalog/testing'
import { isNetError } from '../net/errors'
import { albumKeyOf, LocalLibrary, LocalProvider, matchLocal, musicMetadataReader, rowFromTags, type LocalFileRow, type TagInfo } from './local'
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
