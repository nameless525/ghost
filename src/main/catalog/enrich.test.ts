import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import { Enricher, igdbToData, pickIgdbMatch, similarity, type IgdbGame } from './enrich'
import { QueryEngine } from './query'
import { CatalogRepo } from './repo'
import { hit, memoryDb, P } from './testing'

describe('matching', () => {
  it('similarity', () => {
    expect(similarity('chrono trigger', 'chrono trigger')).toBe(1)
    expect(similarity('chrono trigger', 'chrono cross')).toBeLessThan(0.7)
    expect(similarity('final fantasy vi', 'final fantasy iii')).toBeLessThan(0.9)
  })

  const ct: IgdbGame = { id: 1, name: 'Chrono Trigger', first_release_date: Date.UTC(1995, 2, 11) / 1000, cover: { image_id: 'co1' }, artworks: [{ image_id: 'ar1' }], franchises: [{ name: 'Chrono' }] }
  const cc: IgdbGame = { id: 2, name: 'Chrono Cross', first_release_date: Date.UTC(1999, 10, 18) / 1000 }
  const ctDs: IgdbGame = { id: 3, name: 'Chrono Trigger', first_release_date: Date.UTC(2008, 10, 20) / 1000, version_parent: 1 }

  it('picks exact names, prefers matching year and originals over editions', () => {
    expect(pickIgdbMatch({ name: 'Chrono Trigger', altNames: [], year: 1995 }, [cc, ctDs, ct])?.id).toBe(1)
    expect(pickIgdbMatch({ name: 'CHRONO TRIGGER', altNames: [], year: null }, [ctDs, ct])?.id).toBe(1)
    expect(pickIgdbMatch({ name: 'Chrono Trigger', altNames: [], year: 1995 }, [cc])).toBeNull()
    expect(pickIgdbMatch({ name: 'クロノ・トリガー', altNames: ['Chrono Trigger'], year: 1995 }, [ct])?.id).toBe(1)
    expect(pickIgdbMatch({ name: 'Something Else', altNames: [], year: 2001 }, [ct, cc])).toBeNull()
  })

  it('maps IGDB fields to image URLs', () => {
    expect(igdbToData(ct)).toEqual({
      id: 1,
      name: 'Chrono Trigger',
      altNames: [],
      year: 1995,
      cover: 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1.jpg',
      hero: 'https://images.igdb.com/igdb/image/upload/t_1080p/ar1.jpg',
      franchise: 'Chrono',
      platforms: []
    })
  })
})

