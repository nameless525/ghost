#!/usr/bin/env node
// CPU use of every Electron process (browser/main, renderer, GPU, utility) over a window, plus the
// renderer main thread's breakdown and how many ticker frames ran. For idle/unfocused checks.
//   CDP_PORT=9241 node scripts/perf/cpu.mjs [seconds=10] [--focus|--blur] [--settle s] [--eval "<js run first>"]
// --focus emulates a focused window, --blur a visible but unfocused one, so the pacing policy is
// deterministic without touching the real window (whose occlusion would otherwise decide).
const args = process.argv.slice(2)
const secs = Number(args.find((a, i) => /^\d+(\.\d+)?$/.test(a) && args[i - 1] !== '--settle') ?? 10)
const blur = args.includes('--blur')
const focus = args.includes('--focus')
const evalIdx = args.indexOf('--eval')
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

if (evalIdx >= 0) await ev(args[evalIdx + 1])
// Focus emulation also keeps frames coming when the real window is covered by other windows
// (macOS stops BeginFrames for occluded windows); --blur then tells the app it lost focus.
if (blur || focus) await tab.send('Emulation.setFocusEmulationEnabled', { enabled: true })
if (focus) await ev(`window.dispatchEvent(new Event('focus')), 1`)
if (blur) await ev(`window.dispatchEvent(new Event('blur')), 1`)
await tab.send('Performance.enable')
const procs = async () => (await browser.send('SystemInfo.getProcessInfo')).result.processInfo
const metrics = async () => Object.fromEntries((await tab.send('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]))
const frameId = () => ev('window.__ghostPacing?.ticker.frameId ?? 0')
// let the pacing policy settle after our own CDP traffic (--settle <s> to wait longer, e.g. past
// the unfocused grace period before the loop pauses)
const settleIdx = args.indexOf('--settle')
await new Promise((r) => setTimeout(r, settleIdx >= 0 ? Number(args[settleIdx + 1]) * 1000 : 1500))
const p0 = await procs()
const m0 = await metrics()
const f0 = await frameId()
const t0 = Date.now()
await new Promise((r) => setTimeout(r, secs * 1000))
const p1 = await procs()
const m1 = await metrics()
const f1 = await frameId()
const wall = (Date.now() - t0) / 1000
const cap = await ev('window.__ghostPacing?.ticker.maxFps')
const vis = await ev('document.visibilityState')
if (blur || focus) await tab.send('Emulation.setFocusEmulationEnabled', { enabled: false })
const byType = new Map()
for (const p of p1) {
  const before = p0.find((q) => q.id === p.id)
  if (!before) continue
  const pct = ((p.cpuTime - before.cpuTime) / wall) * 100
  byType.set(p.type, (byType.get(p.type) ?? 0) + pct)
}
const d = (k) => Math.round(((m1[k] - m0[k]) / wall) * 1000 * 10) / 10 // ms per second
console.log(
  JSON.stringify({
    seconds: Math.round(wall * 10) / 10,
    cpuPct: Object.fromEntries([...byType].map(([k, v]) => [k, Math.round(v * 10) / 10])),
    rendererMsPerSec: { task: d('TaskDuration'), script: d('ScriptDuration'), style: d('RecalcStyleDuration'), layout: d('LayoutDuration') },
    styleRecalcsPerSec: Math.round(((m1.RecalcStyleCount - m0.RecalcStyleCount) / wall) * 10) / 10,
    layoutsPerSec: Math.round(((m1.LayoutCount - m0.LayoutCount) / wall) * 10) / 10,
    tickerFps: Math.round(((f1 - f0) / wall) * 10) / 10,
    cap: cap ?? 'Infinity',
    vis,
    heapMB: Math.round(m1.JSHeapUsedSize / 1e5) / 10,
    nodes: m1.Nodes,
    listeners: m1.JSEventListeners
  })
)
browser.ws.close()
tab.ws.close()
