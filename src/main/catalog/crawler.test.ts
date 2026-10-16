// Index crawls that stop part-way: failed pages, interruptions and resuming, with several sources
// sharing the crawl tables.
import { describe, expect, it } from 'vitest'
import { NetError } from '../net/errors'
import type { IndexPage, IndexProvider, ProviderCallOptions, StreamInfo } from '../providers/types'
import { Crawler, type CrawlerDeps } from './crawler'
import { CatalogRepo } from './repo'
import { hit, memoryDb } from './testing'

/** An index source with these sections (key → page count), one album a page. */
function fakeIndex(id: string, sections: Record<string, number>, calls: string[]) {
  const p = {
    id,
    name: id,
    /** Runs before a page is served: throw to fail it, return a promise to hold it. */
    before: null as ((section: string, page: number, signal?: AbortSignal) => void | Promise<void>) | null,
    indexSections: () => Object.keys(sections).map((key) => ({ key, label: key })),
    async fetchIndexPage(section: string, page: number, opts: ProviderCallOptions = {}): Promise<IndexPage> {
      calls.push(`${id}:${section}:${page}`)
      await p.before?.(section, page, opts.signal)
      const items = [hit(`${id}-${section}-${page}`, `${id} ${section} game ${page} OST`, 'ost', 2000, [], { provider: id })]
      return { items, page, totalPages: sections[section], totalAlbums: null }
    },
    async resolveStream(): Promise<StreamInfo[]> {
      return []
    }
  }
  return p satisfies IndexProvider
}

/** A page request that waits until the crawl is stopped; `reached` once it was asked for. */
function holdPage(): { reached: Promise<void>; hold: (signal?: AbortSignal) => Promise<void> } {
  let reached!: () => void
  const p = new Promise<void>((r) => (reached = r))
  return {
    reached: p,
    hold: (signal) => {
      reached()
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new NetError('aborted', 'request aborted')), { once: true }))
    }
  }
}

function crawl(repo: CatalogRepo, provider: IndexProvider, opts: Partial<CrawlerDeps> = {}) {
  const waiting: (() => void)[] = []
  const c: Crawler = new Crawler({
    repo,
    provider,
    pageDelayMs: 0,
    ...opts,
    onProgress: () => {
      opts.onProgress?.()
      if (!c.running) for (const w of waiting.splice(0)) w()
    }
  })
  /** Resolves once the crawl has ended (finished or stopped). */
  const idle = () => new Promise<void>((r) => (c.running ? waiting.push(r) : r()))
  return { c, idle }
}

const jobs = (repo: CatalogRepo, provider: string) => repo.all<{ status: string }>(`SELECT status FROM crawl_jobs WHERE provider = ? ORDER BY id`, provider).map((j) => j.status)
const pages = (repo: CatalogRepo, provider: string) =>
  repo.all<{ page: number }>(`SELECT page FROM crawl_pages p JOIN crawl_jobs j ON j.id = p.job_id WHERE j.provider = ? AND j.status = 'running' ORDER BY page`, provider).map((r) => r.page)
const albums = (repo: CatalogRepo, provider: string) => repo.all<{ provider_ref: string }>(`SELECT provider_ref FROM albums WHERE provider = ? ORDER BY provider_ref`, provider).map((r) => r.provider_ref)

