// Top-right filter control (osu!lazer's song-select filter): syntax-highlighted search,
// result count, group + sort selectors and a slim catalog-indexing progress line.
import { Calendar, CalendarClock, DiscAlbum, Dices, Gamepad2, History, Layers, MicVocal, Monitor, Star, Timer, Type } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import type { GroupBy, SortBy } from '@shared/types'
import { parseSearch } from '@shared/search'
import { sfx } from '../../sound'
import { ProgressBar } from '../../ui/ProgressBar'
import { SearchInput, type SearchInputHandle } from '../../ui/SearchInput'
import { Select, type SelectOption } from '../../ui/Select'
import { Tooltip } from '../../ui/Tooltip'
import { cx } from '../../ui/util'
import { formatEtaShort } from './activity'
import { CatalogActivityPopover } from './CatalogActivity'
import { browseModel } from './model'
import { applyQuery, setSearchText } from './query'
import { GROUP_LABELS, GROUP_NOUNS, SORT_LABELS, useBrowse } from './store'
import { useRestartKey } from './waits'

const ic = { width: 15, height: 15 }

const GROUP_OPTIONS: SelectOption<GroupBy>[] = [
  { value: 'game', label: GROUP_LABELS.game, icon: <Gamepad2 style={ic} /> },
  { value: 'album', label: GROUP_LABELS.album, icon: <DiscAlbum style={ic} /> },
  { value: 'composer', label: GROUP_LABELS.composer, icon: <MicVocal style={ic} /> },
  { value: 'franchise', label: GROUP_LABELS.franchise, icon: <Layers style={ic} /> },
  { value: 'platform', label: GROUP_LABELS.platform, icon: <Monitor style={ic} /> },
  { value: 'year', label: GROUP_LABELS.year, icon: <Calendar style={ic} /> }
]

const SORT_OPTIONS: SelectOption<SortBy>[] = [
  { value: 'title', label: SORT_LABELS.title, icon: <Type style={ic} /> },
  { value: 'year', label: SORT_LABELS.year, icon: <CalendarClock style={ic} /> },
  { value: 'recent', label: SORT_LABELS.recent, icon: <History style={ic} /> },
  { value: 'length', label: SORT_LABELS.length, icon: <Timer style={ic} /> },
  { value: 'intensity', label: SORT_LABELS.intensity, icon: <Star style={ic} /> },
  { value: 'random', label: SORT_LABELS.random, icon: <Dices style={ic} /> }
]

/** Mirror of the query with filter tokens coloured (must reproduce the text exactly). */
export function SearchSyntax({ text }: { text: string }) {
  const parsed = useMemo(() => parseSearch(text), [text])
  const out: ReactNode[] = []
  let i = 0
  parsed.tokens.forEach((t, k) => {
    if (t.start > i) out.push(text.slice(i, t.start))
    out.push(
      <span key={k} className={`bs-tok bs-tok--${t.type}`}>
        {t.text}
      </span>
    )
    i = t.end
  })
  if (i < text.length) out.push(text.slice(i))
  return <>{out}</>
}

