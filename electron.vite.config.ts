import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@main': resolve(__dirname, 'src/main'),
  '@renderer': resolve(__dirname, 'src/renderer/src')
}

/**
 * Fontsource lists a .woff fallback after every .woff2 subset; Chromium always takes the woff2, so
 * the ~360 .woff copies (~5.5 MB) were dead weight in the package and in the startup CSS.
 */
const woff2Only: Plugin = {
  name: 'ghost:woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!id.includes('@fontsource') || !/\.css($|\?)/.test(id)) return null
    return { code: code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, ''), map: null }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        external: [/\.node$/],
        // The catalog runs in a worker thread (src/main/catalog/host.ts spawns out/main/catalogWorker.js).
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          catalogWorker: resolve(__dirname, 'src/main/catalog/worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    resolve: { alias },
    plugins: [react(), woff2Only],
    server: { port: 5174 },
    // electron-vite leaves the renderer unminified by default: minifying cuts the startup chunk
    // from ~1.35 MB to under half, i.e. less to read, parse and compile on every cold launch.
    build: { minify: 'esbuild' }
  }
})
