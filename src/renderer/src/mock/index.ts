// Browser-only mock of GhostAPI. Lets the whole UI run (and be screenshotted) without Electron,
// the Rust engine or the network. Playback is simulated with a clock; analysis frames are
// synthesised from a per-track tempo so beat-reactive visuals behave realistically.
import type { GhostAPI, GhostEventName, GhostEvents } from '@shared/api'
import { defaultSettings, mergeSettings } from '@shared/defaults'
import type {
  Album,
  AlbumDetail,
  AnalysisFrame,
  BrowseGroup,
  BrowseQuery,
  CatalogStatus,
  AudioFormat,
  DownloadItem,
  ExternalAlbumHit,
  Game,
  HistoryEntry,
  PlayContext,
  PlayerState,
  Playlist,
  PlaylistItem,
  QueueItem,
  Settings,
  TrackAnalysis,
  TrackView
} from '@shared/types'
import { FIXTURE_GAMES, type FixtureGame } from './fixtures'

// ---------------------------------------------------------------------------
// helpers

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967295
}
const parseDur = (s: string) => {
  const [m, sec] = s.split(':').map(Number)
  return (m * 60 + sec) * 1000
}
const now = () => Date.now()
let uidSeq = 0
const uid = (p = 'u') => `${p}${++uidSeq}_${Math.floor(Math.random() * 1e6).toString(36)}`
const delay = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(v), ms))

const artCache = new Map<string, string>()
function mockArt(seed: string, a: string, b: string, w: number, h: number): string {
  const key = `${seed}:${w}x${h}`
  const hit = artCache.get(key)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const r = (n: number) => hash(seed + n)
  const lg = g.createLinearGradient(0, 0, w, h)
  lg.addColorStop(0, b)
  lg.addColorStop(1, '#07060c')
  g.fillStyle = lg
  g.fillRect(0, 0, w, h)
  for (let i = 0; i < 7; i++) {
    const x = r(i) * w
    const y = r(i + 10) * h
    const rad = (0.15 + r(i + 20) * 0.45) * Math.max(w, h)
    const rg = g.createRadialGradient(x, y, 0, x, y, rad)
    rg.addColorStop(0, i % 2 ? a : b)
    rg.addColorStop(1, 'transparent')
    g.globalAlpha = 0.35 + r(i + 30) * 0.4
    g.fillStyle = rg
    g.fillRect(0, 0, w, h)
  }
  g.globalAlpha = 0.12
  g.fillStyle = '#ffffff'
  const px = Math.max(6, Math.round(w / 40))
  for (let i = 0; i < 60; i++) g.fillRect(Math.floor((r(i + 50) * w) / px) * px, Math.floor((r(i + 90) * h) / px) * px, px, px)
  g.globalAlpha = 1
  const url = c.toDataURL('image/jpeg', 0.85)
  artCache.set(key, url)
  return url
}

// ---------------------------------------------------------------------------
// catalog

interface MockTrack extends TrackView {
  bpm: number
  intensityStars: number
}

const games: Game[] = []
const albums: Album[] = []
const tracks: MockTrack[] = []
const fixtureByGame = new Map<string, FixtureGame>()

/** `?mockScale=N` pads the catalog with synthetic games, for virtualisation/perf work. */
function scaledFixtures(): FixtureGame[] {
  const n = Number(new URLSearchParams(location.search).get('mockScale') || 0)
  if (!n || n <= FIXTURE_GAMES.length) return FIXTURE_GAMES
  const A = ['Crystal', 'Neon', 'Silent', 'Iron', 'Lunar', 'Hollow', 'Eternal', 'Pixel', 'Shadow', 'Starlight', 'Sky', 'Ember', 'Frozen', 'Arcane', 'Wild', 'Final']
  const B = ['Quest', 'Saga', 'Odyssey', 'Legends', 'Tactics', 'Drift', 'Knights', 'Frontier', 'Dungeon', 'Racer', 'Chronicle', 'Requiem', 'Heroes', 'Horizon', 'Echoes', 'Dreams']
  const out = [...FIXTURE_GAMES]
  const colors = ['#ff6b6b', '#4dd4ff', '#b48cff', '#7cff9e', '#ffd166', '#ff8fd1', '#6ee7ff', '#c3ff6b']
  for (let i = out.length; i < n; i++) {
    const h = hash('scale' + i)
    const name = `${A[i % A.length]} ${B[Math.floor(i / A.length) % B.length]}${i >= A.length * B.length ? ' ' + (Math.floor(i / (A.length * B.length)) + 1) : ''}`
    const tracks: [string, string][] = Array.from({ length: 8 }, (_, k) => [`${['Theme', 'Battle', 'Town', 'Field', 'Boss', 'Ending', 'Dungeon', 'Credits'][k]} ${k + 1}`, `${2 + Math.floor(hash(name + k) * 3)}:${String(Math.floor(hash(name + 'k' + k) * 59)).padStart(2, '0')}`])
    out.push({ name, year: 1985 + Math.floor(h * 40), platforms: [['SNES', 'PS1', 'Genesis', 'Switch', 'Windows', 'GBA'][i % 6]], accent: colors[i % colors.length], accent2: '#120c20', albums: [{ title: `${name} Original Soundtrack`, kind: 'ost', year: 1985 + Math.floor(h * 40), composers: ['Composer ' + ((i % 37) + 1)], formats: ['mp3'], tracks }] })
  }
  return out
}