describe('Enricher with mocked IGDB + SteamGridDB', () => {
  it('applies IGDB names/art/franchise and SGDB heroes; reports enrichment status', async () => {
    const db = memoryDb()
    const repo = new CatalogRepo(db)
    const ids = repo.upsertHits(
      [hit('ct-osv', 'CHRONO TRIGGER ORIGINAL SOUND VERSION', 'ost', 1995, [P.snes]), hit('zz', 'Zzyzx Unknown Game OST', 'ost', 2003, [P.win])],
      { initial: true }
    )
    repo.assignGames(ids)
    const settings = defaultSettings('/tmp')
    const calls: string[] = []
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      if (url.startsWith('https://id.twitch.tv/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 3600 })
      if (url === 'https://api.igdb.com/v4/multiquery') {
        expect((init!.headers as Record<string, string>)['Client-ID']).toBe('cid')
        const body = String(init!.body)
        const names = [...body.matchAll(/query games "g(\d+)" \{\n  search "([^"]*)"/g)]
        return Response.json(
          names.map(([, id, name]) => ({
            name: `g${id}`,
            result: /chrono trigger/i.test(name)
              ? [{ id: 20, name: 'Chrono Trigger', alternative_names: [{ name: 'クロノ・トリガー' }], first_release_date: Date.UTC(1995, 2, 11) / 1000, cover: { image_id: 'co7' }, artworks: [{ image_id: 'ar7' }], franchise: { name: 'Chrono' } }]
              : []
          }))
        )
      }
      if (url.includes('/search/autocomplete/')) return Response.json({ success: true, data: [{ id: 555, name: 'Chrono Trigger', release_date: Date.UTC(1995, 2, 11) / 1000 }] })
      if (url.includes('/heroes/game/555')) return Response.json({ success: true, data: [{ url: 'https://cdn.sgdb/hero.png' }] })
      if (url.includes('/logos/game/555')) return Response.json({ success: true, data: [{ url: 'https://cdn.sgdb/logo.png' }] })
      return new Response('?', { status: 404 })
    }) as typeof fetch
    let changes = 0
    const enricher = new Enricher({ repo, getSettings: () => settings, fetch: fetchMock, onChange: () => changes++ })
    expect(enricher.status()).toEqual({ igdb: false, steamGridDb: false })
    settings.keys = { igdbClientId: 'cid', igdbClientSecret: 'secret', steamGridDbKey: 'sg' }
    expect(enricher.status()).toEqual({ igdb: true, steamGridDb: true })

    const gid = repo.get<{ game_id: number }>(`SELECT game_id FROM albums WHERE id = ?`, ids[0])!.game_id
    enricher.want([gid])
    enricher.start()
    const t0 = Date.now()
    while (!repo.game(gid)?.logo && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20))
    enricher.stop()

    const g = repo.game(gid)!
    expect(g).toMatchObject({
      name: 'Chrono Trigger',
      year: 1995,
      franchise: 'Chrono',
      cover: 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co7.jpg',
      hero: 'https://cdn.sgdb/hero.png',
      logo: 'https://cdn.sgdb/logo.png'
    })
    expect(g.altNames).toContain('クロノ・トリガー')
    expect(g.altNames).not.toContain('CHRONO TRIGGER') // same key as the name
    expect(changes).toBeGreaterThan(0)
    // Unmatched games are marked checked so they are not retried immediately.
    const other = repo.get<{ igdb_checked_at: number | null; igdb_id: number | null }>(`SELECT igdb_checked_at, igdb_id FROM games WHERE id = (SELECT game_id FROM albums WHERE id = ?)`, ids[1])!
    expect(other.igdb_checked_at).not.toBeNull()
    expect(other.igdb_id).toBeNull()
    // IGDB alt names become searchable.
    const qe = new QueryEngine(repo, () => 'lossless')
    expect(qe.browse({ text: 'クロノ', group: 'game', sort: 'title', offset: 0, limit: 5 }).groups.map((x) => x.title)).toEqual(['Chrono Trigger'])
    expect(qe.browse({ text: 'franchise=chrono', group: 'game', sort: 'title', offset: 0, limit: 5 }).groups.map((x) => x.title)).toEqual(['Chrono Trigger'])
    expect(calls.filter((c) => c.includes('oauth2')).length).toBe(1)
  })
})

