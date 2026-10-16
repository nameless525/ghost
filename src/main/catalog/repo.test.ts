import { describe, expect, it } from 'vitest'
import type { OfflineAnalysisResult } from '../engine/types'
import type { AlbumHit, ProviderAlbum } from '../providers/types'
import { QueryEngine } from './query'
import { CatalogRepo } from './repo'
import { gameKey } from './normalize'
import { UNKNOWN_INTENSITY, UNKNOWN_LEN } from './schema'
import { detail, hit, memoryDb, P, seedSmall } from './testing'

/** An album page with stable track locators (detail() numbers them by position). */
function page(h: AlbumHit, tracks: [title: string, ms: number | null][], extra: Partial<ProviderAlbum> = {}): ProviderAlbum {
  const d = detail(h, tracks.map(([title, ms]) => ({ title, ms: ms ?? 0 })), extra)
  return { ...d, tracks: d.tracks.map((t, i) => ({ ...t, durationMs: tracks[i][1], locator: `${h.ref}/${t.title}.mp3` })) }
}

function trackId(repo: CatalogRepo, title: string): number {
  return repo.get<{ id: number }>(`SELECT id FROM tracks WHERE title = ?`, title)!.id
}

describe('full re-cluster while albums are edited', () => {
  it('an album page applied while it yields keeps its game, and a copy joins that game', async () => {
    const repo = new CatalogRepo(memoryDb())
    const h = hit('old-slug-title', 'Old Slug Title', 'ost', 2001, [P.win])
    const [id] = repo.upsertHits([h], { initial: true })
    repo.assignGames([id])
    let applied = false
    await repo.reclusterAll(async () => {
      if (applied) return
      applied = true
      repo.applyAlbumDetail(id, page({ ...h, title: 'Correct Game Name' }, [['Opening', 60_000]]))
    })
    const gameId = Number(repo.album(id)!.gameId)
    expect(repo.gameRow(gameId)).toMatchObject({ name: 'Correct Game Name', norm_key: 'correct game name' })
    const [copy] = repo.upsertHits([hit('copy', 'Correct Game Name Original Soundtrack', 'ost', 2001, [P.win])], { initial: false })
    repo.assignGames([copy])
    expect(repo.album(copy)!.gameId).toBe(String(gameId))
    expect(repo.all(`SELECT id FROM games WHERE name = 'Correct Game Name'`)).toHaveLength(1)
  })

  it('titles, pins and gone albums changed at any yield end up as their current values say', async () => {
    const repo = new CatalogRepo(memoryDb())
    // Several write chunks, the edited albums in the last one.
    const hits = Array.from({ length: 2500 }, (_, i) => hit(`filler-${i}`, `Filler Game ${i} OST`, 'ost', 2000, []))
    const ids = repo.upsertHits(hits, { initial: true })
    repo.assignGames(ids)
    const [renamed, pinned, gone] = ids.slice(-3)
    let n = 0
    await repo.reclusterAll(async () => {
      // Every yield until the pass records its version (the search-index merge after it would
      // never run out of work).
      if (repo.meta('cluster_version') != null) return
      n++
      repo.applyAlbumDetail(renamed, page({ ...hits[2497], title: `Renamed Game ${n}` }, [['Song', 1000]]))
      repo.pinAlbumToGame(pinned, `Pinned Game ${n}`)
      if (n === 1) repo.markAlbumError(gone, 'gone', true)
    })
    expect(n).toBeGreaterThan(3)
    const keyed = repo.all<{ id: number; title: string; game_key: string | null; norm_key: string | null }>(
      `SELECT a.id, a.title, a.game_key, g.norm_key FROM albums a LEFT JOIN games g ON g.id = a.game_id WHERE a.gone = 0`
    )
    for (const a of keyed) expect([a.id, a.norm_key]).toEqual([a.id, a.game_key ?? gameKey(a.title)])
    expect(repo.gameRow(Number(repo.album(renamed)!.gameId))!.norm_key).toBe(`renamed game ${n}`)
    expect(repo.gameRow(Number(repo.album(pinned)!.gameId))!.norm_key).toBe(`pinned game ${n}`)
    // No game is left without a visible album.
    expect(repo.all(`SELECT id FROM games WHERE id NOT IN (SELECT game_id FROM albums WHERE gone = 0 AND game_id IS NOT NULL)`)).toEqual([])
    expect(repo.album(gone)!.gameId).toBeNull()
  })
})

