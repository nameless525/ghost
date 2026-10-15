// Composition root for the main-process services implementing GhostServices.
// Wires the DB, settings, catalog, audio engine, player, library and downloads together.
// Nothing here assumes a window exists: all pushes go through `broadcast`.
import { app, BrowserWindow, dialog, shell, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import { IPC_EVENT, type GhostServices } from '../shared/api'
import { defaultSettings } from '../shared/defaults'
import type { BrowseQuery, CatalogStatus, GhostNotification } from '../shared/types'
import { GHOST_VERSION } from '../shared/version'
import type { CatalogService } from './catalog'
import { createCatalogHost, type CatalogHost } from './catalog/host'
import { TaskReporter, watchArchiveDownload } from './catalog/tasks'
import { openDb } from './db'
import { DownloadManager } from './downloads'
import { loadEngine, preloadArgsFor } from './engine/native'
import { NullEngine } from './engine/null'
import type { ArchiveListing, EngineBridge, EngineSource } from './engine/types'
import type { Broadcast } from './ipc'
import { createLibrary } from './library'
import { dataDir, paths } from './paths'
import { perfMark } from './perf'
import { FileSessionStore, Player } from './player'
import { applyEngineSettings, createSettingsService, SettingsStore } from './settings'

export interface ServicesHandle {
  services: GhostServices
  /** Extra args for the renderer preload (native addon path, shm name). */
  preloadArgs: string[]
  shutdown(): Promise<void>
}

const USER_AGENT = `GHOST/${GHOST_VERSION}`

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
    suggest: async () => [],
    sources: async () => [],
    getAnalysis: async () => null,
    recordAnalysis: () => {},
    resolveSources: async () => [],
    markSourceFailed: () => {},
    warmSources: () => {},
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
  // The catalog worker shares this file on its own connection (WAL). Wait for its write lock rather
  // than failing with SQLITE_BUSY, and leave checkpoints to the worker so a large WAL is never
  // folded back on this thread.
  db.exec('PRAGMA busy_timeout = 3000; PRAGMA wal_autocheckpoint = 0;')
  const settingsStore = new SettingsStore(join(dataDir(), 'settings.json'), defaultSettings(paths.defaultDownloads()))
  const getSettings = () => settingsStore.peek()
  perfMark('services:db+settings')

  // --- catalog ---------------------------------------------------------------
  // Runs in a worker thread (catalog/worker.ts): its SQLite queries, crawling and HTML parsing would
  // otherwise stall this thread, which also delivers native window input on macOS. `catalog` is an
  // RPC proxy; calls queue until the worker is up (spawned below, after startup writes are done).
  // Chiptune rip albums list their archive through the engine, created after the catalog. Opening
  // one waits on its download (up to 32 MB): an engine that can say how far that is (cacheProgress)
  // gives the album's bar real bytes.
  let engineRef: EngineBridge | null = null
  const tasks = new TaskReporter((p) => broadcast('progress', p))
  const inspectArchive = (source: EngineSource, ctx?: { progressKey?: string }): Promise<ArchiveListing> => {
    const e = engineRef
    if (!e?.inspectArchive) return Promise.reject(new Error('The audio engine is unavailable, so chiptune rip sets can’t be opened.'))
    const work = e.inspectArchive(source)
    const key = ctx?.progressKey
    if (!key || source.kind !== 'http' || typeof e.cacheProgress !== 'function') return work
    return watchArchiveDownload(work, () => e.cacheProgress!(source.cacheKey), key, tasks)
  }
  // The catalog's progress reports for the player, which is created below (none can be waiting before).
  let playerRef: Player | null = null
  let catalogHost: CatalogHost | null = null
  let catalog: CatalogService
  try {
    catalogHost = createCatalogHost({
      dbPath: paths.db(),
      dataDir: dataDir(),
      settings: settingsStore.get(),
      broadcast,
      inspectArchive,
      onResolveStep: (step) => playerRef?.onResolveStep(step),
      onToolProgress: (p) => playerRef?.onToolProgress(p),
      onFatal: (e) => {
        console.error('[services] catalog failed to load:', e)
        notices.push({ id: 'startup-catalog', kind: 'error', title: 'Catalog unavailable', body: errMessage(e) })
      }
    })
    catalog = catalogHost.catalog
  } catch (e) {
    console.error('[services] catalog failed to load:', e)
    catalog = unavailableCatalog(errMessage(e))
    notices.push({ id: 'startup-catalog', kind: 'error', title: 'Catalog unavailable', body: errMessage(e) })
  }
  // Background work (crawl, art prefetch) starts once the worker is up.
  catalog.start()
  perfMark('services:catalog-host')

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
  engineRef = engine
  applyEngineSettings(engine, settingsStore.peek(), null)
  perfMark('services:engine')

  // --- library, player, downloads --------------------------------------------
  const { library, playlists, api: libraryApi } = createLibrary({ db, catalog, broadcast, getSettings })
  perfMark('services:library')

  const sessionStore = new FileSessionStore(join(dataDir(), 'session.json'))
  const player = new Player({
    engine,
    catalog,
    library,
    playlists,
    getSettings,
    setLoopMode: (mode) => void settingsStore.set({ audio: { loopMode: mode } }),
    broadcast,
    session: sessionStore,
    mark: perfMark,
    // A dragged volume slider calls setVolume ~120×/s: echo it at most ~30×/s (status changes are immediate).
    echoIntervalMs: 33
  })
  playerRef = player

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
    else if (e.type === 'devices') broadcast('player:devices', e.devices)
    else player.handleEngineEvent(e)
  })

  settingsStore.onChange((next, prev) => {
    catalogHost?.setSettings(next)
    applyEngineSettings(engine, next, prev)
    player.onSettingsChanged(next)
  })
  library.onTracksChanged((ids) => player.refreshTracks(ids))

  const settingsApi = createSettingsService({ store: settingsStore, broadcast, pickFolder })

  // --- restore ---------------------------------------------------------------
  // Not awaited: the window shouldn't wait on the catalog worker (restore fetches the queue's
  // tracks through it); the restored state is broadcast when it lands.
  void player
    .restore(sessionStore.load())
    .then(() => perfMark('session:restored'))
    .catch((e) => console.error('[services] session restore failed:', e))
  downloads.resume()
  // Startup writes on this connection are done: let the catalog worker open the DB now.
  catalogHost?.spawn()
  perfMark('services:done')
  if (process.env.GHOST_PERF_LOG) void catalog.status().then(() => perfMark('catalog:first-answer'), () => {})

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
      random: (text) => catalog.random(text),
      suggest: (text, limit) => catalog.suggest(text, limit),
      sources: () => catalog.sources(),
      warmSources: async (ids) => catalog.warmSources(Array.isArray(ids) ? ids.slice(0, 3) : []),
      searchExternal: (query, providers) => catalog.searchExternal(query, providers),
      importExternal: async (hit, opts) => {
        const d = await catalog.importExternal(hit, opts)
        return { ...d, tracks: library.decorate(d.tracks) }
      }
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
        if (catalogHost) catalogHost.dispose()
        else catalog.stop()
      } catch (e) {
        console.error('[services] catalog shutdown failed:', e)
      }
    }
  }
}
