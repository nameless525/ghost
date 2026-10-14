// Provider registry. The resolver asks providers in the user's priority order
// (settings.sources.order, minus settings.sources.disabled).
//
// Adding a provider (YouTube via yt-dlp, Internet Archive, local files, chiptune archives…):
//   1. Implement `Provider` from ./types — usually `findTrack` (search for candidates of a canonical
//      track and score them, DESIGN §6.4) plus `resolveStream` (locator → StreamInfo[]; return
//      `{ kind: 'file', path }` sources for local files, set `expiresAt` for short-lived URLs).
//   2. Register it in `createDefaultRegistry` with the id used in settings (DEFAULT_SOURCE_ORDER:
//      'local', 'chip', 'bandcamp', 'khinsider', 'archive', 'youtube').
// The catalog caches every resolved stream in the `sources` table, ranks them (provider order,
// then the quality ladder, then confidence) and demotes ones the engine reports as failed.

import type { Settings } from '../../shared/types'
import type { HttpClient } from '../net/http'
import { KhinsiderProvider } from './khinsider'
import type { Provider } from './types'

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

export function createDefaultRegistry(http: HttpClient): ProviderRegistry {
  return new ProviderRegistry().register(new KhinsiderProvider(http))
}

export type { Provider } from './types'
