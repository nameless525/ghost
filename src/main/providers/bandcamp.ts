// Bandcamp: indie composers, good quality, track data embedded as JSON (DESIGN §6.2 #3).
//
//  - searchExternal: https://bandcamp.com/search?q=…&item_type=a (album hits), or a pasted
//    album/track URL. bandcamp.com may answer the search with a JavaScript "Client Challenge"
//    page; we don't try to get past it — that's a typed `blocked` error and we back off.
//  - getAlbum (import): the album page's `data-tralbum` JSON has titles, durations and
//    `file["mp3-128"]` stream URLs. Stream URLs are signed and expire (`token=<epoch>_…`).
//  - findTrack: album search for the game, then match tracks by title + duration.
//  - resolveStream: re-read the album page (cached ≤1 h, refetched if its tokens are about to
//    expire) and return that track's stream.
//
// All HTML goes through the Chromium-stack pageFetch with the polite per-host limiter.
// Locators: '<album or track URL>#<track_id>'.

import { loadHtml } from './html'
import type { ExternalAlbumHit } from '../../shared/types'
import { baseTitle } from '../catalog/normalize'
import { NetError } from '../net/errors'
import type { HttpClient } from '../net/http'
import { cleanTrackTitle, combineScore, durationFit, otherCut, penaltyHits, titleSimilarity } from './match'
import type { CanonicalTrack, Provider, ProviderAlbum, ProviderCallOptions, ProviderTrack, SourceCandidate, StreamInfo } from './types'
import { scoreAlbumTitle } from './youtube'

export const BC_ID = 'bandcamp'
/** A fallback below this (a cover, a remix, another cut) is not the track: better to look elsewhere. */
export const BC_MIN_CONFIDENCE = 0.5
export const BC_SEARCH_TTL_MS = 3600_000
const PAGE_TTL_MS = 3600_000
/** A forced re-read accepts a page fetched this recently. */
const FRESH_REUSE_MS = 2 * 60_000
const BLOCK_BACKOFF_MS = 30 * 60_000

export function searchUrl(q: string): string {
  return `https://bandcamp.com/search?q=${encodeURIComponent(q).replace(/%20/g, '+')}&item_type=a`
}

/** A pasted Bandcamp album/track page URL (<artist>.bandcamp.com/album|track/<slug>), canonicalised. */
export function parseBandcampUrl(s: string): string | null {
  let u: URL
  try {
    u = new URL(s.trim())
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol) || !/^\/(?:album|track)\/[^/]+\/?$/.test(u.pathname)) return null
  if (!/\.bandcamp\.com$/i.test(u.hostname)) return null
  return `https://${u.hostname}${u.pathname.replace(/\/$/, '')}`
}

