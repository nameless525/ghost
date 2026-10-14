// Perf scenario runner (needs the app running with --remote-debugging-port 9223 and the instrumented
// build). Usage: node scripts/perf-scenario.mjs <idle|browse-keys|browse-hold|fling|search>
// Runs a named scenario against the app via CDP and prints renderer + main perf stats.
import { execFileSync } from 'node:child_process'
const cdp = (...a) => execFileSync('node', ['scripts/cdp.mjs', ...a], { encoding: 'utf8' })
const ev = (js) => cdp('eval', js)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const name = process.argv[2]
ev(`(async()=>{window.__ghostPacing.override=Infinity; window.__ghostPerf.stats(true); await window.ghost.__perf(true); return 1})()`)
if (name === 'browse-keys') {
  for (let i = 0; i < 40; i++) { cdp('key', 'ArrowDown'); await sleep(60) }
  await sleep(1500)
} else if (name === 'browse-hold') {
  for (let i = 0; i < 120; i++) { cdp('key', 'ArrowDown'); await sleep(16) }
  await sleep(1500)
} else if (name === 'fling') {
  ev(`(async()=>{ const el=document.querySelector('.bc'); const r=el.getBoundingClientRect(); for(let i=0;i<90;i++){ el.dispatchEvent(new WheelEvent('wheel',{deltaY:120, clientX:r.x+300, clientY:r.y+400, bubbles:true})); await new Promise(r=>requestAnimationFrame(r)) } await new Promise(r=>setTimeout(r,1500)); return 1})()`)
} else if (name === 'search') {
  ev(`(async()=>{ const inp=document.querySelector('.g-search__input'); inp.focus(); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; let q=''; for (const ch of 'final fantasy') { q+=ch; set.call(inp,q); inp.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,90)) } await new Promise(r=>setTimeout(r,2500)); set.call(inp,''); inp.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,2000)); inp.blur(); return 1})()`)
} else if (name === 'idle') {
  await sleep(5000)
}
const r = JSON.parse(ev(`window.__ghostPerf.stats()`))
const m = JSON.parse(ev(`window.ghost.__perf()`))
console.log(JSON.stringify({ scenario: name, renderer: { frames: r.frames, p50: r.p50, p95: r.p95, p99: r.p99, max: r.max, over25: r.over25, over50: r.over50, heapMB: r.heapMB, longTasks: r.longTasks.slice(0, 12) }, main: { loop: m.loop, stalls: m.stalls.slice(0, 8), slowSql: m.slowSql.slice(0, 8) } }, null, 1))
