import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@main': resolve(__dirname, 'src/main'),
  '@renderer': resolve(__dirname, 'src/renderer/src')
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
    plugins: [react()],
    server: { port: 5174 }
  }
})
