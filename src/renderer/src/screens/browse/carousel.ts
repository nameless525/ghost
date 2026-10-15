// The song-select carousel: Game ▸ Albums ▸ Tracks, osu!lazer style.
//
// Virtualised and imperative. Only one group is expanded at a time (the selected one), so the
// layout is arithmetic: group i sits at i·GP (+ the expanded group's children height after
// it), and the children block is a small offsets array. Visible rows get a pooled DOM node;
// nodes are recycled per panel type and positioned with transform/opacity from one ticker
// callback. React never re-renders per frame (or per scroll step).
//
// Motion: the scroll position is a spring (follow-the-selection, wheel, drag-fling, F2 spin);
// every pooled panel damps its own displayed Y toward its layout target (so expanding and
// collapsing slide neighbours out of the way), sits on a gentle arc by distance from the
// focus line, nudges on hover, and the selected panel glows and pulses with the beat.
import type { Album, AlbumDetail, BrowseGroup, TrackView } from '@shared/types'
import { beat } from '../../motion/beat'
import { clamp, clamp01, damp as dampFn } from '../../motion/easing'
import { motionPrefs } from '../../motion/prefs'
import { Spring } from '../../motion/spring'
import { ticker, TickPriority } from '../../motion/ticker'
import { sfx } from '../../sound'
import { usePlayer } from '../../state/player'
import { useSettings } from '../../state/settings'
import { uiZoom } from '../../ui/util'
import { browseModel, PAGE_SIZE, type ModelEvent } from './model'
import { createPanel, fillAlbum, fillGroup, fillLoading, fillTrack, resetPanel, setClass, type PanelNode, type PanelType } from './panels'
import { memory, useBrowse, type SelInfo } from './store'

// ---------------------------------------------------------------- geometry

/** Panel height / pitch (height + gap) per row type. */
const GH = 84
const GP = 94
const AH = 54
const AP = 61
const TH = 38
const TP = 43
const LH = 38
const LP = 44
/** Extra space after an expanded block. */
const CHILD_TAIL = 10
/** Indentation per depth (game, album, track). */
const INDENT = [0, 46, 82]
/** Left margin of the carousel column. */
const BASE_X = 34
/** Selected panel slides left by this much (osu! pulls the selection towards the wedge). */
const SEL_X = 26
const HOVER_X = 12

/** Half-lives (ms) for per-panel damping. */
const Y_HALF = 62
const FX_HALF = 55

const ARC_R = 2.4
const ARC_K = 1.0

/** Free panels kept per type for reuse. */
const POOL_MAX = 16

export interface Sel {
  gi: number
  albumId: string | null
  trackId: string | null
}

interface Row {
  type: PanelType
  id: string
  gi: number
  depth: number
  album: Album | null
  track: TrackView | null
  /** Track index within its album's track list. */
  ti: number
  parent: string
  born: number
  h: number
  pitch: number
  /** Placeholder text for loading rows. */
  label?: string
  /** The track's album spans several discs (number tracks as disc·nn). */
  multiDisc?: boolean
}

interface Item {
  id: string
  type: PanelType
  gi: number
  row: Row | null
  node: PanelNode
  depth: number
  h: number
  /** Displayed layout Y (damped toward the target). */
  y: number
  /** Enter/exit X offset and alpha (screen choreography). */
  ex: number
  ea: number
  delay: number
  /** Birth / leave fade. */
  fade: number
  hover: number
  sel: number
  leaving: boolean
  leaveTo: string | null
  leaveX: number
  data: unknown
  ver: number
  lx: number
  ly: number
  lo: number
  lg: number
  /** Last written ring opacity. */
  lr: number
  ls: number
}

export interface CarouselHooks {
  /** Double-click / Enter: play the item. */
  activate(info: SelInfo): void
  /** Right-click. */
  menu(info: SelInfo, at: { x: number; y: number }): void
}

/** The carousel currently mounted (for keybindings in the screen). */
export let activeCarousel: Carousel | null = null

const sameSel = (a: Sel, b: Sel) => a.gi === b.gi && a.albumId === b.albumId && a.trackId === b.trackId

export class Carousel {
  readonly root: HTMLElement
  private layer: HTMLDivElement
  private hooks: CarouselHooks
  private model = browseModel

  private vw = 0
  private vh = 0
  private topInset = 150
  private bottomInset = 90
  private rect = { left: 0, top: 0 }

  private scroll = new Spring({ frequency: 2.6, damping: 1, precision: 0.05 })
  private follow = true
  private spin: { from: number; t0: number; dur: number; lastRow: number } | null = null
  private speed = 0
  private lastScroll = 0

  sel: Sel = { gi: 0, albumId: null, trackId: null }
  private exAlbum: string | null = null
  private collapsed = false
  private rows: Row[] = []
  private rowIndex = new Map<string, number>()
  private childOff: number[] = []
  private childrenH = 0
  /** Group whose children are shown (-1 = none). */
  private ex = -1
  private loadingKey: string | null = null
  private loadingSince = 0
  private loadingTimer = 0

  private groupItems = new Map<number, Item>()
  private childItems = new Map<string, Item>()
  private leavingItems: Item[] = []
  private pool: Record<PanelType, PanelNode[]> = { group: [], album: [], track: [], loading: [] }
  private ver = 0

  private pointer: { x: number; y: number } | null = null
  private drag: { id: number; y0: number; s0: number; moved: boolean; samples: { t: number; y: number }[] } | null = null
  private suppressClick = false

  private phase: 'idle' | 'intro' | 'outro' = 'idle'
  private phaseAt = 0
  private phaseStagger = 240
  private phaseDist = 0
  private awaitingFirstPage: { groupKey: string | null; albumId: string | null; trackId: string | null } | null = null
  private relocating = false
  /** Set by refreshData(): the selected group may move, follow it by key. */
  private refreshing: string | null = null
  private lastEnsure = 0
  private lastRange = -1
  private published: SelInfo | null = null
  private disposers: (() => void)[] = []
  private readonly preferOriginal = () => useSettings.getState().interface.preferOriginalTitles

