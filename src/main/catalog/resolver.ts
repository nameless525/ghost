// Source resolution: canonical track → ranked playable sources (DESIGN §6.1, §6.4).
//
// Every provider in the user's order gets a chance: the album's own provider resolves its locator
// directly (KHInsider: fetch the track page), search-based providers go through findTrack. Results
// are cached in `sources` and re-resolved after 7 days, when they expire, or after the engine
// reported a failure. Failed sources are demoted, and `exclude` drops ones that already failed.

import type { AudioFormat, ID, Settings } from '../../shared/types'
import type { EngineSource } from '../engine/types'
import type { ProviderRegistry } from '../providers'
import type { CanonicalTrack, Provider, StreamInfo } from '../providers/types'
import type { ResolvedSource } from './index'
import { estimateKbps, formatRank, j, type CatalogRepo, type Quality } from './repo'

export const SOURCE_TTL_MS = 7 * 24 * 3600_000
/** A failure this recent pushes a source behind every healthy one. */
const RECENT_FAILURE_MS = 6 * 3600_000
const MAX_CANDIDATES = 2

interface SourceRow {
  id: number
  track_id: number
  provider: string
  locator: string
  cache_key: string
  url: string | null
  path: string | null
  headers: string | null
  format: AudioFormat
  bitrate: number | null
  lossless: number
  duration_ms: number | null
  size_bytes: number | null
  confidence: number
  verified_at: number
  expires_at: number | null
  failures: number
  last_failed_at: number | null
  needs_refresh: number
}

export function sourceKey(s: EngineSource): string {
  return s.kind === 'http' ? s.cacheKey : `file:${s.path}`
}

export interface ResolverDeps {
  repo: CatalogRepo
  registry: ProviderRegistry
  getSettings: () => Settings
  now?: () => number
  log?: (msg: string) => void
}

export class SourceResolver {
  private inflight = new Map<string, Promise<void>>()
  private now: () => number
  private log: (msg: string) => void

  constructor(private deps: ResolverDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
  }

  canonical(trackId: number): CanonicalTrack | null {
    const r = this.deps.repo.get<{
      id: number
      title: string
      duration_ms: number | null
      disc: number
      number: number
      locator: string
      composers: string
      provider: string
      provider_ref: string
      album_title: string
      year: number | null
      platforms: string
      album_composers: string
      game_name: string | null
    }>(
      `SELECT t.id, t.title, t.duration_ms, t.disc, t.number, t.locator, t.composers, a.provider, a.provider_ref, a.title AS album_title,
              a.year, a.platforms, a.composers AS album_composers, g.name AS game_name
       FROM tracks t JOIN albums a ON a.id = t.album_id LEFT JOIN games g ON g.id = a.game_id WHERE t.id = ?`,
      trackId
    )
    if (!r) return null
    const tc = j<string[]>(r.composers, [])
    return {
      trackId: String(r.id),
      title: r.title,
      albumTitle: r.album_title,
      gameName: r.game_name,
      composers: tc.length ? tc : j<string[]>(r.album_composers, []),
      durationMs: r.duration_ms,
      disc: r.disc,
      number: r.number,
      year: r.year,
      platforms: j<string[]>(r.platforms, []),
      albumProvider: r.provider,
      albumRef: r.provider_ref,
      locator: r.locator
    }
  }

  private rows(trackId: number, provider?: string): SourceRow[] {
    return provider
      ? this.deps.repo.all<SourceRow>(`SELECT * FROM sources WHERE track_id = ? AND provider = ?`, trackId, provider)
      : this.deps.repo.all<SourceRow>(`SELECT * FROM sources WHERE track_id = ?`, trackId)
  }

  private needsRefresh(rows: SourceRow[], now: number): boolean {
    if (!rows.length) return true
    return rows.some(
      (r) => now - r.verified_at > SOURCE_TTL_MS || r.needs_refresh === 1 || (r.expires_at != null && r.expires_at < now + 60_000)
    )
  }

