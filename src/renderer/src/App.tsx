// Root composition: GPU background, screen stack, overlays, toolbar, toasts, floating-UI
// hosts, keyboard root and OS media session. Accent + background follow the player.
import { lazy, Suspense, useEffect } from 'react'
import './theme'
import { startAccentDriver } from './theme'
import './motion'
import { BackgroundLayer } from './gfx/background'
import { useMediaSession, usePlayerThemeSync } from './hooks'
import { VolumeMeter } from './overlays/now-playing/VolumeMeter'
import { applyDeepLinks, FpsMeter, GlobalKeys, initNotifications, OverlayHost, ScreenStack, ToastStack, Toolbar } from './shell'
import { useSettings } from './state/settings'
import { UIHosts } from './ui'

// ?screen=…&overlay=… deep links, before the first render
applyDeepLinks()

/** ?kit shows the UI kit gallery instead of the screens (a living reference for every workstream). */
const showKit = new URLSearchParams(window.location.search).has('kit')
const Gallery = lazy(() => import('./ui/Gallery'))

function useUiScale(): void {
  const scale = useSettings((s) => s.interface.uiScale)
  useEffect(() => {
    const el = document.getElementById('g-app')
    if (el) el.style.zoom = scale && scale !== 1 ? String(scale) : ''
  }, [scale])
}

export default function App() {
  useEffect(() => startAccentDriver(), [])
  useEffect(() => initNotifications(), [])
  usePlayerThemeSync()
  useMediaSession()
  useUiScale()

  return (
    <>
      <BackgroundLayer />
      <div id="g-app" className="g-app">
        {showKit ? (
          <Suspense fallback={null}>
            <Gallery />
          </Suspense>
        ) : (
          <ScreenStack />
        )}
        <OverlayHost />
        <Toolbar />
        <ToastStack />
        <VolumeMeter />
        <FpsMeter />
        <UIHosts />
      </div>
      <GlobalKeys />
    </>
  )
}
