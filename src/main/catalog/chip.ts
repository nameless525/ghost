// Chiptune rip index (DESIGN §6.2 #2): crawls the joshw.info letter listings and vgmrips.net's
// pack list (see providers/chip.ts) into `chip_sets`, and attaches every set to its game as a
// pinned 'gamerip' album (provider 'chip', formats ['chip']), creating the game when the catalog
// doesn't have it yet. Only listings are read; archives are fetched when an album is opened.
//
// Runs after the KHInsider index crawl (so most games already exist to match against), one page
// at a time with a pause between pages, at background priority. Resumable: each listing page is
// recorded in `chip_pages`; pages read within the refresh period are skipped on restart.

import { foldText } from '../../shared/search'
import type { DB } from '../db'
import { isNetError } from '../net/errors'
import { CHIP_ID, chipAlbumHit, JOSHW_SOURCES, type ChipProvider, type ChipSet, type JoshwSource } from '../providers/chip'
import { gameKey, keyOf, sortKey } from './normalize'
import { writerPause, type CatalogRepo } from './repo'

/** joshw listings barely change: re-read them monthly. */
export const CHIP_REFRESH_MS = 30 * 24 * 3600_000
/** vgmrips adds packs every week. */
export const VGMRIPS_REFRESH_MS = 7 * 24 * 3600_000
const BLOCK_PAUSE_MS = 15 * 60_000
const VGMRIPS = 'vgmrips'
/** When the last complete pass ended; `${FINISHED}:<source>` for each source it covered. */
const FINISHED = 'chip:finished_at'
/** Page-count guesses for the progress bar before a source has been listed once. */
const GUESS_PAGES = { joshw: 31, vgmrips: 230 }

export const CHIP_DDL = `
CREATE TABLE IF NOT EXISTS chip_sets (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,
  ref         TEXT NOT NULL UNIQUE,
  url         TEXT,
  game_title  TEXT NOT NULL,
  alt_titles  TEXT NOT NULL DEFAULT '[]',
  system      TEXT,
  format      TEXT NOT NULL,
  year        INTEGER,
  size        INTEGER,
  album_id    INTEGER,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chip_sets_album ON chip_sets(album_id);
CREATE TABLE IF NOT EXISTS chip_pages (
  source      TEXT NOT NULL,
  page        TEXT NOT NULL,
  fetched_at  INTEGER,
  items       INTEGER,
  skipped     INTEGER,
  error       TEXT,
  PRIMARY KEY (source, page)
);
`

export function ensureChipSchema(db: DB): void {
  db.exec(CHIP_DDL)
}

export interface ChipIndexerDeps {
  repo: CatalogRepo
  provider: ChipProvider
  /** Called after every page and state change (status broadcast). */
  onProgress: () => void
  log?: (msg: string) => void
  now?: () => number
  /** Pause between listing pages (on top of the per-host limiter). */
  pageDelayMs?: number
  /** Only these joshw hosts (default: all of JOSHW_SOURCES). */
  hosts?: string[]
  /** Whether the joshw.info listings may be crawled (user opt-in; robots.txt disallows bots). Default true. */
  joshwEnabled?: () => boolean
  /** Crawl vgmrips.net (default true). */
  vgmrips?: boolean
  /** At most this many listing pages per source (smoke tests). */
  maxPages?: number
  /** Only these joshw listing pages ('/c/', '/MSX/m/'), smoke tests. */
  pages?: string[]
}

interface PageRef {
  source: string
  key: string
  fetch: (signal: AbortSignal) => Promise<{ sets: ChipSet[]; skipped: number; totalPages?: number }>
  refreshMs: number
}

export class ChipIndexer {
  running = false
  progress: number | null = null
  message: string | null = null
  private abort: AbortController | null = null
  /** Start over once the stopped pass has wound down (the source list changed). */
  private restart = false
  private readonly now: () => number

  constructor(private readonly deps: ChipIndexerDeps) {
    this.now = deps.now ?? Date.now
    ensureChipSchema(deps.repo.db)
  }

  private get log(): (m: string) => void {
    return this.deps.log ?? (() => {})
  }

  private joshwSources(): JoshwSource[] {
    const only = this.deps.hosts
    if (only) return JOSHW_SOURCES.filter((s) => only.includes(s.host))
    return this.deps.joshwEnabled?.() === false ? [] : JOSHW_SOURCES
  }

  private sourceKeys(): string[] {
    return [...this.joshwSources().map((s) => s.host), ...(this.deps.vgmrips === false ? [] : [VGMRIPS])]
  }

