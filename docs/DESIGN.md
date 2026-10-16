# GHOST — design

**GHOST** = **G**ame **H**aven **OST**.

A desktop app for macOS, Linux and Windows that streams (and optionally downloads) video game soundtracks. It finds music the way ani-cli finds anime (type a name, get playback) and wraps that in a GUI that moves and feels like osu!.

Status: implemented (M0–M6 plus most of M7); see the [README](../README.md) to install it and [DEVELOPMENT.md](DEVELOPMENT.md) to build it. Last updated 2026-10-14.

---

## 1. Principles

1. **Music never glitches.** Audio runs on its own real-time thread in native code. A stalled UI frame can never cause an audio dropout.
2. **Motion is the interface.** Everything animates on purpose, using osu!-style ease-out-quint slides, beat pulses, shear and parallax. Target the display's refresh rate (120 Hz on ProMotion screens).
3. **Everything reacts to the music.** Visuals follow what you *hear*: the clock is compensated for output latency, so it tracks audible sound rather than decoded samples.
4. **Any game, best available source.** There is one canonical catalog. Each track has several possible sources, ranked, with automatic fallback when one fails.
5. **Keyboard first, mouse friendly.** Every action has a key, the way osu!'s song select does.
6. **Local and private.** All sources ship in the core app. There are no accounts, no servers of its own and no telemetry: everything GHOST knows lives on your computer.

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
- OS media integration: media keys, macOS Now Playing, MPRIS on Linux, SMTC on Windows. With no track or no known length, the OS seek range is cleared rather than left at the previous track's.
- Sleep timer, which fades out instead of cutting off.
- Session restore: queue, position and current screen.

### Library
- **Queue:** play now, play next, add to end, drag to reorder, clear, save as playlist.
- **Playlists:** create, rename, duplicate, delete, add/remove tracks, drag to reorder. Auto-generated cover mosaic from game art. Import and export M3U8/JSON.
  - M3U export writes a track's downloaded file, else the first source a plain player can open. A chapter of a long video, a file inside a chip archive or a sub-song needs GHOST's engine to address it: such tracks are left out (as a comment line) and the user is told how many, rather than written as the whole file.
  - Reorder and undo positions count only the tracks the playlist shows (rows no longer in the catalog keep their place).
- **Smart playlists:** a saved search query (see §7.6), for example `platform=snes intensity>5`. Duplicating one gives a hand-sortable playlist of its current tracks. An open one follows the catalog (it reloads on a catalog revision, throttled, and on re-entry once stale), and its rows play by track id, so the clicked track is the one that plays.
- Liked tracks, play history, recently played.
- Offline mode: plays downloaded tracks only.

### Downloads
- Download a track, an album, a playlist, or the queue.
- Saves the original stream as-is. Lossy audio is never re-encoded to lossy.
- Tags written with lofty: title, album, album artist (game), composer, disc and track numbers, year, embedded cover, ReplayGain values.
- Folder template, default: `~/Music/GHOST/{game}/{album} ({year})/{disc}-{track} {title}.{ext}`
- Chiptune formats: save the original file (NSF, SPC, …) and/or render it to FLAC with a chosen loop count and fade.
- Downloads overlay with progress, pause/resume, retry.
- One unfinished download per track: overlapping requests (a track, then its album) and retries of an old failed item don't queue it twice. Each engine attempt has its own id (`<download>:<n>`), so a canceled attempt's late events can't touch a retry, and the download's steps check after every wait that it is still the live attempt.
- The file name reflects the format written: what the engine renders (chip, tracker and game-engine formats, clips) is reserved as `.flac` from the start, and the path the engine reports when done is the one recorded. The engine claims the final name with an exclusive create and renames into that claim, numbering it `Name (n).ext` when taken, so two downloads never share a file and an existing file is never replaced.
- The Downloaded view prunes downloads whose file was deleted outside GHOST (only the exact entry it checked, if still current) and tells every view with one `library:changed`.
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
| Shell | **Electron** | Ships the same Chromium on all three OSes, so rendering behaves identically everywhere. Reliable 120 Hz `requestAnimationFrame`. Mature GPU compositing. A larger download is worth that consistency. |
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
  - Only the latest request to play something (album, tracks, playlist) replaces the queue, however long an earlier one takes to look up; pausing or playing while it's pending decides whether it starts. Browse numbers its own play requests the same way before they reach main.
  - `autoplay` is the transport intent: resuming sets it, pausing clears it, and a source fallback inherits it.
  - Skipping to the preloaded next track keeps the engine's `next`, so `setCurrent` promotes its decoded voice; any other load cancels it first.
  - A preview's hold on the paused queue moves to whatever replaces the held item, and a preview still fetching its track keeps the hold when the older one ends. Only user actions cancel a pending preview.
  - History measures each play against its own track's length (the decoder's once known). The failed-track streak that stops an unplayable queue resets only on audible playback.
