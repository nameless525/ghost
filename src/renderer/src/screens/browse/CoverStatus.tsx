// Over the wedge's cover: what the selection is waiting on (Enter / Q / Mod+D fetching its album
// first, a preview getting its track list and stream, an import being revealed), else the
// "Preview" badge while its preview is audible (click: stop), else a "Preview" button that shows on
// hover (P without the keyboard). Waits shorter than ~250 ms never show (the strip fades in after a
// delay, so fast paths unmount it first).
import { AudioLines, Download, Globe, ListEnd, ListStart, Play, Square, type LucideIcon } from 'lucide-react'
import { useRef } from 'react'
import type { Progress } from '@shared/types'
import { usePlayer } from '../../state/player'
import { useTask } from '../../state/progress'
import { ProgressBar } from '../../ui/ProgressBar'
import { progressPercent } from '../../ui/progress'
import { Tooltip } from '../../ui/Tooltip'
import { previewAlbumId, togglePreview } from './actions'
import { albumFallback, nestSpan } from './progress'
import type { SelInfo } from './store'
import { useBrowseWaits, type ActionKind, type PreviewWait } from './waits'

/** Share of a preview's bar for fetching its track list, when that had to happen first. */
const PREVIEW_ALBUM_SHARE = 0.4
/** Revealing an import: a page or a few of the catalog. */
const REVEAL_EXPECT_MS = 1200
/** Between player.preview() and its first previewLoading report. */
const PREVIEW_START_MS = 800

const ACTION: Record<ActionKind, { kicker: string; icon: LucideIcon }> = {
  play: { kicker: 'Starting playback', icon: Play },
  next: { kicker: 'Playing next', icon: ListStart },
  end: { kicker: 'Adding to queue', icon: ListEnd },
  download: { kicker: 'Preparing download', icon: Download }
}

/** The preview wait is for what the wedge shows (like the "Preview" badge: the track, or the album). */
function previewIsFor(w: PreviewWait, sel: SelInfo): boolean {
  if (sel.track) return w.trackId === sel.track.id
  const albumId = previewAlbumId(sel)
  return albumId ? w.albumId === albumId : w.selId === sel.id
}

interface Shown {
  kicker: string
  icon: LucideIcon
  progress: Progress
  waitKey: string
  /**
   * Show the percentage (measured steps): for an action's album fetch, not for a preview, whose
   * bar nests several steps (the detail says more, e.g. "4.2 of 12.0 MB").
   */
  pct: boolean
}

export function CoverStatus({ sel }: { sel: SelInfo | null }) {
  const action = useBrowseWaits((s) => (s.action && sel && s.action.selId === sel.id ? s.action : null))
  const pw = useBrowseWaits((s) => (s.preview && sel && previewIsFor(s.preview, sel) ? s.preview : null))
  const reveal = useBrowseWaits((s) => s.reveal)
  const pl = usePlayer((s) => s.previewLoading ?? null)
  const preview = usePlayer((s) => s.preview)

  // The album being fetched for an action or a preview: main's task when it reports one.
  const albumId = action ? action.albumId : pw?.phase === 'album' ? pw.albumId : null
  const task = useTask(albumId ? `album:${albumId}` : null)

  // A preview's first stream wait keeps the bar going; a fallback to another source (a new wait) restarts it.
  const firstWait = useRef<{ seq: number; wait: string | null }>({ seq: -1, wait: null })
  const streamWait = pw && pl && pl.trackId === pw.trackId ? pl : null
  if (pw && streamWait?.wait && firstWait.current.seq !== pw.seq) firstWait.current = { seq: pw.seq, wait: streamWait.wait }

  let shown: Shown | null = null
  if (reveal) {
    shown = { kicker: 'Opening in Browse', icon: Globe, progress: { label: `Finding “${reveal.title}”`, fraction: null, expectMs: REVEAL_EXPECT_MS, since: reveal.since }, waitKey: `reveal${reveal.since}`, pct: false }
  } else if (action) {
    // (a finished fetch reports fraction 1 for a moment: no "100%" flash)
    shown = { ...ACTION[action.kind], progress: task ?? albumFallback(action.since), waitKey: `action${action.seq}`, pct: !task?.done }
  } else if (pw) {
    const audible = !streamWait && preview?.track.id === pw.trackId
    if (!audible) {
      let progress: Progress
      if (pw.phase === 'album') progress = nestSpan(task ?? albumFallback(pw.since), [0, PREVIEW_ALBUM_SHARE])
      else {
        const from = pw.albumStep ? PREVIEW_ALBUM_SHARE : 0
        progress = nestSpan(streamWait ?? { label: 'Finding a source', fraction: null, expectMs: PREVIEW_START_MS, since: pw.since }, [from, 1])
      }
      const fallback = streamWait?.wait && streamWait.wait !== firstWait.current.wait ? `|${streamWait.wait}` : ''
      shown = { kicker: 'Loading preview', icon: AudioLines, progress, waitKey: `preview${pw.seq}${fallback}`, pct: false }
    }
  }

  if (shown) {
    const { progress: p, icon: Icon } = shown
    const pct = shown.pct ? progressPercent(p) : null
    return (
      <div className="bw__wait" title={`${shown.kicker}: ${[p.label, p.detail].filter(Boolean).join(' · ')}`}>
        <div className="bw__wait-head">
          <Icon />
          <span className="bw__wait-kicker g-ellipsis">{shown.kicker}</span>
          {pct != null && <span className="bw__wait-pct tnum">{pct}%</span>}
        </div>
        <div className="bw__wait-label">
          {p.label}
          {p.detail && <span className="bw__wait-detail tnum"> · {p.detail}</span>}
        </div>
        <ProgressBar size="thin" progress={p} waitKey={shown.waitKey} />
      </div>
    )
  }

  // audible: the "Preview" badge (a preview still reporting its loading isn't audible yet)
  const previewing = !!(preview && sel && !(pl && pl.trackId === preview.track.id) && (sel.track ? preview.track.id === sel.track.id : preview.track.albumId === previewAlbumId(sel)))
  if (previewing) {
    return (
      <Tooltip content={`Previewing “${preview!.track.title}”. Click to stop.`} shortcut="P" side="top">
        <button type="button" className="bw__previewing" aria-label="Stop the preview" onClick={() => void togglePreview(sel)}>
          <AudioLines className="bw__previewing-on" />
          <Square className="bw__previewing-stop" />
          Preview
        </button>
      </Tooltip>
    )
  }
  if (!sel?.group) return null
  return (
    <Tooltip content={sel.track ? 'Hear a preview of this track' : 'Hear a preview of this soundtrack'} shortcut="P" side="top">
      <button type="button" className="bw__preview-btn" onClick={() => void togglePreview(sel)}>
        <Play />
        Preview
      </button>
    </Tooltip>
  )
}