describe('gone albums and deleted games', () => {
  it("a gone album's tracks never take the game of one created after theirs was deleted", () => {
    const repo = new CatalogRepo(memoryDb())
    const h = hit('some-game', 'Some Game', 'ost', 2001, [P.win])
    const [id] = repo.upsertHits([h], { initial: true })
    repo.assignGames([id])
    repo.applyAlbumDetail(id, page(h, [['Song', 60_000]]))
    const oldGame = repo.album(id)!.gameId
    repo.markAlbumError(id, 'gone', true)
    const [other] = repo.upsertHits([hit('different-game', 'Different Game', 'ost', 2002, [P.win])], { initial: false })
    repo.assignGames([other])
    expect(repo.album(other)!.gameId).toBe(oldGame) // SQLite handed out the deleted game's id again
    const song = () => repo.toTrackViews(repo.trackRows('t.album_id = ?', [id]), 'lossless')[0]
    expect(song()).toMatchObject({ title: 'Song', albumTitle: 'Some Game', gameId: null, gameName: null })
    expect(repo.album(id)).toMatchObject({ gameId: null, gameName: null })
    // Back in the listing: a game of its own again.
    repo.assignGames(repo.upsertHits([h], { initial: false }))
    expect(song()).toMatchObject({ gameName: 'Some Game' })
    expect(song().gameId).not.toBe(oldGame)
  })

  it('a full re-cluster clears references older versions left dangling or reused, and keeps real ones', async () => {
    const repo = new CatalogRepo(memoryDb())
    const ids = repo.upsertHits(
      [
        hit('some-game', 'Some Game', 'ost', 2001, []),
        hit('kept-ost', 'Kept Game Original Soundtrack', 'ost', 2001, []),
        hit('kept-rip', 'Kept Game (Gamerip)', 'gamerip', 2001, []),
        hit('lost', 'Lost Game', 'ost', 2001, []),
        hit('different-game', 'Different Game', 'ost', 2002, [])
      ],
      { initial: true }
    )
    repo.assignGames(ids)
    const [some, keptOst, , lost, different] = ids
    const keptGame = repo.album(keptOst)!.gameId
    for (const id of [some, keptOst, lost]) repo.markAlbumError(id, 'gone', true)
    // As an older version left them: pointing at another game's id, or at no game at all.
    repo.run(`UPDATE albums SET game_id = ? WHERE id = ?`, Number(repo.album(different)!.gameId), some)
    repo.run(`UPDATE albums SET game_id = 999 WHERE id = ?`, lost)
    await repo.reclusterAll(async () => {})
    expect(repo.album(some)!.gameId).toBeNull()
    expect(repo.album(lost)!.gameId).toBeNull()
    expect(repo.album(keptOst)!.gameId).toBe(keptGame)
  })
})

