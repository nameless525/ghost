# GHOST — design

**GHOST** = **G**ame **H**aven **OST**.

A private, personal-use desktop app for macOS, Linux and Windows that streams (and optionally downloads) video game soundtracks. It finds music the way ani-cli finds anime (type a name, get playback) and wraps that in a GUI that moves and feels like osu!.

Status: implemented (M0–M6 plus most of M7); see README.md for running and building. Last updated 2026-10-14.

---

## 1. Principles

1. **Music never glitches.** Audio runs on its own real-time thread in native code. A stalled UI frame can never cause an audio dropout.
2. **Motion is the interface.** Everything animates on purpose, using osu!-style ease-out-quint slides, beat pulses, shear and parallax. Target the display's refresh rate (120 Hz on ProMotion screens).
3. **Everything reacts to the music.** Visuals follow what you *hear*: the clock is compensated for output latency, so it tracks audible sound rather than decoded samples.
4. **Any game, best available source.** There is one canonical catalog. Each track has several possible sources, ranked, with automatic fallback when one fails.
5. **Keyboard first, mouse friendly.** Every action has a key, the way osu!'s song select does.
6. **Private use.** All sources ship in the core app. There's no plugin isolation, no accounts and no telemetry.

---

## 2. Feature scope

### Playback
- Play/pause, seek, next/previous, volume and mute. Every transport action gets a short micro-fade so nothing clicks.
- Gapless playback, sample-accurate, with encoder delay and padding trimmed.
- Optional crossfade (equal-power, 0–12 s). It turns itself off between consecutive tracks of the same album.
- Shuffle: off, normal, or smart (avoids back-to-back tracks from the same game, weights favourites).
- Repeat: off, all, or one.
- Loop-aware playback for formats that carry loop points (chiptune and game-engine formats): N loops plus a fade, or endless.
- Loudness normalization (EBU R128). Track or album mode, with a true-peak safety limiter.
- 10-band parametric EQ (later milestone).
- Output device selection. Follows the system default (for example when AirPods connect) without stopping playback.
- OS media integration: media keys, macOS Now Playing, MPRIS on Linux, SMTC on Windows.
- Sleep timer, which fades out instead of cutting off.
- Session restore: queue, position and current screen.

### Library
- **Queue:** play now, play next, add to end, drag to reorder, clear, save as playlist.
- **Playlists:** create, rename, duplicate, delete, add/remove tracks, drag to reorder. Auto-generated cover mosaic from game art. Import and export M3U8/JSON.
- **Smart playlists:** a saved search query (see §7.6), for example `platform=snes intensity>5`.
- Liked tracks, play history, recently played.
- Offline mode: plays downloaded tracks only.

### Downloads
- Download a track, an album, a playlist, or the queue.
- Saves the original stream as-is. Lossy audio is never re-encoded to lossy.
- Tags written with lofty: title, album, album artist (game), composer, disc and track numbers, year, embedded cover, ReplayGain values.
- Folder template, default: `~/Music/GHOST/{game}/{album} ({year})/{disc}-{track} {title}.{ext}`
- Chiptune formats: save the original file (NSF, SPC, …) and/or render it to FLAC with a chosen loop count and fade.
- Downloads overlay with progress, pause/resume, retry.
- Streaming already goes through the on-disk cache, so downloading a track that's fully cached is a copy plus tagging.

### Discovery
- Instant search across games, albums, tracks, composers and franchises, with filter syntax (§7.6).
- Group by game, album, composer, franchise, platform or year. Sort by title, year, length, intensity or recently added.
- Random (F2) and rewind random (Shift+F2), as in osu!.
- Browse previews: selecting a game plays its signature track from a preview point (§7.3).

---

## 3. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron** | Ships the same Chromium on all three OSes, so rendering behaves identically everywhere. Reliable 120 Hz `requestAnimationFrame`. Mature GPU compositing. App size doesn't matter for private use. |
| UI | **React 19 + TypeScript + Vite** (electron-vite) | React builds the structure. Per-frame motion is imperative (rAF writes `transform`/`opacity` directly), so React never re-renders 120 times a second. |
| GPU layer | **PixiJS v8** canvas under the DOM | Blurred background art, the drifting-pixel field, visualizers, kiai flashes and particles. |
| Motion | Small transform toolkit (osu!framework-style `fadeTo`/`moveTo`/`scaleTo` with easings) plus **Motion** for layout and mount transitions | Copies osu!'s motion semantics exactly. |
| State | Zustand (renderer); typed IPC contract between main and renderer | |
| Catalog | **better-sqlite3** + FTS5 (trigram tokenizer, so Japanese substring search works) | Synchronous and fast. Lives in the main process. |
| Providers | TypeScript in the main process (fetch + cheerio; yt-dlp as a child process) | Scrapers break often. TypeScript makes them quick to fix. |
| Audio engine | **Rust**, loaded through **napi-rs** | Real-time safe, sample-level control, direct access to the C libraries for chiptune and game-engine formats. |

