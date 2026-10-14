// React mount point for the shared GPU background. Follows useUI.backgroundArt / Dim / Blur
// and settings.interface.blurQuality. Render once, at the bottom of the app.
import { useEffect, useMemo, useRef } from 'react'
import { useSettings } from '../../state/settings'
import { useUI } from '../../state/ui'
import { getBackgroundEngine } from './engine'
import { makeGrainDataUrl } from './textures'
import './background.css'

export function BackgroundLayer() {
  const host = useRef<HTMLDivElement>(null)
  const art = useUI((s) => s.backgroundArt)
  const dim = useUI((s) => s.backgroundDim)
  const blur = useUI((s) => s.backgroundBlur)
  const quality = useSettings((s) => s.interface.blurQuality)
  const grain = useMemo(() => makeGrainDataUrl(), [])

  useEffect(() => {
    const e = getBackgroundEngine()
    e.attach(host.current!)
    return () => e.detach()
  }, [])
  useEffect(() => getBackgroundEngine().setArt(art), [art])
  useEffect(() => getBackgroundEngine().setDim(dim, blur), [dim, blur])
  useEffect(() => getBackgroundEngine().setQuality(quality), [quality])

  return (
    <div className="g-bg" aria-hidden>
      <div ref={host} className="g-bg__canvas" />
      <div className="g-bg__vignette" />
      <div className="g-bg__grain" style={{ backgroundImage: `url(${grain})` }} />
    </div>
  )
}