function buildCatalog() {
  scaledFixtures().forEach((fg, gi) => {
    const gameId = `g${gi + 1}`
    fixtureByGame.set(gameId, fg)
    const game: Game = {
      id: gameId,
      name: fg.name,
      altNames: fg.original ? [fg.original] : [],
      year: fg.year,
      platforms: fg.platforms,
      franchise: fg.franchise ?? null,
      cover: null,
      hero: null,
      logo: null,
      accent: fg.accent,
      albumCount: fg.albums.length
    }
    games.push(game)
    fg.albums.forEach((fa, ai) => {
      const albumId = `${gameId}a${ai + 1}`
      const album: Album = {
        id: albumId,
        gameId,
        gameName: fg.name,
        title: fa.title,
        titleOriginal: fa.titleOriginal ?? null,
        kind: fa.kind,
        year: fa.year,
        platforms: fg.platforms,
        catalogNo: null,
        composers: fa.composers,
        cover: null,
        trackCount: fa.tracks.length,
        totalMs: fa.tracks.reduce((s, t) => s + parseDur(t[1]), 0),
        formats: fa.formats,
        provider: 'khinsider',
        providerRef: albumId,
        addedAt: now() - Math.floor(hash(albumId) * 1e10)
      }
      albums.push(album)
      fa.tracks.forEach(([title, dur], ti) => {
        const id = `${albumId}t${ti + 1}`
        const h = hash(id)
        const lower = title.toLowerCase()
        const bossy = /battle|boss|magus|kefka|dancing|megalovania|radiance|ridley|bowser|mad|nightmare|spear|glamour|confronting/.test(lower)
        const calm = /peaceful|morning|sunlight|town|dirtmouth|museum|start|once|fallen|prologue|exhale|good night|comet|overture|title/.test(lower)
        const stars = Math.round((bossy ? 5.2 + h * 2.4 : calm ? 0.8 + h * 1.4 : 2 + h * 3) * 100) / 100
        const bpm = Math.round(bossy ? 150 + h * 40 : calm ? 72 + h * 30 : 100 + h * 40)
        tracks.push({
          id,
          albumId,
          disc: 1,
          number: ti + 1,
          title,
          titleOriginal: null,
          durationMs: parseDur(dur),
          composers: fa.composers,
          albumTitle: fa.title,
          albumKind: fa.kind,
          gameId,
          gameName: fg.name,
          year: fa.year,
          platforms: fg.platforms,
          cover: null,
          hero: null,
          accent: fg.accent,
          liked: false,
          downloaded: false,
          source: { provider: 'khinsider', format: fa.formats.includes('flac') ? 'flac' : 'mp3', lossless: fa.formats.includes('flac'), bitrateKbps: fa.formats.includes('flac') ? 1011 : 320, confidence: 1 },
          analysis: { bpm, intensity: stars, lufs: -14 - h * 6 },
          bpm,
          intensityStars: stars
        })
      })
    })
  })
}