describe('track search documents follow the game', () => {
  const inGameColumn = (repo: CatalogRepo, text: string) => repo.all<{ rowid: number }>(`SELECT rowid FROM track_fts WHERE track_fts MATCH ?`, `{game} : "${text}"`).map((r) => r.rowid)

  it('an arrangement regrouped under its game by a full re-cluster', async () => {
    const repo = new CatalogRepo(memoryDb())
    const qe = new QueryEngine(repo, () => 'lossless')
    const arr = hit('zelda-twm', 'Legend of Zelda: Time Warp Melodies', 'arrange', 2016, [])
    const [a] = repo.upsertHits([arr], { initial: true })
    repo.assignGames([a])
    repo.applyAlbumDetail(a, page(arr, [['Opening', 60_000]]))
    repo.assignGames(repo.upsertHits([hit('zelda-ost', 'The Legend of Zelda Original Soundtrack', 'ost', 1986, [])], { initial: false }))
    expect(qe.searchTracks('"the legend of zelda"')).toEqual([])
    await repo.reclusterAll(async () => {})
    expect(repo.album(a)!.gameName).toBe('The Legend of Zelda')
    expect(qe.searchTracks('"the legend of zelda"').map((t) => t.title)).toEqual(['Opening'])
    expect(qe.searchTracks('game="the legend of zelda"').map((t) => t.title)).toEqual(['Opening'])
  })

  it('an album pinned to a game whose names stay the same', () => {
    const repo = new CatalogRepo(memoryDb())
    const { albums } = seedSmall(repo)
    const hornet = trackId(repo, 'Hornet')
    expect(inGameColumn(repo, 'hollow knight')).toContain(hornet)
    const ct = repo.game(Number(repo.album(albums['chrono-trigger-osv'])!.gameId))!
    repo.pinAlbumToGame(albums['hollow-knight-ost'], 'Chrono Trigger')
    expect(repo.game(Number(ct.id))).toMatchObject({ name: ct.name, altNames: ct.altNames })
    expect(inGameColumn(repo, 'chrono trigger')).toContain(hornet)
    expect(inGameColumn(repo, 'hollow knight')).not.toContain(hornet)
  })

  it('alternative game and album titles find tracks as they find albums, before and after a rebuild', async () => {
    const repo = new CatalogRepo(memoryDb())
    const { albums } = seedSmall(repo)
    const qe = new QueryEngine(repo, () => 'lossless')
    const titles = (text: string) => qe.searchTracks(text, 100).map((t) => t.title).sort()
    const ff6 = Number(repo.album(albums['ff6-osv'])!.gameId)
    // An IGDB alternative name, applied the way enrichment applies it.
    const igdb = { id: 1, name: 'Final Fantasy VI', altNames: ['Final Fantasy III'], year: 1994, cover: null, hero: null, franchise: null, platforms: [] }
    repo.run(`UPDATE games SET igdb_json = ? WHERE id = ?`, JSON.stringify(igdb), ff6)
    repo.updateAlbumFts(repo.refreshGames([ff6]))
    const check = () => {
      expect(titles('クロノ')).toEqual(['Battle with Magus', 'Boss Battle 1', 'Corridors of Time', 'Peaceful Days'])
      expect(titles('クロノ')).toEqual(titles('game=クロノ'))
      expect(titles('"final fantasy iii"')).toEqual(['Dancing Mad', 'Opening Theme', 'The Decisive Battle'])
      expect(titles('"final fantasy iii"')).toEqual(titles('game="final fantasy iii"'))
    }
    check()
    repo.setMeta('fts_version', null)
    expect(await repo.rebuildFts(async () => {})).toBe(true)
    check()
  })
})

