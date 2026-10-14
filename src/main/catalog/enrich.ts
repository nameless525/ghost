// Enrichment (DESIGN §6.3 tier 2): IGDB (names, alt names, year, franchise, cover, artwork) and
// SteamGridDB (hero, logo), plus accent colours from cover art. These are normal JSON APIs, so
// plain `fetch` is fine. Everything is optional: without keys we skip it and report
// `enrichment: { igdb: false, steamGridDb: false }`.

import type { Settings } from '../../shared/types'
import { HostLimiter } from '../net/limiter'
import { keyOf } from './normalize'
import type { CatalogRepo, IgdbData, SgdbData } from './repo'
import { j } from './repo'

type FetchFn = typeof fetch

const IGDB_IMG = 'https://images.igdb.com/igdb/image/upload'
const SGDB_API = 'https://www.steamgriddb.com/api/v2'
const RECHECK_MS = 30 * 24 * 3600_000

export interface IgdbGame {
  id: number
  name: string
  alternative_names?: { name: string }[]
  first_release_date?: number
  cover?: { image_id: string }
  artworks?: { image_id: string }[]
  screenshots?: { image_id: string }[]
  franchise?: { name: string }
  franchises?: { name: string }[]
  collections?: { name: string }[]
  platforms?: { abbreviation?: string; name?: string }[]
  version_parent?: number
}

/** Dice coefficient on character bigrams of two keys. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const ga = grams(a)
  const gb = grams(b)
  let inter = 0
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0)
  return (2 * inter) / (a.length - 1 + (b.length - 1))
}

const yearOf = (unixSec?: number) => (unixSec ? new Date(unixSec * 1000).getUTCFullYear() : null)

/** Best IGDB candidate for one of our games, or null when nothing is close enough. */
export function pickIgdbMatch(game: { name: string; altNames: string[]; year: number | null }, cands: IgdbGame[]): IgdbGame | null {
  const ours = [game.name, ...game.altNames].map(keyOf).filter(Boolean)
  let best: IgdbGame | null = null
  let bestScore = 0
  for (const c of cands) {
    const theirs = [c.name, ...(c.alternative_names ?? []).map((a) => a.name)].map(keyOf).filter(Boolean)
    let score = 0
    for (const o of ours) for (const t of theirs) score = Math.max(score, similarity(o, t))
    const y = yearOf(c.first_release_date)
    if (game.year && y) {
      const dy = Math.abs(game.year - y)
      if (dy <= 1) score += 0.08
      else if (dy > 4) score -= 0.15
    }
    if (c.version_parent) score -= 0.05
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return bestScore >= 0.86 ? best : null
}

export function igdbToData(g: IgdbGame): IgdbData {
  const art = g.artworks?.[0]?.image_id ?? g.screenshots?.[0]?.image_id ?? null
  return {
    id: g.id,
    name: g.name,
    altNames: (g.alternative_names ?? []).map((a) => a.name).filter(Boolean).slice(0, 12),
    year: yearOf(g.first_release_date),
    cover: g.cover?.image_id ? `${IGDB_IMG}/t_cover_big_2x/${g.cover.image_id}.jpg` : null,
    hero: art ? `${IGDB_IMG}/t_1080p/${art}.jpg` : null,
    franchise: g.franchise?.name ?? g.franchises?.[0]?.name ?? g.collections?.[0]?.name ?? null,
    platforms: (g.platforms ?? []).map((p) => p.abbreviation ?? p.name ?? '').filter(Boolean)
  }
}

const FIELDS_FULL =
  'name,alternative_names.name,first_release_date,cover.image_id,artworks.image_id,screenshots.image_id,franchise.name,franchises.name,collections.name,platforms.abbreviation,version_parent'
const FIELDS_MIN = 'name,alternative_names.name,first_release_date,cover.image_id,artworks.image_id'

export class IgdbClient {
  private token: { value: string; exp: number } | null = null
  private fields = FIELDS_FULL
  private limiter = new HostLimiter({ concurrency: 2, spacingMs: 260 })

  constructor(
    readonly clientId: string,
    private secret: string,
    private fetchImpl: FetchFn = fetch
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value
    const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(this.clientId)}&client_secret=${encodeURIComponent(this.secret)}&grant_type=client_credentials`
    const res = await this.fetchImpl(url, { method: 'POST' })
    if (!res.ok) throw new Error(`IGDB auth failed (HTTP ${res.status}); check the Twitch client id/secret`)
    const body = (await res.json()) as { access_token: string; expires_in: number }
    this.token = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 }
    return body.access_token
  }

  /** Up to 10 name searches in one /v4/multiquery request. */
  async searchMany(items: { id: number; name: string }[]): Promise<Map<number, IgdbGame[]>> {
    const body = items
      .map((it) => `query games "g${it.id}" {\n  search "${it.name.replace(/["\\]/g, ' ')}";\n  fields ${this.fields};\n  limit 8;\n};`)
      .join('\n')
    const res = await this.limiter.schedule(async () =>
      this.fetchImpl('https://api.igdb.com/v4/multiquery', {
        method: 'POST',
        headers: { 'Client-ID': this.clientId, Authorization: `Bearer ${await this.accessToken()}`, Accept: 'application/json', 'Content-Type': 'text/plain' },
        body
      })
    )
    if (res.status === 401) {
      this.token = null
      throw new Error('IGDB rejected the access token')
    }
    if (res.status === 400 && this.fields !== FIELDS_MIN) {
      // A field we ask for may have been retired; retry with the conservative set.
      this.fields = FIELDS_MIN
      return this.searchMany(items)
    }
    if (res.status === 429) throw new Error('IGDB rate limit')
    if (!res.ok) throw new Error(`IGDB HTTP ${res.status}`)
    const out = new Map<number, IgdbGame[]>()
    for (const r of (await res.json()) as { name: string; result: IgdbGame[] }[]) out.set(Number(r.name.slice(1)), r.result ?? [])
    return out
  }
}

