#!/usr/bin/env node
// Screen / overlay transition latency: time from a key press to the first frame with the target's
// real content (not a loading ring), on a fresh load. Measures first visits (cold chunks / lazy
// boundaries) and second visits.
//   CDP_PORT=9241 node scripts/nav.mjs [runs=3]
// Steps (from the title screen): Enter (menu) · Enter → Browse rows · Mod+L → Library ·
// Esc · Mod+O → Settings · Esc · F6 → Now Playing · F6 · Esc → Title · Enter/Enter → Browse again.
const runs = Number(process.argv[2] ?? 3)
const port = process.env.CDP_PORT || 9223
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
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
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const codes = { Enter: 13, Escape: 27, F6: 117 }
async function key(k, mods = 0) {
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k
  const vk = codes[k] ?? k.toUpperCase().charCodeAt(0)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods })
}
// Arm a watcher (records performance.now()), press the key, then wait for the first frame after
// the selector matches.
async function measure(selector, k, mods = 0) {
  await ev(`(() => {
    const w = (window.__nav = { t0: performance.now(), t1: 0 })
    const done = () => requestAnimationFrame((ts) => { if (!w.t1) w.t1 = ts })
    if (document.querySelector(${JSON.stringify(selector)})) return done()
    const mo = new MutationObserver(() => { if (document.querySelector(${JSON.stringify(selector)})) { mo.disconnect(); done() } })
    mo.observe(document.body, { childList: true, subtree: true, attributes: true })
    setTimeout(() => mo.disconnect(), 5000)
  })()`)
  await key(k, mods)
  for (let i = 0; i < 60; i++) {
    await sleep(50)
    const r = await ev('window.__nav.t1 ? Math.round(window.__nav.t1 - window.__nav.t0) : 0')
    if (r) return r
  }
  return null
}
const META = 4
const ovReady = (id) => `.g-ov--${id}[data-phase] .g-ov__body > :not(.g-loading-center)`
const base = (await ev('location.href')).split('?')[0]
const rows = []
for (let r = 0; r < runs; r++) {
  await send('Page.navigate', { url: base })
  await sleep(4000) // let idle preloads run, as a user would
  const row = {}
  await key('Enter')
  await sleep(900)
  row.titleToBrowse = await measure('.g-screen--browse .bc-item', 'Enter')
  await sleep(1500)
  row.libraryFirst = await measure(ovReady('library'), 'l', META)
  await sleep(900)
  await key('Escape')
  await sleep(900)
  row.settingsFirst = await measure(ovReady('settings'), 'o', META)
  await sleep(900)
  await key('Escape')
  await sleep(900)
  row.nowPlayingFirst = await measure(ovReady('nowPlaying'), 'F6')
  await sleep(900)
  await key('F6')
  await sleep(900)
  row.libraryAgain = await measure(`${ovReady('library')}`, 'l', META)
  await sleep(900)
  await key('Escape')
  await sleep(900)
  await key('Escape') // browse → title
  await sleep(1400)
  await key('Enter')
  await sleep(900)
  row.titleToBrowseAgain = await measure('.g-screen--browse:not([data-lifecycle="exiting"]) .bc-item', 'Enter')
  await sleep(1200)
  rows.push(row)
  console.log(`run ${r + 1}:`, JSON.stringify(row))
}
const median = (k) => {
  const v = rows.map((x) => x[k]).filter((x) => x != null).sort((a, b) => a - b)
  return v.length ? v[Math.floor(v.length / 2)] : null
}
console.log('median ms:', JSON.stringify(Object.fromEntries(Object.keys(rows[0]).map((k) => [k, median(k)]))))
await send('Page.navigate', { url: base })
ws.close()
