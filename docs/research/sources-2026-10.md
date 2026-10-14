# GHOST: additional music sources (research, 2026-10-14)

Scope: find primary-audio (full-length original game audio, not remixes) sources GHOST can **index into its
local catalog**, beyond KHInsider + vgmrips + joshw (opt-in) + search-time YouTube / Internet Archive / Bandcamp.
Everything below was probed from this machine on 2026-10-14 with plain `curl` / Node `fetch`
(UA `ghost-research/0.1`, or a Chrome UA where noted), using HEAD or `Range: bytes=0-1` for audio and at most
256 KB for any index file. Anything not checked directly is marked **unverified**.

Context from the local catalog (`~/Library/Application Support/GHOST/ghost.db`, read from a copy):
106,556 albums, of which 105,580 KHInsider, 974 chip, 2 YouTube. **70 albums already match Yu-Gi-Oh**
(68 KHInsider, from *Duel Monsters* GB 1998 to *Master Duel* / *Rush Duel*). So for Yu-Gi-Oh the gap is narrow;
see "Yu-Gi-Oh! test" at the end. (Side note: in that DB copy `album_fts MATCH '"yu gi oh"'` returns 70 rows but
`MATCH 'yugioh'` returns 0. The copy may predate the alias reindex, but the "yugioh" spelling is worth checking.)

GHOST's native decoders (from `native/crates/ghost-formats`): libgme (SPC, NSF/NSFE, GBS, HES, KSS, VGM/VGZ,
AY, SAP), libopenmpt (MOD/XM/IT/S3M…), vgmstream (ADX, BRSTM, HCA…), nezplug. **No PSF/PSF2/USF/GSF/2SF/3SF/
SSF/DSF/SID player.** That decides which chip archives are useful directly.

---

## Ranked verdicts

| # | Source | Verdict | Why |
|---|--------|---------|-----|
| 1 | **Zophar's Domain** (zophar.net/music) | **Catalog source (crawl)** | ~19.5k game sets / ~657k tracks, **per-track MP3 renders** of every set, including PSF/2SF/GSF/USF/3SF/PSP/Wii/X360 that GHOST can't emulate. No Cloudflare, no robots.txt, Range OK, Node fetch OK. 33 Yu-Gi-Oh sets. |
| 2 | **Modland** (ftp.modland.com) | **Catalog source (bulk index file)** | One daily `allmods.zip` (5.76 MB, about 516k files) lists everything. Loose SPC/NSF/GBS/HES/KSS/SGC/VGM files GHOST already plays. No robots.txt, Range OK. A robots-clean substitute for joshw's SPC/NSF/GBS. |
| 3 | **Internet Archive** (curated collections) | **Keep at search time, plus a small bulk index** | `folksoundomy_gamesoundtracks` (1,556 items), `hifidelity_soundtracks` (4,487, mixed film/TV/game), `gametracks` (2,816 single-BGM items, about 1,203 games). Per-file MP3, Range OK. Noisy outside these collections. |
| 4 | **MusicBrainz** (+ Cover Art Archive) | **Metadata only** | Open JSON API that works from plain clients; 94 "Yu-Gi-Oh" soundtrack release groups. Use it in place of VGMdb. |
| 5 | **SoundCloud** via yt-dlp `scsearch` | **Search-time last resort** | Works (Yu-Gi-Oh! Forbidden Memories OST tracks found). Uploader quality varies. |
| 6 | SNESmusic.org | Metadata only / skip | robots.txt disallows `/spcsets/` and `/v2/download.php`. RSN (RAR) sets. Use Modland's loose SPCs instead. |
| 7 | VGMdb / vgmdb.info | Skip | vgmdb.net returns a Cloudflare **managed challenge** (`cf-mitigated: challenge`) to curl. vgmdb.info refuses connections on 80 and 443. The hufman proxy needs a logged-in `cf_clearance` cookie. |
| 8 | Niconico / Bilibili via yt-dlp | Skip (for now) | `nicosearch` returned 0 entries. `bilisearch` returned HTTP 412. |
| — | VGMTreasureChest | n/a | This is **KHInsider's audio CDN**, not a separate site. The root returns "It's a secret to everybody." |
| — | gamesounds.xyz | Skip | Alive, but it is a Directory Lister of **sound-effect libraries** (Sonniss GDC 2015–2023 bundles, Kenney), not OSTs. |
| — | project2612.org | Dead | HTTPS returns Cloudflare 526. HTTP serves the default "Welcome to nginx!" page. Its content lives on in vgmrips. |
| — | hcs64.com | Skip | USF (N64) sets only. GHOST has no USF player. Zophar has MP3 renders of the same sets. |
| — | Sitting on Clouds | Skip | Album pages link out through `ouo.io` ad-gated shorteners to zips on external hosts. Not streamable. Has VGMdb links (metadata). |
| — | Squid-Board, VGMusic.com, OCRemix | Skip | A login-walled forum, fan MIDI sequences, and remixes. None is primary audio. |
| — | IA mega-items | Skip | Items such as `video-game-soundtracks-mp3` (87 GB, 330 zips), `VGM_Soundtracks`, `OST Collection N` (mostly anime), `vgmrips-all-of-them`, `adx-cri-adx` are single huge zips, so not streamable per track. |

