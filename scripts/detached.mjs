#!/usr/bin/env node
// Who keeps detached DOM alive? Takes a heap snapshot of the renderer and prints the most common
// retainer chains of detached DOM trees (the JS objects holding them), plus counts.
//   CDP_PORT=9241 node scripts/detached.mjs [--save out.heapsnapshot] [--depth 6]
const args = process.argv.slice(2)
const flag = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : d
}
const depth = Number(flag('--depth', 6))
const save = flag('--save', null)
const port = process.env.CDP_PORT || 9223
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
let id = 0
const pending = new Map()
const chunks = []
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(d.params.chunk)
  else if (d.id && pending.has(d.id)) (pending.get(d.id)(d), pending.delete(d.id))
}
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
await send('HeapProfiler.enable')
await send('HeapProfiler.collectGarbage')
await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false })
ws.close()
const raw = chunks.join('')
if (save) (await import('node:fs')).writeFileSync(save, raw)
const snap = JSON.parse(raw)
const { node_fields: nf, edge_fields: ef, node_types: [nodeTypes], edge_types: [edgeTypes] } = snap.snapshot.meta
const N = nf.length
const E = ef.length
const nodes = snap.nodes
const edges = snap.edges
const strings = snap.strings
const iType = nf.indexOf('type')
const iName = nf.indexOf('name')
const iEdgeCount = nf.indexOf('edge_count')
const iDet = nf.indexOf('detachedness')
const count = nodes.length / N
const name = (n) => strings[nodes[n * N + iName]]
const type = (n) => nodeTypes[nodes[n * N + iType]]
// forward edges → reverse (retainers)
const firstEdge = new Uint32Array(count + 1)
for (let n = 0, e = 0; n < count; n++) {
  firstEdge[n] = e
  e += nodes[n * N + iEdgeCount] * E
}
firstEdge[count] = edges.length
const retainers = Array.from({ length: count }, () => [])
for (let n = 0; n < count; n++) {
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += E) {
    const et = edgeTypes[edges[e]]
    if (et === 'weak') continue
    const to = edges[e + 2] / N
    const label = et === 'element' || et === 'hidden' ? `[${edges[e + 1]}]` : strings[edges[e + 1]]
    retainers[to].push([n, label, et])
  }
}
const isDom = (n) => /^(HTML|SVG|Text$|Comment$|DocumentFragment$|Detached )/.test(name(n)) || name(n).startsWith('Detached ')
const detached = []
for (let n = 0; n < count; n++) if ((iDet >= 0 && nodes[n * N + iDet] === 2) || name(n).startsWith('Detached ')) detached.push(n)
console.log(`detached DOM objects: ${detached.length}`)
const byName = new Map()
for (const n of detached) byName.set(name(n), (byName.get(name(n)) ?? 0) + 1)
console.log([...byName].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `  ${v} × ${k}`).join('\n'))
// For each detached node, walk up retainers that aren't detached DOM themselves: the first
// non-DOM retainer chain is what holds the tree.
const chains = new Map()
const detSet = new Set(detached)
for (const n of detached) {
  const holders = retainers[n].filter(([r]) => !detSet.has(r) && !isDom(r))
  if (!holders.length) continue
  for (const [r, label] of holders.slice(0, 2)) {
    const parts = [`${name(n).replace('Detached ', '')}`, `<-${label}- ${type(r)}:${name(r).slice(0, 60)}`]
    let cur = r
    for (let d = 0; d < depth; d++) {
      const up = retainers[cur].find(([x, , et]) => et !== 'weak' && type(x) !== 'synthetic' && !detSet.has(x))
      if (!up) break
      parts.push(`<-${up[1]}- ${type(up[0])}:${name(up[0]).slice(0, 60)}`)
      cur = up[0]
    }
    const k = parts.join(' ')
    chains.set(k, (chains.get(k) ?? 0) + 1)
  }
}
console.log('\nretainer chains (count  chain):')
for (const [k, v] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(v).padStart(5), ' ', k)
