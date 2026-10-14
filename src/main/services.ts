// Composition root for the main-process services implementing GhostServices.
// Owned by the player/library workstream; this placeholder keeps the app bootable.
import type { GhostServices } from '../shared/api'
import type { Broadcast } from './ipc'

export interface ServicesHandle {
  services: GhostServices
  /** Extra args for the renderer preload (native addon path, shm name). */
  preloadArgs: string[]
  shutdown(): Promise<void>
}

export async function createServices(_broadcast: Broadcast): Promise<ServicesHandle> {
  const notImpl = () => {
    throw new Error('not implemented yet')
  }
  const services = new Proxy({} as GhostServices, {
    get: () => new Proxy({}, { get: () => notImpl })
  })
  return { services, preloadArgs: [], shutdown: async () => {} }
}
