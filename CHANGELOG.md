# Changelog

## 0.4.2 (2026-10-19)

### Fixes
- **No more UI sound at the start of every song in the queue.** On the Play screen, each new song's title card made a sound as it slid into the corner, about a second into the song. It now sounds only when you open the Play screen, not when the queue moves on to the next song.

## 0.4.1 (2026-10-16)

### Your music folders show up in Browse
- **Albums in the music folders you add now appear in Browse**, under their games and marked **Local**, and play from your files, even offline or before the catalog is built. Until now your files only stood in for tracks GHOST already knew from another source: a soundtrack it didn't know never showed up at all.
- Albums are grouped by their tags (album and album artist), or by folder for files without tags. An untagged rip split into "CD1" and "Disc 2" folders is one album with two discs. Retagging a file keeps its likes, playlists and history.
- Adding a folder shows an "Updating albums" step, and the "Added …" notice appears once the albums are in Browse.
- If a folder or drive can't be read during a rescan (permissions, a disconnected drive), GHOST no longer forgets the music in it, and tells you which folders it couldn't open.
- The right local file is found even among hundreds of tracks with the same name ("Main Theme").
- Local albums don't have cover art yet: GHOST doesn't read art embedded in files.

### Opus plays
- **Opus audio now plays and downloads:** local `.opus` files, and the Opus streams YouTube and SoundCloud offer. GHOST had no Opus decoder, so these failed with "unsupported codec". Internet Archive items with only Opus files are offered now too.

### Playback
- **Your latest choice wins.** Clicking a second album or playlist while the first is still loading can no longer be overridden when the first one finishes loading, in Browse or anywhere else. Pausing while it loads starts it paused.
- **Skipping to the next track starts right away,** using the audio GHOST had already buffered for it, instead of opening the file again.
- A track you resumed keeps playing when its source fails and a backup takes over (the backup used to start paused).
- Previewing songs one after another no longer cancels the newer preview or briefly resumes the queue. A preview that's still loading no longer cuts into music you resumed, and stops when you move to another album or change the search; pressing P again while it loads cancels it.
- Removing the current track during a preview plays the next one once the preview ends.
- A queue whose tracks open but never play stops after one round instead of retrying forever.
- History no longer counts a short listen because you skipped to a shorter track, and no longer misses a real listen to a short track when you skip to a longer one.
- **Tracker modules with more than 31 channels:** each of up to 64 channel pills mutes or solos exactly its own channel. Channel 32 used to unmute everything and channel 33 muted channel 1. A pill no longer shows a mute that didn't happen.
- **Surround files keep every speaker** when mixed to stereo. In quad and 5.0 files, one or two channels used to go silent.
- Chip tracks with long quiet passages no longer end early or skip their opening silence, and their loops stay on the beat.
- **Crossfade waits for the next song to be ready** instead of fading the current one out to silence when the next is still loading.
- **Changing the loop mode during a track** updates its length. Endless no longer crossfades or skips to the next track at the old length, and switching back from Endless fades the track out from where it is instead of stopping it dead.
- Seeking while paused no longer shows the track as loading, and pausing while it buffers shows Paused.
- Stopping a preview whose stream had stalled stops it at once: the music comes back to full volume and nothing of the preview plays later.
- The current song keeps its progress after you browse through many previews, and switching the output device no longer restarts it.
- Previews drive the visualizer even when nothing else has been played.
- A server that stalls no longer blocks retrying a track or fetching a fresh link for it. Slow connections that keep sending are never cut off.

### Browse and search
- **Pressing Enter right after typing a search plays what the search finds,** not the soundtrack that was selected before. If nothing matches, it searches online.
- Confirming a Japanese, Chinese or Korean input candidate with Enter no longer submits the search.
- **Groups with more than 1,000 albums** (a platform, a year) can be scrolled to the end. Their totals show a "+" until every album has loaded.
- Sorting platform, year, composer or franchise groups by **Length** orders them by running time (it sorted by album count), unknown lengths last.
- A soundtrack whose album list failed to load says so, with **Click to try again**, instead of "No albums match", and playing it tries again.
- Browse keeps your selected game while the catalog refreshes during indexing.
- Likes and downloads made in the Library or on the Play screen show in Browse at once, and searches like `liked=yes` update straight away, in grouped views too.
- Under Album grouping, an album whose tracks changed is refreshed when you come back to it.
- Searching a game's alternative or Japanese title finds its tracks too, including in smart playlists, and track search keeps up when an album moves to another game.
- `composer=光田` and other one- or two-character composer filters find per-track credits; `source=lossy` includes tracks whose resolved source is lossy; `length=3:30.5` matches the same tracks as `length=210.5s`.
- With a footer button focused from the keyboard, Enter presses that button instead of playing the selection.

