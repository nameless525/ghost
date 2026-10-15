import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { broadcast, ipcStats, registerIpc } from './ipc'
import { perfMark, perfStats, setPerfFocus, startMainPerf } from './perf'
import { enableWorkerCompileCache, migrateLegacyCache } from './paths'
import { onPlayerState } from './power'
import { createServices, type ServicesHandle } from './services'
import { artStats, handleArtProtocol, registerArtScheme } from './net/art-protocol'
import { closeDb } from './db'
import { killTrackedChildren, watchChildren } from './tools/children'
import { appPageMatcher, isExternalLink, navigationAction } from './window-guard'

perfMark('main:module')
app.setName('GHOST')
// Dev/test: isolate all app data (DB, cache, settings) in another folder.
if (process.env.GHOST_USER_DATA) app.setPath('userData', process.env.GHOST_USER_DATA)
// Before the catalog worker (and the renderer's preload) start: they read it at their start.
enableWorkerCompileCache()

const here = dirname(fileURLToPath(import.meta.url))
registerArtScheme()
// yt-dlp runs in the catalog worker; its processes are ended from here on quit.
watchChildren()

let handle: ServicesHandle | null = null

// A stray exception must not put up Electron's blocking "JavaScript error" dialog: log it and say
// so in the app (once per message a minute). The app keeps running, as it did behind that dialog.
const reported = new Map<string, number>()
function reportMainError(kind: string, e: unknown): void {
  const err = e instanceof Error ? e : new Error(String(e))
  console.error(`[main] ${kind}:`, err)
  const now = Date.now()
  if ((reported.get(err.message) ?? 0) > now - 60_000) return
  if (reported.size > 50) reported.clear()
  reported.set(err.message, now)
  if (!app.isReady()) return
  broadcast('notify', { id: `main-error-${now}`, kind: 'error', title: 'Something went wrong', body: err.message })
}
process.on('uncaughtException', (e) => reportMainError('uncaught exception', e))
// Rejections only get logged (Node's default): many are harmless (an aborted request).
process.on('unhandledRejection', (e) => console.error('[main] unhandled rejection:', e))

/**
 * The app icon for unpackaged runs (packaged builds carry their own). Looked up next to the app
 * and next to the build output, since a build can be run from any folder; null when there is none,
 * so a missing icon never stops the app.
 */
const devIcon: string | null = app.isPackaged
  ? null
  : ([join(app.getAppPath(), 'resources/icon.png'), join(here, '../../resources/icon.png')].find((p) => existsSync(p)) ?? null)

/** Where the renderer lives: the dev server, or the bundled index.html. */
const rendererUrl = (): string => process.env.ELECTRON_RENDERER_URL || pathToFileURL(join(here, '../renderer/index.html')).href

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#0f0d17',
    title: 'GHOST',
    icon: devIcon ?? undefined,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 14 },
    titleBarOverlay: isMac ? undefined : { color: '#00000000', symbolColor: '#e8e4f8', height: 40 },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments: handle?.preloadArgs ?? []
    }
  })
  win.once('ready-to-show', () => {
    perfMark('window:ready-to-show')
    win.show()
    // The stall detectors watch startup, then follow focus (a window shown in the background never gets a blur event).
    setTimeout(() => setPerfFocus(BrowserWindow.getFocusedWindow() !== null), 5000).unref()
  })
  win.webContents.once('did-finish-load', () => perfMark('window:did-finish-load'))
  const url = rendererUrl()
  const isAppPage = appPageMatcher(url)
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    // Never hand file:, custom-scheme or javascript: URLs to the OS.
    if (isExternalLink(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  // This window only ever shows GHOST: a followed link or a file dropped on the window must not
  // replace the app (that page would also get the window.ghost bridge). Web links open in the browser.
  win.webContents.on('will-navigate', (e, target) => {
    const action = navigationAction(target, isAppPage)
    if (action === 'allow') return
    e.preventDefault()
    if (action === 'external') void shell.openExternal(target)
  })
  void win.loadURL(url)
  return win
}

startMainPerf()

app.whenReady().then(async () => {
  perfMark('app:ready')
  // Debug: main-process stall / slow-SQL / IPC / art stats for profiling (scripts/cdp.mjs eval).
  ipcMain.handle('ghost:perf', (_e, reset?: boolean) => ({ ...perfStats(!!reset), ipc: ipcStats(!!reset), art: artStats(!!reset) }))
  // Services before the window: they take ~10 ms, and they start the catalog worker, whose boot
  // (~100 ms on its own thread) then overlaps the window's; the restored session is usually in
  // place before the first paint.
  try {
    handle = await createServices(((event, payload) => {
      if (event === 'player:state') onPlayerState(payload as Parameters<typeof onPlayerState>[0])
      broadcast(event, payload)
    }) as typeof broadcast)
  } catch (e) {
    console.error('[main] GHOST could not start:', e)
    dialog.showErrorBox('GHOST could not start', e instanceof Error ? e.message : String(e))
    app.quit()
    return
  }
  registerIpc(handle.services)
  createWindow()
  perfMark('window:created')
  // After the window (its page can't request ghost-art:// before this task ends).
  handleArtProtocol()
  // Dev only (~20 ms to decode the icon): after the window, off its critical path.
  if (devIcon && process.platform === 'darwin') {
    setImmediate(() => {
      try {
        app.dock?.setIcon(devIcon)
      } catch (e) {
        console.warn('[main] dev dock icon:', (e as Error).message)
      }
    })
  }
  setTimeout(() => void migrateLegacyCache(), 10_000).unref()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Stall detectors only run while GHOST has focus (see perf.ts).
app.on('browser-window-focus', () => setPerfFocus(true))
app.on('browser-window-blur', () => setImmediate(() => setPerfFocus(BrowserWindow.getFocusedWindow() !== null)))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void handle?.shutdown()
})

app.on('will-quit', () => {
  // Children of the catalog worker (yt-dlp downloads can run for minutes) don't end with us.
  killTrackedChildren()
  closeDb()
})
