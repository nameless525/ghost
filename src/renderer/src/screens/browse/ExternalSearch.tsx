// "Search online": look for a soundtrack that isn't in the catalog on the web sources (YouTube,
// SoundCloud, Bandcamp, the Internet Archive) as album-like results, and import one into the catalog.
// Used inline by the empty state and inside a dialog from the search panel's "Search online" button.
import { Check, Download, ExternalLink, Globe, Landmark, Search } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { withKnownSources } from '@shared/defaults'
import type { AlbumDetail, ExternalAlbumHit, ExternalProviderId, Progress } from '@shared/types'
import { ghost } from '../../ghost'
import { stagger } from '../../motion/tween'
import { notify } from '../../shell/notifications'
import { sfx } from '../../sound'
import { useTask } from '../../state/progress'
import { useSettings } from '../../state/settings'
import { Button } from '../../ui/Button'
import { CoverArt } from '../../ui/CoverArt'
import { Dialog } from '../../ui/Dialog'
import { formatTime } from '../../ui/format'
import { GhostMark } from '../../ui/GhostMark'
import { ProgressBar } from '../../ui/ProgressBar'
import { ProgressAnimator, progressValue } from '../../ui/progress'
import { SearchInput } from '../../ui/SearchInput'
import { Tooltip } from '../../ui/Tooltip'
import { cx } from '../../ui/util'
import { importExpectMs, recordSearchMs, searchCaption, searchSegments, type SearchSegment, type SourceOutcome } from './progress'
import { useBrowse } from './store'

const PROVIDERS: Record<ExternalProviderId, { name: string; hue: string }> = {
  youtube: { name: 'YouTube', hue: 'var(--danger)' },
  archive: { name: 'Internet Archive', hue: 'var(--info)' },
  bandcamp: { name: 'Bandcamp', hue: 'var(--hue-downloads)' },
  soundcloud: { name: 'SoundCloud', hue: 'var(--warning)' }
}

