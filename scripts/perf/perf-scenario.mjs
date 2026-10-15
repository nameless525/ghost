// Perf scenario runner (needs the app running with --remote-debugging-port 9223 and the instrumented
// build). Usage: node scripts/perf/perf-scenario.mjs <idle|browse-keys|browse-hold|fling|search>
// Runs a named scenario against the app via CDP and prints renderer + main perf stats.
import { execFileSync, spawn } from 'node:child_process'
const cdp = (...a) => execFileSync('node', ['scripts/cdp.mjs', ...a], { encoding: 'utf8' })
// hold focus emulation for the run: a covered window gets no frames on macOS
const focusHold = spawn('node', ['scripts/cdp.mjs', 'focus', '120'], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 400))
const ev = (js) => cdp('eval', js)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const name = process.argv[2]
ev(`(async()=>{window.__ghostPacing.override=Infinity; window.__ghostPerf.stats(true); await window.ghost.__perf(true); return 1})()`)
// one long-lived session for Performance metrics (they count from Performance.enable)
const port = process.env.CDP_PORT || 9223
const pageWs = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && !t.url.startsWith('devtools')).webSocketDebuggerUrl
const mws = new WebSocket(pageWs)
await new Promise((r) => (mws.onopen = r))
let mid = 0
const mpend = new Map()
mws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && mpend.has(d.id)) (mpend.get(d.id)(d), mpend.delete(d.id))
}
const msend = (method) => new Promise((r) => (mpend.set(++mid, r), mws.send(JSON.stringify({ id: mid, method }))))
const metrics = async () => Object.fromEntries((await msend('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]))
await msend('Performance.enable')
// process CPU (renderer / GPU / browser) over the scenario, from the browser target
const bws = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl)
await new Promise((r) => (bws.onopen = r))
let bid = 0
const bpend = new Map()
bws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && bpend.has(d.id)) (bpend.get(d.id)(d), bpend.delete(d.id))
}
const procs = async () => (await new Promise((r) => (bpend.set(++bid, r), bws.send(JSON.stringify({ id: bid, method: 'SystemInfo.getProcessInfo' }))))).result.processInfo
const p0 = await procs()
const t0 = Date.now()
const m0 = await metrics()
if (name === 'browse-keys') {
  for (let i = 0; i < 40; i++) { cdp('key', 'ArrowDown'); await sleep(60) }
  await sleep(1500)
} else if (name === 'browse-hold') {
  for (let i = 0; i < 120; i++) { cdp('key', 'ArrowDown'); await sleep(16) }
  await sleep(1500)
} else if (name === 'fling') {
  ev(`(async()=>{ const el=document.querySelector('.bc'); const r=el.getBoundingClientRect(); for(let i=0;i<90;i++){ el.dispatchEvent(new WheelEvent('wheel',{deltaY:120, clientX:r.x+300, clientY:r.y+400, bubbles:true})); await new Promise(r=>requestAnimationFrame(r)) } await new Promise(r=>setTimeout(r,1500)); return 1})()`)
} else if (name === 'search') {
  ev(`(async()=>{ const inp=document.querySelector('.g-search__input'); inp.focus(); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; let q=''; for (const ch of 'final fantasy') { q+=ch; set.call(inp,q); inp.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,90)) } await new Promise(r=>setTimeout(r,2500)); set.call(inp,''); inp.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,2000)); inp.blur(); return 1})()`)
} else if (name === 'idle') {
  await sleep(5000)
}
const m1 = await metrics()
mws.close()
const p1 = await procs()
const wall = (Date.now() - t0) / 1000
bws.close()
const cpuPct = {}
for (const p of p1) {
  const b = p0.find((q) => q.id === p.id)
  if (b && ['renderer', 'GPU', 'browser'].includes(p.type)) cpuPct[p.type] = Math.round(((cpuPct[p.type] ?? 0) + ((p.cpuTime - b.cpuTime) / wall) * 100) * 10) / 10
}
const r = JSON.parse(ev(`window.__ghostPerf.stats()`))
// renderer main-thread cost per frame (ms) over the scenario
const per = (k) => Math.round(((m1[k] - m0[k]) * 1000 * 100) / Math.max(1, r.frames)) / 100
const cost = { taskMsPerFrame: per('TaskDuration'), scriptMsPerFrame: per('ScriptDuration'), styleMsPerFrame: per('RecalcStyleDuration'), layoutMsPerFrame: per('LayoutDuration'), styleRecalcs: m1.RecalcStyleCount - m0.RecalcStyleCount, layouts: m1.LayoutCount - m0.LayoutCount }
ev(`window.__ghostPacing.override = null, 1`) // back to the normal pacing policy
focusHold.kill('SIGTERM')
const m = JSON.parse(ev(`window.ghost.__perf()`))
console.log(JSON.stringify({ scenario: name, cost, cpuPct, renderer: { frames: r.frames, p50: r.p50, p95: r.p95, p99: r.p99, max: r.max, over25: r.over25, over50: r.over50, heapMB: r.heapMB, longTasks: r.longTasks.slice(0, 12) }, main: { loop: m.loop, stalls: m.stalls.slice(0, 8), slowSql: m.slowSql.slice(0, 8) } }, null, 1))
