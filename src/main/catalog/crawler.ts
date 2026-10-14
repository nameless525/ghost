// Index crawl (DESIGN §6.3 tier 1): every KHInsider letter page (plus the "latest" feed) at a
// polite rate. Resumable: each fetched page is recorded in crawl_pages, so a restart continues
// where it stopped. A block page pauses the crawl (with a message for the UI) instead of retrying
// aggressively.

import { isNetError } from '../net/errors'
import type { IndexProvider, IndexSection } from '../providers/types'
import { writerPause, type CatalogRepo } from './repo'

export const INDEX_MAX_AGE_MS = 7 * 24 * 3600_000
const BLOCK_PAUSE_MS = 10 * 60_000
const ERROR_RETRY_MS = 30_000
const DEFAULT_PAGES_PER_SECTION = 6

interface JobRow {
  id: number
  provider: string
  started_at: number
  finished_at: number | null
  status: string
  initial: number
  message: string | null
}

export interface CrawlerDeps {
  repo: CatalogRepo
  provider: IndexProvider
  /** Called after every page and state change (status broadcast). */
  onProgress: () => void
  log?: (msg: string) => void
  now?: () => number
  /** Extra pause between index pages, on top of the host limiter (politeness). */
  pageDelayMs?: number
  /** Restrict to these section keys (smoke tests). */
  sections?: string[]
  /** Limit pages per section (smoke tests). */
  maxPagesPerSection?: number
}

const tick = () => new Promise<void>((r) => setImmediate(r))

export class Crawler {
  running = false
  progress: number | null = null
  message: string | null = null
  private abort: AbortController | null = null
  private now: () => number

  constructor(private deps: CrawlerDeps) {
    this.now = deps.now ?? Date.now
  }

  private sections(): IndexSection[] {
    const all = this.deps.provider.indexSections()
    return this.deps.sections ? all.filter((s) => this.deps.sections!.includes(s.key)) : all
  }

  lastFinished(): number | null {
    return (
      this.deps.repo.get<{ t: number | null }>(`SELECT MAX(finished_at) AS t FROM crawl_jobs WHERE provider = ? AND status = 'done'`, this.deps.provider.id)?.t ?? null
    )
  }

  /** True when there is no complete index or it is older than a week. */
  isStale(maxAgeMs = INDEX_MAX_AGE_MS): boolean {
    if (this.deps.repo.counts().albums === 0) return true
    const last = this.lastFinished()
    return last == null || this.now() - last > maxAgeMs
  }

  /** Start (or resume) a crawl. Returns false if one is running or nothing needs doing. */
  start(opts: { force?: boolean } = {}): boolean {
    if (this.running) return false
    const repo = this.deps.repo
    let job = repo.get<JobRow>(`SELECT * FROM crawl_jobs WHERE provider = ? AND status = 'running' ORDER BY id DESC LIMIT 1`, this.deps.provider.id)
    if (!job) {
      if (!opts.force && !this.isStale()) return false
      const initial = repo.counts().albums === 0 ? 1 : 0
      const r = repo.st(`INSERT INTO crawl_jobs (provider, started_at, status, initial) VALUES (?, ?, 'running', ?)`).run(this.deps.provider.id, this.now(), initial)
      job = repo.get<JobRow>(`SELECT * FROM crawl_jobs WHERE id = ?`, Number(r.lastInsertRowid))!
    }
    this.running = true
    this.abort = new AbortController()
    this.progress = 0
    this.message = job.initial ? 'Building the catalog…' : 'Refreshing the catalog…'
    this.deps.onProgress()
    void this.run(job, this.abort.signal)
      .catch((e) => {
        this.message = `Indexing failed: ${(e as Error).message}`
        this.deps.log?.(`crawl failed: ${(e as Error).stack ?? e}`)
      })
      .finally(() => {
        this.running = false
        this.progress = null
        this.abort = null
        this.deps.onProgress()
      })
    return true
  }