### Downloads, playlists and the library
- **Two downloads can no longer end up as the same file.** Downloads GHOST converts to FLAC (chiptune and tracker formats, chapters of a long video) are named `.flac` from the start, and a name that's taken is never overwritten.
- Clicking Download twice quickly, or downloading a track and then its album, no longer downloads the track twice. Retrying an old failed download of a track that's already downloading or downloaded says so instead of making a copy.
- Canceling a download while it starts, or retrying it right after canceling, no longer leaves it stuck on "Downloading" (or still writes the file).
- When a downloaded file is deleted outside GHOST, the track can be downloaded again right away from Browse, and opening Downloaded no longer forgets a fresh re-download of a missing file.
- **Duplicating a smart playlist** gives a regular playlist of its current tracks that you can reorder, as its hint promised.
- Open smart playlists and their cards update as you like or download tracks and as the catalog grows, and clicking a row plays exactly the song you clicked.
- M3U export no longer writes a chapter of a long video, or a track inside a chiptune archive, as the whole file: it uses another source a plain player can open, or leaves the track out and tells you how many (download them to include them).
- In playlists with tracks no longer in the catalog, reordering and undoing a removal affect the right track. Deleting playlists down to five no longer leaves some hidden behind a filter you can't clear.
- Pressing Escape in the download naming template really cancels the edit (it was saved a moment later anyway).

### Sources
- **Fallback sources must actually be the track.** The Internet Archive and Bandcamp no longer stand in with a remix, a cover or another cut of the piece, and no source plays "Boss Battle 2" for "Boss Battle 1".
- **Chiptune rip sets list every song:** songs in bonus playlists, loose SPC and VGM files beside a playlist, every song of a multi-song NSF, NSFE or GBS file without a playlist (with NSFE titles), and same-titled songs from different files (FM and PSG versions, revisions), labelled with their file. Regional copies in different folders of a set each play their own file.
- Modland keeps different files of the same name from two composers' folders; titles like "01.Intro" keep their name and number; Internet Archive albums with some untagged files no longer show two tracks with the same number.
- A SoundCloud track whose cached file is broken is downloaded again instead of failing for good, and unfinished SoundCloud downloads no longer pile up outside the cache limit.
- Stopping or timing out a YouTube or SoundCloud lookup also ends the processes it started, at quit too.
- Pasting a malformed SoundCloud link no longer fails the search.

### Catalog
- **One request rate per site.** Browsing, indexing, cover art and Internet Archive lookups now share one politeness limit for each site, so GHOST stays within it even while indexing, and a site's "slow down" or bot check pauses all of them.
- Turning **Index joshw.info rip sets** on starts indexing right away (after a restart too), and turning it off stops its requests at once.
- A stopped catalog crawl no longer loses its progress when other sources finish theirs, and resuming no longer skips the rest of a section after a page that failed.
- A corrected IGDB secret or SteamGridDB key works at once, without a restart, and an enrichment error goes away once the service works again.
- Album and game lengths and intensities stay right after analysis or a refresh.
- Liked or downloaded tracks from albums a source removed no longer show an unrelated game's name and art.
- Albums titled "Music from X" or "A Jazz Tribute to X" join X.
- If the catalog can't start, Browse and album views say so instead of waiting forever.

### Updates
- **GHOST checks for a new release every time it starts**, about 20 seconds in so startup isn't slowed, as well as once a day while it stays open. It used to check at launch only when a day had passed since the last check.
- A failed attempt to prepare a newer update no longer damages one already downloaded, and an update is checked again after a restart before it's offered: a broken or incomplete one is never installed.
- Quitting installs a ready update even while GHOST is checking for (or downloading) an even newer one.
- After a failed update download GHOST tries again in about 2 hours, not a day (then 4 hours, and so on, up to a day). Starting GHOST again in the meantime doesn't download it again early; **Try again** does.
- An update download that hits a disk error fails cleanly and can be retried at once, and "Checking…" can no longer get stuck.

### Cover art
- Cover art that is corrupt or far too large is no longer shown or kept in the cache, and is tried again later. Broken covers already in the cache are fetched again.
- A cover whose download drops halfway is retried.
- Vivid red and orange covers no longer lose their accent colour.
- Changing blur quality updates the background art right away, with a cross-fade.

