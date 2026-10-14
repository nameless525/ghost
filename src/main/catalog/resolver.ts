// Source resolution: canonical track → ranked playable sources (DESIGN §6.1, §6.4).
//
// Providers are asked in the user's order, in two phases:
//  1. the album's own provider resolves its locator directly (KHInsider: fetch the track page), and
//     cheap search providers (findTrackMode 'always', e.g. local files) run findTrack;
//  2. only if nothing usable came out of that (all failed recently, expired or `exclude`d) do the
//     network-search fallbacks (findTrackMode 'fallback': Bandcamp, Internet Archive, YouTube) run
//     findTrack, one provider at a time until one yields a usable source. Normal plays never pay
//     for a YouTube search.
// Results are cached in `sources` and re-resolved after 7 days, when they expire, or after the
// engine reported a failure. A search provider's cached candidates are re-resolved by locator
// rather than searched again; empty searches are remembered for a while. Failed sources are
// demoted, and `exclude` drops ones that already failed.

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
/** Don't repeat a fallback search that found nothing (or failed) for this long. */
const EMPTY_SEARCH_TTL_MS = 6 * 3600_000
const FAILED_SEARCH_TTL_MS = 10 * 60_000
/** A cached candidate that failed this often is searched for again instead of re-resolved. */
const MAX_REUSE_FAILURES = 2

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
  clip_start_ms: number | null
  clip_end_ms: number | null
  archive_entry: string | null
  subsong: number | null
}

export interface StoredStream {
  info: StreamInfo
  locator: string
  confidence: number
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
  /** `${trackId}\0${provider}` → don't run that fallback search again before this time. */
  private backoff = new Map<string, number>()
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

  /** Cache streams a provider already handed us (e.g. on import) as this track's sources. */
  storeStreams(trackId: number, provider: string, items: StoredStream[], durationMs: number | null): void {
    this.store(trackId, provider, items, durationMs)
  }

