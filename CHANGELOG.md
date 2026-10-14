# Changelog

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
