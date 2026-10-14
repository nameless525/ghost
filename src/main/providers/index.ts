// Provider registry. The resolver asks providers in the user's priority order
// (settings.sources.order, minus settings.sources.disabled).
//
// Adding a provider:
//   1. Implement `Provider` from ./types — usually `findTrack` (search for candidates of a canonical
//      track and score them, DESIGN §6.4, helpers in ./match) plus `resolveStream` (locator →
//      StreamInfo[]; return `{ kind: 'file', path }` sources for local files, set `expiresAt` for
//      short-lived URLs). Network searches set `findTrackMode: 'fallback'` so they only run when
//      the album's own sources failed. `searchExternal` + `getAlbum` make it importable.
//   2. Register it in `createDefaultRegistry` with the id used in settings (DEFAULT_SOURCE_ORDER:
//      'local', 'chip', 'bandcamp', 'khinsider', 'zophar', 'modland', 'archive', 'soundcloud',
//      'youtube'). Index providers crawl in registration order; the first one (KHInsider) builds
//      the catalog and the others follow it.
// The catalog caches every resolved stream in the `sources` table, ranks them (provider order,
// then the quality ladder, then confidence) and demotes ones the engine reports as failed.

import type { Settings } from '../../shared/types'
import type { DB } from '../db'
import type { ArchiveListing, EngineSource } from '../engine/types'
import type { HttpClient } from '../net/http'
import { sharedYtDlp, type YtDlp } from '../tools/ytdlp'
import { ArchiveProvider } from './archive'
import { BandcampProvider } from './bandcamp'
import { ChipProvider } from './chip'
import { KhinsiderProvider } from './khinsider'
import { LocalLibrary, LocalProvider } from './local'
import type { Provider } from './types'
import { YouTubeProvider } from './youtube'
import { ZopharProvider } from './zophar'

export class ProviderRegistry {
  private providers = new Map<string, Provider>()

  register(p: Provider): this {
    this.providers.set(p.id, p)
    return this
  }

  unregister(id: string): void {
    this.providers.delete(id)
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id)
  }

  all(): Provider[] {
    return [...this.providers.values()]
  }

  /** Enabled providers in priority order; registered providers missing from `order` go last. */
  ordered(sources: Pick<Settings['sources'], 'order' | 'disabled'>): Provider[] {
    const disabled = new Set(sources.disabled)
    const out: Provider[] = []
    for (const id of sources.order) {
      const p = this.providers.get(id)
      if (p && !disabled.has(id) && !out.includes(p)) out.push(p)
    }
    for (const p of this.providers.values()) if (!disabled.has(p.id) && !out.includes(p)) out.push(p)
    return out
  }
}

export interface RegistryDeps {
  /** The app DB (local files index). Without it there is no local-files provider. */
  db?: DB
  /** yt-dlp (default: the shared instance under <userData>/bin). */
  ytdlp?: () => Promise<YtDlp>
  /** fetch for archive.org's JSON APIs. */
  fetch?: typeof fetch
  /** The engine's archive lister, for chiptune rip sets (without it their albums can't open). */
  inspectArchive?: (source: EngineSource) => Promise<ArchiveListing>
  log?: (msg: string) => void
}

export function createDefaultRegistry(http: HttpClient, deps: RegistryDeps = {}): ProviderRegistry {
  const log = deps.log ?? ((m: string) => console.log(`[sources] ${m}`))
  const r = new ProviderRegistry()
  if (deps.db) r.register(new LocalProvider(new LocalLibrary(deps.db, { log })))
  return r
    .register(new ChipProvider({ http, inspectArchive: deps.inspectArchive, log: (m) => log(`chip: ${m}`) }))
    .register(new BandcampProvider(http))
    .register(new KhinsiderProvider(http))
    .register(new ZopharProvider(http))
    .register(new ArchiveProvider({ fetch: deps.fetch }))
    .register(new YouTubeProvider(deps.ytdlp ?? sharedYtDlp, { log }))
}

export type { Provider } from './types'
