// yt-dlp management: find it, or fetch the OFFICIAL standalone release binary, keep it updated,
// and run it through a small queue.
//
//  - Lookup order: PATH, then /opt/homebrew/bin, /usr/local/bin, ~/.local/bin (apps launched from
//    Finder don't inherit the shell PATH), then our managed copy in <userData>/bin.
//    A system copy older than STALE_SYSTEM_DAYS is skipped in favour of the managed one, because an
//    old yt-dlp can't talk to YouTube.
//  - Download: https://github.com/yt-dlp/yt-dlp/releases/latest/download/<asset>, verified against
//    the same release's SHA2-256SUMS, written atomically, chmod +x. Nothing else is ever downloaded.
//  - Updates: `yt-dlp -U` (which verifies the release itself) at most once per 7 days, managed copy only.
//  - Invocations: execFile with an args array (never a shell), ≤2 concurrent, with timeouts.
//    `--ignore-config` keeps a user's yt-dlp config (cookies-from-browser, proxies…) out of it.
//  - JS challenges: YouTube needs a JS runtime for its player challenges. We pass one we can find
//    (deno/node on disk, else Electron's own binary in ELECTRON_RUN_AS_NODE mode). No PO tokens, no
//    cookies: a video that needs sign-in is reported as `blocked` and skipped.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as FS, existsSync } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { NetError } from '../net/errors'
import { GHOST_USER_AGENT } from '../net/http'
import { HostLimiter, type Priority } from '../net/limiter'

export const YTDLP_RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
export const UPDATE_INTERVAL_MS = 7 * 24 * 3600_000
export const STALE_SYSTEM_DAYS = 150
const DEFAULT_TIMEOUT_MS = 60_000

/** Official standalone release asset for a platform (null = unsupported). */
export function releaseAssetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === 'darwin') return 'yt-dlp_macos'
  if (platform === 'linux') return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : arch === 'x64' ? 'yt-dlp_linux' : null
  if (platform === 'win32') return 'yt-dlp.exe'
  return null
}

/** Parse a SHA2-256SUMS file ("<hex>  <name>" per line). */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim())
    if (m) out.set(m[2], m[1].toLowerCase())
  }
  return out
}

/** "2026.08.19" (optionally ".123456" nightly suffix) → epoch ms, or null. */
export function versionDate(v: string | null | undefined): number | null {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(v?.trim() ?? '')
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

/** Directories to look in for system binaries: PATH plus the usual places Finder-launched apps miss. */
export function searchDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  if (platform !== 'win32') dirs.push('/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), '/usr/bin')
  return [...new Set(dirs)]
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    if (!s.isFile()) return false
    await access(p, FS.X_OK)
    return true
  } catch {
    return false
  }
}

/** Classify a failed yt-dlp run into a NetError (the resolver treats `blocked`/`not_found` as "skip"). */
export function classifyYtDlpError(stderr: string, fallback = 'yt-dlp failed'): NetError {
  const lines = stderr.split(/\r?\n/).filter((l) => /^ERROR:/.test(l))
  const msg = (lines.at(-1) ?? stderr.trim().split(/\r?\n/).at(-1) ?? fallback).replace(/^ERROR:\s*/, '').slice(0, 300) || fallback
  if (/sign in to confirm|not a bot|po[\s_-]?token|login_required|use --cookies|cookies-from-browser|account.*(?:required|terminated)/i.test(stderr)) {
    return new NetError('blocked', `The site wants a signed-in session for this upload, which GHOST doesn't do: ${msg}`)
  }
  if (/private video|video unavailable|has been removed|is not available|no longer available|members[- ]only|not available in your country|copyright|premieres in|live event will begin|does not exist|404: not found|playlist does not exist|this channel does not/i.test(stderr)) {
    return new NetError('not_found', msg)
  }
  if (/http error 429|too many requests/i.test(stderr)) return new NetError('http', msg, { status: 429 })
  if (/requested format is not available/i.test(stderr)) return new NetError('not_found', msg)
  if (/timed out|connection (?:reset|refused|aborted)|getaddrinfo|network is unreachable|temporary failure in name resolution|unable to download (?:webpage|api)/i.test(stderr)) {
    return new NetError('network', msg)
  }
  return new NetError('http', msg)
}

