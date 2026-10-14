// Resolve an artwork URL for <img> and WebGL use. In Electron, remote art is routed through the
// cached, CORS-enabled `ghost-art://` protocol; in the browser mock, URLs are used as-is.
//
// Pass `w` (CSS px) to get a resized copy: it is scaled by devicePixelRatio and rounded UP to one
// of a few size buckets, so every component asking for "about this size" shares one URL (one
// decode, one browser-cache entry, one protocol-cache variant). Without `w`, the protocol serves
// its capped full-size copy (≤1600 px): only use that where the art really fills the screen.
const inElectron = typeof window !== 'undefined' && !import.meta.env.GHOST_WEB_MOCK

/** Device-pixel widths the art protocol caches (keep in sync with src/main/net/art-protocol.ts). */
export const ART_BUCKETS = [128, 256, 512, 768, 1024, 1600] as const

/** The bucket (device px) used for a CSS width `w` at the current devicePixelRatio. */
export function artBucket(w: number, dpr: number = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1): number {
  const px = Math.max(1, w * dpr)
  for (const b of ART_BUCKETS) if (px <= b) return b
  return ART_BUCKETS[ART_BUCKETS.length - 1]
}

export function artUrl(url: string | null | undefined, opts?: { w?: number; dpr?: number }): string | null {
  if (!url) return null
  if (!inElectron || !/^https?:/i.test(url)) return url
  const w = opts?.w ? `&w=${artBucket(opts.w, opts.dpr)}` : ''
  return `ghost-art://img/?u=${encodeURIComponent(url)}${w}`
}
