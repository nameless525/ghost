// Real smoke test of the chiptune rip workstream: crawls ONE joshw.info listing page (SPC, letter
// C), matches Chrono Trigger to the game a KHInsider search put in the catalog, opens its chip album
// (the engine fetches and lists the .7z), plays a track through the real player and engine for a
// few seconds, checks that the sound-chip voices arrive in PlayerState and toggles a voice mask.
// Everything lands in a temp userData dir (GHOST_SMOKE_DIR reuses one).
//
// Other sets: GHOST_CHIP_HOST=nsf.joshw.info GHOST_CHIP_PAGE=/m/ GHOST_CHIP_GAME="Mega Man 2";
// GHOST_CHIP_HOST=vgmrips.net GHOST_CHIP_GAME="Dinosaur" reads vgmrips' first pack-list page.
//
//   npx esbuild scripts/chip-smoke.ts --bundle --platform=node --format=esm --external:electron \
//     --outfile=/tmp/ghost-smoke/chip-smoke.mjs \
//     "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
//   GHOST_NATIVE_ADDON=$PWD/native/dist/ghost.node npx electron /tmp/ghost-smoke/chip-smoke.mjs
import { app } from 'electron'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatalogRepo } from '../src/main/catalog/repo'
import { createCatalogService } from '../src/main/catalog/service'
import { openDb } from '../src/main/db'
import { loadEngine } from '../src/main/engine/native'
import { createLibrary } from '../src/main/library'
import { createHttpClient } from '../src/main/net/http'
import { setSharedHttp } from '../src/main/net/shared'
import { Player } from '../src/main/player'
import { KhinsiderProvider } from '../src/main/providers/khinsider'
import { applyEngineSettings } from '../src/main/settings'
import { defaultSettings } from '../src/shared/defaults'
import type { PlayerState } from '../src/shared/types'

const tmp = process.env.GHOST_SMOKE_DIR || mkdtempSync(join(tmpdir(), 'ghost-chip-smoke-'))
mkdirSync(tmp, { recursive: true })
app.setPath('userData', tmp)
const HOST = process.env.GHOST_CHIP_HOST || 'spc.joshw.info'
const PAGE = process.env.GHOST_CHIP_PAGE || '/c/'
const GAME = process.env.GHOST_CHIP_GAME || 'Chrono Trigger'
const TRACK = Number(process.env.GHOST_CHIP_TRACK ?? 3)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (...a: unknown[]) => console.log('[chip-smoke]', ...a)
const out: Record<string, unknown> = { tmp }

async function until<T>(what: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms: number): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(200)
  }
}

