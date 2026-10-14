// The process-wide HTTP client, shared by the art protocol and the catalog so per-host limits
// (≤2 concurrent, ≥250 ms apart for KHInsider) hold across the whole app.
import { join } from 'node:path'
import { paths } from '../paths'
import { createHttpClient, type HttpClient } from './http'

let shared: HttpClient | null = null

export function sharedHttp(): HttpClient {
  if (!shared) shared = createHttpClient({ cacheDir: join(paths.cache(), 'html'), log: (m) => console.log(`[http] ${m}`) })
  return shared
}

/** Replace the shared client (tests, smoke scripts). */
export function setSharedHttp(client: HttpClient | null): void {
  shared = client
}