function hydrateArt() {
  // Generated lazily because canvas needs a document. Synthetic (mockScale) games reuse a
  // small pool of generated images so startup stays fast.
  for (const g of games) {
    const fg = fixtureByGame.get(g.id)!
    const seed = Number(g.id.slice(1)) > FIXTURE_GAMES.length ? `pool${Number(g.id.slice(1)) % 24}` : g.id
    g.cover = mockArt(seed, fg.accent, fg.accent2, 512, 512)
    g.hero = mockArt(seed + 'hero', fg.accent, fg.accent2, 1600, 900)
  }
  for (const a of albums) {
    const fg = fixtureByGame.get(a.gameId!)!
    const gn = Number(a.gameId!.slice(1))
    a.cover = gn > FIXTURE_GAMES.length ? games[gn - 1].cover : mockArt(a.id, fg.accent2, fg.accent, 512, 512)
  }
  const gameById = new Map(games.map((g) => [g.id, g]))
  const albumById = new Map(albums.map((a) => [a.id, a]))
  for (const t of tracks) {
    t.cover = albumById.get(t.albumId)!.cover
    t.hero = gameById.get(t.gameId!)!.hero
  }
}

let haystacks: Map<string, string> | null = null
function haystack(g: Game): string {
  if (!haystacks) {
    const parts = new Map<string, string[]>(games.map((x) => [x.id, [x.name, ...x.altNames, x.franchise ?? '', ...x.platforms]]))
    for (const a of albums) parts.get(a.gameId!)?.push(a.title, ...a.composers)
    for (const t of tracks) parts.get(t.gameId!)?.push(t.title)
    haystacks = new Map([...parts].map(([id, p]) => [id, p.join(' ').toLowerCase()]))
  }
  return haystacks.get(g.id) ?? ''
}

const strip = (t: MockTrack): TrackView => {
  const { bpm: _b, intensityStars: _i, ...rest } = t
  return { ...rest, liked: likes.has(t.id), downloaded: downloadedIds.has(t.id) }
}

function matches(text: string, g: Game): boolean {
  const q = text.trim().toLowerCase()
  if (!q) return true
  const free = q.split(/\s+/).filter((w) => !/[=<>]/.test(w))
  const hay = haystack(g)
  return free.every((w) => hay.includes(w))
}

function toGroup(g: Game): BrowseGroup {
  return {
    key: `game:${g.id}`,
    kind: 'game',
    title: g.name,
    subtitle: [g.year, g.platforms.join(' · ')].filter(Boolean).join(' · '),
    cover: g.cover,
    hero: g.hero,
    accent: g.accent,
    year: g.year,
    platforms: g.platforms,
    albumCount: g.albumCount,
    gameId: g.id
  }
}

function synthAnalysis(t: MockTrack): TrackAnalysis {
  const dur = (t.durationMs ?? 180000) / 1000
  const beatLen = 60 / t.bpm
  const beats: number[] = []
  for (let x = 0.4; x < dur; x += beatLen) beats.push(Math.round(x * 1000) / 1000)
  const energy = Array.from({ length: 512 }, (_, i) => {
    const p = i / 511
    const base = 0.35 + 0.25 * Math.sin(p * Math.PI * (2 + hash(t.id) * 4)) + 0.2 * Math.sin(p * 37 + hash(t.id + 'e') * 6)
    return Math.max(0.05, Math.min(1, base + (t.intensityStars / 10) * 0.3))
  })
  const kiai: [number, number][] = []
  if (t.intensityStars > 2.2) kiai.push([dur * 0.38, dur * 0.52], [dur * 0.72, dur * 0.86])
  return { lufs: t.analysis?.lufs ?? -14, truePeakDb: -0.8, bpm: t.bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), kiai, energy, intensity: t.intensityStars }
}

// ---------------------------------------------------------------------------
// state

const listeners = new Map<string, Set<(p: unknown) => void>>()
function emit<E extends GhostEventName>(e: E, p: GhostEvents[E]) {
  listeners.get(e)?.forEach((cb) => cb(p))
}

let settings: Settings = defaultSettings('~/Music/GHOST')
const likes = new Set<string>()
const downloadedIds = new Set<string>()
const history: { id: string; at: number; ms: number }[] = []
const playlists = new Map<string, { meta: Playlist; items: { uid: string; id: string; addedAt: number }[] }>()
const downloads: DownloadItem[] = []

