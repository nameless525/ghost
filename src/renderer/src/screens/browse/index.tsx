// PLACEHOLDER — owned by the ui-browse workstream, which replaces this file.
// Contract: default-export a component taking ScreenProps (see shell/types.ts). Mounted lazily
// by the ScreenStack at ?screen=browse. Build with the UI kit (ui/README.md); register custom
// choreography with useScreenTransitions() from shell/ScreenStack.
import { Compass } from 'lucide-react'
import type { ScreenProps } from '../../shell/types'
import { Wedge } from '../../ui'

/** Props: lifecycle ('entering' | 'active' | 'exiting'), direction, from, to. */
export type BrowseScreenProps = ScreenProps

export default function BrowseScreen(_props: BrowseScreenProps) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', alignItems: 'center', paddingTop: 'var(--toolbar-h)' }}>
      <Wedge side="left" hue="browse" glow style={{ width: 'min(560px, 46vw)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 6px' }}>
          <Compass style={{ width: 28, height: 28, color: 'var(--accent-hi)' }} />
          <div>
            <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--fg-0)' }}>Browse</div>
            <div style={{ color: 'var(--fg-3)', fontSize: 'var(--fs-sm)' }}>The song-select carousel lands here.</div>
          </div>
        </div>
      </Wedge>
    </div>
  )
}
