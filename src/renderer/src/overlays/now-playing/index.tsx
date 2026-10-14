// PLACEHOLDER — owned by the ui-play workstream, which replaces this file.
// Contract: default-export a component taking OverlayProps (see shell/types.ts). The
// OverlayHost renders it inside the slide-in panel (hue, backdrop, focus trap, Esc and
// click-outside are handled for you). Start with <OverlayHeader/> from the UI kit.
// Opened at ?overlay=nowPlaying.
import { Music2 } from 'lucide-react'
import type { OverlayProps } from '../../shell/types'
import { OverlayHeader } from '../../ui'

/** Props: open, phase ('entering' | 'open' | 'exiting' | 'closed'), close(), hue. */
export type NowPlayingOverlayProps = OverlayProps

export default function NowPlayingOverlay(_props: NowPlayingOverlayProps) {
  return (
    <div className="g-placeholder">
      <OverlayHeader icon={<Music2 />} title="Now playing" description="Transport, queue and volume" />
      <div className="g-placeholder__note">This panel is a placeholder; the ui-play workstream fills it in.</div>
    </div>
  )
}