### Keyboard, screen readers and motion
- Pressing Enter on a queue song's remove (×) button removes it instead of playing it.
- Context menus opened from the keyboard start on the first item; pressing Enter right after opening one no longer does nothing.
- Tab stays inside Library, Settings and dialogs, and no longer gets stuck on hidden controls.
- Screen readers can read the seek bar's position.
- **Easier-to-read buttons:** text on the accent colour is dark wherever that reads better, for example on the default pink.
- Reduce motion also stills the Title screen's ring and the visualizers' idle shimmer.
- Previews pulse to the beat again after an analysed track has played.
- The system's Now Playing no longer shows the previous song's length for a song whose length isn't known yet.

### Analysis
- Peaks in a track's last few samples now count in its true-peak reading and its ReplayGain peak tag.
- Audio sampled below 4 kHz is reported as not analysed, instead of getting a broken, flat energy curve.
- Performance stats include cover-art processing.

### Engine
- Fixed a possible crash when a game-format file is asked for a sub-song it doesn't have.
- `ghost-cli render` and other offline renders no longer insert a short gap after a very short first track.

### After you update
The search index rebuilds and games are re-grouped once, in the background. The first scan of your music folders writes their albums, so they show up as recently added. Chiptune sets you've opened before gain their missing songs the next time they're refreshed.

## 0.4.0 (2026-10-15)

### GHOST updates itself
- **Once a day GHOST checks GitHub for a new release, and by default installs it for you.** It downloads in the background with a notice that names the version ("Updating GHOST to 0.4.1"), checks the download against its SHA-256 checksum, and installs it when you quit GHOST. To install it right away, choose **Restart to update** in the top bar.
- **Prefer to be asked?** Turn off **Install updates automatically** in Settings → About. GHOST then tells you when a new version is out and lets you update now or dismiss it. Settings → About also shows your version, when GHOST last checked, and a **Check now** button.
- **After an update, GHOST shows what's new** in the version you now have (and in any versions you skipped).
- The Mac app in Applications, the Windows installer's copy and the Linux AppImage update themselves. A `.deb` install is told about new releases and links to them, since replacing it needs administrator rights.
- This starts with 0.4.0: from 0.3.x, install 0.4.0 by hand once.

### Even volume from the first seconds, for imports too
GHOST measures each track's loudness the first time it plays and remembers it. Until then a track plays at a guess, and for some imports that guess lasted a long time.
- **Chapters of a long YouTube video are evened out within a second.** A soundtrack imported from one long video with chapters played each chapter at the guess until the whole video had downloaded: about 20 seconds on a fast connection, minutes on a slow one. Each chapter is now measured from its own audio as it arrives, usually within a second of starting.
- **Loud tracks are turned down while they download.** GHOST measures a track as it downloads, and turns it down as soon as the part heard so far shows it's loud, instead of after the last byte. Long single-file soundtracks (YouTube, Internet Archive) are evened out once a few minutes of them have been measured, seconds after they start, instead of after hundreds of megabytes.
- **A better guess.** A track not measured yet starts at its album's loudness when GHOST knows other tracks of the album, instead of the same fixed level for everything.
- **Previews in Browse are evened out too.** They used to play at the guess and were never measured. Now previewing a track measures it, so its first real play starts at the right volume.

### Browse fills in faster
- **A game's track count and length are complete.** They used to count only the albums you had opened, so a game showed "7+" or "38:00+" until you opened each one. Resting on a game now loads its albums' track lists in the background: a game with 8 albums is complete about 2 seconds later, one with 20 in about 2.5 s.
- **The album you stop on loads first.** Every album you passed while scrolling was fetched, one by one and in order, before the one you stopped on. Scrolling past 10 to 15 Zophar's Domain albums, the last one's tracks took 9 to 13 seconds to appear; now under a second. And holding an arrow key through album groups no longer opens every album it passes.
- While an album group's track list loads, the side panel no longer says it has 1 track.

### A source that's down no longer stops an album
- **When a track's own files can't be reached, GHOST looks elsewhere before skipping it.** It searches its other sources (YouTube and the rest) the way it does for a track with nothing to play, instead of moving on to the next track.
- **Once a server stops answering, the rest of the album isn't tried there first.** The next tracks are looked up elsewhere while the current one plays, so they start right away. For five minutes, that server's files are only a last resort.
- For example, an Internet Archive soundtrack whose only storage server was down used to wait 16 seconds on every track and then skip it. Now the first track plays from YouTube after that one wait, and the next ones start without any.
- **It always says when it does this.** While it looks, the loading line reads "Looking for a backup on YouTube · Internet Archive isn’t answering". When the backup plays, a notice names the track, what failed and where the copy comes from ("Internet Archive isn’t answering, so this is a backup copy from YouTube"). An album that falls back track after track updates one notice instead of adding a hundred. The track also carries an orange **Backup** badge, on the Play screen and in Now Playing, explaining the same when you hover it.

