# GHOST performance work

## Tools
| Tool | What |
|---|---|
| `window.__ghostPerf.stats(reset)` (renderer) | frame-time histogram (ticker rawDt), long tasks / long animation frames, heap |
| `window.ghost.__perf(reset)` (renderer → main) | main-process event-loop delay p50/p99/max, stalls > 40 ms (with last slow-op hint), slow SQL statements (> 8 ms) |
| `window.__ghostPacing.override = Infinity \| null` | disable/restore adaptive frame pacing while measuring |
| `node scripts/perf-scenario.mjs <scenario>` | scripted Browse scenarios + both stats (app must run with `--remoteDebuggingPort 9223`) |
| `node scripts/cpuprofile-main.mjs <secs> <out>` / `--summary <out>` | CPU profile of the main process (`--inspect 9229`) or renderer (`CPU_PORT=9223`) |
| `node scripts/trace.mjs <secs> <out>` / `--summary <out>` | Chrome trace (style/layout/paint/raster/GPU) |
| `GHOST_PERF_LOG=1` | log main stalls live |

Launch for profiling (isolated profile):
`GHOST_USER_DATA=/tmp/ghost-perf npx electron-vite dev --remoteDebuggingPort 9223 --inspect 9229`

## Baseline (2026-10-14, M5, 4K external display @ 60 Hz, window 1440×900 @2x, 88k-game catalog)

### Main process (the big problem)
On macOS the Electron main thread also delivers native window input, so main-thread stalls are felt as UI lag.
- Startup stalls of **639 / 842 / 627 ms**: `UPDATE games SET rnd = …` (481 ms), the status count query (375 ms cold), non-game bucket aggregations (70–230 ms each).
- During browsing: recurring stalls **120–300 ms**, event-loop p99 25–42 ms, max up to 308 ms.
- 14 s CPU profile while browsing: `nativeImage.getBitmap` **2018 ms** (accent extraction decoding full-size covers), native image decode ~**919 ms**, `toJPEG`+`resize` **324 ms** (ghost-art thumbnails), SQLite `get` **531 ms** (status counts recomputed ~25 ms each, several times a second).

### Renderer (fine at 60 Hz, tight at 120 Hz / 4K)
- Browse key-nav/fling at 60 Hz: frame p99 17.6 ms, one 84 ms long frame.
- Trace (9 s, 540 frames): BeginMainFrame avg 3.7 ms (max 7); **style recalc every frame** (~1.7 ms, accent `--accent*` glide on :root restyles the document); **DOM re-raster every frame** (GPU process ~32 % busy; RendererRasterWorker 1.86 s / 9 s).
- Full-window PixiJS canvases render at devicePixelRatio (2×) even though the background is blurred.

### Audio
- Underruns are not counted/exposed yet (to add).

## After (2026-10-14, same machine/profile, quiet system)

| Scenario | Before | After |
|---|---|---|
| Startup main stalls | 639 / 842 / 627 ms | one 72 ms stall (bundle load, before the window exists) |
| Browse key-nav / hold / fling / search: main event-loop max | 54–308 ms | 11.7–13.3 ms |
| Main stalls > 40 ms while browsing | recurring | 0 |
| Main-thread image work (14 s browse profile) | ~2,550 ms | ~6 ms (Rust pool) |
| Slow SQL on the main thread | 25–481 ms statements | none (catalog in a worker thread) |
| 60 s continuous key-nav **during a live re-crawl** | 500–800 ms freezes | 3,601 frames, 0 > 25 ms; main max 13 ms; 0 stalls |
| Browse style recalc (ms per second) | 81–192 | 30–38 |
| Browse paints per frame | 12.6–21 | 4.5–10.5 |
| GPU process, Browse | 38–47 % | 21–27 % |
| GPU process, Title playing | ~21 % (SwapBuffers 1.52 ms/frame) | 7.5 % (0.41 ms/frame) |
| Engine CPU idle / playing | 1.65 % / ~3.4 % | 0.23 % / 2.15 % |
| Audio under 24.6 load average | not measured | 0 underruns, worst callback 101 µs of 21.3 ms |

What changed: catalog moved to a `worker_threads` worker (RPC for `net.fetch`, `inspectArchive`, broadcasts), incremental counts and chunked work; image decode/resize/accent in a Rust thread pool with size-bucketed art; stepped accent variables, compositor-only glows and pulses, `display:none` closed overlays, 1× background / ≤1.5× visualizer canvases, off-thread texture decode; structural-sharing player store and queue-revision IPC; live backdrop blur only where sharp art sits behind (Play); App Nap blocked while playing; GHOST caches moved out of Chromium's `Cache/`.
