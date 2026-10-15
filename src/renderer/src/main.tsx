import '@fontsource-variable/outfit'
import '@fontsource/m-plus-rounded-1c/400.css'
import '@fontsource/m-plus-rounded-1c/500.css'
import '@fontsource/m-plus-rounded-1c/700.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installMockGhost } from './mock'
import { initPlayerStore } from './state/player'
import { initTaskProgress } from './state/progress'
import { initSettingsStore } from './state/settings'
import { useUI } from './state/ui'
import { initFramePacing } from './motion/pacing'
import { startRendererPerf } from './lib/perf'
import { preloadScreen } from './shell'
import App from './App'

// The browser mock (npm run dev:web) is compiled out of the Electron build: both conditions are
// build-time constants there. (A dynamic import() here split ~35 shared modules out of the
// startup chunk.) In `electron-vite dev`, a plain browser tab without the preload also gets it.
if (import.meta.env.GHOST_WEB_MOCK || (import.meta.env.DEV && !window.ghost)) installMockGhost()
// Start fetching the first screen's chunk now (deep links already applied by App's module), so
// it's usually here by the first commit and mounts with the shell.
preloadScreen(useUI.getState().screen)
initPlayerStore()
initTaskProgress()
initSettingsStore()
initFramePacing()
startRendererPerf()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