The machine already has Rust 1.99 and Node 26. Install later: `yt-dlp`, `ffmpeg` (Homebrew).

**Alternatives considered**
- **osu!framework (C#)**, the framework osu! itself runs on. It's the most authentic option and has its own reference UI. Rejected because it needs a .NET stack, its audio is BASS (a black box), building font atlases is a chore, and I'd have a slower visual iteration loop while building it.
- **Tauri.** Rejected because it renders through each OS's own WebView: WebKitGTK is janky on Linux, and WKWebView frame pacing is inconsistent. That fails the "extremely smooth" requirement.

---

## 4. Architecture

```
┌──────────────────────────────── Electron app ────────────────────────────────┐
│                                                                               │
│  Renderer (React + PixiJS)                                                    │
│    screens · overlays · carousel · WebGL background + visualizers             │
│        ▲  typed IPC: state, commands          ▲  analysis frames (shared mem, │
│        │                                      │  read in rAF, no IPC per frame)
│  Main process (TypeScript)                    │                               │
│    catalog DB · providers · resolver · queue/playlists · downloads queue      │
│    yt-dlp child process · OS media integration                                │
│        ▼  napi-rs                             │                               │
│  Rust engine (native addon, own threads)  ────┘                               │
│    stream cache ─▶ decoders ─▶ resample ─▶ mixer/DSP ─▶ output (cpal)         │
│                                   └─▶ analysis (FFT, onsets, loudness, beats) │
│    downloader + tagger (reuses the stream cache)                              │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **The main process owns the queue and decides what plays.** The engine only knows `current`, `next` (preloaded so the transition is gapless) and an optional `preview`.
- **The renderer never touches audio directly.** It sends commands and receives state, and reads analysis frames (spectrum, waveform, beat phase, audible clock) from a shared-memory triple buffer that the engine writes.
- **The engine lives in the main process, not the renderer.** A renderer reload or crash doesn't stop the music, and playback keeps going with the window closed.

---

## 5. Audio engine

### 5.1 Threads
| Thread | Job | Rules |
|---|---|---|
| Output callback (cpal) | Pull from the mixer, apply DSP, write to the device | No allocation, no locks, no I/O. Lock-free SPSC rings (`rtrb`) only. |
| Decode workers (one each for current, next and preview) | Decode, resample, fill a ~2 s ring | Blocking reads from the stream cache are fine here. |
| Analysis | FFT, band energies, onset flux. Publishes frames to a triple buffer | Fed by a tap on the output path. |
| I/O (tokio) | HTTP range fetches into the chunk cache; downloads | |
| Background jobs | Full-file loudness and beat analysis, low priority | Runs faster than real time on cached files. |

### 5.2 Signal chain
```
source ─▶ decode ─▶ trim gapless padding ─▶ resample (rubato sinc) ─▶ loop/fade stage
      ─▶ track/album gain (R128) ─┐
                                  ├─▶ MUSIC BUS ─▶ duck (when previewing) ─▶ overlay low-pass
preview source ─▶ … ─▶ PREVIEW BUS┘                 ─▶ EQ ─▶ master volume (dB curve, 20 ms smoothing)
                                                    ─▶ true-peak limiter ─▶ device
analysis tap: taken AFTER gain, BEFORE master volume, so visuals stay lively at low volume
```
- The internal format is 32-bit float stereo at the device's sample rate.
- **Overlay low-pass, a nod to osu!:** when a modal overlay opens, the music bus sweeps a low-pass filter from 20 kHz down to about 500 Hz (OutQuint, 300 ms), plus 2 dB of ducking. Closing the overlay sweeps it back.
- **Volume slider:** maps to −60…0 dB on a perceptual curve and ramps between values so there's no zipper noise.

### 5.3 Streaming and cache
- Each remote source opens as a **sparse chunk cache**: 256 KB chunks, a bitmap of which chunks are present, and HTTP Range requests. The decoder sees an ordinary blocking `Read + Seek`.
- When the decoder reads a missing chunk, that request jumps to the front of the queue. Seeking ahead means one range fetch, not a full download.
- Prefetch the next 30 s first, then fill the rest of the file in the background.
- If the server doesn't support Range, fill linearly from the start.
- If a URL expires (YouTube links are short-lived) and returns 403, re-resolve it through its provider and resume.
- The cache is evicted least-recently-used with a size cap (default 5 GB). Downloaded files are pinned elsewhere and never evicted.

### 5.4 Decoders
| Formats | Library |
|---|---|
| MP3, FLAC, AAC/M4A, ALAC, Vorbis, WAV, AIFF | symphonia (gapless mode on) |
| Opus (WebM/Ogg) | libopus, behind symphonia's demuxers |
| NSF/NSFE, SPC, GBS, VGM/VGZ, HES, KSS, AY, SAP, GYM | libgme (game-music-emu) |
| ADX, HCA, BRSTM/BCSTM/BFSTM, FSB, Wwise WEM, and hundreds of other game-engine formats | libvgmstream |
| MOD/XM/IT/S3M/UMX (tracker music: Amiga, DOS, Unreal, Deus Ex) | libopenmpt |
| PSF/2SF/USF/GSF/SSF (PlayStation, DS, N64, GBA, Saturn) | later: highly_experimental, vio2sf, lazyusf2 |

As built: the C libraries live in `native/crates/ghost-formats` (vendored release tarballs under `native/vendor/`, compiled statically with the `cc` crate). Decoder choice: format hint → extension → magic bytes. Sources can address an `archiveEntry` inside a `.zip`/`.7z` (NEZPlug `.m3u` lines supply titles/lengths), a `subsong`, and a `clipStartMs`/`clipEndMs` range (chapters of full-OST videos). Chip/tracker/game-engine sources and clips download as loop-rendered FLAC. Not built: vgmstream codecs needing FFmpeg/mpg123 (XMA, ATRAC, Switch Opus…), RAR `.rsn` sets, the PSF family.

### 5.5 Gapless, crossfade, loops
- **Gapless.** Once the main process calls `setNext`, the next source starts decoding into its own ring. When the current source runs out mid-callback, the mixer keeps filling the same buffer from the next ring, so not a single sample is lost.
- **Crossfade.** Uses equal-power curves. Skipped when the next track follows on from the same album.
- **Loop-aware sources** (libgme, vgmstream and libopenmpt report loop points):
  - *Album* (default): 2 loops, then a 10 s fade. This matches the usual convention for game-music rips.
  - *Endless*: loop until skipped.
  - *Custom*: N loops with a chosen fade length.

### 5.6 Loudness
- Measured with `ebur128`: integrated loudness, loudness range and true peak. Stored per source.
- Default target −16 LUFS (configurable).
- **Album mode** applies one gain to the whole album and is used automatically when the queue is playing an album in order. **Track mode** is used otherwise.
- **First play of an unmeasured track:** start at a provisional gain chosen by source type (YouTube audio is usually already near −14 LUFS; chiptune rips swing widely). The cached file arrives much faster than real time, so the full measurement usually finishes within 1–3 s. The gain then ramps to the measured value over 2 s.
- A 1.5 ms look-ahead true-peak limiter at −1 dBTP guards boosted quiet tracks. Chiptune rips are often extremely quiet or right at full scale.

### 5.7 Analysis
**Real time, per display frame:**
- 2048-point Hann-windowed FFT, folded into 96 log-spaced bands from 30 Hz to 16 kHz.
- Each band smoothed with a 15 ms attack and 180 ms release, which looks good on screen.
- RMS, peak, a 1024-sample waveform for the oscilloscope, and spectral-flux onsets.

**Offline, once the full file is available, stored in the DB:**
- **Beat grid:** onset-strength envelope, then tempo by autocorrelation and comb filter, then a dynamic-programming beat tracker (Ellis 2007). Output: BPM, beat times and a downbeat estimate. If confidence is low (ambient tracks, rubato), there's no grid and the UI reacts to the amplitude envelope only.
- **Kiai sections:** high-energy passages found by applying hysteresis to smoothed loudness and onset density. They drive "kiai mode" visuals (§7.3).
- **Energy curve:** 512 points, used to draw the seek bar as a density graph, like osu!'s song-progress graph.
- **Intensity ★:** an osu!-style difficulty rating (0–10) combining tempo, onset density, spectral flux and loudness. It's shown in osu!'s difficulty colours: a calm town theme rates around 1.4★ (blue), a final boss theme around 6.5★ (purple). It's also filterable (`intensity>5`).

### 5.8 Clock and sync
- The engine reports `audible_position = frames_rendered − output_latency`, together with the host timestamp from cpal's `OutputCallbackInfo`.
- The renderer extrapolates from that pair using `performance.now()`. Beat pulses therefore land on the beat you hear, even with Bluetooth latency.

### 5.9 Devices
- List and select output devices.
- Watch for changes to the system default device. On a change: fade out over 30 ms, rebuild the stream, fade back in. Playback position is preserved.
- Device buffer is about 40 ms; latency is compensated as in §5.8.

### 5.10 API exposed to TypeScript (napi)
```ts
engine.setCurrent(src: SourceSpec, opts?: { startMs?: number }): void
engine.setNext(src: SourceSpec | null): void          // preload for a gapless transition
engine.play() / pause() / seek(ms) / stop()
engine.preview(src: SourceSpec, startMs: number) / stopPreview()
engine.setVolume(db) / setLoopMode(mode) / setNormalization(cfg) / setCrossfade(sec)
engine.setOverlayFilter(active: boolean)
engine.listDevices() / setDevice(id | 'default')
engine.analyze(src): Promise<AnalysisResult>            // loudness, beats, kiai, energy, intensity
engine.download(src, destPath, tags): DownloadHandle    // progress events
engine.on('state' | 'advanced' | 'buffering' | 'error' | 'ended', cb)
engine.analysisRegion(): string                         // shared-memory name the renderer maps
```
`SourceSpec` = `{ kind: 'http' | 'file' | 'chip', url | path, headers?, formatHint?, loop?, subsong? }`

Also implemented: `inspectArchive(source)` (entries + playlist texts), `setVoiceMask`/`voiceCount` (chiptune channel muting), and `download(…, { renderFlac })`.

For progress bars, two cheap queries (about 1 µs each from JavaScript, polled only while something waits):
- `loadProgress('current' | 'preview')`: what a track's start or rebuffer waits on. It reports whether the source answered, its bytes in the stream cache (and whether the decoder needs the whole file first: chip formats, archive entries), decoded audio against what the voice waits for (200 ms to start, 750 ms after an underrun), and how long the reader has waited for bytes against its 8 s give-up. The audio thread only stores a few atomics on transitions.
- `cacheProgress(cacheKey)`: bytes of a source in the stream cache, e.g. a chiptune set being fetched for `inspectArchive`. A headless CLI (`ghost-cli`) exposes the same API from the terminal for testing (play a URL, render to WAV, dump analysis).

---

## 6. Sources and catalog

### 6.1 Provider interface (TypeScript)
```ts
interface Provider {
  id: string
  searchAlbums?(q: string): Promise<AlbumHit[]>
  getAlbum?(ref: string): Promise<AlbumDetail>              // tracks plus per-track locators
  findTrack?(t: CanonicalTrack): Promise<SourceCandidate[]> // search-based providers (YouTube, IA)
  resolveStream(locator: string): Promise<StreamInfo>       // url, headers, format, bitrate, expiresAt
}
```
The resolver asks each enabled provider in priority order and scores the candidates (§6.4). It returns a ranked `Source[]`. If the top source fails (404, decode error, stall longer than 8 s), the engine moves to the next one on its own.

### 6.2 Providers, in default priority order
1. **Local files.** Watched folders, matched to the catalog by tags and AcoustID.
2. **Chiptune rips.**
   - vgmrips.net VGM packs: always on. The crawl reads only `/packs/latest`.
   - joshw.info sets: opt-in, because its robots.txt disallows crawlers.

   Both are original-format files with real loop points, attached to their games.
3. **Bandcamp.** Indie composers, good quality, track data embedded as JSON in each page.
4. **KHInsider.** The main catalog source: a huge catalog with MP3 and often FLAC. It marks in-game rips ("gamerip") separately from official albums.
5. **Zophar's Domain.** About 19.5k game sets, each with per-track 320 kbps MP3 renders. That includes formats GHOST can't emulate (PSF/2SF/GSF/USF/3SF, PSP, Wii). Its rips join the KHInsider game of the same name, or become new games.
6. **Modland.**
   - One daily `allmods.zip` index lists loose SPC/NSF/GBS/VGM files, which GHOST plays with libgme: robots-clean original-hardware music for SNES, NES, Game Boy and the 8/16-bit Segas.
   - NSF/GBS song counts come from a 128-byte header read when the album is opened.
   - NSF folders named after musicians mix their own work with real rips, so those albums are only kept for games the catalog already knows.
   - HES/KSS (no song count) and SGC (no libgme player) aren't indexed.
7. **Internet Archive.**
   - The curated game-soundtrack collections are indexed: `folksoundomy_gamesoundtracks`, the game items of `hifidelity_soundtracks`, and game-tagged `hifidelity_potpourri` (about 3.8k albums).
   - Everything else is searched on demand ("Search online", beside Browse's search box). Each web source answers separately, and results list as they arrive.
8. **YouTube via yt-dlp.**
   - Universal fallback, searched on demand.
   - Prefer "Artist – Topic" channels (official distributor uploads).
   - Prefer m4a/AAC; use Opus only when it's the best available.
   - Full-OST videos with chapters are split into virtual tracks.
9. **SoundCloud via yt-dlp.** The very last resort, searched on demand.
   - yt-dlp can't search sets, so album-like hits are long uploads (split on timestamped descriptions) and one uploader's tracks of the game.
   - SoundCloud serves only HLS, so each track is downloaded once into a 1 GiB LRU cache before it plays.
10. **Rainwave**, for radio mode (later milestone).

Researched but not used (see `docs/research/sources-2026-10.md`):
- **VGMdb:** behind a Cloudflare challenge.
- **SNESmusic:** its robots.txt disallows the set downloads.
- **project2612:** dead.
- **gamesounds.xyz:** sound effects, not soundtracks.
- **Niconico and Bilibili:** search doesn't work from yt-dlp.

Quality preference is a setting: lossless when available / high (320 kbps) / data saver. Copies of the same release from several sources are ordered by the source priority.

### 6.3 Building the catalog
Two tiers, so the app is useful on day one and gets richer over time:

1. **Playable index (fast, full).**
   - Every index source (KHInsider, Zophar's Domain, Modland, the IA collections) has its own crawl, resumable page by page.
   - KHInsider runs first, alone, and builds the catalog.
   - Zophar's Domain and the IA collections then crawl together. They are different hosts, each paced politely on its own.
   - Modland follows them, because it keeps some albums only for games the others know.
   - The chiptune rip index runs last. Each source has its own refresh period, and disabled sources aren't crawled.
   - First-time setup is explicit. A notice names the sources being added and says it only happens once, and the Browse status line ("One-time setup · … · ~3 min left") opens per-source progress. Afterwards, refreshes are quiet.
   - Albums cluster into games by normalized title (§6.4), so a second source's copy joins the game the first created.
   - Track lists and file URLs are fetched lazily (album page first, track page at play time) and cached.
2. **Enrichment.**
   - **IGDB:** pull the whole game list (500 per request, about 4 requests a second, so minutes). Gives names, alternate names, platforms, franchises, covers and artwork.
   - **SteamGridDB:** hero images, logos and backgrounds.
   - **MusicBrainz** (later): release groups, ISRCs and AcoustID links. Its JSON API works from plain clients; VGMdb doesn't (Cloudflare).
   - **Wikidata** (later): cross-service ID mapping, so matching can use exact IDs instead of names.

Games with no album anywhere get a virtual album, "{game} — in-game", filled from rips and YouTube.

### 6.4 Matching and confidence
- **Normalize titles:** strip OST, Original Soundtrack, Original Sound Version, (Gamerip), platform tags and punctuation; use NFKC; add a romanized variant.
- **Album → game:** compare normalized names against IGDB names and alternate names, use year and platform as tie-breakers, and prefer an exact Wikidata or VGMdb ID link when one exists.
- **Candidate → canonical track score:**
  `0.45·title_similarity + 0.35·duration_fit(±2 s full credit, falls to zero at ±15 s) + 0.1·channel_trust + 0.1·quality`
  An AcoustID fingerprint match overrides everything.
- Candidates scoring below 0.6 are marked "unverified" in the UI. A manual "pick another source" menu is always available.

### 6.5 Data model (SQLite)
```
games(id, igdb_id, name, alt_names, year, platforms, franchise, cover, hero, logo, accent_rgb)
albums(id, game_id, title, title_original, kind[ost|gamerip|arrange|remix|single], year,
       catalog_no, vgmdb_id, mbid, khinsider_slug, cover)
tracks(id, album_id, disc, number, title, title_original, duration_ms, composers)
sources(id, track_id, provider, locator, format, bitrate, lossless, duration_ms,
        confidence, verified_at, failures)
analysis(source_id, lufs, lra, true_peak, bpm, beat_grid BLOB, kiai BLOB,
         energy BLOB, intensity)
playlists(id, name, kind[manual|smart], query, cover, created_at, updated_at)
playlist_items(playlist_id, pos, track_id)
likes(track_id, at) · history(track_id, played_at, ms_played) · downloads(track_id, path, format, at)
search_fts  -- FTS5 trigram index over game, album, track, composer and franchise names
```

---

## 7. Interface

### 7.1 Visual language
Inspired by osu!lazer, with its own identity. It doesn't reuse any osu! assets.

- **Palette:** a dark plum-navy base. Each overlay has its own hue: Browse pink, Library blue, Downloads green, Settings purple. The accent colour comes from the current game's art (a vibrant swatch), defaulting to pink `#ff66aa`.
- **Shear:** panels, wedges and footer buttons are skewed about 0.15 horizontally, with their contents un-skewed so text stays upright. This is lazer's signature.
- **Shapes:** 10 px corner radius. The selected panel gets an accent edge glow; hover brightens it and scales it to 1.02.
- **Background motif:** instead of osu!'s triangles, *drifting pixels*: soft rounded squares that rise slowly and pulse brighter on beats, drawn as a PixiJS particle field.
- **Typography:** a geometric sans plus a rounded Japanese companion (shortlist: Outfit or Lexend with M PLUS Rounded 1c). Tabular numerals for times.
- **Intensity colours:** osu!'s difficulty spectrum.

  | Stars | 0.1 | 1.25 | 2.0 | 2.5 | 3.3 | 4.2 | 4.9 | 5.8 | 6.7 | 7.7 | 9.0 |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | Colour | `#4290FB` | `#4FC0FF` | `#4FFFD5` | `#7CFF4F` | `#F6F05C` | `#FF8068` | `#FF4E6F` | `#C645B8` | `#6563DE` | `#18158E` | `#000000` |

### 7.2 Motion
- **Defaults:** OutQuint easing; 200 ms for hover, 300–500 ms for slides and screen transitions, OutElastic for "pop" confirmations.
- **Beat pulse:** scale 1.00 → 1.04 on each beat, decaying with OutQuint over about 80% of a beat. Downbeats are stronger.
- **Parallax:** background and wedges shift 2–3% with the mouse.
- **Screen transitions** are choreographed (elements leave in sequence, staggered 30–50 ms), never plain cross-fades.
- **Carousel:** spring-driven scrolling (critically damped, small overshoot on fling); panels sit on a gentle arc, as in osu!'s song select.
- All per-frame motion runs in a single rAF loop that writes `transform`/`opacity` only (compositor-friendly), and is paced to the display's refresh rate.
- **Progress:** every wait the user can notice shows a progress bar (`ui/ProgressBar`) that says what it waits on. A step is either measured (bytes, buffered audio, files read, sources answered), estimated (the bar eases toward the end over the step's typical length, learned per source, and never reaches it until the step ends) or unknown (a sweep). Bars never move backwards within one wait, and run as Web Animations, so they cost no JavaScript per frame. The player reports its waits in `PlayerState.loading` / `previewLoading` (finding a source → connecting → downloading or buffering, a stall's countdown to trying another source); long tasks send `progress` events keyed by what they belong to (`album:<id>`, `import:…`, `scan`, `tool:yt-dlp`).

### 7.3 Screens

**Title ("Press Start")**, the analogue of osu!'s main menu.
- A big disc logo in the centre with a radial spectrum ring, pulsing on beats.
- Clicking the logo (or pressing any key) slides out buttons: Browse · Library · Settings.
- The background is the current game's art, with parallax.
- Startup music: a random liked track, or a built-in theme.
- After 30 s idle, the buttons retract and the logo drifts (attract mode).

**Browse**, the analogue of song select and the core screen.
```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ◉ Home  Browse  Library          ⌕ composer=mitsuda intensity>4_      ⇩  ♪  21:04  ⚙ │
├───────────────────────────────────────────────────────────────────────────────┤
│ ╱▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔╱              ╱ Final Fantasy VI   1994 · SNES  ╱   │
│ ╱ [cover]  Battle with Magus╱           ╱ Chrono Trigger      1995 · SNES  ╱ ◀  │
│ ╱ Chrono Trigger OSV        ╱              ╱ Original Sound Version · 3 discs ╱ │
│ ╱ Yasunori Mitsuda          ╱                ╱ Peaceful Days          1.4★  ╱   │
│ ╱ 2:52 · 152 BPM · 6.2★     ╱                ╱ Battle with Magus      6.2★  ╱ ◀ │
│ ╱ FLAC · KHInsider          ╱                ╱ Corridors of Time      2.6★  ╱   │
│ ╱▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁╱              ╱ Arranged: The Brink of Time   ╱    │
│      blurred game art · parallax · drifting pixels    ╱ Chrono Cross 1999 ╱     │
├───────────────────────────────────────────────────────────────────────────────┤
│ ╱Random╱ ╱Add to queue╱ ╱Add to playlist╱ ╱Download╱                   ╱⋯╱ ╱Play╱ │
└───────────────────────────────────────────────────────────────────────────────┘
(values illustrative)
```
- **Carousel (right):** three levels, Game ▸ Albums ▸ Tracks, like osu!'s beatmap set ▸ difficulties. Track rows show length, an intensity badge, the source quality (FLAC / 320 / CHIP / YT) and a downloaded dot.
- **Info wedge (left):**
  - Cover, then title (romanized or original, toggled with Alt+J), composers, year, platform and catalog number.
  - Stats: length, BPM, intensity, loudness.
  - Which source will play.
- **Background:** the selected game's hero art, blurred and dimmed, cross-fading on every change of selection.
- **Browse previews:** when the selection rests on a game for 400 ms, its signature track starts from its preview point with a fade-in. If the queue is already playing, previews are opt-in (press P, or the Preview button on the cover). Only one song is ever audible: a preview pauses a playing queue (the engine fades one out as the other fades in) and resumes it when the preview ends, at its 30 s limit or when it is stopped. Playing, resuming or skipping in the queue, from anywhere, ends the preview. Otherwise the music changes as you browse, which is what makes osu!'s song select feel alive.
- **Search panel (top right):** the search box with its result count and a "Search online" button beside it (the web sources, for what isn't in the catalog), then group and sort, and "Filters": the search syntax (§7.6) as examples that add themselves when clicked.
- **Footer:** sheared buttons for the selection (Random, Add to queue, Add to playlist, Download), "More" (the selection's context menu) and Play.

**Play screen**, the analogue of osu!'s player screen.
- Enter on a track opens it:
  1. The wedge and carousel slide off.
  2. A **title card** (art, title, game, composer) holds for about 1.2 s. This hides the buffering time.
  3. The card slides into the bottom-left corner.
- Full-bleed art behind a visualizer layer. Visualizer modes: radial disc, spectrum skyline, oscilloscope, and per-channel scopes for chiptunes (one scope per hardware voice, with mute/solo; later milestone).
- **Kiai mode** during detected high-energy sections: stronger beat flashes, a burst of pixel particles, accent saturation turned up.
- Bottom seek bar draws the track's energy curve.
- Controls fade in on mouse movement and hide after 2 s of idle. Esc returns to Browse.

**Music controller overlay**, the analogue of osu!'s Now Playing overlay.
- Drops down from the toolbar on any screen: cover, title, seek bar, transport, shuffle/repeat/loop mode, volume.
- A drawer slides out with the queue (drag to reorder, "up next", history).

**Library overlay**, slides in from the right, blue hue.
- Tabs: Playlists · Liked · History · Downloaded.
- Playlist detail: drag to reorder, multi-select, play all, download all, export.
- Smart playlists show their query and can be edited.

**Downloads and notifications:** stacked progress cards on the right, osu!-style progress notifications.

**Settings overlay:** slides in from the left, with a sidebar of section icons.
- Audio: device, buffer, normalization, gapless/crossfade, loop mode, EQ, resampler quality.
- Sources: enable/disable and reorder providers, quality, yt-dlp updates.
- Library: download folder, naming template, cache size.
- Interface: UI scale, frame limiter, parallax, blur quality, original vs romanized titles, UI sounds.
- Key bindings.

**Toolbar** (always visible, auto-hides on the Play screen): Home · Browse · Library | search | downloads · notifications · music · clock · settings.

### 7.4 UI sound design
- **Soft synthesized cues:** hover tick, select chime, back swoosh, confirm. Tuned to one pentatonic set so they never clash with each other.
- Played around −18 dBFS on a separate UI bus that isn't normalized. Can be turned off.
- The overlay low-pass and ducking (§5.2) give opening an overlay a physical feel.

### 7.5 Keyboard
| Key | Action |
|---|---|
| ↑ ↓ / ← → | Move through the carousel / collapse and expand levels |
| Enter | Open the Play screen / expand |
| Esc | Back |
| Typing anywhere in Browse | Search (as in osu!) |
| Space | Play/pause |
| Ctrl+← / Ctrl+→ | Previous / next track |
| F2 / Shift+F2 | Random / back to the previous random pick (also right-click Random) |
| P | Preview selection |
| Q / Shift+Q | Add to queue / play next |
| Ctrl+S | Add to playlist |
| Ctrl+D | Download |
| Ctrl+Enter | Search online (for what's typed) |
| Ctrl+F | Focus the search box |
| Ctrl+L | Library |
| Ctrl+O | Settings |
| F6 | Music controller |
| Alt+J | Toggle original / romanized titles |
| ? | Keyboard shortcuts (every key, by screen; also in Settings → Interface) |

### 7.6 Search syntax
Free text plus `key op value` filters. Operators: `=` `!=` `>` `<` `>=` `<=`.
- Keys: `composer` `game` `franchise` `platform` `year` `length` `bpm` `intensity` `source` (flac|chip|yt|zophar|modland|…) `kind` (ost|gamerip|arrange) `liked` `downloaded`.
- Example: `boss platform=snes intensity>5 length<4m`
- A saved search is a smart playlist.

Spelling is forgiving (`src/main/catalog/aliases.ts`). Case, accents, apostrophes and punctuation don't matter, and `&` reads as "and". Each name is also indexed under extra spellings:
- Punctuation-joined runs: "yugioh" finds Yu-Gi-Oh!, "spiderman" finds Spider-Man.
- Word pairs run together: "megaman".
- Roman and arabic sequel numbers: "final fantasy 7" finds VII.
- Per-segment initialisms: "ff7", "kh2", "mgs3", "botw".

Results where every word is a whole word of the game's name rank first. Next come whole words of an album title, then substring matches; the chosen sort applies within each tier. A query that finds nothing offers "Did you mean …?": game names that share the query's rarer trigrams (from `fts5vocab`), re-ranked by trigram overlap, so typos like "kingdon hearts" still land on Kingdom Hearts. When the search-text format changes, `FTS_VERSION` rebuilds the index in the background, and `CLUSTER_VERSION` re-clusters games in the same way.

---

## 8. Milestones
| # | Name | Delivers |
|---|---|---|
| M0 | Foundations | Monorepo (electron-vite app plus Rust workspace), napi bridge, theme tokens, fonts, PixiJS background, toolbar shell, typed IPC |
| M1 | First sound | Engine core: cpal output, symphonia, sparse HTTP cache, transport, gapless, R128, analysis tap → UI. `engine-cli`. KHInsider provider. Minimal search → play. **Anything on KHInsider is playable** |
| M2 | Browse | Catalog DB plus KHInsider index crawl, IGDB and SteamGridDB enrichment, carousel, info wedge, backgrounds, search syntax, previews |
| M3 | Play | Play screen, title card, music controller overlay, visualizers, beat grid, kiai, intensity, energy seek bar |
| M4 | Library | Queue UI, playlists and smart playlists, likes, history, downloads plus tagging, session restore, settings overlay |
| M5 | Reach | YouTube/yt-dlp with match scoring and chapter splitting, Internet Archive, Bandcamp, local files, VGMdb/MusicBrainz enrichment, AcoustID |
| M6 | Chiptunes | libgme, vgmstream, libopenmpt, loop modes, render-to-FLAC, per-voice scopes |
| M7 | Polish | OS media integration, UI sounds, attract mode, 120 Hz performance pass, EQ, packaging (dmg / AppImage / NSIS), Linux and Windows checks |

---

## 9. Needed from the owner
| Item | When | Notes |
|---|---|---|
| Twitch developer app client ID and secret (IGDB) | M2 | dev.twitch.tv, free |
| SteamGridDB API key | M2 | steamgriddb.com profile, free |
| AcoustID application key | M5 | optional |
| Listening tests | every audio milestone | Audio is verified by measurement (gapless null tests, LUFS checks, timing logs), but ears are the final check |
| Linux and Windows runs | M7 | Development and verification happen on macOS |

---

## 10. Risks
- **Scraper breakage** (KHInsider markup, YouTube). Mitigation: each provider has fixture-based tests, the resolver falls back automatically, and yt-dlp updates itself.
- **YouTube anti-bot changes** (PO tokens, SABR streaming). Mitigation: rely on yt-dlp, and keep YouTube as the last resort rather than the main source.
- **Catalog matching errors.** Mitigation: confidence scores, an "unverified" badge, manual source override, exact ID links through Wikidata.
- **Electron + native addon packaging across three OSes.** Mitigation: napi-rs prebuilt targets, and CI builds added before M7.
- **Per-voice chiptune scopes cost CPU** (one emulator instance per voice). Mitigation: render only while visible, with a lower-rate analysis path.
