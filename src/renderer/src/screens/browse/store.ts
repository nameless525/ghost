// React-facing Browse state (selection summary, query, counts, catalog status) plus the
// module-level memory that restores the screen exactly as it was left.
import { create } from 'zustand'
import { parseSearch } from '@shared/search'
import type { Album, AlbumDetail, BrowseGroup, CatalogStatus, GroupBy, SortBy, TrackView } from '@shared/types'

export type SelKind = 'group' | 'album' | 'track'

/** Everything the wedge/footer/previews need about the current selection. */
export interface SelInfo {
  /** Changes whenever the selected item changes (used to key content animations). */
  id: string
  kind: SelKind
  gi: number
  group: BrowseGroup | null
  /** Albums of the selected group, once loaded. */
  albums: Album[] | null
  album: Album | null
  /** Detail of `album` (tracks), once loaded. */
  detail: AlbumDetail | null
  track: TrackView | null
  /** Index of `track` in `detail.tracks`. */
  trackIndex: number
}

export interface BrowseUIState {
  text: string
  group: GroupBy
  sort: SortBy
  total: number | null
  loading: boolean
  sel: SelInfo | null
  status: CatalogStatus | null
  /** "Search elsewhere" dialog. */
  externalOpen: boolean
  externalQuery: string
  /** Enter on a search with no results: run the web search for this query right away. */
  externalAuto: string | null
  /** F2 picks that Shift+F2 can rewind. */
  historyLen: number
}

export const useBrowse = create<BrowseUIState>(() => ({
  text: '',
  group: 'game',
  sort: 'title',
  total: null,
  loading: true,
  sel: null,
  status: null,
  externalOpen: false,
  externalQuery: '',
  externalAuto: null,
  historyLen: 0
}))

/** Carousel position memory (module scope: survives leaving Browse). */
export interface CarouselMemory {
  gi: number
  groupKey: string | null
  albumId: string | null
  trackId: string | null
  exAlbum: string | null
  collapsed: boolean
  scroll: number | null
  /** F2 history for Shift+F2. */
  history: { gi: number; groupKey: string | null; albumId: string | null; trackId: string | null }[]
}

export const memory: CarouselMemory = {
  gi: 0,
  groupKey: null,
  albumId: null,
  trackId: null,
  exAlbum: null,
  collapsed: false,
  scroll: null,
  history: []
}

export const GROUP_LABELS: Record<GroupBy, string> = {
  game: 'Game',
  album: 'Album',
  composer: 'Composer',
  franchise: 'Franchise',
  platform: 'Platform',
  year: 'Year'
}

export const GROUP_NOUNS: Record<GroupBy, [string, string]> = {
  game: ['game', 'games'],
  album: ['album', 'albums'],
  composer: ['composer', 'composers'],
  franchise: ['franchise', 'franchises'],
  platform: ['platform', 'platforms'],
  year: ['year', 'years']
}

export const SORT_LABELS: Record<SortBy, string> = {
  title: 'Title',
  year: 'Year',
  recent: 'Recently added',
  length: 'Length',
  intensity: 'Intensity',
  random: 'Random'
}

export const PROVIDER_NAMES: Record<string, string> = {
  khinsider: 'KHInsider',
  youtube: 'YouTube',
  yt: 'YouTube',
  archive: 'Internet Archive',
  bandcamp: 'Bandcamp',
  local: 'Local files',
  chip: 'Chiptune engine',
  zophar: 'Zophar’s Domain',
  modland: 'Modland',
  soundcloud: 'SoundCloud'
}

export const providerName = (p: string | null | undefined): string => (p ? (PROVIDER_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1)) : 'Unknown')

/** A web-search friendly version of a catalog query: free text (as typed) plus name-like filter values. */
export function naturalQuery(text: string): string {
  const p = parseSearch(text)
  const words: string[] = []
  for (const t of p.tokens) {
    if (t.type === 'text') words.push(t.text)
    else if (t.type === 'phrase') words.push(t.text.replace(/^["“「『]|["”」』]$/g, ''))
  }
  for (const f of p.filters) if (f.key === 'game' || f.key === 'franchise' || f.key === 'composer') words.push(f.value)
  return (words.join(' ') || text).trim()
}