describe('album and game length / intensity follow their active tracks', () => {
  const analysis = (intensity: number | null, durationMs: number): OfflineAnalysisResult => ({
    integratedLufs: -14,
    loudnessRange: 6,
    truePeakDb: -1,
    bpm: 120,
    bpmConfidence: 0.9,
    beats: [],
    downbeats: [],
    kiai: [],
    energy: [],
    intensity,
    durationMs
  })
  type Facts = { total_ms: number | null; sort_len: number; intensity: number | null; sort_intensity: number }
  const facts = (repo: CatalogRepo, albumId: number) => {
    const cols = 'total_ms, sort_len, intensity, sort_intensity'
    const album = repo.get<Facts & { game_id: number }>(`SELECT ${cols}, game_id FROM albums WHERE id = ?`, albumId)!
    const game = repo.get<Facts>(`SELECT ${cols} FROM games WHERE id = ?`, album.game_id)!
    return { album: { total_ms: album.total_ms, sort_len: album.sort_len, intensity: album.intensity, sort_intensity: album.sort_intensity }, game }
  }
  const len = (ms: number | null) => ({ total_ms: ms, sort_len: ms ?? UNKNOWN_LEN })
  const inten = (v: number | null) => ({ intensity: v, sort_intensity: v ?? UNKNOWN_INTENSITY })

  it('a length learned by analysis counts, a refresh without lengths keeps it, removed tracks stop counting', () => {
    const repo = new CatalogRepo(memoryDb())
    const h = hit('chip-set', 'Chip Set', 'gamerip', 1990, [])
    const [id] = repo.upsertHits([h], { initial: true })
    repo.assignGames([id])
    repo.applyAlbumDetail(id, page(h, [['Stage 1', null]]))
    expect(facts(repo, id)).toMatchObject({ album: len(null), game: len(null) })
    repo.recordAnalysis(trackId(repo, 'Stage 1'), analysis(null, 120_000))
    expect(facts(repo, id)).toMatchObject({ album: len(120_000), game: len(120_000) })
    repo.applyAlbumDetail(id, page(h, [['Stage 1', null]]))
    expect(facts(repo, id)).toMatchObject({ album: len(120_000), game: len(120_000) })
    repo.applyAlbumDetail(id, page(h, [['Stage 1', null], ['Stage 2', 30_000]]))
    expect(facts(repo, id)).toMatchObject({ album: len(150_000), game: len(150_000) })
    repo.applyAlbumDetail(id, page(h, [['Stage 2', 30_000]]))
    expect(facts(repo, id)).toMatchObject({ album: len(30_000), game: len(30_000) })
  })

  it('removed analysed tracks leave the intensity; a restored one counts again', () => {
    const repo = new CatalogRepo(memoryDb())
    const h = hit('loud-quiet', 'Loud and Quiet', 'ost', 2010, [])
    const [id] = repo.upsertHits([h], { initial: true })
    repo.assignGames([id])
    repo.applyAlbumDetail(id, page(h, [['Loud', 60_000], ['Quiet', 60_000]]))
    repo.recordAnalysis(trackId(repo, 'Loud'), analysis(10, 60_000))
    repo.recordAnalysis(trackId(repo, 'Quiet'), analysis(2, 60_000))
    expect(facts(repo, id)).toMatchObject({ album: inten(6), game: inten(6) })
    repo.applyAlbumDetail(id, page(h, [['Quiet', 60_000]]))
    expect(facts(repo, id)).toMatchObject({ album: inten(2), game: inten(2) })
    repo.applyAlbumDetail(id, page(h, [['New', 60_000]]))
    expect(facts(repo, id)).toMatchObject({ album: { ...inten(null), ...len(60_000) }, game: inten(null) })
    repo.applyAlbumDetail(id, page(h, [['Loud', 60_000], ['New', 60_000]]))
    expect(facts(repo, id)).toMatchObject({ album: { ...inten(10), ...len(120_000) }, game: inten(10) })
  })

  it('an FTS rebuild repairs aggregates written by older versions', async () => {
    const repo = new CatalogRepo(memoryDb())
    const h = hit('chip-set', 'Chip Set', 'gamerip', 1990, [])
    const [id] = repo.upsertHits([h], { initial: true })
    repo.assignGames([id])
    repo.applyAlbumDetail(id, page(h, [['Stage 1', 120_000]]))
    repo.run(`UPDATE albums SET total_ms = NULL, sort_len = ? WHERE id = ?`, UNKNOWN_LEN, id)
    repo.run(`UPDATE games SET total_ms = NULL, sort_len = ?`, UNKNOWN_LEN)
    repo.setMeta('fts_version', null)
    await repo.rebuildFts(async () => {})
    expect(facts(repo, id)).toMatchObject({ album: len(120_000), game: len(120_000) })
  })
})
