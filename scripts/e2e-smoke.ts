// Headless end-to-end smoke test of the real main-process stack (catalog → resolver → engine →
// player → downloads) without a window. Uses a temp userData dir.
//
//   npx esbuild scripts/e2e-smoke.ts --bundle --platform=node --format=esm --external:electron \
//     --outfile=/tmp/ghost-e2e/e2e.mjs \
//     "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
//   GHOST_NATIVE_ADDON=$PWD/native/dist/ghost.node npx electron /tmp/ghost-e2e/e2e.mjs
import { app } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServices } from '../src/main/services'
import { handleArtProtocol, registerArtScheme } from '../src/main/net/art-protocol'
import type { PlayerState } from '../src/shared/types'

const tmp = process.env.GHOST_SMOKE_DIR || mkdtempSync(join(tmpdir(), 'ghost-e2e-'))
app.setPath('userData', tmp)
registerArtScheme()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const query = process.env.GHOST_E2E_QUERY || 'chrono trigger'
let last: PlayerState | null = null
const log = (...a: unknown[]) => console.log('[e2e]', ...a)

app.whenReady().then(async () => {
  handleArtProtocol()
  const handle = await createServices(((event: string, payload: any) => {
    if (event === 'player:state') {
      const s = payload as PlayerState
      if (!last || last.status !== s.status || last.current?.id !== s.current?.id || !!last.currentAnalysis !== !!s.currentAnalysis)
        log('state', s.status, s.current?.title, s.current?.source?.format, 'pos', Math.round(s.positionMs), 'analysis', s.currentAnalysis ? `${s.currentAnalysis.bpm?.toFixed(1)}bpm ★${s.currentAnalysis.intensity?.toFixed(2)}` : '-', s.error ?? '')
      last = s
    } else if (event === 'notify') log('notify', payload.kind, payload.title, payload.body ?? '')
    else if (event === 'downloads:changed') {
      const d = payload[0]
      if (d && (d.status === 'done' || d.status === 'error')) log('download', d.status, d.path ?? d.error)
    }
  }) as any)
  const s = handle.services
  // Keep test downloads out of the real ~/Music folder.
  await s.settings.set({ library: { downloadDir: join(tmp, 'downloads') } })
  try {
    let groups: any[] = []
    for (let i = 0; i < 20 && !groups.length; i++) {
      const page = await s.catalog.browse({ text: query, group: 'game', sort: 'title', offset: 0, limit: 10 })
      groups = page.groups
      if (!groups.length) await sleep(1000)
    }
    log('browse groups', groups.map((g) => `${g.title} (${g.albumCount})`))
    if (!groups.length) throw new Error('no groups found')
    const albums = await s.catalog.groupAlbums(groups[0].key, { text: query, group: 'game', sort: 'title' })
    log('albums', albums.map((a) => `${a.title} [${a.kind}]`))
    const detail = await s.catalog.album(albums[0].id)
    log('tracks', detail.tracks.length, detail.tracks.slice(0, 3).map((t) => `${t.number}. ${t.title} ${t.durationMs}`))
    await s.player.playAlbum(albums[0].id, 0)
    for (let i = 0; i < 10; i++) {
      await sleep(1000)
      if (last?.status === 'playing') break
    }
    const p0 = (await s.player.getState()).positionMs
    await sleep(3000)
    const st = await s.player.getState()
    log('position advanced', Math.round(st.positionMs - p0), 'ms in ~3000ms; status', st.status)
    await s.player.setOverlayFilter(true)
    await sleep(500)
    await s.player.setOverlayFilter(false)
    await s.player.seek(30000)
    await sleep(1500)
    log('after seek', Math.round((await s.player.getState()).positionMs))
    await s.player.next()
    await sleep(4000)
    log('after next', last?.current?.title, last?.status)
    await s.downloads.enqueue({ trackIds: [detail.tracks[0].id] })
    for (let i = 0; i < 30; i++) {
      await sleep(1000)
      const d = (await s.downloads.list())[0]
      if (d && (d.status === 'done' || d.status === 'error')) break
    }
    const lib = await s.library.downloaded()
    log('downloaded tracks', lib.map((t) => t.title))
    log('analysis on current', JSON.stringify(last?.currentAnalysis ? { bpm: last.currentAnalysis.bpm, beats: last.currentAnalysis.beats.length, kiai: last.currentAnalysis.kiai, intensity: last.currentAnalysis.intensity } : null))
  } catch (e) {
    log('FAILED', e)
  }
  await handle.shutdown()
  app.quit()
})
