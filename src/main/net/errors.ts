// Typed network/provider errors. Electron IPC only carries `message` across to the renderer, so
// the code is also encoded as a `[code]` prefix: the UI can test `message.startsWith('[blocked]')`.

export type NetErrorCode =
  /** A bot-protection block or challenge page (e.g. Cloudflare). Not retried; tell the user. */
  | 'blocked'
  | 'not_found'
  | 'http'
  | 'network'
  | 'timeout'
  | 'aborted'
  /** The page loaded but didn't have the structure we expected (site changed?). */
  | 'parse'

export class NetError extends Error {
  readonly code: NetErrorCode
  readonly status: number | null
  readonly url: string | null
  readonly retryable: boolean

  constructor(code: NetErrorCode, message: string, opts: { status?: number | null; url?: string | null; retryable?: boolean; cause?: unknown } = {}) {
    super(`[${code}] ${message}`, opts.cause ? { cause: opts.cause } : undefined)
    this.name = 'NetError'
    this.code = code
    this.status = opts.status ?? null
    this.url = opts.url ?? null
    this.retryable = opts.retryable ?? (code === 'network' || code === 'timeout' || (code === 'http' && (opts.status ?? 0) >= 500))
  }
}

export function isNetError(e: unknown, code?: NetErrorCode): e is NetError {
  return e instanceof NetError && (code === undefined || e.code === code)
}

/** Recover the code from an error message that crossed IPC. */
export function errorCode(e: unknown): NetErrorCode | null {
  if (e instanceof NetError) return e.code
  const m = /^\[([a-z_]+)\]/.exec(String((e as Error)?.message ?? e))
  return (m?.[1] as NetErrorCode) ?? null
}

export function blockedMessage(host: string): string {
  return `${host} is blocking requests from GHOST (bot protection). Open https://${host} in your browser, then try again in a few minutes.`
}

/** Stream errors meaning "this URL is no longer valid for us" (a freshly resolved one usually works). */
export const ACCESS_DENIED = /\b(?:HTTP\s*)?(?:401|403|410)\b|forbidden|expired|\bgone\b/i
