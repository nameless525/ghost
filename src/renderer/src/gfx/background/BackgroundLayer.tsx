// React mount point for the shared GPU background. Follows useUI.backgroundArt / Dim / Blur
// and settings.interface.blurQuality. Render once, at the bottom of the app.
//
// The engine (Pixi, ~180 KB, and its WebGL context) loads once the first screen is on screen:
// setting up WebGL waits on the GPU process, and the canvas fades in over 900 ms anyway.
import { useEffect, useMemo, useRef, useState } from 'react'
import { firstScreen } from '../../shell/firstScreen'
import { useSettings } from '../../state/settings'
import { useUI } from '../../state/ui'
import type { BackgroundEngine } from './engine'
import { makeGrainDataUrl } from './grain'
import './background.css'

export function BackgroundLayer() {
  const host = useRef<HTMLDivElement>(null)
  const art = useUI((s) => s.backgroundArt)
  const dim = useUI((s) => s.backgroundDim)
  const blur = useUI((s) => s.backgroundBlur)
  const quality = useSettings((s) => s.interface.blurQuality)
  const grain = useMemo(() => makeGrainDataUrl(), [])
  const [engine, setEngine] = useState<BackgroundEngine | null>(null)

  useEffect(() => {
    let alive = true
    let e: BackgroundEngine | null = null
    void firstScreen
      .then(() => import('./engine'))
      .then((m) => {
        if (!alive || !host.current) return
        e = m.getBackgroundEngine()
        e.attach(host.current)
        setEngine(e)
      })
    return () => {
      alive = false
      e?.detach()
    }
  }, [])
  useEffect(() => engine?.setArt(art), [engine, art])
  useEffect(() => engine?.setDim(dim, blur), [engine, dim, blur])
  useEffect(() => engine?.setQuality(quality), [engine, quality])

  return (
    <div className="g-bg" aria-hidden>
      <div ref={host} className="g-bg__canvas" />
      <div className="g-bg__vignette" />
      <div className="g-bg__grain" style={{ backgroundImage: `url(${grain})` }} />
    </div>
  )
}
