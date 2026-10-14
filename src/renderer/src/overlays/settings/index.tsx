// PLACEHOLDER — owned by the ui-library workstream, which replaces this file.
// Contract: default-export a component taking OverlayProps (see shell/types.ts). The
// OverlayHost renders it inside the slide-in panel (hue, backdrop, focus trap, Esc and
// click-outside are handled for you). Start with <OverlayHeader/> from the UI kit.
// Opened at ?overlay=settings.
import { Settings } from 'lucide-react'
import type { OverlayProps } from '../../shell/types'
import { OverlayHeader } from '../../ui'

/** Props: open, phase ('entering' | 'open' | 'exiting' | 'closed'), close(), hue. */
export type SettingsOverlayProps = OverlayProps

export default function SettingsOverlay(_props: SettingsOverlayProps) {
  return (
    <div className="g-placeholder">
      <OverlayHeader icon={<Settings />} title="Settings" description="Audio, sources, library and interface" />
      <div className="g-placeholder__note">This panel is a placeholder; the ui-library workstream fills it in.</div>
    </div>
  )
}
