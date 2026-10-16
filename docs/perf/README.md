# GHOST performance work

## Tools
| Tool | What |
|---|---|
| `window.__ghostPerf.stats(reset)` (renderer) | frame-time histogram (ticker rawDt), long tasks / long animation frames, heap |
| `window.ghost.__perf(reset)` (renderer → main) | main-process event-loop delay p50/p99/max, stalls > 40 ms (with last slow-op hint), slow SQL statements (> 8 ms) |
| `window.__ghostPacing.override = Infinity \| null` | disable/restore adaptive frame pacing while measuring |
| `node scripts/perf/perf-scenario.mjs <scenario>` | scripted Browse scenarios + both stats (app must run with `--remoteDebuggingPort 9223`) |
| `node scripts/perf/cpuprofile-main.mjs <secs> <out>` / `--summary <out>` | CPU profile of the main process (`--inspect 9229`) or renderer (`CPU_PORT=9223`) |
| `node scripts/perf/trace.mjs <secs> <out>` / `--summary <out>` | Chrome trace (style/layout/paint/raster/GPU) |
| `GHOST_PERF_LOG=1` | log main stalls live (otherwise the detectors only run while a window is focused, or for 10 min after `__perf()`) |
| `GHOST_PERF_IPC=1` | count IPC bytes per channel (`window.ghost.__perf().ipc`) |
| `node scripts/perf/coldstart.mjs <app executable> --profile <dir> [--runs N]` | launch → main ready → window → first screen → catalog's first answer, from fresh process starts on clones of a profile, plus CPU and memory after start-up |
| `node scripts/perf/startup.mjs [runs] [--screen browse]` | renderer startup milestones (first screen, canvas, settled) over N reloads |
| `node scripts/perf/nav.mjs` | screen / overlay open latency |
| `node scripts/perf/cpu.mjs [secs] [--focus\|--blur] [--settle s]` | CPU per Electron process + renderer main-thread breakdown (idle checks) |
| `node scripts/perf/soak.mjs` / `detached.mjs` | long-session heap growth / who keeps detached DOM alive |
| `node scripts/perf/render-count.mjs` | React renders per action (dev build) |
| `node scripts/perf/bundle-report.mjs` | renderer bundle size by source |
| `node scripts/perf/play-latency.mjs <albumId> [index]` | click → sound milestones (request → resolved → engine-set → playing) |
| `node scripts/perf/catalog-rpc-bench.mjs` / `npx tsx scripts/perf/catalog-bench.ts <db copy>` | catalog queries through the app / offline on a DB copy |
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

## Third pass (2026-10-15): launch, background playback, memory, size

