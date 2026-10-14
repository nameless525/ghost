// LibraryAPI: likes, history, downloaded tracks and playlists.
import type { LibraryAPI } from '../../shared/api'
import type { ID } from '../../shared/types'
import { Library, type LibraryDeps } from './library'
import { Playlists } from './playlists'

export { Library, type LibraryCatalog, type LibraryDeps } from './library'
export { Playlists, SMART_LIMIT, PlaylistNotFoundError } from './playlists'
export { DownloadsRepo, type DownloadRecord } from './downloads-repo'
export { ensureLibrarySchema } from './schema'
export { renderM3U, exportPlaylistM3U } from './m3u'

export interface LibraryHandle {
  library: Library
  playlists: Playlists
  api: LibraryAPI
}

export function createLibrary(deps: LibraryDeps): LibraryHandle {
  const library = new Library(deps)
  const playlists = new Playlists(library, deps.catalog, deps.broadcast)
  const api: LibraryAPI = {
    playlists,
    toggleLike: async (trackId: ID) => library.toggleLike(trackId),
    liked: () => library.liked(),
    history: (limit?: number) => library.history(limit),
    downloaded: () => library.downloaded()
  }
  return { library, playlists, api }
}
