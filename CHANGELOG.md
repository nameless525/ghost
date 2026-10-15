# Changelog

## 0.3.1 (2026-10-14)

### Fixed
- **A preview no longer plays over your music.** With a song paused, resting on a game in Browse previews it; resuming the song (Space, the toolbar, media keys) used to leave both playing. Now only one song is ever audible:
  - Playing, resuming or skipping in the queue, from anywhere, stops the preview.
  - Pressing P while music plays pauses the music for the preview and resumes it when the preview ends.
  - A late "preview ended" from the engine can no longer cancel a newer preview, and a preview that can't play stops the one it replaced.
- **Album track lists that fail to load** now say so ("Couldn’t load the tracks · Enter tries again") instead of loading forever.
- **Browse:** the "Search the web" offer no longer has track rows scrolling under its text.
- **Lists** (Library, queue) show a track that is still loading as loading, not as playing.

### Progress bars for every wait
Anything you wait on now shows a bar that says what it is waiting for. The bar is measured where the app can measure it, and otherwise estimated from how long that source usually takes, learning as you use it. It never moves backwards, and a wait that runs long keeps visibly moving. The bars run on the GPU compositor and cost nothing when nothing waits.
- **Starting a track:** the Play screen's title card, its seek bar, the toolbar's now-playing chip and the Now Playing panel show each step:
  - "Finding a source"
  - "Getting the stream from YouTube" or "Searching SoundCloud for this track"
  - "Connecting to KHInsider"
  - downloading a chiptune file (with MB)
  - buffering

  The title card stays while the track loads (up to 8 s).
- **Stalls mid-track:** "Buffering", and after a few seconds "Waiting for the network · Trying another source in 5 s".
- **Setting up YouTube support:** the one-time yt-dlp download shows its MB in a notice, the player and the bar. It used to be a silent 20 s wait.
- **Browse:**
  - Previews show "Loading preview" on the cover.
  - Enter, Q and Download on an album whose track list isn't loaded show their wait there too.
  - Track lists loading in the carousel get a progress line, with real MB for chiptune sets.
  - "Search elsewhere" shows one segment per source ("2 of 4 sources").
  - Imports show their progress on the row.
- **Settings:** adding a music folder shows the scan's progress ("120 of 900 files") and ends with what it found. Before, there was no feedback at all. The catalog bars use the same design.
- **Downloads:** items finding a source say so, and downloading an album from Browse shows a card at once.

### Faster
- The weekly yt-dlp self-update no longer occupies one of the two yt-dlp slots (for up to 5 minutes), so it can't delay YouTube and SoundCloud plays.
- Adding or removing a music folder starts the scan immediately instead of within 4 s.

## 0.3.0 (2026-10-14)

### Fixed
- **YouTube imports no longer stop with "8 tracks in a row couldn't be played (HTTP 403)".** Two causes:
  - YouTube links break after a while: they expire, are tied to your network address, and refuse requests past the first ~2 MB.
  - A refreshed link was handed back stale, and the player gave up on it.

  Now a refused link is fetched fresh and retried at the same spot, and so are its sibling tracks (chapters of the same video). The engine also requests YouTube in bounded chunks: open-ended requests were throttled to real time.
- **Albums a source lists but has no files for** (a few Zophar sets) disappear when opened, with a message, instead of silently playing nothing.
- **Track counts and lengths:** unknown values show "–", and partial sums show "+", instead of "0 tracks · 0:00".

### Indexing: faster, and explicit
- **Faster:** Zophar's Domain and the Internet Archive collections are indexed at the same time after KHInsider, and Modland after them. First-time setup of the new sources is about a third faster.
- **Explicit:**
  - A notice says which sources are being added, roughly how long it takes, and that it only happens once.
  - The Browse status line shows "One-time setup · Zophar's Domain · 42% · ~3 min left" and opens a per-source panel with progress and when each source next refreshes. Later refreshes are quiet.
  - Settings → Sources shows the same live state per source.

### Faster everywhere (full code review and performance pass; numbers in docs/perf/README.md)
- **Startup:** the first screen appears in about 40 ms instead of about 340 ms. React was holding every first screen and overlay back by 300 ms. The renderer bundle is less than half its old size.
- **Playback starts sooner:**
  - Uncached KHInsider: about 0.4 s, and less when you rest on a track first (its link is fetched ahead).
  - Zophar: under 1 s instead of about 6 s.
  - YouTube: late chapters start in a third of a second instead of nearly four.
  - Seeks are about twice as fast.