Incidental finding about an existing source: **vgmrips.net now sits behind Anubis.** A browser-like UA
(`Mozilla/5.0 …`) gets the "Making sure you're not a bot!" interstitial. A non-browser UA
(GHOST's `GHOST/0.1 (personal video game soundtrack player)`) gets the real page (`/packs/` → 200, 35 KB). Keep the
honest UA for vgmrips; don't route it through Chromium/`net.fetch`. vgmrips robots.txt also says
`Disallow: /*.vgz$`, `/*.zip$`, `/*.mp3$`, `/packs/vgm`, `/packs/song`.

---

## 1. Zophar's Domain: https://www.zophar.net/music

**Alive, and big.** Each platform page prints `Found N games with M tracks!`. Totals collected on 2026-10-14:

| platform slug | games | tracks | | platform slug | games | tracks |
|---|---|---|---|---|---|---|
| nintendo-nes-nsf | 1968 | 46296 | | playstation-psf | 1260 | 38535 |
| nintendo-ds-2sf | 1892 | 56068 | | playstation2-psf2 | 1371 | 81138 |
| nintendo-snes-spc | 1639 | 36175 | | playstation3-psf3 | 441 | 39204 |
| gameboy-gbs | 1559 | 41615 | | playstation-portable-psp | 1460 | 68767 |
| nintendo-3ds-3sf | 798 | 39030 | | sega-dreamcast-dsf | 570 | 19899 |
| gameboy-advance-gsf | 717 | 22000 | | sega-saturn-ssf | 458 | 13082 |
| nintendo-gamecube-gcn | 302 | 14053 | | sega-mega-drive-genesis | 815 | 13799 |
| nintendo-wii | 316 | 18321 | | sega-game-gear-sgc | 257 | 19206 |
| nintendo-64-usf | 149 | 6825 | | sega-master-system-vgm | 250 | 2590 |
| turbografx-16-hes | 740 | 15115 | | xbox | 223 | 9297 |
| xbox-360 | 527 | 33000 | | amiga | 489 | 4907 |
| commodore-64 | 479 | 4198 | | pc-9801 | 201 | 4510 |
| arcade | 163 | 2655 | | x68000 | 147 | 2900 |
| ms-dos | 79 | 1351 | | pc-8801 | 42 | 831 |
| atari-st / atari-8bit / spectrum / windows / fm-towns / msx2 / sharp-x1 / cd-i | 40/28/37/28/14/15/15/2 | small | | | | |

**Sum: ≈19,491 games, ≈657,000 tracks.** (Slugs `2sf, psf, psf2, usf, nds, hes, kss, s98, wsr, hsvc` print no count; they look like aliases or empty categories.)

- **Content:** every set has (a) **per-track MP3s** rendered from the emulated rip (or native streams for
  PSP/Wii/X360/GC/Xbox), (b) a zip of all MP3s, and (c) a zip of the original EMU files. MP3s are about
  **320 kbps** (`psp_snddat_00000000.mp3` = 3,644,603 B for 1:31). Track names come from the rip tags. Some
  disc-dump sets have raw names like `psp_snddat_0000000A`.
- **Overlap with KHInsider:** high. I matched page 2 (200 titles) of 8 platform listings against local KHInsider
  titles with naive normalization. Not found: GBS 17, 3DS 21, DS 23, NES 25, PSP 25, PS2 27, Saturn 10, X360 35,
  i.e. about **5–17%** (some are false negatives from naming). Rough estimate: **1.5–3k games that KHInsider lacks**,
  plus a second stream URL for many KHInsider albums. Estimate only, not verified title by title.
- **Yu-Gi-Oh: yes, 33 sets.** `https://www.zophar.net/music/search?search=yu-gi-oh` returns, for example,
  `/music/playstation-psf/yu-gi-oh-forbidden-memories`, `/music/playstation-portable-psp/yu-gi-oh-gx-tag-force`,
  `/music/nintendo-ds-2sf/yu-gi-oh-duel-monsters-gx-card-almanac` (the last one is **not** in the local KHInsider catalog),
  `/music/gameboy-gbs/yu-gi-oh-dark-duel-stories`, `/music/nintendo-3ds-3sf/yu-gi-oh-zexal-world-duel-carnival`,
  `/music/playstation2-psf2/yu-gi-oh-the-duelists-of-the-roses`, `/music/nintendo-wii/yu-gi-oh-5ds-wheelie-breakers`.

**Access**
- `www.zophar.net`: `Server: Apache`, **no Cloudflare**. Plain curl and Node `fetch` both get 200. Five sequential
  listing pages took about 0.5 s each with no throttling seen. No rate-limit headers.
- **robots.txt: none.** `https://www.zophar.net/robots.txt` → `302 Location: https://www.zophar.net/` (homepage,
  which has `<meta name="robots" content="index, follow">`). `https://fi.zophar.net/robots.txt` → 404.
- Audio/cover host `fi.zophar.net`: nginx (Plesk). `Range: bytes=0-1` → **206**,
  `content-range: bytes 0-1/3644603`, `content-type: audio/mpeg`. Works with no UA, from curl and from Node `fetch`.

**Enumeration**
1. Platform slugs come from the `/music` page: `a[href^="/music/"]` whose path has one segment, excluding
   `letter/*, developer, publisher, year, popular, search`. Or hard-code the 36 slugs above.
2. Platform listing: `https://www.zophar.net/music/<platform>?page=N` (200 rows per page; SNES = 9 pages).
   - `p.found_stats` → "Found 1639 games with 36175 tracks!"
   - `.pagination p.counter` → "Page 1 of 9". `li.pagination-end a[href]` → `?page=9`
   - rows: `table#gamelist tr.regularrow, table#gamelist tr.regularrow_image`
     - `td.name > a[href]` → `/music/<platform>/<slug>` (album id = `<platform>/<slug>`)
     - `td.name span.alternative_names` → alternate (often Japanese) title
     - `td.year a` → year. `td.developer a` → developer
     - `td.image img[src]` → `https://fi.zophar.net/soundcovers/<platform>/thumbs_small/<x>.jpg` (only on `_image` rows)
   - Full crawl ≈ 100 listing pages + ≈19.5k album pages. At 1 req/s that is about 5.5 h; incremental after that.
3. Alternatives: `/music/letter/<A-Z|%23>`, `/music/search?search=<q>` (handy for on-demand lookups).

**Album page** (example `https://www.zophar.net/music/playstation-psf/yu-gi-oh-forbidden-memories`)
- `#music_info h2` → title ("Yu-Gi-Oh! - GX Tag Force")
- `#music_info p` → `span.infoname` / `span.infodata` pairs: `Alternative name:`, `Release date:` (with
  `a[href^="/music/year/"]`), `Console:`, `Developer:`, `Publisher:`, `Ripped by:`, `Tagged by:`
- `#music_cover img[src]` → `https://fi.zophar.net/soundcovers/playstation-psf/thumbs_large/ps1_yugiohforbiddenmemories.jpg`
  (empty `div` when there's no cover)
- `#mass_download a` → `…/<slug>/<rand>/<Title> (MP3).zophar.zip` ("Download all files as MP3 (207 MB)") and
  `…/<slug>/<Title> (EMU).zophar.zip`
- Tracks: `table#tracklist tr` (rows have class `regularrow trackrow` **or** just `regularrow`, so select on
  `td.download`): `td.number` (may be empty or "101."), `td.name`, `td.length` ("m:ss"),
  `td.download a[href]` → **direct MP3**:
  `https://fi.zophar.net/soundfiles/playstation-psf/yu-gi-oh-forbidden-memories/01.mp3`
  `https://fi.zophar.net/soundfiles/nintendo-snes-spc/chrono-trigger/101%20Presentiment.mp3`
- The same list also appears as inline JS: `mediaPath = 'https://fi.zophar.net/soundfiles/<platform>/<slug>/'` and
  `tracks = [{"track":0,"name":"…","length":"1:31","file":"psp_snddat_00000000.mp3"}, …]`.

**Verdict: integrate as catalog source #1.** No new decoder needed, since the MP3s stream through the existing pipeline.
Platform maps 1:1 from the slug. Good for the PSF/2SF/GSF/USF/PSP families that GHOST can't emulate. Dedupe
against KHInsider by (normalized title, platform). When both exist, prefer KHInsider for official OSTs and keep Zophar as an
alternate stream.

---

## 2. Modland: https://ftp.modland.com/pub/modules/

- **Alive.** `readme_welcome.txt`: "Currently there are 516161 modules online in 409 different formats". Mostly
  tracker/demoscene, but it has game-music format trees, laid out as `Format/Composer/Game/files` or `Format/Composer/file`:
  - `Nintendo SPC/` (587 composer dirs; `- unknown/` alone has 426 game dirs), loose `.spc` per track, e.g.
    `Nintendo SPC/Yasunori Mitsuda/Chrono Trigger/`
  - `Nintendo Sound Format/<composer>/<game>.nsf` (541 dirs), `Gameboy Sound System/<composer>/<game>.gbs` (153),
    `HES/` (95), `KSS/` (16), `SGC/` (104), `AY Emul`/`AY STRC`, `Slight Atari Player`,
    `Video Game Music/<system>/<composer>/<game>/` (Mega Drive, SMS, Game Gear, 32X, Mega CD, MSX, X68000, …)
  - also PSF/PSF2/USF/2SF/SSF/DSF/GSF trees (`Playstation Sound Format/- unknown/Yu-Gi-Oh - Forbidden Memories/01.psf …`),
    which GHOST can't play today.
- **Access:** nginx (Ubuntu), autoindex HTML, **no robots.txt (404)**, no Cloudflare. Mirrors (`/mirrors.txt`):
  `modland.antarctica.no` (http), ftp mirrors at amigascne and exotica.
- **Enumeration, one file:** `https://ftp.modland.com/allmods.zip` (5,760,668 B, regenerated daily; dated
  2026-Oct-14 20:01). It holds a single deflate entry `allmods.txt` (30,860,371 B). Each line is
  `<size>\t<path relative to /pub/modules/>`, e.g. `259547\tAce Tracker/505/bekiffte maschinen.am`.
  (Verified by inflating the first 256 KB with a Range request.) Filter on the first path segment.
- **Audio:** direct file URL = `https://ftp.modland.com/pub/modules/` + URL-encoded path. `Range: bytes=0-1` →
  **206** (`Content-Range: bytes 0-1/66096`), CORS headers present.
- **Yu-Gi-Oh:** only the PSF set above (unplayable). GBS sets unverified (needs the full index).
- **Verdict: catalog source.** Cheap: one 5.8 MB download a day, then files fetched on play. Value: SNES SPC (vgmrips
  has none, and joshw is opt-in because its robots.txt disallows bots), plus NSF/GBS/HES/KSS/SGC with no robots
  conflict. Metadata is thin: title comes from the folder or file name, composer from the parent dir, platform from
  the format. Merge with joshw/vgmrips by (normalized game, system). Composer dirs duplicate co-composed games
  (`coop-…` dirs), so dedupe.

---

## 3. Internet Archive: curated game-music collections

Collection sizes (from `advancedsearch.php`, `numFound`):

| identifier | items | content |
|---|---|---|
| `hifidelity_soundtracks` | 4,487 | mixed film/TV/**game** albums; ≈1,130 match `title:game OR subject:game OR subject:"video game" OR title:OST OR subject:vgm` |
| `gametracks` ("Game Tracks: Ripped and Lifted Soundtracks from Games") | 2,816 | **one BGM per item**, titled `« Game» Track ( Publisher, Year, Platform)`, ≈1,203 distinct games |
| `folksoundomy_gamesoundtracks` | 1,556 | game OST albums (gamerips and official), e.g. `MediEvil1998GameripSoundtrack` |
| `anime-soundtracks` / `anime_audio` | 2,294 / 777 | anime (not game) |
| `tvtunes` | 31,716 | TV/anime theme snippets (the source of most Yu-Gi-Oh noise) |

Wider query slices are noisy. For example `mediatype:audio AND (subject:"video game music" OR subject:VGM OR subject:OST …)` gives
16,208 items, many of them podcasts.

**Yu-Gi-Oh:** `Yu-Gi-Oh! Forbidden Memories Soundtrack` (folksoundomy_gamesoundtracks),
`yu-gi-oh-forbidden-memories-remastered-25th-anniversary` (hifidelity_potpourri), 3 Monster Capsule GB BGMs
(gametracks). Most of the 342 audio hits for "yu-gi-oh" are podcasts or tvtunes.

**Access / enumeration**
- `advancedsearch.php?q=collection:<id>&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=date&fl[]=subject&rows=1000&page=N&output=json` works (paging verified up to `start=4000`).
- **Scrape API quirk (verified 2026-10-14):** `https://archive.org/services/search/v1/scrape?q=collection%3Agametracks&fields=…&count=10000`
  works **only when `fields` lists ≥3 fields (or includes `collection`)**. With `fields=identifier` or `fields=identifier,title`
  the `q` is ignored and it returns the whole index (total 5,455,065 or 58,480,655). With `fields=identifier,title,date`:
  total 2,816, all matching. Check against `&total_only=true` (`{"items":[],"count":0,"total":2816}`). `count` up to 10000
  returns everything in one page for these collections; above that, use `cursor`. `scope=all` → "not authorized" for guests.
- Item files: `https://archive.org/metadata/<id>` → `files[]` with `name`, `format` (`VBR MP3`, `Flac`, `WAVE`), `length`,
  `title`, `track`. Stream: `https://archive.org/download/<id>/<urlencoded name>` → 302 to `dnXXXX.*.archive.org`,
  Range → **206** `audio/mpeg`. Cover: `https://archive.org/services/img/<id>` (200 `image/jpeg`).
- **Verdict:** keep the existing per-query search. Optionally bulk-index `folksoundomy_gamesoundtracks` and the game-filtered
  `hifidelity_soundtracks` (≈2.7k albums total; three scrape calls), with file lists fetched lazily from `/metadata/<id>` on open.
  `gametracks` is low value (single tracks; most are probably already in KHInsider).

---

## 4. MusicBrainz (metadata in place of VGMdb)

- `https://musicbrainz.org/ws/2/release-group/?query=releasegroup:yu-gi-oh%20AND%20secondarytype:soundtrack&fmt=json`
  → `count: 94` (e.g. *Yu-Gi-Oh! - Duelist of the Roses*, *Forbidden Memories Remastered: 25th Anniversary*, *Music to Duel By*).
  Plain client OK. Requires a descriptive UA; limit 1 req/s. Cover art via `https://coverartarchive.org/release-group/<mbid>`
  (CAA not probed: **unverified**).
- **Verdict: metadata only.** Composer, catalog number, and release dates to enrich KHInsider/Zophar albums. Not an audio source.

## 5. VGMdb (vgmdb.net, vgmdb.info)

- `https://vgmdb.net/` and `/robots.txt` → **403 `cf-mitigated: challenge`** ("Just a moment…"). robots.txt can't be read
  without a browser. WebFetch also gets 403. `media.vgm.io` cover path → 403 (path not confirmed).
- `vgmdb.info` (hufman's JSON proxy, `?format=json`): DNS resolves (192.9.238.96) but **connection refused on 443 and 80**.
  The proxy's README says that since VGMdb added Cloudflare it needs `USER_COOKIE` from a logged-in browser (`cf_clearance`, `vgmsessionhash`).
- **Verdict: skip.** Passing that challenge would mean borrowing a browser's clearance cookie. Use MusicBrainz for metadata.

## 6. SNESmusic.org

- Alive: 1,519 SPC sets / 2,631 games in its DB. Listing: `https://www.snesmusic.org/v2/select.php?view=sets&char=<A-Z|n1-9>&limit=0`.
  Set page: `profile.php?profile=set&selected=<id>` (composer, developer, publisher, release date, dumper, track count).
- robots.txt (quoted): `Disallow: /spcsets/`, `Disallow: /v2/download.php`, `Disallow: /covers/`, `Disallow: /tracklists/`, `Disallow: *.rsn`.
  Downloads are `download.php?spcNow=<code>` → RSN (RAR of SPCs).
- No Yu-Gi-Oh (no SNES Yu-Gi-Oh game exists). Its sister archives `/cmh/` (Console Music History, currently NES 1983–86 timeline)
  and `/pmh/` are small.
- **Verdict: metadata only / skip.** The audio is robots-disallowed. The same SPCs are on Modland as loose files.

## 7. yt-dlp extra extractors (GHOST's `yt-dlp_macos` 2026.08.19)

- `scsearch3:yu-gi-oh forbidden memories ost` → 3 tracks (`https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A1071428926`, …,
  durations 116–143 s). **Works.**
- `nicosearch3:遊戯王` / `nicosearchdate3:遊戯王 BGM` → `playlist_count: 0` (no error, no results; may be geo or API change; **unverified why**).
- `bilisearch3:游戏王 OST` → `HTTP Error 412: Precondition Failed`.
- **Verdict:** add SoundCloud as a final fallback after YouTube. Skip Niconico and Bilibili until they return results.

## 8. Other candidates checked

- **VGMTreasureChest** (`vgmtreasurechest.com`): Cloudflare-fronted; root body is `It's a secret to everybody.`. This is KHInsider's
  audio CDN (`*.vgmtreasurechest.com`, Range-capable), not a catalog.
- **gamesounds.xyz**: Directory Lister. Root dirs: `Kenney's Sound Pack`, `Sonniss.com - GDC 2015 … 2021-2023 - Game Audio Bundle`.
  robots.txt contains only Cloudflare content-signal comments. These are SFX libraries, so skip.
- **project2612.org**: `https://` → 526, `http://` → default nginx page, `/list.php` → 404. Dead.
- **hcs64.com**: alive (`/files/` index, `/usf/`), USF-focused. GHOST can't play USF. Skip.
- **Sitting on Clouds** (`sittingonclouds.net`, Astro site): `/album/<id>`, `/game/list`, `/platform/list`. Downloads are `ouo.io` ad-gated
  shortlinks to external zips. No robots.txt (it serves the homepage). Skip as audio. Each album links to its VGMdb id.
- **IA mirrors of rip sites**: `snesmusic.org-cmh-pmh-music-archive` (1 zip, 17 GB), `vgmrips-all-of-them` (1 zip),
  `adx-cri-adx` (Saturn, 803 zips, 117 GB), `falconk_archivebot_vgmrips_net_*` (WARCs). Not streamable per track.
- **HVSC / SID**: alive (`hvsc.c64.org`). Only useful if GHOST adds libsidplayfp. Out of scope.
- **SMS Power VGMs**: alive. Already covered by vgmrips.

---

## Yu-Gi-Oh! test (summary)

| source | Yu-Gi-Oh coverage |
|---|---|
| KHInsider (already indexed) | 68 albums locally, from GB *Duel Monsters* (1998) through *Master Duel*, *Cross Duel*, *Rush Duel* |
| Zophar | 33 sets. Adds *GX Card Almanac* (DS); the rest overlap KHInsider but are alternate streams |
| Modland | *Forbidden Memories* PSF (unplayable). GBS unverified |
| Internet Archive | *Forbidden Memories* OST, *FM Remastered 25th*, 3 Monster Capsule GB BGMs. The rest is anime themes and podcasts |
| SoundCloud | Forbidden Memories OST tracks |
| MusicBrainz | 94 soundtrack release groups (metadata) |

Titles none of the new sources clearly add (by title search; **unverified** exhaustively): *Duel Monsters III* (GB),
*Duel Monsters 7* (GBA), *GX Tag Force Evolution* (PS2), *ZEXAL Clash! Duel Carnival* (3DS). Those probably still need the
YouTube fallback, or joshw (opt-in) for GB/GBA rips.

Since KHInsider already covers most Yu-Gi-Oh games, a Yu-Gi-Oh "failure" is more likely a matching or ranking problem than
a missing source. Check the `yugioh` alias in the FTS index (see the note at the top).
