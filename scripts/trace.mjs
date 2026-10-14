#!/usr/bin/env node
// Record a Chrome trace of the renderer (devtools timeline categories) and summarise where main-
// thread and compositor time went. Start the app with --remote-debugging-port 9223.
//   node scripts/trace.mjs <seconds> <out.json>      node scripts/trace.mjs --summary <out.json>
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === '--summary') {
  const ev = JSON.parse(readFileSync(args[1], 'utf8'))
  const threads = new Map()
  for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name)
  const agg = new Map()
  const longest = []
  for (const e of ev) {
    if (e.ph !== 'X' || !e.dur) continue
    const th = threads.get(`${e.pid}:${e.tid}`) || '?'
    if (!/CrRendererMain|Compositor|VizCompositor|CrGpuMain|ThreadPool/.test(th)) continue
    const k = `${th.replace(/ThreadPool.*/, 'ThreadPool')} | ${e.name}`
    const a = agg.get(k) || { ms: 0, n: 0, max: 0 }
    a.ms += e.dur / 1000
    a.n++
    a.max = Math.max(a.max, e.dur / 1000)
    agg.set(k, a)
    if (th === 'CrRendererMain' && e.dur > 16000) longest.push([Math.round(e.dur / 1000), e.name, JSON.stringify(e.args?.data ?? {}).slice(0, 120)])
  }
  for (const [k, a] of [...agg].sort((x, y) => y[1].ms - x[1].ms).slice(0, 40)) console.log(String(Math.round(a.ms)).padStart(6), 'ms', String(a.n).padStart(6), 'x  max', String(Math.round(a.max)).padStart(4), ' ', k)
  console.log('\nLongest renderer-main events (>16ms):')
  for (const l of longest.sort((a, b) => b[0] - a[0]).slice(0, 15)) console.log(' ', l.join('  '))
  process.exit(0)
}
const [secs = '8', out = 'trace.json'] = args
const port = process.env.CDP_PORT || 9223
const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
const ws = new WebSocket(browser.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const events = []
let done
const finished = new Promise((r) => (done = r))
const pend = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.method === 'Tracing.dataCollected') events.push(...d.params.value)
  else if (d.method === 'Tracing.tracingComplete') done()
  else if (d.id && pend.has(d.id)) (pend.get(d.id)(d), pend.delete(d.id))
}
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'gpu', 'viz', 'v8', 'disabled-by-default-devtools.timeline.frame', 'loading', 'toplevel'] } })
await new Promise((r) => setTimeout(r, Number(secs) * 1000))
await send('Tracing.end')
await finished
writeFileSync(out, JSON.stringify(events))
console.log('saved', out, events.length, 'events')
ws.close()
