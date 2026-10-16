// GHOST's own updates. Checks GitHub at launch (when a day has passed since the last check) and
// every 24 hours after, by the wall clock (a Mac that sleeps overnight doesn't push it back).
//  - Auto updates on (the default): a newer release downloads at once ("Updating GHOST to 0.4.1"),
//    is checked against its SHA-256 and made ready; it installs when GHOST quits, or right away
//    from "Restart to update".
//  - Off: the user is asked first (the renderer's prompt: update now, or not now for this version).
//  - An install that can't update itself (a .deb, a read-only folder) hears that a release is out
//    and gets a link to it.
// After an update, the bundled changelog's sections since the version last run are shown once.

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import type { GhostNotification, UpdateRelease, UpdateState, UpdateStatus, WhatsNew } from '../../shared/types'
import { formatBytesOf } from '../player/progress'
import { parseChangelog, whatsNewSince } from './changelog'
import { assetFor, fetchLatestRelease, type Release, type ReleaseAsset } from './feed'
import type { InstallTarget } from './install'
import { compareVersions } from './version'

export const CHECK_EVERY_MS = 24 * 3600_000
/** The first check waits this long after launch (startup has enough to do). */
export const STARTUP_DELAY_MS = 20_000
/** How often the clock is read to see whether a check is due. */
const TICK_MS = 30 * 60_000
/** A download that failed is tried again after this long (not at every tick: it's 130 MB). */
const RETRY_AFTER_MS = 2 * 3600_000
/** No bytes for this long: the download is given up (and tried again later). */
const STALL_MS = 60_000

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface UpdaterDeps {
  current: string
  platform: NodeJS.Platform
  arch: string
  target: InstallTarget
  /** GitHub's latest-release API (GHOST_UPDATE_FEED points tests at a local one). */
  feedUrl: string
  /** Only installers from these hosts are downloaded (GitHub's). Null: any (a test feed). */
  downloadHosts: RegExp | null
  userAgent: string
  fetch: Fetch
  /** <userData>/updates: downloads, the staged app, state.json. */
  dir: string
  /** settings.updates.auto */
  getAuto: () => boolean
  onState: (s: UpdateState) => void
  notify: (n: GhostNotification) => void
  /** Make a downloaded installer ready (install.ts prepareInstall, bound to the target). */
  prepare: (file: string, version: string) => Promise<string>
  /** Start installing (install.ts launchInstall, synchronous); `reopen` after a restart. */
  launch: (prepared: string, reopen: boolean) => void
  /** Quit GHOST (the installer takes over). */
  quit: () => void
  readChangelog: () => Promise<string>
  /** This profile existed before this launch (an update, not a first run). */
  existingProfile: boolean
  now?: () => number
  log?: (msg: string) => void
}

interface Saved {
  lastCheckedAt: number | null
  /** The next check isn't before this (after a failed download). */
  retryAt: number | null
  /** The version the user said "Not now" to. */
  dismissed: string | null
  /** The version whose release notes were last shown (or that was first run). */
  lastSeenVersion: string | null
  /** Downloaded, checked and prepared, waiting to be installed. */
  pending: { release: UpdateRelease; prepared: string; file: string } | null
}

const EMPTY: Saved = { lastCheckedAt: null, retryAt: null, dismissed: null, lastSeenVersion: null, pending: null }

export class Updater {
  private saved: Saved = { ...EMPTY }
  private status: UpdateStatus = 'idle'
  private latest: { release: UpdateRelease; asset: ReleaseAsset | null } | null = null
  private progress: { bytes: number; totalBytes: number | null } | null = null
  private error: string | null = null
  private busy: Promise<void> | null = null
  private checking: Promise<UpdateState> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private tick: ReturnType<typeof setInterval> | null = null
  private announced = new Set<string>()
  private launched = false
  private stopped = false
  private readonly now: () => number
  private readonly stateFile: string

  constructor(private readonly d: UpdaterDeps) {
    this.now = d.now ?? Date.now
    this.stateFile = join(d.dir, 'state.json')
  }

  private get canInstall(): boolean {
    return this.d.target.kind !== 'none' && this.d.target.kind !== 'deb' && !this.d.target.manualReason
  }

