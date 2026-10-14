// PLACEHOLDER — owned by the ui-library workstream, which replaces this file.
// Contract: default-export a component taking OverlayProps (see shell/types.ts). The
// OverlayHost renders it inside the slide-in panel (hue, backdrop, focus trap, Esc and
// click-outside are handled for you). Start with <OverlayHeader/> from the UI kit.
// Opened at ?overlay=downloads.
import { Download } from 'lucide-react'
import type { OverlayProps } from '../../shell/types'
import { OverlayHeader } from '../../ui'

/** Props: open, phase ('entering' | 'open' | 'exiting' | 'closed'), close(), hue. */
export type DownloadsOverlayProps = OverlayProps

export default function DownloadsOverlay(_props: DownloadsOverlayProps) {
  return (
    <div className="g-placeholder">
      <OverlayHeader icon={<Download />} title="Downloads" description="Queued, active and finished downloads" />
      <div className="g-placeholder__note">This panel is a placeholder; the ui-library workstream fills it in.</div>
    </div>
  )
}
