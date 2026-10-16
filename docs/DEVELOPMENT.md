# Developing GHOST

Everything you need to build GHOST from source, run it while you work on it, and find your way around the code. The design and the reasoning behind it are in [DESIGN.md](DESIGN.md).

## Prerequisites

| | macOS | Windows | Linux (Debian / Ubuntu) |
|---|---|---|---|
| **Node.js 24+** | [nodejs.org](https://nodejs.org) or `brew install node` | [nodejs.org](https://nodejs.org) | [nodejs.org](https://nodejs.org) or your package manager |
| **Rust (stable)** | [rustup.rs](https://rustup.rs) | [rustup.rs](https://rustup.rs) | [rustup.rs](https://rustup.rs) |
| **C/C++ compiler** | `xcode-select --install` | [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++" | `sudo apt install build-essential pkg-config libasound2-dev` |

On other Linux distributions, install the equivalents: a C/C++ toolchain, `pkg-config` and the ALSA development headers (`alsa-lib-devel` on Fedora, `alsa-lib` on Arch).

## Build and run

```bash
git clone https://github.com/nameless525/ghost.git
cd ghost
npm ci
npm run build:native
npm run dev
```

- `npm run build:native` compiles the Rust audio engine (`native/`) into `native/dist/ghost.node`. The first build takes a few minutes; later ones are incremental. Run it again whenever you change Rust code.
- `npm run dev` starts the app with hot reload for the interface.
- Use a separate data folder so development never touches your real library: `GHOST_USER_DATA=/tmp/ghost-dev npm run dev`.

## Package an installer

```bash
npm run dist
```

This builds the engine and the app, then writes an installer for the current OS to `release/<version>/`: a `.dmg` on macOS, an `.exe` installer on Windows, and an `.AppImage` plus a `.deb` on Linux. `npm run dist:dir` writes an unpacked app instead, which is quicker to try.

Builds aren't code-signed. Pushing a tag such as `v0.3.3` starts the [release workflow](../.github/workflows/release.yml):

1. It runs every test (app and engine) on macOS, Windows and Linux.
2. Only if they all pass, it builds the installers on each platform and opens each freshly built app with the launch check below.
3. Only if all three launch, it publishes a GitHub release with the installers and the notes from [CHANGELOG.md](../CHANGELOG.md).

## Everyday commands

| Task | Command |
|---|---|
| Type-check | `npm run typecheck` |
| TypeScript tests | `npm test` |
| Rust tests | `cd native && cargo test` |
| Interface only, in a browser, with a mock backend | `npm run dev:web`, then open <http://localhost:5173> |
| Play something from the terminal (no UI) | `cd native && cargo run -p ghost-cli -- play <url-or-file> --seconds 10` |

`npm run dev:web` takes a few URL parameters: `?screen=browse` or `?screen=play`, `?overlay=library|settings|downloads|nowPlaying`, `?kit` for the component gallery, and `&mockScale=5000` for a big fake catalog. `ghost-cli` also has `render`, `analyze`, `inspect`, `download` and `devices` commands.

## Project layout

| Path | What's there |
|---|---|
| `src/main` | Electron main process: `catalog` (SQLite + FTS5 in a worker thread, index crawls), `providers` (one per music source), `player`, `library`, `downloads`, `settings`, `net` (fetching through Chromium's network stack, the `ghost-art://` image cache), `tools` (the managed yt-dlp) |
| `src/preload` | The `window.ghost` bridge and the shared-memory reader for live audio analysis |
| `src/renderer/src` | The React interface: `screens` (title, Browse, Play), `overlays` (library, settings, downloads, now playing), `shell`, `ui` (the component kit, see [`ui/README.md`](../src/renderer/src/ui/README.md)), `gfx` (PixiJS background and visualizers) |
| `src/shared` | Types and the API contract shared by every process, and the search syntax parser |
| `native/crates` | Rust: `ghost-engine` (audio engine), `ghost-analysis` (DSP: spectrum, beats, loudness), `ghost-formats` (chiptune and game-audio decoders), `ghost-node` (napi bindings), `ghost-art`, `ghost-cli` |
| `native/vendor` | Vendored C/C++ decoder libraries (libgme, vgmstream, libopenmpt, libvorbis, libogg, libopus), each with its own license |
| `scripts` | `build-native.mjs`, `cdp.mjs` (drive a running app), `perf/` (profiling and benchmarks), `smoke/` (end-to-end checks against the real sites) |
| `resources` | App icons |

## Testing against a running app

Build the app, start it with remote debugging, then drive it from another terminal:

```bash
npm run build
```

```bash
GHOST_USER_DATA=/tmp/ghost-dev npx electron . --remote-debugging-port=9223
```

```bash
node scripts/cdp.mjs shot screen.png
```

`cdp.mjs` can also `eval` JavaScript in the window, press keys, type, click and scroll; see the top of the file. The performance tools in `scripts/perf/` work the same way and are described in [perf/README.md](perf/README.md). The smoke tests in `scripts/smoke/` exercise the real stack (catalog, sources, player, engine) without a window; each file's header says how to run it.

`scripts/smoke/launch.mjs` checks a packaged build: it opens the app with a throwaway profile (every catalog source off, so nothing is crawled) and makes sure the window, the catalog worker and the audio engine come up. For example, after `npm run dist:dir` on a Mac:

```bash
node scripts/smoke/launch.mjs release/0.3.3/mac-arm64/GHOST.app/Contents/MacOS/GHOST
```

`GHOST_NET_TESTS=1 npm test` also downloads the real yt-dlp release for your OS, checks it against the published checksums and runs it. CI does this on every platform.

## Conventions

- Tests sit next to the code they cover (`*.test.ts`). Source parsers are tested against saved pages in `src/main/providers/__fixtures__`.
- `src/shared/types.ts` and `src/shared/api.ts` are the contract between processes: change them additively.
- Be a good guest on the sites GHOST reads. Requests are paced, sent one at a time per site, cached, and carry an honest user agent. Never add code that gets around a site's bot protection or its robots.txt.
- Every wait the user can see gets a progress indicator, and only one song is ever audible at a time.
