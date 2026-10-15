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
| `GHOST_PERF_LOG=1` | log main stalls live (otherwise the detectors only run while a window is focused, or for 10 min after `__perf()`) |
| `GHOST_PERF_IPC=1` | count IPC bytes per channel (`window.ghost.__perf().ipc`) |
| `node scripts/startup.mjs [runs] [--screen browse]` | renderer startup milestones (first screen, canvas, settled) over N reloads |
| `node scripts/nav.mjs` | screen / overlay open latency |
| `node scripts/cpu.mjs [secs] [--focus\|--blur] [--settle s]` | CPU per Electron process + renderer main-thread breakdown (idle checks) |
| `node scripts/soak.mjs` / `detached.mjs` | long-session heap growth / who keeps detached DOM alive |
| `node scripts/render-count.mjs` | React renders per action (dev build) |
| `node scripts/bundle-report.mjs` | renderer bundle size by source |
| `node scripts/play-latency.mjs <albumId> [index]` | click → sound milestones (request → resolved → engine-set → playing) |
| `node scripts/catalog-rpc-bench.mjs` / `npx tsx scripts/catalog-bench.ts <db copy>` | catalog queries through the app / offline on a DB copy |
| `cd native && cargo run --release -p ghost-engine --example bench` | engine time-to-first-audio, seek, decode hashes against a simulated (throttled) server; also `idle`, `devbench`, `cachebench`, ghost-art `art_bench` |

All scripts take `CDP_PORT` (default 9223).

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

## Second pass (0.3.0, 2026-10-14): code review + every layer

Same machine and profile (93k games / 135k albums), production build unless noted.

| Area | Before | After |
|---|---|---|
| Renderer: first screen after launch | 338–347 ms (React.lazy's 300 ms fallback throttle) | 34–44 ms (median 40) |
| Renderer: first Title → Browse / first overlay open | ~345 / ~300 ms | ~45 / 2–19 ms |
| Renderer: startup JS / total JS / fonts | 1355 KB / 2879 KB / 10.6 MB | 504 KB / 1236 KB / 4.9 MB |
| Idle, unfocused (renderer / GPU) | 2.2 % / 2.4 % | 0.2 % / 0 % (drawing paused after 10 s) |
| Idle, focused at 30 fps (renderer / GPU) | 3.3–4.6 % / 3.8–6.1 % | 1.2 % / 2 % |
| Browse key steps / hold / search | p99 18.6 ms, rare 33 ms frames | p99 18.6 ms, 0 frames > 25 ms; main loop p99 12.5 ms |
| Long-session renderer heap (200-step soak) | 11.9 → 39.8 MB, growing | 11.8 → 18.2 MB, flat |
| Main, backgrounded & paused | ~800 context switches/s, ~1.1 % CPU | ~170/s, ~0.3 % |
| Playback IPC | 10.5 KB/s | ~1.7 KB/s |
| Search (worker, p50) | "final fantasy" 5.0 ms, platform filter after a change 62–128 ms | 2.1 ms, 9–18 ms |
| KHInsider listing parse / weekly refresh writes | 30.5 ms per page / ~6 s | 8.2 ms / < 1 s |
| Click → sound, uncached KHInsider MP3 | ~0.9–1.3 s | 0.43 s (≈0.27 s when its URL was warmed by resting on it; the track-page fetch is ~0.16 s) |
| Click → sound, uncached Zophar MP3 | ~5.9 s (often "stalled") | 0.87–0.98 s |
| Click → sound, preloaded next / cached | — | 22–28 ms |
| YouTube chapter at 19 min (fragmented MP4 seek) | 3.7 s | 0.35 s |
| Engine CPU playing MP3 / idle | 16.96 / 1.57 ms per s | 10.14 / 0.77 ms per s |
| Analysis memory, 6-min MP3 / 60-min track | +200 MB / 2.15 GB | +22 MB / 87 MB |

What changed, briefly:
- **Renderer:** `shell/lazyModule.ts` instead of React.lazy; Pixi driven from our ticker; the
  ticker sleeps on a timer below display rate and pauses when unfocused and silent; LRU-bounded
  Browse caches; minified renderer.
- **Main:** stall detectors and the player heartbeat only run when needed; volume/seek echoes
  coalesced; queue resends skipped; HTML cache writes off the request path; a V8 compile cache
  for the worker.
- **Catalog:**
  - htmlparser2 with direct tree walks.
  - Unchanged rows are skipped on refresh.
  - `platform_names` table; trigger-kept per-source counts; paced FTS merges.
  - Bounded statement cache.
  - Pre-resolving stream URLs (album rest, track rest, next queued).
- **Engine:**
  - Bounded HTTP ranges over pooled connections.
  - Partial-chunk reads; no trailing-tag probe before first audio.
  - sidx-based fragmented-MP4 seeks.
  - Streaming offline analysis.
  - Division-free limiter.
  - Device-change listener instead of polling.
