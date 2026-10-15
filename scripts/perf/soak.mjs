#!/usr/bin/env node
// Long-session memory soak for Browse: random jumps (F2), step into the albums, expand one (loads
// its tracks), repeat. Reports JS heap after a forced GC, DOM nodes, listeners and process RSS
// (renderer + GPU) at the start, halfway and the end.
//   CDP_PORT=9241 node scripts/perf/soak.mjs [iterations=200]
// Start it on Browse (it navigates there via ?screen=browse).
import { execFileSync } from 'node:child_process'

const iterations = Number(process.argv[2] ?? 200)
const port = process.env.CDP_PORT || 9223
async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) (pending.get(d.id)(d), pending.delete(d.id))
  }
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  return { ws, send }
}
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
const browser = await connect(version.webSocketDebuggerUrl)
const tab = await connect(page.webSocketDebuggerUrl)
const ev = async (expression) => (await tab.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const codes = { Enter: 13, Escape: 27, F2: 113, ArrowDown: 40, ArrowRight: 39, ArrowLeft: 37 }
async function key(k) {
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: codes[k] })
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: codes[k] })
}
const rss = (pid) => {
  try {
    return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024)
  } catch {
    return null
  }
}
await tab.send('Performance.enable')
// Keep frames coming even if the real window is covered (macOS stops BeginFrames for occluded
// windows, which stalls every frame-driven cleanup and looks like a leak), and act focused.
await tab.send('Emulation.setFocusEmulationEnabled', { enabled: true })
async function snapshot(label) {
  await tab.send('HeapProfiler.collectGarbage')
  await sleep(300)
  const m = Object.fromEntries((await tab.send('Performance.getMetrics')).result.metrics.map((x) => [x.name, x.value]))
  const procs = (await browser.send('SystemInfo.getProcessInfo')).result.processInfo
  const renderers = procs.filter((p) => p.type === 'renderer').map((p) => rss(p.id))
  const gpu = procs.filter((p) => p.type === 'GPU').map((p) => rss(p.id))
  const s = { label, heapMB: Math.round(m.JSHeapUsedSize / 1e5) / 10, nodes: m.Nodes, listeners: m.JSEventListeners, docs: m.Documents, rendererRssMB: Math.max(...renderers), gpuRssMB: gpu[0] ?? null, imgs: await ev('document.images.length') }
  console.log(JSON.stringify(s))
  return s
}
const base = (await ev('location.href')).split('?')[0]
await tab.send('Page.navigate', { url: `${base}?screen=browse` })
await sleep(5000)
await ev(`window.dispatchEvent(new Event('focus')), 1`)
await snapshot('start')
const t0 = Date.now()
for (let i = 0; i < iterations; i++) {
  await key('F2')
  await sleep(260)
  await key('ArrowDown')
  await sleep(120)
  await key('ArrowRight')
  await sleep(260)
  if (i === Math.floor(iterations / 2)) await snapshot('half')
}
await sleep(1500)
const end = await snapshot('end')
console.log(`soak: ${iterations} iterations in ${Math.round((Date.now() - t0) / 1000)} s`)
const perf = await ev('JSON.stringify((({frames,p50,p95,p99,max,over25,over50,longTasks}) => ({frames,p50,p95,p99,max,over25,over50,longTasks:longTasks.length}))(window.__ghostPerf.stats()))')
console.log('frames:', perf)
void end
await tab.send('Emulation.setFocusEmulationEnabled', { enabled: false })
browser.ws.close()
tab.ws.close()
