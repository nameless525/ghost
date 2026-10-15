#!/usr/bin/env node
// Click→sound latency: plays an album through window.ghost and prints the main-process play:* marks
// (request → load → resolved → engine-set → playing) as deltas, plus what the renderer saw.
//   CDP_PORT=9223 node scripts/perf/play-latency.mjs <albumId> [startIndex]
// IPC traffic per channel: start the app with GHOST_PERF_IPC=1 and read window.ghost.__perf().ipc.
const [albumId, start = '0'] = process.argv.slice(2)
const port = process.env.CDP_PORT || 9223
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pend = new Map()
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) (pend.get(d.id)(d), pend.delete(d.id)) }
const ev = (expression) => new Promise((r) => { const i = ++id; pend.set(i, (d) => r(d.result?.result?.value ?? d.result?.exceptionDetails)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })) })
const out = await ev(`(async () => {
  await window.ghost.player.setVolume(0.08)
  const n0 = (await window.ghost.__perf(false)).marks.length
  const t0 = performance.now()
  let tPlaying = null, tLoading = null
  const off = window.ghost.on('player:state', (s) => {
    if (s.status === 'loading' && tLoading === null) tLoading = performance.now() - t0
    if (s.status === 'playing' && tPlaying === null) tPlaying = performance.now() - t0
  })
  await window.ghost.player.playAlbum(${JSON.stringify(albumId)}, ${Number(start)})
  const tReturn = performance.now() - t0
  for (let i = 0; i < 300 && tPlaying === null; i++) await new Promise((r) => setTimeout(r, 50))
  off()
  const p = await window.ghost.__perf(false)
  const marks = p.marks.slice(n0).filter((m) => m.name.startsWith('play:'))
  const base = marks[0]?.ms ?? 0
  const st = await window.ghost.player.getState()
  return { rendererMs: { invokeReturned: Math.round(tReturn), firstLoadingState: tLoading && Math.round(tLoading), firstPlayingState: tPlaying && Math.round(tPlaying) }, main: marks.map((m) => m.name + ' +' + Math.round(m.ms - base)), track: st.current?.title, src: st.current?.source?.provider + '/' + st.current?.source?.format }
})()`)
console.log(JSON.stringify(out, null, 1))
ws.close()
