// PLACEHOLDER — owned by the ui-play workstream, which replaces this file.
// Contract: default-export a component taking ScreenProps (see shell/types.ts). Mounted lazily
// by the ScreenStack at ?screen=play. The toolbar auto-hides on this screen.
import type { ScreenProps } from '../../shell/types'
import { useNowPlayingBackground } from '../../hooks'
import { usePlayer } from '../../state/player'
import { CoverArt } from '../../ui'

/** Props: lifecycle ('entering' | 'active' | 'exiting'), direction, from, to. */
export type PlayScreenProps = ScreenProps

export default function PlayScreen(_props: PlayScreenProps) {
  const current = usePlayer((s) => s.current)
  useNowPlayingBackground({ dim: 0.35, blur: 0.6 })
  return (
    <div style={{ position: 'absolute', left: 40, bottom: 48, display: 'flex', alignItems: 'center', gap: 18 }}>
      <CoverArt src={current?.cover} size={96} radius={14} />
      <div>
        <div style={{ fontSize: 'var(--fs-3xl)', fontWeight: 700, color: 'var(--fg-0)' }}>{current?.title ?? 'Nothing playing'}</div>
        <div style={{ color: 'var(--fg-2)' }}>{current?.gameName ?? 'Pick something in Browse'}</div>
      </div>
    </div>
  )
}