/** "A, B and C" (in a sentence: "the Internet Archive"). */
function listNames(ids: ExternalProviderId[]): string {
  const names = ids.map((id) => (id === 'archive' ? 'the Internet Archive' : PROVIDERS[id].name))
  if (!names.length) return 'the web'
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The enabled web sources in priority order. */
function useExternalSources(): ExternalProviderId[] {
  const order = useSettings((s) => s.sources.order)
  const disabled = useSettings((s) => s.sources.disabled)
  return useMemo(() => withKnownSources(order).filter((id): id is ExternalProviderId => id in PROVIDERS && !disabled.includes(id)), [order, disabled])
}

/** The enabled web sources in priority order, as "Bandcamp, the Internet Archive, YouTube and SoundCloud". */
export function useExternalSourceNames(): string {
  return listNames(useExternalSources())
}

/** Generic provider glyphs (drawn here; no brand assets). */
export function ProviderIcon({ provider }: { provider: ExternalAlbumHit['provider'] }) {
  if (provider === 'archive') return <Landmark className="bx-prov__svg" />
  if (provider === 'soundcloud')
    return (
      <svg className="bx-prov__svg" viewBox="0 0 24 24" aria-hidden>
        <path d="M2 15.5a2.5 2.5 0 0 1 2.5-2.5h.5v5h-.5A2.5 2.5 0 0 1 2 15.5M7 10h1.5v8H7zm3-2h1.5v10H10zm3-1a5.5 5.5 0 0 1 5.4 4.4A3.3 3.3 0 0 1 22 14.7 3.3 3.3 0 0 1 18.7 18H13z" fill="currentColor" />
      </svg>
    )
  if (provider === 'bandcamp')
    return (
      <svg className="bx-prov__svg" viewBox="0 0 24 24" aria-hidden>
        <path d="M2 18 8.5 6H22l-6.5 12z" fill="currentColor" />
      </svg>
    )
  return (
    <svg className="bx-prov__svg" viewBox="0 0 24 24" aria-hidden>
      <rect x="2" y="5" width="20" height="14" rx="4.5" fill="currentColor" />
      <path d="m10 9 5 3-5 3z" fill="var(--bg-1)" />
    </svg>
  )
}

export type Phase = 'idle' | 'loading' | 'done' | 'error'

export interface ExternalSearchProps {
  query: string
  /** Start searching immediately (dialog), or wait for the button (empty state). */
  auto?: boolean
  onImported: (detail: AlbumDetail) => void
  compact?: boolean
  /** Told when the search starts / finishes (the empty state compacts its header for results). */
  onPhase?: (phase: Phase) => void
}

export function ExternalSearch({ query, auto, onImported, compact, onPhase }: ExternalSearchProps) {
  const [phase, setPhase] = useState<Phase>(auto && query.trim() ? 'loading' : 'idle')
  const onPhaseRef = useRef(onPhase)
  onPhaseRef.current = onPhase
  useEffect(() => onPhaseRef.current?.(phase), [phase])
  const [hits, setHits] = useState<ExternalAlbumHit[]>([])
  /** The sources asked and how each answered so far (the rest are still searching; their results list as they land). */
  const [search, setSearch] = useState<{ ids: ExternalProviderId[]; outcome: Partial<Record<ExternalProviderId, SourceOutcome>>; startedAt: number; run: number }>({ ids: [], outcome: {}, startedAt: 0, run: 0 })
  const [error, setError] = useState<string | null>(null)
  /** The result being imported (provider + ref) and since when. */
  const [importing, setImporting] = useState<{ key: string; since: number } | null>(null)
  const [imported, setImported] = useState<Set<string>>(new Set())
  const list = useRef<HTMLDivElement>(null)
  const shown = useRef(new Set<string>())
  const seq = useRef(0)
  const q = query.trim()
  const ids = useExternalSources()

  // Each source is asked on its own so fast ones (Internet Archive, ~1 s) list before slow ones
  // (YouTube / SoundCloud via yt-dlp, 6–10 s); results merge by score as they land.
  const run = async () => {
    if (!q) return
    const my = ++seq.current
    const t0 = Date.now()
    setPhase('loading')
    setError(null)
    setHits([])
    shown.current.clear()
    setSearch({ ids, outcome: {}, startedAt: t0, run: my })
    const answered = (id: ExternalProviderId, how: SourceOutcome) => setSearch((s) => (s.run === my ? { ...s, outcome: { ...s.outcome, [id]: how } } : s))
    const errors: string[] = []
    let found = 0
    await Promise.all(
      ids.map((id) =>
        ghost()
          .catalog.searchExternal(q, [id])
          .then((res) => {
            if (my !== seq.current) return
            recordSearchMs(id, Date.now() - t0)
            answered(id, 'done')
            if (!res.length) return
            found += res.length
            setHits((h) => {
              const seen = new Set(h.map((x) => x.provider + x.ref))
              return [...h, ...res.filter((x) => !seen.has(x.provider + x.ref))].sort((a, b) => b.score - a.score)
            })
          })
          .catch((err) => {
            errors.push(err instanceof Error ? err.message : String(err))
            if (my === seq.current) answered(id, 'failed')
          })
      )
    )
    if (my !== seq.current) return
    if (!found && errors.length === ids.length) {
      setError(errors[0] ?? 'every source failed')
      setPhase('error')
    } else setPhase('done')
  }

  useEffect(() => {
    if (auto && q) void run()
    else {
      seq.current++
      setPhase('idle')
      setHits([])
    }
  }, [q, auto]) // eslint-disable-line react-hooks/exhaustive-deps

  // Slide in only the rows that just arrived.
  useEffect(() => {
    if (!list.current) return
    const fresh = Array.from(list.current.children).filter((el) => {
      const k = (el as HTMLElement).dataset.key ?? ''
      if (shown.current.has(k)) return false
      shown.current.add(k)
      return true
    })
    if (fresh.length) void stagger(fresh, (t) => t.set({ opacity: 0, x: 26 }).fadeIn(260, 'outQuad').moveToX(0, 520, 'outQuint'), 45)
  }, [hits])

  const doImport = async (hit: ExternalAlbumHit) => {
    if (importing) return
    setImporting({ key: hit.provider + hit.ref, since: Date.now() })
    sfx.play('confirm', { volume: 0.5 })
    try {
      const d = await ghost().catalog.importExternal(hit)
      setImported((s) => new Set(s).add(hit.ref))
      notify({ kind: 'success', title: 'Imported into your catalog', body: d.album.title, image: d.album.cover })
      onImported(d)
    } catch (err) {
      sfx.play('error')
      notify({ kind: 'error', title: 'Import failed', body: err instanceof Error ? err.message : String(err) })
    } finally {
      setImporting(null)
    }
  }

  if (phase === 'idle') {
    return (
      <Button variant="primary" size={compact ? 'md' : 'lg'} icon={<Globe />} onClick={() => void run()} disabled={!q}>
        Search online for “{q}”
      </Button>
    )
  }

  return (
    <div className={cx('bx', compact && 'bx--compact')}>
      {search.ids.length > 0 && (phase === 'loading' || (phase === 'done' && hits.length > 0)) && <SearchProgress {...search} solo={hits.length === 0} />}
      {phase === 'error' && (
        <div className="bx__msg bx__msg--error">
          Search failed: {error}
          <Button size="sm" variant="secondary" onClick={() => void run()}>
            Retry
          </Button>
        </div>
      )}
      {phase === 'done' && hits.length === 0 && (
        <div className="bx__msg">
          <GhostMark />
          No albums found online for “{q}”. Try fewer words, or the game’s original title.
        </div>
      )}
      {hits.length > 0 && (
        <div className="bx__list" ref={list}>
          {hits.map((h) => {
            const p = PROVIDERS[h.provider]
            const done = imported.has(h.ref)
            const busy = importing?.key === h.provider + h.ref
            return (
              <div key={h.provider + h.ref} data-key={h.provider + h.ref} className={cx('bx-hit', busy && 'bx-hit--importing')} style={{ '--ph': p.hue } as CSSProperties}>
                <div className="bx-hit__art">
                  <CoverArt src={h.cover} size={52} radius={8} hue={null} />
                  <span className="bx-prov" title={p.name}>
                    <ProviderIcon provider={h.provider} />
                  </span>
                </div>
                <div className="bx-hit__text">
                  <div className="bx-hit__title g-ellipsis" title={h.title}>
                    {h.title}
                  </div>
                  {busy ? (
                    <ImportWait hit={h} since={importing!.since} />
                  ) : (
                    <div className="bx-hit__sub g-ellipsis">
                      <span className="bx-hit__prov">{p.name}</span>
                      {h.subtitle && <> · {h.subtitle}</>}
                      {h.trackCount != null && <> · {h.trackCount} tracks</>}
                      {h.totalMs != null && <> · {formatTime(h.totalMs)}</>}
                    </div>
                  )}
                </div>
                <MatchScore score={h.score} />
                <Tooltip content={`Open on ${p.name}`}>
                  <button type="button" className="g-icon-btn g-icon-btn--sm" aria-label={`Open on ${p.name}`} onClick={() => void ghost().system.openExternal(h.url)}>
                    <ExternalLink />
                  </button>
                </Tooltip>
                <Tooltip content={done ? 'In your catalog' : 'Add it to your catalog, to play, queue and download like any other album'}>
                  <Button size="sm" variant={done ? 'soft' : 'primary'} icon={done ? <Check /> : <Download />} loading={busy} disabled={!!importing && !busy} onClick={() => void doImport(h)}>
                    {done ? 'Imported' : 'Import'}
                  </Button>
                </Tooltip>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** How likely a result is the complete official soundtrack, in words (the % is in the tooltip). */
function MatchScore({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const [label, tone] = score >= 0.8 ? ['Strong match', 'best'] : score >= 0.6 ? ['Good match', 'good'] : ['Possible match', 'weak']
  return (
    <Tooltip content={`${pct}% likely to be the complete official soundtrack`}>
      <span className={cx('bx-score', `bx-score--${tone}`)} aria-label={`${label}, ${pct}%`}>
        {label}
      </span>
    </Tooltip>
  )
}

/**
 * The search's progress, honest about who it waits on: one segment per source, each easing along
 * that source's usual answer time and filling the moment it answers ("2 of 4 sources"). Above the
 * results (it stays put while they scroll), then a summary of the finished search.
 */
function SearchProgress({ ids, outcome, startedAt, run, solo }: { ids: ExternalProviderId[]; outcome: Partial<Record<ExternalProviderId, SourceOutcome>>; startedAt: number; run: number; solo: boolean }) {
  const segments = useMemo(() => searchSegments(ids, outcome, startedAt), [ids, outcome, startedAt])
  const { label, detail } = searchCaption(ids, outcome, (id) => PROVIDERS[id].name)
  const answered = ids.filter((id) => outcome[id]).length
  return (
    <div
      className={cx('g-progress bx-progress', solo && 'bx-progress--solo', answered === ids.length && 'bx-progress--done')}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={ids.length}
      aria-valuenow={answered}
      aria-valuetext={[label, detail].filter(Boolean).join(', ')}
    >
      <div className="g-progress__caption">
        <span className="g-progress__label">{label}</span>
        {detail && <span className="g-progress__detail">{detail}</span>}
      </div>
      <div className="bx-progress__segs">
        {segments.map((s) => (
          <Segment key={s.id} seg={s} run={run} />
        ))}
      </div>
    </div>
  )
}

/** One source's share of the search bar (ProgressBar's motion: a Web Animation, nothing per frame). */
function Segment({ seg, run }: { seg: SearchSegment; run: number }) {
  const fill = useRef<HTMLSpanElement>(null)
  const anim = useRef<ProgressAnimator | null>(null)
  const lastRun = useRef<number | null>(null)
  const { state, progress } = seg
  useLayoutEffect(() => {
    const el = fill.current
    if (!el) return
    const a = (anim.current ??= new ProgressAnimator({ el, kind: 'scaleX' }))
    if (lastRun.current !== run) {
      lastRun.current = run
      a.jump(state === 'pending' ? (progressValue(progress) ?? 0) : 0)
    }
    if (state === 'pending') a.set(progress)
    else a.finish()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a step is its since/expectMs
  }, [run, state, progress.since, progress.expectMs])
  useLayoutEffect(
    () => () => {
      anim.current?.dispose()
      anim.current = null
    },
    []
  )
  const name = PROVIDERS[seg.id].name
  return (
    <span className={cx('bx-seg g-progress__track', `bx-seg--${state}`)} title={`${name}: ${state === 'pending' ? 'searching' : state === 'done' ? 'answered' : 'didn’t answer'}`}>
      <span ref={fill} className="g-progress__fill g-keep-motion" />
    </span>
  )
}

/** An import in progress, on its row: what it's doing (main's 'progress' task, else an estimate) and a line along the row. */
function ImportWait({ hit, since }: { hit: ExternalAlbumHit; since: number }) {
  const task = useTask(`import:${hit.provider}:${hit.ref}`)
  const p: Progress = task ?? { label: `Importing from ${PROVIDERS[hit.provider].name}`, detail: null, fraction: null, expectMs: importExpectMs(hit), since }
  return (
    <>
      <div className="bx-hit__sub bx-hit__sub--wait g-ellipsis">
        {p.label}
        {p.detail ? <span className="tnum"> · {p.detail}</span> : '…'}
      </div>
      <ProgressBar className="bx-hit__load" size="thin" progress={p} waitKey={since} done={!!task?.done} />
    </>
  )
}

/** The "Search online" dialog, with an editable query (searches on Enter or the Search button). */
export function ExternalSearchDialog({ onImported }: { onImported: (d: AlbumDetail) => void }) {
  const open = useBrowse((s) => s.externalOpen)
  const initial = useBrowse((s) => s.externalQuery)
  const [draft, setDraft] = useState(initial)
  const [query, setQuery] = useState(initial)
  useEffect(() => {
    if (open) {
      setDraft(initial)
      setQuery(initial)
    }
  }, [open, initial])
  const close = () => useBrowse.setState({ externalOpen: false })
  const sources = useExternalSourceNames()
  return (
    <Dialog open={open} onClose={close} title="Search online" icon={<Globe />} width={720} hue="browse">
      <div className="bx-dialog">
        <p className="bx-dialog__lead">Find a soundtrack that isn’t in your catalog on {sources}. Import a result to play it like any other album.</p>
        <div className="bx-dialog__bar">
          <SearchInput value={draft} onChange={setDraft} onSubmit={(v) => setQuery(v.trim())} placeholder="Game or soundtrack name" autoFocus onEscape={close} />
          <Button variant="primary" icon={<Search />} disabled={!draft.trim() || draft.trim() === query} onClick={() => setQuery(draft.trim())}>
            Search
          </Button>
        </div>
        <div className="bx-dialog__results">
          {query ? (
            <ExternalSearch
              key={query}
              query={query}
              auto
              compact
              onImported={(d) => {
                close()
                onImported(d)
              }}
            />
          ) : (
            <div className="bx__msg">Type the name of a game or soundtrack, then press Enter.</div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