const player: PlayerState = {
  status: 'idle',
  current: null,
  currentAnalysis: null,
  positionMs: 0,
  positionAt: now(),
  durationMs: null,
  volume: 0.8,
  muted: false,
  shuffle: 'off',
  repeat: 'off',
  loopMode: 'album',
  queue: [],
  queueIndex: -1,
  context: null,
  preview: null,
  error: null
}
let currentMock: MockTrack | null = null
let trackSeq = 0

function livePos(): number {
  return player.status === 'playing' ? player.positionMs + (now() - player.positionAt) : player.positionMs
}
function pushState() {
  emit('player:state', structuredClone(player))
}
function snapshot() {
  player.positionMs = livePos()
  player.positionAt = now()
}

function loadIndex(i: number, autoplay = true) {
  if (i < 0 || i >= player.queue.length) {
    player.status = 'idle'
    player.current = null
    currentMock = null
    player.queueIndex = -1
    pushState()
    return
  }
  const item = player.queue[i]
  currentMock = tracks.find((t) => t.id === item.track.id)!
  trackSeq++
  player.queueIndex = i
  player.current = strip(currentMock)
  player.currentAnalysis = synthAnalysis(currentMock)
  player.durationMs = currentMock.durationMs
  player.positionMs = 0
  player.positionAt = now()
  player.error = null
  player.status = 'loading'
  pushState()
  setTimeout(() => {
    player.status = autoplay ? 'playing' : 'paused'
    player.positionAt = now()
    pushState()
  }, 350)
  history.unshift({ id: currentMock.id, at: now(), ms: 0 })
  emit('library:changed', { kind: 'history' })
}

setInterval(() => {
  if (player.status !== 'playing' || !player.durationMs) return
  if (livePos() >= player.durationMs) {
    if (player.repeat === 'one') return loadIndex(player.queueIndex)
    const next = player.queueIndex + 1
    if (next < player.queue.length) loadIndex(next)
    else if (player.repeat === 'all' && player.queue.length) loadIndex(0)
    else {
      player.status = 'idle'
      player.positionMs = player.durationMs
      pushState()
    }
  }
}, 250)

function setQueue(ids: string[], start: number, context: PlayContext | null) {
  player.queue = ids.map((id) => ({ uid: uid('q'), track: strip(tracks.find((t) => t.id === id)!) }))
  player.context = context
  if (player.shuffle !== 'off') {
    const first = player.queue.splice(start, 1)
    player.queue.sort(() => Math.random() - 0.5)
    player.queue.unshift(...first)
    start = 0
  }
  loadIndex(start)
}

function plDetail(id: string) {
  const p = playlists.get(id)
  if (!p) throw new Error('No such playlist')
  return p
}
function refreshMeta(id: string) {
  const p = plDetail(id)
  const ts = p.items.map((i) => tracks.find((t) => t.id === i.id)!)
  p.meta = {
    ...p.meta,
    trackCount: ts.length,
    durationMs: ts.reduce((s, t) => s + (t.durationMs ?? 0), 0),
    covers: [...new Set(ts.map((t) => t.cover!))].slice(0, 4),
    updatedAt: now()
  }
  emit('library:changed', { kind: 'playlists', id })
}

function pushDownloads() {
  emit('downloads:changed', structuredClone(downloads))
}

function enqueueDownloads(ids: string[]) {
  for (const id of ids) {
    const t = tracks.find((x) => x.id === id)!
    const item: DownloadItem = {
      id: uid('d'),
      trackId: id,
      title: t.title,
      gameName: t.gameName,
      albumTitle: t.albumTitle,
      cover: t.cover,
      status: 'queued',
      progress: 0,
      bytes: 0,
      totalBytes: Math.round((t.durationMs ?? 180000) * 40),
      path: null,
      error: null,
      createdAt: now()
    }
    downloads.unshift(item)
  }
  pushDownloads()
}

setInterval(() => {
  let changed = false
  const active = downloads.filter((d) => d.status === 'downloading')
  for (const d of active) {
    d.bytes = Math.min(d.totalBytes!, d.bytes + d.totalBytes! * 0.08)
    d.progress = d.bytes / d.totalBytes!
    if (d.progress >= 1) {
      d.status = 'done'
      d.path = `~/Music/GHOST/${d.gameName}/${d.albumTitle}/${d.title}.flac`
      downloadedIds.add(d.trackId)
      emit('library:changed', { kind: 'downloaded' })
      emit('notify', { id: uid('n'), kind: 'success', title: 'Downloaded', body: d.title, image: d.cover })
    }
    changed = true
  }
  const queued = downloads.filter((d) => d.status === 'queued')
  for (const d of queued.slice(0, Math.max(0, 3 - active.length))) {
    d.status = 'downloading'
    changed = true
  }
  if (changed) pushDownloads()
}, 300)