  /** Load what was saved, pick up a downloaded release, and (`schedule`) start the 24-hour checks. */
  async start(schedule = true): Promise<void> {
    await mkdir(this.d.dir, { recursive: true })
    try {
      this.saved = { ...EMPTY, ...(JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<Saved>) }
    } catch {
      this.saved = { ...EMPTY }
    }
    const p = this.saved.pending
    if (p && compareVersions(p.release.version, this.d.current) > 0 && existsSync(p.prepared) && this.canInstall) {
      this.latest = { release: p.release, asset: null }
      this.status = 'ready'
    } else {
      // Installed (or stale): its files go.
      this.saved.pending = null
      await this.clearDownloads()
    }
    await this.save()
    this.emit()
    if (!schedule) return
    const due = Math.max(STARTUP_DELAY_MS, this.nextCheckAt() - this.now())
    this.timer = setTimeout(() => void this.checkIfDue(), due)
    this.tick = setInterval(() => void this.checkIfDue(), TICK_MS)
    this.timer.unref?.()
    this.tick.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.tick) clearInterval(this.tick)
  }

  state(): UpdateState {
    const r = this.latest?.release ?? null
    // A release found (not one already downloaded) needs an installer for this system, with a checksum.
    const verifiable = !r || this.status === 'ready' || !!this.latest?.asset?.sha256
    return {
      current: this.d.current,
      status: this.status,
      latest: r,
      progress: this.progress,
      error: this.error,
      lastCheckedAt: this.saved.lastCheckedAt,
      canInstall: this.canInstall && verifiable,
      manualReason: !this.canInstall ? this.d.target.manualReason : verifiable ? null : this.noInstallerReason(),
      dismissed: !!r && this.saved.dismissed === r.version
    }
  }

  private noInstallerReason(): string {
    const a = this.latest?.asset
    if (!a) return `This release has no installer for this system.`
    return 'This release’s installer has no checksum, so GHOST won’t install it by itself.'
  }

  private nextCheckAt(): number {
    const last = this.saved.lastCheckedAt ?? 0
    return Math.max(last + CHECK_EVERY_MS, this.saved.retryAt ?? 0)
  }

  private async checkIfDue(): Promise<void> {
    if (this.stopped || this.now() < this.nextCheckAt()) return
    await this.check().catch(() => {})
  }

  /** Ask GitHub for the newest release now; with auto updates on, a newer one starts downloading. */
  check(): Promise<UpdateState> {
    if (this.busy) return this.busy.then(() => this.state(), () => this.state())
    this.checking ??= this.doCheck().finally(() => (this.checking = null))
    return this.checking
  }

  private async doCheck(): Promise<UpdateState> {
    const before = this.status
    this.set('checking')
    this.error = null
    let release: Release | null
    try {
      release = await fetchLatestRelease(this.d.fetch, this.d.feedUrl, this.d.userAgent)
    } catch (e) {
      this.error = `Couldn’t check for updates: ${(e as Error).message}`
      this.saved.retryAt = this.now() + RETRY_AFTER_MS
      await this.save()
      // A release already found stays on offer (the error says the re-check failed).
      this.set(before === 'ready' || before === 'available' ? before : 'error')
      throw e
    }
    this.saved.lastCheckedAt = this.now()
    this.saved.retryAt = null
    await this.save()
    if (!release || compareVersions(release.version, this.d.current) <= 0) {
      this.latest = null
      this.set('idle')
      return this.state()
    }
    const pending = this.saved.pending
    if (pending && compareVersions(pending.release.version, release.version) >= 0) {
      this.set('ready')
      return this.state()
    }
    const asset = assetFor(release, this.d.platform, this.d.arch, this.d.target.kind)
    this.latest = { release: { version: release.version, notes: release.notes, url: release.url, publishedAt: release.publishedAt, sizeBytes: asset?.size ?? null }, asset }
    const installable = this.canInstall && !!asset?.sha256
    if (installable && this.d.getAuto()) {
      // Straight to "Updating GHOST to …" (never "available", which asks).
      void this.download().catch(() => {})
      return this.state()
    }
    this.set('available')
    this.announceAvailable()
    return this.state()
  }

  private announceAvailable(): void {
    const r = this.latest?.release
    if (!r || this.saved.dismissed === r.version || this.announced.has(`available:${r.version}`)) return
    this.announced.add(`available:${r.version}`)
    const s = this.state()
    const body = s.canInstall ? `You have ${this.d.current}. Update now, or dismiss it, from the top bar or Settings → About.` : `You have ${this.d.current}. ${s.manualReason ?? ''} Get it from the release page (Settings → About).`.trim()
    this.d.notify({ id: `update-${r.version}`, kind: 'info', title: `GHOST ${r.version} is available`, body })
  }

  /** Download, check and prepare the newest release (ready to install afterwards). */
  download(): Promise<void> {
    if (this.busy) return this.busy
    if (this.status === 'ready') return Promise.resolve()
    const latest = this.latest
    if (!latest) return Promise.reject(new Error('There is no newer version to download.'))
    const { release, asset } = latest
    if (!this.canInstall || !asset) return Promise.reject(new Error(this.state().manualReason ?? 'GHOST can’t install updates here.'))
    const sha256 = asset.sha256
    if (!sha256) return Promise.reject(new Error(this.noInstallerReason()))
    this.busy = this.doDownload(release, { ...asset, sha256 }).finally(() => (this.busy = null))
    return this.busy
  }

  private async doDownload(release: UpdateRelease, asset: ReleaseAsset & { sha256: string }): Promise<void> {
    const v = release.version
    const id = `update-${v}`
    this.error = null
    this.progress = { bytes: 0, totalBytes: asset.size }
    this.set('downloading')
    let lastNote = 0
    const note = (force = false) => {
      const t = this.now()
      if (!force && t - lastNote < 250) return
      lastNote = t
      const p = this.progress
      const total = p?.totalBytes ?? null
      this.d.notify({ id, kind: 'progress', title: `Updating GHOST to ${v}`, body: total ? `Downloading · ${formatBytesOf(p!.bytes, total)}` : 'Downloading…', progress: total ? Math.min(0.99, p!.bytes / total) : 0 })
      this.emit()
    }
    note(true)
    try {
      await this.clearDownloads()
      const file = join(this.d.dir, asset.name)
      await this.fetchVerified(asset, file, (bytes, total) => {
        this.progress = { bytes, totalBytes: total }
        note()
      })
      this.d.notify({ id, kind: 'progress', title: `Updating GHOST to ${v}`, body: 'Getting it ready to install…', progress: 0.99 })
      const prepared = await this.d.prepare(file, v)
      this.saved.pending = { release, prepared, file }
      this.saved.retryAt = null
      await this.save()
      this.progress = null
      this.set('ready')
      this.d.notify({
        id,
        kind: 'success',
        title: `GHOST ${v} is ready to install`,
        body: `It installs when you quit GHOST (you have ${this.d.current}). To install it now, choose “Restart to update” in the top bar.`
      })
    } catch (e) {
      const msg = (e as Error).message
      this.progress = null
      this.error = `Couldn’t download GHOST ${v}: ${msg}`
      this.saved.retryAt = this.now() + RETRY_AFTER_MS
      await this.save()
      this.set('error')
      this.d.notify({ id, kind: 'error', title: `Couldn’t update GHOST to ${v}`, body: `${msg}. GHOST will try again later.` })
      this.d.log?.(`[updates] download of ${v} failed: ${msg}`)
      throw e
    }
  }

  /** Stream `asset` to `file`, hashing as it arrives; only a file matching its SHA-256 is kept. */
  private async fetchVerified(asset: ReleaseAsset & { sha256: string }, file: string, onProgress: (bytes: number, total: number | null) => void): Promise<void> {
    if (!/^https?:/.test(asset.url) || (this.d.downloadHosts && !(asset.url.startsWith('https://') && this.d.downloadHosts.test(new URL(asset.url).hostname))))
      throw new Error(`refusing to download from ${asset.url}`)
    const ac = new AbortController()
    let stall = setTimeout(() => ac.abort(), STALL_MS)
    const part = `${file}.part`
    try {
      const res = await this.d.fetch(asset.url, { headers: { 'User-Agent': this.d.userAgent }, redirect: 'follow', signal: ac.signal })
      if (!res.ok || !res.body) throw new Error(`the download answered HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || asset.size
      const hash = createHash('sha256')
      const out = createWriteStream(part)
      let bytes = 0
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          clearTimeout(stall)
          stall = setTimeout(() => ac.abort(), STALL_MS)
          hash.update(chunk)
          bytes += chunk.length
          if (!out.write(chunk)) await once(out, 'drain')
          onProgress(bytes, total)
        }
      } finally {
        out.end()
        await once(out, 'close')
      }
      if (hash.digest('hex') !== asset.sha256) throw new Error('the download doesn’t match its checksum')
      await rename(part, file)
    } catch (e) {
      await rm(part, { force: true })
      if (ac.signal.aborted) throw new Error('the download stalled')
      throw e
    } finally {
      clearTimeout(stall)
    }
  }

  /** Install the newest release now and restart (downloading it first when needed). */
  async installNow(): Promise<void> {
    if (this.status !== 'ready') {
      if (!this.latest) await this.check()
      // (check() may have found it downloaded already)
      if (this.state().status !== 'ready') await this.download()
    }
    const p = this.saved.pending
    if (!p) throw new Error('There is no update ready to install.')
    this.d.notify({ id: `update-${p.release.version}`, kind: 'progress', title: `Updating GHOST to ${p.release.version}`, body: 'Installing: GHOST restarts in a moment.', progress: 1 })
    this.launched = true
    this.d.launch(p.prepared, true)
    this.d.quit()
  }

  /**
   * GHOST is quitting: with auto updates on, a release waiting to be installed goes in now (without
   * reopening). Off, it waits for "Restart to update". Synchronous.
   */
  onQuit(): void {
    this.stop()
    const p = this.saved.pending
    if (this.launched || this.status !== 'ready' || !p || !this.d.getAuto()) return
    this.launched = true
    try {
      this.d.launch(p.prepared, false)
    } catch (e) {
      this.d.log?.(`[updates] install on quit failed: ${(e as Error).message}`)
    }
  }

  async dismiss(): Promise<void> {
    const r = this.latest?.release
    if (!r) return
    this.saved.dismissed = r.version
    await this.save()
    this.emit()
  }

  /** Auto updates turned on while a release waits: it starts downloading. */
  onAutoChanged(auto: boolean): void {
    if (auto && this.status === 'available' && this.state().canInstall) void this.download().catch(() => {})
    else this.emit()
  }

  async whatsNew(): Promise<WhatsNew | null> {
    const from = this.saved.lastSeenVersion
    if (!from && !this.d.existingProfile) {
      // A first run: nothing changed for this user.
      await this.whatsNewSeen()
      return null
    }
    if (from && compareVersions(this.d.current, from) <= 0) return null
    try {
      return whatsNewSince(parseChangelog(await this.d.readChangelog()), this.d.current, from)
    } catch (e) {
      this.d.log?.(`[updates] changelog: ${(e as Error).message}`)
      return null
    }
  }

  async whatsNewSeen(): Promise<void> {
    if (this.saved.lastSeenVersion === this.d.current) return
    this.saved.lastSeenVersion = this.d.current
    await this.save()
  }

  private set(status: UpdateStatus): void {
    this.status = status
    this.emit()
  }

  private emit(): void {
    this.d.onState(this.state())
  }

  private async save(): Promise<void> {
    const tmp = `${this.stateFile}.tmp`
    await writeFile(tmp, JSON.stringify(this.saved, null, 2))
    await rename(tmp, this.stateFile)
  }

  /** Downloads and staged apps other than the pending one's. */
  private async clearDownloads(): Promise<void> {
    const keep = new Set([this.saved.pending?.file, this.saved.pending?.prepared].filter(Boolean).map(String))
    let names: string[] = []
    try {
      names = await readdir(this.d.dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(this.d.dir, n)
      if (n === 'state.json' || keep.has(p)) continue
      await rm(p, { recursive: true, force: true }).catch(() => {})
    }
  }
}