export class SgdbClient {
  private limiter = new HostLimiter({ concurrency: 1, spacingMs: 300 })
  constructor(
    readonly key: string,
    private fetchImpl: FetchFn = fetch
  ) {}

  private async get<T>(path: string): Promise<T | null> {
    const res = await this.limiter.schedule(() => this.fetchImpl(`${SGDB_API}${path}`, { headers: { Authorization: `Bearer ${this.key}`, Accept: 'application/json' } }))
    if (res.status === 404) return null
    if (res.status === 401 || res.status === 403) throw new Error('SteamGridDB rejected the API key')
    if (!res.ok) throw new Error(`SteamGridDB HTTP ${res.status}`)
    const body = (await res.json()) as { success: boolean; data: T }
    return body.success ? body.data : null
  }

  async lookup(game: { name: string; year: number | null; hasCover: boolean }): Promise<SgdbData | null> {
    const hits = (await this.get<{ id: number; name: string; release_date?: number }[]>(`/search/autocomplete/${encodeURIComponent(game.name)}`)) ?? []
    const key = keyOf(game.name)
    let best: { id: number } | null = null
    let bestScore = 0
    for (const h of hits.slice(0, 8)) {
      let s = similarity(key, keyOf(h.name))
      const y = h.release_date ? new Date(h.release_date * 1000).getUTCFullYear() : null
      if (game.year && y && Math.abs(game.year - y) <= 1) s += 0.08
      if (s > bestScore) {
        bestScore = s
        best = h
      }
    }
    if (!best || bestScore < 0.86) return null
    const q = 'types=static&nsfw=false&humor=false'
    const heroes = (await this.get<{ url: string }[]>(`/heroes/game/${best.id}?${q}`)) ?? []
    const logos = (await this.get<{ url: string }[]>(`/logos/game/${best.id}?${q}`)) ?? []
    const grids = game.hasCover ? [] : ((await this.get<{ url: string }[]>(`/grids/game/${best.id}?dimensions=600x900&${q}`)) ?? [])
    return { id: best.id, hero: heroes[0]?.url ?? null, logo: logos[0]?.url ?? null, cover: grids[0]?.url ?? null }
  }
}

export interface EnricherDeps {
  repo: CatalogRepo
  getSettings: () => Settings
  fetch?: FetchFn
  /** Called after game rows changed (bump revision / broadcast). */
  onChange: () => void
  log?: (msg: string) => void
  now?: () => number
}

