// Imperative DOM for carousel panels. Nodes are pooled and recycled by the carousel, so
// everything here is "build once, refill many": no React, no per-fill allocation beyond
// strings, and only text/attribute writes when a value actually changed.
import { intensityColor } from '@shared/defaults'
import type { Album, AlbumKind, AudioFormat, BrowseGroup, Progress, TrackView } from '@shared/types'
import { artUrl } from '../../lib/art'
import { sourceLabel } from '../../ui/Badges'
import { formatTime } from '../../ui/format'
import { ProgressAnimator, progressMode, progressValue } from '../../ui/progress'

export type PanelType = 'group' | 'album' | 'track' | 'loading'

export interface PanelNode {
  type: PanelType
  el: HTMLDivElement
  panel: HTMLDivElement
  /** Beat-pulsing rim (opacity per frame). Sibling of the panel. */
  glow: HTMLDivElement
  /** Selection ring + outer glow (opacity follows the selection fade). Sibling of the panel. */
  ring: HTMLDivElement
  title: HTMLElement
  sub: HTMLElement | null
  meta: HTMLElement | null
  img: HTMLImageElement | null
  /**
   * Group rows: a small copy of the cover under `img` (the source's own thumbnail where it has
   * one, a few KB), shown until the full-size one has downloaded.
   */
  preview: HTMLImageElement | null
  right: HTMLElement | null
  num: HTMLElement | null
  /** Loading rows: what the row waits on, as a line along its bottom. */
  load: LoadLine | null
  /** Last values written, to skip redundant DOM writes. */
  cache: Record<string, string>
}

/**
 * A loading row's progress line (the ProgressBar look, driven imperatively). Its animator exists
 * only while the row shows a wait; the motion is a Web Animation, so nothing runs per frame.
 */
interface LoadLine {
  bar: HTMLElement
  fill: HTMLElement
  detail: HTMLElement
  anim: ProgressAnimator | null
  /** The wait it shows (a new one starts the line where that wait already is). */
  key: string | null
  /** Last planned step, so unchanged progress isn't re-planned. */
  sig: string
}

const STAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>'
const HEART =
  '<svg class="bc-heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/></svg>'
const DISC =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="2"/><path d="M6 12c0-1.7.7-3.2 1.8-4.2"/><path d="M18 12c0 1.7-.7 3.2-1.8 4.2"/></svg>'

export const KIND_LABEL: Record<AlbumKind, string> = {
  ost: 'OST',
  gamerip: 'Gamerip',
  arrange: 'Arrange',
  remix: 'Remix',
  single: 'Single',
  compilation: 'Compilation',
  other: 'Other'
}

/** What each album kind means, for the tags' tooltips (first-time users won't know "gamerip"). */
export const KIND_HINT: Record<AlbumKind, string> = {
  ost: 'Official soundtrack: the music as released by the game’s publisher',
  gamerip: 'Gamerip: the music taken straight from the game’s files, often more complete than the official release',
  arrange: 'Arrangement: the game’s music re-recorded or re-arranged',
  remix: 'Remixes of the game’s music',
  single: 'Single: one or a few songs released on their own',
  compilation: 'Compilation: music from several games or releases',
  other: 'Other music related to the game'
}

/** What a source badge (FLAC / 320 / CHIP / YT) means, for its tooltip. */
export function formatHint(source: Parameters<typeof sourceLabel>[0] | null): string | undefined {
  const tone = source ? sourceLabel(source)?.tone : null
  if (tone === 'flac') return 'Lossless audio (CD quality or better)'
  if (tone === 'chip') return 'Chiptune: GHOST plays the game’s original music data through an emulator'
  if (tone === 'yt') return 'Streamed from YouTube'
  if (tone === 'hq') return 'High-quality compressed audio'
  if (tone === 'lq') return 'Compressed audio'
  return undefined
}

const GROUP_NOUN: Record<string, [string, string]> = {
  game: ['album', 'albums'],
  album: ['track', 'tracks'],
  composer: ['album', 'albums'],
  franchise: ['album', 'albums'],
  platform: ['album', 'albums'],
  year: ['album', 'albums']
}

export const plural = (n: number, one: string, many: string = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))

function div(cls: string, parent?: HTMLElement): HTMLDivElement {
  const d = document.createElement('div')
  d.className = cls
  parent?.appendChild(d)
  return d
}

