// Persistent download queue (concurrency 3). Resolves the best source for the quality
// setting, names the file from the template, hands it to the engine (download + tag) and
// tracks progress. State machine per item:
//   queued -> resolving -> downloading -> (tagging) -> done
//                    \-> error (after every source failed)     any non-final -> canceled
//   error/canceled -> queued (retry)
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DownloadsAPI } from '../../shared/api'
import type { DownloadItem, DownloadStatus, DownloadTarget, ID, Settings, TrackView } from '../../shared/types'
import type { CatalogService, ResolvedSource } from '../catalog'
import type { EngineBridge, EngineEvent } from '../engine/types'
import type { Broadcast } from '../ipc'
import type { DownloadRecord, DownloadsRepo } from '../library/downloads-repo'
import { buildDownloadPath, expandHome, extensionFor, uniquePath } from './naming'
import { buildTags, templateVars } from './tags'

export type DownloadCatalog = Pick<CatalogService, 'album' | 'albumOf' | 'resolveSources' | 'getAnalysis' | 'markSourceFailed'>

export interface DownloadLibrary {
  readonly downloads: DownloadsRepo
  fetchTracks(ids: ID[]): Promise<TrackView[]>
  downloadedPath(trackId: ID): string | null
  noteDownloaded(trackId: ID, path: string): void
}

export interface DownloadManagerDeps {
  engine: EngineBridge
  catalog: DownloadCatalog
  library: DownloadLibrary
  playlists: { trackIds(id: ID): Promise<ID[]>; get(id: ID): Promise<{ playlist: { name: string } }> }
  getSettings: () => Settings
  broadcast: Broadcast
  shell: { showItemInFolder(path: string): void; openPath(path: string): Promise<string> }
  concurrency?: number
  /** Minimum interval between 'downloads:changed' broadcasts (<= 4/s by default). */
  throttleMs?: number
  fileExists?: (path: string) => boolean
  mkdirp?: (dir: string) => void
  now?: () => number
}

interface Job {
  id: ID
  canceled: boolean
  sources: ResolvedSource[]
  srcIdx: number
  dest: string | null
  /** engine.download() has been called for the current source. */
  launched: boolean
  track: TrackView | null
  lastError: string | null
}

interface Batch {
  label: string
  total: number
  done: number
  failed: number
  canceled: number
  cover: string | null
}

const FINAL: DownloadStatus[] = ['done', 'error', 'canceled']
const sourceKey = (s: ResolvedSource) => (s.source.kind === 'http' ? s.source.cacheKey : `file:${s.source.path}`)

export class DownloadManager implements DownloadsAPI {
  private readonly items = new Map<ID, DownloadRecord>()
  private readonly seq = new Map<ID, number>()
  private nextSeq = 0
  private readonly active = new Map<ID, Job>()
  private readonly reserved = new Set<string>()
  private readonly batches = new Map<string, Batch>()
  private readonly repo: DownloadsRepo
  private readonly concurrency: number
  private readonly throttleMs: number
  private readonly fileExists: (p: string) => boolean
  private readonly mkdirp: (d: string) => void
  private readonly now: () => number
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private lastEmit = 0
  private disposed = false
  private pending = new Set<Promise<unknown>>()

  constructor(private readonly deps: DownloadManagerDeps) {
    this.repo = deps.library.downloads
    this.concurrency = Math.max(1, deps.concurrency ?? 3)
    this.throttleMs = deps.throttleMs ?? 250
    this.fileExists = deps.fileExists ?? existsSync
    this.mkdirp = deps.mkdirp ?? ((d) => mkdirSync(d, { recursive: true }))
    this.now = deps.now ?? Date.now
    // Oldest first (stable sort keeps rowid order within a batch) so `seq` matches enqueue order.
    const rows = this.repo.visible().sort((a, b) => a.createdAt - b.createdAt)
    for (const r of rows) this.remember(r)
  }

  private remember(rec: DownloadRecord): void {
    this.items.set(rec.id, rec)
    if (!this.seq.has(rec.id)) this.seq.set(rec.id, this.nextSeq++)
  }

  /** Re-queue work interrupted by a quit/crash and start processing. */
  resume(): void {
    const interrupted = this.repo.unfinished()
    for (const rec of interrupted) {
      const mem = this.items.get(rec.id) ?? rec
      if (mem.status !== 'queued') {
        mem.status = 'queued'
        mem.bytes = 0
        mem.progress = 0
        this.repo.save(mem)
      }
      this.remember(mem)
      if (mem.batch) {
        const b = this.batches.get(mem.batch) ?? { label: mem.albumTitle || 'downloads', total: 0, done: 0, failed: 0, canceled: 0, cover: mem.cover }
        b.total++
        this.batches.set(mem.batch, b)
      }
    }
    if (interrupted.length) this.emitChanged()
    this.pump()
  }

