import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isNetError } from '../net/errors'
import { killTrackedChildren, trackedChildren } from './children'
import { classifyYtDlpError, parseSha256Sums, releaseAssetName, searchDirs, UPDATE_INTERVAL_MS, versionDate, YTDLP_RELEASE_BASE, YtDlp } from './ytdlp'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ghost-ytdlp-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A stand-in yt-dlp: prints its version, "updates", sleeps / fails on request, echoes its args. */
const fakeBinary = (version: string) => `#!/bin/sh
if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi
if [ "$1" = "-U" ]; then echo "Updated yt-dlp to stable@2026.09.01"; touch "$(dirname "$0")/updated"; exit 0; fi
for a in "$@"; do
  if [ "$a" = "--sleep" ]; then sleep 0.3; fi
  if [ "$a" = "--hang" ]; then exec sleep 5; fi
  if [ "$a" = "--fail" ]; then echo "ERROR: [youtube] abcdefghijk: Video unavailable. This video is private" >&2; exit 1; fi
done
for a in "$@"; do printf '%s\\n' "$a"; done
`

const NOW = Date.UTC(2026, 9, 14)
const unix = process.platform !== 'win32'

function releaseFetch(binary: Buffer, opts: { badSum?: boolean } = {}): typeof fetch & { urls: string[] } {
  const asset = releaseAssetName()!
  const sum = createHash('sha256').update(binary).digest('hex')
  const urls: string[] = []
  const f = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    if (url === `${YTDLP_RELEASE_BASE}/SHA2-256SUMS`) {
      const s = opts.badSum ? '0'.repeat(64) : sum
      return new Response(`${'1'.repeat(64)}  yt-dlp.tar.gz\n${s}  ${asset}\n${'2'.repeat(64)}  yt-dlp_x86.exe\n`)
    }
    if (url === `${YTDLP_RELEASE_BASE}/${asset}`) return new Response(binary)
    return new Response('nope', { status: 404 })
  }) as typeof fetch & { urls: string[] }
  f.urls = urls
  return f
}

describe('yt-dlp: helpers', () => {
  it('official release asset per platform', () => {
    expect(releaseAssetName('darwin', 'arm64')).toBe('yt-dlp_macos')
    expect(releaseAssetName('darwin', 'x64')).toBe('yt-dlp_macos')
    expect(releaseAssetName('linux', 'x64')).toBe('yt-dlp_linux')
    expect(releaseAssetName('linux', 'arm64')).toBe('yt-dlp_linux_aarch64')
    expect(releaseAssetName('win32', 'x64')).toBe('yt-dlp.exe')
    expect(releaseAssetName('freebsd', 'x64')).toBeNull()
  })
  it('SHA2-256SUMS, versions, search dirs', () => {
    const m = parseSha256Sums(`${'a'.repeat(64)}  yt-dlp_macos\n${'B'.repeat(64)} *yt-dlp.exe\ngarbage\n`)
    expect(m.get('yt-dlp_macos')).toBe('a'.repeat(64))
    expect(m.get('yt-dlp.exe')).toBe('b'.repeat(64))
    expect(m.size).toBe(2)
    expect(versionDate('2026.08.19')).toBe(Date.UTC(2026, 7, 19))
    expect(versionDate('2026.08.19.232211')).toBe(Date.UTC(2026, 7, 19))
    expect(versionDate('nope')).toBeNull()
    const d = searchDirs({ PATH: '/a:/b:/a' }, 'darwin')
    expect(d.slice(0, 4)).toEqual(['/a', '/b', '/opt/homebrew/bin', '/usr/local/bin'])
  })
  it('classifies failures (sign-in walls are blocked, never worked around)', () => {
    expect(classifyYtDlpError('ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser').code).toBe('blocked')
    expect(classifyYtDlpError('ERROR: [youtube] x: Video unavailable').code).toBe('not_found')
    expect(classifyYtDlpError('ERROR: [youtube] x: Private video. Sign in if you\'ve been granted access').code).toBe('not_found')
    expect(classifyYtDlpError('ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided> (caused by getaddrinfo)').code).toBe('network')
    expect(classifyYtDlpError('ERROR: [youtube] x: Requested format is not available').code).toBe('not_found')
    expect(classifyYtDlpError('ERROR: something odd').message).toMatch(/something odd/)
  })
})