describe('a page that fails', () => {
  it('does not end its section when the crawl resumes past it', async () => {
    const repo = new CatalogRepo(memoryDb())
    const calls: string[] = []
    const src = fakeIndex('zophar', { a: 4 }, calls)
    const page3 = holdPage()
    src.before = (_s, page, signal) => {
      if (page === 2) throw new NetError('parse', 'temporary malformed response')
      if (page === 3) return page3.hold(signal)
    }
    const first = crawl(repo, src)
    first.c.start()
    await page3.reached
    first.c.stop()
    await first.idle()
    expect(calls).toEqual(['zophar:a:1', 'zophar:a:2', 'zophar:a:3'])
    expect(jobs(repo, 'zophar')).toEqual(['running'])

    // the app restarts with every page readable: pages 3 and 4 are read before the job is done
    src.before = null
    calls.length = 0
    const resumed = crawl(repo, src)
    expect(resumed.c.start()).toBe(true)
    await resumed.idle()
    expect(calls).toEqual(['zophar:a:3', 'zophar:a:4'])
    expect(jobs(repo, 'zophar')).toEqual(['done'])
    expect(albums(repo, 'zophar')).toEqual(['zophar-a-1', 'zophar-a-3', 'zophar-a-4'])
  })

  it('first in its section: the crawl goes on for as many pages as the last one saw, also when resumed', async () => {
    const repo = new CatalogRepo(memoryDb())
    const calls: string[] = []
    const src = fakeIndex('zophar', { a: 3 }, calls)
    const full = crawl(repo, src)
    full.c.start()
    await full.idle()

    calls.length = 0
    src.before = (_s, page) => {
      if (page === 1) throw new NetError('parse', 'malformed response')
    }
    const refresh = crawl(repo, src)
    refresh.c.start({ force: true })
    await refresh.idle()
    expect(calls).toEqual(['zophar:a:1', 'zophar:a:2', 'zophar:a:3'])

    // the same with an interruption right after the failed page
    calls.length = 0
    const page2 = holdPage()
    src.before = (_s, page, signal) => {
      if (page === 1) throw new NetError('parse', 'malformed response')
      if (page === 2) return page2.hold(signal)
    }
    const interrupted = crawl(repo, src)
    interrupted.c.start({ force: true })
    await page2.reached
    interrupted.c.stop()
    await interrupted.idle()
    src.before = null
    calls.length = 0
    const resumed = crawl(repo, src)
    resumed.c.start()
    await resumed.idle()
    expect(calls).toEqual(['zophar:a:2', 'zophar:a:3'])
    expect(jobs(repo, 'zophar')).toEqual(['done', 'done', 'done'])

    // a section gone from the site: two failures in a row end it
    calls.length = 0
    src.before = () => {
      throw new NetError('not_found', 'no such page')
    }
    const gone = crawl(repo, src)
    gone.c.start({ force: true })
    await gone.idle()
    expect(calls).toEqual(['zophar:a:1', 'zophar:a:2'])
  })
})

describe('several sources sharing the crawl tables', () => {
  it('an interrupted crawl keeps its pages while other sources finish theirs, and resumes from them', async () => {
    const repo = new CatalogRepo(memoryDb())
    const calls: string[] = []
    const zophar = fakeIndex('zophar', { all: 2 }, calls)
    const page2 = holdPage()
    zophar.before = (_s, page, signal) => (page === 2 ? page2.hold(signal) : undefined)
    const z = crawl(repo, zophar)
    z.c.start()
    await page2.reached
    z.c.stop() // turned off mid-crawl
    await z.idle()
    for (const id of ['archive', 'modland']) {
      const other = crawl(repo, fakeIndex(id, { all: 1 }, calls))
      other.c.start()
      await other.idle()
    }
    expect(jobs(repo, 'zophar')).toEqual(['running'])
    expect(pages(repo, 'zophar')).toEqual([1])

    zophar.before = null
    calls.length = 0
    const resumed = crawl(repo, zophar)
    resumed.c.start()
    await resumed.idle()
    expect(calls).toEqual(['zophar:all:2'])
    expect(jobs(repo, 'zophar')).toEqual(['done'])
  })

  it('page-count estimates come from the same source’s previous crawl', async () => {
    const repo = new CatalogRepo(memoryDb())
    const calls: string[] = []
    const zophar = fakeIndex('zophar', { first: 1, long: 10 }, calls)
    const one = crawl(repo, zophar)
    one.c.start()
    await one.idle()
    // another source finishes in between (its sections say nothing about Zophar's)
    const archive = crawl(repo, fakeIndex('archive', { other: 2 }, calls))
    archive.c.start()
    await archive.idle()

    const seen: { detail: string | null; progress: number | null }[] = []
    const again: { c: Crawler; idle: () => Promise<void> } = crawl(repo, zophar, { onProgress: () => seen.push({ detail: again.c.detail, progress: again.c.progress }) })
    again.c.start({ force: true })
    await again.idle()
    // after the 1-page section, the 10-page one (as last time) is still ahead
    expect(seen.find((s) => s.detail === 'first 1/1')!.progress).toBeCloseTo(1 / 11)
  })
})
