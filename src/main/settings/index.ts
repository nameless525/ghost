// SettingsAPI implementation. Electron-specific bits (the folder picker) are injected.
import type { SettingsAPI } from '../../shared/api'
import type { DeepPartial, Settings } from '../../shared/types'
import type { Broadcast } from '../ipc'
import type { SettingsStore } from './store'

export { SettingsStore, sanitizeSettings, writeFileAtomic } from './store'
export { applyEngineSettings, loopParams } from './engine'

export interface SettingsServiceDeps {
  store: SettingsStore
  broadcast: Broadcast
  /** Native folder picker; resolves to the chosen directory or null. */
  pickFolder: (defaultPath: string) => Promise<string | null>
}

export function createSettingsService({ store, broadcast, pickFolder }: SettingsServiceDeps): SettingsAPI {
  // `next` is the store's own (never mutated, replaced on every set) object; send() serialises it.
  store.onChange((next) => broadcast('settings:changed', next))
  return {
    async get(): Promise<Settings> {
      return store.get()
    },
    async set(patch: DeepPartial<Settings>): Promise<Settings> {
      return store.set(patch ?? {})
    },
    async pickFolder(): Promise<string | null> {
      return pickFolder(store.peek().library.downloadDir)
    }
  }
}
