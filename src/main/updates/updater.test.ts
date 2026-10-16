import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { GhostNotification, UpdateState } from '../../shared/types'
import type { InstallTarget } from './install'
import { CHECK_EVERY_MS, STARTUP_DELAY_MS, Updater, type UpdaterDeps } from './updater'

// state.json writes, watched: how many are in progress at once, and a gate that holds them.
const stateWrites = vi.hoisted(() => ({ active: 0, peak: 0, gate: null as Promise<void> | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const isTmp = (p: unknown) => String(p).endsWith('state.json.tmp')
  return {
    ...fs,
    writeFile: async (...a: Parameters<typeof fs.writeFile>) => {
      if (!isTmp(a[0])) return fs.writeFile(...a)
      stateWrites.active++
      stateWrites.peak = Math.max(stateWrites.peak, stateWrites.active)
      try {
        await stateWrites.gate
        return await fs.writeFile(...a)
      } catch (e) {
        stateWrites.active--
        throw e
      }
    },
    rename: async (...a: Parameters<typeof fs.rename>) => {
      if (!isTmp(a[0])) return fs.rename(...a)
      try {
        return await fs.rename(...a)
      } finally {
        stateWrites.active--
      }
    }
  }
})

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
afterEach(() => vi.useRealTimers())

const BYTES = new Uint8Array(300_000).map((_, i) => i % 251)
const SHA = createHash('sha256').update(BYTES).digest('hex')
const MAC: InstallTarget = { kind: 'mac-app', path: '/Applications/GHOST.app', manualReason: null }

function release(version: string, sha = SHA) {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/nameless525/ghost/releases/tag/v${version}`,
    published_at: '2026-10-20T10:00:00Z',
    body: `### New\n- Things in ${version}.\n\n---\n\n**Install:** below.`,
    assets: [{ name: `GHOST-${version}-mac-arm64.dmg`, size: BYTES.length, browser_download_url: `https://github.com/dl/${version}.dmg`, digest: `sha256:${sha}` }]
  }
}

const CHANGELOG = `# Changelog\n\n## 0.5.0 (2026-10-20)\n- Five.\n\n## 0.4.1 (2026-10-18)\n- Four one.\n\n## 0.4.0 (2026-10-15)\n- Four.\n`

function setup(
  o: {
    latest?: () => object | null | Promise<object | null>
    /** The installer download's response (default: BYTES). */
    installer?: (url: string) => Response | Promise<Response>
    prepare?: UpdaterDeps['prepare']
    verify?: UpdaterDeps['verify']
    auto?: boolean
    target?: InstallTarget
    dir?: string
    existingProfile?: boolean
    current?: string
    now?: () => number
  } = {}
) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'ghost-updater-'))
  if (!o.dir) dirs.push(dir)
  const states: UpdateState[] = []
  const notes: GhostNotification[] = []
  const launched: [string, boolean][] = []
  const fetched: string[] = []
  const logs: string[] = []
  let quits = 0
  let auto = o.auto ?? true
  const latest = o.latest ?? (() => release('0.5.0'))
  const deps: UpdaterDeps = {
    current: o.current ?? '0.4.0',
    platform: 'darwin',
    arch: 'arm64',
    target: o.target ?? MAC,
    feedUrl: 'https://api.github.com/repos/nameless525/ghost/releases/latest',
    downloadHosts: /(^|\.)(github\.com|githubusercontent\.com)$/,
    userAgent: 'test',
    fetch: async (url) => {
      fetched.push(url)
      if (url.includes('/releases/latest')) {
        const r = await latest()
        return r ? new Response(JSON.stringify(r)) : new Response('', { status: 404 })
      }
      if (o.installer) return o.installer(url)
      return new Response(BYTES, { headers: { 'content-length': String(BYTES.length) } })
    },
    dir,
    getAuto: () => auto,
    onState: (s) => states.push(s),
    notify: (n) => notes.push(n),
    prepare: o.prepare ?? (async (file, version) => `${file}.prepared-${version}`),
    verify:
      o.verify ??
      (async (prepared) => {
        if (!existsSync(prepared)) throw new Error('gone')
      }),
    launch: (prepared, reopen) => void launched.push([prepared, reopen]),
    quit: () => void quits++,
    readChangelog: async () => CHANGELOG,
    existingProfile: o.existingProfile ?? true,
    now: o.now,
    log: (m) => void logs.push(m)
  }
  const u = new Updater(deps)
  return { u, dir, states, notes, launched, fetched, logs, quits: () => quits, setAuto: (v: boolean) => (auto = v), deps }
}

