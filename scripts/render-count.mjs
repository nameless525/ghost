#!/usr/bin/env node
// React render counts per interaction (needs component names: run against `electron-vite dev`).
// Installs a minimal React DevTools hook before the app loads, then counts, per commit, every
// function/class component that actually rendered (PerformedWork), grouped by name.
//   CDP_PORT=9241 node scripts/render-count.mjs [keys|hold|type|idle] [--screen browse]
//     keys  20 × ArrowDown, 120 ms apart      hold  60 × ArrowDown, 16 ms apart (key repeat)
//     type  types "final fantasy" into the search box     idle  5 s of nothing (playback ticking)
const args = process.argv.slice(2)
const scenario = args.find((a) => !a.startsWith('--')) ?? 'keys'
const screenIdx = args.indexOf('--screen')
const screen = screenIdx >= 0 ? args[screenIdx + 1] : 'browse'
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

// PerformedWork = 1 in React's fiber flags; tags: 0 function, 1 class, 11 forwardRef, 14/15 memo
const hook = `(() => {
  const counts = new Map()
  let commits = 0
  const nameOf = (f) => { const t = f.elementType ?? f.type; if (!t) return null; if (typeof t === 'function') return t.displayName || t.name || 'anon'; if (t.displayName) return t.displayName; const inner = t.render || t.type; return inner ? (inner.displayName || inner.name || 'anon') : null }
  // A fiber object that was already in the previous commit's tree was reused untouched (its
  // flags are stale); rendered/cloned fibers are the alternates. Count only the latter.
  let prev = new WeakSet()
  let next = new WeakSet()
  const walk = (f) => { while (f) { next.add(f); if (!prev.has(f) && (f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 15) && (f.flags & 1)) { const n = nameOf(f); if (n) counts.set(n, (counts.get(n) || 0) + 1) } if (f.child) walk(f.child); f = f.sibling } }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject() { return 1 }, onScheduleFiberRoot() {}, onCommitFiberRoot(_id, root) { commits++; next = new WeakSet(); walk(root.current.child); prev = next }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {} }
  window.__renders = { reset() { counts.clear(); commits = 0 }, get() { return { commits, total: [...counts.values()].reduce((a, b) => a + b, 0), top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25) } } }
})()`
await send('Page.enable')
const { result: added } = await send('Page.addScriptToEvaluateOnNewDocument', { source: hook })
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
const base = (await ev('location.href')).split('?')[0]
await send('Page.navigate', { url: `${base}?screen=${screen}` })
await sleep(6000)
await ev('window.ghost.player.pause().catch(() => {}), 1')
await sleep(800)
const codes = { ArrowDown: 40 }
async function key(k) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: codes[k] })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: codes[k] })
}
await ev('window.__renders.reset(), 1')
let actions = 0
if (scenario === 'keys') for (let i = 0; i < 20; i++, actions++) (await key('ArrowDown'), await sleep(120))
else if (scenario === 'hold') for (let i = 0; i < 60; i++, actions++) (await key('ArrowDown'), await sleep(16))
else if (scenario === 'type') {
  // real key events: typing anywhere in Browse focuses the search box first
  for (const ch of 'final fantasy') {
    const code = ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    actions++
    await sleep(90)
  }
} else await sleep(5000)
await sleep(1500)
const r = await ev('window.__renders.get()')
console.log(JSON.stringify({ scenario, screen, actions, commits: r.commits, renders: r.total, perAction: actions ? Math.round((r.total / actions) * 10) / 10 : null }))
for (const [n, c] of r.top) console.log(String(c).padStart(6), n)
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier })
await send('Emulation.setFocusEmulationEnabled', { enabled: false })
await send('Page.navigate', { url: base })
ws.close()
