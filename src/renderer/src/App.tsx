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
import { ErrorBoundary } from './shell/ErrorBoundary'
import { whenIdle } from './shell/lazyModule'
import { useSettings } from './state/settings'
import { UIHosts } from './ui'

// ?screen=…&overlay=… deep links, before the first render
applyDeepLinks()

/** ?kit shows the UI kit gallery instead of the screens (a living reference for the UI). */
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
  // context menus read playlists synchronously ("Add to playlist"): fill the cache early
  useEffect(() => whenIdle(() => void import('./lib/track-actions').then((m) => m.initPlaylistCache())), [])
  usePlayerThemeSync()
  useMediaSession()
  useUiScale()

  // The chrome is contained too: a render error in, say, the toolbar's now-playing chip used to
  // unmount the whole tree (a blank window); now only that piece disappears.
  return (
    <>
      <ErrorBoundary label="The background" silent>
        <BackgroundLayer />
      </ErrorBoundary>
      <div id="g-app" className="g-app">
        {showKit ? (
          <Suspense fallback={null}>
            <Gallery />
          </Suspense>
        ) : (
          <ScreenStack />
        )}
        <ErrorBoundary label="Overlays" silent>
          <OverlayHost />
        </ErrorBoundary>
        <ErrorBoundary label="The toolbar" silent>
          <Toolbar />
        </ErrorBoundary>
        <ErrorBoundary label="Notifications" silent>
          <ToastStack />
          <VolumeMeter />
          <FpsMeter />
        </ErrorBoundary>
        <UIHosts />
      </div>
      <GlobalKeys />
    </>
  )
}