describe('Enricher after a failure', () => {
  async function until(cond: () => boolean, ms = 10_000) {
    const t0 = Date.now()
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  function setup() {
    const repo = new CatalogRepo(memoryDb())
    const addGame = (ref: string, title: string) => {
      const ids = repo.upsertHits([hit(ref, title, 'ost', 1995, [P.snes])], { initial: true })
      repo.assignGames(ids)
      return repo.get<{ game_id: number }>(`SELECT game_id FROM albums WHERE id = ?`, ids[0])!.game_id
    }
    const checked = (gid: number) => repo.get<{ igdb: number | null; sgdb: number | null }>(`SELECT igdb_checked_at AS igdb, sgdb_checked_at AS sgdb FROM games WHERE id = ?`, gid)!
    const settings = defaultSettings('/tmp')
    const down = { igdb: false, sgdb: false }
    const secrets: string[] = []
    const tokens: string[] = []
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.host === 'id.twitch.tv') {
        const secret = url.searchParams.get('client_secret')!
        secrets.push(secret)
        if (secret === 'incorrect-secret') return new Response('{"message":"invalid client secret"}', { status: 403 })
        return Response.json({ access_token: `tok-${secret}`, expires_in: 3600 })
      }
      if (url.href === 'https://api.igdb.com/v4/multiquery') {
        tokens.push(String((init!.headers as Record<string, string>).Authorization))
        if (down.igdb) return new Response('busy', { status: 500 })
        const names = [...String(init!.body).matchAll(/query games "g(\d+)"/g)]
        return Response.json(names.map(([, id]) => ({ name: `g${id}`, result: [] })))
      }
      if (url.pathname.startsWith('/api/v2/search/autocomplete/')) {
        if (down.sgdb) return new Response('busy', { status: 500 })
        return Response.json({ success: true, data: [] })
      }
      return new Response('?', { status: 404 })
    }) as typeof fetch
    let t = Date.UTC(2026, 9, 1)
    const enricher = new Enricher({ repo, getSettings: () => settings, fetch: fetchMock, onChange: () => {}, log: () => {}, now: () => t })
    return { repo, addGame, checked, settings, down, secrets, tokens, enricher, later: (ms: number) => (t += ms) }
  }

  it('a corrected IGDB secret under the same client id is used at once: new token, no back-off', async () => {
    const { addGame, checked, settings, secrets, tokens, enricher } = setup()
    const ct = addGame('ct-osv', 'Chrono Trigger OST')
    settings.keys = { igdbClientId: 'same-id', igdbClientSecret: 'incorrect-secret', steamGridDbKey: '' }
    enricher.start()
    try {
      await until(() => enricher.lastError != null)
      expect(enricher.lastError).toMatch(/IGDB auth failed/)
      // corrected in Settings (the catalog re-reads its keys on every settings change)
      settings.keys = { ...settings.keys, igdbClientSecret: 'corrected-secret' }
      enricher.configure()
      expect(enricher.lastError).toBeNull()
      await until(() => checked(ct).igdb != null)
      expect(secrets).toEqual(['incorrect-secret', 'corrected-secret'])
      expect(enricher.lastError).toBeNull()

      // rotated while a token is cached: the next request authenticates with the new secret
      const ff = addGame('ff6-osv', 'Final Fantasy VI OST')
      settings.keys = { ...settings.keys, igdbClientSecret: 'rotated-secret' }
      enricher.configure()
      await until(() => checked(ff).igdb != null)
      expect(secrets).toEqual(['incorrect-secret', 'corrected-secret', 'rotated-secret'])
      expect(tokens).toEqual(['Bearer tok-corrected-secret', 'Bearer tok-rotated-secret'])
    } finally {
      enricher.stop()
    }
  })

  it('a service’s error clears once it works again, or its key is removed; the other’s stays until then', async () => {
    const { addGame, checked, settings, down, enricher, later } = setup()
    const ct = addGame('ct-osv', 'Chrono Trigger OST')
    settings.keys = { igdbClientId: 'cid', igdbClientSecret: 'secret', steamGridDbKey: 'sg' }
    down.igdb = true
    down.sgdb = true
    enricher.want([ct])
    enricher.start()
    try {
      await until(() => /IGDB HTTP 500/.test(enricher.lastError ?? '') && /SteamGridDB HTTP 500/.test(enricher.lastError ?? ''))

      down.igdb = false
      later(31_000) // past the back-off
      enricher.want([ct])
      await until(() => checked(ct).igdb != null)
      expect(enricher.lastError).toBe('SteamGridDB HTTP 500')

      down.sgdb = false
      later(31_000)
      enricher.want([ct])
      await until(() => checked(ct).sgdb != null)
      expect(enricher.lastError).toBeNull()

      // failing again, then the key is removed: nothing is failing any more
      down.igdb = true
      addGame('ff6-osv', 'Final Fantasy VI OST')
      later(31_000)
      enricher.want([])
      await until(() => enricher.lastError != null)
      expect(enricher.lastError).toBe('IGDB HTTP 500')
      settings.keys = { ...settings.keys, igdbClientId: '', igdbClientSecret: '' }
      expect(enricher.lastError).toBeNull()
      expect(enricher.status()).toEqual({ igdb: false, steamGridDb: true })
    } finally {
      enricher.stop()
    }
  })
})