function span(cls: string, parent?: HTMLElement): HTMLSpanElement {
  const s = document.createElement('span')
  s.className = cls
  parent?.appendChild(s)
  return s
}

function makeImg(cls: string, parent: HTMLElement): HTMLImageElement {
  const img = document.createElement('img')
  img.className = cls
  img.decoding = 'async'
  img.draggable = false
  img.alt = ''
  img.addEventListener('load', () => img.classList.add('is-loaded'))
  img.addEventListener('error', () => img.classList.remove('is-loaded'))
  parent.appendChild(img)
  return img
}

export function createPanel(type: PanelType): PanelNode {
  const el = div(`bc-item bc-item--${type}`)
  el.setAttribute('role', type === 'loading' ? 'presentation' : 'option')
  const panel = div('bc-panel', el)
  let img: HTMLImageElement | null = null
  let preview: HTMLImageElement | null = null
  let sub: HTMLElement | null = null
  let meta: HTMLElement | null = null
  let right: HTMLElement | null = null
  let num: HTMLElement | null = null
  let load: LoadLine | null = null
  let title: HTMLElement
  if (type === 'group') {
    const art = div('bc-art', panel)
    preview = makeImg('bc-art__img bc-art__img--preview', art)
    img = makeImg('bc-art__img', art)
    div('bc-shade', panel)
    div('bc-edge', panel)
    const content = div('bc-content', panel)
    title = div('bc-title', content)
    sub = div('bc-sub', content)
    meta = div('bc-meta', content)
  } else if (type === 'album') {
    div('bc-edge', panel)
    const content = div('bc-content', panel)
    const thumb = div('bc-thumb', content)
    thumb.innerHTML = DISC
    img = makeImg('bc-thumb__img', thumb)
    const text = div('bc-text', content)
    title = div('bc-title', text)
    sub = div('bc-sub', text)
    right = div('bc-right', content)
  } else if (type === 'track') {
    const content = div('bc-content', panel)
    num = span('bc-num', content)
    num.innerHTML = '<span class="bc-num__n"></span><span class="bc-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>'
    title = span('bc-title', content)
    right = span('bc-right', content)
  } else {
    const content = div('bc-content', panel)
    content.innerHTML = '<span class="bc-spin" aria-hidden="true"></span>'
    title = span('bc-title', content)
    const detail = span('bc-detail tnum', content)
    const bar = div('bc-load', panel)
    bar.innerHTML = '<span class="g-progress__fill g-keep-motion"></span><span class="g-progress__sweep g-keep-motion"></span>'
    load = { bar, fill: bar.firstElementChild as HTMLElement, detail, anim: null, key: null, sig: '' }
  }
  // Siblings of the panel (not children) so their opacity can live on their own compositor
  // layers without the panel's rounded overflow clip.
  const ring = div('bc-ring', el)
  const glow = div('bc-glow', el)
  return { type, el, panel, glow, ring, title, sub, meta, img, preview, right, num, load, cache: {} }
}

function setText(n: PanelNode, key: string, el: HTMLElement | null, text: string): void {
  if (!el || n.cache[key] === text) return
  n.cache[key] = text
  el.textContent = text
}

function setHTML(n: PanelNode, key: string, el: HTMLElement | null, html: string): void {
  if (!el || n.cache[key] === html) return
  n.cache[key] = html
  el.innerHTML = html
}

/** Width (css px) group rows ask their cover for: .bc-art is 196 px wide. */
export const GROUP_ART_W = 200
/** Width of the preview under it: the smallest size the art protocol makes (128 px at 2x). */
const PREVIEW_W = 64

function loadInto(img: HTMLImageElement, src: string): void {
  img.classList.remove('is-loaded')
  if (!src) {
    img.removeAttribute('src')
    return
  }
  img.src = src
  if (img.complete && img.naturalWidth > 0) img.classList.add('is-loaded')
}

function setImg(n: PanelNode, url: string | null, w: number): void {
  const img = n.img
  if (!img) return
  const src = artUrl(url, { w }) ?? ''
  if (n.cache.img === src) return
  n.cache.img = src
  loadInto(img, src)
  // The preview only while the full-size cover is still on its way (not when it was cached).
  if (n.preview) loadInto(n.preview, src && !img.classList.contains('is-loaded') ? (artUrl(url, { w: PREVIEW_W }) ?? '') : '')
}

