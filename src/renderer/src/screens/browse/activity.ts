// Wording helpers for catalog activity (kept out of the component module for Fast Refresh).

const MIN = 60_000
export const DAY = 24 * 3600_000

/** "under a minute", "about 3 min", "about 1 h 10 min". */
export function formatEta(ms: number): string {
  if (ms < 50_000) return 'under a minute'
  const m = Math.round(ms / MIN)
  if (m < 60) return `about ${m} min`
  const h = Math.floor(m / 60)
  return `about ${h} h${m % 60 ? ` ${m % 60} min` : ''}`
}

/** "every 3 days", "weekly", "every 2 weeks". */
export function formatEvery(ms: number): string {
  const d = Math.round(ms / DAY)
  if (d <= 1) return 'daily'
  if (d === 7) return 'weekly'
  if (d % 7 === 0) return `every ${d / 7} weeks`
  return `every ${d} days`
}

/** Compact form for the status line: "<1 min", "~3 min", "~1 h 10". */
export function formatEtaShort(ms: number): string {
  if (ms < 50_000) return '<1 min'
  const m = Math.round(ms / MIN)
  if (m < 60) return `~${m} min`
  return `~${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}`
}