  private store(trackId: number, provider: string, items: { info: StreamInfo; locator: string; confidence: number }[], durationMs: number | null): void {
    const repo = this.deps.repo
    const now = this.now()
    repo.tx(() => {
      const existing = new Map(this.rows(trackId, provider).map((r) => [r.cache_key, r]))
      const keep = new Set<string>()
      for (const { info, locator, confidence } of items) {
        const key = sourceKey(info.source)
        if (keep.has(key)) continue
        keep.add(key)
        const url = info.source.kind === 'http' ? info.source.url : null
        const path = info.source.kind === 'file' ? info.source.path : null
        const headers = info.source.kind === 'http' && info.source.headers ? JSON.stringify(info.source.headers) : null
        const bitrate = info.bitrateKbps ?? estimateKbps(info.sizeBytes, durationMs)
        const ex = existing.get(key)
        if (ex) {
          const sameTarget = ex.url === url && ex.path === path
          repo.run(
            `UPDATE sources SET locator = ?, url = ?, path = ?, headers = ?, format = ?, bitrate = ?, lossless = ?, duration_ms = ?, size_bytes = ?,
               confidence = ?, verified_at = ?, expires_at = ?, failures = ?, needs_refresh = 0 WHERE id = ?`,
            locator,
            url,
            path,
            headers,
            info.format,
            bitrate,
            info.lossless ? 1 : 0,
            durationMs,
            info.sizeBytes,
            confidence,
            now,
            info.expiresAt,
            sameTarget ? ex.failures : 0,
            ex.id
          )
        } else {
          repo.run(
            `INSERT INTO sources (track_id, provider, locator, cache_key, url, path, headers, format, bitrate, lossless, duration_ms, size_bytes, confidence, verified_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            trackId,
            provider,
            locator,
            key,
            url,
            path,
            headers,
            info.format,
            bitrate,
            info.lossless ? 1 : 0,
            durationMs,
            info.sizeBytes,
            confidence,
            now,
            info.expiresAt
          )
        }
      }
      for (const [key, r] of existing) if (!keep.has(key)) repo.run(`DELETE FROM sources WHERE id = ?`, r.id)
    })
  }

  private async refreshProvider(p: Provider, t: CanonicalTrack, trackId: number): Promise<void> {
    const flightKey = `${trackId}\u0000${p.id}`
    const existing = this.inflight.get(flightKey)
    if (existing) return existing
    const run = (async () => {
      if (p.id === t.albumProvider) {
        const infos = await p.resolveStream(t.locator, { priority: 0 })
        this.store(trackId, p.id, infos.map((info) => ({ info, locator: t.locator, confidence: 1 })), t.durationMs)
      } else if (p.findTrack) {
        const cands = (await p.findTrack(t, { priority: 0 })).sort((a, b) => b.confidence - a.confidence).slice(0, MAX_CANDIDATES)
        const items: { info: StreamInfo; locator: string; confidence: number }[] = []
        for (const c of cands) {
          try {
            for (const info of await p.resolveStream(c.locator, { priority: 0 })) items.push({ info, locator: c.locator, confidence: c.confidence })
          } catch (e) {
            this.log(`${p.id}: candidate ${c.locator} failed: ${(e as Error).message}`)
          }
        }
        this.store(trackId, p.id, items, t.durationMs)
      }
    })().finally(() => this.inflight.delete(flightKey))
    this.inflight.set(flightKey, run)
    return run
  }

  async resolve(trackIdStr: ID, opts: { quality?: Quality; exclude?: string[] } = {}): Promise<ResolvedSource[]> {
    const trackId = Number(trackIdStr)
    const t = Number.isFinite(trackId) ? this.canonical(trackId) : null
    if (!t) return []
    const settings = this.deps.getSettings()
    const quality = opts.quality ?? settings.sources.quality
    const providers = this.deps.registry.ordered(settings.sources)
    const now = this.now()
    let firstError: unknown = null
    for (const p of providers) {
      if (p.id !== t.albumProvider && !p.findTrack) continue
      const rows = this.rows(trackId, p.id)
      if (!this.needsRefresh(rows, now)) continue
      try {
        await this.refreshProvider(p, t, trackId)
      } catch (e) {
        firstError ??= e
        this.log(`${p.id}: resolving track ${trackId} failed${rows.length ? ' (using cached sources)' : ''}: ${(e as Error).message}`)
      }
    }
    const order = providers.map((p) => p.id)
    const exclude = new Set(opts.exclude ?? [])
    const ranked = this.rows(trackId)
      .filter((r) => order.includes(r.provider) && !exclude.has(r.cache_key))
      .map((r) => ({ r, recentFail: r.failures > 0 && r.last_failed_at != null && now - r.last_failed_at < RECENT_FAILURE_MS ? 1 : 0 }))
      .sort(
        (a, b) =>
          a.recentFail - b.recentFail ||
          order.indexOf(a.r.provider) - order.indexOf(b.r.provider) ||
          formatRank(a.r.format, quality) - formatRank(b.r.format, quality) ||
          b.r.confidence - a.r.confidence ||
          a.r.failures - b.r.failures
      )
      .map(({ r }) => toResolved(r))
    if (!ranked.length && firstError) throw firstError
    return ranked
  }

  markFailed(trackIdStr: ID, cacheKey: string, reason: string): void {
    this.deps.repo.run(
      `UPDATE sources SET failures = failures + 1, last_failed_at = ?, last_error = ?, needs_refresh = 1 WHERE track_id = ? AND cache_key = ?`,
      this.now(),
      reason.slice(0, 500),
      Number(trackIdStr),
      cacheKey
    )
  }
}

function toResolved(r: SourceRow): ResolvedSource {
  const source: EngineSource = r.path
    ? { kind: 'file', path: r.path, formatHint: r.format }
    : { kind: 'http', url: r.url!, cacheKey: r.cache_key, headers: j<Record<string, string> | undefined>(r.headers, undefined), formatHint: r.format }
  if (source.kind === 'http' && !source.headers) delete source.headers
  return {
    provider: r.provider,
    source,
    format: r.format,
    lossless: !!r.lossless,
    bitrateKbps: r.bitrate,
    confidence: r.confidence,
    sizeBytes: r.size_bytes
  }
}
