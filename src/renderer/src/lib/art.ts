// Resolve an artwork URL for <img> and WebGL use. In Electron, remote art is routed through the
// cached, CORS-enabled `ghost-art://` protocol; in the browser mock, URLs are used as-is.
// Pass `w` to get a resized copy (cached separately) — use it for thumbnails and carousel rows.
const inElectron = typeof window !== 'undefined' && !import.meta.env.GHOST_WEB_MOCK

export function artUrl(url: string | null | undefined, opts?: { w?: number }): string | null {
  if (!url) return null
  if (!inElectron || !/^https?:/i.test(url)) return url
  const w = opts?.w ? `&w=${Math.round(opts.w * (window.devicePixelRatio || 1))}` : ''
  return `ghost-art://img/?u=${encodeURIComponent(url)}${w}`
}
