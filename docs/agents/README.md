# GHOST — team conventions for parallel workstreams

Read `docs/DESIGN.md` first. It is the spec. This file is how we work in one repo at the same time.

## Contracts (owned by the lead; change additively, re-Read before every Edit, never Write over them)
- `src/shared/types.ts`: domain types
- `src/shared/api.ts`: `GhostAPI` (renderer ↔ main) + `API_METHODS`
- `src/shared/defaults.ts`: default settings, intensity colours
- `src/main/engine/types.ts`: `EngineBridge` (TS view of the Rust engine)
- `native/crates/ghost-engine/src/lib.rs`: public Rust engine API
- `native/crates/ghost-analysis/src/lib.rs`: public Rust analysis API

If you need a contract change, make the smallest additive edit and mention it in your final report.

## Ownership (only edit files you own; everything else is read-only for you)
| Workstream | Owns |
|---|---|
| engine-core | `native/crates/ghost-engine/**` (except the public API rules above), `native/crates/ghost-cli/**` |
| analysis | `native/crates/ghost-analysis/**` |
| engine-bindings | `native/crates/ghost-node/**`, `scripts/build-native.mjs`, `src/main/engine/native.ts`, `src/preload/analysis.ts` |
| catalog | `src/main/catalog/**`, `src/main/providers/**`, `src/main/net/**`, `src/shared/search.ts` |
| services | `src/main/player/**`, `src/main/library/**`, `src/main/downloads/**`, `src/main/settings/**`, `src/main/services.ts`, `src/main/media/**` |
| ui-shell | `src/renderer/src/{App.tsx,theme,motion,gfx/background,shell,ui,sound,hooks,screens/title}/**` |
| ui-browse | `src/renderer/src/screens/browse/**` |
| ui-play | `src/renderer/src/screens/play/**`, `src/renderer/src/overlays/now-playing/**`, `src/renderer/src/gfx/visualizers/**` |
| ui-library | `src/renderer/src/overlays/{library,downloads,settings}/**` |

The lead owns `src/main/index.ts`, `src/main/ipc.ts`, `src/main/db.ts`, `src/main/paths.ts`, `src/preload/index.ts`, `src/renderer/src/{main.tsx,ghost.ts,state/**,mock/**,lib/**}`, configs and `package.json`.
UI workstreams may add small, clearly named helpers to `src/renderer/src/state/ui.ts` only via additive Edits.

## Shared tooling
- **Adding npm deps:** `npm run add-dep -- <pkg> [--dev]`. It serialises installs, so never run `npm install` directly.
- **Rust:** set `CARGO_TARGET_DIR=native/target/<your-workstream>` so parallel builds don't block on one lock.
- **Renderer dev server (mock backend, no Electron):** `http://localhost:5173` (already running; Vite hot-reloads). Deep links: `?screen=browse|play|title` and `?overlay=library|settings|downloads|nowPlaying` (implemented by ui-shell).
- **Built-in browser:** open your OWN tab (`preview_start` with `url: "http://localhost:5173/?screen=…"`) and pass its tabId everywhere. Never close or navigate other agents' tabs.
- **Type-check:** `npm run typecheck`. Unit tests: `npx vitest run <path>`. Rust: `cargo test -p <crate>` inside `native/`.
- **Don't commit.** The lead commits.

## Quality bar
- The UI targets 120 fps. Per-frame animation goes in rAF and writes `transform`/`opacity` directly. No React state updates per frame.
- Real-time audio code: no allocation, no locks, no I/O on the output callback.
- No placeholder "TODO" UIs in your owned area by the time you finish. Ship it working and polished.
