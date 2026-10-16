// GHOST's own updates: the updater's state from main ('updates:state'), the update prompt's open
// flag (the toolbar pill and Settings open it; shell/Updates.tsx also opens it by itself once per
// release) and the actions behind their buttons. Without an updater (an older preload, the browser
// mock before it had one) everything stays idle.
import { create } from 'zustand'
import type { GhostAPI, UpdatesAPI } from '@shared/api'
import type { UpdateState } from '@shared/types'
import { GHOST_VERSION } from '@shared/version'
import { ghost } from '../ghost'
import { notify } from '../shell/notifications'

const IDLE: UpdateState = {
  current: GHOST_VERSION,
  status: 'idle',
  latest: null,
  progress: null,
  error: null,
  lastCheckedAt: null,
  canInstall: false,
  manualReason: null,
  dismissed: false
}

export const useUpdates = create<UpdateState>(() => IDLE)

export const useUpdateUI = create<{
  /** The update prompt is open. */
  prompt: boolean
  /** "Update now" was clicked: GHOST restarts into the release once it's downloaded. */
  restarting: boolean
}>(() => ({ prompt: false, restarting: false }))

export const openUpdatePrompt = (): void => useUpdateUI.setState({ prompt: true })
export const closeUpdatePrompt = (): void => useUpdateUI.setState({ prompt: false })

/** The updater, or null where this build has none. */
export function updatesApi(): UpdatesAPI | null {
  return (window.ghost as Partial<GhostAPI> | undefined)?.updates ?? null
}

function apply(s: UpdateState | null | undefined): void {
  if (!s || typeof s.status !== 'string') return
  useUpdates.setState(s, true)
  // the download the restart waited for failed, or there's nothing to install any more
  if (s.status === 'idle' || s.status === 'error') useUpdateUI.setState({ restarting: false })
}

let started = false
export function initUpdatesStore(): void {
  if (started) return
  started = true
  const api = updatesApi()
  if (!api) return
  let pushed = false
  ghost().on('updates:state', (s) => {
    pushed = true
    apply(s)
  })
  // a push that beat the reply is newer than it
  api.getState().then(
    (s) => !pushed && apply(s),
    () => {}
  )
}

/** The download's progress, 0..1, or null while its size is unknown. */
export function updateFraction(s: UpdateState): number | null {
  const total = s.progress?.totalBytes ?? s.latest?.sizeBytes ?? null
  return s.progress && total ? Math.min(1, s.progress.bytes / total) : null
}

/** An updater call the user asked for. Its failures normally arrive as UpdateState.error (with
 *  main's own notice); one that rejects outright is shown here instead of doing nothing. */
function run(failed: string, call: (api: UpdatesAPI) => Promise<unknown>): void {
  const api = updatesApi()
  if (!api) return
  call(api).catch((err: unknown) => {
    useUpdateUI.setState({ restarting: false })
    notify({ kind: 'error', title: failed, body: String((err as Error)?.message ?? err) })
  })
}

export const checkForUpdates = (): void => run('Could not check for updates', (a) => a.check())

/** Install the release and restart GHOST into it, downloading it first if needed. */
export function installUpdate(): void {
  useUpdateUI.setState({ restarting: true })
  run('Could not update GHOST', (a) => a.installNow())
}

/** "Not now": no prompt for this release again (a newer one asks again). */
export function dismissUpdate(): void {
  closeUpdatePrompt()
  run('Could not dismiss the update', (a) => a.dismiss())
}

/** For installs that can't update themselves: the release page, to download it from. */
export function openReleasePage(url: string): void {
  void ghost().system.openExternal(url)
}
