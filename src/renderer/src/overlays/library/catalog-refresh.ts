// When a library view built on a catalog query (a smart playlist) reloads: whenever
// 'catalog:status' reports a data revision past the one the view loaded, throttled, since the
// revision ticks several times a second while the catalog indexes. A hidden view only marks
// itself stale and reloads when it's shown again (see useLive).

/** Reload at most this often while the catalog keeps changing (slower while it indexes). */
export const CATALOG_REFRESH_MS = 700
export const CATALOG_REFRESH_INDEXING_MS = 2500

export class CatalogRefresh {
  /** The newest revision reported, null before the first report. */
  private latest: number | null = null
  /** The revision the shown data was loaded at; null: unknown, so any report may be newer. */
  private loadedAt: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private due = false

  constructor(
    /** Load the view again (it calls `loading()` as it starts). */
    private readonly reload: () => void,
    private readonly isShown: () => boolean,
    private readonly markStale: () => void
  ) {}

  /** A load starts, for whatever reason: it covers every revision reported so far. */
  loading(): void {
    this.loadedAt = this.latest
  }

  /** A 'catalog:status' report. */
  status(revision: number | undefined, indexing: boolean): void {
    if (revision == null) return
    this.latest = revision
    if (revision === this.loadedAt) return
    if (!this.isShown()) return this.markStale()
    if (this.timer !== null) {
      this.due = true
      return
    }
    this.reload()
    this.wait(indexing ? CATALOG_REFRESH_INDEXING_MS : CATALOG_REFRESH_MS)
  }

  private wait(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.due) return
      this.due = false
      // A load since (a library change, a reload) may already have covered it.
      if (this.latest === this.loadedAt) return
      if (!this.isShown()) return this.markStale()
      this.reload()
      this.wait(ms)
    }, ms)
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
