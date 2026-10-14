// `ghost-art://` protocol: serves remote artwork through Chromium's network stack with an
// on-disk cache and permissive CORS so the renderer can use it as WebGL textures.
// Implemented by the catalog/providers workstream.
import { protocol } from 'electron'

export const ART_SCHEME = 'ghost-art'

/** Must run before app 'ready'. */
export function registerArtScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ART_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
  ])
}

/** Call after app 'ready'. */
export function handleArtProtocol(): void {
  // TODO(catalog workstream): fetch via net.fetch, cache under paths.art(), add CORS headers.
}
