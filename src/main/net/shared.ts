// The process-wide host scheduler and HTTP client. The art protocol, the main process' own page
// requests and the catalog worker's (over RPC, see rpc-fetch.ts) all wait their turn in the one
// scheduler, so per-host limits (≤2 concurrent, ≥250 ms apart for KHInsider), Retry-After pauses and
// block cooldowns hold across the whole app.
import { paths } from '../paths'
import { createHostScheduler, createHttpClient, type HostScheduler, type HttpClient } from './http'

let scheduler: HostScheduler | null = null
let shared: HttpClient | null = null

export function sharedScheduler(): HostScheduler {
  return (scheduler ??= createHostScheduler({ log: (m) => console.log(`[http] ${m}`) }))
}

export function sharedHttp(): HttpClient {
  if (!shared) shared = createHttpClient({ cacheDir: paths.htmlCache(), scheduler: sharedScheduler(), log: (m) => console.log(`[http] ${m}`) })
  return shared
}

/** Replace the shared client (tests, smoke scripts). */
export function setSharedHttp(client: HttpClient | null): void {
  shared = client
}