  stop(): void {
    this.abort?.abort()
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const t = setTimeout(resolve, ms)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          resolve()
        },
        { once: true }
      )
    })
  }

  private estimate(jobId: number, sections: IndexSection[]): { done: number; total: number } {
    const repo = this.deps.repo
    const known = new Map<string, number>()
    // Page counts from the previous job seed the estimate before page 1 of a section is fetched.
    for (const r of repo.all<{ section: string; t: number }>(
      `SELECT section, MAX(total_pages) AS t FROM crawl_pages WHERE job_id = (SELECT MAX(job_id) FROM crawl_pages WHERE job_id < ?) GROUP BY section`,
      jobId
    ))
      known.set(r.section, r.t)
    for (const r of repo.all<{ section: string; t: number }>(`SELECT section, MAX(total_pages) AS t FROM crawl_pages WHERE job_id = ? GROUP BY section`, jobId)) known.set(r.section, r.t)
    let total = 0
    for (const s of sections) total += Math.min(known.get(s.key) ?? DEFAULT_PAGES_PER_SECTION, this.cap(s))
    const done = repo.get<{ n: number }>(`SELECT COUNT(*) AS n FROM crawl_pages WHERE job_id = ? AND fetched_at IS NOT NULL`, jobId)!.n
    return { done, total: Math.max(total, done, 1) }
  }

  private cap(s: IndexSection): number {
    return Math.min(s.maxPages ?? Infinity, this.deps.maxPagesPerSection ?? Infinity)
  }

  private async run(job: JobRow, signal: AbortSignal): Promise<void> {
    const repo = this.deps.repo
    const sections = this.sections()
    const log = this.deps.log ?? (() => {})
    const pageRow = (section: string, page: number) =>
      repo.get<{ total_pages: number | null; fetched_at: number | null }>(`SELECT total_pages, fetched_at FROM crawl_pages WHERE job_id = ? AND section = ? AND page = ?`, job.id, section, page)

    for (const section of sections) {
      let page = 1
      let failures = 0
      for (;;) {
        if (signal.aborted) return
        const done = pageRow(section.key, page)
        let totalPages: number
        if (done?.fetched_at) {
          totalPages = done.total_pages ?? 1
        } else {
          let res
          try {
            res = await this.deps.provider.fetchIndexPage(section.key, page, { priority: 2, signal })
          } catch (e) {
            if (signal.aborted || isNetError(e, 'aborted')) return
            if (isNetError(e, 'blocked')) {
              this.message = (e as Error).message
              repo.run(`UPDATE crawl_jobs SET message = ? WHERE id = ?`, this.message, job.id)
              this.deps.onProgress()
              log(`crawl paused: ${this.message}`)
              await this.wait(BLOCK_PAUSE_MS, signal)
              continue
            }
            failures++
            log(`crawl ${section.key} p${page} failed (${failures}): ${(e as Error).message}`)
            if (failures < 3 && !isNetError(e, 'not_found') && !isNetError(e, 'parse')) {
              await this.wait(ERROR_RETRY_MS, signal)
              continue
            }
            // Give up on this page; record it so the job can finish.
            repo.run(
              `INSERT INTO crawl_pages (job_id, section, page, total_pages, items, fetched_at, error) VALUES (?, ?, ?, NULL, 0, ?, ?)
               ON CONFLICT(job_id, section, page) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error`,
              job.id,
              section.key,
              page,
              this.now(),
              (e as Error).message.slice(0, 300)
            )
            failures = 0
            const prev = repo.get<{ t: number | null }>(`SELECT MAX(total_pages) AS t FROM crawl_pages WHERE job_id = ? AND section = ?`, job.id, section.key)?.t
            totalPages = prev ?? page
            page++
            if (page > Math.min(totalPages, this.cap(section))) break
            continue
          }
          failures = 0
          // Small write transactions with pauses between them: Browse requests are answered and the
          // main process' library writes get the lock in between.
          await tick()
          const ids = await repo.upsertHitsPaced(res.items, { initial: !!job.initial })
          await writerPause()
          await repo.assignGamesPaced(ids)
          repo.revision++
          repo.run(
            `INSERT INTO crawl_pages (job_id, section, page, total_pages, items, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(job_id, section, page) DO UPDATE SET total_pages = excluded.total_pages, items = excluded.items, fetched_at = excluded.fetched_at, error = NULL`,
            job.id,
            section.key,
            page,
            res.totalPages,
            res.items.length,
            this.now()
          )
          totalPages = res.totalPages
          const est = this.estimate(job.id, sections)
          this.progress = Math.min(0.99, est.done / est.total)
          this.message = `${job.initial ? 'Building' : 'Refreshing'} the catalog… ${section.label} ${page}/${Math.min(totalPages, this.cap(section))}`
          this.deps.onProgress()
          if (this.deps.pageDelayMs) await this.wait(this.deps.pageDelayMs, signal)
        }
        page++
        if (page > Math.min(totalPages, this.cap(section))) break
      }
    }
    if (signal.aborted) return
    this.message = 'Grouping albums into games…'
    this.deps.onProgress()
    await repo.reclusterAll()
    repo.run(`UPDATE crawl_jobs SET status = 'done', finished_at = ?, message = NULL WHERE id = ?`, this.now(), job.id)
    // Keep crawl_pages of the last two jobs only (page-count estimates use the previous one).
    repo.run(`DELETE FROM crawl_pages WHERE job_id < (SELECT MIN(id) FROM (SELECT id FROM crawl_jobs ORDER BY id DESC LIMIT 2))`)
    this.message = null
    this.progress = null
    log(`crawl job ${job.id} done: ${JSON.stringify(repo.counts())}`)
  }
}