function setVar(n: PanelNode, name: string, value: string): void {
  if (n.cache[name] === value) return
  n.cache[name] = value
  n.el.style.setProperty(name, value)
}

/** Toggle a class (cached). Returns true when it actually changed. */
export function setClass(n: PanelNode, cls: string, on: boolean): boolean {
  const k = 'c:' + cls
  const v = on ? '1' : ''
  if (n.cache[k] === v) return false
  n.cache[k] = v
  n.el.classList.toggle(cls, on)
  return true
}

// ---------------------------------------------------------------- group (game / bucket)

export function fillGroup(n: PanelNode, g: BrowseGroup | null, title: string | null, gi: number): void {
  setClass(n, 'is-skeleton', !g)
  n.el.dataset.gi = String(gi)
  if (!g) {
    setText(n, 'title', n.title, '')
    setText(n, 'sub', n.sub, '')
    setHTML(n, 'meta', n.meta, '')
    setImg(n, null, 0)
    setVar(n, '--ga', 'var(--accent)')
    return
  }
  setText(n, 'title', n.title, title ?? g.title)
  let sub: string
  if (g.kind === 'game') sub = [g.year, g.platforms.slice(0, 3).join(' · ')].filter(Boolean).join(' · ')
  else sub = g.subtitle ?? ''
  setText(n, 'sub', n.sub, sub)
  const [one, many] = GROUP_NOUN[g.kind] ?? ['album', 'albums']
  let meta = `<span class="bc-chip">${esc(plural(g.albumCount, one, many))}</span>`
  if (g.kind !== 'game' && g.kind !== 'album') meta = `<span class="bc-chip bc-chip--kind">${esc(g.kind)}</span>` + meta
  if (g.kind === 'game' && g.platforms.length > 3) meta += `<span class="bc-chip bc-chip--soft">+${g.platforms.length - 3}</span>`
  setHTML(n, 'meta', n.meta, meta)
  setImg(n, g.cover ?? g.hero, GROUP_ART_W)
  setVar(n, '--ga', g.accent ?? 'var(--accent)')
}

// ---------------------------------------------------------------- album row

function formatBadges(formats: AudioFormat[]): string {
  const seen = new Set<string>()
  let out = ''
  for (const f of formats) {
    const s = sourceLabel(f)
    if (!s || seen.has(s.label)) continue
    seen.add(s.label)
    out += `<span class="g-source g-source--${s.tone}" title="${esc(formatHint(f) ?? '')}">${esc(s.label)}</span>`
    if (seen.size >= 2) break
  }
  return out
}

/** Where an album comes from, when it isn't the main catalog source: [tag, full name]. */
const PROVIDER_TAGS: Record<string, [string, string]> = {
  zophar: ['Zophar', 'Zophar’s Domain'],
  modland: ['Modland', 'Modland'],
  archive: ['IA', 'the Internet Archive'],
  youtube: ['YouTube', 'YouTube'],
  soundcloud: ['SoundCloud', 'SoundCloud'],
  bandcamp: ['Bandcamp', 'Bandcamp'],
  local: ['Local', 'your music folders']
}

export function fillAlbum(n: PanelNode, a: Album, title: string, showGame: boolean, expanded: boolean): void {
  setText(n, 'title', n.title, title)
  const bits: string[] = []
  if (showGame && a.gameName) bits.push(a.gameName)
  if (a.year) bits.push(String(a.year))
  if (a.trackCount != null) bits.push(plural(a.trackCount, 'track'))
  if (a.totalMs) bits.push(formatTime(a.totalMs))
  setText(n, 'sub', n.sub, bits.join(' · '))
  const from = PROVIDER_TAGS[a.provider]
  setHTML(
    n,
    'right',
    n.right,
    `${from ? `<span class="bc-from" title="From ${esc(from[1])}">${esc(from[0])}</span>` : ''}<span class="bc-kind bc-kind--${a.kind}" title="${esc(KIND_HINT[a.kind] ?? '')}">${esc(KIND_LABEL[a.kind] ?? a.kind)}</span>${formatBadges(a.formats)}`
  )
  setImg(n, a.cover, 40) // .bc-thumb is 38 css px
  setClass(n, 'is-expanded', expanded)
}

