import { create } from 'zustand'
import type { DeepPartial, Settings } from '@shared/types'
import { defaultSettings } from '@shared/defaults'
import { ghost } from '../ghost'

export const useSettings = create<Settings>(() => defaultSettings(''))

export function initSettingsStore(): void {
  void ghost().settings.get().then((s) => useSettings.setState(s, true))
  ghost().on('settings:changed', (s) => useSettings.setState(s, true))
}

export function updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
  return ghost().settings.set(patch)
}
