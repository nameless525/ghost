// "Can't find it?": search YouTube, Internet Archive and Bandcamp for album-like results and
// import one into the catalog. Used inline by the empty state and inside a dialog from the footer.
import { Check, Download, ExternalLink, Landmark, Telescope } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AlbumDetail, ExternalAlbumHit } from '@shared/types'
import { ghost } from '../../ghost'
import { stagger } from '../../motion/tween'
import { notify } from '../../shell/notifications'
import { sfx } from '../../sound'
import { Button } from '../../ui/Button'
import { CoverArt } from '../../ui/CoverArt'
import { Dialog } from '../../ui/Dialog'
import { formatTime } from '../../ui/format'
import { GhostMark } from '../../ui/GhostMark'
import { LoadingRing } from '../../ui/LoadingRing'
import { SearchInput } from '../../ui/SearchInput'
import { Tooltip } from '../../ui/Tooltip'
import { cx } from '../../ui/util'
import { useBrowse } from './store'

const PROVIDERS: Record<ExternalAlbumHit['provider'], { name: string; hue: string }> = {
  youtube: { name: 'YouTube', hue: 'var(--danger)' },
  archive: { name: 'Internet Archive', hue: 'var(--info)' },
  bandcamp: { name: 'Bandcamp', hue: 'var(--hue-downloads)' }
}

/** Generic provider glyphs (drawn here; no brand assets). */
export function ProviderIcon({ provider }: { provider: ExternalAlbumHit['provider'] }) {
  if (provider === 'archive') return <Landmark className="bx-prov__svg" />
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
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState<string | null>(null)
  const [imported, setImported] = useState<Set<string>>(new Set())
  const list = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const q = query.trim()

  const run = async () => {
    if (!q) return
    const my = ++seq.current
    setPhase('loading')
    setError(null)
    try {
      const res = await ghost().catalog.searchExternal(q)
      if (my !== seq.current) return
      setHits(res.sort((a, b) => b.score - a.score))
      setPhase('done')
    } catch (err) {
      if (my !== seq.current) return
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }

  useEffect(() => {
    if (auto && q) void run()
    else {
      seq.current++
      setPhase('idle')
      setHits([])
    }
  }, [q, auto]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phase !== 'done' || !list.current) return
    void stagger(Array.from(list.current.children), (t) => t.set({ opacity: 0, x: 26 }).fadeIn(260, 'outQuad').moveToX(0, 520, 'outQuint'), 45)
  }, [phase, hits])

  const doImport = async (hit: ExternalAlbumHit) => {
    if (importing) return
    setImporting(hit.ref)
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
      <Button variant="primary" size={compact ? 'md' : 'lg'} icon={<Telescope />} onClick={() => void run()} disabled={!q}>
        Search YouTube, Internet Archive and Bandcamp for “{q}”
      </Button>
    )
  }

  return (
    <div className={cx('bx', compact && 'bx--compact')}>
      {phase === 'loading' && (
        <div className="bx__loading">
          <LoadingRing size={34} />
          <span>Searching YouTube, Internet Archive and Bandcamp…</span>
        </div>
      )}
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
          Nothing album-like out there for “{q}” either.
        </div>
      )}
      {phase === 'done' && hits.length > 0 && (
        <div className="bx__list" ref={list}>
          {hits.map((h) => {
            const p = PROVIDERS[h.provider]
            const done = imported.has(h.ref)
            return (
              <div key={h.provider + h.ref} className="bx-hit" style={{ '--ph': p.hue } as CSSProperties}>
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
                  <div className="bx-hit__sub g-ellipsis">
                    <span className="bx-hit__prov">{p.name}</span>
                    {h.subtitle && <> · {h.subtitle}</>}
                    {h.trackCount != null && <> · {h.trackCount} tracks</>}
                    {h.totalMs != null && <> · {formatTime(h.totalMs)}</>}
                  </div>
                </div>
                <Tooltip content={`${Math.round(h.score * 100)}% likely the complete official soundtrack`}>
                  <div className="bx-score" aria-label={`Score ${Math.round(h.score * 100)}%`}>
                    <div className="bx-score__bar">
                      <div className="bx-score__fill" style={{ transform: `scaleX(${h.score})` }} />
                    </div>
                    <span className="tnum">{Math.round(h.score * 100)}%</span>
                  </div>
                </Tooltip>
                <Tooltip content="Open the source page">
                  <button type="button" className="g-icon-btn g-icon-btn--sm" aria-label="Open source page" onClick={() => void ghost().system.openExternal(h.url)}>
                    <ExternalLink />
                  </button>
                </Tooltip>
                <Button size="sm" variant={done ? 'soft' : 'primary'} icon={done ? <Check /> : <Download />} loading={importing === h.ref} disabled={!!importing && importing !== h.ref} onClick={() => void doImport(h)}>
                  {done ? 'Imported' : 'Import'}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Footer "Search elsewhere" dialog with an editable query. */
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
  return (
    <Dialog open={open} onClose={close} title="Search elsewhere" icon={<Telescope />} width={720} hue="browse">
      <div className="bx-dialog">
        <p className="bx-dialog__lead">Can’t find a soundtrack? Look for album-like uploads on YouTube, the Internet Archive and Bandcamp, then import one into your catalog.</p>
        <SearchInput value={draft} onChange={setDraft} onSubmit={(v) => setQuery(v)} placeholder="Game or soundtrack name" autoFocus onEscape={close} />
        <div className="bx-dialog__results">
          {query.trim() ? (
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
            <div className="bx__msg">Type a name and press Enter.</div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