/** Background IGDB matcher + on-demand SteamGridDB lookups. */
export class Enricher {
  private igdb: IgdbClient | null = null
  private sgdb: SgdbClient | null = null
  private running = false
  private wake: (() => void) | null = null
  private wanted: number[] = []
  private sgdbWanted: number[] = []
  private igdbPausedUntil = 0
  private sgdbPausedUntil = 0
  lastError: string | null = null

  constructor(private deps: EnricherDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Re-read keys from settings; returns which services are configured. */
  configure(): { igdb: boolean; steamGridDb: boolean } {
    const k = this.deps.getSettings().keys
    const fetchImpl = this.deps.fetch ?? fetch
    if (k.igdbClientId && k.igdbClientSecret) {
      if (!this.igdb || this.igdb.clientId !== k.igdbClientId) this.igdb = new IgdbClient(k.igdbClientId, k.igdbClientSecret, fetchImpl)
    } else this.igdb = null
    if (k.steamGridDbKey) {
      if (!this.sgdb || this.sgdb.key !== k.steamGridDbKey) this.sgdb = new SgdbClient(k.steamGridDbKey, fetchImpl)
    } else this.sgdb = null
    return { igdb: !!this.igdb, steamGridDb: !!this.sgdb }
  }

  status(): { igdb: boolean; steamGridDb: boolean } {
    return this.configure()
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.wake?.()
  }

  /** Prioritise games the user is looking at. */
  want(gameIds: number[]): void {
    const cfg = this.configure()
    if (!cfg.igdb && !cfg.steamGridDb) return
    for (const id of gameIds) {
      const row = this.deps.repo.get<{ igdb_checked_at: number | null; sgdb_checked_at: number | null }>(
        `SELECT igdb_checked_at, sgdb_checked_at FROM games WHERE id = ?`,
        id
      )
      if (!row) continue
      if (cfg.igdb && row.igdb_checked_at == null && !this.wanted.includes(id)) this.wanted.push(id)
      if (cfg.steamGridDb && row.sgdb_checked_at == null && !this.sgdbWanted.includes(id)) this.sgdbWanted.push(id)
    }
    if (this.wanted.length > 200) this.wanted.splice(0, this.wanted.length - 200)
    if (this.sgdbWanted.length > 60) this.sgdbWanted.splice(0, this.sgdbWanted.length - 60)
    this.wake?.()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(() => {
        this.wake = null
        r()
      }, ms)
      this.wake = () => {
        clearTimeout(t)
        this.wake = null
        r()
      }
    })
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const cfg = this.configure()
      let worked = false
      try {
        if (cfg.igdb && this.now() >= this.igdbPausedUntil) worked = (await this.igdbStep()) || worked
      } catch (e) {
        this.lastError = (e as Error).message
        this.deps.log?.(`igdb: ${this.lastError}`)
        this.igdbPausedUntil = this.now() + (/auth|token|reject/i.test(this.lastError) ? 10 * 60_000 : 30_000)
      }
      try {
        if (cfg.steamGridDb && this.now() >= this.sgdbPausedUntil) worked = (await this.sgdbStep()) || worked
      } catch (e) {
        this.lastError = (e as Error).message
        this.deps.log?.(`steamgriddb: ${this.lastError}`)
        this.sgdbPausedUntil = this.now() + (/key/i.test(this.lastError) ? 10 * 60_000 : 30_000)
      }
      if (!this.running) break
      await this.sleep(worked ? 50 : 30_000)
    }
  }

  private async igdbStep(): Promise<boolean> {
    const repo = this.deps.repo
    const ids = this.wanted.splice(0, 10)
    if (ids.length < 10) {
      const more = repo.all<{ id: number }>(
        `SELECT id FROM games WHERE igdb_checked_at IS NULL OR (igdb_id IS NULL AND igdb_checked_at < ?) ORDER BY igdb_checked_at IS NOT NULL, album_count DESC, id LIMIT ?`,
        this.now() - RECHECK_MS,
        10 - ids.length + 5
      )
      for (const r of more) if (ids.length < 10 && !ids.includes(r.id)) ids.push(r.id)
    }
    if (!ids.length) return false
    const games = ids
      .map((id) => repo.get<{ id: number; name: string; alt_names: string; year: number | null; igdb_json: string | null }>(`SELECT id, name, alt_names, year, igdb_json FROM games WHERE id = ?`, id))
      .filter((g): g is NonNullable<typeof g> => !!g)
    if (!games.length) return false
    const results = await this.igdb!.searchMany(games.map((g) => ({ id: g.id, name: g.name })))
    const changed: number[] = []
    const now = this.now()
    repo.tx(() => {
      for (const g of games) {
        const prior = j<IgdbData | null>(g.igdb_json, null)
        // Match against our own names (not IGDB's, which may already have replaced `name`).
        const ourAlt = j<string[]>(g.alt_names, [])
        const match = pickIgdbMatch({ name: prior ? ourAlt[0] ?? g.name : g.name, altNames: ourAlt, year: g.year }, results.get(g.id) ?? [])
        if (match) {
          repo.run(`UPDATE games SET igdb_id = ?, igdb_json = ?, igdb_checked_at = ? WHERE id = ?`, match.id, JSON.stringify(igdbToData(match)), now, g.id)
          changed.push(g.id)
        } else repo.run(`UPDATE games SET igdb_checked_at = ? WHERE id = ?`, now, g.id)
      }
    })
    if (changed.length) {
      const dirty = repo.refreshGames(changed)
      repo.updateAlbumFts(dirty)
      for (const id of changed) repo.updateTrackFtsForGame(id)
      repo.revision++
      this.deps.onChange()
    }
    return true
  }

  private async sgdbStep(): Promise<boolean> {
    const id = this.sgdbWanted.shift()
    if (id == null) return false
    const repo = this.deps.repo
    const g = repo.get<{ id: number; name: string; year: number | null; cover: string | null }>(`SELECT id, name, year, cover FROM games WHERE id = ?`, id)
    if (!g) return true
    const data = await this.sgdb!.lookup({ name: g.name, year: g.year, hasCover: !!g.cover })
    repo.run(`UPDATE games SET sgdb_id = ?, sgdb_json = ?, sgdb_checked_at = ? WHERE id = ?`, data?.id ?? null, data ? JSON.stringify(data) : null, this.now(), id)
    if (data) {
      repo.refreshGames([id])
      repo.revision++
      this.deps.onChange()
    }
    return true
  }
}

