// Putting a downloaded release in place, per platform. GHOST isn't signed with a vendor certificate,
// so the stock updaters (Squirrel.Mac checks the code signature of both versions) can't be used:
//  - macOS: the app is copied out of the release's disk image, and a small script swaps it in for
//    the running app's bundle once GHOST has quit (then reopens it after a restart).
//  - Windows: the release's installer (NSIS, per-user) runs silently once GHOST has quit.
//  - Linux AppImage: the new AppImage replaces the file GHOST runs from (the running copy keeps its
//    open file until it quits).
// A .deb install, a copy run from source, or one in a folder GHOST can't write to only hears that a
// release is out (Settings / the prompt link to it).

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { InstallKind } from './feed'

export interface InstallTarget {
  kind: InstallKind
  /** mac-app: the .app bundle. appimage: the AppImage file. nsis: the app's folder. */
  path: string | null
  /** Why updates can't be installed here (null when they can). */
  manualReason: string | null
}

export interface DetectOptions {
  packaged: boolean
  platform: NodeJS.Platform
  execPath: string
  env: NodeJS.ProcessEnv
  canWrite: (path: string) => boolean
  exists: (path: string) => boolean
}

export function detectInstall(o: DetectOptions): InstallTarget {
  if (!o.packaged) return { kind: 'none', path: null, manualReason: 'This copy of GHOST runs from its source code: update it with git.' }
  if (o.platform === 'darwin') {
    const i = o.execPath.indexOf('.app/')
    if (i < 0) return { kind: 'none', path: null, manualReason: 'GHOST couldn’t find its app bundle.' }
    const bundle = o.execPath.slice(0, i + 4)
    if (bundle.startsWith('/Volumes/') && !o.canWrite(dirname(bundle)))
      return { kind: 'mac-app', path: bundle, manualReason: 'GHOST is running from its disk image. Drag it to your Applications folder, and it will update itself from then on.' }
    if (bundle.includes('/AppTranslocation/'))
      return { kind: 'mac-app', path: bundle, manualReason: 'macOS is running GHOST from a temporary copy. Run the xattr command from the README once, and GHOST will update itself from then on.' }
    if (!o.canWrite(dirname(bundle)) || !o.canWrite(bundle))
      return { kind: 'mac-app', path: bundle, manualReason: `GHOST can’t write to ${dirname(bundle)}, so it can’t replace itself there.` }
    return { kind: 'mac-app', path: bundle, manualReason: null }
  }
  if (o.platform === 'win32') {
    const dir = dirname(o.execPath)
    if (!o.exists(join(dir, 'Uninstall GHOST.exe'))) return { kind: 'none', path: null, manualReason: 'This copy of GHOST wasn’t set up by its installer, so it can’t update itself.' }
    return { kind: 'nsis', path: dir, manualReason: null }
  }
  if (o.platform === 'linux') {
    const image = o.env.APPIMAGE
    if (!image) return { kind: 'deb', path: null, manualReason: 'GHOST was installed from a .deb package (or another way): update it the same way.' }
    if (!o.canWrite(dirname(image))) return { kind: 'appimage', path: image, manualReason: `GHOST can’t write to ${dirname(image)}, so it can’t replace its AppImage there.` }
    return { kind: 'appimage', path: image, manualReason: null }
  }
  return { kind: 'none', path: null, manualReason: 'GHOST can’t update itself on this system.' }
}

/** Runs a command, resolving with its stdout (rejects with its stderr on failure). */
export type Run = (cmd: string, args: string[]) => Promise<string>

