// Session persistence: the queue, position and transport settings survive restarts.
import { readFileSync } from 'node:fs'
import type { PlayContext, RepeatMode, ShuffleMode } from '../../shared/types'
import { writeFileAtomic } from '../settings/store'

export interface SessionData {
  v: 1
  queue: { uid: string; trackId: string }[]
  /** Pre-shuffle order (uids) while shuffle is on. */
  originalOrder: string[] | null
  queueIndex: number
  positionMs: number
  shuffle: ShuffleMode
  repeat: RepeatMode
  volume: number
  muted: boolean
  context: PlayContext | null
  savedAt: number
}

export interface SessionStore {
  load(): SessionData | null
  save(data: SessionData): void
}

const SHUFFLES: ShuffleMode[] = ['off', 'on', 'smart']
const REPEATS: RepeatMode[] = ['off', 'all', 'one']

/** Validate untrusted JSON into SessionData (dropping anything malformed). */
export function parseSession(raw: unknown): SessionData | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || !Array.isArray(r.queue)) return null
  const queue = r.queue.filter(
    (q): q is { uid: string; trackId: string } => !!q && typeof q === 'object' && typeof (q as any).uid === 'string' && typeof (q as any).trackId === 'string'
  )
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return {
    v: 1,
    queue,
    originalOrder: Array.isArray(r.originalOrder) ? r.originalOrder.filter((u): u is string => typeof u === 'string') : null,
    queueIndex: Math.trunc(num(r.queueIndex, -1)),
    positionMs: Math.max(0, num(r.positionMs, 0)),
    shuffle: SHUFFLES.includes(r.shuffle as ShuffleMode) ? (r.shuffle as ShuffleMode) : 'off',
    repeat: REPEATS.includes(r.repeat as RepeatMode) ? (r.repeat as RepeatMode) : 'off',
    volume: Math.min(1, Math.max(0, num(r.volume, 0.8))),
    muted: r.muted === true,
    context: r.context && typeof r.context === 'object' ? (r.context as PlayContext) : null,
    savedAt: num(r.savedAt, 0)
  }
}

export class FileSessionStore implements SessionStore {
  /** JSON of the last saved queue array: a save while playing usually changes only the position. */
  private queueJson: { of: SessionData['queue']; json: string } | null = null

  constructor(private readonly file: string) {}

  load(): SessionData | null {
    try {
      return parseSession(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return null
    }
  }

  save(data: SessionData): void {
    try {
      const { queue, ...rest } = data
      if (this.queueJson?.of !== queue) this.queueJson = { of: queue, json: JSON.stringify(queue) }
      writeFileAtomic(this.file, `${JSON.stringify(rest).slice(0, -1)},"queue":${this.queueJson.json}}`)
    } catch (e) {
      console.error('[player] failed to save session:', e)
    }
  }
}

export class MemorySessionStore implements SessionStore {
  data: SessionData | null = null
  saves = 0
  load(): SessionData | null {
    return this.data ? structuredClone(this.data) : null
  }
  save(data: SessionData): void {
    this.data = structuredClone(data)
    this.saves++
  }
}
