// Browse: GHOST's song select. Info wedge (left), the Game ▸ Albums ▸ Tracks carousel (right),
// the filter bar (top right) and the sheared footer. See carousel.ts for the virtualised engine.
import { Globe, RotateCcw, Settings } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AlbumDetail } from '@shared/types'
import { ghost } from '../../ghost'
import { tween } from '../../motion/tween'
import { isModalScopeActive, useKeybinding } from '../../shell/keys'
import { useScreenTransitions } from '../../shell/ScreenStack'
import type { ScreenProps } from '../../shell/types'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { useSettings } from '../../state/settings'
import { anyModalOverlay, DEFAULT_ACCENT, useUI } from '../../state/ui'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/util'
import type { SearchInputHandle } from '../../ui/SearchInput'
import {
  addSelectionToPlaylist,
  canAutoPreview,
  downloadSelection,
  likeSelection,
  playSelection,
  previewAlbumId,
  previewEnded,
  previewState,
  queueSelection,
  startPreview,
  stopPreview,
  togglePreview,
  toggleTitles
} from './actions'
import { activeCarousel, Carousel } from './carousel'
import { ExternalSearch, ExternalSearchDialog, useExternalSourceNames, type Phase } from './ExternalSearch'
import { Footer } from './Footer'
import { InfoWedge } from './InfoWedge'
import { formatEta } from './activity'
import { openSelectionMenu } from './menu'
import { browseModel } from './model'
import { openSearchOnline, setSearchText } from './query'
import { SearchBar } from './SearchBar'
import { naturalQuery, useBrowse, type SelInfo } from './store'
import { beginReveal, endReveal, useBrowseWaits } from './waits'
import './browse.css'

/** Props: lifecycle ('entering' | 'active' | 'exiting'), direction, from, to. */
export type BrowseScreenProps = ScreenProps

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

/** Background art + accent for a selection. */
function themeOf(sel: SelInfo): { art: string | null; accent: string } {
  const g = sel.group
  const art = sel.track?.hero ?? sel.detail?.game?.hero ?? g?.hero ?? sel.track?.cover ?? sel.album?.cover ?? g?.cover ?? null
  const accent = sel.track?.accent ?? sel.detail?.game?.accent ?? g?.accent ?? DEFAULT_ACCENT
  return { art, accent }
}

/**
 * After an import: refetch and land on the new album (switching the query if it's filtered out).
 * That can take a few catalog pages; the wedge shows the wait meanwhile.
 */
async function revealImported(d: AlbumDetail): Promise<void> {
  beginReveal(d.album.title)
  try {
    await reveal(d)
  } finally {
    endReveal()
  }
}

async function reveal(d: AlbumDetail): Promise<void> {
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
      menu: (info, at) => openSelectionMenu(info, at, info.id === useBrowse.getState().sel?.id)
    })
    return () => c.destroy()
  }, [])
  return <div ref={ref} className="bc" />
}

