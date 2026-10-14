// Structural sharing for state pushed over IPC. Every push is a fresh structured clone, so
// without this every object in it (the current track, the queue, the analysis) changes
// identity on every heartbeat and every selector returning one re-renders its component.
//
//   store.setState(share(store.getState(), incoming), true)
//
// share(prev, next) returns `prev` itself when `next` is deep-equal to it; otherwise a copy of
// `next` in which every deep-equal branch is the corresponding branch of `prev`. Plain objects
// and arrays only (what IPC delivers); anything else is compared by identity / value.

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}

export function share<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev
  if (Array.isArray(prev) && Array.isArray(next)) {
    const n = next.length
    let same = prev.length === n
    const out = new Array(n)
    for (let i = 0; i < n; i++) {
      const v = i < prev.length ? share(prev[i], next[i]) : next[i]
      out[i] = v
      if (same && v !== prev[i]) same = false
    }
    return (same ? prev : out) as T
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = Object.keys(next)
    let same = keys.length === Object.keys(prev).length
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      const v = share(prev[k], next[k])
      out[k] = v
      if (same && (v !== prev[k] || !(k in prev))) same = false
    }
    return (same ? prev : out) as T
  }
  return next
}
