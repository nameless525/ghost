import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseChangelog, whatsNewSince } from './changelog'
import { assetFor, fetchLatestRelease, parseRelease, parseSha256Sums, releaseNotes } from './feed'
import { detectInstall, launchInstall, MAC_SWAP_SCRIPT, prepareInstall, type InstallTarget } from './install'
import { compareVersions } from './version'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ghost-upd-'))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const unix = process.platform !== 'win32'

describe('versions', () => {
  it('orders releases, pre-releases before their release', () => {
    expect(compareVersions('0.4.1', '0.4.0')).toBeGreaterThan(0)
    expect(compareVersions('v0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.5.0-beta.1', '0.5.0')).toBeLessThan(0)
    expect(compareVersions('0.5.0-beta.2', '0.5.0-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('nonsense', '0.0.1')).toBeLessThan(0)
  })
})

describe('changelog', () => {
  const md = `# Changelog

## Unreleased
- not out yet

## 0.4.1 (2026-10-20)
### Fixes
- One fix.

## 0.4.0 (2026-10-15)
Intro line.
- Big thing.
  - Detail.

## 0.3.3 (2026-10-14)
- Older.
`
  it('splits the released versions, newest first, without Unreleased', () => {
    const s = parseChangelog(md)
    expect(s.map((x) => [x.version, x.date])).toEqual([
      ['0.4.1', '2026-10-20'],
      ['0.4.0', '2026-10-15'],
      ['0.3.3', '2026-10-14']
    ])
    expect(s[1].notes).toBe('Intro line.\n- Big thing.\n  - Detail.')
  })

  it('shows what changed since the version last run', () => {
    const s = parseChangelog(md)
    expect(whatsNewSince(s, '0.4.1', '0.3.3')?.sections.map((x) => x.version)).toEqual(['0.4.1', '0.4.0'])
    expect(whatsNewSince(s, '0.4.1', '0.4.0')).toMatchObject({ version: '0.4.1', from: '0.4.0', sections: [{ version: '0.4.1', notes: '### Fixes\n- One fix.' }] })
    // updated from a version that didn't record itself: just this one's notes
    expect(whatsNewSince(s, '0.4.0', null)?.sections.map((x) => x.version)).toEqual(['0.4.0'])
    expect(whatsNewSince(s, '0.4.1', '0.4.1')).toBeNull()
  })

  it('reads the real changelog', () => {
    const s = parseChangelog(readFileSync(join(__dirname, '../../../CHANGELOG.md'), 'utf8'))
    expect(s.length).toBeGreaterThan(3)
    expect(s.every((x) => x.notes.length > 0 && compareVersions(x.version, '0.0.1') > 0)).toBe(true)
  })
})

describe('release feed', () => {
  const sha = (c: string) => c.repeat(64)
  const gh = {
    tag_name: 'v0.4.1',
    html_url: 'https://github.com/nameless525/ghost/releases/tag/v0.4.1',
    published_at: '2026-10-20T10:00:00Z',
    body: '### Fixes\n- One fix.\n\n---\n\n**Install:** download the file for your system below.',
    assets: [
      { name: 'GHOST-0.4.1-mac-arm64.dmg', size: 130_000_000, browser_download_url: 'https://github.com/x/mac.dmg', digest: `sha256:${sha('a')}` },
      { name: 'GHOST-0.4.1-windows-x64-setup.exe', size: 90_000_000, browser_download_url: 'https://github.com/x/win.exe', digest: `sha256:${sha('b')}` },
      { name: 'GHOST-0.4.1-linux-x86_64.AppImage', size: 120_000_000, browser_download_url: 'https://github.com/x/app.AppImage' },
      { name: 'GHOST-0.4.1-linux-amd64.deb', size: 80_000_000, browser_download_url: 'https://github.com/x/app.deb' },
      { name: 'SHA256SUMS', size: 400, browser_download_url: 'https://github.com/x/SHA256SUMS' }
    ]
  }

  it('reads the version, notes (without the install footer) and installers', () => {
    const r = parseRelease(gh)!
    expect(r).toMatchObject({ version: '0.4.1', notes: '### Fixes\n- One fix.', url: gh.html_url, publishedAt: Date.parse(gh.published_at) })
    expect(assetFor(r, 'darwin', 'arm64', 'mac-app')).toMatchObject({ name: 'GHOST-0.4.1-mac-arm64.dmg', sha256: sha('a') })
    expect(assetFor(r, 'win32', 'x64', 'nsis')?.name).toBe('GHOST-0.4.1-windows-x64-setup.exe')
    expect(assetFor(r, 'linux', 'x64', 'appimage')?.name).toBe('GHOST-0.4.1-linux-x86_64.AppImage')
    expect(assetFor(r, 'linux', 'x64', 'deb')?.name).toBe('GHOST-0.4.1-linux-amd64.deb')
    expect(assetFor(r, 'darwin', 'x64', 'mac-app')).toBeNull() // no Intel build
    expect(parseRelease({ ...gh, draft: true })).toBeNull()
    expect(parseRelease({ ...gh, tag_name: 'latest' })).toBeNull()
    expect(releaseNotes('a\n---\nb')).toBe('a')
  })

  it('fills missing digests from SHA256SUMS', async () => {
    const urls: string[] = []
    const fetch = async (url: string) => {
      urls.push(url)
      if (url.endsWith('/latest')) return new Response(JSON.stringify(gh))
      return new Response(`${sha('c')}  GHOST-0.4.1-linux-x86_64.AppImage\n${sha('d')} *GHOST-0.4.1-linux-amd64.deb\n`)
    }
    const r = (await fetchLatestRelease(fetch, 'https://api.example/latest', 'ua'))!
    expect(assetFor(r, 'linux', 'x64', 'appimage')?.sha256).toBe(sha('c'))
    expect(assetFor(r, 'darwin', 'arm64', 'mac-app')?.sha256).toBe(sha('a')) // GitHub's own digest kept
    expect(urls).toEqual(['https://api.example/latest', 'https://github.com/x/SHA256SUMS'])
    expect(parseSha256Sums('nonsense')).toEqual(new Map())
    // no releases yet; rate limited
    expect(await fetchLatestRelease(async () => new Response('', { status: 404 }), 'u', 'ua')).toBeNull()
    await expect(fetchLatestRelease(async () => new Response('', { status: 403 }), 'u', 'ua')).rejects.toThrow(/rate limit/)
  })
})

describe('install', () => {
  const base = { packaged: true, env: {}, canWrite: () => true, exists: () => true }
  it('knows how this copy was installed, and when it can replace itself', () => {
    expect(detectInstall({ ...base, platform: 'darwin', execPath: '/Applications/GHOST.app/Contents/MacOS/GHOST' })).toEqual({ kind: 'mac-app', path: '/Applications/GHOST.app', manualReason: null })
    expect(detectInstall({ ...base, platform: 'darwin', execPath: '/Volumes/GHOST 0.4.0/GHOST.app/Contents/MacOS/GHOST', canWrite: () => false }).manualReason).toMatch(/disk image/)
    expect(detectInstall({ ...base, platform: 'darwin', execPath: '/Applications/GHOST.app/Contents/MacOS/GHOST', canWrite: () => false }).manualReason).toMatch(/can’t write/)
    expect(detectInstall({ ...base, platform: 'win32', execPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\ghost\\GHOST.exe' }).kind).toBe('nsis')
    expect(detectInstall({ ...base, platform: 'win32', execPath: 'C:\\portable\\GHOST.exe', exists: () => false }).kind).toBe('none')
    expect(detectInstall({ ...base, platform: 'linux', execPath: '/tmp/.mount_x/ghost', env: { APPIMAGE: '/home/a/GHOST.AppImage' } })).toEqual({ kind: 'appimage', path: '/home/a/GHOST.AppImage', manualReason: null })
    expect(detectInstall({ ...base, platform: 'linux', execPath: '/opt/GHOST/ghost' })).toMatchObject({ kind: 'deb', manualReason: expect.stringMatching(/\.deb/) })
    expect(detectInstall({ ...base, packaged: false, platform: 'darwin', execPath: '/x/Electron.app/Contents/MacOS/Electron' }).manualReason).toMatch(/source/)
  })

  it('macOS: copies the app out of the disk image and checks it is the expected version', async () => {
    const d = tmp()
    const calls: string[] = []
    // A stand-in for hdiutil / ditto / PlistBuddy over a real folder.
    const exec = async (cmd: string, args: string[]) => {
      calls.push(cmd.split('/').pop()!)
      if (cmd === 'hdiutil' && args[0] === 'attach') {
        const mnt = args[args.indexOf('-mountpoint') + 1]
        mkdirSync(join(mnt, 'GHOST.app', 'Contents'), { recursive: true })
        writeFileSync(join(mnt, 'GHOST.app', 'Contents', 'Info.plist'), 'plist')
      }
      if (cmd === 'ditto') cpSync(args[0], args[1], { recursive: true })
      if (cmd.endsWith('PlistBuddy')) return args[1].includes('Identifier') ? 'dev.ghost.app\n' : '0.4.1\n'
      return ''
    }
    const target: InstallTarget = { kind: 'mac-app', path: '/Applications/GHOST.app', manualReason: null }
    const staged = await prepareInstall(target, join(d, 'GHOST.dmg'), '0.4.1', d, exec)
    expect(staged).toBe(join(d, 'GHOST.app'))
    expect(existsSync(join(staged, 'Contents', 'Info.plist'))).toBe(true)
    expect(calls).toEqual(['hdiutil', 'ditto', 'PlistBuddy', 'PlistBuddy', 'hdiutil']) // always detached
    await expect(prepareInstall(target, join(d, 'GHOST.dmg'), '0.4.2', d, exec)).rejects.toThrow(/holds GHOST 0.4.1, not 0.4.2/)
  })

  it.runIf(unix)('macOS swap script: waits for GHOST to quit, then puts the new app in place', () => {
    const d = tmp()
    const app = join(d, 'GHOST.app')
    const staged = join(d, 'staged', 'GHOST.app')
    mkdirSync(join(app, 'Contents'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'v'), 'old')
    mkdirSync(join(staged, 'Contents'), { recursive: true })
    writeFileSync(join(staged, 'Contents', 'v'), 'new')
    const script = join(d, 'install.sh')
    writeFileSync(script, MAC_SWAP_SCRIPT)
    // A pid that has exited (this short-lived child's).
    const gone = Number(execFileSync('/bin/sh', ['-c', 'echo $$']).toString().trim())
    execFileSync('/bin/sh', [script, String(gone), app, staged, '0'])
    expect(readFileSync(join(app, 'Contents', 'v'), 'utf8')).toBe('new')
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(`${app}.old-version`)).toBe(false)
  })

  it('starts each platform’s installer the right way', () => {
    const d = tmp()
    const started: unknown[][] = []
    const spawnDetached = (cmd: string, args: string[]) => void started.push([cmd, ...args])
    launchInstall({ kind: 'mac-app', path: '/Applications/GHOST.app', manualReason: null }, '/u/GHOST.app', { pid: 42, reopen: true, stagingDir: d, spawnDetached })
    expect(started.pop()).toEqual(['/bin/sh', join(d, 'install.sh'), '42', '/Applications/GHOST.app', '/u/GHOST.app', '1'])
    expect(readFileSync(join(d, 'install.sh'), 'utf8')).toBe(MAC_SWAP_SCRIPT)
    launchInstall({ kind: 'nsis', path: 'C:\\g', manualReason: null }, 'C:\\u\\setup.exe', { pid: 42, reopen: false, stagingDir: d, spawnDetached })
    expect(started.pop()).toEqual(['C:\\u\\setup.exe', '/S', '--updated'])
    launchInstall({ kind: 'nsis', path: 'C:\\g', manualReason: null }, 'C:\\u\\setup.exe', { pid: 42, reopen: true, stagingDir: d, spawnDetached })
    expect(started.pop()).toEqual(['C:\\u\\setup.exe', '/S', '--updated', '--force-run'])
    launchInstall({ kind: 'appimage', path: '/a/G.AppImage', manualReason: null }, '/a/G.AppImage', { pid: 42, reopen: false, stagingDir: d, spawnDetached })
    expect(started).toHaveLength(0) // already in place: nothing to start on quit
  })
})