  constructor(root: HTMLElement, hooks: CarouselHooks) {
    this.root = root
    this.hooks = hooks
    this.layer = document.createElement('div')
    this.layer.className = 'bc-layer'
    root.setAttribute('role', 'listbox')
    root.setAttribute('aria-label', 'Soundtracks')
    root.appendChild(this.layer)
    activeCarousel = this

    const ro = new ResizeObserver(() => this.measure())
    ro.observe(root)
    this.disposers.push(() => ro.disconnect())
    this.measure()

    this.listen(root, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false })
    this.listen(root, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent))
    this.listen(root, 'pointermove', (e) => this.onPointerMove(e as PointerEvent))
    this.listen(root, 'pointerup', (e) => this.onPointerUp(e as PointerEvent))
    this.listen(root, 'pointercancel', (e) => this.onPointerUp(e as PointerEvent))
    this.listen(root, 'pointerleave', () => (this.pointer = null))
    this.listen(root, 'click', (e) => this.onClick(e as MouseEvent))
    this.listen(root, 'dblclick', (e) => this.onDblClick(e as MouseEvent))
    this.listen(root, 'contextmenu', (e) => this.onContextMenu(e as MouseEvent))

    this.disposers.push(this.model.subscribe((e) => this.onModel(e)))
    this.disposers.push(beat.retain())
    let lastPlayer = ''
    this.disposers.push(
      usePlayer.subscribe((s) => {
        const k = `${s.current?.id ?? ''}|${s.status}`
        if (k !== lastPlayer) {
          lastPlayer = k
          this.ver++
        }
      })
    )
    let lastPref = this.preferOriginal()
    this.disposers.push(
      useSettings.subscribe((s) => {
        if (s.interface.preferOriginalTitles !== lastPref) {
          lastPref = s.interface.preferOriginalTitles
          this.ver++
          this.publish(true)
        }
      })
    )
    this.disposers.push(ticker.add((dt, now) => this.tick(dt, now), TickPriority.physics + 1))

    this.restore()
  }

  private listen(el: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    el.addEventListener(type, fn, opts)
    this.disposers.push(() => el.removeEventListener(type, fn, opts))
  }

  destroy(): void {
    this.persist()
    window.clearTimeout(this.loadingTimer)
    for (const d of this.disposers) d()
    this.disposers = []
    this.layer.remove()
    if (activeCarousel === this) activeCarousel = null
  }

  // ---------------------------------------------------------------- geometry helpers

  private measure(): void {
    const r = this.root.getBoundingClientRect()
    const z = uiZoom()
    this.rect = { left: r.left / z, top: r.top / z }
    this.vw = this.root.clientWidth
    this.vh = this.root.clientHeight
    this.root.style.setProperty('--bc-w', `${this.vw}px`)
  }

  /** Space reserved at the top (search bar) and bottom (footer); the focus line sits between. */
  setInsets(top: number, bottom: number): void {
    this.topInset = top
    this.bottomInset = bottom
  }

  private get focusY(): number {
    return Math.round(this.topInset + (this.vh - this.topInset - this.bottomInset) * 0.5)
  }

  private get total(): number {
    return this.model.total ?? 0
  }

  private groupY(gi: number): number {
    return gi * GP + (this.ex >= 0 && gi > this.ex ? this.childrenH : 0)
  }

  private childY(k: number): number {
    return (this.ex + 1) * GP + this.childOff[k]
  }

  private groupAt(y: number): number {
    if (y <= 0) return 0
    if (this.ex < 0 || y < (this.ex + 1) * GP) return Math.floor(y / GP)
    if (y < (this.ex + 1) * GP + this.childrenH) return this.ex
    return Math.floor((y - this.childrenH) / GP)
  }

  /** First child index whose bottom is below `y` (relative to the children block). */
  private childAt(y: number): number {
    let lo = 0
    let hi = this.rows.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.childOff[mid] + this.rows[mid].pitch <= y) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private selId(s: Sel = this.sel): string {
    if (s.trackId && this.rowIndex.has('T' + s.trackId)) return 'T' + s.trackId
    if (s.albumId && this.rowIndex.has('A' + s.albumId)) return 'A' + s.albumId
    return 'G' + s.gi
  }

  /** Layout box of the selected row. */
  private selBox(): { y: number; h: number } {
    const id = this.selId()
    const k = this.rowIndex.get(id)
    if (k !== undefined) return { y: this.childY(k), h: this.rows[k].h }
    return { y: this.groupY(this.sel.gi), h: GH }
  }

  private clampScroll(v: number): number {
    if (!this.total) return GH / 2
    const lo = GH / 2
    const last = this.rows.length && this.ex === this.total - 1 ? this.childY(this.rows.length - 1) + this.rows[this.rows.length - 1].h / 2 : this.groupY(this.total - 1) + GH / 2
    return clamp(v, lo, Math.max(lo, last))
  }

  private selCenter(): number {
    const b = this.selBox()
    return b.y + b.h / 2
  }

  private targetOf(item: Item): number {
    if (item.type === 'group' && !item.leaving) return this.groupY(item.gi)
    const k = this.rowIndex.get(item.id)
    if (k !== undefined && !item.leaving) return this.childY(k)
    // leaving: slide back under the parent
    if (item.leaveTo) {
      if (item.leaveTo[0] === 'G') {
        const gi = Number(item.leaveTo.slice(1))
        if (gi < this.total) return this.groupY(gi)
      } else {
        const pk = this.rowIndex.get(item.leaveTo)
        if (pk !== undefined) return this.childY(pk)
        const pItem = this.childItems.get(item.leaveTo) ?? this.leavingItems.find((x) => x.id === item.leaveTo)
        if (pItem) return pItem.y
      }
    }
    return item.y
  }

  // ---------------------------------------------------------------- restore / persist

  private restore(): void {
    const m = this.model
    if (m.started && m.total !== null) {
      let gi = clamp(memory.gi, 0, Math.max(0, this.total - 1))
      if (memory.groupKey && m.group(gi)?.key !== memory.groupKey) {
        const j = m.findLoaded(memory.groupKey)
        if (j >= 0) gi = j
      }
      this.sel = { gi, albumId: memory.albumId, trackId: memory.trackId }
      this.exAlbum = memory.exAlbum
      this.collapsed = memory.collapsed
      this.rebuild(true)
      const c = this.selCenter()
      this.scroll.set(memory.scroll != null ? this.clampScroll(memory.scroll) : c, c)
      this.follow = true
      this.publish(true)
      useBrowse.setState({ total: m.total, loading: m.loading })
    } else {
      this.awaitingFirstPage = { groupKey: memory.groupKey, albumId: memory.albumId, trackId: memory.trackId }
    }
  }

  private persist(): void {
    memory.gi = this.sel.gi
    memory.groupKey = this.model.group(this.sel.gi)?.key ?? null
    memory.albumId = this.sel.albumId
    memory.trackId = this.sel.trackId
    memory.exAlbum = this.exAlbum
    memory.collapsed = this.collapsed
    memory.scroll = this.scroll.value
  }

  // ---------------------------------------------------------------- rows (children of the expanded group)

  private rebuild(instant = false): void {
    const now = performance.now()
    const g = this.model.group(this.sel.gi)
    const prev = this.rowIndex
    const prevRows = this.rows
    const rows: Row[] = []
    const born = instant ? 0 : now
    const reuse = (r: Row): Row => {
      const k = prev.get(r.id)
      const old = k !== undefined ? prevRows[k] : undefined
      if (old && old.gi === r.gi) {
        r.born = old.born
        if (old.album === r.album && old.track === r.track && old.parent === r.parent && old.label === r.label) return old
      }
      return r
    }
    const gid = 'G' + this.sel.gi
    let loading: string | null = null
    if (g && !this.collapsed) {
      if (g.kind === 'album') {
        const albumId = g.key.slice(g.key.indexOf(':') + 1)
        const d = this.model.detailFor(albumId)
        if (d) {
          const multiDisc = d.tracks.some((t) => t.disc > 1)
          d.tracks.forEach((t, ti) => rows.push(reuse({ type: 'track', id: 'T' + t.id, gi: this.sel.gi, depth: 1, album: d.album, track: t, ti, parent: gid, born, h: TH, pitch: TP, multiDisc })))
        } else loading = 'Loading tracks…'
      } else {
        const albums = this.model.albumsFor(g.key)
        if (albums) {
          for (const a of albums) {
            const aid = 'A' + a.id
            rows.push(reuse({ type: 'album', id: aid, gi: this.sel.gi, depth: 1, album: a, track: null, ti: -1, parent: gid, born, h: AH, pitch: AP }))
            if (a.id === this.exAlbum) {
              const d = this.model.detailFor(a.id)
              if (d) {
                const multiDisc = d.tracks.some((t) => t.disc > 1)
                d.tracks.forEach((t, ti) => rows.push(reuse({ type: 'track', id: 'T' + t.id, gi: this.sel.gi, depth: 2, album: d.album, track: t, ti, parent: aid, born, h: TH, pitch: TP, multiDisc })))
              } else if (this.loadingDelayPassed('d:' + a.id, now)) {
                rows.push(reuse({ type: 'loading', id: 'L' + aid, gi: this.sel.gi, depth: 2, album: a, track: null, ti: -1, parent: aid, born, h: LH, pitch: LP, label: 'Loading tracks…' }))
              }
            }
          }
          if (!albums.length) loading = 'No albums match'
        } else loading = 'Loading albums…'
      }
      if (loading && (loading === 'No albums match' || this.loadingDelayPassed('g:' + g.key, now))) {
        rows.push(reuse({ type: 'loading', id: 'L' + gid, gi: this.sel.gi, depth: 1, album: null, track: null, ti: -1, parent: gid, born, h: LH, pitch: LP, label: loading }))
      }
    }

    const index = new Map<string, number>()
    const off: number[] = []
    let y = 0
    rows.forEach((r, i) => {
      index.set(r.id, i)
      off.push(y)
      y += r.pitch
    })
    this.rows = rows
    this.rowIndex = index
    this.childOff = off
    this.childrenH = rows.length ? y + CHILD_TAIL : 0
    this.ex = rows.length ? this.sel.gi : -1

    // children that disappeared slide back under their parent and fade
    for (const [id, item] of this.childItems) {
      const k = index.get(id)
      // gone, or the same album/track id under a different group (bucket groupings): a new identity
      if (k === undefined || rows[k].gi !== item.gi) {
        this.childItems.delete(id)
        item.leaving = true
        item.leaveTo = item.row?.parent ?? null
        this.leavingItems.push(item)
      } else if (item.row !== rows[k]) {
        item.row = rows[k]
        item.data = null
      }
    }
  }

  /** Placeholders only appear if loading takes a moment (no flash for fast loads). */
  private loadingDelayPassed(key: string, now: number): boolean {
    if (this.loadingKey !== key) {
      this.loadingKey = key
      this.loadingSince = now
    }
    if (now - this.loadingSince >= 140) return true
    window.clearTimeout(this.loadingTimer)
    this.loadingTimer = window.setTimeout(() => this.rebuild(), 150)
    return false
  }

  // ---------------------------------------------------------------- selection

  /** Select something. `follow` recentres the carousel on it (default true). */
  select(next: Sel, o: { sound?: boolean; follow?: boolean; instant?: boolean } = {}): void {
    if (!this.total) return
    next = { ...next, gi: clamp(next.gi, 0, this.total - 1) }
    const prev = this.sel
    const changed = !sameSel(prev, next)
    if (next.gi !== prev.gi) {
      this.exAlbum = next.trackId ? next.albumId : null
      this.collapsed = false
    } else if (next.trackId && next.albumId) this.exAlbum = next.albumId
    else if (!next.albumId && this.collapsed) this.collapsed = false
    this.sel = next
    if (o.follow !== false) {
      this.follow = true
      this.setSpring('follow')
    }
    this.rebuild(o.instant)
    this.prefetch()
    this.persist()
    this.publish()
    if (changed && o.sound !== false) sfx.play('select', { volume: 0.5 })
  }

  private prefetch(): void {
    const m = this.model
    m.ensureGroups(this.sel.gi - 8, this.sel.gi + 8)
    for (const d of [1, -1]) {
      const g = m.group(this.sel.gi + d)
      if (g && g.kind !== 'album') m.albumsFor(g.key)
    }
  }

  private flatOfSel(): number {
    const k = this.rowIndex.get(this.selId())
    if (k !== undefined) return this.ex + 1 + k
    const gi = this.sel.gi
    return this.ex < 0 || gi <= this.ex ? gi : gi + this.rows.length
  }

  private selAtFlat(f: number): Sel | null {
    const C = this.rows.length
    if (this.ex < 0 || f <= this.ex) return { gi: f, albumId: null, trackId: null }
    if (f <= this.ex + C) {
      const r = this.rows[f - this.ex - 1]
      if (r.type === 'loading') return null
      return { gi: r.gi, albumId: r.album?.id ?? null, trackId: r.track?.id ?? null }
    }
    return { gi: f - C, albumId: null, trackId: null }
  }

  /** ↑/↓: step through the flattened visible list. */
  move(delta: number): void {
    if (!this.total) return
    const max = this.total - 1 + this.rows.length
    let f = this.flatOfSel()
    const step = Math.sign(delta)
    let remaining = Math.abs(delta)
    let target: Sel | null = null
    while (remaining > 0) {
      f += step
      if (f < 0 || f > max) break
      const s = this.selAtFlat(f)
      if (!s) continue
      target = s
      remaining--
    }
    if (target) this.select(target)
    else this.nudge(step)
  }

  /** Little bump at the ends of the list. */
  private nudge(dir: number): void {
    this.scroll.impulse(dir * 260)
  }

  /** ←: collapse / go to parent / previous group. */
  left(): void {
    const s = this.sel
    const g = this.model.group(s.gi)
    if (s.trackId) {
      if (g?.kind === 'album') this.select({ gi: s.gi, albumId: null, trackId: null })
      else {
        this.exAlbum = null
        this.select({ gi: s.gi, albumId: s.albumId, trackId: null }, { sound: false })
        sfx.play('collapse', { volume: 0.6 })
      }
    } else if (s.albumId) {
      if (this.exAlbum === s.albumId) {
        this.exAlbum = null
        this.rebuild()
        this.persist()
        sfx.play('collapse', { volume: 0.6 })
      } else this.select({ gi: s.gi, albumId: null, trackId: null })
    } else if (s.gi > 0) this.select({ gi: s.gi - 1, albumId: null, trackId: null })
    else this.nudge(-1)
  }

  /** →: expand / step in / next group. */
  right(): void {
    const s = this.sel
    if (s.albumId && !s.trackId && this.model.group(s.gi)?.kind !== 'album') {
      if (this.exAlbum !== s.albumId) {
        this.expandAlbum(s.albumId)
        return
      }
      const k = this.rowIndex.get('A' + s.albumId)
      const next = k !== undefined ? this.rows[k + 1] : undefined
      if (next?.type === 'track') this.select({ gi: s.gi, albumId: s.albumId, trackId: next.track!.id })
      return
    }
    if (s.gi < this.total - 1) this.select({ gi: s.gi + 1, albumId: null, trackId: null })
    else this.nudge(1)
  }

  page(dir: number): void {
    const n = Math.max(1, Math.floor((this.vh - this.topInset - this.bottomInset) / GP))
    this.select({ gi: this.sel.gi + dir * n, albumId: null, trackId: null })
  }

  edge(end: boolean): void {
    this.select({ gi: end ? this.total - 1 : 0, albumId: null, trackId: null })
  }

  expandAlbum(albumId: string): void {
    this.exAlbum = albumId
    this.collapsed = false
    this.follow = true
    this.rebuild()
    this.persist()
    sfx.play('expand', { volume: 0.6 })
  }

  toggleAlbum(albumId: string): void {
    if (this.exAlbum === albumId) {
      this.exAlbum = null
      this.rebuild()
      this.persist()
      sfx.play('collapse', { volume: 0.6 })
    } else this.expandAlbum(albumId)
  }

  private toggleGroup(): void {
    this.collapsed = !this.collapsed
    if (this.collapsed) this.sel = { gi: this.sel.gi, albumId: null, trackId: null }
    this.rebuild()
    this.persist()
    this.publish()
    sfx.play(this.collapsed ? 'collapse' : 'expand', { volume: 0.6 })
  }

  /** Recentre on the selection (after free scrolling). */
  recenter(): void {
    this.follow = true
    this.setSpring('follow')
  }

  // ---------------------------------------------------------------- random (F2) with a spin

  random(): boolean {
    const n = this.total
    if (n < 2) return false
    let r = Math.floor(Math.random() * n)
    if (r === this.sel.gi) r = (r + 1 + Math.floor(Math.random() * (n - 1))) % n
    memory.history.push({ gi: this.sel.gi, groupKey: this.model.group(this.sel.gi)?.key ?? null, albumId: this.sel.albumId, trackId: this.sel.trackId })
    if (memory.history.length > 50) memory.history.shift()
    useBrowse.setState({ historyLen: memory.history.length })
    this.spinTo({ gi: r, albumId: null, trackId: null })
    return true
  }

  rewind(): boolean {
    const h = memory.history.pop()
    useBrowse.setState({ historyLen: memory.history.length })
    if (!h) return false
    let gi = h.gi
    if (h.groupKey && this.model.group(gi)?.key !== h.groupKey) {
      const j = this.model.findLoaded(h.groupKey)
      if (j >= 0) gi = j
    }
    this.spinTo({ gi, albumId: h.albumId, trackId: h.trackId })
    return true
  }

  private spinTo(target: Sel): void {
    void this.model.loadGroup(target.gi)
    const from = this.scroll.value
    this.select(target, { sound: false })
    const dist = Math.abs(this.selCenter() - from)
    const dur = motionPrefs.reduce ? 0 : clamp(520 + 150 * Math.log2(1 + dist / GP), 560, 1250)
    this.spin = dur ? { from, t0: performance.now(), dur, lastRow: Math.floor(from / GP) } : null
    if (!dur) this.scroll.set(this.clampScroll(this.selCenter()))
    sfx.play('confirm', { volume: 0.45 })
  }

  // ---------------------------------------------------------------- screen choreography

  /** Panels cascade in from the right, top to bottom. */
  intro(dist = 0.55, staggerMs = 260): void {
    const now = performance.now()
    this.phase = 'intro'
    this.phaseAt = now
    this.phaseStagger = staggerMs
    this.phaseDist = this.vw * dist
    for (const it of this.liveItems()) this.applyIntro(it, now)
  }

  /** Panels leave to the right. Resolves when they're gone. */
  outro(fast = false): Promise<void> {
    const now = performance.now()
    this.phase = 'outro'
    this.phaseAt = now
    this.phaseStagger = fast ? 90 : 200
    this.phaseDist = this.vw * 0.75
    for (const it of this.liveItems()) it.delay = now + this.stagger(it)
    return new Promise((r) => window.setTimeout(r, fast ? 300 : 520))
  }

  private stagger(it: Item): number {
    const sy = it.y - this.scroll.value + this.focusY
    return clamp01(sy / Math.max(1, this.vh)) * this.phaseStagger
  }

  private applyIntro(it: Item, now: number): void {
    it.ex = this.phaseDist
    it.ea = 0
    it.delay = now + this.stagger(it)
  }

  private *liveItems(): Generator<Item> {
    yield* this.groupItems.values()
    yield* this.childItems.values()
  }

  // ---------------------------------------------------------------- model events

  private onModel(e: ModelEvent): void {
    const m = this.model
    switch (e.type) {
      case 'reset': {
        // keep the old selection's identity so we can find it in the new results
        const g = m.group(this.sel.gi)
        this.awaitingFirstPage = { groupKey: g?.key ?? memory.groupKey, albumId: this.sel.albumId, trackId: this.sel.trackId }
        const now = performance.now()
        for (const it of [...this.groupItems.values(), ...this.childItems.values()]) {
          it.leaving = true
          it.leaveTo = null
          it.leaveX = 90
          it.delay = now
          this.leavingItems.push(it)
        }
        this.groupItems.clear()
        this.childItems.clear()
        this.rows = []
        this.rowIndex = new Map()
        this.childOff = []
        this.childrenH = 0
        this.ex = -1
        useBrowse.setState({ loading: true })
        break
      }
      case 'total': {
        useBrowse.setState({ total: e.total, loading: m.loading })
        // A query can come back empty first (the catalog is still indexing) and fill in on a later
        // refresh: if nothing is selected yet, select the first result once there is one.
        if (e.total > 0 && this.sel.gi < 0 && !this.awaitingFirstPage) this.select({ gi: 0, albumId: null, trackId: null }, { sound: false, instant: true })
        else if (this.sel.gi >= e.total && e.total > 0) this.select({ gi: e.total - 1, albumId: null, trackId: null }, { sound: false })
        if (!e.total) this.publish(true)
        break
      }
      case 'page': {
        useBrowse.setState({ loading: false })
        if (this.awaitingFirstPage) {
          const want = this.awaitingFirstPage
          this.awaitingFirstPage = null
          const j = want.groupKey ? m.findLoaded(want.groupKey) : -1
          // Very first visit (nothing remembered, no search): open on a random game, like a fresh
          // song select, instead of whatever happens to sort first.
          const first = !want.groupKey && !memory.groupKey && !m.query.text.trim() && this.total > 1
          const target: Sel =
            j >= 0
              ? { gi: j, albumId: want.albumId, trackId: want.trackId }
              : { gi: first ? Math.floor(Math.random() * Math.min(this.total, 5000)) : 0, albumId: null, trackId: null }
          if (first) m.ensureGroups(target.gi - 8, target.gi + 8)
          this.sel = { gi: -1, albumId: null, trackId: null }
          this.exAlbum = null
          this.select(target, { sound: false, instant: true })
          this.scroll.set(this.clampScroll(this.selCenter()))
          // a screen-enter cascade may already be running: let it carry the new panels in
          if (!(this.phase === 'intro' && performance.now() - this.phaseAt < 600)) this.intro(0.22, 150)
          else this.phaseAt = performance.now()
          return
        }
        if (this.sel.gi < 0 && this.total > 0 && e.page === 0) {
          this.select({ gi: 0, albumId: null, trackId: null }, { sound: false, instant: true })
          this.scroll.set(this.clampScroll(this.selCenter()))
          return
        }
        if (Math.floor(this.sel.gi / PAGE_SIZE) === e.page) {
          // after a revision refresh the selected group may have moved: follow it by key
          const key = this.refreshing
          const g = m.group(this.sel.gi)
          if (key && g && g.key !== key && !this.relocating) {
            const j = m.findLoaded(key)
            if (j >= 0 && j !== this.sel.gi) {
              const before = this.selCenter()
              this.sel = { ...this.sel, gi: j }
              this.rebuild(true)
              const shift = this.selCenter() - before
              this.scroll.set(this.scroll.value + shift, this.scroll.target + shift)
              for (const it of this.groupItems.values()) this.releaseItem(it)
              this.groupItems.clear()
            }
          }
          this.refreshing = null
          this.rebuild()
          this.persist()
          this.publish()
        }
        break
      }
      case 'albums': {
        const g = m.group(this.sel.gi)
        if (g?.key === e.key) {
          this.rebuild()
          this.publish()
        }
        break
      }
      case 'detail': {
        const g = m.group(this.sel.gi)
        const groupAlbum = g?.kind === 'album' ? g.key.slice(g.key.indexOf(':') + 1) : null
        if (e.albumId === this.exAlbum || e.albumId === groupAlbum) this.rebuild()
        if (e.albumId === this.sel.albumId || e.albumId === groupAlbum || e.albumId === this.published?.album?.id) this.publish()
        this.ver++
        break
      }
      case 'game':
        this.ver++
        this.publish(true)
        break
    }
  }

  /** The catalog revision moved: refetch what's on screen, keep the selection. */
  refreshData(): void {
    this.refreshing = this.model.group(this.sel.gi)?.key ?? null
    const pages = new Set<number>()
    for (const gi of this.groupItems.keys()) pages.add(Math.floor(gi / PAGE_SIZE))
    pages.add(Math.floor(this.sel.gi / PAGE_SIZE))
    const g = this.model.group(this.sel.gi)
    const keepDetails = [this.exAlbum, this.sel.albumId].filter((x): x is string => !!x)
    if (g?.kind === 'album') keepDetails.push(g.key.slice(g.key.indexOf(':') + 1))
    this.model.refresh([...pages], g && g.kind !== 'album' ? [g.key] : [], keepDetails)
  }

  /** Select a group by key (after imports), loading pages as needed. */
  async reveal(groupKey: string, albumId: string | null): Promise<boolean> {
    this.relocating = true
    try {
      const j = await this.model.locate(groupKey)
      if (j < 0) return false
      this.awaitingFirstPage = null
      this.select({ gi: j, albumId, trackId: null }, { sound: false })
      if (albumId) this.exAlbum = albumId
      this.rebuild()
      return true
    } finally {
      this.relocating = false
    }
  }

  // ---------------------------------------------------------------- selection info for React

  infoFor(s: Sel): SelInfo {
    const m = this.model
    const g = m.group(s.gi)
    let albums: Album[] | null = null
    let album: Album | null = null
    let detail: AlbumDetail | null = null
    if (g) {
      if (g.kind === 'album') {
        const id = g.key.slice(g.key.indexOf(':') + 1)
        detail = m.peekDetail(id) ?? null
        album = detail?.album ?? null
        albums = album ? [album] : null
      } else {
        albums = m.albumsFor(g.key) ?? null
        if (s.albumId) {
          album = albums?.find((a) => a.id === s.albumId) ?? m.peekDetail(s.albumId)?.album ?? null
          detail = m.peekDetail(s.albumId) ?? null
        }
      }
    }
    const track = s.trackId ? (detail?.tracks.find((t) => t.id === s.trackId) ?? null) : null
    const kind = track ? 'track' : s.albumId && album && g?.kind !== 'album' ? 'album' : 'group'
    return {
      id: `${s.gi}|${g?.key ?? ''}|${kind === 'group' ? '' : s.albumId}|${track?.id ?? ''}`,
      kind,
      gi: s.gi,
      group: g,
      albums,
      album: kind === 'group' && g?.kind !== 'album' ? null : album,
      detail: kind === 'group' && g?.kind !== 'album' ? null : detail,
      track,
      trackIndex: track && detail ? detail.tracks.indexOf(track) : -1
    }
  }

  private publish(force = false): void {
    if (!this.model.total) {
      if (this.published || force) {
        this.published = null
        useBrowse.setState({ sel: null })
      }
      return
    }
    const info = this.infoFor(this.sel)
    const p = this.published
    if (!force && p && p.id === info.id && p.group === info.group && p.albums === info.albums && p.album === info.album && p.detail === info.detail && p.track === info.track) return
    this.published = info
    useBrowse.setState({ sel: info })
  }

  /** Screen rect of the selected panel (for anchoring menus). */
  selectedRect(): { x: number; y: number } {
    const id = this.selId()
    const it = id[0] === 'G' ? this.groupItems.get(this.sel.gi) : this.childItems.get(id)
    const z = uiZoom()
    if (!it) return { x: (this.rect.left + this.vw * 0.4) * z, y: (this.rect.top + this.focusY) * z }
    const r = it.node.el.getBoundingClientRect()
    return { x: r.left + 120 * z, y: r.top + r.height / 2 }
  }

  // ---------------------------------------------------------------- input

  private setSpring(mode: 'follow' | 'wheel' | 'fling'): void {
    const s = this.scroll
    if (mode === 'follow') {
      s.frequency = 2.5
      s.damping = 1
    } else if (mode === 'wheel') {
      s.frequency = 4.2
      s.damping = 1
    } else {
      s.frequency = 1.5
      s.damping = 0.82
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    if (!this.total) return
    const mouse = e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY) && e.deltaX === 0)
    const d = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? this.vh : 1)
    this.follow = false
    this.spin = null
    if (mouse) {
      this.setSpring('wheel')
      const base = Math.abs(this.scroll.target - this.scroll.value) > 2 * GP ? this.scroll.value : this.scroll.target
      this.scroll.target = this.clampScroll(base + d * 1.25)
    } else {
      const v = this.clampScroll(this.scroll.value + d)
      this.scroll.value = v
      this.scroll.target = v
      this.scroll.velocity = 0
    }
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const z = uiZoom()
    return { x: e.clientX / z - this.rect.left, y: e.clientY / z - this.rect.top }
  }

  private onPointerDown(e: PointerEvent): void {
    this.measure()
    if (e.button !== 0) return
    this.drag = { id: e.pointerId, y0: e.clientY, s0: this.scroll.value, moved: false, samples: [{ t: performance.now(), y: e.clientY }] }
  }

  private onPointerMove(e: PointerEvent): void {
    this.pointer = this.local(e)
    const d = this.drag
    if (!d || d.id !== e.pointerId) return
    const dy = (e.clientY - d.y0) / uiZoom()
    if (!d.moved) {
      if (Math.abs(dy) < 7) return
      d.moved = true
      this.root.setPointerCapture(e.pointerId)
      this.root.classList.add('is-dragging')
      this.follow = false
      this.spin = null
    }
    let v = d.s0 - dy
    const c = this.clampScroll(v)
    if (v !== c) v = c + (v - c) * 0.35 // rubber band past the ends
    this.scroll.value = v
    this.scroll.target = v
    this.scroll.velocity = 0
    const now = performance.now()
    d.samples.push({ t: now, y: e.clientY })
    while (d.samples.length > 2 && now - d.samples[0].t > 90) d.samples.shift()
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag
    if (!d || d.id !== e.pointerId) return
    this.drag = null
    if (!d.moved) return
    this.root.classList.remove('is-dragging')
    if (this.root.hasPointerCapture(e.pointerId)) this.root.releasePointerCapture(e.pointerId)
    this.suppressClick = true
    window.setTimeout(() => (this.suppressClick = false), 0)
    const a = d.samples[0]
    const b = d.samples[d.samples.length - 1]
    const dt = Math.max(1, b.t - a.t)
    const vel = performance.now() - b.t > 80 ? 0 : (-(b.y - a.y) / uiZoom() / dt) * 1000
    this.setSpring('fling')
    this.scroll.velocity = vel
    this.scroll.target = this.clampScroll(this.scroll.value + vel * 0.42)
  }

  private itemFromEvent(e: Event): Item | null {
    const el = (e.target as HTMLElement | null)?.closest?.('.bc-item') as HTMLElement | null
    if (!el) return null
    const id = el.dataset.id
    if (!id) return null
    if (id[0] === 'G') return this.groupItems.get(Number(id.slice(1))) ?? null
    return this.childItems.get(id) ?? null
  }

  private selOfItem(it: Item): Sel {
    if (it.type === 'group') return { gi: it.gi, albumId: null, trackId: null }
    return { gi: it.gi, albumId: it.row?.album?.id ?? null, trackId: it.row?.track?.id ?? null }
  }

  private onClick(e: MouseEvent): void {
    if (this.suppressClick || e.detail > 1) return
    const it = this.itemFromEvent(e)
    if (!it || it.leaving || it.type === 'loading') return
    const s = this.sel
    if (it.type === 'group') {
      if (s.gi === it.gi && !s.albumId) this.toggleGroup()
      else this.select({ gi: it.gi, albumId: null, trackId: null })
    } else if (it.type === 'album') {
      const id = it.row!.album!.id
      if (s.albumId === id && !s.trackId) this.toggleAlbum(id)
      else {
        this.select({ gi: it.gi, albumId: id, trackId: null }, { sound: false })
        this.expandAlbum(id)
      }
    } else {
      this.select(this.selOfItem(it))
    }
  }

  private onDblClick(e: MouseEvent): void {
    const it = this.itemFromEvent(e)
    if (!it || it.leaving || it.type === 'loading') return
    const s = this.selOfItem(it)
    if (!sameSel(s, this.sel)) this.select(s, { sound: false })
    this.hooks.activate(this.infoFor(this.sel))
  }

  private onContextMenu(e: MouseEvent): void {
    const it = this.itemFromEvent(e)
    e.preventDefault()
    if (!it || it.leaving || it.type === 'loading') return
    this.hooks.menu(this.infoFor(this.selOfItem(it)), { x: e.clientX, y: e.clientY })
  }

  // ---------------------------------------------------------------- pool

  private acquire(type: PanelType): PanelNode {
    const n = this.pool[type].pop() ?? createPanel(type)
    if (n.el.parentNode !== this.layer) this.layer.appendChild(n.el)
    n.el.classList.remove('is-free')
    return n
  }

  private releaseItem(it: Item): void {
    // The pool only needs a screenful per type. Fast F2 spins briefly hold many panels at once,
    // and without a cap that high-water mark stayed in the DOM for the rest of the session.
    if (this.pool[it.type].length >= POOL_MAX) {
      it.node.el.remove()
      return
    }
    resetPanel(it.node)
    it.node.el.classList.add('is-free')
    it.node.glow.style.opacity = ''
    it.node.ring.style.opacity = ''
    delete it.node.cache.lx
    this.pool[it.type].push(it.node)
  }

  private makeItem(id: string, type: PanelType, gi: number, row: Row | null, ty: number, now: number): Item {
    const node = this.acquire(type)
    node.el.dataset.id = id
    const depth = row?.depth ?? 0
    const h = row?.h ?? GH
    const it: Item = {
      id,
      type,
      gi,
      row,
      node,
      depth,
      h,
      y: ty,
      ex: 0,
      ea: 1,
      delay: 0,
      fade: 1,
      hover: 0,
      sel: 0,
      leaving: false,
      leaveTo: null,
      leaveX: 0,
      data: undefined,
      ver: -1,
      lx: NaN,
      ly: NaN,
      lo: NaN,
      lg: NaN,
      lr: NaN,
      ls: NaN
    }
    if (row && row.born && now - row.born < 450) {
      // newly expanded: slide out from under the parent
      const parent = row.parent[0] === 'G' ? this.groupItems.get(Number(row.parent.slice(1))) : this.childItems.get(row.parent)
      it.y = parent ? parent.y + (parent.h - h) / 2 : ty - 20
      it.fade = 0
    } else {
      it.y = ty + this.displacementNear(ty)
    }
    if (this.phase !== 'idle' && now - this.phaseAt < 700) {
      if (this.phase === 'intro') this.applyIntro(it, now)
      else {
        it.delay = now
        it.ex = this.phaseDist
        it.ea = 0
      }
    }
    return it
  }

  /** New panels inherit the motion of their on-screen neighbours (no pops mid-animation). */
  private displacementNear(ty: number): number {
    let best = Infinity
    let disp = 0
    for (const it of this.liveItems()) {
      const t = this.targetOf(it)
      const d = Math.abs(t - ty)
      if (d < best) {
        best = d
        disp = it.y - t
      }
    }
    return best < GP * 3 ? disp : 0
  }

  // ---------------------------------------------------------------- frame

  private tick(dt: number, now: number): void {
    if (!this.vh) return
    const total = this.total

    // --- scroll
    const sc = this.scroll
    if (this.spin) {
      const sp = this.spin
      const p = clamp01((now - sp.t0) / sp.dur)
      // outQuint-ish with a softer start: accelerate briefly, then a long glide into place
      const e = p < 1 ? 1 - Math.pow(1 - p, 4.2) : 1
      const to = this.clampScroll(this.selCenter())
      sc.value = sp.from + (to - sp.from) * e
      sc.target = sc.value
      sc.velocity = 0
      const row = Math.floor(sc.value / GP)
      if (row !== sp.lastRow) {
        sp.lastRow = row
        if (p < 0.92) sfx.play('tick', { volume: 0.22 })
      }
      if (p >= 1) {
        this.spin = null
        sc.set(to)
        this.setSpring('follow')
      }
    } else if (!this.drag?.moved) {
      if (this.follow) sc.target = this.clampScroll(this.selCenter())
      else {
        const c = this.clampScroll(sc.target)
        if (c !== sc.target) sc.target = c
      }
      sc.step(dt)
    }
    const s = sc.value
    const v = dt > 0 ? ((s - this.lastScroll) / dt) * 1000 : 0
    this.lastScroll = s
    this.speed += (Math.abs(v) - this.speed) * (1 - Math.exp(-dt / 58)) // ≈0.25 per 60 Hz frame, same at 120 Hz

    if (this.phase === 'intro' && now - this.phaseAt > 1200) this.phase = 'idle'

    // --- visible range
    const fy = this.focusY
    const margin = 160
    const top = s - fy - margin
    const bottom = s - fy + this.vh + margin
    let g0 = 0
    let g1 = -1
    if (total) {
      g0 = clamp(this.groupAt(top), 0, total - 1)
      g1 = clamp(this.groupAt(bottom), 0, total - 1)
      if (g0 !== this.lastRange || now - this.lastEnsure > 250) {
        if (this.speed < 7000 || now - this.lastEnsure > 250) {
          this.model.ensureGroups(g0 - 4, g1 + 4)
          this.lastEnsure = now
          this.lastRange = g0
        }
      }
    }

    // --- release group panels that scrolled away (once actually off screen)
    for (const [gi, it] of this.groupItems) {
      if (gi >= total || ((gi < g0 || gi > g1) && this.offscreen(it, s, fy))) {
        this.releaseItem(it)
        this.groupItems.delete(gi)
      }
    }
    // --- acquire visible group panels
    for (let gi = g0; gi <= g1; gi++) {
      if (!this.groupItems.has(gi)) this.groupItems.set(gi, this.makeItem('G' + gi, 'group', gi, null, this.groupY(gi), now))
    }
    // --- children
    if (this.rows.length) {
      const base = (this.ex + 1) * GP
      const k0 = this.childAt(top - base)
      const k1 = this.childAt(bottom - base)
      for (const [id, it] of this.childItems) {
        const k = this.rowIndex.get(id)!
        if ((k < k0 || k > k1) && this.offscreen(it, s, fy)) {
          this.releaseItem(it)
          this.childItems.delete(id)
        }
      }
      for (let k = k0; k <= k1 && k < this.rows.length; k++) {
        const r = this.rows[k]
        if (!this.childItems.has(r.id)) this.childItems.set(r.id, this.makeItem(r.id, r.type, r.gi, r, this.childY(k), now))
      }
    }

    // --- hover (computed from the pointer: no DOM hit-testing per frame)
    let hover: string | null = null
    const ptr = this.pointer
    if (ptr && !this.drag?.moved && !this.spin) {
      for (const it of this.liveItems()) {
        const sy = it.y - s + fy
        if (ptr.y >= sy && ptr.y < sy + it.h && ptr.x >= it.lx - 4) {
          hover = it.id
          break
        }
      }
    }

    // --- per panel
    const selId = this.selId()
    const activeGroup = selId[0] !== 'G' ? 'G' + this.sel.gi : ''
    const halfH = Math.max(200, (this.vh - this.topInset - this.bottomInset) / 2 + 60)
    const pulse = motionPrefs.reduce ? 0 : Math.min(1.4, beat.pulse)
    const preferOrig = this.preferOriginal()
    const ps = usePlayer.getState()
    const nowId = ps.current?.id ?? null
    const nowState: 'off' | 'paused' | 'playing' = ps.status === 'playing' ? 'playing' : 'paused'
    const fadeTop = this.topInset - 64
    const fadeBottom = this.vh - this.bottomInset + 40

    const rm = motionPrefs.reduce
    const damp = rm ? (_c: number, t: number) => t : dampFn
    const update = (it: Item) => {
      const ty = this.targetOf(it)
      it.y = damp(it.y, ty, it.leaving ? 70 : Y_HALF, dt)
      const sy = it.y - s + fy

      // choreography
      if (now >= it.delay) {
        if (this.phase === 'outro') {
          it.ex = damp(it.ex, this.phaseDist, 70, dt)
          it.ea = damp(it.ea, 0, 45, dt)
        } else if (it.ex !== 0 || it.ea !== 1) {
          it.ex = damp(it.ex, 0, 80, dt)
          it.ea = damp(it.ea, 1, 70, dt)
          if (Math.abs(it.ex) < 0.2) it.ex = 0
          if (it.ea > 0.998) it.ea = 1
        }
      }
      if (it.leaving) {
        it.fade = damp(it.fade, 0, it.leaveTo ? 38 : 55, dt)
        if (it.leaveX) it.ex = damp(it.ex, it.leaveX, 60, dt)
      } else if (it.fade < 1) {
        it.fade = damp(it.fade, 1, FX_HALF, dt)
        if (it.fade > 0.995) it.fade = 1
      }
      const isSel = !it.leaving && it.id === selId
      const isHover = !it.leaving && it.id === hover
      it.hover = damp(it.hover, isHover ? 1 : 0, 45, dt)
      it.sel = damp(it.sel, isSel ? 1 : 0, 55, dt)

      // arc: further from the focus line → further right
      const cy = sy + it.h / 2
      const d = clamp((cy - fy) / halfH, -1.7, 1.7)
      const arc = (ARC_R - Math.sqrt(Math.max(0, ARC_R * ARC_R - d * d))) * halfH * ARC_K * 0.5
      const x = BASE_X + INDENT[it.depth] + arc - it.hover * HOVER_X - it.sel * SEL_X + it.ex
      let alpha = it.fade * it.ea
      if (cy < fadeTop + 70) alpha *= clamp01((cy - fadeTop) / 70)
      if (cy > fadeBottom - 70) alpha *= clamp01((fadeBottom - cy) / 70)

      const n = it.node
      // Everything per frame is transform/opacity on composited layers: the item (position +
      // beat scale), the selection ring and the pulsing rim (own layers while lit).
      const xr = Math.round(x * 10) / 10
      const yr = Math.round(sy * 10) / 10
      const sc2 = Math.round((1 + 0.012 * pulse * it.sel) * 1000) / 1000
      if (xr !== it.lx || yr !== it.ly || sc2 !== it.ls) {
        it.lx = xr
        it.ly = yr
        it.ls = sc2
        n.el.style.transform = sc2 === 1 ? `translate3d(${xr}px,${yr}px,0)` : `translate3d(${xr}px,${yr}px,0) scale(${sc2})`
      }
      const o = Math.round(alpha * 100) / 100
      if (o !== it.lo) {
        it.lo = o
        n.el.style.opacity = String(o)
      }
      setClass(n, 'is-lit', it.sel > 0.004)
      const ring = Math.round(it.sel * 100) / 100
      if (ring !== it.lr) {
        it.lr = ring
        n.ring.style.opacity = String(ring)
      }
      const g = Math.round(it.sel * (0.72 + 0.28 * Math.min(1, pulse)) * 100) / 100
      if (g !== it.lg) {
        it.lg = g
        n.glow.style.opacity = String(g)
      }
      if (!it.leaving) {
        if (setClass(n, 'is-selected', isSel)) n.el.setAttribute('aria-selected', String(isSel))
        setClass(n, 'is-hover', isHover)
        setClass(n, 'is-active', it.id === activeGroup)
        if (it.type === 'group') setClass(n, 'is-expanded', this.ex === it.gi)
        this.fill(it, preferOrig, nowId, nowState)
      }
    }

    for (const it of this.groupItems.values()) update(it)
    for (const it of this.childItems.values()) update(it)
    for (let i = this.leavingItems.length - 1; i >= 0; i--) {
      const it = this.leavingItems[i]
      update(it)
      if (it.fade < 0.02 || this.offscreen(it, s, fy)) {
        this.releaseItem(it)
        this.leavingItems.splice(i, 1)
      }
    }
  }

  private offscreen(it: Item, s: number, fy: number): boolean {
    const sy = it.y - s + fy
    return sy + it.h < -60 || sy > this.vh + 60
  }

  private fill(it: Item, preferOrig: boolean, nowId: string | null, nowState: 'paused' | 'playing'): void {
    const n = it.node
    if (it.type === 'group') {
      const g: BrowseGroup | null = this.model.group(it.gi)
      if (g === it.data && it.ver === this.ver) return
      it.data = g
      it.ver = this.ver
      const title = g && preferOrig && g.kind === 'game' ? this.model.originalTitle(g.gameId, g.title) : null
      fillGroup(n, g, title, it.gi)
      return
    }
    const r = it.row
    if (!r) return
    const exKey = r.type === 'album' ? (r.album!.id === this.exAlbum ? 1 : 0) : 0
    const v = this.ver * 2 + exKey
    if (r === it.data && it.ver === v) return
    it.data = r
    it.ver = v
    if (r.type === 'album') {
      const a = r.album!
      fillAlbum(n, a, preferOrig ? (a.titleOriginal ?? a.title) : a.title, this.model.group(r.gi)?.kind !== 'game', a.id === this.exAlbum)
    } else if (r.type === 'track') {
      const t = r.track!
      fillTrack(n, t, preferOrig ? (t.titleOriginal ?? t.title) : t.title, t.id === nowId ? nowState : 'off', !!r.multiDisc)
    } else {
      fillLoading(n, r.label ?? 'Loading…')
    }
  }
}
