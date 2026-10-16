// Page requests across threads. Electron's `net.fetch` (Chromium's network stack, which KHInsider's
// Cloudflare accepts where Node's fetch is refused) only exists in the main process, and so does the
// app's one HostScheduler (per-host limits, Retry-After pauses, block cooldowns, retries), which the
// art protocol uses too. So the catalog worker's HttpClient sends each request to main as plain
// data, with its priority, timeout and retries; main runs it in its host's turn and replies with the
// body as a transferred ArrayBuffer, or the NetError. Cancelling the call takes the request out of
// the queue (or aborts it), and one the worker moves up while it waits moves up in main's queue. The
// HTML disk cache, and sharing one request among callers, stay in the worker's HttpClient.

import { NetError } from './errors'
import type { HostScheduler, NetRequest } from './http'
import type { Priority } from './limiter'

export interface WireRequest {
  url: string
  /** The request, to run in its host's turn (`id`: what a later `promote` refers to). */
  request?: NetRequest & { id: string }
  /** Move the waiting request `id` up to `priority` (answered at once, without a body). */
  promote?: { id: string; priority: Priority }
}

export interface WireResponse {
  /** Final URL after redirects. */
  url: string
  status: number
  contentType: string | null
  body: ArrayBuffer | null
}

export type SendRequest = (req: WireRequest, opts: { signal?: AbortSignal }) => Promise<WireResponse>

/** Worker side: a HostScheduler whose requests wait their turn in the main process' (see above). */
export function remoteScheduler(send: SendRequest): HostScheduler {
  // (ids only need to tell apart this worker's requests waiting in main)
  const tag = Math.random().toString(36).slice(2)
  let seq = 0
  return {
    async request(url, req, signal, onQueued) {
      const id = `${tag}.${++seq}`
      onQueued?.((priority) => void send({ url, promote: { id, priority } }, {}).catch(() => {}))
      let r: WireResponse
      try {
        r = await send({ url, request: { ...req, id } }, { signal })
      } catch (e) {
        // (the RPC's own cancellation is a DOM AbortError)
        if (signal?.aborted) throw new NetError('aborted', 'request aborted', { url })
        throw e
      }
      return { url: r.url, status: r.status, contentType: r.contentType, body: new Uint8Array(r.body ?? new ArrayBuffer(0)) }
    },
    limiter: () => {
      throw new Error('Per-host limits are kept by the main process.')
    },
    // (main fails a blocked host's requests fast)
    blockedUntil: () => 0
  }
}

/** Requests from the worker waiting in main's queues, by id: how to move each up. */
const waiting = new Map<string, (p: Priority) => void>()

/** Main side: run one wire request with `scheduler` (main's), and return the reply plus the buffers to transfer. */
export async function serveFetch(scheduler: HostScheduler, req: WireRequest, signal: AbortSignal): Promise<{ res: WireResponse; transfer: ArrayBuffer[] }> {
  if (req.promote) {
    waiting.get(req.promote.id)?.(req.promote.priority)
    return { res: { url: req.url, status: 204, contentType: null, body: null }, transfer: [] }
  }
  if (!req.request) throw new Error('Nothing to fetch.')
  const { id, ...r } = req.request
  try {
    const out = await scheduler.request(req.url, r, signal, (promote) => waiting.set(id, promote))
    const b = out.body
    const body = (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer) as ArrayBuffer
    return { res: { url: out.url, status: out.status, contentType: out.contentType, body }, transfer: body.byteLength ? [body] : [] }
  } finally {
    waiting.delete(id)
  }
}