  private store(trackId: number, provider: string, items: StoredStream[], durationMs: number | null): void {
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
        const clipStart = info.source.clipStartMs ?? null
        const clipEnd = info.source.clipEndMs ?? null
        const entry = info.source.archiveEntry ?? null
        const subsong = info.source.subsong ?? null
        // A chip file's size says nothing about its bitrate (it's a program, not audio).
        const bitrate = info.bitrateKbps ?? (info.format === 'chip' ? null : estimateKbps(info.sizeBytes, durationMs))
        const ex = existing.get(key)
        if (ex) {
          // Expiring URLs (YouTube, Bandcamp) change on every re-resolve: the same locator is the same target.
          const sameTarget = ex.path === path && ex.archive_entry === entry && ex.subsong === subsong && (ex.url === url || (ex.locator === locator && info.expiresAt != null))
          repo.run(
            `UPDATE sources SET locator = ?, url = ?, path = ?, headers = ?, format = ?, bitrate = ?, lossless = ?, duration_ms = ?, size_bytes = ?,
               confidence = ?, verified_at = ?, expires_at = ?, failures = ?, needs_refresh = 0, clip_start_ms = ?, clip_end_ms = ?, archive_entry = ?, subsong = ? WHERE id = ?`,
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
            clipStart,
            clipEnd,
            entry,
            subsong,
            ex.id
          )
        } else {
          repo.run(
            `INSERT INTO sources (track_id, provider, locator, cache_key, url, path, headers, format, bitrate, lossless, duration_ms, size_bytes, confidence, verified_at, expires_at, clip_start_ms, clip_end_ms, archive_entry, subsong)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            info.expiresAt,
            clipStart,
            clipEnd,
            entry,
            subsong
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
        const now = this.now()
        const rows = this.rows(trackId, p.id)
        // Candidates found earlier: re-resolve them by locator (an expired YouTube URL) instead of searching again.
        const reuse = new Map<string, number>()
        for (const r of rows) {
          if (r.failures < MAX_REUSE_FAILURES && now - r.verified_at < SOURCE_TTL_MS) reuse.set(r.locator, Math.max(reuse.get(r.locator) ?? 0, r.confidence))
        }
        const resolveAll = async (cands: { locator: string; confidence: number }[]): Promise<StoredStream[]> => {
          const settled = await Promise.allSettled(cands.map((c) => p.resolveStream(c.locator, { priority: 0 })))
          const items: StoredStream[] = []
          settled.forEach((r, i) => {
            if (r.status === 'fulfilled') for (const info of r.value) items.push({ info, locator: cands[i].locator, confidence: cands[i].confidence })
            else this.log(`${p.id}: candidate ${cands[i].locator} failed: ${(r.reason as Error).message}`)
          })
          return items
        }
        let items = reuse.size ? await resolveAll([...reuse].map(([locator, confidence]) => ({ locator, confidence }))) : []
        if (!items.length) {
          const bad = new Set(rows.filter((r) => r.failures >= MAX_REUSE_FAILURES).map((r) => r.locator))
          const cands = (await p.findTrack(t, { priority: 0 }))
            .filter((c) => !bad.has(c.locator))
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, MAX_CANDIDATES)
          items = await resolveAll(cands)
          if (!items.length && p.findTrackMode === 'fallback') this.backoff.set(flightKey, now + EMPTY_SEARCH_TTL_MS)
        }
        // Keep rows that failed too often so they stay excluded from future searches.
        if (items.length) this.store(trackId, p.id, [...items, ...this.keepFailed(rows, items)], t.durationMs)
      }
    })().finally(() => this.inflight.delete(flightKey))
    this.inflight.set(flightKey, run)
    return run
  }

  /** Rows over the failure limit, re-stored as-is so `store` doesn't drop the memory of them. */
  private keepFailed(rows: SourceRow[], items: StoredStream[]): StoredStream[] {
    const kept = new Set(items.map((i) => sourceKey(i.info.source)))
    return rows.filter((r) => r.failures >= MAX_REUSE_FAILURES && !kept.has(r.cache_key)).map((r) => ({ info: { ...toStream(r) }, locator: r.locator, confidence: r.confidence }))
  }

  private async refreshIfNeeded(p: Provider, t: CanonicalTrack, trackId: number, now: number): Promise<unknown> {
    const rows = this.rows(trackId, p.id)
    if (!this.needsRefresh(rows, now)) return null
    const key = `${trackId}\u0000${p.id}`
    const fallback = p.id !== t.albumProvider && p.findTrackMode === 'fallback'
    if (fallback && (this.backoff.get(key) ?? 0) > now) return null
    if (this.backoff.size > 5000) for (const [k, until] of this.backoff) if (until <= now) this.backoff.delete(k)
    try {
      await this.refreshProvider(p, t, trackId)
      return null
    } catch (e) {
      if (fallback) this.backoff.set(key, now + FAILED_SEARCH_TTL_MS)
      this.log(`${p.id}: resolving track ${trackId} failed${rows.length ? ' (using cached sources)' : ''}: ${(e as Error).message}`)
      return e
    }
  }

  async resolve(trackIdStr: ID, opts: { quality?: Quality; exclude?: string[] } = {}): Promise<ResolvedSource[]> {
    const trackId = Number(trackIdStr)
    const t = Number.isFinite(trackId) ? this.canonical(trackId) : null
    if (!t) return []
    const settings = this.deps.getSettings()
    const quality = opts.quality ?? settings.sources.quality
    const providers = this.deps.registry.ordered(settings.sources)
    const order = providers.map((p) => p.id)
    const exclude = new Set(opts.exclude ?? [])
    const now = this.now()
    let firstError: unknown = null
    const isFallback = (p: Provider) => p.id !== t.albumProvider && !!p.findTrack && p.findTrackMode === 'fallback'

    const rank = () =>
      this.rows(trackId)
        .filter((r) => order.includes(r.provider) && !exclude.has(r.cache_key) && !(r.expires_at != null && r.expires_at < now + 30_000))
        .map((r) => ({ r, recentFail: r.failures > 0 && r.last_failed_at != null && now - r.last_failed_at < RECENT_FAILURE_MS ? 1 : 0 }))
        .sort(
          (a, b) =>
            a.recentFail - b.recentFail ||
            order.indexOf(a.r.provider) - order.indexOf(b.r.provider) ||
            formatRank(a.r.format, quality) - formatRank(b.r.format, quality) ||
            b.r.confidence - a.r.confidence ||
            a.r.failures - b.r.failures
        )

    // Phase 1: the album's own provider + cheap search providers.
    for (const p of providers) {
      if (p.id !== t.albumProvider && !p.findTrack) continue
      if (isFallback(p)) continue
      const e = await this.refreshIfNeeded(p, t, trackId, now)
      firstError ??= e
    }
    let ranked = rank()
    // Phase 2: network-search fallbacks, only when nothing healthy is left.
    if (!ranked.some((x) => !x.recentFail)) {
      for (const p of providers) {
        if (!isFallback(p)) continue
        const e = await this.refreshIfNeeded(p, t, trackId, now)
        firstError ??= e
        ranked = rank()
        if (ranked.some((x) => !x.recentFail)) break
      }
    }
    const out = ranked.map(({ r }) => toResolved(r))
    if (!out.length && firstError) throw firstError
    return out
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

function engineSource(r: SourceRow): EngineSource {
  const source: EngineSource = r.path
    ? { kind: 'file', path: r.path, formatHint: r.format }
    : { kind: 'http', url: r.url!, cacheKey: r.cache_key, headers: j<Record<string, string> | undefined>(r.headers, undefined), formatHint: r.format }
  if (source.kind === 'http' && !source.headers) delete source.headers
  if (r.clip_start_ms != null && r.clip_end_ms != null) {
    source.clipStartMs = r.clip_start_ms
    source.clipEndMs = r.clip_end_ms
  }
  if (r.archive_entry) {
    source.archiveEntry = r.archive_entry
    // The entry's own extension says what it is (the URL is the .7z / .zip).
    const ext = /\.([a-z0-9]{1,6})$/i.exec(r.archive_entry)?.[1]?.toLowerCase()
    if (ext) source.formatHint = ext
  }
  if (r.subsong != null) source.subsong = r.subsong
  return source
}

function toStream(r: SourceRow): StreamInfo {
  return { provider: r.provider, source: engineSource(r), format: r.format, lossless: !!r.lossless, bitrateKbps: r.bitrate, sizeBytes: r.size_bytes, expiresAt: r.expires_at }
}

function toResolved(r: SourceRow): ResolvedSource {
  const source = engineSource(r)
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