- **The renderer never touches audio directly.** It sends commands and receives state, and reads analysis frames (spectrum, waveform, beat phase, audible clock) from a shared-memory triple buffer that the engine writes.
- **The engine lives in the main process, not the renderer.** A renderer reload or crash doesn't stop the music, and playback keeps going with the window closed.
- **GHOST updates itself** (`src/main/updates`). Not signed with vendor certificates, so the stock updaters are out (Squirrel.Mac checks the code signature of both versions). Instead:
  - It asks GitHub's latest-release API 20 s after every launch (out of startup's way), then every 24 hours by the wall clock while it stays open. A launch doesn't fetch again an installer whose download failed until that download's retry time.
  - It picks this system's installer from the release and checks the download against GitHub's own SHA-256 digest of the file (the release's `SHA256SUMS` when that's missing). It only downloads from GitHub.
  - Installing: on macOS, the app is copied out of the disk image and a small script swaps it in for the running bundle once GHOST has quit. On Windows, the NSIS installer runs silently (`/S --updated`). A Linux AppImage replaces its own file. A `.deb`, a read-only folder or a copy run from source only hears that a release is out.
  - With auto updates on (the default) a release downloads by itself and installs on quit or on "Restart to update". Off, the user is asked first and can dismiss a version.
  - A release counts as waiting only once it is fully prepared and checked (on macOS: the copied app's bundle id and version), and it is checked again at every launch. Each macOS release is staged in a folder of its own, and the previous one is removed only after the new one is recorded, so a failed preparation never damages a release already waiting. Installing on quit depends on that waiting release, not on what the updater is doing at the moment (a check for an even newer one may be running).
  - `state.json` is written by one queue, and a write that fails is logged, never left as a status stuck on "checking".
  - A failed download is tried again 2 hours later, then 4, doubling up to a day for the same release.
  - After an update, the changelog bundled in the app shows each version's section since the one last run.

---

## 5. Audio engine

### 5.1 Threads
| Thread | Job | Rules |
|---|---|---|
| Output callback (cpal) | Pull from the mixer, apply DSP, write to the device | No allocation, no locks, no I/O. Lock-free SPSC rings (`rtrb`) only. The stream is paused after 30 s with nothing playing and resumed by the next command. |
| Decode workers (one each for current, next and preview) | Decode, resample, fill a ~2 s ring | Blocking reads from the stream cache are fine here. |
| Analysis | FFT, band energies, onset flux. Publishes frames to a triple buffer | Fed by a tap on the output path, only while the window can be seen (the renderer reports it). |
| I/O (tokio) | HTTP range fetches into the chunk cache; downloads | |
| Background jobs | Full-file loudness and beat analysis, low priority | Runs faster than real time on cached files. |

### 5.2 Signal chain
```
source ─▶ decode ─▶ trim gapless padding ─▶ resample (rubato sinc, exact polyphase) ─▶ loop/fade stage
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
- A loudness measurement reads the stream while it plays, as a **background reader**: it never moves the prefetch window, and what it waits for is fetched only after that window, so it can't make playback stutter.
- If the server doesn't support Range, fill linearly from the start.
- Every response (the linear fill too, and the TLS handshake) is dropped after 15 s without a byte; the timer restarts with each byte, so a slow download that keeps sending is never cut off. The fetcher's request can be interrupted: a fresh URL for the same cache key (a re-resolved link), shutdown, or every reader gone past the idle grace stops a stalled response, and a new URL is fetched at once.
- If a URL expires (YouTube links are short-lived) and returns 403, re-resolve it through its provider and resume.
- If none of a track's sources play, ask the catalog once more without them: its fallback search (YouTube and the others) runs before the track is skipped. A server that didn't answer (a timeout, a stall) has its folder's other files tried last for 5 minutes: the rest of an album on it is looked up elsewhere first, and a preloaded next track waiting on it is preloaded again.
- The cache is evicted least-recently-used with a size cap (default 5 GB). Downloaded files are pinned elsewhere and never evicted.

### 5.4 Decoders
| Formats | Library |
|---|---|
| MP3, FLAC, AAC/M4A, ALAC, Vorbis, WAV, AIFF | symphonia (gapless mode on) |
| Opus (WebM/Ogg/MP4) | libopus (vendored), behind symphonia's demuxers; the source trims the pre-skip and pre-rolls 80 ms on seeks |
| NSF/NSFE, SPC, GBS, VGM/VGZ, HES, KSS, AY, SAP, GYM | libgme (game-music-emu) |
| ADX, HCA, BRSTM/BCSTM/BFSTM, FSB, Wwise WEM, and hundreds of other game-engine formats | libvgmstream |
| MOD/XM/IT/S3M/UMX (tracker music: Amiga, DOS, Unreal, Deus Ex) | libopenmpt |
| PSF/2SF/USF/GSF/SSF (PlayStation, DS, N64, GBA, Saturn) | later: highly_experimental, vio2sf, lazyusf2 |

As built: the C libraries live in `native/crates/ghost-formats` (vendored release tarballs under `native/vendor/`, compiled statically with the `cc` crate). Decoder choice: format hint → extension → magic bytes. Sources can address an `archiveEntry` inside a `.zip`/`.7z` (NEZPlug `.m3u` lines supply titles/lengths), a `subsong`, and a `clipStartMs`/`clipEndMs` range (chapters of full-OST videos). Chip/tracker/game-engine sources and clips download as loop-rendered FLAC. Sources report their speaker layout (a WAVE channel mask; the usual one for the channel count when the file has none), and multichannel audio is mixed to stereo by speaker position (front at full level, the rest at −3 dB on their side, LFE left out), so quad and 5.0 files keep every channel. libgme's silence detection stays on only for tracks the engine doesn't time (it's their only end); a timed track plays its quiet passages as written. vgmstream paths are made absolute so companion files (TXTH, `.lwav` pairs) resolve. Not built: vgmstream codecs needing FFmpeg/mpg123 (XMA, ATRAC, Switch Opus…), RAR `.rsn` sets, the PSF family.

### 5.5 Gapless, crossfade, loops
- **Gapless.** Once the main process calls `setNext`, the next source starts decoding into its own ring. When the current source runs out mid-callback, the mixer keeps filling the same buffer from the next ring, so not a single sample is lost.
- **Crossfade.** Uses equal-power curves. Skipped when the next track follows on from the same album. It starts only once the next voice can start: until then the current track plays on at full level and the overlap shrinks to what's left, and a next track that never gets ready makes it an ordinary end.
- **Buffering** means waiting for data while playback is requested: a paused track is never shown buffering (seeking while paused included), and a voice starts only when playback is requested, never during the pause fade.
- **Loop-aware sources** (libgme, vgmstream and libopenmpt report loop points):
  - *Album* (default): 2 loops, then a 10 s fade. This matches the usual convention for game-music rips.
  - *Endless*: loop until skipped.
  - *Custom*: N loops with a chosen fade length.
  - Changing the mode reaches the track that's playing: its decoder republishes its end and length (Endless has neither; a track already decoded to its old end restarts where it is heard). A finite plan whose fade start is already behind the track fades out from where the track is.

### 5.6 Loudness
- Measured with `ebur128`: integrated loudness, loudness range and true peak. Stored per source.
- Default target −16 LUFS (configurable).
- **Album mode** applies one gain to the whole album and is used automatically when the queue is playing an album in order. **Track mode** is used otherwise.
- **First play of an unmeasured track:**
  - It starts from the best guess at hand: its album's loudness when other tracks of the album are measured, else an assumed −12 LUFS (−4 dB at the default target).
  - The measurement starts with the track and reads the stream as it downloads (§5.3), so it ends about when the download does. A chapter of a long video is measured from its own bytes, within a second or two, without waiting for the whole video.
  - While it runs it reports the loudness so far about once a second. That may turn the track down at once (the part heard so far shows a loud track, not that the rest stays quiet), and it counts in full once it covers 3 minutes of audio (a long single-file soundtrack takes minutes to download).
  - The gain ramps to each new value over 2 s. A skipped track's measurement stops with it, unless its file is already in.
- **Previews** are measured too (a whole file once it's cached, a chapter at once), so a track you previewed starts its first real play at the right level.
- A 1.5 ms look-ahead true-peak limiter at −1 dBTP guards boosted quiet tracks. Chiptune rips are often extremely quiet or right at full scale.
- True peak includes the last few samples of a file (the interpolator is drained at the end). Audio below 4 kHz isn't analysed (the K-weighting filter has no stable form there): it reports its length and nothing else.

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
- The audible clock and `position()` describe the queue only. The analysis tap also stamps the preview playing in each block, and the live analysis follows the preview while no music advances (a preview with nothing else loaded animates the visualizer).
- Voice metadata (id, length, start) is kept for every live voice plus the 64 most recently retired ones (for the clock's lag), so browsing many previews can't evict the current track's.
- Stopping a preview that has run dry ends it at once (its last frames ramped down, the music duck lifted) and cancels its decoder: nothing of it sounds later.

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

Also implemented: `inspectArchive(source)` (entries, the head of each multi-song chip file, playlist texts), `setVoiceMask`/`voiceCount` (chiptune channel muting: up to 64 voices, a BigInt mask in main and the addon, a lowercase hex string in state and IPC), and `download(…, { renderFlac })`.

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
1. **Local files.** The user's music folders.
   - Each scan turns their albums into catalog albums of provider `local` (badge "Local"), grouped by album tag and album artist (and disc), by folder when untagged ("CD1"/"Disc 2" folders join their parent). They cluster into games like any album, so a local-only soundtrack is browsable and playable even offline. Tracks are keyed by file path; only changed albums are rewritten, an album with no files left is marked gone, and a retagged file keeps its track id.
   - Local files also stand in for matching tracks of other sources' albums, first in the default order. The candidate lookup takes the album's own files (exact title first) and same-titled files from elsewhere (closest length first), each capped at 500.
   - A folder or file that can't be read keeps what was known about it, and is reported as unavailable or incomplete.
2. **Chiptune rips.**
   - vgmrips.net VGM packs: always on. The crawl reads only `/packs/latest`.
   - joshw.info sets: opt-in, because its robots.txt disallows crawlers.

   Both are original-format files with real loop points, attached to their games.
   - A set's tracks: full playlists set the order, then one-song playlists and playable files no line covers. A song is an archive entry plus a sub-song: equal titles in different files (FM and PSG versions, revisions) are all kept, the later ones labelled with their file. Playlist lines resolve relative to the playlist's folder, then the set's root, then a file name only one entry has; the engine resolves them the same way.
   - A multi-song NSF, NSFE or GBS with no playlist lists every song (NSFE titles and lengths when it has them). HES and KSS headers have no meaningful song count, so such a file stays one track.
   - Turning joshw.info on or off takes effect at once; each source has its own index checkpoint, so one newly turned on is indexed even after a recent vgmrips pass.
3. **Bandcamp.** Indie composers, good quality, track data embedded as JSON in each page.
4. **KHInsider.** The main catalog source: a huge catalog with MP3 and often FLAC. It marks in-game rips ("gamerip") separately from official albums.
5. **Zophar's Domain.** About 19.5k game sets, each with per-track 320 kbps MP3 renders. That includes formats GHOST can't emulate (PSF/2SF/GSF/USF/3SF, PSP, Wii). Its rips join the KHInsider game of the same name, or become new games.
6. **Modland.**
   - One daily `allmods.zip` index lists loose SPC/NSF/GBS/VGM files, which GHOST plays with libgme: robots-clean original-hardware music for SNES, NES, Game Boy and the 8/16-bit Segas.
   - NSF/GBS song counts come from a 128-byte header read when the album is opened.
   - NSF folders named after musicians mix their own work with real rips, so those albums are only kept for games the catalog already knows.
   - HES/KSS (no song count) and SGC (no libgme player) aren't indexed.
   - Two composer folders' files of the same name are both kept unless they're the same size.
7. **Internet Archive.**
   - The curated game-soundtrack collections are indexed: `folksoundomy_gamesoundtracks`, the game items of `hifidelity_soundtracks`, and game-tagged `hifidelity_potpourri` (about 3.8k albums).
   - Everything else is searched on demand ("Search online", beside Browse's search box). Each web source answers separately, and results list as they arrive.
   - Its JSON APIs go through the app's request scheduler, in archive.org's turn with its covers.
   - As a fallback it offers only matches of confidence ≥ 0.5 whose length is between half and twice the track's (Bandcamp the same), never a cover, remix or another cut.
8. **YouTube via yt-dlp.**
   - Universal fallback, searched on demand.
   - Prefer "Artist – Topic" channels (official distributor uploads).
   - Prefer m4a/AAC; use Opus only when it's the best available.
   - Full-OST videos with chapters are split into virtual tracks.
   - yt-dlp runs as a process tree: its own process group on Unix (SIGTERM, then SIGKILL after 3 s), `taskkill /T /F` on Windows, tracked until the whole tree is gone, at quit too. Lookups batched into one run honour each caller's cancellation; the run stops only when nobody waits on it.
9. **SoundCloud via yt-dlp.** The very last resort, searched on demand.
   - yt-dlp can't search sets, so album-like hits are long uploads (split on timestamped descriptions) and one uploader's tracks of the game.
   - SoundCloud serves only HLS, so each track is downloaded once into a 1 GiB LRU cache before it plays. Unfinished downloads' leftovers count toward the cap and are swept at startup and after failures. A file that fails to play is downloaded again (once, for every chapter sharing it).
10. **Rainwave**, for radio mode (later milestone).

Researched but not used:
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
   - Sources are checked for a due refresh at launch and every 24 hours while the app stays open. The check follows the wall clock (read every 15 min), because timers stall while the Mac sleeps.
     - A source that comes due between checks waits for the next one. One queued behind a running crawl starts when that crawl ends.
     - Turning a source on in Settings starts its crawl at once. Turning one off stops its crawl, which resumes where it stopped when the source is turned back on.
   - First-time setup is explicit. A notice names the sources being added and says it only happens once, and the Browse status line ("One-time setup · … · ~3 min left") opens per-source progress. Afterwards, refreshes are quiet.
   - Albums cluster into games by normalized title (§6.4), so a second source's copy joins the game the first created.
   - Track lists and file URLs are fetched lazily (album page first, track page at play time) and cached.
     - Resting on a game fetches its albums' track lists in the background (two at a time, the newest game's only), so its track count and length are complete.
     - Each site gets its own request queue: what someone waits for goes before background work, newest first (scrolling past albums and stopping, the one stopped on is fetched next), then crawls and art in order.
     - Covers (`ghost-art://`) are cached once native processing has read them, or when they are a format only the browser reads (AVIF, SVG, BMP) within limits of their own (4 MB, 4096 px a side). Anything else (corrupt, over the size limits, not an image) is never served or cached, and its URL is left alone for 15 minutes.
     - One scheduler in the main process owns those queues, Retry-After pauses and block cooldowns for every page, cover and Internet Archive request. The catalog worker sends its requests to it over RPC with their priority, timeout, retries and an id for promotion (cancelling removes them from main's queue); its HTML cache and request sharing stay in the worker. Requests shared by several callers share only the network result: each caller applies its own stale-copy fallback, and a request every caller abandoned is never joined again.
   - Crawl progress is kept per source: pages of an unfinished crawl are never pruned, and only each source's latest finished crawl is kept, for estimates. A page that failed is recorded as a failure; resuming past it continues the section (its length comes from the crawl's other pages, or for page 1 from the previous crawl).
2. **Enrichment.**
   - **IGDB:** pull the whole game list (500 per request, about 4 requests a second, so minutes). Gives names, alternate names, platforms, franchises, covers and artwork.
   - **SteamGridDB:** hero images, logos and backgrounds.
   - Each service keeps its own error and back-off, tied to the keys they were made with. Editing a key retries at once with a fresh client, and an error clears after the service's next success.
   - **MusicBrainz** (later): release groups, ISRCs and AcoustID links. Its JSON API works from plain clients; VGMdb doesn't (Cloudflare).
   - **Wikidata** (later): cross-service ID mapping, so matching can use exact IDs instead of names.

Games with no album anywhere get a virtual album, "{game} — in-game", filled from rips and YouTube.

### 6.4 Matching and confidence
- **Normalize titles:** strip OST, Original Soundtrack, Original Sound Version, (Gamerip), platform tags and punctuation; use NFKC; add a romanized variant.
- **Album → game:** compare normalized names against IGDB names and alternate names, use year and platform as tie-breakers, and prefer an exact Wikidata or VGMdb ID link when one exists.
- **Candidate → canonical track score:**
  `0.45·title_similarity + 0.35·duration_fit(±2 s full credit, falls to zero at ±15 s) + 0.1·channel_trust + 0.1·quality`
  An AcoustID fingerprint match overrides everything.
- Candidates scoring below 0.6 are marked "unverified" in the UI. A manual "pick another source" menu is always available. The resolver never uses a candidate whose confidence isn't in (0, 1].
- **Numbers name different tracks:** when both titles carry numbers that disagree ("Boss Battle 1" / "Boss Battle 2", Roman or Arabic), they don't match. A leading track or upload number ("02 - Dirtmouth") and numbers inside the game or album name are decoration.

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
- An album's length, length sort key and intensity are derived from its stored, non-removed tracks only (learned lengths count, removed tracks don't), and its game is refreshed in the same transaction.
- A track's search document carries its album's titles and alternate titles and its game's names, alternate names and aliases. It is rewritten whenever the album changes game or the game's names change.
- A full re-cluster yields between chunks, so it compares each chunk against the albums' current values before writing: albums edited meanwhile are reassigned from what they are now. Deleting a game clears the reference of its gone albums (saved tracks then show no game rather than whichever game reuses the id).
- Grouped Browse results (platform, year, composer, franchise) are cached per query, keyed by the catalog revision and, for liked/downloaded filters, by SQLite's `data_version` (main writes those on its own connection). `bucketStaleMs` is their maximum age before a background recompute. Members of a group are paged (`catalog.groupAlbumPage`), so groups of any size can be scrolled to the end.

