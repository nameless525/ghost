/** 83000 → '1:23', 3723000 → '1:02:03'. Negative/invalid → '0:00'. */
export function formatTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '0:00'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/**
 * Sum of values that may be unknown (null): null when none is known, `partial` when only some
 * are. Unknown durations/counts must read as unknown ("–"), never as 0.
 */
export function sumKnown(values: Iterable<number | null | undefined>): { total: number; partial: boolean } | null {
  let total = 0
  let known = 0
  let unknown = 0
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) unknown++
    else {
      total += v
      known++
    }
  }
  return known ? { total, partial: unknown > 0 } : null
}

/** Format a sumKnown() result: "–" when unknown, a trailing "+" when only partly known. */
export function formatSum(sum: { total: number; partial: boolean } | null, fmt: (n: number) => string = String): string {
  return sum ? fmt(sum.total) + (sum.partial ? '+' : '') : '–'
}