### YouTube starts sooner
- **The first YouTube track after launch plays about 4 seconds sooner** (about 6 s from click to sound instead of 10 for a track not looked up yet). GHOST ran yt-dlp once at every launch just to read its version, and the standalone yt-dlp takes seconds to start. A copy that has run before and hasn't changed since isn't checked again. The first online search after launch gains the same.
- A track you click no longer waits for the next ones GHOST looks up in the background at the same moment: they share one yt-dlp run, and each is ready as soon as yt-dlp has it.

### Lighter and faster
- **Covers show up while you scroll Browse.** After a random jump and a quick scroll, covers took 7 to 13 seconds to appear, because GHOST downloaded every one it passed, full size and all at once. Now it fetches what's on screen first, shows a small preview of each cover within about a second (the site's own thumbnail, a few KB) while the full one downloads, and fetches the covers just below where you stop before you get there. Small covers, like the album list's, come from those thumbnails instead of multi-megabyte scans.
- **Minimised or covered, GHOST stops drawing.** Music keeps playing, but a window nobody can see no longer redraws 30 times a second, and the engine stops computing the visualizer's spectrum. Listening with GHOST in the background used about 27% of a CPU core; it now uses under 3%.
- **Starts sooner.** The title screen appears about 335 ms after launch instead of 395 ms (340 ms instead of 430 ms on a first launch, before the graphics caches are warm). The window no longer waits for the audio system to start, and the animated background loads just after the first screen instead of before it.
- **Less memory.** The title screen's spinning logo took 63 MB of graphics memory because of how Chromium measures curved text; it now takes 4 MB. Full-size background art is released 10 seconds after leaving the Play screen, and the visualizer canvas no longer reserves depth and stencil buffers it never used (about 12 MB).
- **Smaller download.** The installers no longer carry Chromium's built-in text in 55 languages GHOST doesn't use, and the audio engine is built with whole-program optimisation. The macOS installer is 130 MB instead of 144 MB, and the app takes 263 MB on disk instead of 321 MB.
- **A cheaper audio path.** Resampling (for example 44.1 kHz music on a 48 kHz device) is now exact polyphase filtering, a fifth of the work it was with no loss in quality: the engine's CPU while playing an MP3 drops by about a quarter. After 30 seconds with nothing playing, GHOST pauses its audio output instead of streaming silence, so the system's audio service and Bluetooth headphones can rest.
- **Smoother on 120 Hz screens.** Listening without touching anything draws at 60 frames per second instead of 120 (full speed returns the moment you interact), and slowed-down animation no longer wastes a frame of work between drawn frames.
- **First catalog build:** games are re-grouped once at the end instead of after every source, and weekly refreshes no longer rewrite every unchanged album.
- Smaller things: the catalog starts about 50 ms sooner, the Downloaded view checks its files in parallel instead of one at a time on the main thread, the art cache is trimmed once a day instead of at every launch, IGDB enrichment steps are about 100 times cheaper, saving the session while playing no longer re-serialises the whole queue, and the spellchecker is off (Windows and Linux no longer download dictionaries for it).

### Fixes
- yt-dlp's state file is written atomically, so another part of the app reading it mid-write can't mistake it for a missing install and download yt-dlp again.
- The engine reports a stream's cache as complete even when the track ended first (the offline renderer used by `ghost-cli render` and the tests could outrun the download).

## 0.3.3 (2026-10-14)

