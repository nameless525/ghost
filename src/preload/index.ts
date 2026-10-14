// Preload bridge: exposes `window.ghost` (GhostAPI) by routing every method in
// API_METHODS through one IPC channel, plus the synchronous analysis reader.
import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS, IPC_EVENT, IPC_INVOKE, type GhostEventName } from '../shared/api'
import { createAnalysisReader } from './analysis'

type Tree = { [k: string]: Tree | ((...args: unknown[]) => Promise<unknown>) }

function buildApi(): Tree {
  const root: Tree = {}
  for (const path of API_METHODS) {
    const parts = path.split('.')
    let node = root
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Tree
    node[parts[parts.length - 1]] = (...args: unknown[]) => ipcRenderer.invoke(IPC_INVOKE, path, args)
  }
  return root
}

const listeners = new Map<string, Set<(payload: unknown) => void>>()
ipcRenderer.on(IPC_EVENT, (_e, name: string, payload: unknown) => {
  listeners.get(name)?.forEach((cb) => cb(payload))
})

const api = {
  ...buildApi(),
  /** Debug: main-process perf stats (not part of GhostAPI). */
  __perf: (reset?: boolean) => ipcRenderer.invoke('ghost:perf', reset),
  analysis: createAnalysisReader(),
  on(event: GhostEventName, cb: (payload: unknown) => void) {
    let set = listeners.get(event)
    if (!set) listeners.set(event, (set = new Set()))
    set.add(cb)
    return () => set!.delete(cb)
  }
}

contextBridge.exposeInMainWorld('ghost', api)