export function SearchBar({ inputRef, onSubmit }: { inputRef: Ref<SearchInputHandle>; onSubmit: () => void }) {
  const text = useBrowse((s) => s.text)
  const group = useBrowse((s) => s.group)
  const sort = useBrowse((s) => s.sort)
  const total = useBrowse((s) => s.total)
  const loading = useBrowse((s) => s.loading)
  // Only what the bar itself shows: the full status object changes ~3×/s while indexing, and
  // re-rendering the whole bar (selects, input, syntax highlight) for it was wasted work.
  const indexing = useBrowse((s) => !!s.status?.indexing)
  const progress = useBrowse((s) => (s.status?.indexing ? (s.status.progress ?? null) : null))
  const parsed = useMemo(() => parseSearch(text), [text])
  const pending = text.trim() !== browseModel.query.text || loading

  const [one, many] = GROUP_NOUNS[group]
  const count = total == null ? null : total === 0 ? 'No matches' : `${total.toLocaleString()} ${total === 1 ? one : many}`
  const error = parsed.errors[0]?.message

  return (
    <div className="bs">
      <div className="bs__panel">
        <div className="bs__inner">
          <SearchInput
            ref={inputRef}
            size="lg"
            value={text}
            onChange={(v) => setSearchText(v)}
            onSubmit={() => {
              applyQuery(true)
              onSubmit()
            }}
            highlight={(v) => <SearchSyntax text={v} />}
            loading={pending && !!text}
            placeholder="Search games, albums, composers…"
            right={count && <span className={cx('bs__count', total === 0 && 'bs__count--none')}>{count}</span>}
            inputProps={{ 'aria-label': 'Search the catalog' }}
          />
          <div className="bs__row">
            <Select<GroupBy>
              value={group}
              options={GROUP_OPTIONS}
              prefix={<span className="bs__prefix">Group</span>}
              onChange={(g) => {
                useBrowse.setState({ group: g })
                applyQuery(true)
              }}
              aria-label="Group by"
            />
            <Select<SortBy>
              value={sort}
              options={SORT_OPTIONS}
              prefix={<span className="bs__prefix">Sort</span>}
              onChange={(s) => {
                useBrowse.setState({ sort: s })
                applyQuery(true)
              }}
              aria-label="Sort by"
            />
            <div className="bs__status">
              {error ? (
                <span className="bs__error">{error}</span>
              ) : indexing ? (
                <IndexingStatus />
              ) : parsed.filters.length ? (
                <FilterSummary count={parsed.filters.length} />
              ) : (
                <SyntaxHint />
              )}
            </div>
          </div>
        </div>
        <IndexingLine active={indexing} progress={progress} />
      </div>
    </div>
  )
}

/**
 * "One-time setup · Zophar's Domain and Internet Archive · 42% · about 3 min left" (first-time
 * crawls) or a quieter "Refreshing KHInsider · 57%". Opens the per-source activity popover.
 */
function IndexingStatus() {
  const status = useBrowse((s) => s.status)
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  if (!status) return null
  const running = (status.sources ?? []).filter((s) => s.state === 'running').map((s) => s.name)
  const names = running.length <= 2 ? running.join(' and ') : `${running.length} sources`
  const pct = status.progress != null ? Math.round(status.progress * 100) : null
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={cx('bs__indexing', status.setup && 'bs__indexing--setup')}
        aria-expanded={open}
        title={status.message ?? undefined}
        onClick={() => {
          sfx.play(open ? 'collapse' : 'expand', { volume: 0.45 })
          setOpen((o) => !o)
        }}
      >
        <span className="bs__pulse" />
        {status.setup ? <span className="bs__setup">One-time setup</span> : 'Refreshing'}
        {names && status.setup && <span className="bs__sep">·</span>}
        {names && <span className="bs__names">{names}</span>}
        {pct != null && <b className="tnum">{pct}%</b>}
        {status.etaMs != null && (
          <>
            <span className="bs__sep">·</span>
            <span className="bs__eta tnum">{formatEtaShort(status.etaMs)} left</span>
          </>
        )}
      </button>
      {open && btn.current && <CatalogActivityPopover status={status} anchor={btn.current} onClose={() => setOpen(false)} />}
    </>
  )
}

function FilterSummary({ count }: { count: number }) {
  return (
    <span className="bs__hint">
      {count} filter{count === 1 ? '' : 's'} active
    </span>
  )
}

function SyntaxHint() {
  return (
    <Tooltip
      side="bottom"
      content={
        <span className="bs__tip">
          Filters: <b>composer</b> <b>game</b> <b>platform</b> <b>year</b> <b>length</b> <b>bpm</b> <b>intensity</b> <b>source</b> <b>kind</b> <b>liked</b> <b>downloaded</b>
          <br />
          Operators = != &gt; &lt; &gt;= &lt;= · exclude with -word
        </span>
      }
    >
      <span className="bs__hint bs__hint--example" tabIndex={-1}>
        try <SearchSyntax text="platform=snes intensity>5 length<4m" />
      </span>
    </Tooltip>
  )
}

/** Along the panel's bottom edge: how far indexing is (a sweep while that's unknown), still and faded out otherwise. */
function IndexingLine({ active, progress }: { active: boolean; progress: number | null }) {
  const run = useRestartKey(active, progress)
  return <ProgressBar className={cx('bs-progress', active && 'bs-progress--on')} size="thin" progress={active ? progress : 0} waitKey={run} aria-label="Catalog indexing" />
}
