import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SOURCE_ORDER, defaultSettings, withKnownSources } from '../../shared/defaults'
import { FakeEngine, fakeBroadcast } from '../player/testing'
import { applyEngineSettings, createSettingsService, loopParams, SettingsStore } from './index'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'ghost-settings-'))
  dirs.push(d)
  return d
}

const defaults = defaultSettings('/Users/me/Music/GHOST')

describe('withKnownSources', () => {
  it('slots sources added in a later version next to their default neighbours', () => {
    const v1 = ['local', 'chip', 'bandcamp', 'khinsider', 'archive', 'youtube']
    expect(withKnownSources(v1)).toEqual(DEFAULT_SOURCE_ORDER)
    // a user's own arrangement survives
    expect(withKnownSources(['youtube', 'khinsider', 'local', 'chip', 'bandcamp', 'archive'])).toEqual(['youtube', 'soundcloud', 'khinsider', 'zophar', 'modland', 'local', 'chip', 'bandcamp', 'archive'])
    expect(withKnownSources(['khinsider', 'khinsider'], ['khinsider'])).toEqual(['khinsider'])
  })
})

describe('SettingsStore', () => {
  it('starts from defaults and deep-merges patches, persisting atomically', () => {
    const dir = tmp()
    const file = join(dir, 'settings.json')
    const store = new SettingsStore(file, defaults)
    expect(store.get()).toEqual(defaults)
    const next = store.set({ audio: { crossfadeSec: 4, normalization: { targetLufs: -14 } }, sources: { order: ['youtube', 'khinsider'] } })
    expect(next.audio.crossfadeSec).toBe(4)
    expect(next.audio.normalization).toEqual({ enabled: true, targetLufs: -14, mode: 'auto' })
    expect(next.audio.gapless).toBe(true)
    // arrays are replaced; sources the saved order lacks are slotted in after their default neighbour
    expect(next.sources.order).toEqual(['youtube', 'soundcloud', 'local', 'chip', 'bandcamp', 'khinsider', 'zophar', 'modland', 'archive'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(next)
    expect(readdirSync(dir)).toEqual(['settings.json']) // no temp files left behind
    // reload
    expect(new SettingsStore(file, defaults).get()).toEqual(next)
  })

  it('fills in settings added after the file was written, and clamps bad values', () => {
    const file = join(tmp(), 'settings.json')
    writeFileSync(file, JSON.stringify({ audio: { crossfadeSec: 99, loopMode: 'bogus', loopCount: 0 }, library: { cacheMaxGb: -3, downloadDir: '' } }))
    const s = new SettingsStore(file, defaults).get()
    expect(s.audio.crossfadeSec).toBe(12)
    expect(s.audio.loopMode).toBe('album')
    expect(s.audio.loopCount).toBe(1)
    expect(s.library.cacheMaxGb).toBe(0.25)
    expect(s.library.downloadDir).toBe(defaults.library.downloadDir)
    expect(s.interface).toEqual(defaults.interface)
  })

  it('keeps list settings lists of non-empty strings, whatever the file or a patch holds', () => {
    const file = join(tmp(), 'settings.json')
    for (const bad of ['/Users/test/Music', { a: '/x' }, null, 42]) {
      writeFileSync(file, JSON.stringify({ sources: { localFolders: bad, disabled: bad, quality: 'high' } }))
      const s = new SettingsStore(file, defaults).get()
      expect(s.sources.localFolders).toEqual([])
      expect(s.sources.disabled).toEqual([])
      expect(s.sources.quality).toBe('high') // the rest of the file survives
    }
    writeFileSync(file, JSON.stringify({ sources: { localFolders: ['/m/a', 7, '', '  ', null, '/m/b'], disabled: ['youtube', {}, 'zophar'] } }))
    const store = new SettingsStore(file, defaults)
    expect(store.get().sources.localFolders).toEqual(['/m/a', '/m/b'])
    expect(store.get().sources.disabled).toEqual(['youtube', 'zophar'])
    // a patch from the renderer is checked the same way
    expect(store.set({ sources: { localFolders: '/m/c' as unknown as string[] } }).sources.localFolders).toEqual([])
    expect(store.set({ sources: { localFolders: ['/m/c', null as unknown as string] } }).sources.localFolders).toEqual(['/m/c'])
  })

  it('moves a corrupt file aside and uses defaults', () => {
    const dir = tmp()
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{ not json')
    const store = new SettingsStore(file, defaults)
    expect(store.get()).toEqual(defaults)
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir).some((f) => f.startsWith('settings.json.corrupt-'))).toBe(true)
  })

  it('get() returns a copy', () => {
    const store = new SettingsStore(join(tmp(), 's.json'), defaults)
    store.get().audio.gapless = false
    expect(store.get().audio.gapless).toBe(true)
  })
})

describe('settings service', () => {
  it('broadcasts settings:changed and forwards pickFolder', async () => {
    const bc = fakeBroadcast()
    const store = new SettingsStore(join(tmp(), 's.json'), defaults)
    const api = createSettingsService({ store, broadcast: bc.broadcast, pickFolder: async (d) => `${d}/picked` })
    const s = await api.set({ interface: { showFps: true } })
    expect(s.interface.showFps).toBe(true)
    expect(bc.last('settings:changed')?.interface.showFps).toBe(true)
    expect((await api.get()).interface.showFps).toBe(true)
    expect(await api.pickFolder()).toBe('/Users/me/Music/GHOST/picked')
  })
})

describe('applyEngineSettings', () => {
  it('applies everything at startup', () => {
    const e = new FakeEngine()
    const s = structuredClone(defaults)
    s.audio.device = 'dac'
    applyEngineSettings(e, s, null)
    expect(e.lastCall('setNormalization')).toEqual([true, -16, 'auto'])
    expect(e.lastCall('setGapless')).toEqual([true])
    expect(e.lastCall('setCrossfade')).toEqual([0])
    expect(e.lastCall('setLoop')).toEqual(['album', 2, 10])
    expect(e.lastCall('setDevice')).toEqual(['dac'])
  })

  it('does not touch the device at startup when following the system default', () => {
    const e = new FakeEngine()
    applyEngineSettings(e, defaults, null)
    expect(e.callsOf('setDevice')).toHaveLength(0)
  })

  it('re-applies only what changed, immediately, through the store listener', () => {
    const e = new FakeEngine()
    const store = new SettingsStore(join(tmp(), 's.json'), defaults)
    store.onChange((next, prev) => applyEngineSettings(e, next, prev))
    store.set({ audio: { normalization: { mode: 'album' } } })
    expect(e.calls.map((c) => c.method)).toEqual(['setNormalization'])
    expect(e.lastCall('setNormalization')).toEqual([true, -16, 'album'])
    e.calls = []
    store.set({ audio: { loopMode: 'custom', loopCount: 3, fadeSec: 5 } })
    expect(e.calls.map((c) => c.method)).toEqual(['setLoop'])
    expect(e.lastCall('setLoop')).toEqual(['custom', 3, 5])
    e.calls = []
    store.set({ audio: { gapless: false, crossfadeSec: 6, device: 'default' } })
    expect(e.calls.map((c) => c.method).sort()).toEqual(['setCrossfade', 'setGapless'])
    store.set({ audio: { device: 'dac' } })
    expect(e.lastCall('setDevice')).toEqual(['dac'])
    store.set({ audio: { device: 'default' } })
    expect(e.lastCall('setDevice')).toEqual([null])
    e.calls = []
    store.set({ interface: { parallax: false } })
    expect(e.calls).toEqual([])
  })

  it('loopParams follows the design: album = 2 loops + 10 s fade', () => {
    const a = structuredClone(defaults.audio)
    expect(loopParams({ ...a, loopMode: 'album', loopCount: 5, fadeSec: 3 })).toEqual(['album', 2, 10])
    expect(loopParams({ ...a, loopMode: 'custom', loopCount: 5, fadeSec: 3 })).toEqual(['custom', 5, 3])
    expect(loopParams({ ...a, loopMode: 'endless', fadeSec: 3 })).toEqual(['endless', 0, 3])
  })
})