/** Strip search tracking params from a result link. */
export function canonicalUrl(href: string): string {
  try {
    const u = new URL(href)
    return `${u.protocol}//${u.hostname}${u.pathname.replace(/\/$/, '')}`
  } catch {
    return href.replace(/[?#].*$/, '')
  }
}

/** Bandcamp's JavaScript bot-check interstitial. */
export function isChallengePage(html: string): boolean {
  const head = html.slice(0, 8000)
  return /<title>\s*Client Challenge\s*<\/title>/i.test(head) || /\/_fs-ch-[A-Za-z0-9_-]+\//.test(head)
}

/** Expiry (epoch ms) of a signed bcbits stream URL: `token=<epoch>_<sig>` (or `ts=`). */
export function streamExpiry(url: string): number | null {
  const m = /[?&]token=(\d{9,})_/.exec(url) ?? /[?&]ts=(\d{9,})/.exec(url)
  return m ? Number(m[1]) * 1000 : null
}

/** "26 tracks, 58 minutes" → { tracks: 26, ms: 3_480_000 }. */
export function parseLength(s: string): { tracks: number | null; ms: number | null } {
  const t = /(\d+)\s+tracks?/i.exec(s)
  const h = /(\d+)\s+hours?/i.exec(s)
  const m = /(\d+)\s+minutes?/i.exec(s)
  const ms = h || m ? ((Number(h?.[1] ?? 0) * 60 + Number(m?.[1] ?? 0)) * 60_000) : null
  return { tracks: t ? Number(t[1]) : null, ms }
}

export function parseSearchPage(html: string, query: string): ExternalAlbumHit[] {
  if (isChallengePage(html)) throw new NetError('blocked', 'bandcamp.com answered the search with a bot check (Client Challenge). Try again later, or paste a Bandcamp album link.')
  const $ = loadHtml(html)
  const out: ExternalAlbumHit[] = []
  $('li.searchresult').each((_, el) => {
    const r = $(el)
    const type = r.find('.itemtype').first().text().trim().toLowerCase()
    let dataType: string | null = null
    try {
      dataType = (JSON.parse(r.attr('data-search') ?? '{}') as { type?: string }).type ?? null
    } catch {
      /* ignore */
    }
    if ((type && type !== 'album') || (dataType && dataType !== 'a')) return
    const a = r.find('.heading a').first()
    const title = a.text().replace(/\s+/g, ' ').trim()
    const href = r.find('.itemurl a').first().attr('href') ?? a.attr('href')
    if (!title || !href) return
    const url = canonicalUrl(href)
    const artist = r.find('.subhead').first().text().replace(/\s+/g, ' ').trim().replace(/^by\s+/i, '') || null
    const len = parseLength(r.find('.length').first().text())
    const img = r.find('.art img').first().attr('src') ?? null
    out.push({
      provider: 'bandcamp',
      ref: url,
      title,
      subtitle: artist,
      cover: img ? img.replace(/_\d+\.(jpg|png)$/i, '_10.$1') : null,
      trackCount: len.tracks,
      totalMs: len.ms,
      url,
      score: scoreAlbumTitle(title, query, { channel: artist, kind: 'album' })
    })
  })
  return out.sort((x, y) => y.score - x.score)
}

interface Tralbum {
  id?: number
  item_type?: string
  artist?: string
  art_id?: number | null
  url?: string
  album_release_date?: string | null
  current?: { title?: string; release_date?: string | null; about?: string | null; credits?: string | null; type?: string }
  trackinfo?: {
    id?: number
    track_id?: number
    title?: string
    artist?: string | null
    track_num?: number | null
    duration?: number | null
    file?: Record<string, string> | null
    title_link?: string | null
    streaming?: number
  }[]
}

export function artUrl(artId: number | null | undefined, size = 10): string | null {
  return artId ? `https://f4.bcbits.com/img/a${String(artId).padStart(10, '0')}_${size}.jpg` : null
}

export function trackLocator(pageUrl: string, trackId: number | string): string {
  return `${canonicalUrl(pageUrl)}#${trackId}`
}

export function parseLocator(loc: string): { url: string; trackId: string } {
  const i = loc.lastIndexOf('#')
  if (i <= 0) throw new NetError('parse', `bad Bandcamp locator: ${loc}`)
  return { url: loc.slice(0, i), trackId: loc.slice(i + 1) }
}

/** Album (or single-track) page → ProviderAlbum with ready mp3-128 streams. */
export function parseAlbumPage(html: string, pageUrl: string): ProviderAlbum {
  if (isChallengePage(html)) throw new NetError('blocked', 'bandcamp.com answered with a bot check (Client Challenge)')
  const $ = loadHtml(html)
  const raw = $('[data-tralbum]').first().attr('data-tralbum')
  if (!raw) throw new NetError('parse', `no track data on ${pageUrl}`)
  let d: Tralbum
  try {
    d = JSON.parse(raw) as Tralbum
  } catch {
    throw new NetError('parse', `unreadable track data on ${pageUrl}`)
  }
  const url = canonicalUrl(d.url || pageUrl)
  const title = (d.current?.title ?? $('meta[property="og:title"]').attr('content') ?? url).trim()
  const artist = d.artist?.trim() || null
  const og = $('meta[property="og:image"]').attr('content') ?? null
  const cover = artUrl(d.art_id) ?? (og ? og.replace(/_\d+\.(jpg|png)$/i, '_10.$1') : null)
  const released = d.album_release_date ?? d.current?.release_date ?? null
  const year = released && /\b(\d{4})\b/.test(released) ? Number(/\b(\d{4})\b/.exec(released)![1]) : null
  const names = [title, baseTitle(title)]
  const tracks: ProviderTrack[] = (d.trackinfo ?? []).map((t, i) => {
    const id = t.track_id ?? t.id ?? i + 1
    const durationMs = t.duration && t.duration > 0 ? Math.round(t.duration * 1000) : null
    const stream = t.file?.['mp3-128'] ?? null
    const streams: StreamInfo[] | undefined = stream
      ? [
          {
            provider: BC_ID,
            source: { kind: 'http', url: stream, cacheKey: `bc:${id}.mp3`, formatHint: 'mp3' },
            format: 'mp3',
            lossless: false,
            bitrateKbps: 128,
            sizeBytes: durationMs ? Math.round((durationMs / 1000) * 16_000) : null,
            expiresAt: streamExpiry(stream)
          }
        ]
      : undefined
    return {
      disc: 1,
      number: t.track_num ?? i + 1,
      title: cleanTrackTitle((t.title ?? `Track ${i + 1}`).trim(), { names }),
      durationMs,
      locator: trackLocator(url, id),
      files: [{ format: 'mp3' as const, sizeBytes: null }],
      composers: t.artist ? [t.artist] : artist ? [artist] : [],
      streams
    }
  })
  const t = title.toLowerCase()
  return {
    provider: BC_ID,
    ref: url,
    title,
    titleFromRef: false,
    platforms: [],
    kind: d.item_type === 'track' ? 'single' : /\bremix/.test(t) ? 'remix' : /\barrange|\bpiano\b|\borchestra|\bcovers?\b/.test(t) ? 'arrange' : 'ost',
    typeLabel: 'Bandcamp',
    year,
    thumb: artUrl(d.art_id, 7) ?? og,
    cover,
    catalogNo: null,
    addedAt: null,
    altTitles: [],
    titleOriginal: null,
    developers: [],
    publishers: [],
    composers: artist ? [artist] : [],
    images: cover ? [cover] : [],
    description: [d.current?.about, d.current?.credits].filter(Boolean).join('\n\n').trim().slice(0, 4000) || null,
    formats: ['mp3'],
    totalSizes: {},
    externalId: d.id != null ? String(d.id) : null,
    tracks
  }
}

// ---------------------------------------------------------------------------
// Provider

export interface BandcampProviderOptions {
  now?: () => number
  log?: (msg: string) => void
}

export class BandcampProvider implements Provider {
  readonly id = BC_ID
  readonly name = 'Bandcamp'
  readonly findTrackMode = 'fallback' as const
  private blockedUntil = 0
  private readonly now: () => number

  constructor(
    private readonly http: HttpClient,
    opts: BandcampProviderOptions = {}
  ) {
    this.now = opts.now ?? Date.now
  }

  private checkBackoff(): void {
    if (this.blockedUntil > this.now()) throw new NetError('blocked', 'bandcamp.com search is asking for a bot check; backing off for a while')
  }

  private async search(q: string, opts: ProviderCallOptions): Promise<ExternalAlbumHit[]> {
    this.checkBackoff()
    const url = searchUrl(q)
    const r = await this.http.pageFetch(url, { ttlMs: BC_SEARCH_TTL_MS, priority: opts.priority ?? 0, signal: opts.signal, force: opts.force })
    try {
      return parseSearchPage(r.html, q)
    } catch (e) {
      if ((e as NetError).code === 'blocked') {
        this.blockedUntil = this.now() + BLOCK_BACKOFF_MS
        await this.http.invalidate(url)
      }
      throw e
    }
  }

  private async page(url: string, opts: ProviderCallOptions, fresh = false): Promise<ProviderAlbum> {
    // A fresh read (stored URLs failed or are about to expire) still takes a copy fetched moments
    // ago: after one failure every track of the album refreshes from the same page.
    const reread = fresh || !!opts.force
    const r = await this.http.pageFetch(url, { ttlMs: reread ? FRESH_REUSE_MS : PAGE_TTL_MS, cache: true, priority: opts.priority ?? 0, signal: opts.signal, allowStale: !reread })
    try {
      return parseAlbumPage(r.html, url)
    } catch (e) {
      if (r.fromCache) await this.http.invalidate(url)
      throw e
    }
  }

  async searchExternal(q: string, opts: ProviderCallOptions = {}): Promise<ExternalAlbumHit[]> {
    const query = q.trim()
    if (!query) return []
    const direct = parseBandcampUrl(query)
    if (direct) {
      const a = await this.page(direct, opts)
      return [{ provider: 'bandcamp', ref: a.ref, title: a.title, subtitle: a.composers[0] ?? null, cover: a.cover, trackCount: a.tracks.length, totalMs: a.tracks.reduce((s, t) => s + (t.durationMs ?? 0), 0) || null, url: a.ref, score: 1 }]
    }
    // Bandcamp matches words literally and soundtrack titles rarely say "OST": search the name.
    const base = query.replace(/\b(?:full\s+)?(?:o\.?s\.?t|original\s+soundtrack|soundtrack)\b/gi, ' ').replace(/\s+/g, ' ').trim() || query
    return (await this.search(base, opts)).filter((h) => h.score >= 0.25)
  }

  async getAlbum(ref: string, opts: ProviderCallOptions = {}): Promise<ProviderAlbum> {
    const album = await this.page(ref, opts, !!opts.force)
    if (!album.tracks.length) throw new NetError('not_found', `no tracks on ${ref}`)
    return album
  }

  async findTrack(t: CanonicalTrack, opts: ProviderCallOptions = {}): Promise<SourceCandidate[]> {
    const game = t.gameName || baseTitle(t.albumTitle) || t.albumTitle
    const hits = (await this.search(game, opts)).filter((h) => h.score >= 0.45).slice(0, 2)
    const out: SourceCandidate[] = []
    for (const h of hits) {
      let album: ProviderAlbum
      try {
        album = await this.page(h.ref, opts)
      } catch {
        continue
      }
      for (const tr of album.tracks) {
        if (!tr.streams?.length) continue
        const title = titleSimilarity(t.title, tr.title, { context: [game, album.title, t.albumTitle] })
        if (title < 0.5 || otherCut(t.durationMs, tr.durationMs)) continue
        const duration = durationFit(t.durationMs, tr.durationMs)
        const trust = album.composers.some((c) => t.composers.some((x) => x.toLowerCase() === c.toLowerCase())) ? 0.9 : 0.6
        const confidence = combineScore({ title, duration, trust, quality: 0.6, penalties: penaltyHits(`${tr.title} ${album.title}`, [t.title, t.albumTitle, t.gameName]) })
        if (confidence < BC_MIN_CONFIDENCE) continue
        out.push({ provider: BC_ID, locator: tr.locator, title: tr.title, durationMs: tr.durationMs, confidence })
      }
    }
    return out.sort((a, b) => b.confidence - a.confidence).slice(0, 5)
  }

  async resolveStream(locator: string, opts: ProviderCallOptions = {}): Promise<StreamInfo[]> {
    const { url, trackId } = parseLocator(locator)
    const find = (a: ProviderAlbum) => a.tracks.find((x) => x.locator === trackLocator(url, trackId))
    let tr = find(await this.page(url, opts))
    const exp = tr?.streams?.[0]?.expiresAt
    // Cached page whose signed URLs are (nearly) stale: read it again.
    if (!tr?.streams?.length || (exp != null && exp < this.now() + 30 * 60_000)) tr = find(await this.page(url, opts, true))
    if (!tr) throw new NetError('not_found', `track ${trackId} is no longer on ${url}`)
    if (!tr.streams?.length) throw new NetError('not_found', `"${tr.title}" can't be streamed from Bandcamp (purchase only)`)
    return tr.streams
  }
}
