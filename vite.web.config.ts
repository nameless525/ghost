// Renderer-only dev server (no Electron). `window.ghost` is replaced by the mock in
// src/renderer/src/mock so the UI can be developed and screenshotted in a normal browser.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  plugins: [react()],
  define: { 'import.meta.env.GHOST_WEB_MOCK': 'true' },
  server: { port: 5173, strictPort: true, host: '127.0.0.1' }
})
