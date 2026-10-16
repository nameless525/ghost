// The resolver's contract with search providers: what it accepts from findTrack, and what a failed
// source asks of the provider on the next resolve.
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { Settings } from '../../shared/types'
import { NetError } from '../net/errors'
import { ProviderRegistry } from '../providers'
import type { CanonicalTrack, Provider, ProviderCallOptions, SourceCandidate, StreamInfo } from '../providers/types'
import type { CatalogService } from './index'
import { CatalogRepo } from './repo'
import { createCatalogService } from './service'
import { memoryDb, seedSmall } from './testing'

const stream = (provider: string, locator: string): StreamInfo => ({
  provider,
  source: { kind: 'http', url: `https://${provider}.example/${encodeURIComponent(locator)}`, cacheKey: `${provider}:${locator}` },
  format: 'mp3',
  lossless: false,
  bitrateKbps: 320,
  sizeBytes: null,
  expiresAt: null
})

/** The album's own provider, its page down. */
const deadKh: Provider = {
  id: 'khinsider',
  name: 'KHInsider',
  async resolveStream(): Promise<StreamInfo[]> {
    throw new NetError('http', 'HTTP 500 from downloads.khinsider.com')
  }
}

/** A fallback search answering with fixed candidates; records each resolve and whether it was forced. */
function fallback(id: string, candidates: (t: CanonicalTrack) => SourceCandidate[]) {
  const p = {
    id,
    name: id,
    findTrackMode: 'fallback' as const,
    searches: 0,
    resolves: [] as string[],
    async findTrack(t: CanonicalTrack): Promise<SourceCandidate[]> {
      p.searches++
      return candidates(t)
    },
    async resolveStream(locator: string, opts: ProviderCallOptions = {}): Promise<StreamInfo[]> {
      p.resolves.push(`${locator}${opts.force ? ' (forced)' : ''}`)
      return [stream(id, locator)]
    }
  }
  return p satisfies Provider
}

function setup(...providers: Provider[]) {
  const settings: Settings = defaultSettings('/tmp/ghost-dl')
  const db = memoryDb()
  const repo = new CatalogRepo(db)
  const { albums } = seedSmall(repo)
  const registry = new ProviderRegistry()
  for (const p of providers) registry.register(p)
  const svc = createCatalogService({ db, broadcast: (() => {}) as never, getSettings: () => settings }, { registry, disableEnrichment: true, disableLocalScan: true, log: () => {} })
  return { svc, albums, db }
}

async function trackOf(svc: CatalogService, albumId: number, title: string) {
  return (await svc.album(String(albumId))).tracks.find((t) => t.title === title)!
}

describe('resolver: search candidates', () => {
  it('a candidate with no confidence is a known mismatch: never stored or played, the next provider is asked', async () => {
    const archive = fallback('archive', (t) => [
      { provider: 'archive', locator: 'hk/remix.mp3', title: `${t.title} Piano Cover Remix`, durationMs: 400_000, confidence: 0 },
      { provider: 'archive', locator: 'hk/nan.mp3', title: t.title, durationMs: null, confidence: Number.NaN }
    ])
    const youtube = fallback('youtube', (t) => [{ provider: 'youtube', locator: 'aaaaaaaaaaa', title: t.title, durationMs: t.durationMs, confidence: 0.8 }])
    const { svc, albums, db } = setup(deadKh, archive, youtube)
    const dirtmouth = await trackOf(svc, albums['hollow-knight-ost'], 'Dirtmouth')
    const list = await svc.resolveSources(dirtmouth.id)
    expect(list.map((s) => s.provider)).toEqual(['youtube'])
    expect(archive.searches).toBe(1)
    expect(archive.resolves).toEqual([])
    expect(youtube.searches).toBe(1)
    expect(db.prepare(`SELECT provider FROM sources WHERE track_id = ?`).all(Number(dirtmouth.id))).toEqual([{ provider: 'youtube' }])
  })

  it('a stored source with no confidence (kept by an older version) is not played', async () => {
    const youtube = fallback('youtube', (t) => [{ provider: 'youtube', locator: 'aaaaaaaaaaa', title: t.title, durationMs: t.durationMs, confidence: 0.8 }])
    const { svc, albums, db } = setup(deadKh, fallback('archive', () => []), youtube)
    const dirtmouth = await trackOf(svc, albums['hollow-knight-ost'], 'Dirtmouth')
    db.prepare(
      `INSERT INTO sources (track_id, provider, locator, cache_key, url, format, confidence, verified_at) VALUES (?, 'archive', 'hk/remix.mp3', 'ia:hk/remix.mp3', 'https://archive.org/download/hk/remix.mp3', 'mp3', 0, ?)`
    ).run(Number(dirtmouth.id), Date.now())
    expect((await svc.resolveSources(dirtmouth.id)).map((s) => s.provider)).toEqual(['youtube'])
  })

  it('after a failure only the failed candidate is resolved past the provider’s caches', async () => {
    const sc = fallback('soundcloud', (t) => [
      { provider: 'soundcloud', locator: '1', title: t.title, durationMs: t.durationMs, confidence: 0.9 },
      { provider: 'soundcloud', locator: '2', title: t.title, durationMs: t.durationMs, confidence: 0.7 }
    ])
    const { svc, albums } = setup(deadKh, sc)
    const dirtmouth = await trackOf(svc, albums['hollow-knight-ost'], 'Dirtmouth')
    const [first] = await svc.resolveSources(dirtmouth.id)
    expect(sc.resolves).toEqual(['1', '2'])
    svc.markSourceFailed(dirtmouth.id, (first.source as { cacheKey: string }).cacheKey, 'decode error')
    await svc.resolveSources(dirtmouth.id)
    expect(sc.resolves.slice(2).sort()).toEqual(['1 (forced)', '2'])
  })
})