export const run: Run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += String(d)))
    p.stderr.on('data', (d) => (err += String(d)))
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${basename(cmd)} failed: ${err.trim() || `exit ${code}`}`))))
  })

/** Throws unless `app` is GHOST's bundle at `version` (its Info.plist says so). */
async function checkBundle(app: string, version: string, exec: Run): Promise<void> {
  const plist = join(app, 'Contents', 'Info.plist')
  const id = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).trim()
  const v = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).trim()
  if (id !== 'dev.ghost.app') throw new Error(`the disk image holds ${id}, not GHOST`)
  if (v !== version) throw new Error(`the disk image holds GHOST ${v}, not ${version}`)
}

/**
 * Make the downloaded `file` ready to install, checking that it is `version`. Returns what
 * `launchInstall` needs: the staged app (macOS), the installer (Windows), the AppImage (Linux,
 * already in place). A failure leaves nothing of this release behind, and never touches a release
 * staged before it.
 */
export async function prepareInstall(target: InstallTarget, file: string, version: string, stagingDir: string, exec: Run = run): Promise<string> {
  if (target.kind === 'mac-app') {
    // A folder of its own per release: the one staged before stays whole until this one is ready.
    const stage = await mkdtemp(join(stagingDir, `stage-${version}-`))
    try {
      const mnt = join(stage, 'mount')
      await mkdir(mnt)
      await exec('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-readonly', '-noverify', '-mountpoint', mnt, file])
      try {
        const name = (await readdir(mnt)).find((n) => n.endsWith('.app'))
        if (!name) throw new Error('the disk image has no app in it')
        const staged = join(stage, name)
        await exec('ditto', [join(mnt, name), staged])
        await checkBundle(staged, version, exec)
        return staged
      } finally {
        await exec('hdiutil', ['detach', mnt, '-force']).catch(() => {})
        // (only once it's empty: never into a disk image that is still mounted)
        await rmdir(mnt).catch(() => {})
      }
    } catch (e) {
      await rm(stage, { recursive: true, force: true }).catch(() => {})
      throw e
    }
  }
  if (target.kind === 'appimage' && target.path) {
    // Beside the running one (same filesystem, so the swap is a rename), then swapped in.
    const next = `${target.path}.update`
    try {
      await copyFile(file, next)
      await chmod(next, 0o755)
      await rename(next, target.path)
    } catch (e) {
      await rm(next, { force: true }).catch(() => {})
      throw e
    }
    return target.path
  }
  if (target.kind === 'nsis') return file
  throw new Error('GHOST can’t install updates here')
}

/**
 * Throws unless `prepared` (from prepareInstall, recorded before a restart) is still there and, on
 * macOS, still GHOST's bundle at `version`.
 */
export async function verifyPrepared(target: InstallTarget, prepared: string, version: string, exec: Run = run): Promise<void> {
  if (!existsSync(prepared)) throw new Error(`${prepared} is gone`)
  if (target.kind === 'mac-app') await checkBundle(prepared, version, exec)
  else if (target.kind === 'appimage' && prepared !== target.path) throw new Error(`${prepared} isn’t this AppImage`)
}

/** The macOS swap, run once GHOST has quit: $1 pid, $2 the app, $3 the staged new app, $4 1 to reopen. */
export const MAC_SWAP_SCRIPT = `#!/bin/sh
# GHOST's updater: waits for GHOST to quit, then puts the new version in place of the old one.
pid="$1"; app="$2"; staged="$3"; reopen="$4"
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1)); [ "$n" -gt 600 ] && exit 1
  sleep 0.1
done
old="$app.old-version"
[ -x "$staged/Contents/MacOS/GHOST" ] || exit 1
rm -rf "$old"
mv "$app" "$old" || exit 1
# The old version goes only once the new one is in place, whole.
if ! mv "$staged" "$app" || [ ! -x "$app/Contents/MacOS/GHOST" ]; then
  rm -rf "$app"
  mv "$old" "$app"
  exit 1
fi
rm -rf "$old"
xattr -dr com.apple.quarantine "$app" 2>/dev/null
if [ "$reopen" = 1 ]; then
  # A copy run on its own data folder keeps it ("open" would start it without its environment).
  if [ -n "$GHOST_USER_DATA" ]; then
    "$app/Contents/MacOS/GHOST" >/dev/null 2>&1 &
  else
    open "$app"
  fi
fi
exit 0
`

export interface LaunchOptions {
  pid: number
  /** Reopen GHOST once installed (a restart; quitting doesn't). */
  reopen: boolean
  stagingDir: string
  spawnDetached?: (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => void
}

const spawnDetached = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => spawn(cmd, args, { detached: true, stdio: 'ignore', env: env ?? process.env, windowsHide: true }).unref()

/**
 * Start installing `prepared` (from prepareInstall). Synchronous (it runs as GHOST quits, which
 * doesn't wait for promises); the installer itself waits for GHOST to be gone.
 */
export function launchInstall(target: InstallTarget, prepared: string, o: LaunchOptions): void {
  const start = o.spawnDetached ?? spawnDetached
  if (target.kind === 'mac-app' && target.path) {
    const script = join(o.stagingDir, 'install.sh')
    writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 })
    start('/bin/sh', [script, String(o.pid), target.path, prepared, o.reopen ? '1' : '0'])
    return
  }
  if (target.kind === 'nsis') {
    // electron-builder's NSIS installer: silent, as an update; --force-run starts GHOST when done.
    start(prepared, ['/S', '--updated', ...(o.reopen ? ['--force-run'] : [])])
    return
  }
  if (target.kind === 'appimage') {
    if (!o.reopen) return // already in place
    // The new AppImage sets these up for itself.
    const env = { ...process.env }
    for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete env[k]
    start(prepared, [], env)
    return
  }
  throw new Error('GHOST can’t install updates here')
}
