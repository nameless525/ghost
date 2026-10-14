// Browse: GHOST's song select. Info wedge (left), the Game ▸ Albums ▸ Tracks carousel (right),
// the filter bar (top right) and the sheared footer. See carousel.ts for the virtualised engine.
import { Download, ListEnd, ListStart, Play, Shuffle, Telescope } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AlbumDetail } from '@shared/types'
import { ghost } from '../../ghost'
import { albumMenuItems, trackMenuItems } from '../../lib/track-actions'
import { tween } from '../../motion/tween'
import { isModalScopeActive, useKeybinding } from '../../shell/keys'
import { useScreenTransitions } from '../../shell/ScreenStack'
import type { ScreenProps } from '../../shell/types'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { updateSettings, useSettings } from '../../state/settings'
import { anyModalOverlay, DEFAULT_ACCENT, useUI } from '../../state/ui'
import { openContextMenu, type MenuItem } from '../../ui/ContextMenu'
import { cx } from '../../ui/util'
import type { SearchInputHandle } from '../../ui/SearchInput'
import {
  addSelectionToPlaylist,
  canAutoPreview,
  downloadSelection,
  likeSelection,
  playSelection,
  previewAlbumId,
  previewState,
  queueSelection,
  startPreview,
  stopPreview,
  togglePreview
} from './actions'
import { activeCarousel, Carousel } from './carousel'
import { ExternalSearch, ExternalSearchDialog, useExternalSourceNames, type Phase } from './ExternalSearch'
import { Footer } from './Footer'
import { InfoWedge } from './InfoWedge'
import { browseModel } from './model'
import { openExternalSearch, setSearchText } from './query'
import { SearchBar } from './SearchBar'
import { naturalQuery, useBrowse, type SelInfo } from './store'
import './browse.css'

/** Props: lifecycle ('entering' | 'active' | 'exiting'), direction, from, to. */
export type BrowseScreenProps = ScreenProps

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))
const ic = (I: typeof Play) => <I size={15} strokeWidth={2} />

/** Background art + accent for a selection. */
function themeOf(sel: SelInfo): { art: string | null; accent: string } {
  const g = sel.group
  const art = sel.track?.hero ?? sel.detail?.game?.hero ?? g?.hero ?? sel.track?.cover ?? sel.album?.cover ?? g?.cover ?? null
  const accent = sel.track?.accent ?? sel.detail?.game?.accent ?? g?.accent ?? DEFAULT_ACCENT
  return { art, accent }
}

function groupMenu(sel: SelInfo): MenuItem[] {
  const g = sel.group!
  return [
    { heading: g.title },
    { label: g.kind === 'game' ? 'Play soundtrack' : 'Play first album', icon: ic(Play), shortcut: 'Enter', onSelect: () => void playSelection(sel) },
    { label: 'Play next', icon: ic(ListStart), shortcut: 'Shift+Q', onSelect: () => void queueSelection(sel, 'next') },
    { label: 'Add to queue', icon: ic(ListEnd), shortcut: 'Q', onSelect: () => void queueSelection(sel, 'end') },
    { separator: true },
    { label: 'Download', icon: ic(Download), shortcut: 'Mod+D', onSelect: () => void downloadSelection(sel) },
    { label: 'Random pick', icon: ic(Shuffle), shortcut: 'F2', onSelect: () => void activeCarousel?.random() },
    { separator: true },
    { label: `Search elsewhere for “${g.title}”`, icon: ic(Telescope), onSelect: () => openExternalSearch(g.title) }
  ]
}

function openMenu(sel: SelInfo, at: { x: number; y: number }): void {
  if (sel.track && sel.detail) {
    const ids = sel.detail.tracks.map((t) => t.id)
    openContextMenu(
      at,
      trackMenuItems(sel.track, { playList: { ids, index: Math.max(0, sel.trackIndex), context: { kind: 'album', id: sel.detail.album.id, title: sel.detail.album.title } } })
    )
  } else if (sel.album) {
    openContextMenu(at, albumMenuItems(sel.album.id, sel.album.title, sel.detail?.tracks.map((t) => t.id) ?? null))
  } else if (sel.group) openContextMenu(at, groupMenu(sel))
}

