// Progress math for Browse's waits (pure, no DOM): estimates for waits main doesn't report on its
// own, the "Search elsewhere" bar (one segment per source, each filling on its own estimate and
// completing when that source answers) and nesting one wait's steps inside a bigger wait's bar.
import type { ExternalAlbumHit, ExternalProviderId, Progress } from '@shared/types'
import { progressValue } from '../../ui/progress'

// ---------------------------------------------------------------- album track lists

/** An album's track list without a 'progress' task (yet): a source page fetch usually takes about this long. */
export const ALBUM_EXPECT_MS = 1800
/** A group's album list (a local catalog query) that is visibly slow: the worker is busy, give it about this. */
export const ALBUMS_EXPECT_MS = 900

/** Stand-in for an album fetch main hasn't reported (an estimate from when the fetch started). */
export function albumFallback(since: number, label = 'Loading tracks'): Progress {
  return { label, detail: null, fraction: null, expectMs: ALBUM_EXPECT_MS, since }
}

/** `p` placed within [a, b] of a bigger wait's bar (its own span nested inside), so steps of different origins share one monotonic bar. */
export function nestSpan<P extends Progress>(p: P, [a, b]: [number, number]): P {
  const [s0, s1] = p.span ?? [0, 1]
  return { ...p, span: [a + (b - a) * s0, a + (b - a) * s1] }
}

// ---------------------------------------------------------------- "Search elsewhere"

/**
 * How long each web source usually takes to answer a search: YouTube and SoundCloud go through
 * yt-dlp (6–10 s), the Internet Archive and Bandcamp are plain HTTP (about 1 s and 1–2 s).
 */
export const SEARCH_EXPECT_MS: Record<ExternalProviderId, number> = {
  youtube: 8000,
  soundcloud: 8000,
  archive: 1200,
  bandcamp: 1600
}
const SEARCH_FALLBACK_MS = 3000

/** Answer times seen this session (an exponentially weighted mean per source). */
const learned = new Map<string, number>()

export function searchExpectMs(id: ExternalProviderId): number {
  return Math.round(learned.get(id) ?? SEARCH_EXPECT_MS[id] ?? SEARCH_FALLBACK_MS)
}

/** A source answered after `ms`: later searches estimate with it. */
export function recordSearchMs(id: ExternalProviderId, ms: number): void {
  if (!(ms > 0) || ms > 120_000) return
  const prev = learned.get(id) ?? SEARCH_EXPECT_MS[id] ?? SEARCH_FALLBACK_MS
  learned.set(id, prev + 0.35 * (Math.max(150, ms) - prev))
}

/** Test hook: forget what was learned. */
export function resetSearchTimes(): void {
  learned.clear()
}

export type SourceOutcome = 'done' | 'failed'

export interface SearchSegment {
  id: ExternalProviderId
  /** pending: still searching (fills on its estimate); done / failed: answered (full). */
  state: 'pending' | SourceOutcome
  progress: Progress
}

/** One segment per source, in order. A source that answered is complete, whatever it answered. */
export function searchSegments(ids: ExternalProviderId[], outcome: Partial<Record<ExternalProviderId, SourceOutcome>>, startedAt: number): SearchSegment[] {
  return ids.map((id) => {
    const state = outcome[id] ?? 'pending'
    const progress: Progress = state === 'pending' ? { label: id, fraction: null, expectMs: searchExpectMs(id), since: startedAt } : { label: id, fraction: 1, expectMs: null, since: startedAt }
    return { id, state, progress }
  })
}

/** The whole search as one 0..1 value at `now` (segments weigh the same: k of N, plus the pending ones' estimates). */
export function searchValue(segments: SearchSegment[], now = Date.now()): number {
  if (!segments.length) return 0
  let sum = 0
  for (const s of segments) sum += s.state === 'pending' ? (progressValue(s.progress, now) ?? 0) : 1
  return sum / segments.length
}

/**
 * The bar's caption: "Searching YouTube, SoundCloud…" with "2 of 4 sources" while it runs, then
 * "Searched 4 sources" (and which ones failed).
 */
export function searchCaption(ids: ExternalProviderId[], outcome: Partial<Record<ExternalProviderId, SourceOutcome>>, name: (id: ExternalProviderId) => string): { label: string; detail: string | null } {
  const pending = ids.filter((id) => !outcome[id])
  const answered = ids.length - pending.length
  if (pending.length) return { label: `Searching ${pending.map(name).join(', ')}…`, detail: `${answered} of ${ids.length} source${ids.length === 1 ? '' : 's'}` }
  const failed = ids.filter((id) => outcome[id] === 'failed')
  return {
    label: `Searched ${ids.length === 1 ? name(ids[0]) : `${ids.length} sources`}`,
    detail: failed.length ? `${failed.map(name).join(', ')} didn’t answer` : null
  }
}

// ---------------------------------------------------------------- imports

/**
 * How long importing a result usually takes when main doesn't say: SoundCloud sets resolve every
 * track (about a second each), a YouTube playlist or video about 4 s, the others about 1.5 s.
 */
export function importExpectMs(hit: Pick<ExternalAlbumHit, 'provider' | 'trackCount'>): number {
  if (hit.provider === 'soundcloud') return Math.max(1500, 1000 * (hit.trackCount ?? 8))
  if (hit.provider === 'youtube') return 4000
  return 1500
}