// ---------------------------------------------------------------- track row

export function fillTrack(n: PanelNode, t: TrackView, title: string, playing: 'off' | 'paused' | 'playing', multiDisc = false): void {
  setText(n, 'title', n.title, title)
  const numEl = n.num?.firstElementChild as HTMLElement | null
  setText(n, 'num', numEl, (multiDisc ? `${t.disc}·` : '') + String(t.number).padStart(2, '0'))
  setClass(n, 'is-now', playing !== 'off')
  setClass(n, 'is-now-paused', playing === 'paused')
  setClass(n, 'is-liked', t.liked)
  const src = sourceLabel(t.source)
  const stars = t.analysis?.intensity
  let html = ''
  if (t.liked) html += HEART
  if (t.downloaded) html += '<span class="bc-dl" title="Downloaded"></span>'
  if (src) html += `<span class="g-source g-source--${src.tone}" title="${esc(formatHint(t.source) ?? '')}">${esc(src.label)}</span>`
  if (stars != null && Number.isFinite(stars)) {
    html += `<span class="g-intensity g-intensity--sm${stars >= 6.5 ? ' g-intensity--bright' : ''}" style="--ic:${intensityColor(stars)}">${STAR}${stars.toFixed(2)}</span>`
  } else html += `<span class="g-intensity g-intensity--sm g-intensity--empty">${STAR}–</span>`
  html += `<span class="bc-len tnum">${t.durationMs ? formatTime(t.durationMs) : '–:––'}</span>`
  setHTML(n, 'right', n.right, html)
}

/**
 * A loading row: its label, and when it waits on something (`key` names the wait, `p` how far it
 * is) the detail ("4.2 of 12.0 MB") and the progress line. Without a wait ("No albums match") the
 * spinner and line go.
 */
export function fillLoading(n: PanelNode, label: string, key: string | null = null, p: Progress | null = null, done = false): void {
  setText(n, 'title', n.title, label)
  const l = n.load
  if (!l) return
  setText(n, 'detail', l.detail, (key && p?.detail) || '')
  setClass(n, 'is-static', !key)
  if (!key || !p) {
    stopLoadLine(n)
    return
  }
  const indeterminate = !done && progressMode(p) === 'indeterminate'
  if (n.cache.indet !== String(indeterminate)) {
    n.cache.indet = String(indeterminate)
    l.bar.classList.toggle('is-indeterminate', indeterminate)
  }
  const a = (l.anim ??= new ProgressAnimator({ el: l.fill, kind: 'scaleX' }))
  if (l.key !== key) {
    // rows appear a moment into their wait: start where it already is
    l.key = key
    l.sig = ''
    a.jump(progressValue(p) ?? 0)
  }
  const sig = done ? 'done' : `${p.fraction}|${p.expectMs}|${p.since}|${p.span?.[0]}|${p.span?.[1]}`
  if (sig === l.sig) return
  l.sig = sig
  if (done) a.finish()
  else a.set(p)
}

/** A loading row is leaving (what it waited for arrived): its line fills as it fades. */
export function finishLoading(n: PanelNode): void {
  const l = n.load
  if (!l?.anim || l.sig === 'done') return
  l.sig = 'done'
  l.bar.classList.remove('is-indeterminate')
  delete n.cache.indet
  l.anim.finish()
}

function stopLoadLine(n: PanelNode): void {
  const l = n.load
  if (!l) return
  // no sweep left running on a pooled (hidden) node
  if (n.cache.indet === 'true') l.bar.classList.remove('is-indeterminate')
  delete n.cache.indet
  l.anim?.dispose()
  l.anim = null
  l.key = null
  l.sig = ''
}

/** A node leaves for good (dropped from the pool): stop what it runs. */
export function disposePanel(n: PanelNode): void {
  stopLoadLine(n)
}

/** Reset per-use state when a node goes back to the pool. */
export function resetPanel(n: PanelNode): void {
  stopLoadLine(n)
  n.el.classList.remove('is-selected', 'is-hover', 'is-active', 'is-lit')
  n.el.removeAttribute('aria-selected')
  delete n.cache['c:is-selected']
  delete n.cache['c:is-hover']
  delete n.cache['c:is-active']
  delete n.cache['c:is-lit']
  n.el.style.opacity = '0'
  delete n.cache.o
}
