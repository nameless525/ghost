// Request/response RPC over a worker_threads message channel (a Worker, `parentPort` or a
// MessagePort). Both ends are symmetric: each can `call` the other's handlers (with request ids,
// cancellation and transferable payloads) and send fire-and-forget `notify` messages.
//
// Errors cross as plain data and are rebuilt on the other side; NetErrors keep their class and code,
// so `isNetError()` / `errorCode()` and the `[code] message` prefix the UI relies on still work.

import { NetError, type NetErrorCode } from './errors'

/** The bits of MessagePort / Worker / parentPort we use. */
export interface PortLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MessagePort/Worker overloads
  postMessage(value: any, ...transferList: any[]): void
  on(event: 'message', listener: (value: unknown) => void): unknown
  off?(event: 'message', listener: (value: unknown) => void): unknown
}

export interface CallContext {
  /** Aborted when the caller cancels (its AbortSignal fired) or the endpoint closes. */
  signal: AbortSignal
}

export type Handler = (args: unknown[], ctx: CallContext) => unknown
export type NoteHandler = (...args: unknown[]) => void

export interface SerializedError {
  message: string
  name: string
  stack?: string
  code?: string
  status?: number | null
  url?: string | null
  retryable?: boolean
}

type Msg =
  | { t: 'call'; id: number; m: string; a: unknown[] }
  | { t: 'ok'; id: number; v: unknown }
  | { t: 'err'; id: number; e: SerializedError }
  | { t: 'cancel'; id: number }
  | { t: 'note'; m: string; a: unknown[] }

/** A value plus the ArrayBuffers to transfer (not copy) with it. */
export class Transfer<T> {
  constructor(
    readonly value: T,
    readonly list: ArrayBuffer[]
  ) {}
}
export const transfer = <T>(value: T, list: ArrayBuffer[]): Transfer<T> => new Transfer(value, list)

const NET_CODES = new Set<string>(['blocked', 'not_found', 'http', 'network', 'timeout', 'aborted', 'parse'])

export function serializeError(e: unknown): SerializedError {
  if (e instanceof NetError) return { message: e.message, name: e.name, stack: e.stack, code: e.code, status: e.status, url: e.url, retryable: e.retryable }
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
    return { message: e.message, name: e.name, stack: e.stack, code: typeof code === 'string' ? code : undefined }
  }
  return { message: String(e), name: 'Error' }
}

export function deserializeError(s: SerializedError): Error {
  let err: Error
  if (s.name === 'NetError' && s.code && NET_CODES.has(s.code)) {
    const prefix = `[${s.code}] `
    err = new NetError(s.code as NetErrorCode, s.message.startsWith(prefix) ? s.message.slice(prefix.length) : s.message, {
      status: s.status ?? null,
      url: s.url ?? null,
      retryable: s.retryable
    })
  } else if (s.name === 'AbortError') {
    err = new DOMException(s.message, 'AbortError')
  } else {
    err = new Error(s.message)
    if (s.name && s.name !== 'Error') err.name = s.name
    if (s.code) (err as { code?: string }).code = s.code
  }
  // Keep the remote stack for debugging (the local one is just the message pump).
  if (s.stack) err.stack = s.stack
  return err
}

export function abortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError')
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  done: () => void
}

export class RpcEndpoint {
  private seq = 0
  private pending = new Map<number, Pending>()
  private running = new Map<number, AbortController>()
  private closed: Error | null = null
  private readonly listener = (v: unknown) => this.onMessage(v as Msg)

  constructor(
    private readonly port: PortLike,
    private readonly handlers: Record<string, Handler> = {},
    private readonly notes: Record<string, NoteHandler> = {}
  ) {
    port.on('message', this.listener)
  }

  /** Requests waiting for a reply. */
  get inFlight(): number {
    return this.pending.size
  }

  call<T = unknown>(method: string, args: unknown[] = [], opts: { signal?: AbortSignal; transfer?: ArrayBuffer[] } = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    if (opts.signal?.aborted) return Promise.reject(abortError())
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        this.post({ t: 'cancel', id })
        reject(abortError())
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        done: () => opts.signal?.removeEventListener('abort', onAbort)
      })
      try {
        this.post({ t: 'call', id, m: method, a: args }, opts.transfer)
      } catch (e) {
        this.pending.delete(id)
        opts.signal?.removeEventListener('abort', onAbort)
        reject(e)
      }
    })
  }

  notify(method: string, ...args: unknown[]): void {
    if (this.closed) return
    this.post({ t: 'note', m: method, a: args })
  }

  /** Fail everything in flight (the other side is gone). Later calls reject with `reason`. */
  close(reason: Error): void {
    if (this.closed) return
    this.closed = reason
    this.port.off?.('message', this.listener)
    for (const p of this.pending.values()) {
      p.done()
      p.reject(reason)
    }
    this.pending.clear()
    for (const c of this.running.values()) c.abort()
    this.running.clear()
  }

  private post(msg: Msg, list?: ArrayBuffer[]): void {
    if (list?.length) this.port.postMessage(msg, list)
    else this.port.postMessage(msg)
  }

  private onMessage(msg: Msg): void {
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'call':
        void this.serve(msg)
        return
      case 'ok':
      case 'err': {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        p.done()
        if (msg.t === 'ok') p.resolve(msg.v)
        else p.reject(deserializeError(msg.e))
        return
      }
      case 'cancel':
        this.running.get(msg.id)?.abort()
        this.running.delete(msg.id)
        return
      case 'note': {
        const fn = this.notes[msg.m]
        if (!fn) return
        try {
          fn(...(msg.a ?? []))
        } catch (e) {
          console.error(`[rpc] note ${msg.m} failed:`, e)
        }
        return
      }
    }
  }

  private async serve(msg: Extract<Msg, { t: 'call' }>): Promise<void> {
    const ctl = new AbortController()
    this.running.set(msg.id, ctl)
    try {
      const fn = this.handlers[msg.m]
      if (!fn) throw new Error(`Unknown method: ${msg.m}`)
      const out = await fn(msg.a ?? [], { signal: ctl.signal })
      if (ctl.signal.aborted || this.closed) return
      if (out instanceof Transfer) this.post({ t: 'ok', id: msg.id, v: out.value }, out.list)
      else this.post({ t: 'ok', id: msg.id, v: out })
    } catch (e) {
      if (ctl.signal.aborted || this.closed) return
      try {
        this.post({ t: 'err', id: msg.id, e: serializeError(e) })
      } catch (e2) {
        console.error('[rpc] could not send an error reply:', e2)
      }
    } finally {
      this.running.delete(msg.id)
    }
  }
}
