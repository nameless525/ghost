#!/usr/bin/env node
// Launch check for a packaged build: starts the app with a throwaway profile, then makes sure the
// window loaded, the catalog worker answers, and the native audio engine is up. Every catalog
// source is turned off in that profile, so nothing is crawled. Exits non-zero on any failure.
//
//   node scripts/smoke/launch.mjs <path to the app executable>
//
//   macOS:   release/<version>/mac-arm64/GHOST.app/Contents/MacOS/GHOST
//   Windows: release/<version>/win-unpacked/GHOST.exe
//   Linux:   release/<version>/linux-unpacked/ghost   (under xvfb-run on a headless machine)
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exe = process.argv[2]
if (!exe) {
  console.error('usage: launch.mjs <app executable>')
  process.exit(2)
}
const PORT = 9300 + Math.floor(Math.random() * 500)
const TIMEOUT_MS = 90_000
// Lines in the app's output that mean something is broken.
const BAD = [/audio engine unavailable/i, /no analysis region/i, /uncaught exception/i, /unhandled rejection/i, /Something went wrong/i]

const profile = mkdtempSync(join(tmpdir(), 'ghost-launch-'))
writeFileSync(
  join(profile, 'settings.json'),
  JSON.stringify({
    sources: { disabled: ['khinsider', 'zophar', 'modland', 'archive', 'chip', 'bandcamp', 'youtube', 'soundcloud'] },
    library: { downloadDir: join(profile, 'downloads') }
  })
)

const args = [`--remote-debugging-port=${PORT}`]
if (process.platform === 'linux') args.push('--no-sandbox')
const app = spawn(exe, args, { env: { ...process.env, GHOST_USER_DATA: profile }, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
for (const s of [app.stdout, app.stderr]) s.on('data', (d) => (output += d.toString()))
let exited = null
app.on('exit', (code, signal) => (exited = { code, signal }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const left = () => TIMEOUT_MS - (Date.now() - t0)

function finish(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`)
  if (!ok) console.log(`--- app output ---\n${output.trim() || '(none)'}`)
  app.kill()
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {}
    process.exit(ok ? 0 : 1)
  }, 1500)
}

async function pageTarget() {
  while (left() > 0) {
    if (exited) throw new Error(`the app exited early (${JSON.stringify(exited)})`)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      if (page) return page
    } catch {}
    await sleep(500)
  }
  throw new Error('no window appeared')
}

async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = () => reject(new Error('could not attach to the window')))))
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    }
  }
  return async (expression) => {
    const i = ++id
    const reply = new Promise((r) => pending.set(i, r))
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    const d = await reply
    if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description ?? d.result.exceptionDetails.text)
    return d.result?.result?.value
  }
}

try {
  const page = await pageTarget()
  const evaluate = await connect(page.webSocketDebuggerUrl)
  // The interface mounted and the preload bridge is there.
  while (!(await evaluate(`!!(window.ghost && document.getElementById('root')?.childElementCount)`))) {
    if (left() < 0) throw new Error('the interface never mounted')
    await sleep(500)
  }
  const result = JSON.parse(
    await evaluate(`(async () => {
      const status = await window.ghost.catalog.status()
      const state = await window.ghost.player.getState()
      const devices = await window.ghost.player.devices()
      return JSON.stringify({ catalog: typeof status.games === 'number', player: typeof state.status === 'string', devices: Array.isArray(devices), deviceCount: devices.length })
    })()`)
  )
  if (!result.catalog) throw new Error('the catalog worker did not answer')
  if (!result.player) throw new Error('the player did not answer')
  if (!result.devices) throw new Error('the audio engine did not list devices')
  // Give startup work a moment to log any failure.
  await sleep(3000)
  const bad = BAD.find((re) => re.test(output))
  if (bad) throw new Error(`the app reported a problem (${bad})`)
  finish(true, `window, catalog and audio engine are up (${result.deviceCount} audio device(s)) in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
} catch (e) {
  finish(false, e.message)
}
