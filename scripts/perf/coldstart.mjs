#!/usr/bin/env node
// Launch timing for a built app, from process start to a usable window, over N fresh launches.
// Each run starts from a clone of a template profile (APFS/ReFS clones are instant), so every
// launch sees the same catalog, session and caches; the first run also warms the OS file cache
// and Chromium's code cache, and is reported but left out of the medians.
//
//   node scripts/perf/coldstart.mjs <app executable> --profile <template dir> [--runs 6] [--settle 6]
//
// Milestones (ms after spawn):
//   main       the main bundle finished evaluating (Electron + Node boot, then our imports)
//   ready      app 'ready'                     services  createServices() returned
//   window     BrowserWindow created           shown     'ready-to-show' (the window appears)
//   nav        the renderer's navigation start fcp       first contentful paint
//   screen     first frame with the title screen's content (the renderer's ghost:first-screen mark)
//   catalog    the catalog worker's first answer      session   the saved queue restored
// (GHOST_PERF_LOG is set so the main process records the catalog mark.)
// After --settle seconds: CPU seconds used by every process of the app so far, and their total RSS.
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, constants, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : d
}
const exe = args[0]
const template = flag('--profile', null)
const runs = Number(flag('--runs', 6))
const settle = Number(flag('--settle', 6))
if (!exe || !template) {
  console.error('usage: coldstart.mjs <app executable> --profile <template dir> [--runs N] [--settle s]')
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => performance.timeOrigin + performance.now()

function cdp(url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) (pending.get(d.id)(d), pending.delete(d.id))
  }
  const open = new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => j(new Error('cdp connect failed')))))
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  return { open, send, close: () => ws.close() }
}

/** Every process descended from `root` (Electron helpers, GPU, renderer, utility). */
function tree(root) {
  if (process.platform === 'win32') return { pids: [root], cpu: NaN, rssMb: NaN, by: {} }
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,time='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
  const kids = new Map()
  for (const [pid, ppid] of rows) (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(pid)
  const want = new Set([String(root)])
  const stack = [String(root)]
  while (stack.length) for (const c of kids.get(stack.pop()) ?? []) if (!want.has(c)) (want.add(c), stack.push(c))
  let rss = 0
  let cpu = 0
  const by = {}
  const names = Object.fromEntries(
    execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(.*)$/).slice(1))
  )
  for (const [pid, , kb, time] of rows) {
    if (!want.has(pid)) continue
    rss += Number(kb)
    const type = names[pid]?.match(/--type=([\w-]+)/)?.[1] ?? 'main'
    const sub = names[pid]?.match(/--utility-sub-type=([\w.]+)/)?.[1]?.split('.').pop()
    const key = sub ? `${type}:${sub}` : type
    by[key] = Math.round((by[key] ?? 0) + Number(kb) / 1024)
    // [[dd-]hh:]mm:ss.ss
    const parts = time.replace('-', ':').split(':').map(Number)
    cpu += parts.reduce((a, v) => a * 60 + v, 0)
  }
  return { pids: [...want], cpu, rssMb: rss / 1024, by }
}

async function launch(n) {
  const profile = mkdtempSync(join(tmpdir(), 'ghost-cold-'))
  cpSync(template, profile, { recursive: true, mode: constants.COPYFILE_FICLONE })
  const port = 9400 + Math.floor(Math.random() * 400)
  const t0 = now()
  const app = spawn(exe, [`--remote-debugging-port=${port}`], { env: { ...process.env, GHOST_USER_DATA: profile, GHOST_PERF_LOG: '1' }, stdio: 'ignore' })
  const row = { run: n }
  try {
    let target = null
    while (!target) {
      if (now() - t0 > 30_000) throw new Error('no window appeared')
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => [])
      target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      if (!target) await sleep(20)
    }
    const b = cdp(target.webSocketDebuggerUrl)
    await b.open
    const ev = async (expression) => (await b.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
    let cold = null
    while (!cold) {
      if (now() - t0 > 60_000) throw new Error('the first screen never appeared')
      await sleep(20)
      cold = await ev(`(() => {
        const screen = performance.getEntriesByName('ghost:first-screen')[0]?.startTime
        return screen ? JSON.stringify({ screen: performance.timeOrigin + screen, origin: performance.timeOrigin, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null }) : null
      })()`).catch(() => null)
    }
    const c = JSON.parse(cold)
    const catalogAt = await ev(`window.ghost.catalog.status().then(() => performance.timeOrigin + performance.now())`)
    const perf = await ev(`window.ghost.__perf(false).then((p) => JSON.stringify({ origin: p.timeOrigin, marks: p.marks }))`)
    const p = JSON.parse(perf)
    const mark = (name) => {
      const m = p.marks.find((x) => x.name === name)
      return m ? p.origin + m.ms - t0 : null
    }
    Object.assign(row, {
      main: mark('main:module'),
      ready: mark('app:ready'),
      services: mark('services:done'),
      window: mark('window:created'),
      shown: mark('window:ready-to-show'),
      nav: c.origin - t0,
      fcp: c.fcp == null ? null : c.origin + c.fcp - t0,
      screen: c.screen - t0,
      catalog: mark('catalog:first-answer') ?? catalogAt - t0,
      session: mark('session:restored')
    })
    await sleep(settle * 1000)
    const status = JSON.parse(await ev(`window.ghost.catalog.status().then((s) => JSON.stringify({ games: s.games, crawling: (s.sources ?? []).filter((x) => x.state === 'running' || x.state === 'waiting').length }))`))
    const t = tree(app.pid)
    Object.assign(row, { cpuS: t.cpu, rssMb: t.rssMb, games: status.games, crawling: status.crawling })
    if (n > 0) console.log(`  rss by process (MB): ${JSON.stringify(t.by)}`)
    b.close()
  } finally {
    app.kill()
    await new Promise((r) => (app.exitCode != null ? r() : app.once('exit', r)))
    await sleep(500)
    rmSync(profile, { recursive: true, force: true })
  }
  return row
}

const fmt = (v) => (typeof v === 'number' ? (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10) : v)
const rows = []
for (let i = 0; i <= runs; i++) {
  const row = await launch(i)
  console.log(`${i === 0 ? 'warm-up' : `run ${i}`}: ${Object.entries(row).filter(([k]) => k !== 'run').map(([k, v]) => `${k} ${fmt(v)}`).join('  ')}`)
  if (i > 0) rows.push(row)
  await sleep(1000)
}
const median = (k) => {
  const v = rows.map((r) => r[k]).filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b)
  return v.length ? v[Math.floor(v.length / 2)] : null
}
console.log(`median (${rows.length} runs): ${Object.keys(rows[0]).filter((k) => k !== 'run').map((k) => `${k} ${fmt(median(k))}`).join('  ')}`)
