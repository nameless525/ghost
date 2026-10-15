// Settings overlay (purple hue, slides in from the left), osu!-style: a sidebar of section
// icons with scroll-spy, a search box that filters every setting by label / description /
// keywords, and sections of rows (label, description, control). Changes apply live.
import { SearchX, Settings as SettingsIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react'
import { stagger, tween } from '../../motion/tween'
import { useKeybinding } from '../../shell/keys'
import { useSettingsRequest } from '../../shell/navigation'
import type { OverlayProps } from '../../shell/types'
import { sfx } from '../../sound'
import { Button } from '../../ui/Button'
import { OverlayHeader } from '../../ui/OverlayHeader'
import { ScrollArea, scrollToSmooth } from '../../ui/ScrollArea'
import { SearchInput, type SearchInputHandle } from '../../ui/SearchInput'
import { Tooltip } from '../../ui/Tooltip'
import { cx } from '../../ui/util'
import { EmptyState } from '../library/common'
import { SearchContext } from './controls'
import { OpenContext, rowMatches, SECTIONS, type SectionDef, type SectionId } from './sections'
import './settings.css'

/** Props: open, phase ('entering' | 'open' | 'exiting' | 'closed'), close(), hue. */
export type SettingsOverlayProps = OverlayProps

const SPY_OFFSET = 90

export default function SettingsOverlay({ open }: SettingsOverlayProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<SectionId>('audio')
  const viewport = useRef<HTMLDivElement>(null)
  const side = useRef<HTMLDivElement>(null)
  const indicator = useRef<HTMLDivElement>(null)
  const search = useRef<SearchInputHandle>(null)
  const sectionEls = useRef(new Map<SectionId, HTMLElement>())
  const lockUntil = useRef(0)
  const q = query.trim().toLowerCase()

  // filtered view of the registry
  const visible = useMemo(() => {
    return SECTIONS.map((s) => ({
      section: s,
      groups: s.groups.map((g) => ({ group: g, rows: g.rows.filter((r) => rowMatches(r, s, g, q)) })).filter((g) => g.rows.length)
    })).filter((s) => s.groups.length)
  }, [q])
  const matchCount = visible.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.rows.length, 0), 0)
  const visibleIds = new Set(visible.map((v) => v.section.id))

  // ---- scroll-spy ------------------------------------------------------------------------
  const spy = () => {
    const vp = viewport.current
    if (!vp || performance.now() < lockUntil.current) return
    let current: SectionId | null = null
    for (const { section } of visible) {
      const el = sectionEls.current.get(section.id)
      if (el && el.offsetTop - SPY_OFFSET <= vp.scrollTop) current = section.id
    }
    if (vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 4 && visible.length) current = visible[visible.length - 1].section.id
    current ??= visible[0]?.section.id ?? 'audio'
    setActive((a) => (a === current ? a : current!))
  }
  useEffect(spy, [q]) // eslint-disable-line react-hooks/exhaustive-deps

  const jump = (id: SectionId) => {
    const vp = viewport.current
    const el = sectionEls.current.get(id)
    if (!vp || !el) return
    sfx.play('select', { volume: 0.7 })
    setActive(id)
    lockUntil.current = performance.now() + 700
    scrollToSmooth(vp, el.offsetTop - 6)
    // a little nudge on the section title so the eye lands on it
    const head = el.querySelector<HTMLElement>('.set-sec__head')
    if (head) tween(head).clear().set({ x: -14 }).moveToX(0, 600, 'outElasticHalf')
  }

  // indicator follows the active icon
  useLayoutEffect(() => {
    const s = side.current
    const ind = indicator.current
    const btn = s?.querySelector<HTMLElement>(`[data-section="${active}"]`)
    if (!ind || !btn) return
    ind.style.transform = `translateY(${btn.offsetTop + (btn.offsetHeight - 26) / 2}px)`
    ind.style.opacity = visibleIds.has(active) ? '1' : '0'
  })

  // entrance: sidebar icons pop in, sections slide in
  useLayoutEffect(() => {
    if (!open) return
    const icons = side.current?.querySelectorAll<HTMLElement>('.set-side__btn')
    if (icons) void stagger(icons, (t) => t.clear().set({ opacity: 0, x: -16 }).fadeIn(220, 'outQuad').moveToX(0, 520, 'outQuint'), 30, { delay: 80 })
    const heads = viewport.current?.querySelectorAll<HTMLElement>('.set-sec')
    if (heads) void stagger(Array.from(heads).slice(0, 2), (t) => t.clear().set({ opacity: 0, x: -30 }).fadeIn(260, 'outQuad').moveToX(0, 600, 'outQuint'), 70, { delay: 120 })
  }, [open])

  // re-run the row entrance when the search result set changes
  const prevQ = useRef(q)
  useLayoutEffect(() => {
    if (prevQ.current === q) return
    prevQ.current = q
    const vp = viewport.current
    if (!vp) return
    vp.scrollTop = 0
    const rows = vp.querySelectorAll<HTMLElement>('.set-sec__head, .set-group')
    void stagger(Array.from(rows).slice(0, 10), (t) => t.clear().set({ opacity: 0, y: 10 }).fadeIn(200, 'outQuad').moveToY(0, 420, 'outQuint'), 22)
  }, [q])

  // osu!-style: start typing anywhere in the panel to search
  const onKeyDown = (e: RKeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || e.key === ' ') return
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, [contenteditable="true"], [role="listbox"], [role="slider"]')) return
    search.current?.focus()
  }

  // openSettings('library') from elsewhere (the Downloads footer): land on that section
  const request = useSettingsRequest((s) => s)
  const handled = useRef(0)
  useEffect(() => {
    if (!open || !request.section || handled.current === request.seq) return
    const id = request.section as SectionId
    if (query) setQuery('')
    // after the panel (and a cleared search) has laid out
    const t = window.setTimeout(
      () => {
        handled.current = request.seq
        jump(id)
      },
      query ? 120 : 60
    )
    return () => window.clearTimeout(t)
  }, [open, request]) // eslint-disable-line react-hooks/exhaustive-deps

  useKeybinding('Mod+F', () => {
    search.current?.focus()
    search.current?.select()
  })

  return (
    <OpenContext.Provider value={open}>
      <SearchContext.Provider value={q}>
        <div className="set" onKeyDown={onKeyDown}>
          <nav ref={side} className="set-side" aria-label="Settings sections">
            <div ref={indicator} className="set-side__ind" />
            {SECTIONS.map((s) => (
              <Tooltip key={s.id} content={s.title} side="right">
                <button
                  type="button"
                  data-section={s.id}
                  className={cx('set-side__btn', active === s.id && 'set-side__btn--on', !visibleIds.has(s.id) && 'set-side__btn--dim')}
                  aria-label={s.title}
                  aria-current={active === s.id ? 'true' : undefined}
                  disabled={!visibleIds.has(s.id)}
                  onPointerEnter={() => sfx.play('hover')}
                  onClick={() => jump(s.id)}
                >
                  {s.icon}
                </button>
              </Tooltip>
            ))}
          </nav>
          <div className="set-main">
            <OverlayHeader icon={<SettingsIcon />} title="Settings" description="Changes apply instantly" />
            <div className="set-search">
              <SearchInput
                ref={search}
                value={query}
                onChange={setQuery}
                placeholder="Search settings"
                right={q ? <span className="set-search__count tnum">{matchCount}</span> : undefined}
                inputProps={{ 'aria-label': 'Search settings' }}
              />
            </div>
            <ScrollArea viewportRef={viewport} className="set-scroll" onScroll={spy}>
              {visible.length === 0 ? (
                <EmptyState
                  compact
                  icon={<SearchX />}
                  title="No settings match"
                  body={`Nothing matches “${query.trim()}”. Try a broader word like “audio”, “folder” or “key”.`}
                  actions={
                    <Button variant="ghost" onClick={() => setQuery('')}>
                      Clear search
                    </Button>
                  }
                />
              ) : (
                visible.map(({ section, groups }) => (
                  <Section
                    key={section.id}
                    section={section}
                    groups={groups}
                    elRef={(el) => {
                      if (el) sectionEls.current.set(section.id, el)
                      else sectionEls.current.delete(section.id)
                    }}
                  />
                ))
              )}
              <div className="set-tail" />
            </ScrollArea>
          </div>
        </div>
      </SearchContext.Provider>
    </OpenContext.Provider>
  )
}

function Section({ section, groups, elRef }: { section: SectionDef; groups: { group: SectionDef['groups'][number]; rows: SectionDef['groups'][number]['rows'] }[]; elRef: (el: HTMLElement | null) => void }) {
  return (
    <section ref={elRef} className={cx('set-sec', `set-sec--${section.id}`)} aria-labelledby={`set-h-${section.id}`}>
      <header className="set-sec__head">
        <span className="set-sec__icon">{section.icon}</span>
        <div>
          <h2 id={`set-h-${section.id}`} className="set-sec__title">
            {section.title}
          </h2>
          <div className="set-sec__blurb">{section.blurb}</div>
        </div>
      </header>
      {groups.map(({ group, rows }) => (
        <div key={group.title} className="set-group">
          {groups.length > 1 || group.title !== section.title ? <div className="set-group__title">{group.title}</div> : null}
          <div className="set-group__rows">
            {rows.map((r) => (
              <r.C key={r.id} label={r.label} description={r.description} />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