Same machine and profile as above (M5, 4K display at 60 Hz, window 1440×900 at 2x, 93k games),
production builds. Launch numbers are medians of 9 fresh launches (`coldstart.mjs`, on clones of
the profile with and without Chromium's GPU caches). CPU numbers are the share of one core used by
every GHOST process together, from interleaved A/B runs of both builds: this machine had a browser
playing video at the time, so single samples vary by up to ±8 points (medians of 9 shown).

| Area | Before | After |
|---|---|---|
| **Minimised (or fully covered) while playing** | 26–29 % (30 fps drawn into a hidden window; live analysis running) | **2.4–2.8 %** |
| Launch → title screen (warm GPU caches / first launch) | 393 / 432 ms | 334 / 340 ms |
| Launch → window shown / catalog's first answer | 329 / 260 ms | 285 / 201 ms |
| CPU used in the first 8 s after launch | 3.1 s | 2.4 s |
| JavaScript parsed before the first screen | 513 KB | 331 KB |
| Focused, playing: Title / Play / Browse (60 fps) | 49.9 / 40.4 / 48.3 % | 46.1 / 37.9 / 41.8 % |
| Title idle (focused, 30 fps) / Browse playing unfocused (30 fps) | 18.7 / 28.0 % | 17.5 / 26.6 % |
| Title screen: the spinning logo's GPU layer | 4038×4083 px (63 MB) | 1008×1008 px (4 MB) |
| Memory after playing on Browse (main / GPU process / renderer) | 94 / 382 / 117 MB | 78 / 355 / 103 MB |
| Engine CPU playing a 44.1 kHz MP3 (48 kHz device) | 31–36 ms per s | 24–27 ms per s |
| Resampler, 44.1 → 48 kHz | 3.46 ms per s of audio | 0.74 ms per s of audio |
| Engine + coreaudiod with nothing playing (after 30 s) | ~5.6 ms per s, device kept running | 0 (stream suspended) |
| Capped frames (12 / 20 fps; 30 fps on 120 Hz): rAF calls per drawn frame | 2 | 1 |
| Listening without input on a 120 Hz display | 120 fps | 60 fps |
| macOS installer / app on disk / ghost.node | 144.5 / 321 / 17.2 MB | 129.6 / 263 / 13.5 MB |
| First catalog build: full re-clusters (each ~1 s plus an FTS merge) | one per source (4) | 1 |
| Weekly refresh: writes for unchanged albums | ~135k row updates | none |
| IGDB enrichment step (backlog query) | 7 ms | 0.05 ms |
| Browse covers, random jump + 40-row scroll, empty art cache (median until a cover shows / every visible row shows one after stopping) | 6.9–12.9 s / 6.3–15.6 s | 0.3–1.0 s / 0.7–1.0 s |
| Same, on a simulated 50 Mbps CDN (median / visible rows after stopping) | 0.3–1.6 s / 0–1.8 s | 4–8 ms / 0–0.3 s |

What changed:
- **Hidden windows draw nothing.** `backgroundThrottling` is back on (it had been off since the
  scaffold), so a minimised or covered window reports itself hidden and the ticker stops. The
  renderer also tells the engine (`player.setAnalysisDemand`), which then stops feeding its
  real-time analysis thread and publisher; so does closing the last window on macOS.
- **Start-up:** the engine registers for CoreAudio device changes on its own thread (the first
  CoreAudio call costs ~45 ms and ran on Electron's main thread, ahead of the window). Pixi and
  the background's WebGL set-up load after the first screen (`shell/firstScreen.ts`): Pixi's
  module init reads back a GPU canvas, and WebGL set-up waits on the GPU process, which on a cold
  start held the first frame for hundreds of ms in a trace. Renderers are made without a probe
  context or depth/stencil buffers (`gfx/glRenderer.ts`). The preload loads the addon on the
  first analysis read. The catalog worker imports `cheerio/slim` (~45 ms less to load), and
  cheerio and music-metadata are bundled instead of shipped as 1,082 loose files.
- **Memory:** the title logo's SVG is clipped to its viewBox (the textPath's conservative bounds
  made a 63 MB layer); full-size background art is dropped 10 s after the blur returns, and older
  tracks' copies as soon as a new one lands; the visualizer canvas hides and stops drawing when
  nothing on it is visible.
- **Frame pacing:** passive playback is capped at 60 fps on displays above 70 Hz. Capped frames
  three or more vsyncs apart are requested by a timer that learns where a request lands
  (Chromium serves a rAF asked for mid-interval at once, stamped with that interval, when it
  hasn't drawn yet), so none has to be skipped; frames two vsyncs apart keep the every-vsync rAF.
- **Engine:** exact polyphase resampling (nearest lookup in a sinc table with `to / gcd` points per
  input sample) wherever that table is ≤ 1024 points, cubic otherwise; the device stream is
  paused after 30 s with nothing playing and resumed by the next command; whole-program LTO.
- **Main and catalog:** the queue isn't re-sent on library changes that don't touch it; session
  saves reuse the queue's JSON; production builds don't run the stall detectors; the Downloaded
  view checks files in parallel; the art cache is trimmed once a day; the full re-cluster runs
  once per crawl round; unchanged albums aren't written on refresh; the IGDB backlog is two index
  walks; the spellchecker is off.
- **Package:** only English Chromium locales (`electronLanguages`).
- **Browse covers** (`net/art-protocol.ts`, `screens/browse/prefetch.ts`): a quick scroll queued
  every cover it passed, full-size scans included, as up to 4 downloads per host across ~7 hosts
  at once; with the connection split ~28 ways, covers on screen waited behind everything scrolled
  past (Electron gives the handler no sign that an <img> moved on). Now at most 6 downloads run,
  newest first, small images ahead of full-size ones, background ones last, and a slot is only
  taken when the host's limiter can start; the smallest bucket comes from the source's thumbnail
  (KHInsider 117 px, Zophar ~180 px); game rows show that preview under the full cover; the rows
  around a resting selection are fetched ahead at background priority; the info wedge's 1600 px
  hero waits for the selection to rest.

Measured, not changed (yet):
- At 60 Hz, a focused window while music plays costs ~45–55 % of a core on Title, Browse and Play,
  almost all of it Chromium's per-frame work (style, paint, commit, two WebGL canvases, compositing
  and presentation). Hiding single layers doesn't move it; fewer frames does. An unfocused window
  while playing is 30 fps (~32 %); at 20 fps it would be ~22 %.
- A Genesis VGM (Nuked OPN2, cycle-accurate) costs ~100 ms of engine CPU per second; libgme's
  faster YM2612 cores would cut that at a fidelity cost.
- Minimised while playing, what's left is the main process and engine (~1.1 %), the renderer
  (~0.8 %) and Chromium's audio service (~0.6 %). The last two are mostly the silent `<audio>` kept
  for the OS media controls; native media controls (MPNowPlayingInfoCenter / SMTC / MPRIS) would
  remove it.