  /** When the index was last completed (all sources), or null. */
  lastFinished(): number | null {
    const v = this.deps.repo.meta(FINISHED)
    return v ? Number(v) : null
  }

  /** True when some source was never listed or its last full pass is older than its refresh period. */
  isStale(): boolean {
    const last = this.lastFinished()
    if (last == null || this.now() - last > VGMRIPS_REFRESH_MS) return true
    // A source turned on since (the joshw.info opt-in) is listed now, not at the next refresh.
    return this.sourceKeys().some((s) => this.deps.repo.meta(`${FINISHED}:${s}`) == null)
  }

  /** Start (or resume) indexing. False if running or nothing is due. */
  start(opts: { force?: boolean } = {}): boolean {
    if (this.running) return false
    if (!opts.force && !this.isStale()) return false
    if (opts.force) {
      this.deps.repo.run(`UPDATE chip_pages SET fetched_at = NULL`)
      this.deps.repo.setMeta('chip:vgmrips:full_at', null)
      // Due until this pass completes (also when it is interrupted).
      this.deps.repo.run(`DELETE FROM catalog_meta WHERE key LIKE ?`, `${FINISHED}:%`)
    }
    this.running = true
    this.abort = new AbortController()
    this.progress = 0
    this.message = 'Indexing chiptune rips…'
    this.deps.onProgress()
    const signal = this.abort.signal
    void this.run(signal)
      .catch((e) => {
        this.message = null
        this.log(`chip index failed: ${(e as Error).stack ?? e}`)
      })
      .finally(() => {
        this.running = false
        this.progress = null
        this.abort = null
        if (!signal.aborted) this.message = null
        this.deps.onProgress()
        if (this.restart) {
          this.restart = false
          this.start()
        }
      })
    return true
  }

  stop(): void {
    this.restart = false
    this.abort?.abort()
  }

  /**
   * The joshw.info opt-in changed: a pass under way stops (no request to a host turned off) and
   * starts over with the current sources, skipping the pages it already read.
   */
  sourcesChanged(): void {
    if (!this.running) return
    this.restart = true
    this.abort?.abort()
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted || ms <= 0) return resolve()
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

  private pageRow(source: string, key: string): { fetched_at: number | null; items: number | null } | undefined {
    return this.deps.repo.get(`SELECT fetched_at, items FROM chip_pages WHERE source = ? AND page = ?`, source, key)
  }

  private record(source: string, key: string, items: number, skipped: number, error: string | null): void {
    this.deps.repo.run(
      `INSERT INTO chip_pages (source, page, fetched_at, items, skipped, error) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, page) DO UPDATE SET fetched_at = excluded.fetched_at, items = excluded.items, skipped = excluded.skipped, error = excluded.error`,
      source,
      key,
      this.now(),
      items,
      skipped,
      error
    )
  }

  private fresh(p: PageRef): boolean {
    const r = this.pageRow(p.source, p.key)
    return !!r?.fetched_at && this.now() - r.fetched_at < p.refreshMs
  }

  private estimateTotal(): number {
    let total = 0
    for (const s of this.sourceKeys()) {
      const n = this.deps.repo.get<{ n: number }>(`SELECT COUNT(*) AS n FROM chip_pages WHERE source = ?`, s)?.n ?? 0
      const guess = s === VGMRIPS ? Number(this.deps.repo.meta('chip:vgmrips:pages') ?? GUESS_PAGES.vgmrips) : GUESS_PAGES.joshw
      total += Math.min(Math.max(n, guess), this.deps.maxPages ?? Infinity)
    }
    return Math.max(1, total)
  }