// ---------------------------------------------------------------------------
// synthetic analysis frames

const bands = new Float32Array(96)
const wave = new Float32Array(512)
let smoothRms = 0
function readFrame(): AnalysisFrame | null {
  const t = currentMock
  const playing = player.status === 'playing'
  const posMs = livePos()
  const target = playing && t ? 1 : 0
  smoothRms += (target - smoothRms) * 0.08
  if (!t && smoothRms < 0.01) return null
  const bpm = t?.bpm ?? 120
  const beatLen = 60000 / bpm
  const phase = ((posMs - 400) % beatLen + beatLen) % beatLen / beatLen
  const kick = Math.exp(-phase * 7)
  const energyIdx = t && t.durationMs ? Math.min(511, Math.floor((posMs / t.durationMs) * 512)) : 0
  const energy = player.currentAnalysis?.energy[energyIdx] ?? 0.5
  const time = performance.now() / 1000
  for (let i = 0; i < 96; i++) {
    const f = i / 95
    const tilt = Math.pow(1 - f, 1.3) * 0.85 + 0.12
    const low = i < 14 ? kick * (1 - i / 14) * 0.6 : 0
    const n = 0.5 + 0.5 * Math.sin(time * (2.1 + i * 0.37) + i * 1.7) * Math.sin(time * 1.3 + i)
    const v = (tilt * (0.35 + 0.65 * energy) * (0.55 + 0.45 * n) + low) * smoothRms
    bands[i] += (Math.min(1, v) - bands[i]) * (v > bands[i] ? 0.6 : 0.12)
  }
  for (let i = 0; i < 512; i++) {
    const x = i / 512
    wave[i] = smoothRms * (0.5 * kick * Math.sin(x * Math.PI * 2 * 3 + time * 8) + 0.25 * Math.sin(x * Math.PI * 2 * 17 + time * 30) + 0.1 * Math.sin(x * Math.PI * 2 * 61))
  }
  return {
    bands: bands.slice(),
    waveform: wave.slice(),
    rms: smoothRms * (0.3 + 0.5 * energy + 0.2 * kick),
    peak: smoothRms * (0.6 + 0.4 * kick),
    onset: smoothRms * kick,
    positionMs: posMs,
    trackSeq
  }
}

// ---------------------------------------------------------------------------
// API

