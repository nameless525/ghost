// `fetch` across threads. Electron's `net.fetch` (Chromium's network stack, which KHInsider's
// Cloudflare accepts where Node's fetch is refused) only exists in the main process, so the catalog
// worker sends page requests to main as plain data, main runs them asynchronously and replies with
// status, headers and the body as a transferred ArrayBuffer. Politeness (per-host limiter),
// retries and the HTML disk cache stay in the worker's HttpClient on top of this.

import type { FetchLike } from './http'

export interface WireRequest {
  url: string
  method?: string
  headers?: [string, string][]
  body?: string | ArrayBuffer | null
  redirect?: RequestInit['redirect']
}

export interface WireResponse {
  /** Final URL after redirects. */
  url: string
  status: number
  statusText: string
  headers: [string, string][]
  /** null for null-body statuses (204, 304, …). */
  body: ArrayBuffer | null
}

export type SendRequest = (req: WireRequest, opts: { signal?: AbortSignal; transfer?: ArrayBuffer[] }) => Promise<WireResponse>

const NULL_BODY = new Set([101, 103, 204, 205, 304])

function headerPairs(h: RequestInit['headers']): [string, string][] {
  if (!h) return []
  if (h instanceof Headers) return [...h.entries()]
  if (Array.isArray(h)) return h.map(([k, v]) => [String(k), String(v)])
  return Object.entries(h).map(([k, v]) => [k, String(v)])
}

async function bodyOf(b: RequestInit['body']): Promise<string | ArrayBuffer | null> {
  if (b == null) return null
  if (typeof b === 'string') return b
  if (b instanceof ArrayBuffer) return b
  if (ArrayBuffer.isView(b)) return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  if (b instanceof URLSearchParams) return b.toString()
  // Blob, FormData, streams: let Response serialise them.
  return await new Response(b as ConstructorParameters<typeof Response>[0]).arrayBuffer()
}

/** Rebuild a WHATWG Response from a wire reply (with `url` set, as fetch would). */
export function toResponse(r: WireResponse): Response {
  const res = new Response(NULL_BODY.has(r.status) ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers })
  Object.defineProperty(res, 'url', { value: r.url, enumerable: true })
  return res
}

/** Worker side: a fetch that sends each request through `send` (an RPC to the main process). */
export function remoteFetch(send: SendRequest): FetchLike {
  return async (url, init = {}) => {
    const body = await bodyOf(init.body)
    const req: WireRequest = {
      url: String(url),
      method: init.method,
      headers: headerPairs(init.headers),
      body,
      redirect: init.redirect
    }
    const r = await send(req, { signal: init.signal ?? undefined, transfer: body instanceof ArrayBuffer ? [body] : undefined })
    return toResponse(r)
  }
}

/**
 * Main side: run one wire request with `fetchImpl` (Electron net.fetch) and return the reply plus
 * the buffers to transfer. Chromium's HTTP cache is bypassed (`cache: 'no-store'`): the worker keeps
 * its own disk cache, and Chromium's had grown to hundreds of MB duplicating it.
 */
export async function serveFetch(fetchImpl: FetchLike, req: WireRequest, signal: AbortSignal): Promise<{ res: WireResponse; transfer: ArrayBuffer[] }> {
  const init: RequestInit = {
    method: req.method,
    headers: req.headers,
    body: req.body ?? undefined,
    redirect: req.redirect,
    signal,
    cache: 'no-store'
  }
  const r = await fetchImpl(req.url, init)
  const body = NULL_BODY.has(r.status) ? null : await r.arrayBuffer()
  return {
    res: { url: r.url || req.url, status: r.status, statusText: r.statusText, headers: [...r.headers.entries()], body },
    transfer: body && body.byteLength ? [body] : []
  }
}