export interface YtDlpBinary {
  path: string
  version: string
  /** Downloaded by us (we keep it updated) vs found on the system. */
  managed: boolean
}

export interface JsRuntime {
  name: 'deno' | 'node' | 'bun'
  path: string
  env?: Record<string, string>
}

/** A JS runtime yt-dlp can use for YouTube's player challenges, if we can find one. */
export async function findJsRuntime(dirs: string[] = searchDirs()): Promise<JsRuntime | null> {
  const exe = process.platform === 'win32' ? '.exe' : ''
  for (const name of ['deno', 'node', 'bun'] as const) {
    for (const d of dirs) {
      const p = join(d, name + exe)
      if (await isExecutable(p)) return { name, path: p }
    }
  }
  // Electron's own binary is a Node runtime when ELECTRON_RUN_AS_NODE is set (needs the RunAsNode fuse).
  if (process.versions.electron) return { name: 'node', path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  return null
}

export interface YtDlpOptions {
  /** Where the managed binary + its state file live (<userData>/bin). */
  binDir: string
  /** yt-dlp's own cache (player JS etc.). Default <binDir>/cache. */
  cacheDir?: string
  fetch?: typeof fetch
  now?: () => number
  log?: (msg: string) => void
  platform?: NodeJS.Platform
  arch?: string
  /** Override system lookup dirs (tests). [] disables system lookup. */
  systemDirs?: string[]
  maxConcurrent?: number
  /** JS runtime for YouTube challenges: undefined = auto-detect, null = none. */
  jsRuntime?: JsRuntime | null
  /** Disable the weekly self-update (tests). */
  autoUpdate?: boolean
}

export interface RunOptions {
  timeoutMs?: number
  signal?: AbortSignal
  priority?: Priority
  /** Resolve with stdout/stderr even when yt-dlp exits non-zero (e.g. --ignore-errors batches). */
  allowFailure?: boolean
}

export interface RunResult {
  stdout: string
  stderr: string
  /** Exit code (0 unless allowFailure let a failure through). */
  code: number
}

interface ManagedState {
  asset: string
  sha256: string
  version: string | null
  downloadedAt: number
  updateCheckedAt: number
}

export class YtDlp {
  private readonly queue: HostLimiter
  private located: Promise<YtDlpBinary> | null = null
  private runtime: Promise<JsRuntime | null> | null = null
  private updating: Promise<void> | null = null
  private readonly now: () => number
  private readonly log: (msg: string) => void
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: YtDlpOptions) {
    this.queue = new HostLimiter({ concurrency: opts.maxConcurrent ?? 2, spacingMs: 0 })
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
    this.fetchImpl = opts.fetch ?? fetch
  }

  get platform(): NodeJS.Platform {
    return this.opts.platform ?? process.platform
  }

  private get stateFile(): string {
    return join(this.opts.binDir, 'yt-dlp.json')
  }

  managedPath(): string | null {
    const asset = releaseAssetName(this.platform, this.opts.arch ?? process.arch)
    return asset ? join(this.opts.binDir, asset) : null
  }

  /** Locate (or download) yt-dlp once; later calls share the result. A failure is retried next call. */
  ensure(): Promise<YtDlpBinary> {
    if (!this.located) {
      this.located = this.locate().catch((e) => {
        this.located = null
        throw e
      })
    }
    return this.located
  }

  private async version(path: string): Promise<string | null> {
    try {
      const { stdout } = await this.exec(path, ['--version'], { timeoutMs: 30_000 }, {})
      const v = stdout.trim().split(/\s+/)[0]
      return versionDate(v) != null ? v : null
    } catch (e) {
      this.log(`yt-dlp at ${path} did not run: ${(e as Error).message}`)
      return null
    }
  }

  private async locate(): Promise<YtDlpBinary> {
    const exe = this.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
    const managed = this.managedPath()
    for (const dir of this.opts.systemDirs ?? searchDirs(process.env, this.platform)) {
      const p = join(dir, exe)
      if (p === managed || !(await isExecutable(p))) continue
      const v = await this.version(p)
      if (!v) continue
      const age = this.now() - (versionDate(v) ?? 0)
      if (age > STALE_SYSTEM_DAYS * 24 * 3600_000) {
        this.log(`system yt-dlp ${v} at ${p} is too old; using a managed copy instead`)
        break
      }
      this.log(`using system yt-dlp ${v} at ${p}`)
      return { path: p, version: v, managed: false }
    }
    if (!managed) throw new Error(`yt-dlp has no standalone build for ${this.platform}/${this.opts.arch ?? process.arch}; install it and put it on PATH`)
    if (await isExecutable(managed)) {
      const v = await this.version(managed)
      if (v) {
        this.maybeUpdate(managed)
        return { path: managed, version: v, managed: true }
      }
      this.log('managed yt-dlp is broken; downloading it again')
    }
    await this.download()
    const v = await this.version(managed)
    if (!v) throw new Error('downloaded yt-dlp does not run')
    await this.writeState({ ...(await this.readState())!, version: v })
    return { path: managed, version: v, managed: true }
  }

  private async readState(): Promise<ManagedState | null> {
    try {
      return JSON.parse(await readFile(this.stateFile, 'utf8')) as ManagedState
    } catch {
      return null
    }
  }

  private async writeState(s: ManagedState): Promise<void> {
    await mkdir(this.opts.binDir, { recursive: true })
    await writeFile(this.stateFile, JSON.stringify(s, null, 2))
  }

  private async get(url: string, timeoutMs: number): Promise<Response> {
    const res = await this.fetchImpl(url, { headers: { 'User-Agent': GHOST_USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new NetError('http', `HTTP ${res.status} from ${url}`, { status: res.status, url })
    return res
  }

  /** Download the official release binary for this platform and verify its SHA-256. */
  async download(): Promise<string> {
    const asset = releaseAssetName(this.platform, this.opts.arch ?? process.arch)
    if (!asset) throw new Error(`no yt-dlp release asset for ${this.platform}`)
    const dest = join(this.opts.binDir, asset)
    this.log(`downloading yt-dlp (${asset}) from the official GitHub release`)
    const sums = parseSha256Sums(await (await this.get(`${YTDLP_RELEASE_BASE}/SHA2-256SUMS`, 30_000)).text())
    const expected = sums.get(asset)
    if (!expected) throw new Error(`SHA2-256SUMS has no entry for ${asset}`)
    const bytes = Buffer.from(await (await this.get(`${YTDLP_RELEASE_BASE}/${asset}`, 300_000)).arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) throw new Error(`yt-dlp checksum mismatch for ${asset}: expected ${expected}, got ${actual}`)
    await mkdir(this.opts.binDir, { recursive: true })
    const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.download`
    try {
      await writeFile(tmp, bytes, { mode: 0o755 })
      await chmod(tmp, 0o755)
      await rename(tmp, dest)
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
    const now = this.now()
    await this.writeState({ asset, sha256: actual, version: null, downloadedAt: now, updateCheckedAt: now })
    this.log(`yt-dlp downloaded and verified (${(bytes.length / 1048576).toFixed(1)} MB, sha256 ${actual.slice(0, 12)}…)`)
    return dest
  }

  /** `yt-dlp -U` for the managed copy, at most once per UPDATE_INTERVAL_MS. Runs in the background. */
  private maybeUpdate(path: string): void {
    if (this.opts.autoUpdate === false || this.updating) return
    this.updating = (async () => {
      const st = await this.readState()
      if (st && this.now() - st.updateCheckedAt < UPDATE_INTERVAL_MS) return
      const base: ManagedState = st ?? { asset: releaseAssetName(this.platform, this.opts.arch ?? process.arch) ?? '', sha256: '', version: null, downloadedAt: 0, updateCheckedAt: 0 }
      // Record the attempt first so a failing update doesn't retry on every launch.
      await this.writeState({ ...base, updateCheckedAt: this.now() })
      try {
        const r = await this.queue.schedule(() => this.exec(path, ['-U'], { timeoutMs: 300_000 }, {}), 2)
        const line = r.stdout.trim().split(/\r?\n/).at(-1) ?? ''
        this.log(`yt-dlp -U: ${line}`)
        const v = await this.version(path)
        await this.writeState({ ...base, version: v, updateCheckedAt: this.now() })
        if (v && this.located) this.located = Promise.resolve({ path, version: v, managed: true })
      } catch (e) {
        this.log(`yt-dlp self-update failed: ${(e as Error).message}`)
      }
    })().finally(() => {
      this.updating = null
    })
  }

  private jsRuntime(): Promise<JsRuntime | null> {
    if (this.opts.jsRuntime !== undefined) return Promise.resolve(this.opts.jsRuntime)
    return (this.runtime ??= findJsRuntime(this.opts.systemDirs ?? searchDirs(process.env, this.platform)).catch(() => null))
  }

  private exec(file: string, args: string[], opts: RunOptions, extraEnv: Record<string, string>): Promise<RunResult> {
    const dirs = searchDirs(process.env, this.platform)
    const env = { ...process.env, PATH: dirs.join(this.platform === 'win32' ? ';' : delimiter), PYTHONIOENCODING: 'utf-8', ...extraEnv }
    return new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024, env, signal: opts.signal, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) return resolve({ stdout, stderr, code: 0 })
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: unknown }
          if (opts.signal?.aborted || e.name === 'AbortError') return reject(new NetError('aborted', 'yt-dlp aborted'))
          if (e.killed || e.signal === 'SIGKILL') return reject(new NetError('timeout', `yt-dlp timed out after ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s`))
          if (e.code === 'ENOENT' || e.code === 'EACCES') return reject(new Error(`cannot run yt-dlp at ${file}: ${e.message}`))
          if (opts.allowFailure && typeof e.code === 'number') return resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: e.code })
          reject(classifyYtDlpError(String(stderr ?? ''), e.message))
        }
      )
    })
  }

  /** Run yt-dlp with these args (queued, ≤2 concurrent). */
  async run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const bin = await this.ensure()
    const rt = await this.jsRuntime()
    const base = ['--ignore-config', '--no-warnings', '--no-progress', '--cache-dir', this.opts.cacheDir ?? join(this.opts.binDir, 'cache')]
    if (rt && existsSync(rt.path)) base.push('--js-runtimes', `${rt.name}:${rt.path}`)
    return this.queue.schedule(() => this.exec(bin.path, [...base, ...args], opts, rt?.env ?? {}), opts.priority ?? 1, opts.signal)
  }

  /** Run and parse the JSON yt-dlp prints for -J. */
  async json<T>(args: string[], opts: RunOptions = {}): Promise<T> {
    const { stdout } = await this.run(args, opts)
    try {
      return JSON.parse(stdout) as T
    } catch {
      throw new NetError('parse', `yt-dlp printed something that isn't JSON (${stdout.slice(0, 80)}…)`)
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide instance

let shared: YtDlp | null = null

export async function sharedYtDlp(): Promise<YtDlp> {
  if (!shared) {
    const { dataDir } = await import('../paths')
    shared = new YtDlp({ binDir: dataDir('bin'), log: (m) => console.log(`[yt-dlp] ${m}`) })
  }
  return shared
}

/** Replace the shared instance (tests, smoke scripts). */
export function setSharedYtDlp(y: YtDlp | null): void {
  shared = y
}
