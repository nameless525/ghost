// Routes `ghost:invoke` calls to the GhostServices implementation and broadcasts events.
import { BrowserWindow, ipcMain } from 'electron'
import { API_METHODS, IPC_EVENT, IPC_INVOKE, type GhostEvents, type GhostEventName, type GhostServices } from '../shared/api'

const allowed = new Set<string>(API_METHODS)

export function registerIpc(services: GhostServices): void {
  ipcMain.handle(IPC_INVOKE, async (_e, path: string, args: unknown[]) => {
    if (!allowed.has(path)) throw new Error(`Unknown GHOST method: ${path}`)
    const parts = path.split('.')
    let target: any = services
    for (const p of parts.slice(0, -1)) target = target?.[p]
    const fn = target?.[parts[parts.length - 1]]
    if (typeof fn !== 'function') throw new Error(`GHOST method not implemented: ${path}`)
    return await fn.apply(target, args ?? [])
  })
}

export function broadcast<E extends GhostEventName>(event: E, payload: GhostEvents[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENT, event, payload)
  }
}

export type Broadcast = typeof broadcast
