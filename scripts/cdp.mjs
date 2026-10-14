#!/usr/bin/env node
// Tiny Chrome DevTools Protocol driver for testing the real Electron app.
// Start the app with --remote-debugging-port=9223, then:
//   node scripts/cdp.mjs eval "<js expression>"        evaluate in the renderer (awaits promises)
//   node scripts/cdp.mjs shot <out.png> [scale]        screenshot the window
//   node scripts/cdp.mjs key <Key> [mods]              press a key (mods: shift,ctrl,alt,meta)
//   node scripts/cdp.mjs type "<text>"                 type text
//   node scripts/cdp.mjs click <x> <y>                 click at CSS px
//   node scripts/cdp.mjs wheel <x> <y> <dy>            mouse wheel at CSS px (dy > 0 scrolls down)
//   node scripts/cdp.mjs logs                          print buffered console errors (installs hook)
import { writeFileSync } from 'node:fs'

const port = process.env.CDP_PORT || 9223
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
if (!page) throw new Error('no page target')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
let id = 0
const pending = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d)
    pending.delete(d.id)
  }
}
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const [cmd, ...args] = process.argv.slice(2)
const modsOf = (s = '') => s.split(',').reduce((m, k) => m | ({ alt: 1, ctrl: 2, meta: 4, shift: 8 }[k] || 0), 0)
if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: args[0], awaitPromise: true, returnByValue: true })
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r, null, 1))
} else if (cmd === 'shot') {
  const scale = Number(args[1] || 0.5)
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: undefined })
  // Downscale via an offscreen canvas in the page to keep files small.
  const small = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => { const img = new Image(); img.src = 'data:image/png;base64,${r.result.data}'; await img.decode(); const c = document.createElement('canvas'); c.width = Math.round(img.width * ${scale}); c.height = Math.round(img.height * ${scale}); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.85).split(',')[1] })()`
  })
  writeFileSync(args[0], Buffer.from(small.result.result.value, 'base64'))
  console.log('saved', args[0])
} else if (cmd === 'key') {
  const key = args[0]
  const modifiers = modsOf(args[1])
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
  const keyCode = { Enter: 13, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32, F2: 113, Backspace: 8, Tab: 9, PageDown: 34, PageUp: 33 }[key] || key.toUpperCase().charCodeAt(0)
  const k = key === 'Space' ? ' ' : key
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: key === 'Space' ? 'Space' : code, windowsVirtualKeyCode: keyCode, modifiers, text: k.length === 1 && !(modifiers & 6) ? k : undefined })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: key === 'Space' ? 'Space' : code, windowsVirtualKeyCode: keyCode, modifiers })
  console.log('key', key)
} else if (cmd === 'type') {
  await send('Input.insertText', { text: args[0] })
  console.log('typed')
} else if (cmd === 'click') {
  const [x, y] = args.map(Number)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  console.log('clicked', x, y)
} else if (cmd === 'wheel') {
  const [x, y, dy] = args.map(Number)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy })
  console.log('wheel', x, y, dy)
} else if (cmd === 'logs') {
  const r = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { if (!window.__ghostErrs) { window.__ghostErrs = []; const o = console.error; console.error = (...a) => { window.__ghostErrs.push(a.map(String).join(' ')); o(...a) }; addEventListener('error', (e) => window.__ghostErrs.push('uncaught: ' + e.message)); addEventListener('unhandledrejection', (e) => window.__ghostErrs.push('rejection: ' + (e.reason?.message || e.reason))) } return window.__ghostErrs })()`
  })
  console.log(JSON.stringify(r.result.result.value, null, 1))
}
ws.close()
