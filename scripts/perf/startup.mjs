#!/usr/bin/env node
// Renderer startup timing: reloads the running app N times and reports medians.
//   CDP_PORT=9241 node scripts/perf/startup.mjs [runs=5] [--screen browse] [--trace out.json]
// Milestones (ms since navigation start), recorded by a probe injected before any app script runs:
//   fcp         first contentful paint (toolbar / background)
//   screen      first frame after the initial screen's content is in the DOM (not its loading ring)
//   canvas      first frame after the GPU background's canvas is attached
//   idle        first 200 ms window with no task > 50 ms after `screen` ("settled")
// Main-thread cost from a trace of each reload: script compile + evaluate, style sheet parse,
// style recalc, layout, and the long tasks before `screen`.
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const runs = Number(args.find((a) => /^\d+$/.test(a)) ?? 5)
const flag = (k) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : null
}
const screen = flag('--screen')
const traceOut = flag('--trace')
const port = process.env.CDP_PORT || 9223

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
let id = 0
const pending = new Map()
let traceEvents = []
let traceDone = null
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.method === 'Tracing.dataCollected') traceEvents.push(...d.params.value)
  else if (d.method === 'Tracing.tracingComplete') traceDone?.()
  else if (d.id && pending.has(d.id)) (pending.get(d.id)(d), pending.delete(d.id))
}
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const probe = `(() => {
  const t = (window.__startup = { screen: 0, canvas: 0, idle: 0 })
  const frameAfter = (k) => requestAnimationFrame((ts) => { if (!t[k]) t[k] = Math.round(ts) })
  let gotScreen = false, gotCanvas = false
  const check = () => {
    if (!gotScreen) {
      // title root, a populated Browse carousel, or the Play root
      if (document.querySelector('.tl-root, .bc-item, .pl-root')) { gotScreen = true; frameAfter('screen') }
    }
    if (!gotCanvas && document.querySelector('canvas')) { gotCanvas = true; frameAfter('canvas') }
    if (gotScreen && gotCanvas) mo.disconnect()
  }
  const mo = new MutationObserver(check)
  mo.observe(document, { childList: true, subtree: true })
  let lastLong = 0
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lastLong = Math.max(lastLong, e.startTime + e.duration) }).observe({ type: 'longtask', buffered: true }) } catch {}
  const idleCheck = () => { const now = performance.now(); if (t.screen && now - Math.max(lastLong, t.screen) >= 200) t.idle = Math.round(Math.max(lastLong, t.screen)); else setTimeout(idleCheck, 50) }
  setTimeout(idleCheck, 50)
})()`

await send('Page.enable')
await send('Runtime.enable')
const { result: added } = await send('Page.addScriptToEvaluateOnNewDocument', { source: probe })
const baseUrl = (await ev('location.href')).split('?')[0]
const url = screen ? `${baseUrl}?screen=${screen}` : baseUrl

const rows = []
for (let r = 0; r < runs; r++) {
  traceEvents = []
  await send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'v8.execute', 'disabled-by-default-v8.compile', 'blink', 'loading', 'toplevel'] }
  })
  await send('Page.navigate', { url })
  let st = null
  for (let i = 0; i < 100; i++) {
    await sleep(100)
    st = await ev('window.__startup && window.__startup.idle ? JSON.stringify({ ...window.__startup, fcp: Math.round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0), dcl: Math.round(performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? 0), heap: Math.round(performance.memory.usedJSHeapSize / 1e5) / 10 }) : null').catch(() => null)
    if (st) break
  }
  await sleep(300)
  const finished = new Promise((r) => (traceDone = r))
  await send('Tracing.end')
  await finished
  const s = JSON.parse(st ?? '{}')
  // Trace: renderer main thread (the one with the most ParseHTML/EvaluateScript work).
  const threads = new Map()
  for (const e of traceEvents) if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name)
  const nav = traceEvents.find((e) => e.name === 'navigationStart' || e.name === 'NavigationStartToBegin') ?? null
  const mainKey = [...threads].find(([k, n]) => n === 'CrRendererMain' && traceEvents.some((e) => `${e.pid}:${e.tid}` === k && e.name === 'EvaluateScript'))?.[0]
  const sum = { compile: 0, evaluate: 0, parseCss: 0, style: 0, layout: 0, gc: 0, busyToScreen: 0 }
  const t0 = nav?.ts ?? Math.min(...traceEvents.filter((e) => e.ts > 0).map((e) => e.ts))
  const screenTs = t0 + (s.screen ?? 0) * 1000
  for (const e of traceEvents) {
    if (e.ph !== 'X' || `${e.pid}:${e.tid}` !== mainKey || e.ts < t0 || e.ts > screenTs) continue
    const ms = (e.dur ?? 0) / 1000
    if (/^v8\.compile|V8\.CompileCode|v8\.parseOnBackground|CompileScript/.test(e.name)) sum.compile += ms
    else if (e.name === 'EvaluateScript' || e.name === 'v8.evaluateModule') sum.evaluate += ms
    else if (e.name === 'ParseAuthorStyleSheet') sum.parseCss += ms
    else if (e.name === 'UpdateLayoutTree' || e.name === 'RecalculateStyles') sum.style += ms
    else if (e.name === 'Layout') sum.layout += ms
    else if (/GC/.test(e.name) && !/GCEvent/.test(e.name)) sum.gc += ms
    if (e.name === 'RunTask') sum.busyToScreen += ms
  }
  if (traceOut && r === runs - 1) writeFileSync(traceOut, JSON.stringify(traceEvents))
  rows.push({ ...s, ...Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round(v * 10) / 10])) })
  console.log(`run ${r + 1}:`, JSON.stringify(rows[rows.length - 1]))
}
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier })
const median = (k) => {
  const v = rows.map((x) => x[k]).filter((x) => typeof x === 'number').sort((a, b) => a - b)
  return v.length ? v[Math.floor(v.length / 2)] : null
}
console.log('median:', JSON.stringify(Object.fromEntries(Object.keys(rows[0]).map((k) => [k, median(k)]))))
// leave the app on its default screen
if (screen) await send('Page.navigate', { url: baseUrl })
ws.close()