---

## 7. Interface

### 7.1 Visual language
Inspired by osu!lazer, with its own identity. It doesn't reuse any osu! assets.

- **Palette:** a dark plum-navy base. Each overlay has its own hue: Browse pink, Library blue, Downloads green, Settings purple. The accent colour comes from the current game's art (a vibrant swatch, from populated hue buckets only), defaulting to pink `#ff66aa`. Text on the accent (its "ink") is whichever of white and the dark ink contrasts more with it; tiles drawn in the ink run from the accent's light shade to the accent, never darker.
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
- **Reduce motion** stops decorative motion: no beat or kiai pulses, no rotation, still idle shimmer (the Title ring and the visualizers alike). The bars that follow the audio stay.
- **Beat source:** the voice you hear. A preview (set while the queue isn't playing) pulses from onset detection and its analysed tempo, not the paused queue track's beat grid; changing voice resets the timing.
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
  - Stats: length, BPM, intensity, loudness. A game's track count and length cover every album once their track lists are in (fetched as the selection rests); a "+" marks a total some albums are still missing from.
  - Which source will play.
- **Background:** the selected game's hero art, blurred and dimmed, cross-fading on every change of selection. Blur quality is part of the art's identity: changing it rebuilds the art on screen and cross-fades to it.
- **Browse previews:** when the selection rests on a game for 400 ms, its signature track starts from its preview point with a fade-in. If the queue is already playing, previews are opt-in (press P, or the Preview button on the cover). Only one song is ever audible: a preview pauses a playing queue (the engine fades one out as the other fades in) and resumes it when the preview ends, at its 30 s limit or when it is stopped. Playing, resuming or skipping in the queue, from anywhere, ends the preview. Otherwise the music changes as you browse, which is what makes osu!'s song select feel alive.
- **Enter, the search box's submit and the footer's Play** play the selection of the query as typed: they wait for that query's first page, then act once (or search online when nothing matches). Leaving Browse cancels a play still fetching its album.
- **Keeping up:** a catalog refresh follows the selected group by its key across pages; likes and downloads made anywhere patch Browse's cached tracks (the model listens for as long as it lives), and searches filtering on them refresh. An album list that failed to load says so ("Click to try again") instead of "No albums match", and is retried at once by a deliberate action.
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
- Controls fade in on mouse movement and hide after 3 s of idle. Esc returns to Browse.

**Music controller overlay**, the analogue of osu!'s Now Playing overlay.
- Drops down from the toolbar on any screen: cover, title, seek bar, transport, shuffle/repeat/loop mode, volume.
- A drawer slides out with the queue (drag to reorder, "up next", history), with a search field (/ or Ctrl+F) that filters by title, game, album or composer; Enter plays the picked result.

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
| / or Ctrl+F (queue open) | Search the queue |
| ? | Keyboard shortcuts (every key, by screen; also in Settings → Interface) |

- A key counts as typing by where it was pressed (the event's target), not by where focus is after the field's own handlers ran. Keys that go to an IME (composition, keyCode 229) are never shortcuts, and confirming a candidate with Enter doesn't submit.
- Enter and Space belong to a button, link or menu item focused from the keyboard; one that merely kept focus after a click is blurred and the key goes to the binding.
- A context menu opened from the keyboard starts on its first enabled item. Focus traps (dialogs, overlays) follow the real Tab order: no negative tabindex, nothing inert, hidden or disabled. Key handlers on rows ignore keys from controls inside the row (Enter on a queue row's × removes it).
- Settings text fields save after a pause, on blur and on Enter; Esc restores the saved value and drops the pending save.
- Live sliders (the seek bar) write their accessible value straight to the element: at once for the user's own changes, every second otherwise, every 5 s while focused.

### 7.6 Search syntax
Free text plus `key op value` filters. Operators: `=` `!=` `>` `<` `>=` `<=`.
- Keys: `composer` `game` `franchise` `platform` `year` `length` `bpm` `intensity` `source` (flac|chip|yt|zophar|modland|…) `kind` (ost|gamerip|arrange) `liked` `downloaded`.
- Example: `boss platform=snes intensity>5 length<4m`
- A saved search is a smart playlist.

`composer=` with one or two CJK characters or one Latin letter matches the same credits the full-text path does (per-track composers, else the album's). `source=lossy` counts resolved sources in a lossy format, not only advertised ones. A duration's precision follows its digits in every notation (`3:30.5` = `210.5s`).

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

## 9. Outside inputs
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
