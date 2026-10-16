import { beforeAll, describe, expect, it } from 'vitest'
import type { BrowseQuery } from '../../shared/types'
import { QueryEngine } from './query'
import { CatalogRepo } from './repo'
import { detail, hit, memoryDb } from './testing'

const q = (text: string): BrowseQuery => ({ text, group: 'album', sort: 'title', offset: 0, limit: 100 })

describe('short composer filters match the credits longer ones do', () => {
  const repo = new CatalogRepo(memoryDb())
  const qe = new QueryEngine(repo, () => 'lossless')

  beforeAll(() => {
    // Track credits only; and album credits that differ from one track's own.
    const solo = hit('solo', 'Solo Album', 'ost', 2001, [])
    const mixed = hit('mixed', 'Mixed Album', 'arrange', 2002, [])
    const ids = repo.upsertHits([solo, mixed], { initial: true })
    repo.assignGames(ids)
    const d1 = detail(solo, [{ title: 'Solo Credited', ms: 60_000 }, { title: 'Solo Uncredited', ms: 60_000 }])
    d1.tracks[0].composers = ['光田康典']
    repo.applyAlbumDetail(ids[0], d1)
    const d2 = detail(mixed, [{ title: 'Mixed Own Credit', ms: 60_000 }, { title: 'Mixed Album Credit', ms: 60_000 }], { composers: ['Zeta Person'] })
    d2.tracks[0].composers = ['光田康典']
    repo.applyAlbumDetail(ids[1], d2)
  })

  const tracks = (text: string) => qe.searchTracks(text, 100).map((t) => t.title).sort()
  const albums = (text: string) => qe.browse(q(text)).groups.map((g) => g.title)

  it("tracks: a track's own credits, else its album's", () => {
    expect(tracks('composer=光田')).toEqual(['Mixed Own Credit', 'Solo Credited'])
    expect(tracks('composer=光田')).toEqual(tracks('composer=光田康'))
    expect(tracks('composer!=光田')).toEqual(['Mixed Album Credit', 'Solo Uncredited'])
    expect(tracks('composer!=光田')).toEqual(tracks('composer!=光田康'))
    expect(tracks('composer=z')).toEqual(['Mixed Album Credit'])
    expect(tracks('composer=z')).toEqual(tracks('composer=zeta'))
    expect(tracks('composer!=z')).toEqual(tracks('composer!=zeta'))
  })

  it("albums: the album's credits and its tracks'", () => {
    expect(albums('composer=光田')).toEqual(['Mixed Album', 'Solo Album'])
    expect(albums('composer=光田')).toEqual(albums('composer=光田康'))
    expect(albums('composer!=光田')).toEqual([])
    expect(albums('composer=z')).toEqual(['Mixed Album'])
    expect(albums('composer=z')).toEqual(albums('composer=zeta'))
    expect(albums('composer!=z')).toEqual(albums('composer!=zeta'))
  })
})

describe('source=lossy counts resolved sources, as format and lossless filters do', () => {
  const setup = (format: string, lossless = false) => {
    const repo = new CatalogRepo(memoryDb())
    const qe = new QueryEngine(repo, () => 'lossless')
    const h = hit('unknown-formats', 'Unknown Formats', 'ost', 2001, [])
    const [id] = repo.upsertHits([h], { initial: true })
    repo.assignGames([id])
    repo.applyAlbumDetail(id, detail(h, [{ title: 'Opening', ms: 60_000 }, { title: 'Ending', ms: 60_000 }], { formats: [] }))
    const opening = repo.get<{ id: number }>(`SELECT id FROM tracks WHERE title = 'Opening'`)!.id
    repo.run(
      `INSERT INTO sources (track_id, provider, locator, cache_key, format, lossless, verified_at) VALUES (?, 'youtube', 'v', 'yt:v', ?, ?, 0)`,
      opening,
      format,
      lossless ? 1 : 0
    )
    return (text: string) => qe.searchTracks(text, 100).map((t) => t.title).sort()
  }

  it.each(['mp3', 'ogg', 'm4a', 'aac', 'opus'])('a resolved %s source', (format) => {
    const tracks = setup(format)
    expect(tracks(`source=${format}`)).toEqual(['Ending', 'Opening'])
    expect(tracks('source=lossy')).toEqual(tracks(`source=${format}`))
    expect(tracks('source!=lossy')).toEqual([])
    expect(tracks('source=lossless')).toEqual([])
  })

  it('lossless or unknown resolved sources are not lossy', () => {
    const flac = setup('flac', true)
    expect(flac('source=lossy')).toEqual([])
    expect(flac('source=lossless')).toEqual(['Ending', 'Opening'])
    const unknown = setup('unknown')
    expect(unknown('source=lossy')).toEqual([])
    expect(unknown('source=lossless')).toEqual([])
    expect(unknown('source!=lossy')).toEqual(['Ending', 'Opening'])
  })
})
