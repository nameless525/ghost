import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { GhostNotification, UpdateState } from '../../shared/types'
import type { InstallTarget } from './install'
import { CHECK_EVERY_MS, STARTUP_DELAY_MS, Updater, type UpdaterDeps } from './updater'

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

function setup(o: { latest?: () => object | null; auto?: boolean; target?: InstallTarget; dir?: string; existingProfile?: boolean; current?: string; now?: () => number } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'ghost-updater-'))
  if (!o.dir) dirs.push(dir)
  const states: UpdateState[] = []
  const notes: GhostNotification[] = []
  const launched: [string, boolean][] = []
  const fetched: string[] = []
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
        const r = latest()
        return r ? new Response(JSON.stringify(r)) : new Response('', { status: 404 })
      }
      return new Response(BYTES, { headers: { 'content-length': String(BYTES.length) } })
    },
    dir,
    getAuto: () => auto,
    onState: (s) => states.push(s),
    notify: (n) => notes.push(n),
    prepare: async (file, version) => `${file}.prepared-${version}`,
    launch: (prepared, reopen) => void launched.push([prepared, reopen]),
    quit: () => void quits++,
    readChangelog: async () => CHANGELOG,
    existingProfile: o.existingProfile ?? true,
    now: o.now
  }
  const u = new Updater(deps)
  return { u, dir, states, notes, launched, fetched, quits: () => quits, setAuto: (v: boolean) => (auto = v), deps }
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

  it('checks 20 s after launch, then once every 24 hours', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const t = setup({ now: () => Date.now(), latest: () => release('0.4.0') })
    await t.u.start(true)
    const checks = () => t.fetched.filter((u) => u.includes('/releases/latest')).length
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1000)
    expect(checks()).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(checks()).toBe(1)
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - 3600_000)
    expect(checks()).toBe(1)
    await vi.advanceTimersByTimeAsync(3600_000 + 31 * 60_000)
    expect(checks()).toBe(2)
    t.u.stop()
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
