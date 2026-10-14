// Composition root for the main-process services implementing GhostServices.
// Wires the DB, settings, catalog, audio engine, player, library and downloads together.
// Nothing here assumes a window exists: all pushes go through `broadcast`.
import { app, BrowserWindow, dialog, shell, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import { IPC_EVENT, type GhostServices } from '../shared/api'
import { defaultSettings } from '../shared/defaults'
import type { BrowseQuery, CatalogStatus, GhostNotification } from '../shared/types'
import { createCatalog, type CatalogService } from './catalog'
import { openDb } from './db'
import { DownloadManager } from './downloads'
import { loadEngine, preloadArgsFor } from './engine/native'
import { NullEngine } from './engine/null'
import type { EngineBridge } from './engine/types'
import type { Broadcast } from './ipc'
import { createLibrary } from './library'
import { dataDir, paths } from './paths'
import { FileSessionStore, Player } from './player'
import { applyEngineSettings, createSettingsService, SettingsStore } from './settings'

export interface ServicesHandle {
  services: GhostServices
  /** Extra args for the renderer preload (native addon path, shm name). */
  preloadArgs: string[]
  shutdown(): Promise<void>
}

const USER_AGENT = 'GHOST/0.1'

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Notifications raised during startup are broadcast before any window exists, so they are
 * also replayed to each window once its renderer has loaded.
 */
function startupNotices(broadcast: Broadcast) {
  const sticky: GhostNotification[] = []
  const onWindow = (_e: unknown, win: BrowserWindow) => {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (win.isDestroyed()) return
        for (const n of sticky) win.webContents.send(IPC_EVENT, 'notify', n)
      }, 1500)
    })
  }
  app.on('browser-window-created', onWindow)
  return {
    push(n: GhostNotification) {
      sticky.push(n)
      broadcast('notify', n)
    },
    dispose() {
      app.off('browser-window-created', onWindow)
    }
  }
}

/**
 * Keeps the app usable (library, settings) when the catalog can't load. Methods not listed
 * (including ones added to CatalogService later) reject with the reason.
 */
function unavailableCatalog(reason: string): CatalogService {
  const message = `Catalog unavailable: ${reason}`
  const fail = async (): Promise<never> => {
    throw new Error(message)
  }
  const status: CatalogStatus = {
    indexing: false,
    games: 0,
    albums: 0,
    tracks: 0,
    progress: null,
    lastIndexedAt: null,
    message,
    enrichment: { igdb: false, steamGridDb: false }
  }
  const known: Partial<CatalogService> = {
    start() {},
    stop() {},
    status: async () => status,
    reindex: fail,
    browse: async (q: BrowseQuery) => ({ total: 0, offset: q.offset, groups: [] }),
    groupAlbums: async () => [],
    album: fail,
    game: async () => null,
    tracks: async () => [],
    searchTracks: async () => [],
    random: async () => null,
    getAnalysis: () => null,
    recordAnalysis: () => {},
    resolveSources: async () => [],
    markSourceFailed: () => {},
    albumOf: async () => null,
    queryTrackIds: async () => []
  }
  return new Proxy(known, {
    get: (target, key) => {
      if (key in target) return target[key as keyof CatalogService]
      return typeof key === 'symbol' || key === 'then' ? undefined : fail
    }
  }) as CatalogService
}

async function pickFolder(defaultPath: string): Promise<string | null> {
  const opts: OpenDialogOptions = {
    title: 'Choose a folder',
    defaultPath,
    properties: ['openDirectory', 'createDirectory', 'promptToCreate']
  }
  const win = BrowserWindow.getFocusedWindow()
  const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
}

