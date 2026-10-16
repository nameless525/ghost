// The updater wired to Electron: GitHub over Chromium's network stack (system proxies apply), the
// install this copy of GHOST is, and the changelog bundled in the app. GHOST_UPDATE_FEED points it
// at another latest-release document (tests serve one locally; it also allows plain http there).

import { app, net } from 'electron'
import { accessSync, constants, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GhostNotification, Settings, UpdateState } from '../../shared/types'
import { GHOST_VERSION } from '../../shared/version'
import { GHOST_USER_AGENT } from '../net/http'
import { RELEASES_API } from './feed'
import { detectInstall, launchInstall, prepareInstall, verifyPrepared } from './install'
import { Updater } from './updater'

export { Updater } from './updater'

const canWrite = (p: string) => {
  try {
    accessSync(p, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export interface UpdaterHost {
  updater: Updater
  /** Whether it checks by itself (a packaged app, or a test feed). */
  scheduled: boolean
}

export function createUpdater(o: { dir: string; getSettings: () => Settings; existingProfile: boolean; onState: (s: UpdateState) => void; notify: (n: GhostNotification) => void }): UpdaterHost {
  const feed = process.env.GHOST_UPDATE_FEED || null
  const target = detectInstall({ packaged: app.isPackaged, platform: process.platform, execPath: process.execPath, env: process.env, canWrite, exists: existsSync })
  const updater = new Updater({
    current: GHOST_VERSION,
    platform: process.platform,
    arch: process.arch,
    target,
    feedUrl: feed ?? RELEASES_API,
    downloadHosts: feed ? null : /(^|\.)(github\.com|githubusercontent\.com)$/,
    userAgent: GHOST_USER_AGENT,
    fetch: (url, init) => net.fetch(url, init),
    dir: o.dir,
    getAuto: () => o.getSettings().updates?.auto !== false,
    onState: o.onState,
    notify: o.notify,
    prepare: (file, version) => prepareInstall(target, file, version, o.dir),
    verify: (prepared, version) => verifyPrepared(target, prepared, version),
    launch: (prepared, reopen) => launchInstall(target, prepared, { pid: process.pid, reopen, stagingDir: o.dir }),
    quit: () => app.quit(),
    readChangelog: () => readFile(join(app.getAppPath(), 'CHANGELOG.md'), 'utf8'),
    existingProfile: o.existingProfile,
    log: (m) => console.log(m)
  })
  return { updater, scheduled: app.isPackaged || !!feed }
}
