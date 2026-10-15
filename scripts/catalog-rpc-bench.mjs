#!/usr/bin/env node
// Catalog latencies as the renderer sees them (IPC → main → catalog worker → back), on a running app.
//   CDP_PORT=9244 node scripts/catalog-rpc-bench.mjs browse [runs=10]
//   CDP_PORT=9244 node scripts/catalog-rpc-bench.mjs album <albumId>...      first open (album page fetch) vs cached
//   CDP_PORT=9244 node scripts/catalog-rpc-bench.mjs play <albumId>:<index>...  click → URL resolved → playing
// `play` keeps the volume at 0.1 and pauses at the end. Each album/play target costs real requests
// to the source: use a handful.
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
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500))
  return r.result?.result?.value
}
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 100) / 100
}

const [cmd, ...rest] = process.argv.slice(2)

if (cmd === 'browse') {
  const runs = Number(rest[0] ?? 10)
  const QUERIES = [
    ['', 'game', 'title'],
    ['', 'game', 'random'],
    ['', 'album', 'title'],
    ['final fantasy', 'game', 'title'],
    ['mario', 'game', 'title'],
    ['the', 'game', 'title'],
    ['megaman', 'album', 'title'],
    ['ff7', 'game', 'title'],
    ['platform=snes', 'game', 'title'],
    ['', 'platform', 'title'],
    ['', 'year', 'title'],
    ['', 'franchise', 'title']
  ]
  const out = await ev(`(async () => {
    const res = {}
    const Q = ${JSON.stringify(QUERIES)}
    for (const [text, group, sort] of Q) {
      const xs = []
      let bytes = 0
      for (let i = 0; i < ${runs}; i++) {
        const t0 = performance.now()
        const p = await window.ghost.catalog.browse({ text, group, sort, offset: 0, limit: 100 })
        xs.push(performance.now() - t0)
        bytes = JSON.stringify(p).length
      }
      res[group + ' ' + sort + ' "' + text + '"'] = { xs, bytes }
    }
    // groupAlbums for the first game of the default page, and the album detail of its first album.
    const p = await window.ghost.catalog.browse({ text: 'final fantasy', group: 'game', sort: 'title', offset: 0, limit: 100 })
    const xs = [], ys = []
    let ab = 0, db = 0
    for (let i = 0; i < ${runs}; i++) {
      const g = p.groups[i % p.groups.length]
      let t0 = performance.now()
      const list = await window.ghost.catalog.groupAlbums(g.key, { text: 'final fantasy', group: 'game', sort: 'title' })
      xs.push(performance.now() - t0)
      ab = Math.max(ab, JSON.stringify(list).length)
    }
    res['groupAlbums "final fantasy"'] = { xs, bytes: ab }
    return res
  })()`)
  for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(36)} p50 ${String(pct(v.xs, 50)).padStart(7)}  p95 ${String(pct(v.xs, 95)).padStart(7)}  max ${String(pct(v.xs, 100)).padStart(7)} ms  ${v.bytes} B`)
} else if (cmd === 'album') {
  for (const albumId of rest) {
    const r = await ev(`(async () => {
      let t0 = performance.now()
      const a = await window.ghost.catalog.album(${JSON.stringify(albumId)})
      const first = performance.now() - t0
      t0 = performance.now()
      const b = await window.ghost.catalog.album(${JSON.stringify(albumId)})
      const second = performance.now() - t0
      return { first, second, tracks: a.tracks.length, bytes: JSON.stringify(b).length, title: a.album.title, provider: a.album.provider }
    })()`)
    console.log(`album ${albumId} (${r.provider}, ${r.tracks} tracks, ${r.bytes} B) first ${Math.round(r.first)} ms, again ${Math.round(r.second * 10) / 10} ms  ${r.title}`)
  }
} else if (cmd === 'play') {
  await ev(`window.ghost.player.setVolume(0.1)`)
  for (const t of rest) {
    const [albumId, index] = t.split(':')
    const r = await ev(`(async () => {
      const before = (await window.ghost.__perf()).marks.length
      const t0 = performance.now()
      await window.ghost.player.playAlbum(${JSON.stringify(albumId)}, ${Number(index ?? 0)})
      const tCall = performance.now() - t0
      for (let i = 0; i < 300; i++) {
        const m = (await window.ghost.__perf()).marks
        const mine = m.slice(Math.max(0, m.length - 60)).filter((x) => x.name.startsWith('play:'))
        const last = (n) => [...mine].reverse().find((x) => x.name === n)
        const req = last('play:request'), load = last('play:load'), res = last('play:resolved'), set = last('play:engine-set'), playing = last('play:playing')
        if (playing && load && playing.ms > load.ms) return { tCall, loadToResolved: res && res.ms >= load.ms ? res.ms - load.ms : null, resolvedToSet: set && res ? set.ms - res.ms : null, requestToPlaying: req ? playing.ms - req.ms : null, loadToPlaying: playing.ms - load.ms }
        await new Promise((r) => setTimeout(r, 50))
      }
      return { tCall, timeout: true }
    })()`)
    console.log(`play ${t}: ${JSON.stringify(r)}`)
    await ev(`window.ghost.player.pause()`)
    await new Promise((r) => setTimeout(r, 400))
  }
  await ev(`window.ghost.player.pause()`)
} else {
  console.log('usage: catalog-rpc-bench.mjs browse [runs] | album <id>... | play <albumId>:<index>...')
}
ws.close()