  // ---------------------------------------------------------------------------
  // broadcasting

  private sorted(): DownloadRecord[] {
    return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt || (this.seq.get(a.id) ?? 0) - (this.seq.get(b.id) ?? 0))
  }

  private toItem(r: DownloadRecord): DownloadItem {
    return {
      id: r.id,
      trackId: r.trackId,
      title: r.title,
      gameName: r.gameName,
      albumTitle: r.albumTitle,
      cover: r.cover,
      status: r.status,
      progress: r.progress,
      bytes: r.bytes,
      totalBytes: r.totalBytes,
      path: r.path,
      error: r.error,
      createdAt: r.createdAt
    }
  }

  private emitChanged(): void {
    if (this.disposed || this.emitTimer) return
    const wait = this.lastEmit + this.throttleMs - Date.now()
    if (wait <= 0) return this.flush()
    this.emitTimer = setTimeout(() => this.flush(), wait)
  }

  private flush(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    if (this.disposed) return
    this.lastEmit = Date.now()
    this.deps.broadcast('downloads:changed', this.sorted().map((r) => this.toItem(r)))
  }

  private notify(kind: 'info' | 'success' | 'error' | 'progress', title: string, body?: string, image?: string | null, id?: string, progress?: number): void {
    this.deps.broadcast('notify', { id: id ?? `dl-${randomUUID()}`, kind, title, body, image: image ?? null, progress })
  }

  private setStatus(rec: DownloadRecord, status: DownloadStatus, persist = true): void {
    rec.status = status
    if (persist) this.repo.save(rec)
    this.emitChanged()
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const w = p.catch((e) => console.error('[downloads]', e)) as Promise<T>
    this.pending.add(w)
    void w.finally(() => this.pending.delete(w))
    return w
  }

  /** Resolves when no download job is mid-resolution (tests). */
  async settled(): Promise<void> {
    for (let i = 0; i < 50 && this.pending.size; i++) await Promise.all([...this.pending])
  }

  // ---------------------------------------------------------------------------
  // queue

  private async targetTrackIds(target: DownloadTarget): Promise<{ ids: ID[]; label: string | null }> {
    if ('trackIds' in target) return { ids: target.trackIds ?? [], label: null }
    if ('albumId' in target) {
      const d = await this.deps.catalog.album(target.albumId)
      return { ids: d.tracks.map((t) => t.id), label: d.album.title }
    }
    if ('playlistId' in target) {
      const [ids, detail] = await Promise.all([this.deps.playlists.trackIds(target.playlistId), this.deps.playlists.get(target.playlistId)])
      return { ids, label: detail.playlist.name }
    }
    return { ids: [], label: null }
  }

  async enqueue(target: DownloadTarget): Promise<void> {
    const { ids, label } = await this.targetTrackIds(target)
    const unique = [...new Set(ids)]
    if (!unique.length) return
    const busy = new Set([...this.items.values()].filter((r) => !FINAL.includes(r.status)).map((r) => r.trackId))
    const tracks = await this.deps.library.fetchTracks(unique)
    const fresh = tracks.filter((t) => !busy.has(t.id) && !this.deps.library.downloadedPath(t.id))
    const skipped = tracks.length - fresh.length
    if (!fresh.length) {
      this.notify('info', tracks.length === 1 ? 'Already downloaded' : 'Nothing new to download', tracks.length === 1 ? tracks[0].title : `${tracks.length} tracks are already downloaded or queued`)
      return
    }
    const batch = fresh.length > 1 ? randomUUID() : null
    const now = this.now()
    for (const t of fresh) {
      const rec: DownloadRecord = {
        id: randomUUID(),
        trackId: t.id,
        title: t.title,
        gameName: t.gameName,
        albumTitle: t.albumTitle,
        cover: t.cover,
        status: 'queued',
        progress: 0,
        bytes: 0,
        totalBytes: null,
        path: null,
        error: null,
        createdAt: now,
        format: null,
        batch,
        finishedAt: null
      }
      this.repo.insert(rec)
      this.remember(rec)
    }
    if (batch) {
      const b: Batch = { label: label ?? `${fresh.length} tracks`, total: fresh.length, done: 0, failed: 0, canceled: 0, cover: fresh[0].cover }
      this.batches.set(batch, b)
      this.notify('progress', `Downloading ${b.label}`, `0 of ${b.total}${skipped ? ` · ${skipped} already downloaded` : ''}`, b.cover, `dl-batch-${batch}`, 0)
    }
    this.emitChanged()
    this.pump()
  }

  private pump(): void {
    if (this.disposed) return
    while (this.active.size < this.concurrency) {
      const next = [...this.items.values()]
        .filter((r) => r.status === 'queued' && !this.active.has(r.id))
        .sort((a, b) => a.createdAt - b.createdAt || (this.seq.get(a.id) ?? 0) - (this.seq.get(b.id) ?? 0))[0]
      if (!next) return
      const job: Job = { id: next.id, canceled: false, sources: [], srcIdx: -1, dest: null, launched: false, track: null, lastError: null }
      this.active.set(next.id, job)
      void this.track(this.start(next, job))
    }
  }

  private async start(rec: DownloadRecord, job: Job): Promise<void> {
    this.setStatus(rec, 'resolving')
    rec.error = null
    try {
      const [track] = await this.deps.library.fetchTracks([rec.trackId])
      if (job.canceled) return
      if (!track) throw new Error('This track is no longer in the catalog.')
      job.track = track
      const sources = await this.deps.catalog.resolveSources(rec.trackId, { quality: this.deps.getSettings().sources.quality })
      if (job.canceled) return
      job.sources = sources
      if (!sources.length) throw new Error('No downloadable source found.')
      await this.launchNext(rec, job)
    } catch (e) {
      if (!job.canceled) this.fail(rec, job, (e as Error)?.message ?? String(e))
    }
  }

  private async launchNext(rec: DownloadRecord, job: Job): Promise<void> {
    for (;;) {
      if (job.canceled) return
      const src = job.sources[++job.srcIdx]
      if (!src) return this.fail(rec, job, job.lastError ?? 'Every source failed.')
      const track = job.track!
      let meta: Awaited<ReturnType<DownloadCatalog['albumOf']>> = null
      try {
        meta = await this.deps.catalog.albumOf(rec.trackId)
      } catch {
        meta = null
      }
      if (job.canceled) return
      const settings = this.deps.getSettings()
      const ext = extensionFor(src.format, src.source)
      const base = buildDownloadPath({ baseDir: expandHome(settings.library.downloadDir), template: settings.library.namingTemplate, vars: templateVars(track, meta?.album ?? null, meta?.game ?? null), ext })
      if (job.dest) this.reserved.delete(job.dest.toLowerCase())
      const dest = uniquePath(base, (p) => this.reserved.has(p.toLowerCase()) || this.fileExists(p))
      this.reserved.add(dest.toLowerCase())
      job.dest = dest
      let analysis = null
      try {
        analysis = this.deps.catalog.getAnalysis(rec.trackId)
      } catch {
        analysis = null
      }
      const tags = buildTags(track, meta?.album ?? null, meta?.game ?? null, analysis)
      rec.format = src.format
      rec.totalBytes = src.sizeBytes ?? null
      rec.bytes = 0
      rec.progress = 0
      if (meta?.album && !rec.albumTitle) rec.albumTitle = meta.album.title
      try {
        this.mkdirp(dirname(dest))
        this.deps.engine.download(rec.id, src.source, dest, tags)
      } catch (e) {
        job.lastError = (e as Error)?.message ?? String(e)
        continue
      }
      job.launched = true
      this.setStatus(rec, 'downloading')
      return
    }
  }

  /** Engine 'download' events. */
  handleEngineEvent(e: EngineEvent): void {
    if (e.type !== 'download') return
    const rec = this.items.get(e.downloadId)
    const job = this.active.get(e.downloadId)
    if (!rec || !job || job.canceled) return
    switch (e.status) {
      case 'progress': {
        rec.bytes = e.bytes
        if (e.totalBytes) rec.totalBytes = e.totalBytes
        rec.progress = rec.totalBytes ? Math.min(0.999, rec.bytes / rec.totalBytes) : rec.progress
        // All bytes are in but no 'done' yet: the engine is writing tags.
        if (rec.totalBytes && rec.bytes >= rec.totalBytes && rec.status === 'downloading') rec.status = 'tagging'
        this.emitChanged()
        return
      }
      case 'done':
        return this.complete(rec, job, e.path ?? job.dest!, e.bytes)
      case 'error': {
        const msg = e.error ?? 'Download failed.'
        job.lastError = msg
        job.launched = false
        const src = job.sources[job.srcIdx]
        if (src) {
          try {
            this.deps.catalog.markSourceFailed(rec.trackId, sourceKey(src), msg)
          } catch {
            /* ignore */
          }
        }
        this.setStatus(rec, 'resolving', false)
        void this.track(this.launchNext(rec, job))
        return
      }
      case 'canceled':
        this.finishJob(rec, job)
        if (rec.status !== 'canceled') this.setStatus(rec, 'canceled')
        this.settleBatch(rec)
        this.pump()
        return
    }
  }

  private finishJob(rec: DownloadRecord, job: Job): void {
    this.active.delete(rec.id)
    if (job.dest) this.reserved.delete(job.dest.toLowerCase())
  }

  private complete(rec: DownloadRecord, job: Job, path: string, bytes: number): void {
    this.finishJob(rec, job)
    rec.path = path
    rec.bytes = bytes || rec.bytes
    if (!rec.totalBytes) rec.totalBytes = rec.bytes || null
    rec.progress = 1
    rec.error = null
    rec.finishedAt = this.now()
    this.setStatus(rec, 'done')
    try {
      this.deps.library.noteDownloaded(rec.trackId, path)
    } catch (e) {
      console.error('[downloads] noteDownloaded failed:', e)
    }
    if (!rec.batch || !this.batches.has(rec.batch)) this.notify('success', 'Downloaded', rec.title, rec.cover)
    this.settleBatch(rec)
    this.pump()
  }

  private fail(rec: DownloadRecord, job: Job, message: string): void {
    this.finishJob(rec, job)
    rec.error = message
    rec.progress = 0
    this.setStatus(rec, 'error')
    if (!rec.batch || !this.batches.has(rec.batch)) this.notify('error', `Download failed: ${rec.title}`, message, rec.cover)
    this.settleBatch(rec)
    this.pump()
  }

  private settleBatch(rec: DownloadRecord): void {
    const id = rec.batch
    const b = id ? this.batches.get(id) : undefined
    if (!id || !b) return
    if (rec.status === 'done') b.done++
    else if (rec.status === 'error') b.failed++
    else if (rec.status === 'canceled') b.canceled++
    const settled = b.done + b.failed + b.canceled
    if (settled < b.total) {
      this.notify('progress', `Downloading ${b.label}`, `${b.done} of ${b.total}${b.failed ? ` · ${b.failed} failed` : ''}`, b.cover, `dl-batch-${id}`, settled / b.total)
      return
    }
    this.batches.delete(id)
    if (b.failed) this.notify('error', `Downloaded ${b.done} of ${b.total}: ${b.label}`, `${b.failed} track${b.failed === 1 ? '' : 's'} failed. Retry them from Downloads.`, b.cover, `dl-batch-${id}`)
    else if (b.done) this.notify('success', `Downloaded ${b.label}`, `${b.done} track${b.done === 1 ? '' : 's'}${b.canceled ? ` · ${b.canceled} canceled` : ''}`, b.cover, `dl-batch-${id}`)
    else this.notify('info', `Canceled ${b.label}`, undefined, b.cover, `dl-batch-${id}`)
  }

  // ---------------------------------------------------------------------------
  // DownloadsAPI

  async list(): Promise<DownloadItem[]> {
    return this.sorted().map((r) => this.toItem(r))
  }

  async cancel(id: ID): Promise<void> {
    const rec = this.items.get(id)
    if (!rec || FINAL.includes(rec.status)) return
    const job = this.active.get(id)
    if (job) {
      job.canceled = true
      if (job.launched) {
        try {
          this.deps.engine.cancelDownload(id)
        } catch (e) {
          console.error('[downloads] cancelDownload failed:', e)
        }
      }
      this.finishJob(rec, job)
    }
    rec.error = null
    this.setStatus(rec, 'canceled')
    this.settleBatch(rec)
    this.pump()
  }

  async retry(id: ID): Promise<void> {
    const rec = this.items.get(id)
    if (!rec || (rec.status !== 'error' && rec.status !== 'canceled')) return
    rec.error = null
    rec.bytes = 0
    rec.progress = 0
    rec.totalBytes = null
    rec.path = null
    rec.batch = null
    this.setStatus(rec, 'queued')
    this.pump()
  }

  async clearFinished(): Promise<void> {
    this.repo.clearFinished()
    for (const [id, r] of this.items) if (FINAL.includes(r.status)) this.items.delete(id)
    this.emitChanged()
  }

  async reveal(id: ID): Promise<void> {
    const rec = this.items.get(id)
    if (rec?.path && this.fileExists(rec.path)) return this.deps.shell.showItemInFolder(rec.path)
    return this.openFolder()
  }

  async openFolder(): Promise<void> {
    const dir = expandHome(this.deps.getSettings().library.downloadDir)
    try {
      this.mkdirp(dir)
    } catch {
      /* the shell will report it */
    }
    const err = await this.deps.shell.openPath(dir)
    if (err) this.notify('error', "Couldn't open the downloads folder", err)
  }

  /** Stop broadcasting; in-flight items resume as 'queued' on the next start. */
  dispose(): void {
    this.disposed = true
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
  }
}
