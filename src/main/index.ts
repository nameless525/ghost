import { app, BrowserWindow, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpc, broadcast } from './ipc'
import { createServices, type ServicesHandle } from './services'
import { handleArtProtocol, registerArtScheme } from './net/art-protocol'

app.setName('GHOST')

const here = dirname(fileURLToPath(import.meta.url))
registerArtScheme()

let handle: ServicesHandle | null = null

function createWindow(preloadArgs: string[]): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#0f0d17',
    title: 'GHOST',
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'resources/icon.png'),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 14 },
    titleBarOverlay: isMac ? undefined : { color: '#00000000', symbolColor: '#e8e4f8', height: 40 },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments: preloadArgs
    }
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(here, '../renderer/index.html'))
  return win
}

app.whenReady().then(async () => {
  handleArtProtocol()
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(app.getAppPath(), 'resources/icon.png'))
  handle = await createServices(broadcast)
  registerIpc(handle.services)
  createWindow(handle.preloadArgs)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(handle!.preloadArgs)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void handle?.shutdown()
})