describe.runIf(unix)('yt-dlp: locate / download / update / run', () => {
  it('downloads the official binary, verifies SHA-256, makes it executable', async () => {
    const binDir = join(tmp(), 'bin')
    const bin = Buffer.from(fakeBinary('2026.08.19'))
    const f = releaseFetch(bin)
    const y = new YtDlp({ binDir, fetch: f, systemDirs: [], jsRuntime: null, now: () => NOW, autoUpdate: false })
    const b = await y.ensure()
    expect(b).toEqual({ path: join(binDir, releaseAssetName()!), version: '2026.08.19', managed: true })
    expect(f.urls).toEqual([`${YTDLP_RELEASE_BASE}/SHA2-256SUMS`, `${YTDLP_RELEASE_BASE}/${releaseAssetName()}`])
    expect(statSync(b.path).mode & 0o111).not.toBe(0)
    const state = JSON.parse(readFileSync(join(binDir, 'yt-dlp.json'), 'utf8'))
    expect(state).toMatchObject({ asset: releaseAssetName(), version: '2026.08.19', sha256: createHash('sha256').update(bin).digest('hex') })
    // second instance reuses the managed copy without downloading
    const f2 = releaseFetch(bin)
    await new YtDlp({ binDir, fetch: f2, systemDirs: [], jsRuntime: null, now: () => NOW, autoUpdate: false }).ensure()
    expect(f2.urls).toEqual([])
  })

  it('refuses a binary whose checksum does not match', async () => {
    const binDir = join(tmp(), 'bin')
    const y = new YtDlp({ binDir, fetch: releaseFetch(Buffer.from(fakeBinary('2026.08.19')), { badSum: true }), systemDirs: [], jsRuntime: null, autoUpdate: false })
    await expect(y.ensure()).rejects.toThrow(/checksum mismatch/)
    expect(existsSync(join(binDir, releaseAssetName()!))).toBe(false)
  })

  it('prefers a current system yt-dlp; skips a stale one', async () => {
    const sys = tmp()
    writeFileSync(join(sys, 'yt-dlp'), fakeBinary('2026.09.30'))
    chmodSync(join(sys, 'yt-dlp'), 0o755)
    const f = releaseFetch(Buffer.from(fakeBinary('2026.08.19')))
    const y = new YtDlp({ binDir: join(tmp(), 'bin'), fetch: f, systemDirs: [sys], jsRuntime: null, now: () => NOW, autoUpdate: false })
    expect(await y.ensure()).toEqual({ path: join(sys, 'yt-dlp'), version: '2026.09.30', managed: false })
    expect(f.urls).toEqual([])

    const old = tmp()
    writeFileSync(join(old, 'yt-dlp'), fakeBinary('2023.01.06'))
    chmodSync(join(old, 'yt-dlp'), 0o755)
    const y2 = new YtDlp({ binDir: join(tmp(), 'bin'), fetch: releaseFetch(Buffer.from(fakeBinary('2026.08.19'))), systemDirs: [old], jsRuntime: null, now: () => NOW, autoUpdate: false })
    expect((await y2.ensure()).managed).toBe(true)
  })

  it('runs `yt-dlp -U` for the managed copy at most once a week', async () => {
    const binDir = join(tmp(), 'bin')
    const bin = Buffer.from(fakeBinary('2026.08.19'))
    await new YtDlp({ binDir, fetch: releaseFetch(bin), systemDirs: [], jsRuntime: null, now: () => NOW, autoUpdate: false }).ensure()
    // a week and a bit later
    const later = NOW + UPDATE_INTERVAL_MS + 3600_000
    const y = new YtDlp({ binDir, fetch: releaseFetch(bin), systemDirs: [], jsRuntime: null, now: () => later })
    await y.ensure()
    for (let i = 0; i < 100 && !existsSync(join(binDir, 'updated')); i++) await new Promise((r) => setTimeout(r, 20))
    expect(existsSync(join(binDir, 'updated'))).toBe(true)
    await new Promise((r) => setTimeout(r, 100))
    expect(JSON.parse(readFileSync(join(binDir, 'yt-dlp.json'), 'utf8')).updateCheckedAt).toBe(later)
    // not again within the week
    rmSync(join(binDir, 'updated'))
    await new YtDlp({ binDir, fetch: releaseFetch(bin), systemDirs: [], jsRuntime: null, now: () => later + 1000 }).ensure()
    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(join(binDir, 'updated'))).toBe(false)
  })

  it('passes args without a shell, ignores user config, queues ≤2 at a time, times out, classifies errors', async () => {
    const sys = tmp()
    writeFileSync(join(sys, 'yt-dlp'), fakeBinary('2026.09.30'))
    chmodSync(join(sys, 'yt-dlp'), 0o755)
    const y = new YtDlp({ binDir: join(tmp(), 'bin'), systemDirs: [sys], jsRuntime: { name: 'node', path: process.execPath }, now: () => NOW, autoUpdate: false })
    const evil = 'ytsearch10:Zelda"; rm -rf ~; echo $(whoami) `id`'
    const r = await y.run(['--flat-playlist', '-J', evil])
    const args = r.stdout.trim().split('\n')
    expect(args.slice(0, 4)).toEqual(['--ignore-config', '--no-warnings', '--no-progress', '--cache-dir'])
    expect(args).toContain('--js-runtimes')
    expect(args).toContain(`node:${process.execPath}`)
    expect(args.at(-1)).toBe(evil)

    const t0 = Date.now()
    await Promise.all([1, 2, 3, 4].map(() => y.run(['--sleep'])))
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550) // 4 × 300 ms, two at a time

    await expect(y.run(['--hang'], { timeoutMs: 200 })).rejects.toSatisfy((e: unknown) => isNetError(e, 'timeout'))
    await expect(y.run(['--fail'])).rejects.toSatisfy((e: unknown) => isNetError(e, 'not_found'))
    const tolerated = await y.run(['--fail'], { allowFailure: true })
    expect(tolerated.code).toBe(1)
    expect(tolerated.stderr).toMatch(/Video unavailable/)
  })

  it('registers each run so quitting can end it, and forgets it once it exits', async () => {
    const sys = tmp()
    writeFileSync(join(sys, 'yt-dlp'), fakeBinary('2026.09.30'))
    chmodSync(join(sys, 'yt-dlp'), 0o755)
    const y = new YtDlp({ binDir: join(tmp(), 'bin'), systemDirs: [sys], jsRuntime: null, now: () => NOW, autoUpdate: false })
    await y.ensure()
    const before = trackedChildren().length
    const run = y.run(['--hang'], { timeoutMs: 10_000 }).catch((e) => e)
    for (let i = 0; i < 100 && trackedChildren().length === before; i++) await new Promise((r) => setTimeout(r, 10))
    expect(trackedChildren().length).toBe(before + 1)
    killTrackedChildren() // what the main thread does on quit
    expect(isNetError(await run)).toBe(true) // the run fails instead of hanging on
    for (let i = 0; i < 50 && trackedChildren().length > before; i++) await new Promise((r) => setTimeout(r, 10))
    expect(trackedChildren().length).toBe(before)
  })

  it('a missing binary dir is created on download', async () => {
    const root = tmp()
    mkdirSync(join(root, 'deep'), { recursive: true })
    const y = new YtDlp({ binDir: join(root, 'deep', 'er', 'bin'), fetch: releaseFetch(Buffer.from(fakeBinary('2026.08.19'))), systemDirs: [], jsRuntime: null, autoUpdate: false })
    expect((await y.ensure()).managed).toBe(true)
  })
})
