// Shuffle algorithms. Pure functions with an injectable RNG so tests are deterministic.

export type Rng = () => number

export interface ShuffleEntry {
  /** Grouping key that must not repeat back-to-back (the game, or the album when there's no game). */
  group: string
  liked: boolean
}

/** Weight of a liked track relative to a normal one in smart shuffle. */
export const LIKED_WEIGHT = 3

export function fisherYates<T>(items: T[], rng: Rng = Math.random): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Smart shuffle: never plays two tracks from the same game back-to-back when that is avoidable,
 * and liked tracks tend to come up earlier (weighted random draw without replacement).
 *
 * At every step we draw among the items whose group differs from the previous one. A group
 * is forced when leaving it for later would make the spacing impossible (classic
 * "rearrange so no two adjacent are equal" feasibility: a group with m items among n
 * remaining needs m <= n - m + 1).
 *
 * @param prevGroup group of the track playing right before the shuffled run (the current track).
 */
export function smartShuffle<T>(items: T[], entry: (t: T) => ShuffleEntry, prevGroup: string | null = null, rng: Rng = Math.random): T[] {
  const pool = items.map((item) => ({ item, ...entry(item) }))
  const counts = new Map<string, number>()
  for (const p of pool) counts.set(p.group, (counts.get(p.group) ?? 0) + 1)
  const out: T[] = []
  let prev = prevGroup
  while (pool.length) {
    const n = pool.length
    let maxGroup: string | null = null
    let maxCount = 0
    for (const [g, c] of counts) {
      if (c > maxCount || (c === maxCount && g !== prev && maxGroup === prev)) {
        maxGroup = g
        maxCount = c
      }
    }
    let candidates: number[]
    if (maxGroup !== null && maxGroup !== prev && maxCount > n - maxCount) {
      // Forced: this group needs every other slot from here on.
      candidates = pool.flatMap((p, i) => (p.group === maxGroup ? [i] : []))
    } else {
      candidates = pool.flatMap((p, i) => (p.group !== prev ? [i] : []))
      if (candidates.length === 0) candidates = pool.map((_, i) => i) // unavoidable repeat
    }
    let total = 0
    for (const i of candidates) total += pool[i].liked ? LIKED_WEIGHT : 1
    let r = rng() * total
    let pick = candidates[candidates.length - 1]
    for (const i of candidates) {
      r -= pool[i].liked ? LIKED_WEIGHT : 1
      if (r < 0) {
        pick = i
        break
      }
    }
    const [chosen] = pool.splice(pick, 1)
    const c = counts.get(chosen.group)! - 1
    if (c === 0) counts.delete(chosen.group)
    else counts.set(chosen.group, c)
    out.push(chosen.item)
    prev = chosen.group
  }
  return out
}

/** Number of adjacent pairs sharing a group (0 when the order is perfectly spaced). */
export function adjacentRepeats<T>(items: T[], group: (t: T) => string, prevGroup: string | null = null): number {
  let n = 0
  let prev = prevGroup
  for (const it of items) {
    const g = group(it)
    if (g === prev) n++
    prev = g
  }
  return n
}

/** Minimum achievable adjacent repeats for a multiset of groups (used to verify smart shuffle). */
export function minAdjacentRepeats(groups: string[], prevGroup: string | null = null): number {
  const counts = new Map<string, number>()
  for (const g of groups) counts.set(g, (counts.get(g) ?? 0) + 1)
  const n = groups.length
  let worst = 0
  for (const [g, m] of counts) {
    // With prev = g, the group effectively has one extra member placed in front.
    const mm = g === prevGroup ? m + 1 : m
    const nn = g === prevGroup ? n + 1 : n
    worst = Math.max(worst, mm - (nn - mm) - 1)
  }
  return Math.max(0, worst)
}
