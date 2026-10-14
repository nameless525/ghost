import '@fontsource-variable/outfit'
import '@fontsource/m-plus-rounded-1c/400.css'
import '@fontsource/m-plus-rounded-1c/500.css'
import '@fontsource/m-plus-rounded-1c/700.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installMockGhost } from './mock'
import { initPlayerStore } from './state/player'
import { initSettingsStore } from './state/settings'
import { initFramePacing } from './motion/pacing'
import App from './App'

if (import.meta.env.GHOST_WEB_MOCK || !window.ghost) installMockGhost()
initPlayerStore()
initSettingsStore()
initFramePacing()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
