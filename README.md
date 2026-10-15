# GHOST — Game Haven OST

A private desktop app for streaming (and downloading) the soundtrack of any video game, wrapped in an osu!-inspired, beat-reactive interface. The design lives in [docs/DESIGN.md](docs/DESIGN.md).

- **Catalog sources:** indexed automatically in the background, one after another.
  - KHInsider: the main catalog, MP3 and FLAC album rips.
  - Zophar's Domain: per-track MP3 rips, including PlayStation, DS, GBA and N64 sets that can't be emulated.
  - Modland: original SNES, NES, Game Boy and Sega (Mega Drive, Master System, Game Gear) sound files (SPC, NSF, GBS, VGM), emulated live with real loop points.
  - The Internet Archive's curated game-soundtrack collections.
  - vgmrips chiptune packs. joshw.info rip sets are opt-in, because its robots.txt asks crawlers to stay out.
  - Your own music folders.
- **Last resorts:** searched on demand with "Search online" and imported into the catalog:
  - YouTube and SoundCloud (through yt-dlp, fetched automatically from the official release).
  - Internet Archive.
  - Bandcamp.
- **Engine:** written in Rust.
  - Streams through a disk cache that fetches only the parts it needs.
  - Sample-exact gapless playback, even when resampling; optional crossfade.
  - Loudness levelling (EBU R128) with a true-peak limiter.
  - Real game loop points.
  - Low-passes the music behind overlays; separate preview channel.
  - Tags downloads.
- **Interface:**
  - Song-select style Browse carousel (Game ▸ Album ▸ Track).
  - Play screen with radial / skyline / oscilloscope visualizers.
  - Kiai mode, triggered by high-energy sections the analysis detects.
  - Intensity ★ ratings.
  - Playlists, smart playlists, queue, likes, history, downloads and settings.

## Run

```bash
npm install
```

```bash
npm run build:native
```

```bash
npm run dev
```

`build:native` compiles the Rust engine (`native/`) into `native/dist/ghost.node`. The first build takes a few minutes; after that it's incremental.

The first launch builds the catalog in the background. KHInsider takes about 6 to 7 minutes, and the other sources follow it. Searching works straight away.

Search is forgiving: "yugioh" finds Yu-Gi-Oh!, "ff7" finds Final Fantasy VII, and typos get a "Did you mean …?".

### Optional keys (Settings → Integrations)
- **IGDB** (Twitch developer app client ID + secret): game metadata and cover art.
- **SteamGridDB** API key: wide hero backgrounds and logos.

Keys are stored only in your local settings file.

## Package

```bash
npm run dist
```

This produces `release/<version>/` (dmg / AppImage / nsis). Use `npm run dist:dir` for an unpacked app. Builds are unsigned (private use).

## Develop

| Task | Command |
|---|---|
| UI only, with a mock backend, in a browser | `npm run dev:web`, then open http://localhost:5173 (`?screen=browse|play`, `?overlay=library|settings|downloads|nowPlaying`, `?kit` for the component gallery, `&mockScale=5000` for a big catalog) |
| Type-check | `npm run typecheck` |
| TS tests | `npm test` |
| Rust tests | `cd native && cargo test` |
| Engine from the terminal | `cd native && cargo run -p ghost-cli -- play <url|file> --seconds 10` (also `render`, `analyze`, `inspect`, `download`, `devices`) |
| Headless end-to-end check of the real stack | see the header of `scripts/e2e-smoke.ts` |
| Drive a running app (screenshots, keys, eval) | start it with `--remote-debugging-port=9223`, then `node scripts/cdp.mjs …` |
| Isolated app data for testing | `GHOST_USER_DATA=/some/dir npm run dev` |

### Layout

| Path | What's there |
|---|---|
| `src/shared` | Contracts between the renderer and main process (`api.ts`, `types.ts`) and the search syntax |
| `src/main` | Electron main process: `catalog` (SQLite + FTS5), `providers`, `player`, `library`, `downloads`, `settings`, `net` (Chromium-stack fetching, `ghost-art://` art cache) |
| `src/preload` | `window.ghost` bridge and the shared-memory analysis reader |
| `src/renderer/src` | React UI. Toolkit: `ui/README.md` |
| `native/crates` | `ghost-engine` (audio engine), `ghost-analysis` (DSP), `ghost-formats` (libgme / vgmstream / libopenmpt), `ghost-node` (napi bindings), `ghost-cli` |

## Third-party code

- **Vendored native libraries** (statically linked, see `native/vendor/`):
  - libgme: LGPL-2.1+
  - vgmstream: ISC-style
  - libopenmpt: BSD-3
  - libogg/libvorbis: BSD-3

  This is fine for a private build; redistributing would bring LGPL obligations.
- **yt-dlp** is downloaded at runtime from its official GitHub releases and checked against the published SHA-256 sums.