export function installMockGhost(): void {
  if ((window as any).ghost) return
  buildCatalog()
  hydrateArt()

  const catalogStatus: CatalogStatus = {
    indexing: false,
    games: games.length,
    albums: albums.length,
    tracks: tracks.length,
    progress: null,
    lastIndexedAt: now(),
    message: null,
    enrichment: { igdb: false, steamGridDb: false }
  }

  const sortGroups = (gs: Game[], sort: BrowseQuery['sort']) => {
    const arr = [...gs]
    if (sort === 'year') arr.sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
    else if (sort === 'random') arr.sort(() => Math.random() - 0.5)
    else arr.sort((a, b) => a.name.localeCompare(b.name))
    return arr
  }

  const api: GhostAPI = {
    catalog: {
      status: () => delay(catalogStatus),
      reindex: () => delay(undefined),
      browse: (q) => {
        const filtered = sortGroups(games.filter((g) => matches(q.text, g)), q.sort)
        return delay({ total: filtered.length, offset: q.offset, groups: filtered.slice(q.offset, q.offset + q.limit).map(toGroup) })
      },
      groupAlbums: (key) => delay(albums.filter((a) => `game:${a.gameId}` === key)),
      album: (id) => {
        const album = albums.find((a) => a.id === id)!
        const detail: AlbumDetail = {
          album,
          game: games.find((g) => g.id === album.gameId) ?? null,
          tracks: tracks.filter((t) => t.albumId === id).map(strip)
        }
        return delay(detail, 120)
      },
      game: (id) => delay(games.find((g) => g.id === id) ?? null),
      tracks: (ids) => delay(ids.map((id) => tracks.find((t) => t.id === id)).filter(Boolean).map((t) => strip(t!))),
      searchTracks: (text, limit = 50) => {
        const q = text.toLowerCase()
        return delay(tracks.filter((t) => t.title.toLowerCase().includes(q)).slice(0, limit).map(strip))
      },
      searchExternal: (query) => {
        const q = query.trim()
        if (!q) return delay([])
        const hits: ExternalAlbumHit[] = [
          { provider: 'youtube', ref: `PL${hash(q).toString(36).slice(2, 12)}`, title: `${q} — Full Original Soundtrack`, subtitle: 'Label - Topic', cover: null, trackCount: 24, totalMs: 24 * 170000, url: 'https://www.youtube.com/', score: 0.92 },
          { provider: 'youtube', ref: `v${hash(q + 'v').toString(36).slice(2, 12)}`, title: `${q} OST (complete, with timestamps)`, subtitle: 'VGM uploader', cover: null, trackCount: 31, totalMs: 31 * 150000, url: 'https://www.youtube.com/', score: 0.71 },
          { provider: 'archive', ref: `${q.toLowerCase().replace(/\W+/g, '-')}-soundtrack`, title: `${q} Soundtrack`, subtitle: 'Internet Archive', cover: null, trackCount: 18, totalMs: 18 * 160000, url: 'https://archive.org/', score: 0.55 }
        ]
        return delay(hits, 600)
      },
      importExternal: async (hit, opts) => {
        const gi = games.length + 1
        const gameId = `g${gi}`
        const name = opts?.gameName ?? hit.title.replace(/\s*[—-].*$/, '').replace(/\s*OST.*$/i, '')
        const accent = ['#ff6b6b', '#4dd4ff', '#b48cff', '#7cff9e'][gi % 4]
        fixtureByGame.set(gameId, { name, year: 2020, platforms: [], accent, accent2: '#120c20', albums: [] })
        games.push({ id: gameId, name, altNames: [], year: null, platforms: [], franchise: null, cover: mockArt(gameId, accent, '#120c20', 512, 512), hero: mockArt(gameId + 'hero', accent, '#120c20', 1600, 900), logo: null, accent, albumCount: 1 })
        const albumId = `${gameId}a1`
        const n = Math.min(hit.trackCount ?? 12, 16)
        albums.push({ id: albumId, gameId, gameName: name, title: hit.title, titleOriginal: null, kind: 'ost', year: null, platforms: [], catalogNo: null, composers: [], cover: mockArt(albumId, '#120c20', accent, 512, 512), trackCount: n, totalMs: n * 150000, formats: ['m4a' as AudioFormat], provider: hit.provider, providerRef: hit.ref, addedAt: now() })
        for (let i = 0; i < n; i++) {
          const id = `${albumId}t${i + 1}`
          const h = hash(id)
          tracks.push({ id, albumId, disc: 1, number: i + 1, title: `Track ${i + 1}`, titleOriginal: null, durationMs: 120000 + Math.round(h * 120000), composers: [], albumTitle: hit.title, albumKind: 'ost', gameId, gameName: name, year: null, platforms: [], cover: albums[albums.length - 1].cover, hero: games[games.length - 1].hero, accent, liked: false, downloaded: false, source: { provider: hit.provider, format: 'm4a', lossless: false, bitrateKbps: 128, confidence: 0.8 }, analysis: { bpm: 120, intensity: 1 + h * 5, lufs: -14 }, bpm: Math.round(90 + h * 60), intensityStars: Math.round((1 + h * 5) * 100) / 100 })
        }
        haystacks = null
        catalogStatus.games = games.length
        catalogStatus.albums = albums.length
        catalogStatus.revision = (catalogStatus.revision ?? 0) + 1
        emit('catalog:status', { ...catalogStatus })
        return api.catalog.album(albumId)
      },
      random: (text = '') => {
        const pool = games.filter((g) => matches(text, g))
        if (!pool.length) return delay(null)
        const g = pool[Math.floor(Math.random() * pool.length)]
        const as = albums.filter((a) => a.gameId === g.id)
        return delay({ groupKey: `game:${g.id}`, albumId: as[Math.floor(Math.random() * as.length)]?.id ?? null })
      }
    },
    player: {
      getState: () => delay(structuredClone(player), 0),
      playTracks: async (ids, start = 0, context) => setQueue(ids, start, context ?? null),
      playAlbum: async (albumId, start = 0) => {
        const a = albums.find((x) => x.id === albumId)!
        setQueue(tracks.filter((t) => t.albumId === albumId).map((t) => t.id), start, { kind: 'album', id: albumId, title: a.title })
      },
      playPlaylist: async (id, start = 0) => {
        const p = plDetail(id)
        setQueue(p.items.map((i) => i.id), start, { kind: 'playlist', id, title: p.meta.name })
      },
      toggle: async () => {
        if (player.status === 'playing') return api.player.pause()
        return api.player.play()
      },
      play: async () => {
        if (!player.current) return
        snapshot()
        player.status = 'playing'
        pushState()
      },
      pause: async () => {
        snapshot()
        player.status = 'paused'
        pushState()
      },
      next: async () => loadIndex(Math.min(player.queue.length - 1, player.queueIndex + 1)),
      prev: async () => {
        if (livePos() > 3000) {
          player.positionMs = 0
          player.positionAt = now()
          pushState()
        } else loadIndex(Math.max(0, player.queueIndex - 1))
      },
      seek: async (ms) => {
        player.positionMs = Math.max(0, Math.min(ms, player.durationMs ?? ms))
        player.positionAt = now()
        pushState()
      },
      setVolume: async (v) => {
        player.volume = v
        pushState()
      },
      setMuted: async (m) => {
        player.muted = m
        pushState()
      },
      setShuffle: async (m) => {
        player.shuffle = m
        pushState()
      },
      setRepeat: async (m) => {
        player.repeat = m
        pushState()
      },
      setLoopMode: async (m) => {
        player.loopMode = m
        pushState()
      },
      enqueue: async (ids, mode) => {
        const items: QueueItem[] = ids.map((id) => ({ uid: uid('q'), track: strip(tracks.find((t) => t.id === id)!) }))
        if (mode === 'next') player.queue.splice(player.queueIndex + 1, 0, ...items)
        else player.queue.push(...items)
        if (player.queueIndex < 0) loadIndex(0)
        else pushState()
      },
      removeFromQueue: async (uids) => {
        const cur = player.queue[player.queueIndex]?.uid
        player.queue = player.queue.filter((q) => !uids.includes(q.uid))
        player.queueIndex = player.queue.findIndex((q) => q.uid === cur)
        pushState()
      },
      moveInQueue: async (from, to) => {
        const cur = player.queue[player.queueIndex]?.uid
        const [it] = player.queue.splice(from, 1)
        player.queue.splice(to, 0, it)
        player.queueIndex = player.queue.findIndex((q) => q.uid === cur)
        pushState()
      },
      clearQueue: async () => {
        const cur = player.queue[player.queueIndex]
        player.queue = cur ? [cur] : []
        player.queueIndex = cur ? 0 : -1
        pushState()
      },
      jumpTo: async (i) => loadIndex(i),
      preview: async (id) => {
        player.preview = { track: strip(tracks.find((t) => t.id === id)!), startedAt: now() }
        pushState()
      },
      stopPreview: async () => {
        player.preview = null
        pushState()
      },
      setOverlayFilter: async () => {},
      devices: () => delay([{ id: 'default', name: 'System default', isDefault: true }])
    },
    library: {
      playlists: {
        list: () => delay([...playlists.values()].map((p) => p.meta).sort((a, b) => b.updatedAt - a.updatedAt)),
        get: (id) => {
          const p = plDetail(id)
          const items: PlaylistItem[] = p.items.map((i) => ({ uid: i.uid, addedAt: i.addedAt, track: strip(tracks.find((t) => t.id === i.id)!) }))
          return delay({ playlist: p.meta, items })
        },
        create: async (name, opts) => {
          const id = uid('p')
          const meta: Playlist = { id, name, description: opts?.description ?? null, kind: opts?.query ? 'smart' : 'manual', query: opts?.query ?? null, trackCount: 0, durationMs: 0, covers: [], createdAt: now(), updatedAt: now() }
          playlists.set(id, { meta, items: (opts?.trackIds ?? []).map((tid) => ({ uid: uid('i'), id: tid, addedAt: now() })) })
          refreshMeta(id)
          return plDetail(id).meta
        },
        update: async (id, patch) => {
          const p = plDetail(id)
          p.meta = { ...p.meta, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }
          refreshMeta(id)
          return p.meta
        },
        delete: async (id) => {
          playlists.delete(id)
          emit('library:changed', { kind: 'playlists', id })
        },
        duplicate: async (id) => {
          const p = plDetail(id)
          return api.library.playlists.create(`${p.meta.name} (copy)`, { trackIds: p.items.map((i) => i.id) })
        },
        addTracks: async (id, ids, pos) => {
          const p = plDetail(id)
          const items = ids.map((tid) => ({ uid: uid('i'), id: tid, addedAt: now() }))
          if (pos === undefined) p.items.push(...items)
          else p.items.splice(pos, 0, ...items)
          refreshMeta(id)
          emit('notify', { id: uid('n'), kind: 'success', title: `Added to ${p.meta.name}`, body: `${ids.length} track${ids.length === 1 ? '' : 's'}` })
        },
        removeItems: async (id, uids) => {
          const p = plDetail(id)
          p.items = p.items.filter((i) => !uids.includes(i.uid))
          refreshMeta(id)
        },
        moveItem: async (id, from, to) => {
          const p = plDetail(id)
          const [it] = p.items.splice(from, 1)
          p.items.splice(to, 0, it)
          refreshMeta(id)
        },
        exportM3U: async (id) => `~/Music/GHOST/${plDetail(id).meta.name}.m3u8`
      },
      toggleLike: async (id) => {
        if (likes.has(id)) likes.delete(id)
        else likes.add(id)
        if (player.current?.id === id) {
          player.current = { ...player.current, liked: likes.has(id) }
          pushState()
        }
        emit('library:changed', { kind: 'likes' })
        return likes.has(id)
      },
      liked: () => delay([...likes].map((id) => strip(tracks.find((t) => t.id === id)!))),
      history: (limit = 100) =>
        delay(history.slice(0, limit).map<HistoryEntry>((h) => ({ track: strip(tracks.find((t) => t.id === h.id)!), playedAt: h.at, msPlayed: h.ms }))),
      downloaded: () => delay([...downloadedIds].map((id) => strip(tracks.find((t) => t.id === id)!)))
    },
    downloads: {
      enqueue: async (target) => {
        let ids: string[] = []
        if ('trackIds' in target) ids = target.trackIds
        else if ('albumId' in target) ids = tracks.filter((t) => t.albumId === target.albumId).map((t) => t.id)
        else ids = plDetail(target.playlistId).items.map((i) => i.id)
        enqueueDownloads(ids)
      },
      list: () => delay(structuredClone(downloads)),
      cancel: async (id) => {
        const d = downloads.find((x) => x.id === id)
        if (d && d.status !== 'done') d.status = 'canceled'
        pushDownloads()
      },
      retry: async (id) => {
        const d = downloads.find((x) => x.id === id)
        if (d) Object.assign(d, { status: 'queued', progress: 0, bytes: 0, error: null })
        pushDownloads()
      },
      clearFinished: async () => {
        for (let i = downloads.length - 1; i >= 0; i--) if (['done', 'canceled', 'error'].includes(downloads[i].status)) downloads.splice(i, 1)
        pushDownloads()
      },
      reveal: async () => {},
      openFolder: async () => {}
    },
    settings: {
      get: () => delay(structuredClone(settings), 0),
      set: async (patch) => {
        settings = mergeSettings(settings, patch)
        emit('settings:changed', structuredClone(settings))
        return structuredClone(settings)
      },
      pickFolder: async () => '~/Music/GHOST'
    },
    system: {
      openExternal: async (url) => void window.open(url, '_blank'),
      reveal: async () => {},
      info: async () => ({ platform: 'web', version: '0.1.0-mock', dataDir: '(mock)', mock: true })
    },
    analysis: { read: readFrame },
    on(event, cb) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(cb as (p: unknown) => void)
      return () => set!.delete(cb as (p: unknown) => void)
    }
  }

  // A couple of sample playlists so the Library isn't empty.
  void api.library.playlists.create('Boss rush', { trackIds: tracks.filter((t) => t.intensityStars > 5).map((t) => t.id).slice(0, 8) })
  void api.library.playlists.create('Study / ambient', { trackIds: tracks.filter((t) => t.intensityStars < 2).map((t) => t.id).slice(0, 10) })
  ;(window as any).ghost = api
}