  private async run(signal: AbortSignal): Promise<void> {
    const max = this.deps.maxPages ?? Infinity
    const delay = this.deps.pageDelayMs ?? 1500
    const joshw = this.joshwSources()
    const sources = this.sourceKeys()
    const total = this.estimateTotal()
    let done = 0
    let added = 0
    const step = (label: string) => {
      done++
      this.progress = Math.min(0.99, done / total)
      this.message = `Indexing chiptune rips… ${label}`
      this.deps.onProgress()
    }

    /**
     * Read one listing page (unless fresh, or `always`) and attach its sets. `ok: false` = aborted.
     * `fresh` = new sets on the page (not seen before).
     */
    const visit = async (p: PageRef, label: string, always = false): Promise<{ ok: boolean; totalPages?: number; fresh?: number }> => {
      if (!always && this.fresh(p)) {
        step(label)
        return { ok: true }
      }
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) return { ok: false }
        try {
          const res = await p.fetch(signal)
          const fresh = res.sets.length - this.knownRefs(res.sets.map((x) => x.ref))
          // In small transactions with pauses (see writerPause).
          const ids: number[] = []
          for (let i = 0; i < res.sets.length; i += 40) {
            if (i) await writerPause()
            for (const id of this.attach(res.sets.slice(i, i + 40))) ids.push(id)
          }
          added += ids.length
          this.record(p.source, p.key, res.sets.length, res.skipped, null)
          step(label)
          await this.wait(delay, signal)
          return { ok: true, totalPages: res.totalPages, fresh }
        } catch (e) {
          if (signal.aborted || isNetError(e, 'aborted')) return { ok: false }
          if (isNetError(e, 'blocked')) {
            this.message = (e as Error).message
            this.deps.onProgress()
            this.log(`chip index paused: ${this.message}`)
            await this.wait(BLOCK_PAUSE_MS, signal)
            continue
          }
          if (attempt < 1 && !isNetError(e, 'not_found') && !isNetError(e, 'parse')) {
            await this.wait(30_000, signal)
            continue
          }
          this.log(`chip index ${p.source} ${p.key}: ${(e as Error).message}`)
          this.record(p.source, p.key, 0, 0, (e as Error).message.slice(0, 300))
          step(label)
          return { ok: true }
        }
      }
    }

    for (const src of joshw) {
      if (signal.aborted) return
      let pages: { path: string; group: string | null }[]
      try {
        pages = await this.deps.provider.joshwPages(src, { priority: 2, signal })
      } catch (e) {
        if (signal.aborted) return
        this.log(`chip index: listing ${src.host} failed: ${(e as Error).message}`)
        continue
      }
      const only = this.deps.pages
      for (const page of (only ? pages.filter((p) => only.includes(p.path)) : pages).slice(0, max)) {
        const label = `${src.format} · ${decodeURIComponent(page.path).replace(/^\/|\/$/g, '').toUpperCase()}`
        const r = await visit({ source: src.host, key: page.path, refreshMs: CHIP_REFRESH_MS, fetch: (s) => this.deps.provider.fetchJoshwPage(src, page, { priority: 2, signal: s }) }, label)
        if (!r.ok) return
      }
    }

    if (this.deps.vgmrips !== false) {
      // The list is newest first: after a full pass, a refresh reads pages until one has nothing new
      // (a full pass again once a month).
      const repo = this.deps.repo
      const fullAt = Number(repo.meta('chip:vgmrips:full_at') ?? 0)
      const incremental = fullAt > 0 && this.now() - fullAt < CHIP_REFRESH_MS
      let totalPages = Number(repo.meta('chip:vgmrips:pages') ?? 0) || 1
      let complete = true
      for (let p = 0; p < totalPages; p++) {
        if (p >= max) {
          complete = false
          break
        }
        const r = await visit(
          { source: VGMRIPS, key: `latest?p=${p}`, refreshMs: VGMRIPS_REFRESH_MS, fetch: (s) => this.deps.provider.fetchVgmripsPage(p, { priority: 2, signal: s }) },
          `VGM · ${p + 1}/${totalPages}`,
          incremental
        )
        if (!r.ok) return
        if (r.totalPages && r.totalPages !== totalPages) {
          totalPages = r.totalPages
          repo.setMeta('chip:vgmrips:pages', String(totalPages))
        }
        if (incremental && r.fresh === 0) break
      }
      if (complete && !incremental) repo.setMeta('chip:vgmrips:full_at', String(this.now()))
    }
    if (signal.aborted) return
    const at = String(this.now())
    for (const s of sources) this.deps.repo.setMeta(`${FINISHED}:${s}`, at)
    this.deps.repo.setMeta(FINISHED, at)
    this.log(`chip index pass done: ${added} sets attached`)
  }

  /** How many of these refs are already indexed. */
  private knownRefs(refs: string[]): number {
    let n = 0
    for (let i = 0; i < refs.length; i += 400) {
      const chunk = refs.slice(i, i + 400)
      n += this.deps.repo.get<{ n: number }>(`SELECT COUNT(*) AS n FROM chip_sets WHERE ref IN (${chunk.map(() => '?').join(',')})`, ...chunk)?.n ?? 0
    }
    return n
  }

  /**
   * Upsert sets as albums and pin each to its game: an existing game whose key / name / sort name
   * matches the set's title or an alternative title, else a new game named after the set.
   * Returns the album ids (input order).
   */
  attach(sets: ChipSet[]): number[] {
    if (!sets.length) return []
    const repo = this.deps.repo
    const now = this.now()
    // Sets found by the first pass have no meaningful "added" date; later ones are new.
    const first = this.lastFinished() == null
    const ids = repo.upsertHits(sets.map(chipAlbumHit), { initial: first })
    const created = new Map<string, string>()
    repo.tx(() => {
      sets.forEach((s, i) => {
        const id = ids[i]
        // Every game the title or an alternative title names; on a tie, the one on the set's platform
        // ("Final Fantasy III" [SNES] is Final Fantasy VI, not the NES game).
        const cands: string[] = []
        for (const n of [s.title, ...s.altTitles]) {
          const k = repo.findGameKey(n, { scanAltNames: false })
          if (k && !cands.includes(k)) cands.push(k)
        }
        let key: string | null = cands[0] ?? null
        if (cands.length > 1 && s.system) {
          const plat = JSON.stringify(s.system.platform.name)
          key = cands.find((k) => (repo.get<{ platforms: string }>(`SELECT platforms FROM games WHERE norm_key = ?`, k)?.platforms ?? '').includes(plat)) ?? key
        }
        if (!key) {
          key = gameKey(s.title) || keyOf(s.title) || foldText(s.title)
          if (!repo.get(`SELECT 1 FROM games WHERE norm_key = ?`, key)) created.set(key, s.title)
        }
        repo.run(
          `UPDATE albums SET game_key = ?, formats = '["chip"]', art_checked_at = COALESCE(art_checked_at, ?),
             track_count = COALESCE(track_count, ?), sizes = CASE WHEN detail_at IS NULL THEN ? ELSE sizes END,
             alt_titles = CASE WHEN detail_at IS NULL THEN ? ELSE alt_titles END,
             developers = CASE WHEN detail_at IS NULL THEN ? ELSE developers END,
             publishers = CASE WHEN detail_at IS NULL THEN ? ELSE publishers END,
             composers = CASE WHEN detail_at IS NULL THEN ? ELSE composers END
           WHERE id = ?`,
          key,
          now,
          s.trackCount,
          JSON.stringify(s.sizeBytes ? { chip: s.sizeBytes } : {}),
          JSON.stringify(s.altTitles),
          JSON.stringify(s.developers),
          JSON.stringify(s.publishers),
          JSON.stringify(s.composers),
          id
        )
        if (s.composers.length && !repo.get(`SELECT 1 FROM albums WHERE id = ? AND detail_at IS NOT NULL`, id)) {
          for (const c of s.composers) repo.run(`INSERT OR IGNORE INTO album_composers(album_id, name_fold, name) VALUES (?, ?, ?)`, id, foldText(c), c)
        }
        repo.run(
          `INSERT INTO chip_sets (source, ref, url, game_title, alt_titles, system, format, year, size, album_id, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ref) DO UPDATE SET url = excluded.url, game_title = excluded.game_title, alt_titles = excluded.alt_titles, system = excluded.system,
             format = excluded.format, year = excluded.year, size = excluded.size, album_id = excluded.album_id, last_seen = excluded.last_seen`,
          s.source,
          s.ref,
          s.archiveUrl,
          s.title,
          JSON.stringify(s.altTitles),
          s.system?.label ?? null,
          s.format,
          s.year,
          s.sizeBytes,
          id,
          now,
          now
        )
      })
    })
    repo.assignGames(ids)
    // New games are named after the set (the album title carries "(SNES SPC rip)").
    if (created.size) {
      repo.tx(() => {
        for (const [key, name] of created) {
          repo.run(
            `UPDATE games SET name = ?, sort_name = ? WHERE norm_key = ? AND igdb_json IS NULL
               AND NOT EXISTS (SELECT 1 FROM albums a WHERE a.game_id = games.id AND a.provider != ? AND a.gone = 0)`,
            name,
            sortKey(name),
            key,
            CHIP_ID
          )
        }
      })
      repo.updateAlbumFts(repo.all<{ id: number }>(`SELECT a.id FROM albums a JOIN games g ON g.id = a.game_id WHERE g.norm_key IN (${[...created.keys()].map(() => '?').join(',')})`, ...created.keys()).map((r) => r.id))
    }
    repo.revision++
    return ids
  }
}