const settle = () => new Promise((r) => setTimeout(r, 30))

describe('Updater', () => {
  it('auto updates: downloads the new version, says so with its number, installs when GHOST quits', async () => {
    const t = setup()
    await t.u.start(false)
    await t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('ready'))
    const s = t.u.state()
    expect(s).toMatchObject({ current: '0.4.0', latest: { version: '0.5.0', notes: '### New\n- Things in 0.5.0.' }, canInstall: true, error: null })
    expect(t.states.some((x) => x.status === 'downloading' && x.progress)).toBe(true)
    expect(t.notes[0]).toMatchObject({ id: 'update-0.5.0', kind: 'progress', title: 'Updating GHOST to 0.5.0' })
    expect(t.notes.at(-1)).toMatchObject({ id: 'update-0.5.0', kind: 'success', title: 'GHOST 0.5.0 is ready to install' })
    expect(t.notes.at(-1)?.body).toMatch(/installs when you quit GHOST \(you have 0\.4\.0\)/)
    // never "available" on the way (that state asks the user)
    expect(t.states.map((x) => x.status)).not.toContain('available')
    // quitting installs it, once, without reopening
    t.u.onQuit()
    t.u.onQuit()
    expect(t.launched).toEqual([[join(t.dir, 'GHOST-0.5.0-mac-arm64.dmg.prepared-0.5.0'), false]])
    expect(t.quits()).toBe(0)
  })

  it('with auto updates turned off after the download, quitting doesn’t install it: it waits to be asked', async () => {
    const t = setup()
    await t.u.start(false)
    await t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('ready'))
    t.setAuto(false)
    t.u.onQuit()
    expect(t.launched).toEqual([])
  })

  it('two checks at once make one request', async () => {
    const t = setup({ auto: false })
    await t.u.start(false)
    await Promise.all([t.u.check(), t.u.check()])
    expect(t.fetched.filter((u) => u.includes('/releases/latest'))).toHaveLength(1)
  })

  it('auto updates off: asks first (no download), and "Not now" holds until a newer release', async () => {
    let v = '0.5.0'
    const t = setup({ auto: false, latest: () => release(v) })
    await t.u.start(false)
    await t.u.check()
    expect(t.u.state()).toMatchObject({ status: 'available', latest: { version: '0.5.0' }, canInstall: true, dismissed: false })
    expect(t.fetched.filter((u) => u.endsWith('.dmg'))).toHaveLength(0)
    expect(t.notes).toEqual([expect.objectContaining({ kind: 'info', title: 'GHOST 0.5.0 is available', body: expect.stringMatching(/You have 0\.4\.0/) })])
    await t.u.dismiss()
    expect(t.u.state().dismissed).toBe(true)
    await t.u.check()
    expect(t.notes).toHaveLength(1)
    v = '0.5.1'
    await t.u.check()
    expect(t.u.state()).toMatchObject({ latest: { version: '0.5.1' }, dismissed: false })
    expect(t.notes.at(-1)?.title).toBe('GHOST 0.5.1 is available')
    // "Update now": download, then install and restart
    await t.u.installNow()
    expect(t.launched).toEqual([[join(t.dir, 'GHOST-0.5.1-mac-arm64.dmg.prepared-0.5.1'), true]])
    expect(t.quits()).toBe(1)
    expect(t.notes.at(-1)).toMatchObject({ title: 'Updating GHOST to 0.5.1', body: expect.stringMatching(/restarts/) })
  })

  it('turning auto updates on while a release waits starts its download', async () => {
    const t = setup({ auto: false })
    await t.u.start(false)
    await t.u.check()
    t.setAuto(true)
    t.u.onAutoChanged(true)
    await vi.waitFor(() => expect(t.u.state().status).toBe('ready'))
  })

  it('a download that doesn’t match its checksum is thrown away and nothing installs', async () => {
    const t = setup({ latest: () => release('0.5.0', 'f'.repeat(64)) })
    await t.u.start(false)
    await t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('error'))
    expect(t.u.state().error).toMatch(/doesn’t match its checksum/)
    expect(t.notes.at(-1)).toMatchObject({ kind: 'error', title: 'Couldn’t update GHOST to 0.5.0' })
    expect(readdirSync(t.dir).filter((n) => n.includes('.dmg'))).toEqual([])
    t.u.onQuit()
    expect(t.launched).toEqual([])
  })

  it('nothing newer: idle', async () => {
    const t = setup({ latest: () => release('0.4.0') })
    await t.u.start(false)
    expect((await t.u.check()).status).toBe('idle')
    expect(t.u.state().lastCheckedAt).not.toBeNull()
    expect(t.notes).toEqual([])
  })

  it('an install that can’t update itself says a release is out and why', async () => {
    const deb: InstallTarget = { kind: 'deb', path: null, manualReason: 'GHOST was installed from a .deb package (or another way): update it the same way.' }
    const t = setup({ target: deb })
    await t.u.start(false)
    await t.u.check()
    expect(t.u.state()).toMatchObject({ status: 'available', canInstall: false, manualReason: deb.manualReason })
    expect(t.notes.at(-1)?.title).toBe('GHOST 0.5.0 is available')
    await expect(t.u.download()).rejects.toThrow(/\.deb/)
  })

  it('a downloaded release survives a restart that didn’t install it', async () => {
    const t = setup()
    await t.u.start(false)
    await t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('ready'))
    // the "prepared" app the fake made is a path; make it exist
    rmSync(join(t.dir, 'x'), { force: true })
    const prepared = join(t.dir, 'GHOST-0.5.0-mac-arm64.dmg.prepared-0.5.0')
    ;(await import('node:fs')).mkdirSync(prepared, { recursive: true })
    const again = setup({ dir: t.dir })
    await again.u.start(false)
    expect(again.u.state()).toMatchObject({ status: 'ready', latest: { version: '0.5.0' } })
    // once installed (now running 0.5.0), its files go
    const after = setup({ dir: t.dir, current: '0.5.0' })
    await after.u.start(false)
    expect(after.u.state().status).toBe('idle')
    expect(existsSync(prepared)).toBe(false)
  })

  it('checks 20 s after every launch, then once every 24 hours', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const t = setup({ now: () => Date.now(), latest: () => release('0.4.0') })
    await t.u.start(true)
    const checks = () => t.fetched.filter((u) => u.includes('/releases/latest')).length
    // A check finishes with real I/O (it saves its time to disk): the fake clock waits for it,
    // or the check would record a time hours later than it ran.
    const finished = async (n: number) => {
      while (t.states.filter((s) => s.status === 'idle' && s.lastCheckedAt != null).length < n) await new Promise((r) => setImmediate(r))
    }
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1000)
    expect(checks()).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(checks()).toBe(1)
    await finished(1)
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - 3600_000)
    expect(checks()).toBe(1)
    await vi.advanceTimersByTimeAsync(3600_000 + 31 * 60_000)
    expect(checks()).toBe(2)
    await finished(2)
    t.u.stop()

    // Launched again an hour later: it checks again (20 s in), though a day hasn't passed.
    await vi.advanceTimersByTimeAsync(3600_000)
    const again = setup({ dir: t.dir, now: () => Date.now(), latest: () => release('0.4.0') })
    await again.u.start(true)
    const againChecks = () => again.fetched.filter((u) => u.includes('/releases/latest')).length
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1000)
    expect(againChecks()).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(againChecks()).toBe(1)
    while (!again.states.some((s) => s.status === 'idle' && s.lastCheckedAt != null)) await new Promise((r) => setImmediate(r))
    again.u.stop()
  })

  it('release notes after an update: since the version last run, once', async () => {
    const t = setup({ current: '0.5.0' })
    await t.u.start(false)
    // updated from a version before release notes were recorded: this version's
    expect(await t.u.whatsNew()).toMatchObject({ version: '0.5.0', from: null, sections: [{ version: '0.5.0', notes: '- Five.' }] })
    await t.u.whatsNewSeen()
    expect(await t.u.whatsNew()).toBeNull()
    // later, from 0.5.0 to... (a skipped version shows too)
    const older = setup({ current: '0.4.0' })
    await older.u.start(false)
    await older.u.whatsNewSeen()
    const newer = setup({ dir: older.dir, current: '0.5.0' })
    await newer.u.start(false)
    expect((await newer.u.whatsNew())?.sections.map((s) => s.version)).toEqual(['0.5.0', '0.4.1'])
    // a first run shows nothing
    const fresh = setup({ existingProfile: false, current: '0.5.0' })
    await fresh.u.start(false)
    expect(await fresh.u.whatsNew()).toBeNull()
    const fresh2 = setup({ dir: fresh.dir, current: '0.5.0' })
    await fresh2.u.start(false)
    expect(await fresh2.u.whatsNew()).toBeNull()
  })

  it('a newer release that fails to get ready leaves the one already waiting intact and installable', async () => {
    let v = '0.5.0'
    const t = setup({
      latest: () => release(v),
      // A real folder for each prepared release; 0.6.0's preparation fails half-way.
      prepare: async (file, version) => {
        const dir = `${file}.prepared-${version}`
        mkdirSync(dir, { recursive: true })
        if (version === '0.6.0') throw new Error('ditto failed: No space left on device')
        return dir
      }
    })
    await t.u.start(false)
    await t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('ready'))
    const a = join(t.dir, 'GHOST-0.5.0-mac-arm64.dmg.prepared-0.5.0')
    v = '0.6.0'
    await t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('error'))
    expect(existsSync(a)).toBe(true)
    expect(existsSync(join(t.dir, 'GHOST-0.6.0-mac-arm64.dmg'))).toBe(false)
    // after a restart, 0.5.0 is still the one to install
    const again = setup({ dir: t.dir })
    await again.u.start(false)
    expect(again.u.state()).toMatchObject({ status: 'ready', latest: { version: '0.5.0' } })
    again.u.onQuit()
    expect(again.launched).toEqual([[a, false]])
  })

  it('a release waiting from before a restart is checked again, and dropped (never installed) when it no longer checks out', async () => {
    const t = setup({ prepare: async (file, version) => (mkdirSync(`${file}.prepared-${version}`), `${file}.prepared-${version}`) })
    await t.u.start(false)
    await t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('ready'))
    const again = setup({
      dir: t.dir,
      verify: async () => {
        throw new Error('the disk image holds GHOST 0.6.0, not 0.5.0')
      }
    })
    again.u.onQuit() // (quitting before it's checked: nothing to install yet)
    await again.u.start(false)
    expect(again.u.state()).toMatchObject({ status: 'idle', latest: null })
    expect(readdirSync(t.dir)).toEqual(['state.json'])
    again.u.onQuit()
    expect(again.launched).toEqual([])
    expect(again.logs.join('\n')).toMatch(/can’t be installed: the disk image holds GHOST 0\.6\.0/)
  })

  it('updater actions at once write state.json one at a time, and each ends up in it', async () => {
    const t = setup({ auto: false })
    await t.u.start(false)
    let open!: () => void
    stateWrites.gate = new Promise((r) => (open = r))
    stateWrites.peak = 0
    try {
      const seen = t.u.whatsNewSeen()
      const checked = t.u.check()
      await vi.waitFor(() => expect(t.fetched.some((u) => u.includes('/releases/latest'))).toBe(true))
      await new Promise((r) => setImmediate(r))
      await t.u.dismiss().catch(() => {})
      open()
      await seen
      expect((await checked).status).toBe('available')
      await t.u.dismiss()
      expect(stateWrites.peak).toBe(1)
      expect(JSON.parse(readFileSync(join(t.dir, 'state.json'), 'utf8'))).toMatchObject({ lastSeenVersion: '0.4.0', dismissed: '0.5.0', lastCheckedAt: expect.any(Number) })
      expect(t.logs).toEqual([])
    } finally {
      stateWrites.gate = null
    }
  })

  it('a state.json that can’t be written never leaves the updater checking or downloading', async () => {
    const t = setup()
    await t.u.start(false)
    // (a folder where state.json goes: every save fails)
    rmSync(join(t.dir, 'state.json'))
    mkdirSync(join(t.dir, 'state.json'))
    expect((await t.u.check()).status).not.toBe('checking')
    await vi.waitFor(() => expect(t.u.state().status).toBe('ready'))
    await t.u.whatsNewSeen()
    expect(t.logs.some((m) => /couldn’t save its state/.test(m))).toBe(true)
  })

  it('a download whose file can’t be written fails at once (no stray exception), and a retry works without a restart', async () => {
    let cancelled = 0
    let first = true
    const t = setup({
      installer: () => {
        if (!first) return new Response(BYTES, { headers: { 'content-length': String(BYTES.length) } })
        first = false
        // The updates folder disappears while the body is still arriving (slowly: one chunk, then nothing).
        rmSync(t.dir, { recursive: true, force: true })
        const body = new ReadableStream<Uint8Array>({
          start: (c) => c.enqueue(BYTES.subarray(0, 1000)),
          pull: () => new Promise<void>(() => {}),
          cancel: () => void cancelled++
        })
        return new Response(body, { headers: { 'content-length': String(BYTES.length) } })
      }
    })
    await t.u.start(false)
    await t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('error'))
    expect(t.u.state().error).toMatch(/ENOENT/)
    expect(cancelled).toBe(1)
    expect(t.notes.at(-1)).toMatchObject({ kind: 'error', title: 'Couldn’t update GHOST to 0.5.0' })
    await t.u.download()
    expect(t.u.state().status).toBe('ready')
    expect(readdirSync(t.dir).filter((n) => n.endsWith('.part'))).toEqual([])
  })

  it('quitting installs the release already waiting while a check for a newer one is still going', async () => {
    let hold: Promise<void> | null = null
    let answer!: () => void
    let v = '0.5.0'
    let slow: (() => void) | null = null
    const t = setup({
      latest: async () => {
        await hold
        return release(v)
      },
      installer: async () => {
        if (v === '0.6.0') await new Promise<void>((r) => (slow = r))
        return new Response(BYTES, { headers: { 'content-length': String(BYTES.length) } })
      },
      prepare: async (file, version) => (mkdirSync(`${file}.prepared-${version}`), `${file}.prepared-${version}`)
    })
    await t.u.start(false)
    await t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('ready'))
    const a = join(t.dir, 'GHOST-0.5.0-mac-arm64.dmg.prepared-0.5.0')
    // a recheck that hasn't answered yet (up to its 20 s timeout)
    hold = new Promise((r) => (answer = r))
    v = '0.6.0'
    const rechecked = t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('checking'))
    // …or that found 0.6.0 and is downloading it
    answer()
    await rechecked
    await vi.waitFor(() => expect(t.u.state().status).toBe('downloading'))
    await vi.waitFor(() => expect(slow).not.toBeNull())
    t.u.onQuit()
    expect(t.launched).toEqual([[a, false]])
    // 0.6.0 finishing afterwards leaves the release being installed alone
    slow!()
    await vi.waitFor(() => expect(t.u.state().status).toBe('ready'))
    expect(existsSync(a)).toBe(true)
    t.u.onQuit()
    expect(t.launched).toHaveLength(1)
  })

  it('quitting during a recheck that never answers still installs the release waiting', async () => {
    const t = setup({ prepare: async (file, version) => (mkdirSync(`${file}.prepared-${version}`), `${file}.prepared-${version}`) })
    await t.u.start(false)
    await t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('ready'))
    ;(t.deps as { fetch: UpdaterDeps['fetch'] }).fetch = () => new Promise<Response>(() => {})
    void t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('checking'))
    t.u.onQuit()
    expect(t.launched).toEqual([[join(t.dir, 'GHOST-0.5.0-mac-arm64.dmg.prepared-0.5.0'), false]])
  })

  it('a failed download is tried again two hours later (then four), not a day later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const t = setup({ now: () => Date.now(), latest: () => release('0.5.0', 'f'.repeat(64)) })
    await t.u.start(true)
    const checks = () => t.fetched.filter((u) => u.includes('/releases/latest')).length
    const failures = () => t.notes.filter((n) => n.kind === 'error').length
    const failed = async (n: number) => {
      while (failures() < n) await new Promise((r) => setImmediate(r))
    }
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 1000)
    expect(checks()).toBe(1)
    await failed(1)
    await vi.advanceTimersByTimeAsync(2 * 3600_000 - 60_000)
    expect(checks()).toBe(1)
    // (the clock is looked at every 30 minutes)
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(checks()).toBe(2)
    await failed(2)
    await vi.advanceTimersByTimeAsync(4 * 3600_000 - 60_000)
    expect(checks()).toBe(2)
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(checks()).toBe(3)
    await failed(3)
    t.u.stop()
  })

  it('a launch while a failed download waits for its retry checks, but fetches the installer again only once it is due', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const latest = () => release('0.5.0', 'f'.repeat(64))
    const t = setup({ now: () => Date.now(), latest })
    await t.u.start(true)
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 1000)
    while (!t.notes.some((n) => n.kind === 'error')) await new Promise((r) => setImmediate(r))
    t.u.stop()
    const downloads = (f: string[]) => f.filter((u) => u.endsWith('.dmg')).length
    expect(downloads(t.fetched)).toBe(1)

    // Relaunched 10 minutes later: it checks, says the download failed, and doesn't fetch it again yet.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const again = setup({ dir: t.dir, now: () => Date.now(), latest })
    await again.u.start(true)
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 1000)
    while (again.u.state().status !== 'error') await new Promise((r) => setImmediate(r))
    expect(again.fetched.filter((u) => u.includes('/releases/latest')).length).toBe(1)
    expect(downloads(again.fetched)).toBe(0)
    expect(again.u.state()).toMatchObject({ status: 'error', latest: { version: '0.5.0' }, canInstall: true })
    // Two hours after the failure, it's tried again.
    await vi.advanceTimersByTimeAsync(2 * 3600_000)
    while (downloads(again.fetched) < 1) await new Promise((r) => setImmediate(r))
    while (!again.notes.some((n) => n.kind === 'error')) await new Promise((r) => setImmediate(r))
    again.u.stop()
  })

  it('only downloads installers from GitHub', async () => {
    const r = release('0.5.0')
    r.assets[0].browser_download_url = 'https://evil.example/GHOST.dmg'
    const t = setup({ latest: () => r })
    await t.u.start(false)
    await t.u.check()
    await vi.waitFor(() => expect(t.u.state().status).toBe('error'))
    expect(t.u.state().error).toMatch(/refusing to download/)
    await settle()
  })
})
