#!/usr/bin/env node
// Capture a CPU profile of the Electron MAIN process (start the app with --inspect 9229),
// or of the renderer with CPU_PORT=9223 (start with --remote-debugging-port 9223).
//   node scripts/cpuprofile-main.mjs <seconds> <out.cpuprofile>   then summarise with --summary
import { readFileSync, writeFileSync } from 'node:fs'
const [secs = '10', out = 'main.cpuprofile', mode] = process.argv.slice(2)
if (mode === '--summary' || secs === '--summary') {
  const file = secs === '--summary' ? out : out
  const p = JSON.parse(readFileSync(file, 'utf8'))
  const byId = new Map(p.nodes.map((n) => [n.id, n]))
  const self = new Map()
  const dt = p.timeDeltas
  p.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + (dt[i] || 0)))
  const agg = new Map()
  for (const [id, us] of self) {
    const n = byId.get(id)
    const cf = n.callFrame
    const key = `${cf.functionName || '(anon)'} ${(cf.url || '').split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`
    agg.set(key, (agg.get(key) || 0) + us)
  }
  const total = [...agg.values()].reduce((a, b) => a + b, 0)
  console.log('total ms', Math.round(total / 1000))
  for (const [k, us] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 35)) console.log(String(Math.round(us / 1000)).padStart(7), 'ms ', k)
  process.exit(0)
}
// CPU_PORT=9223 profiles the renderer page instead (remote-debugging port).
const port = process.env.CPU_PORT || 9229
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools')) || list[0]
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pend = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pend.has(d.id)) (pend.get(d.id)(d), pend.delete(d.id))
}
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Profiler.enable')
await send('Profiler.setSamplingInterval', { interval: 500 })
await send('Profiler.start')
await new Promise((r) => setTimeout(r, Number(secs) * 1000))
const res = await send('Profiler.stop')
writeFileSync(out, JSON.stringify(res.result.profile))
console.log('saved', out)
ws.close()