### Open source
- GHOST is now on GitHub under the MIT License. Every release comes with installers for macOS (Apple Silicon), Windows and Linux.
- Every release runs the full test suite on macOS, Windows and Linux first, then opens each freshly built app on its own system to check that its window, catalog and audio engine come up. Nothing is published unless all of that passes.
- The Windows and Linux builds are new and haven't had much real-world use yet. If something doesn't work, please [open an issue](https://github.com/nameless525/ghost/issues).
- The requests GHOST sends to music sites now name the project page, so site owners can see what it is.

### Fixes
- The engine builds on Windows: its build script no longer trips over Windows paths and line endings.
- The engine's offline renderer (used by `ghost-cli render` and the tests) could stall for good after a stream was stopped mid-download, and could drop the error of a track that failed just as it ended. Playback in the app wasn't affected.

### Catalog refreshes while GHOST stays open
- Sources are checked for a due refresh every 24 hours while GHOST is open, as well as at launch. The check follows the clock on the wall, so a Mac that sleeps overnight doesn't push it back.
- Turning a source on in Settings starts adding it straight away instead of at the next launch. Turning one off stops its indexing, which picks up where it left off when you turn it back on.
- Catalog activity no longer shows a due source as "Up next" while nothing is running. It says "Refresh due · starts in about 5 h" (the next check), and "next in N days" counts to the check that will actually refresh it.

## 0.3.2 (2026-10-14)

### Search online, where you search
- **"Search online"** (formerly "Search elsewhere") is a button right beside the catalog search box instead of in the footer, where it was also hidden in windows narrower than 1280 px. With text typed it searches online for that text straight away (⌘↵ from anywhere in Browse). When few games match, it glows.
- In Browse, notices appear under the search panel instead of on top of the button.

### Search the queue
- The queue (on the Play screen and in Now Playing) has a search field.
  - It matches title, game, album and composer, ignoring case, accents and punctuation.
  - It highlights matches, shows how many tracks match on each tab, and offers to show matches that are in another tab.
  - Keys: / or ⌘F to search, ↑/↓ to pick, Enter to play, Esc to clear.
  - It stays instant on queues of thousands of tracks.

### Clearer for a first-time user
- **Browse:**
  - The footer reads Random · Add to queue · Add to playlist · Download · More · Play. "Rewind" moved into Random (right-click or Shift+F2).
  - The cryptic "try platform=snes…" chips became a **Filters** popover with plain examples that insert into the search.
  - Hovering explains:
    - "+" totals, BPM, intensity, loudness;
    - format badges and album kinds (OST, GAMERIP…);
    - the original-title line, which also toggles the titles.
  - "Era" is now "Released". The cover has a Preview button, and the Preview badge stops the preview.
  - Online results say "Strong / Good / Possible match" instead of a percentage.
- **Keyboard shortcuts sheet:** press ? anywhere, or open it from Settings → Interface.
- **One vocabulary everywhere:** menus read Play · Play next · Add to queue · Add to playlist · Like / Liked · Download. Shortcut hints only appear where the key really does that.
- **Title screen:** the menu is Browse, Library, Settings. The disabled "Radio · Coming soon" entry is gone.
- **Settings:** options are explained in plain words (normalization, gapless, crossfade, looping, quality…). The "Library" section is now "Downloads", and Re-index asks first.
- **Library and Downloads:**
  - Clearer empty states and tooltips.
  - A "Saved to <folder>" footer, and one "Clear finished" button.
  - Double-click plays a finished download.
- **Play screen:**
  - The loop-mode button only appears for tracks that have loop points, with a plain explanation.
  - Unanalysed tracks don't show an empty intensity badge.
  - Controls stay 3 s before hiding.
- **Fewer notices:** confirmations of things you just did ("Added to queue") pop up briefly but don't fill the notification centre.

### Fixed
- **Error dialogs from test builds:** a build started from another folder showed an "A JavaScript error occurred in the main process" dialog about the app icon. A missing icon is now harmless. Any other stray background error shows as a notice instead of a blocking system dialog.
- **First launch:** the "Setting up your catalog" notice was lost because it was sent before the window had loaded.
- **Composer credits:** some games listed "Arranged by" or "Arranged :" as their composers (credits mis-filed on the source page). Only composers are kept now, and existing albums are cleaned once.
- **Large UI scale (150%):**
  - Browse overlapped itself and cut off footer labels.
  - The catalog activity popover was misplaced.
  - The queue's "no matches" buttons were cut off.
- **Play screen:**
  - Focusing the queue search while the drawer slid in shifted the screen sideways.
  - An invisible pause button sat in the middle of the screen in the Skyline and Scope visualizers.
  - The Skyline visualizer drew over the chiptune channel strip.
- **Browse:**
  - A track list that failed to load said "Enter tries again" (Enter starts playback); it now retries on click.
  - A catalog read error showed "Your catalog is empty".
- **Notices:**
  - Undoing a playlist removal showed one notice per track.
  - Downloading a playlist showed two cards.
  - Downloading one track from a menu showed nothing.
  - A track still downloading was reported as "Already downloaded".
- **Menus** opened from controls at the bottom of the screen covered their own button.

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

## 0.1.0 (2026-10-14)
First release: the KHInsider catalog, the Rust audio engine, the osu!-style interface, and the jitter and performance pass.