app.whenReady().then(async () => {
  let shutdown = () => {}
  try {
    const http = createHttpClient({ cacheDir: join(tmp, 'html'), log: (m) => log(`[http] ${m}`) })
    setSharedHttp(http)
    const db = openDb(join(tmp, 'ghost.db'))
    const settings = defaultSettings(join(tmp, 'downloads'))
    const engine = loadEngine({ cacheDir: join(tmp, 'cache'), cacheMaxBytes: 2e9, userAgent: 'GHOST/0.1' })
    applyEngineSettings(engine, settings, null)

    // 1. The game as the main index knows it (one KHInsider search instead of a full crawl).
    let t0 = Date.now()
    const repo0 = new CatalogRepo(db)
    const kh = (await new KhinsiderProvider(http).searchAlbums(GAME.toLowerCase(), { priority: 0 })).filter((h) => h.title.toLowerCase().includes(GAME.toLowerCase()))
    repo0.assignGames(repo0.upsertHits(kh, { initial: true }))
    const khGame = repo0.get<{ id: number; name: string }>(`SELECT g.id, g.name FROM games g WHERE g.norm_key = ?`, GAME.toLowerCase())
    out.khinsider = { ms: Date.now() - t0, albums: kh.length, titles: kh.slice(0, 6).map((h) => h.title), game: khGame ?? null }

    // 2. The chip index: one listing page of one format.
    const broadcast = ((event: string, payload: unknown) => {
      if (event === 'player:state') onState(payload as PlayerState)
    }) as never
    const catalog = createCatalogService(
      { db, broadcast, getSettings: () => settings, inspectArchive: (s) => engine.inspectArchive!(s) },
      {
        http,
        disableEnrichment: true,
        disableLocalScan: true,
        startDelayMs: 0,
        crawlSections: [],
        chip: HOST === 'vgmrips.net' ? { hosts: [], vgmrips: true, maxPages: 1, pageDelayMs: 0 } : { hosts: [HOST], pages: [PAGE], vgmrips: false, pageDelayMs: 0 },
        log: (m) => log(`[catalog] ${m}`)
      }
    )
    t0 = Date.now()
    catalog.start()
    await until('the chip index', async () => {
      const s = await catalog.status()
      return s.albums > kh.length && !s.indexing && s
    }, 120_000)
    const pages = db.prepare(`SELECT source, page, items, skipped, error FROM chip_pages`).all()
    const chipAlbums = (db.prepare(`SELECT COUNT(*) AS n FROM albums WHERE provider = 'chip'`).get() as { n: number }).n
    out.index = { ms: Date.now() - t0, pages, chipAlbums, status: await catalog.status() }

    // 3. Match: the chip album sits on the KHInsider game.
    const browse = await catalog.browse({ text: `${GAME} source=chip`, group: 'album', sort: 'title', offset: 0, limit: 10 })
    const g = browse.groups.find((x) => x.title.startsWith(`${GAME} (`))
    if (!g) throw new Error(`no chip album for ${GAME}: ${browse.groups.map((x) => x.title).join(', ')}`)
    const albumId = g.key.split(':')[1]
    const albumsOfGame = khGame ? db.prepare(`SELECT title, provider, kind FROM albums WHERE game_id = ? ORDER BY provider, title`).all(khGame.id) : []
    out.match = { album: g.title, gameId: g.gameId, khGameId: khGame?.id ?? null, sameGame: khGame ? String(khGame.id) === g.gameId : null, albumsOfGame }

    // 4. Open it: the engine fetches + lists the archive, tracks get stored sources.
    t0 = Date.now()
    const detail = await catalog.album(albumId)
    out.album = {
      ms: Date.now() - t0,
      title: detail.album.title,
      game: detail.game?.name,
      year: detail.album.year,
      platforms: detail.album.platforms,
      composers: detail.album.composers,
      tracks: detail.tracks.length,
      first: detail.tracks.slice(0, 5).map((t) => `${t.disc}-${t.number} ${t.title} ${t.durationMs ?? '?'}`)
    }
    const track = detail.tracks[Math.min(TRACK, detail.tracks.length - 1)]
    const [src] = await catalog.resolveSources(track.id)
    out.source = src

    // 5. Play through the real player.
    const { library, playlists } = createLibrary({ db, catalog, broadcast, getSettings: () => settings })
    const player = new Player({ engine, catalog, library, playlists, getSettings: () => settings, setLoopMode: () => {}, broadcast })
    engine.onEvent((e) => player.handleEngineEvent(e))
    shutdown = () => {
      player.dispose()
      engine.shutdown()
      catalog.stop()
    }
    await player.setVolume(Number(process.env.GHOST_SMOKE_VOLUME ?? 0.12))
    await player.playAlbum(albumId, detail.tracks.indexOf(track))
    const playing = await until('playback', () => last?.status === 'playing' && last, 30_000)
    const p0 = playing.positionMs
    const voiced = await until('voices', () => last?.voices && last, 10_000)
    await sleep(3000)
    const s1 = await player.getState()
    out.playback = {
      track: s1.current?.title,
      status: s1.status,
      advancedMs: Math.round(s1.positionMs - p0),
      durationMs: s1.durationMs,
      voices: voiced.voices,
      engineVoiceCount: engine.voiceCount?.() ?? null
    }

    // 6. Voice mask: mute the first two voices, then solo the third, then back to all.
    await player.setVoiceMask(0b11)
    await sleep(1500)
    const m1 = (await player.getState()).voices
    const n = m1?.names.length ?? 0
    await player.setVoiceMask(((1 << n) - 1) & ~0b100)
    await sleep(1500)
    const m2 = (await player.getState()).voices
    // the next track starts with every voice back on
    await player.next()
    await until('next track', () => last?.status === 'playing' && last.current?.id !== track.id && last, 20_000)
    await sleep(800)
    const m3 = (await player.getState()).voices
    out.voiceMask = { afterMute: m1?.mask, afterSolo: m2?.mask, nextTrack: (await player.getState()).current?.title, nextTrackMask: m3?.mask }
    log('RESULT', JSON.stringify(out, null, 2))
  } catch (e) {
    log('RESULT (partial)', JSON.stringify(out, null, 2))
    log('FAILED', e)
    process.exitCode = 1
  }
  shutdown()
  app.quit()
})

let last: PlayerState | null = null
function onState(s: PlayerState): void {
  if (!last || last.status !== s.status || last.current?.id !== s.current?.id || last.voices?.mask !== s.voices?.mask || !!last.voices !== !!s.voices)
    log('state', s.status, s.current?.title ?? '-', 'pos', Math.round(s.positionMs), 'voices', s.voices ? `${s.voices.names.join('|')} mask=${s.voices.mask}` : '-', s.error ?? '')
  last = s
}