/** Fills games.accent from cover art as it gets fetched / found in the art cache. */
export class AccentWorker {
  private queue: { gameId: number; url: string }[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private seen = new Set<string>()

  constructor(
    private repo: CatalogRepo,
    /** Decode cached/fetched image bytes into an accent; null if unavailable. */
    private accentOf: (url: string, bytes?: Buffer) => Promise<string | null>,
    private onChange: () => void
  ) {}

  /** Called by the art protocol when a cover arrives from the network. */
  onArtFetched(url: string, bytes: Buffer): void {
    const games = this.repo.all<{ id: number }>(`SELECT id FROM games WHERE cover = ? AND accent IS NULL`, url)
    if (!games.length) return
    void this.accentOf(url, bytes).then((accent) => {
      if (!accent) return
      for (const g of games) this.repo.run(`UPDATE games SET accent = ? WHERE id = ? AND cover = ?`, accent, g.id, url)
      this.repo.revision++
      this.onChange()
    })
  }

  /** Queue games (e.g. a browse page) whose covers may already be cached. */
  want(rows: { gameId: number; cover: string | null; accent: string | null }[]): void {
    for (const r of rows) {
      if (r.accent || !r.cover) continue
      const k = `${r.gameId}\u0000${r.cover}`
      if (this.seen.has(k)) continue
      this.seen.add(k)
      this.queue.push({ gameId: r.gameId, url: r.cover })
    }
    this.pump()
  }

  private pump(): void {
    if (this.timer || !this.queue.length) return
    this.timer = setTimeout(async () => {
      this.timer = null
      const item = this.queue.shift()
      if (item) {
        try {
          const accent = await this.accentOf(item.url)
          if (accent) {
            this.repo.run(`UPDATE games SET accent = ? WHERE id = ? AND cover = ? AND accent IS NULL`, accent, item.gameId, item.url)
            this.repo.revision++
            this.onChange()
          }
        } catch {
          /* not cached / undecodable: the art protocol will report it when it is fetched */
        }
      }
      this.pump()
    }, 25)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.queue = []
  }
}