- **Search:** typical queries take 1–3 ms, 2–5× faster. Page parsing is 2–4× faster, and weekly catalog refreshes do about a tenth of the work.
- **Idle:** about 0% CPU and GPU when the window is unfocused and nothing is playing, and about half when focused. The main process and audio engine wake far less often. Memory stays flat over long sessions.
- **Audio engine:** about 15–40% less CPU while playing. Analysis memory is down from up to 2 GB to under 100 MB. Output is bit-identical.

### Robustness
- **Navigation lock:** the window can no longer be navigated away from the app, for example by dropping a file on it. Only web and mail links open externally.
- **Engine crashes:** a crash in an audio thread or a malformed chip-music file no longer takes the app down. Fuzzing found and fixed 12 memory-safety bugs in the emulators.
- **Quitting:** yt-dlp downloads are stopped when you quit, and the database is closed cleanly.
- **Interface fixes:** about 40, including:
  - ⌘←/→ in text fields skipping tracks.
  - Sliders hijacking the scroll wheel.
  - Toasts covering the notification centre.
  - "Add to playlist" being empty on first use.
  - Focus-trap fights between dialogs.
- **Other:** downloads retry a refreshed link on 403. The output-device list updates live. Unhandled errors show a message instead of failing silently.

## 0.2.0 (2026-10-14)

### New sources
The catalog grows from about 88,000 to about 93,000 games, and from 106,000 to 135,000 albums. The extra sources are indexed in the background after KHInsider, one at a time, each on its own refresh schedule. Turn any of them off in Settings → Sources.
- **Zophar's Domain:** per-track MP3 rips of about 19,500 games. That includes PlayStation, PS2, DS, GBA, N64, PSP and Saturn sets, which can't be emulated. Its rips join the KHInsider game of the same name, or add games KHInsider doesn't have (about 1,900 of them).
- **Modland:** original SNES (SPC), NES (NSF), Game Boy (GBS) and Sega (VGM) sound files, played by the chip engine with their real loop points.
- **Internet Archive:** the curated game-soundtrack collections, about 3,800 albums.
- **SoundCloud** joins "Search elsewhere" as a last resort, after YouTube. SoundCloud now serves only HLS streams, which the engine can't open, so each track is downloaded once (5–12 s) into a 1 GiB cache.

### Search
- **Forgiving spellings:**
  - Punctuation, accents and spaces don't matter: "yugioh" finds all of Yu-Gi-Oh!, "spiderman" finds Spider-Man.
  - Sequel numbers match either way ("final fantasy 7").
  - Initialisms work: "ff7", "kh2", "mgs3", "botw".
  - "&" and "and" are the same.
- **"Did you mean …?"** for typos: "kingdon hearts" finds Kingdom Hearts, "chrno triger" finds Chrono Trigger.
- **Better ranking:** results whose name contains every word you typed come first. "botw" lists Breath of the Wild before "Robot Wars"; "mother 3" lists Mother 3 before a Cave Story album that mentions it.
- **"ost", "soundtrack", "original" and similar words are optional** next to other words, so "chrono trigger ost" works.
- **Search elsewhere:**
  - Results list as each source answers instead of waiting for the slowest.
  - The results list scrolls, and stays above the footer instead of running under it.
  - Pressing Enter on a search with no results searches the web.

### Polish
- **Browse:**
  - Album rows show which source they come from.
  - Games without art get a placeholder.
  - When nothing matches, the left panel shows the query with search tips.
  - The carousel's top and bottom limits no longer come out wrong when measured mid-animation.
- **Overlays:**
  - Library, Settings and Downloads panels are opaque, so the screen behind no longer shows through.
  - Now Playing and queue alignment are fixed.
- **Title, Play and system controls:**
  - The title ring's spectrum bars and its "✦GAME" lettering are fixed.
  - The Play card handles long album names.
  - System Now Playing shows the cover art.
- **Accessibility:** focus rings are fixed, and history rows can be reached with the keyboard.
- **Imports:** track titles keep "Theme", "Music" and "Score" ("Frog's Theme" no longer becomes "Frog's").
- **Library:** albums found on several sources are ordered by your source priority.

### Under the hood
- One index crawl per source, each resumable page by page; the chiptune index runs after all of them.
- Existing catalogs rebuild their search index (about 10 s) and regroup games (about 4 s) once, in the background, on first launch.
- Saved source orders gain the new sources next to their default neighbours.
- The research behind the source choices is in `docs/research/sources-2026-10.md`.

## 0.1.0 (2026-10-14)
First release: the KHInsider catalog, the Rust audio engine, the osu!-style interface, and the jitter and performance pass.