export async function createServices(broadcast: Broadcast): Promise<ServicesHandle> {
  const notices = startupNotices(broadcast)

  // --- storage & settings ----------------------------------------------------
  const db = openDb(paths.db())
  const settingsStore = new SettingsStore(join(dataDir(), 'settings.json'), defaultSettings(paths.defaultDownloads()))
  const getSettings = () => settingsStore.peek()

  // --- catalog ---------------------------------------------------------------
  let catalog: CatalogService
  try {
    catalog = createCatalog({ db, broadcast, getSettings: () => settingsStore.get() })
  } catch (e) {
    console.error('[services] catalog failed to load:', e)
    catalog = unavailableCatalog(errMessage(e))
    notices.push({ id: 'startup-catalog', kind: 'error', title: 'Catalog unavailable', body: errMessage(e) })
  }
  try {
    catalog.start()
  } catch (e) {
    // Background work (crawl, art prefetch) failed to start; lookups may still work.
    console.error('[services] catalog background work failed to start:', e)
    notices.push({ id: 'startup-catalog-start', kind: 'error', title: 'Catalog indexing failed to start', body: errMessage(e) })
  }

  // --- audio engine ----------------------------------------------------------
  let engine: EngineBridge
  let preloadArgs: string[] = []
  try {
    engine = loadEngine({
      cacheDir: paths.cache(),
      cacheMaxBytes: Math.round(settingsStore.peek().library.cacheMaxGb * 1e9),
      userAgent: USER_AGENT
    })
    try {
      preloadArgs = preloadArgsFor(engine)
    } catch (e) {
      console.error('[services] no analysis region for the renderer:', e)
    }
  } catch (e) {
    const reason = errMessage(e)
    console.error('[services] audio engine unavailable:', reason)
    engine = new NullEngine(reason)
    notices.push({ id: 'startup-engine', kind: 'error', title: 'Audio engine unavailable', body: reason })
  }
  applyEngineSettings(engine, settingsStore.peek(), null)

  // --- library, player, downloads --------------------------------------------
  const { library, playlists, api: libraryApi } = createLibrary({ db, catalog, broadcast, getSettings })

  const sessionStore = new FileSessionStore(join(dataDir(), 'session.json'))
  const player = new Player({
    engine,
    catalog,
    library,
    playlists,
    getSettings,
    setLoopMode: (mode) => void settingsStore.set({ audio: { loopMode: mode } }),
    broadcast,
    session: sessionStore
  })

  const downloads = new DownloadManager({
    engine,
    catalog,
    library,
    playlists,
    getSettings,
    broadcast,
    shell: { showItemInFolder: (p) => shell.showItemInFolder(p), openPath: (p) => shell.openPath(p) }
  })

  engine.onEvent((e) => {
    if (e.type === 'download') downloads.handleEngineEvent(e)
    else player.handleEngineEvent(e)
  })

  settingsStore.onChange((next, prev) => {
    applyEngineSettings(engine, next, prev)
    player.onSettingsChanged(next)
  })
  library.onTracksChanged((ids) => player.refreshTracks(ids))

  const settingsApi = createSettingsService({ store: settingsStore, broadcast, pickFolder })

  // --- restore ---------------------------------------------------------------
  try {
    await Promise.race([player.restore(sessionStore.load()), new Promise((r) => setTimeout(r, 2500))])
  } catch (e) {
    console.error('[services] session restore failed:', e)
  }
  downloads.resume()

  // --- the API ---------------------------------------------------------------
  const services: GhostServices = {
    catalog: {
      status: () => catalog.status(),
      reindex: () => catalog.reindex(),
      browse: (q) => catalog.browse(q),
      groupAlbums: (groupKey, q) => catalog.groupAlbums(groupKey, q),
      album: async (albumId) => {
        const d = await catalog.album(albumId)
        return { ...d, tracks: library.decorate(d.tracks) }
      },
      game: (gameId) => catalog.game(gameId),
      tracks: async (ids) => library.decorate(await catalog.tracks(ids)),
      searchTracks: async (text, limit) => library.decorate(await catalog.searchTracks(text, limit)),
      random: (text) => catalog.random(text)
    },
    player,
    library: libraryApi,
    downloads,
    settings: settingsApi,
    system: {
      openExternal: async (url: string) => {
        if (!/^(https?:|mailto:)/i.test(String(url))) throw new Error('Only web links can be opened.')
        await shell.openExternal(url)
      },
      reveal: async (path: string) => {
        if (path) shell.showItemInFolder(path)
      },
      info: async () => ({ platform: process.platform, version: app.getVersion(), dataDir: app.getPath('userData'), mock: false })
    }
  }

  let stopped = false
  return {
    services,
    preloadArgs,
    shutdown: async () => {
      if (stopped) return
      stopped = true
      notices.dispose()
      // Synchronous first: before-quit doesn't wait for promises.
      try {
        player.dispose()
      } catch (e) {
        console.error('[services] player shutdown failed:', e)
      }
      downloads.dispose()
      try {
        engine.shutdown()
      } catch (e) {
        console.error('[services] engine shutdown failed:', e)
      }
      try {
        catalog.stop()
      } catch (e) {
        console.error('[services] catalog shutdown failed:', e)
      }
    }
  }
}