function EmptyState() {
  const total = useBrowse((s) => s.total)
  const loading = useBrowse((s) => s.loading)
  const catalogError = useBrowse((s) => s.catalogError)
  const query = browseModel.query.text
  // only while the empty state shows: catalog:status ticks several times a second while indexing
  const status = useBrowse((s) => (s.total === 0 && !s.loading ? s.status : null))
  const sources = useExternalSourceNames()
  const ref = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const autoQuery = useBrowse((s) => s.externalAuto)
  // revealing an import re-runs queries: don't flash the empty state (and its search) in between
  const revealing = useBrowseWaits((s) => !!s.reveal)
  const show = total === 0 && !loading && !revealing
  useEffect(() => {
    if (show && ref.current) tween(ref.current).clear().set({ opacity: 0, y: 18 }).fadeIn(300, 'outQuad').moveToY(0, 600, 'outQuint')
  }, [show, query])
  useEffect(() => {
    setSuggestions([])
    if (!show || !query || catalogError) return
    let live = true
    ghost()
      .catalog.suggest(naturalQuery(query), 5)
      .then((s) => live && setSuggestions(s))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [show, query, catalogError])
  if (!show) return null
  if (catalogError) {
    return (
      <div className="be" ref={ref}>
        <div className="be__mark be__mark--error">
          <RotateCcw />
        </div>
        <h2 className="be__title">Couldn’t read your catalog</h2>
        <p className="be__sub be__sub--error">{catalogError}</p>
        <Button variant="primary" size="lg" icon={<RotateCcw />} onClick={() => void browseModel.reload()}>
          Try again
        </Button>
      </div>
    )
  }
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
            <p className="be__sub">Check the spelling, or search online on {sources}. Anything you import shows up here.</p>
          )}
          <ExternalSearch key={query} query={naturalQuery(query)} auto={autoQuery === query} onPhase={setPhase} onImported={(d) => void revealImported(d)} />
        </>
      ) : status?.indexing ? (
        <>
          <h2 className="be__title">Setting up your catalog…</h2>
          <p className="be__sub">
            A one-time setup{status.etaMs != null ? ` (${formatEta(status.etaMs)} left)` : ''}: games appear here as they’re found. Afterwards, sources refresh quietly in the background.
          </p>
        </>
      ) : (
        <>
          <h2 className="be__title">Your catalog is empty</h2>
          <p className="be__sub">Turn on or re-index sources in Settings, or search online for a soundtrack to import.</p>
          <div className="be__actions">
            <Button variant="secondary" size="lg" icon={<Settings />} onClick={() => useUI.getState().toggleOverlay('settings', true)}>
              Open Settings
            </Button>
            <Button variant="primary" size="lg" icon={<Globe />} onClick={() => openSearchOnline()}>
              Search online
            </Button>
          </div>
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
    const off = useBrowse.subscribe((s, p) => {
      if (s.sel?.id === p.sel?.id) return
      window.clearTimeout(t)
      const a = s.sel?.album
      if (a && !s.sel?.detail) t = window.setTimeout(() => void browseModel.loadDetail(a.id), 150)
    })
    return () => {
      off()
      window.clearTimeout(t)
    }
  }, [])

  // ---- resting on a track: resolve its stream URL (and the next one's) ahead of Enter, so the play
  // starts without a source-page round trip (the catalog bounds and dedupes these)
  useEffect(() => {
    let t = 0
    const off = useBrowse.subscribe((s, p) => {
      if (s.sel?.id === p.sel?.id) return
      window.clearTimeout(t)
      const sel = s.sel
      const track = sel?.track
      if (!track || !sel.detail || track.downloaded) return
      const i = sel.detail.tracks.findIndex((x) => x.id === track.id)
      const ids = sel.detail.tracks.slice(Math.max(0, i), Math.max(0, i) + 2).map((x) => x.id)
      t = window.setTimeout(() => void Promise.resolve(ghost().catalog.warmSources(ids)).catch(() => {}), 450)
    })
    return () => {
      off()
      window.clearTimeout(t)
    }
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
    // The player itself ends a preview when the queue starts playing (from anywhere: the now-playing
    // bar, media keys…) or at its time limit; keep our bookkeeping in step.
    const offPlayer = usePlayer.subscribe((s, p) => {
      if (p.preview && !s.preview) previewEnded(p.preview.track.id)
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
      // Toasts stack top-right, where Search online sits: in Browse they start under the search panel.
      const app = document.getElementById('g-app')
      if (app) {
        let y = top
        for (let n: HTMLElement | null = host; n && n !== app; n = n.offsetParent as HTMLElement | null) y += n.offsetTop
        app.style.setProperty('--toasts-top', `${y + 4}px`)
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (searchWrap.current) ro.observe(searchWrap.current)
    if (footerWrap.current) ro.observe(footerWrap.current)
    if (host) ro.observe(host)
    return () => {
      ro.disconnect()
      document.getElementById('g-app')?.style.removeProperty('--toasts-top')
    }
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
  // ⌘↵ searches online (what's typed, else an empty dialog); in the box itself SearchBar catches it
  useKeybinding('Mod+Enter', () => openSearchOnline(), { repeat: false })
  useKeybinding('Mod+F', () => {
    input.current?.focus()
    input.current?.select()
  })
  useKeybinding('Alt+J', toggleTitles, { repeat: false })

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
            // Nothing in the catalog: Enter searches online instead.
            const text = browseModel.query.text
            if (useBrowse.getState().total === 0 && text) useBrowse.setState({ externalAuto: text })
            else activeCarousel?.recenter()
          }}
        />
      </div>
      <div ref={footerWrap} className="browse__footer">
        <Footer />
      </div>
      <ExternalSearchDialog onImported={(d) => void revealImported(d)} />
    </div>
  )
}
