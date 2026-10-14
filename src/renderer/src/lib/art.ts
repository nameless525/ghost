// Resolve an artwork URL for <img> and WebGL use. In Electron, remote art is routed through the
// cached, CORS-enabled `ghost-art://` protocol; in the browser mock, URLs are used as-is.
const inElectron = typeof window !== 'undefined' && !import.meta.env.GHOST_WEB_MOCK

export function artUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (!inElectron || !/^https?:/i.test(url)) return url
  return `ghost-art://img/?u=${encodeURIComponent(url)}`
}