/** After an import: refetch and land on the new album (switching the query if it's filtered out). */
async function revealImported(d: AlbumDetail): Promise<void> {
  const st = useBrowse.getState()
  const keyFor = () => {
    const g = useBrowse.getState().group
    if (g === 'game' && d.album.gameId) return `game:${d.album.gameId}`
    if (g === 'album') return `album:${d.album.id}`
    return null
  }
  await browseModel.reload()
  let key = keyFor()
  if (key && (await activeCarousel?.reveal(key, d.album.id))) return
  // not visible under the current query: search for it instead
  const name = d.game?.name ?? d.album.gameName ?? d.album.title
  if (st.group !== 'game' && st.group !== 'album') useBrowse.setState({ group: 'game' })
  setSearchText(name, true)
  await browseModel.setQuery({ text: name, group: useBrowse.getState().group, sort: st.sort })
  key = keyFor()
  if (key) await activeCarousel?.reveal(key, d.album.id)
}

function CarouselView() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const c = new Carousel(ref.current!, {
      activate: (info) => void playSelection(info),
      menu: (info, at) => openMenu(info, at)
    })
    return () => c.destroy()
  }, [])
  return <div ref={ref} className="bc" />
}

function EmptyState() {
  const total = useBrowse((s) => s.total)
  const loading = useBrowse((s) => s.loading)
  const query = browseModel.query.text
  const status = useBrowse((s) => s.status)
  const ref = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const autoQuery = useBrowse((s) => s.externalAuto)
  const show = total === 0 && !loading
  useEffect(() => {
    if (show && ref.current) tween(ref.current).clear().set({ opacity: 0, y: 18 }).fadeIn(300, 'outQuad').moveToY(0, 600, 'outQuint')
  }, [show, query])
  useEffect(() => {
    setSuggestions([])
    if (!show || !query) return
    let live = true
    ghost()
      .catalog.suggest(naturalQuery(query), 5)
      .then((s) => live && setSuggestions(s))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [show, query])
  if (!show) return null
  return (
    <div className={cx('be', query && phase !== 'idle' && 'be--results')} ref={ref}>
      <div className="be__mark">
        <svg viewBox="0 0 24 24" aria-hidden>
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="m20 20-3.6-3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      {query ? (
        <>
          <h2 className="be__title">
            Nothing in your catalog matches <span className="be__q">“{query}”</span>
          </h2>
          {suggestions.length > 0 ? (
            <div className="be__suggest" role="group" aria-label="Did you mean">
              <span className="be__suggest-label">Did you mean</span>
              {suggestions.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="be__chip"
                  onClick={() => {
                    sfx.play('select', { volume: 0.5 })
                    setSearchText(name, true)
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          ) : (
            <p className="be__sub">Check the spelling and filters, or look further afield. Imports land straight in Browse.</p>
          )}
          <ExternalSearch key={query} query={naturalQuery(query)} auto={autoQuery === query} onPhase={setPhase} onImported={(d) => void revealImported(d)} />
        </>
      ) : (
        <>
          <h2 className="be__title">{status?.indexing ? 'Building your catalog…' : 'Your catalog is empty'}</h2>
          <p className="be__sub">{status?.indexing ? (status.message ?? 'Indexing soundtrack sources. Games appear here as they’re found.') : 'Re-index your sources from Settings, or search the web for a soundtrack.'}</p>
        </>
      )}
    </div>
  )
}

/** With nothing in the carousel, arrow / page keys scroll the external results instead. */
function scrollEmptyResults(dir: number, page = false): boolean {
  if (useBrowse.getState().total !== 0) return false
  const list = document.querySelector<HTMLElement>('.be .bx__list')
  if (!list) return false
  list.scrollBy({ top: dir * (page ? list.clientHeight * 0.85 : 84), behavior: 'smooth' })
  return true
}

/** A few results: offer the wider search under the carousel. */
function FewResults() {
  const total = useBrowse((s) => s.total)
  const sources = useExternalSourceNames()
  const query = browseModel.query.text
  useBrowse((s) => s.loading)
  if (!query || total == null || total === 0 || total > 3) return null
  return (
    <div className="bfew">
      <span>Not what you’re after?</span>
      <button type="button" className="bfew__btn" title={`Search ${sources}`} onClick={() => openExternalSearch(naturalQuery(query))}>
        <Telescope />
        <span className="g-ellipsis">Search the web for “{naturalQuery(query)}”</span>
      </button>
    </div>
  )
}

export default function BrowseScreen(props: BrowseScreenProps) {
  const wedgeWrap = useRef<HTMLDivElement>(null)
  const searchWrap = useRef<HTMLDivElement>(null)
  const footerWrap = useRef<HTMLDivElement>(null)
  const input = useRef<SearchInputHandle>(null)
  const lifecycle = useRef(props.lifecycle)
  lifecycle.current = props.lifecycle

  // ---- first query (later visits restore instantly from the module-level model)
  useEffect(() => {
    if (!browseModel.started) {
      const { text, group, sort } = useBrowse.getState()
      void browseModel.setQuery({ text: text.trim(), group, sort })
    }
  }, [])

  // ---- catalog status: indexing progress + revision refreshes
  useEffect(() => {
    let timer = 0
    let pendingRefresh = false
    const onStatus = (s: Awaited<ReturnType<ReturnType<typeof ghost>['catalog']['status']>>) => {
      useBrowse.setState({ status: s })
      const rev = s.revision ?? null
      if (rev == null) return
      if (browseModel.revision == null) {
        browseModel.revision = rev
        return
      }
      if (rev === browseModel.revision) return
      browseModel.revision = rev
      if (timer) {
        pendingRefresh = true
        return
      }
      activeCarousel?.refreshData()
      timer = window.setTimeout(function flush() {
        timer = 0
        if (pendingRefresh) {
          pendingRefresh = false
          activeCarousel?.refreshData()
          timer = window.setTimeout(flush, s.indexing ? 2500 : 700)
        }
      }, s.indexing ? 2500 : 700)
    }
    void ghost().catalog.status().then(onStatus).catch(() => {})
    const off = ghost().on('catalog:status', onStatus)
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [])

  // ---- likes / downloads changed elsewhere: refresh the visible album
  useEffect(
    () =>
      ghost().on('library:changed', (e) => {
        if (e.kind !== 'likes' && e.kind !== 'downloaded') return
        const sel = useBrowse.getState().sel
        const id = sel?.detail?.album.id ?? sel?.album?.id
        if (id) browseModel.refreshDetail(id)
      }),
    []
  )

  // ---- background + accent follow the selection (debounced so fast scrolling doesn't thrash)
  useEffect(() => {
    let t = 0
    let last = ''
    const apply = () => {
      const sel = useBrowse.getState().sel
      if (!sel) return
      const { art, accent } = themeOf(sel)
      const dim = useSettings.getState().interface.backgroundDim
      const k = `${art}|${accent}|${dim}`
      if (k === last) return
      last = k
      const ui = useUI.getState()
      ui.setBackground(art, { dim, blur: 1 })
      ui.setAccent(accent)
    }
    apply()
    const offSel = useBrowse.subscribe((s, p) => {
      if (s.sel === p.sel) return
      window.clearTimeout(t)
      t = window.setTimeout(apply, 120)
    })
    const offDim = useSettings.subscribe((s, p) => {
      if (s.interface.backgroundDim !== p.interface.backgroundDim) apply()
    })
    return () => {
      window.clearTimeout(t)
      offSel()
      offDim()
    }
  }, [])

  // ---- album details for the wedge once the selection rests
  useEffect(() => {
    let t = 0
    return useBrowse.subscribe((s, p) => {
      if (s.sel?.id === p.sel?.id) return
      window.clearTimeout(t)
      const a = s.sel?.album
      if (a && !s.sel?.detail) t = window.setTimeout(() => void browseModel.loadDetail(a.id), 150)
    })
  }, [])

  // ---- osu!-style previews: rest on a selection for 400 ms while nothing is playing
  useEffect(() => {
    let t = 0
    const offSel = useBrowse.subscribe((s, p) => {
      if (s.sel?.id === p.sel?.id) return
      window.clearTimeout(t)
      const cur = previewState()
      const albumId = previewAlbumId(s.sel)
      if (cur && (!s.sel || cur.albumId !== albumId)) stopPreview()
      if (!s.sel) return
      const id = s.sel.id
      t = window.setTimeout(() => {
        const sel = useBrowse.getState().sel
        if (sel?.id !== id || lifecycle.current === 'exiting' || !canAutoPreview()) return
        void startPreview(sel)
      }, 400)
    })
    // real playback starting (from anywhere) ends an automatic preview
    const offPlayer = usePlayer.subscribe((s, p) => {
      if (s.status === 'playing' && p.status !== 'playing' && s.current?.id !== p.current?.id) stopPreview()
    })
    return () => {
      window.clearTimeout(t)
      offSel()
      offPlayer()
      stopPreview()
    }
  }, [])

  // ---- carousel insets follow the real search bar / footer sizes. Layout offsets, not
  // getBoundingClientRect: the enter choreography translates both while the first measure runs.
  useLayoutEffect(() => {
    const host = searchWrap.current?.parentElement
    /** Top of `el` within the screen, ignoring transforms. */
    const topIn = (el: HTMLElement): number => {
      let y = 0
      for (let n: HTMLElement | null = el; n && n !== host; n = n.offsetParent as HTMLElement | null) y += n.offsetTop
      return y
    }
    const measure = () => {
      const sw = searchWrap.current
      const fw = footerWrap.current
      if (!sw || !fw || !host) return
      const bs = sw.querySelector<HTMLElement>('.bs') ?? sw
      const top = Math.round(topIn(bs) + bs.offsetHeight + 6)
      const bottom = Math.round(host.clientHeight - topIn(fw) + 4)
      activeCarousel?.setInsets(top, bottom)
      // The empty state / external results live between the search panel and the footer too.
      host.style.setProperty('--browse-top', `${top}px`)
      host.style.setProperty('--browse-bottom', `${bottom}px`)
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (searchWrap.current) ro.observe(searchWrap.current)
    if (footerWrap.current) ro.observe(footerWrap.current)
    if (host) ro.observe(host)
    return () => ro.disconnect()
  }, [])

  // ---- typing anywhere searches (osu!); Q/L/P stay commands while the box isn't focused
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key.length !== 1 || e.key === ' ' || /^[qlp]$/i.test(e.key)) return
      if (lifecycle.current === 'exiting' || isModalScopeActive() || anyModalOverlay(useUI.getState())) return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.closest('[role="listbox"],[role="menu"],.g-popover,.g-dialog'))) return
      const el = input.current?.input
      if (!el) return
      el.focus({ preventScroll: true })
      const end = el.value.length
      el.setSelectionRange(end, end)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- keys
  const sel = () => useBrowse.getState().sel
  const c = () => activeCarousel
  const blurSearch = () => input.current?.blur()
  useKeybinding('ArrowDown', () => void (scrollEmptyResults(1) || c()?.move(1)), { allowInInput: true })
  useKeybinding('ArrowUp', () => void (scrollEmptyResults(-1) || c()?.move(-1)), { allowInInput: true })
  useKeybinding('ArrowLeft', () => void c()?.left())
  useKeybinding('ArrowRight', () => void c()?.right())
  useKeybinding('PageDown', () => void (scrollEmptyResults(1, true) || c()?.page(1)), { allowInInput: true })
  useKeybinding('PageUp', () => void (scrollEmptyResults(-1, true) || c()?.page(-1)), { allowInInput: true })
  useKeybinding('Home', () => void c()?.edge(false))
  useKeybinding('End', () => void c()?.edge(true))
  useKeybinding('Enter', () => void playSelection(sel()), { repeat: false })
  useKeybinding('Escape', () => {
    if (!useBrowse.getState().text) return false
    sfx.play('back', { volume: 0.6 })
    setSearchText('', true)
    blurSearch()
  })
  useKeybinding('F2', () => void (c()?.random() || sfx.play('error', { volume: 0.4 })), { repeat: false, allowInInput: true })
  useKeybinding('Shift+F2', () => void (c()?.rewind() || sfx.play('error', { volume: 0.4 })), { repeat: false, allowInInput: true })
  useKeybinding('P', () => void togglePreview(sel()), { repeat: false })
  useKeybinding('Q', () => void queueSelection(sel(), 'end'), { repeat: false })
  useKeybinding('Shift+Q', () => void queueSelection(sel(), 'next'), { repeat: false })
  useKeybinding('L', () => void likeSelection(sel()), { repeat: false })
  useKeybinding('Mod+S', () => void addSelectionToPlaylist(sel(), activeCarousel?.selectedRect() ?? { x: 400, y: 300 }), { repeat: false })
  useKeybinding('Mod+D', () => void downloadSelection(sel()), { repeat: false })
  useKeybinding(
    'Alt+J',
    () => {
      const on = !useSettings.getState().interface.preferOriginalTitles
      sfx.play(on ? 'toggleOn' : 'toggleOff', { volume: 0.55 })
      void updateSettings({ interface: { preferOriginalTitles: on } })
    },
    { repeat: false }
  )

  // ---- choreography
  useScreenTransitions({
    enter: ({ other }) => {
      const fromPlay = other === 'play'
      tween(wedgeWrap.current).clear().set({ opacity: 0, x: -180 }).delay(fromPlay ? 0 : 40).fadeIn(280, 'outQuad').moveToX(0, 700, 'outQuint')
      tween(searchWrap.current).clear().set({ opacity: 0, y: -50 }).delay(fromPlay ? 40 : 120).fadeIn(280, 'outQuad').moveToY(0, 650, 'outQuint')
      tween(footerWrap.current).clear().set({ opacity: 0, y: 64 }).delay(fromPlay ? 60 : 170).fadeIn(280, 'outQuad').moveToY(0, 650, 'outQuint')
      activeCarousel?.intro(0.6, fromPlay ? 200 : 320)
      return wait(fromPlay ? 650 : 850)
    },
    exit: ({ other }) => {
      stopPreview()
      const toPlay = other === 'play'
      if (toPlay) {
        tween(wedgeWrap.current).clear().fadeOut(220, 'inQuad').moveToX(-260, 300, 'inQuad')
        tween(searchWrap.current).clear().fadeOut(200, 'inQuad').moveToY(-40, 260, 'inQuad')
        tween(footerWrap.current).clear().fadeOut(200, 'inQuad').moveToY(50, 260, 'inQuad')
        return Promise.all([activeCarousel?.outro(true), wait(320)])
      }
      tween(searchWrap.current).clear().fadeOut(240, 'inQuad').moveToY(-50, 360, 'inQuad')
      tween(wedgeWrap.current).clear().delay(60).fadeOut(260, 'inQuad').moveToX(-200, 400, 'inQuad')
      tween(footerWrap.current).clear().delay(110).fadeOut(240, 'inQuad').moveToY(64, 360, 'inQuad')
      return Promise.all([activeCarousel?.outro(false), wait(520)])
    }
  })

  return (
    <div className="browse">
      <div ref={wedgeWrap} className="browse__wedge">
        <InfoWedge />
      </div>
      <CarouselView />
      <EmptyState />
      <div ref={searchWrap} className="browse__search">
        <SearchBar
          inputRef={input}
          onSubmit={() => {
            blurSearch()
            // Nothing in the catalog: Enter searches the web instead.
            const text = browseModel.query.text
            if (useBrowse.getState().total === 0 && text) useBrowse.setState({ externalAuto: text })
            else activeCarousel?.recenter()
          }}
        />
        <FewResults />
      </div>
      <div ref={footerWrap} className="browse__footer">
        <Footer />
      </div>
      <ExternalSearchDialog onImported={(d) => void revealImported(d)} />
    </div>
  )
}
