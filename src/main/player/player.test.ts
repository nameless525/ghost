import { afterEach, describe, expect, it } from 'vitest'
import type { ID, Settings } from '../../shared/types'
import { allVoices, formatVoiceMask, parseVoiceMask, voiceBit } from '../../shared/voices'
import type { EngineTrack } from '../engine/types'
import { sliderToDb } from '../engine/types'
import { createLibrary } from '../library'
import { HEARTBEAT_KEEPALIVE_MS, HISTORY_MIN_MS, MAX_FAIL_STREAK, Player } from './player'
import { MemorySessionStore } from './session'
import { FakeCatalog, FakeEngine, fakeBroadcast, flush, httpSource, makeTrack, memoryDb, testSettings } from './testing'

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const players: Player[] = []
afterEach(() => {
  for (const p of players.splice(0)) p.dispose()
})

function setup(opts: { seed?: number; session?: MemorySessionStore; tracks?: number; files?: Set<string>; echoIntervalMs?: number; heartbeatMs?: number } = {}) {
  const engine = new FakeEngine()
  const catalog = new FakeCatalog()
  const n = opts.tracks ?? 5
  for (let i = 1; i <= n; i++) catalog.addTracks(makeTrack(`t${i}`, { number: i, title: `Song ${i}` }))
  const bc = fakeBroadcast()
  const db = memoryDb()
  const settings: Settings = testSettings()
  const files = opts.files ?? new Set<string>()
  const { library, playlists } = createLibrary({ db, catalog, broadcast: bc.broadcast, getSettings: () => settings, fileExists: (p) => files.has(p) })
  const session = opts.session ?? new MemorySessionStore()
  const clock = { t: 1_700_000_000_000 }
  const player = new Player({
    engine,
    catalog,
    library,
    playlists,
    getSettings: () => settings,
    setLoopMode: (m) => {
      settings.audio.loopMode = m
    },
    broadcast: bc.broadcast,
    session,
    now: () => clock.t,
    random: mulberry32(opts.seed ?? 42),
    heartbeatMs: opts.heartbeatMs ?? 0,
    echoIntervalMs: opts.echoIntervalMs,
    sessionDebounceMs: 0
  })
  players.push(player)
  engine.onEvent((e) => player.handleEngineEvent(e))
  const settle = async () => {
    await player.settled()
    await flush()
  }
  const st = () => player.snapshot()
  const ids = () => st().queue.map((q) => q.track.id)
  const uidAt = (i: number) => st().queue[i].uid
  /** Engine reports the current track as playing. */
  const started = () => engine.emit({ type: 'state', state: 'playing', id: engine.current!.id })
  return { engine, catalog, bc, db, settings, library, playlists, session, clock, player, settle, st, ids, uidAt, started, files }
}

describe('queue', () => {
  it('playTracks loads the start index into the engine and reports loading -> playing', async () => {
    const t = setup()
    t.catalog.analyses.set('t3', { lufs: -11, truePeakDb: -1, bpm: 120, beats: [], downbeats: [], kiai: [], energy: [], intensity: 3 })
    await t.player.playTracks(['t1', 't2', 't3', 't4'], 2, { kind: 'search', id: null, title: 'x' })
    expect(t.st().status).toBe('loading')
    await t.settle()
    const [track, startMs, autoplay] = t.engine.lastCall('setCurrent') as [EngineTrack, number, boolean]
    expect(track.id).toBe(t.uidAt(2))
    expect(track.source).toEqual(httpSource('t3', 'a').source)
    expect(track.lufs).toBe(-11)
    expect(track.albumKey).toBe('al1')
    expect(track.expectedDurationMs).toBe(180_000)
    expect(startMs).toBe(0)
    expect(autoplay).toBe(true)
    expect(t.st().queueIndex).toBe(2)
    expect(t.st().current?.id).toBe('t3')
    expect(t.st().context?.kind).toBe('search')
    t.started()
    expect(t.st().status).toBe('playing')
    await flush()
    expect(t.bc.last('player:state')?.status).toBe('playing')
  })

  it('drops unknown ids and keeps the requested start track', async () => {
    const t = setup()
    await t.player.playTracks(['nope', 't1', 'missing', 't4'], 3)
    await t.settle()
    expect(t.ids()).toEqual(['t1', 't4'])
    expect(t.st().current?.id).toBe('t4')
  })

  it('playAlbum queues the album in order with an album context', async () => {
    const t = setup()
    await t.player.playAlbum('al1', 1)
    await t.settle()
    expect(t.ids()).toEqual(['t1', 't2', 't3', 't4', 't5'])
    expect(t.st().queueIndex).toBe(1)
    expect(t.st().context).toEqual({ kind: 'album', id: 'al1', title: 'Album One' })
  })

  it('playPlaylist plays the playlist items', async () => {
    const t = setup()
    const pl = await t.playlists.create('Mix', { trackIds: ['t5', 't2', 't5'] })
    await t.player.playPlaylist(pl.id)
    await t.settle()
    expect(t.ids()).toEqual(['t5', 't2', 't5'])
    expect(new Set(t.st().queue.map((q) => q.uid)).size).toBe(3)
    expect(t.st().context).toEqual({ kind: 'playlist', id: pl.id, title: 'Mix' })
  })

  it('enqueue next/end inserts at the right place; enqueue into an empty queue starts playing', async () => {
    const t = setup()
    await t.player.enqueue(['t1'], 'end')
    await t.settle()
    expect(t.ids()).toEqual(['t1'])
    expect(t.st().queueIndex).toBe(0)
    expect(t.engine.callsOf('setCurrent')).toHaveLength(1)
    await t.player.enqueue(['t2', 't3'], 'end')
    await t.player.enqueue(['t4'], 'next')
    expect(t.ids()).toEqual(['t1', 't4', 't2', 't3'])
    expect(t.st().queueIndex).toBe(0)
  })

  it('removeFromQueue keeps the current item; removing the current item plays what takes its place', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3', 't4'], 1)
    await t.settle()
    t.started()
    await t.player.removeFromQueue([t.uidAt(0), t.uidAt(3)])
    expect(t.ids()).toEqual(['t2', 't3'])
    expect(t.st().queueIndex).toBe(0)
    expect(t.st().current?.id).toBe('t2')
    const calls = t.engine.callsOf('setCurrent').length
    await t.player.removeFromQueue([t.uidAt(0)])
    await t.settle()
    expect(t.ids()).toEqual(['t3'])
    expect(t.engine.callsOf('setCurrent')).toHaveLength(calls + 1)
    expect((t.engine.lastCall('setCurrent')![0] as EngineTrack).id).toBe(t.uidAt(0))
    await t.player.removeFromQueue([t.uidAt(0)])
    expect(t.st().queue).toEqual([])
    expect(t.st().current).toBeNull()
    expect(t.st().status).toBe('idle')
  })

  it('moveInQueue reorders and the current index follows the current item', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3', 't4'], 1)
    await t.settle()
    await t.player.moveInQueue(3, 0)
    expect(t.ids()).toEqual(['t4', 't1', 't2', 't3'])
    expect(t.st().queueIndex).toBe(2)
    expect(t.st().current?.id).toBe('t2')
    await t.player.moveInQueue(2, 3)
    expect(t.ids()).toEqual(['t4', 't1', 't3', 't2'])
    expect(t.st().queueIndex).toBe(3)
  })

  it('clearQueue keeps only the current item', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3'], 1)
    await t.settle()
    await t.player.clearQueue()
    expect(t.ids()).toEqual(['t2'])
    expect(t.st().queueIndex).toBe(0)
    expect(t.engine.nextId).toBeNull()
  })

  it('jumpTo loads that index', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3'])
    await t.settle()
    await t.player.jumpTo(2)
    await t.settle()
    expect(t.st().current?.id).toBe('t3')
    expect((t.engine.lastCall('setCurrent')![0] as EngineTrack).id).toBe(t.uidAt(2))
  })

  it("a late 'advanced' for the old preload doesn't override a newer jump", async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3'])
    await t.settle()
    const oldNext = t.uidAt(1)
    expect(t.engine.nextId).toBe(oldNext)
    await t.player.jumpTo(2)
    await t.settle()
    // the engine had already moved into the armed next and reports it after our jump arrived
    t.engine.emit({ type: 'advanced', id: oldNext })
    await t.settle()
    expect(t.st().current?.id).toBe('t3')
    expect(t.st().queueIndex).toBe(2)
  })

  it('prev restarts past 3 s, otherwise goes to the previous track', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3'], 1)
    await t.settle()
    t.started()
    t.engine.posMs = 10_000
    await t.player.prev()
    expect(t.engine.lastCall('seek')).toEqual([0])
    expect(t.st().current?.id).toBe('t2')
    t.engine.posMs = 1_000
    await t.player.prev()
    await t.settle()
    expect(t.st().current?.id).toBe('t1')
    // At the start of the queue prev just restarts.
    t.engine.posMs = 500
    await t.player.prev()
    expect(t.st().current?.id).toBe('t1')
    expect(t.engine.lastCall('seek')).toEqual([0])
  })

  it('next at the end stops (repeat off) or wraps (repeat all)', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2'], 1)
    await t.settle()
    t.started()
    await t.player.next()
    expect(t.st().status).toBe('idle')
    expect(t.st().current?.id).toBe('t2')
    expect(t.engine.callsOf('stop')).toHaveLength(1)
    await t.player.setRepeat('all')
    await t.player.next()
    await t.settle()
    expect(t.st().current?.id).toBe('t1')
  })

  it('pause/play/toggle drive the engine; play after a stop reloads the current track', async () => {
    const t = setup()
    await t.player.playTracks(['t1'])
    await t.settle()
    t.started()
    await t.player.toggle()
    expect(t.engine.lastCall('pause')).toEqual([])
    expect(t.st().status).toBe('paused')
    await t.player.toggle()
    expect(t.engine.callsOf('play')).toHaveLength(1)
    expect(t.st().status).toBe('playing')
    t.engine.finishCurrent() // ended, nothing next
    await t.settle()
    expect(t.st().status).toBe('idle')
    const n = t.engine.callsOf('setCurrent').length
    await t.player.play()
    await t.settle()
    expect(t.engine.callsOf('setCurrent')).toHaveLength(n + 1)
    expect(t.engine.lastCall('setCurrent')![1]).toBe(0)
  })

  it('pausing while a track is still resolving loads it paused', async () => {
    const t = setup()
    let open!: () => void
    t.catalog.gate = new Promise((r) => (open = r))
    await t.player.playTracks(['t1', 't2'])
    await t.player.pause()
    open()
    await t.settle()
    expect(t.engine.lastCall('setCurrent')![2]).toBe(false)
    expect(t.st().status).toBe('paused')
  })
})

/** A promise the test opens by hand: a slow lookup (an album page from the site, a busy worker). */
function gate() {
  let open!: () => void
  const wait = new Promise<void>((r) => (open = r))
  return { wait, open }
}

describe('play requests', () => {
  /** Two albums: al1 (t1..t5) and al2 (u1, u2); `slow` holds the lookups of whatever it names. */
  function twoAlbums() {
    const t = setup()
    t.catalog.addTracks(makeTrack('u1', { albumId: 'al2', number: 1 }), makeTrack('u2', { albumId: 'al2', number: 2 }))
    const slow = new Map<string, Promise<void>>()
    const album = t.catalog.album.bind(t.catalog)
    t.catalog.album = async (id) => {
      await slow.get(id)
      return album(id)
    }
    const fetchTracks = t.library.fetchTracks.bind(t.library)
    t.library.fetchTracks = async (ids) => {
      await slow.get(ids.join())
      return fetchTracks(ids)
    }
    const get = t.playlists.get.bind(t.playlists)
    t.playlists.get = async (id) => {
      await slow.get(id)
      return get(id)
    }
    return { ...t, slow }
  }

  it('a slow earlier request never replaces a newer queue, whichever kinds they are', async () => {
    const t = twoAlbums()
    const pl = await t.playlists.create('Mix', { trackIds: ['t4', 't5'] })
    const cases: [string, () => Promise<void>, () => Promise<void>, ID][] = [
      ['album, then tracks', () => t.player.playAlbum('al2'), () => t.player.playTracks(['t3']), 't3'],
      ['tracks, then playlist', () => t.player.playTracks(['u1', 'u2']), () => t.player.playPlaylist(pl.id), 't4'],
      ['playlist, then album', () => t.player.playPlaylist(pl.id), () => t.player.playAlbum('al2', 1), 'u2'],
      ['album, then album', () => t.player.playAlbum('al1'), () => t.player.playAlbum('al2'), 'u1']
    ]
    for (const [name, older, newer, plays] of cases) {
      const g = gate()
      // whichever lookup the older request makes is the slow one
      for (const key of ['al1', 'al2', 'u1,u2', pl.id]) t.slow.set(key, g.wait)
      const first = older()
      await flush()
      t.slow.clear()
      await newer()
      await t.settle()
      expect(t.st().current?.id, name).toBe(plays)
      g.open()
      await first
      await t.settle()
      expect(t.st().current?.id, name).toBe(plays)
    }
  })

  it('pausing while a new queue is being looked up starts it paused; playing starts it playing', async () => {
    const t = twoAlbums()
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    t.started()
    let g = gate()
    t.slow.set('al2', g.wait)
    const paused = t.player.playAlbum('al2')
    await t.player.pause()
    g.open()
    await paused
    await t.settle()
    expect(t.st().current?.id).toBe('u1')
    expect(t.engine.lastCall('setCurrent')![2]).toBe(false)
    expect(t.st().status).toBe('paused')

    g = gate()
    t.slow.set('al1', g.wait)
    const resumed = t.player.playAlbum('al1', 2)
    await t.player.pause()
    await t.player.play()
    g.open()
    await resumed
    await t.settle()
    expect(t.st().current?.id).toBe('t3')
    expect(t.engine.lastCall('setCurrent')![2]).toBe(true)
  })
})

describe('shuffle', () => {
  it('reorders only the upcoming items, keeps the current one, and restores the order when turned off', async () => {
    const t = setup({ tracks: 10 })
    const all = Array.from({ length: 10 }, (_, i) => `t${i + 1}`)
    await t.player.playTracks(all, 3)
    await t.settle()
    const before = t.st().queue.map((q) => q.uid)
    await t.player.setShuffle('on')
    const after = t.st().queue.map((q) => q.uid)
    expect(after.slice(0, 4)).toEqual(before.slice(0, 4))
    expect(t.st().queueIndex).toBe(3)
    expect(new Set(after.slice(4))).toEqual(new Set(before.slice(4)))
    expect(after.slice(4)).not.toEqual(before.slice(4))
    // the engine's next follows the shuffled order
    await t.settle()
    expect(t.engine.nextId).toBe(after[4])
    await t.player.setShuffle('off')
    expect(t.st().queue.map((q) => q.uid)).toEqual(before)
    expect(t.st().queueIndex).toBe(3)
  })

  it('starting playback with shuffle on puts the chosen track first; off restores the original order around it', async () => {
    const t = setup({ tracks: 8 })
    await t.player.setShuffle('on')
    const all = Array.from({ length: 8 }, (_, i) => `t${i + 1}`)
    await t.player.playTracks(all, 5)
    await t.settle()
    expect(t.st().queueIndex).toBe(0)
    expect(t.st().current?.id).toBe('t6')
    expect(new Set(t.ids())).toEqual(new Set(all))
    await t.player.enqueue(['t1'], 'next')
    await t.player.setShuffle('off')
    expect(t.ids()).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't1', 't7', 't8'])
    expect(t.st().current?.id).toBe('t6')
    expect(t.st().queueIndex).toBe(5)
  })

  it('smart shuffle avoids the same game back-to-back (including right after the current track)', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const t = setup({ seed, tracks: 0 })
      const tracks = []
      for (let g = 1; g <= 4; g++) for (let k = 1; k <= 3; k++) tracks.push(makeTrack(`g${g}k${k}`, { gameId: `game${g}`, albumId: `al${g}` }))
      t.catalog.addTracks(...tracks)
      await t.player.playTracks(tracks.map((x) => x.id), 0)
      await t.settle()
      await t.player.setShuffle('smart')
      const q = t.st().queue.map((x) => x.track.gameId)
      for (let i = 1; i < q.length; i++) expect(q[i], `seed ${seed}: ${q.join(',')}`).not.toBe(q[i - 1])
      t.player.dispose()
    }
  })
})

describe('repeat and gapless preload', () => {
  it('arms the next item as soon as the current one starts, and re-arms on queue changes', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3', 't4'])
    await t.settle()
    expect(t.engine.nextId).toBe(t.uidAt(1))
    expect(t.catalog.resolveCalls.map((c) => c.trackId)).toEqual(['t1', 't2'])
    await t.player.moveInQueue(3, 1)
    await t.settle()
    expect(t.engine.nextId).toBe(t.uidAt(1))
    expect(t.st().queue[1].track.id).toBe('t4')
    await t.player.enqueue(['t5'], 'next')
    await t.settle()
    expect(t.engine.nextId).toBe(t.uidAt(1))
    expect(t.st().queue[1].track.id).toBe('t5')
  })

  it("'advanced' moves the queue index without reloading and preloads the following track", async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3'])
    await t.settle()
    t.started()
    const loads = t.engine.callsOf('setCurrent').length
    t.engine.finishCurrent()
    await t.settle()
    expect(t.st().queueIndex).toBe(1)
    expect(t.st().current?.id).toBe('t2')
    expect(t.st().status).toBe('playing')
    expect(t.st().positionMs).toBe(0)
    expect(t.engine.callsOf('setCurrent')).toHaveLength(loads)
    expect(t.engine.nextId).toBe(t.uidAt(2))
  })

  it('repeat one preloads the same item; repeat all wraps; repeat off leaves next empty at the end', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2'], 1)
    await t.settle()
    expect(t.engine.nextId).toBeNull()
    await t.player.setRepeat('all')
    await t.settle()
    expect(t.engine.nextId).toBe(t.uidAt(0))
    await t.player.setRepeat('one')
    await t.settle()
    expect(t.engine.nextId).toBe(t.uidAt(1))
    t.started()
    t.engine.finishCurrent()
    await t.settle()
    expect(t.st().queueIndex).toBe(1)
    expect(t.engine.nextId).toBe(t.uidAt(1))
    await t.player.setRepeat('off')
    await t.settle()
    expect(t.engine.nextId).toBeNull()
  })

  it("'ended' with repeat off at the end of the queue stops; mid-queue it loads the next item", async () => {
    const t = setup()
    t.catalog.resolveErrors.set('t2', 'offline') // preload of t2 fails, so the engine has no next
    await t.player.playTracks(['t1', 't2', 't3'])
    await t.settle()
    expect(t.engine.nextId).toBeNull()
    t.catalog.resolveErrors.delete('t2')
    t.started()
    t.engine.finishCurrent()
    await t.settle()
    expect(t.st().current?.id).toBe('t2')
    expect((t.engine.lastCall('setCurrent')![0] as EngineTrack).id).toBe(t.uidAt(1))
    await t.player.jumpTo(2)
    await t.settle()
    t.started()
    t.engine.finishCurrent()
    await t.settle()
    expect(t.st().status).toBe('idle')
    expect(t.st().current?.id).toBe('t3')
  })

  it('skipping to the preloaded track reuses its resolved sources', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3'])
    await t.settle()
    const resolves = t.catalog.resolveCalls.length
    await t.player.next()
    await t.settle()
    expect(t.st().current?.id).toBe('t2')
    // only the new preload (t3) was resolved
    expect(t.catalog.resolveCalls.slice(resolves).map((c) => c.trackId)).toEqual(['t3'])
  })

  it('skipping to the armed preload hands the engine its decoded voice; a jump elsewhere cancels it first', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3', 't4'])
    await t.settle()
    t.started()
    const armed = t.uidAt(1)
    expect(t.engine.nextId).toBe(armed)
    let from = t.engine.calls.length
    await t.player.next()
    await t.settle()
    let calls = t.engine.calls.slice(from).map((c) => c.method)
    // nothing cancelled the engine's `next` before setCurrent took it over
    expect(calls.slice(0, calls.indexOf('setCurrent'))).not.toContain('setNext')
    expect(t.engine.promoted).toEqual([armed])
    expect(t.st().current?.id).toBe('t2')
    expect(t.engine.nextId).toBe(t.uidAt(2))
    // the engine had advanced into it just before our skip arrived: its late 'advanced' is stale
    const loads = t.engine.callsOf('setCurrent').length
    t.engine.emit({ type: 'advanced', id: armed })
    await t.settle()
    expect(t.engine.callsOf('setCurrent')).toHaveLength(loads)
    expect(t.st().queueIndex).toBe(1)
    // t3 is armed now; jumping to t4 isn't a promotion: t3 is cancelled before t4 loads
    t.started()
    from = t.engine.calls.length
    await t.player.jumpTo(3)
    await t.settle()
    calls = t.engine.calls.slice(from).map((c) => c.method)
    expect(calls.indexOf('setNext')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('setNext')).toBeLessThan(calls.indexOf('setCurrent'))
    expect(t.engine.promoted).toEqual([armed])
    expect(t.st().current?.id).toBe('t4')
  })
})

describe('source fallback', () => {
  it('a recoverable error marks the source failed and retries the next source at the same position', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    t.started()
    const uid = t.uidAt(0)
    t.engine.posMs = 42_000
    t.engine.emit({ type: 'error', id: uid, message: 'HTTP 404', recoverable: true })
    await t.settle()
    expect(t.catalog.failedMarks).toEqual([{ trackId: 't1', cacheKey: 't1#a', reason: 'HTTP 404' }])
    const [track, startMs, autoplay] = t.engine.lastCall('setCurrent') as [EngineTrack, number, boolean]
    expect(track.id).toBe(uid)
    expect(track.source).toEqual(httpSource('t1', 'b').source)
    expect(startMs).toBe(42_000)
    expect(autoplay).toBe(true)
    expect(t.st().queueIndex).toBe(0)
    // the gapless next is re-armed after the reload
    expect(t.engine.nextId).toBe(t.uidAt(1))
  })

  it('a 403 re-resolves the same source once (fresh URL, same key) before giving up on it', async () => {
    const t = setup()
    // a YouTube-style single source whose stored URL went stale
    t.catalog.sources.set('t1', [httpSource('t1', 'yt', { provider: 'youtube' })])
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    const uid = t.uidAt(0)
    // the catalog hands out a freshly resolved URL under the same cache key
    t.catalog.sources.set('t1', [httpSource('t1', 'yt', { provider: 'youtube', source: { kind: 'http', url: 'https://cdn.example/t1/fresh.m4a', cacheKey: 't1#yt' } })])
    t.engine.emit({ type: 'error', id: uid, message: 'stream failed: HTTP 403', recoverable: true })
    await t.settle()
    expect(t.catalog.failedMarks.map((m) => m.cacheKey)).toEqual(['t1#yt'])
    // not excluded on the retry, and the fresh URL is what plays
    expect((t.catalog.resolveCalls.filter((c) => c.trackId === "t1").at(-1)?.opts as { exclude?: string[] } | undefined)?.exclude).toEqual([])
    const [track] = t.engine.lastCall('setCurrent') as [EngineTrack]
    expect(track.id).toBe(uid)
    expect(track.source).toMatchObject({ url: 'https://cdn.example/t1/fresh.m4a' })
    expect(t.st().current?.id).toBe('t1')
    // the same file under a fresh URL is no backup
    expect(t.st().current?.source?.backupFor).toBeUndefined()
    expect(t.bc.of('notify').find((x) => x.title.includes('backup'))).toBeUndefined()
    // a second 403 on the same key is a real failure: skip on
    t.engine.emit({ type: 'error', id: uid, message: 'stream failed: HTTP 403', recoverable: true })
    await t.settle()
    expect(t.st().current?.id).toBe('t2')
  })

  it('when every source fails it notifies and skips to the next track', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    const uid = t.uidAt(0)
    t.engine.emit({ type: 'error', id: uid, message: 'decode error', recoverable: true })
    await t.settle()
    t.engine.emit({ type: 'error', id: uid, message: 'stalled', recoverable: true })
    await t.settle()
    expect(t.catalog.failedMarks.map((m) => m.cacheKey)).toEqual(['t1#a', 't1#b'])
    expect(t.st().current?.id).toBe('t2')
    expect((t.engine.lastCall('setCurrent')![0] as EngineTrack).id).toBe(t.uidAt(1))
    const n = t.bc.of('notify').find((x) => x.kind === 'error')
    expect(n?.title).toContain('Song 1')
  })

  it("when a track's own sources all fail, it asks the catalog once more (its fallback search) before skipping", async () => {
    const t = setup()
    const yt = httpSource('t1', 'yt', { provider: 'youtube' })
    const resolve = t.catalog.resolveSources.bind(t.catalog)
    // like the resolver: its fallback search runs only when none of the album's own sources is left
    t.catalog.resolveSources = async (id, opts) => (id === 't1' && ['t1#a', 't1#b'].every((k) => opts?.exclude?.includes(k)) ? [yt] : resolve(id, opts))
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    const uid = t.uidAt(0)
    t.engine.emit({ type: 'error', id: uid, message: 'decode error', recoverable: true })
    await t.settle()
    t.engine.emit({ type: 'error', id: uid, message: 'HTTP 404', recoverable: true })
    await t.settle()
    const [track] = t.engine.lastCall('setCurrent') as [EngineTrack]
    expect(track.id).toBe(uid)
    expect(track.source).toEqual(yt.source)
    expect(t.st().current?.id).toBe('t1')
    expect(t.bc.of('notify').find((x) => x.kind === 'error')).toBeUndefined()
    // and it says so: on the track, and in a notice
    expect(t.st().current?.source).toMatchObject({ provider: 'youtube', backupFor: { provider: 'khinsider', format: 'mp3', noAnswer: false } })
    const n = t.bc.of('notify').filter((x) => x.title.includes('backup'))
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ kind: 'info', title: '“Song 1” is playing from a backup', body: 'KHInsider’s MP3 couldn’t be played, so this is a backup copy from YouTube.' })
  })

  it("a server that didn't answer is tried last for the rest of the album: the others are asked for first", async () => {
    const t = setup()
    // An Internet Archive item on a storage server that's down: every track's file is in one folder.
    const ia = (id: string) => httpSource(id, 'ia', { provider: 'archive', source: { kind: 'http', url: `https://ia.example/items/ost/${id}.flac`, cacheKey: `${id}#ia` } })
    const yt = (id: string) => httpSource(id, 'yt', { provider: 'youtube' })
    for (const id of ['t1', 't2']) t.catalog.sources.set(id, [ia(id)])
    const resolve = t.catalog.resolveSources.bind(t.catalog)
    // like the resolver: its fallback search runs only when nothing of the album's own is left
    t.catalog.resolveSources = async (id, opts) => ((opts?.exclude ?? []).includes(`${id}#ia`) && id === 't2' ? [yt(id)] : resolve(id, opts))
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    t.engine.emit({ type: 'error', id: t.uidAt(0), message: 'stream stalled for 8s (timeout: connect)', recoverable: true })
    await t.settle()
    // t1 had nothing else; t2 doesn't wait on the same server first
    expect(t.st().current?.id).toBe('t2')
    const [track] = t.engine.lastCall('setCurrent') as [EngineTrack]
    expect(track.source).toEqual(yt('t2').source)
    expect(t.st().current?.source?.backupFor).toEqual({ provider: 'archive', format: 'mp3', noAnswer: true })
    expect(t.bc.of('notify').find((x) => x.title.includes('backup'))?.body).toBe('Internet Archive isn’t answering, so this is a backup copy from YouTube.')
    // still there as a last resort
    t.engine.emit({ type: 'error', id: t.uidAt(1), message: 'decode error', recoverable: true })
    await t.settle()
    expect((t.engine.lastCall('setCurrent') as [EngineTrack])[0].source).toEqual(ia('t2').source)
  })

  it("the preloaded next track on a server that stopped answering is looked for elsewhere while the current one plays", async () => {
    const t = setup()
    const ia = (id: string) => httpSource(id, 'ia', { provider: 'archive', source: { kind: 'http', url: `https://ia.example/items/ost/${id}.flac`, cacheKey: `${id}#ia` } })
    const yt = (id: string) => httpSource(id, 'yt', { provider: 'youtube' })
    for (const id of ['t1', 't2']) t.catalog.sources.set(id, [ia(id)])
    const resolve = t.catalog.resolveSources.bind(t.catalog)
    t.catalog.resolveSources = async (id, opts) => ((opts?.exclude ?? []).includes(`${id}#ia`) ? [yt(id)] : resolve(id, opts))
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    expect((t.engine.lastCall('setNext') as [EngineTrack])[0].source).toEqual(ia('t2').source) // armed before anyone knew
    t.engine.emit({ type: 'error', id: t.uidAt(0), message: 'stream stalled for 8s (no data)', recoverable: true })
    await t.settle()
    expect((t.engine.lastCall('setCurrent') as [EngineTrack])[0].source).toEqual(yt('t1').source)
    const [next] = t.engine.lastCall('setNext') as [EngineTrack]
    expect(next.id).toBe(t.uidAt(1))
    expect(next.source).toEqual(yt('t2').source)
    // gaplessly into t2: announced too, on the same card as t1's (one per failed source)
    t.engine.emit({ type: 'advanced', id: t.uidAt(1) })
    await t.settle()
    expect(t.st().current?.id).toBe('t2')
    expect(t.st().current?.source?.backupFor?.provider).toBe('archive')
    const cards = t.bc.of('notify').filter((x) => x.title.includes('backup'))
    expect(cards.map((c) => c.title)).toEqual(['“Song 1” is playing from a backup', '“Song 2” is playing from a backup'])
    expect(new Set(cards.map((c) => c.id)).size).toBe(1)
  })

  it('stops instead of skipping forever when nothing in the queue can play', async () => {
    const t = setup({ tracks: 4 })
    for (let i = 1; i <= 4; i++) t.catalog.sources.set(`t${i}`, [])
    await t.player.setRepeat('all')
    await t.player.playTracks(['t1', 't2', 't3', 't4'])
    await t.settle()
    expect(t.st().status).toBe('error')
    expect(t.st().error).toMatch(/4 tracks in a row/)
    expect(t.engine.callsOf('setCurrent')).toHaveLength(0)
    // each track was attempted once (plus at most one preload), not in a loop
    expect(t.catalog.resolveCalls.length).toBeLessThanOrEqual(8)
  })

  it('caps the skip streak on long queues', async () => {
    const t = setup({ tracks: 30 })
    for (let i = 1; i <= 30; i++) t.catalog.resolveErrors.set(`t${i}`, 'offline')
    await t.player.playTracks(Array.from({ length: 30 }, (_, i) => `t${i + 1}`))
    await t.settle()
    expect(t.st().status).toBe('error')
    expect(t.st().queueIndex).toBe(MAX_FAIL_STREAK - 1)
  })

  it('a downloaded file is the top source; remote sources are only resolved if it fails', async () => {
    const t = setup({ files: new Set(['/music/GHOST/Game One/t1.flac']) })
    t.library.noteDownloaded('t1', '/music/GHOST/Game One/t1.flac')
    await t.player.playTracks(['t1'])
    await t.settle()
    expect((t.engine.lastCall('setCurrent')![0] as EngineTrack).source).toEqual({ kind: 'file', path: '/music/GHOST/Game One/t1.flac', formatHint: 'flac' })
    expect(t.catalog.resolveCalls.filter((c) => c.trackId === 't1')).toHaveLength(0)
    expect(t.st().current?.downloaded).toBe(true)
    t.engine.emit({ type: 'error', id: t.uidAt(0), message: 'corrupt file', recoverable: true })
    await t.settle()
    expect((t.engine.lastCall('setCurrent')![0] as EngineTrack).source).toEqual(httpSource('t1', 'a').source)
    expect(t.catalog.failedMarks).toEqual([]) // our own file isn't reported to the catalog
  })

  it('a track loaded while paused, then resumed, falls back to another source playing; one paused stays paused', async () => {
    const t = setup()
    t.catalog.sources.set('t2', ['a', 'b', 'c'].map((x) => httpSource('t2', x)))
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    t.started()
    await t.player.pause()
    await t.player.next() // loads t2 paused
    await t.settle()
    expect(t.engine.lastCall('setCurrent')![2]).toBe(false)
    await t.player.play()
    t.started()
    t.engine.emit({ type: 'error', id: t.uidAt(1), message: 'HTTP 404', recoverable: true })
    await t.settle()
    let [track, , autoplay] = t.engine.lastCall('setCurrent') as [EngineTrack, number, boolean]
    expect(track.source).toEqual(httpSource('t2', 'b').source)
    expect(autoplay).toBe(true)
    expect(t.st().status).toBe('loading')
    // paused on purpose: the fallback waits paused
    t.started()
    await t.player.pause()
    t.engine.emit({ type: 'error', id: t.uidAt(1), message: 'HTTP 404', recoverable: true })
    await t.settle()
    ;[track, , autoplay] = t.engine.lastCall('setCurrent') as [EngineTrack, number, boolean]
    expect(track.source).toEqual(httpSource('t2', 'c').source)
    expect(autoplay).toBe(false)
    expect(t.st().status).toBe('paused')
  })

  it('a track that finished loading under a preview plays its fallback source once the preview is over', async () => {
    const t = setup()
    const g = gate()
    t.catalog.gate = g.wait
    await t.player.playTracks(['t1', 't2'])
    t.catalog.gate = null
    await t.player.preview('t5') // audible while t1 still resolves: holds it
    await flush()
    g.open()
    await t.settle()
    expect(t.engine.lastCall('setCurrent')![2]).toBe(false)
    t.engine.emit({ type: 'previewEnded', id: t.engine.previewing!.track.id })
    await t.settle()
    expect(t.st().status).toBe('playing')
    t.started()
    t.engine.emit({ type: 'error', id: t.uidAt(0), message: 'HTTP 404', recoverable: true })
    await t.settle()
    const [track, , autoplay] = t.engine.lastCall('setCurrent') as [EngineTrack, number, boolean]
    expect(track.source).toEqual(httpSource('t1', 'b').source)
    expect(autoplay).toBe(true)
  })

  /** Each loaded source reports its length (the header opened), then fails on its first packet. */
  async function failAfterMetadata(t: ReturnType<typeof setup>): Promise<void> {
    for (let i = 0; i < 40 && t.st().status !== 'error'; i++) {
      const id = t.engine.current!.id
      t.engine.emit({ type: 'trackInfo', id, durationMs: 180_000, sampleRate: 44100, channels: 2, codec: 'mp3', bitrateKbps: 320 })
      t.engine.emit({ type: 'error', id, message: 'decode error: invalid main_data_begin', recoverable: true })
      await t.settle()
    }
  }

  it('metadata is not playback: a repeating queue that never plays stops after one round', async () => {
    const t = setup({ tracks: 2 })
    await t.player.setRepeat('all')
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    await failAfterMetadata(t)
    expect(t.st().status).toBe('error')
    expect(t.st().error).toMatch(/2 tracks in a row/)
    // each of the two sources of each track, once
    expect(t.engine.callsOf('setCurrent')).toHaveLength(4)
  })

  it('metadata is not playback: the skip streak still caps a long queue', async () => {
    const t = setup({ tracks: 12 })
    for (let i = 1; i <= 12; i++) t.catalog.sources.set(`t${i}`, [httpSource(`t${i}`, 'a')])
    await t.player.playTracks(Array.from({ length: 12 }, (_, i) => `t${i + 1}`))
    await t.settle()
    await failAfterMetadata(t)
    expect(t.st().status).toBe('error')
    expect(t.st().queueIndex).toBe(MAX_FAIL_STREAK - 1)
  })
})

describe('engine events', () => {
  it('trackInfo, buffering, analysis and non-recoverable errors update the state', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    const uid = t.uidAt(0)
    t.started()
    t.engine.emit({ type: 'trackInfo', id: uid, durationMs: 200_500, sampleRate: 44100, channels: 2, codec: 'mp3', bitrateKbps: 320 })
    expect(t.st().durationMs).toBe(200_500)
    t.engine.emit({ type: 'buffering', id: uid, buffering: true })
    expect(t.st().status).toBe('buffering')
    t.engine.emit({ type: 'buffering', id: uid, buffering: false })
    expect(t.st().status).toBe('playing')
    const result = { integratedLufs: -12.5, loudnessRange: 5, truePeakDb: -0.5, bpm: 140, bpmConfidence: 0.9, beats: [0.5, 0.93], downbeats: [0.5], kiai: [[30, 60]] as [number, number][], energy: [0.1, 0.9], intensity: 5.5, durationMs: 200_500 }
    t.engine.emit({ type: 'analysis', id: uid, cacheKey: 't1#a', result })
    expect(t.catalog.recorded).toEqual([{ trackId: 't1', result }])
    expect(t.st().currentAnalysis?.bpm).toBe(140)
    expect(t.st().current?.analysis).toEqual({ bpm: 140, intensity: 5.5, lufs: -12.5 })
    // analysis of the preloaded next track is recorded too, without touching currentAnalysis
    t.engine.emit({ type: 'analysis', id: t.uidAt(1), cacheKey: 't2#a', result: { ...result, bpm: 90 } })
    expect(t.catalog.recorded[1].trackId).toBe('t2')
    expect(t.st().currentAnalysis?.bpm).toBe(140)
    t.engine.emit({ type: 'error', id: null, message: 'Output device lost', recoverable: false })
    expect(t.st().error).toBe('Output device lost')
    expect(t.bc.of('notify').some((n) => n.body === 'Output device lost')).toBe(true)
  })

  it('a looping track switched to Endless mid-play loses its length; a stream without one keeps the catalog\'s', async () => {
    const t = setup()
    await t.player.playTracks(['t1'])
    await t.settle()
    const uid = t.uidAt(0)
    t.started()
    const info = { type: 'trackInfo' as const, id: uid, sampleRate: 44100, channels: 2, codec: 'vgm', bitrateKbps: null }
    t.engine.emit({ ...info, durationMs: 130_000, loopStartMs: 10_000, loopEndMs: 70_000 })
    expect(t.st().durationMs).toBe(130_000)
    t.engine.emit({ ...info, durationMs: null, loopStartMs: 10_000, loopEndMs: 70_000 })
    expect(t.st().durationMs).toBeNull()
    t.engine.emit({ ...info, durationMs: 190_000, loopStartMs: 10_000, loopEndMs: 70_000 })
    expect(t.st().durationMs).toBe(190_000)
    // no loop points: an unknown length isn't endless
    t.engine.emit({ ...info, codec: 'mp3', durationMs: null })
    expect(t.st().durationMs).toBe(190_000)
  })

  it('chip voices: from trackInfo, masked on request, reset on every track change', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3'])
    await t.settle()
    const nes = ['Square 1', 'Square 2', 'Triangle', 'Noise', 'DMC']
    const info = (id: string, names?: string[]) =>
      t.engine.emit({ type: 'trackInfo', id, durationMs: 90_000, sampleRate: 44100, channels: 2, codec: 'nsf', bitrateKbps: null, ...(names ? { voiceCount: names.length, voiceNames: names } : {}) })
    expect(t.st().voices).toBeNull()
    await t.player.setVoiceMask('1') // nothing to mute yet
    expect(t.engine.callsOf('setVoiceMask')).toEqual([])
    t.started()
    info(t.uidAt(0), nes)
    expect(t.st().voices).toEqual({ names: nes, mask: '0' })
    await t.player.setVoiceMask('14') // 0b10100: Triangle + DMC
    expect(t.st().voices).toEqual({ names: nes, mask: '14' })
    expect(t.engine.lastCall('setVoiceMask')).toEqual([0b10100n])
    expect(t.bc.last('player:state')?.voices).toEqual({ names: nes, mask: '14' })
    // bits past the last voice are dropped; bad input unmutes
    await t.player.setVoiceMask('ff')
    expect(t.st().voices!.mask).toBe('1f')
    await t.player.setVoiceMask('NaN')
    expect(t.st().voices!.mask).toBe('0')
    await t.player.setVoiceMask('1')
    // the preloaded next track reports its voices before it plays; a gapless advance resets the mask
    const gb = ['Square 1', 'Square 2', 'Wave', 'Noise']
    info(t.uidAt(1), gb)
    expect(t.st().voices!.names).toEqual(nes)
    t.engine.finishCurrent()
    expect(t.st().current?.id).toBe('t2')
    expect(t.st().voices).toEqual({ names: gb, mask: '0' })
    expect(t.engine.voiceMask).toBe(0n)
    // a track without voices (e.g. an mp3)
    await t.player.setVoiceMask('3')
    await t.player.next()
    await t.settle()
    expect(t.st().voices).toBeNull()
    expect(t.engine.voiceMask).toBe(0n)
    info(t.uidAt(2))
    expect(t.st().voices).toBeNull()
    // a fallback source that turns out to have voices
    info(t.uidAt(2), ['DSP 1', 'DSP 2'])
    expect(t.st().voices).toEqual({ names: ['DSP 1', 'DSP 2'], mask: '0' })
    // clearing the queue drops them
    await t.player.clearQueue()
    await t.player.removeFromQueue([t.uidAt(0)])
    expect(t.st().voices).toBeNull()
  })

  it('chip voices: every one of 64 tracker channels is muted on its own, exactly', async () => {
    const t = setup()
    await t.player.playTracks(['t1'])
    await t.settle()
    t.started()
    const names = Array.from({ length: 70 }, (_, i) => `Channel ${i + 1}`)
    t.engine.emit({ type: 'trackInfo', id: t.uidAt(0), durationMs: 90_000, sampleRate: 44100, channels: 2, codec: 'it', bitrateKbps: null, voiceCount: 70, voiceNames: names })
    // the engine's mask has 64 bits: no pills it can't mute
    expect(t.st().voices!.names).toEqual(names.slice(0, 64))
    for (const ch of [1, 31, 32, 33, 64]) {
      await t.player.setVoiceMask(formatVoiceMask(voiceBit(ch - 1)))
      expect(t.engine.voiceMask, `channel ${ch}`).toBe(2n ** BigInt(ch - 1))
      expect(parseVoiceMask(t.st().voices!.mask), `channel ${ch}`).toBe(2n ** BigInt(ch - 1))
    }
    // solo channel 33: all 63 others muted
    await t.player.setVoiceMask(formatVoiceMask(allVoices(64) & ~voiceBit(32)))
    expect(t.engine.voiceMask).toBe(0xfffffffeffffffffn)
    expect(t.st().voices!.mask).toBe('fffffffeffffffff')
    await t.player.setVoiceMask('0')
    expect(t.engine.voiceMask).toBe(0n)
    // wider than the engine's mask: not a mask, so nothing is muted
    await t.player.setVoiceMask(formatVoiceMask(voiceBit(40)))
    await t.player.setVoiceMask('1' + '0'.repeat(16))
    expect(t.engine.voiceMask).toBe(0n)
    expect(t.st().voices!.mask).toBe('0')
  })

  it('heartbeat broadcasts a fresh position while playing', async () => {
    const t = setup()
    await t.player.playTracks(['t1'])
    await t.settle()
    t.started()
    await flush()
    t.bc.clear()
    t.engine.posMs = 12_345
    t.player.tick()
    await flush()
    const s = t.bc.last('player:state')!
    expect(s.positionMs).toBe(12_345)
    expect(Math.abs(s.positionAt - Date.now())).toBeLessThan(1000)
    await t.player.pause()
    await flush()
    t.bc.clear()
    t.player.tick()
    await flush()
    expect(t.bc.of('player:state')).toHaveLength(0)
  })

  it('sends the queue only when it changed (queueRev names it)', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3'])
    await t.settle()
    t.started()
    await flush()
    // (loading may replace items, e.g. with the resolved source: the latest queue sent wins)
    const first = t.bc.of('player:state').filter((s) => s.queue).pop()!
    expect(first.queue!.map((q) => q.track.id)).toEqual(['t1', 't2', 't3'])
    const rev = first.queueRev!
    expect(t.player.snapshot().queueRev).toBe(rev)
    // heartbeat / volume: no queue, same revision
    t.bc.clear()
    t.player.tick()
    await t.player.setVolume(0.5)
    await flush()
    for (const s of t.bc.of('player:state')) {
      expect(s.queue).toBeUndefined()
      expect(s.queueRev).toBe(rev)
    }
    expect(t.bc.of('player:state').length).toBeGreaterThan(0)
    // a queue change: sent once, with a new revision
    t.bc.clear()
    await t.player.enqueue(['t4'], 'end')
    await flush()
    const changed = t.bc.of('player:state')
    expect(changed[0].queue!.map((q) => q.track.id)).toEqual(['t1', 't2', 't3', 't4'])
    expect(changed[0].queueRev).toBeGreaterThan(rev)
    // getState() always carries the full queue
    const full = await t.player.getState()
    expect(full.queue).toHaveLength(4)
    expect(full.queueRev).toBe(changed[0].queueRev)
  })

  it('heartbeat re-sends the position only when the renderer extrapolation drifts (or the keepalive is due)', async () => {
    const t = setup()
    t.engine.clock = () => t.clock.t
    await t.player.playTracks(['t1'])
    await t.settle()
    t.started()
    await flush()
    t.bc.clear()
    // steady playback: the renderer's positionMs + elapsed is right, nothing to send
    for (let i = 0; i < 5; i++) {
      t.clock.t += 1000
      t.engine.posMs += 1000
      t.player.tick()
      await flush()
    }
    expect(t.bc.of('player:state')).toHaveLength(0)
    // a jump (loop point, stall): sent
    t.clock.t += 1000
    t.engine.posMs = 2_000
    t.player.tick()
    await flush()
    expect(t.bc.of('player:state').map((s) => s.positionMs)).toEqual([2_000])
    // keepalive
    t.bc.clear()
    for (let i = 0; i < HEARTBEAT_KEEPALIVE_MS / 1000; i++) {
      t.clock.t += 1000
      t.engine.posMs += 1000
      t.player.tick()
      await flush()
    }
    expect(t.bc.of('player:state')).toHaveLength(1)
  })

  it('heartbeat sends a status the engine fixed up (missed state event)', async () => {
    const t = setup()
    t.engine.clock = () => t.clock.t
    await t.player.playTracks(['t1'])
    await t.settle()
    expect(t.st().status).toBe('loading')
    t.bc.clear()
    t.engine.playing = true // the 'playing' state event never arrived
    t.player.tick()
    await flush()
    expect(t.bc.last('player:state')?.status).toBe('playing')
  })

  it('runs the heartbeat timer only while something plays', async () => {
    const t = setup({ heartbeatMs: 60_000 })
    const timer = () => (t.player as unknown as { heartbeat: unknown }).heartbeat
    expect(timer()).toBeNull()
    await t.player.playTracks(['t1'])
    expect(timer()).not.toBeNull() // loading
    await t.settle()
    t.started()
    expect(timer()).not.toBeNull()
    await t.player.pause()
    expect(timer()).toBeNull()
    await t.player.play()
    expect(timer()).not.toBeNull()
    t.player.dispose()
    expect(timer()).toBeNull()
  })

  it('coalesces rapid volume echoes but never delays a status change', async () => {
    const t = setup({ echoIntervalMs: 250 })
    await t.player.playTracks(['t1'])
    await t.settle()
    t.started()
    await flush()
    await new Promise((r) => setTimeout(r, 260)) // past the interval since the last broadcast
    t.bc.clear()
    for (let i = 1; i <= 10; i++) await t.player.setVolume(i / 20)
    await flush()
    // the first echo goes out at once, the rest wait for the interval
    expect(t.bc.of('player:state').map((s) => s.volume)).toEqual([0.05])
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    expect(t.bc.of('player:state').map((s) => s.volume)).toEqual([0.05, 0.5])
    // the engine got every step
    expect(t.engine.callsOf('setVolumeDb')).toHaveLength(10)
    // a status change while an echo is pending goes out immediately (and carries the latest volume)
    t.bc.clear()
    await t.player.setVolume(0.6)
    await t.player.setVolume(0.7)
    await t.player.pause()
    await flush()
    const sent = t.bc.of('player:state')
    expect(sent.at(-1)).toMatchObject({ status: 'paused', volume: 0.7 })
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    expect(t.bc.of('player:state').length).toBe(sent.length)
  })

  it('does not re-send the queue when a replayed track keeps its source', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    t.started()
    await flush()
    expect(t.st().queue[0].track.source?.provider).toBe('khinsider')
    t.bc.clear()
    await t.player.jumpTo(0)
    await t.settle()
    t.started()
    await flush()
    expect(t.bc.of('player:state').length).toBeGreaterThan(0)
    expect(t.bc.of('player:state').some((s) => s.queue)).toBe(false)
  })

  it('asks the catalog to pre-resolve the next two (not downloaded) tracks when a queue starts', async () => {
    const t = setup({ tracks: 5 })
    await t.player.playTracks(['t1', 't2', 't3', 't4', 't5'], 1)
    expect(t.catalog.warmed).toEqual([['t3', 't4']])
    // the start track's own resolve went out first
    expect(t.catalog.resolveCalls[0].trackId).toBe('t2')
    await t.settle()
    // a downloaded track needs no warming; the end of the queue is the end
    t.catalog.warmed.length = 0
    t.files.add('/dl/t5.mp3')
    t.library.noteDownloaded('t5', '/dl/t5.mp3')
    await t.player.playTracks(['t3', 't4', 't5'], 1)
    expect(t.catalog.warmed).toEqual([])
    await t.player.playTracks(['t1', 't5', 't2'], 0)
    expect(t.catalog.warmed).toEqual([['t2']])
  })

  it('does not let a stale engine position undo a seek', async () => {
    const t = setup()
    await t.player.playTracks(['t1'])
    await t.settle()
    t.started()
    t.engine.posMs = 5_000
    t.engine.seek = () => {} // engine applies the seek asynchronously
    await t.player.seek(90_000)
    await flush()
    expect(t.bc.last('player:state')!.positionMs).toBe(90_000)
  })
})

describe('history', () => {
  const plays = (t: ReturnType<typeof setup>) => t.db.prepare('SELECT track_id, ms_played FROM history ORDER BY id').all() as { track_id: string; ms_played: number }[]

  it('records a play after 30 s of actual playback', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    t.started()
    t.clock.t += HISTORY_MIN_MS - 1000
    t.player.tick()
    expect(plays(t)).toHaveLength(0)
    await t.player.pause()
    t.clock.t += 60_000 // paused time doesn't count
    t.player.tick()
    expect(plays(t)).toHaveLength(0)
    await t.player.play()
    t.clock.t += 1000
    t.player.tick()
    expect(plays(t)).toEqual([{ track_id: 't1', ms_played: HISTORY_MIN_MS }])
    expect(t.bc.of('library:changed')).toContainEqual({ kind: 'history', id: 't1' })
    t.clock.t += 20_000
    t.engine.finishCurrent() // advance: final ms_played is written
    expect(plays(t)).toEqual([{ track_id: 't1', ms_played: HISTORY_MIN_MS + 20_000 }])
  })

  it('records short tracks at 50 %', async () => {
    const t = setup({ tracks: 0 })
    t.catalog.addTracks(makeTrack('short', { durationMs: 40_000 }))
    await t.player.playTracks(['short'])
    await t.settle()
    t.started()
    t.clock.t += 19_000
    t.player.tick()
    expect(plays(t)).toHaveLength(0)
    t.clock.t += 1_000
    t.player.tick()
    expect(plays(t)).toHaveLength(1)
  })

  it('skipped tracks are not recorded', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    t.started()
    t.clock.t += 5_000
    await t.player.next()
    await t.settle()
    expect(plays(t)).toHaveLength(0)
  })

  /** A queue of `first` then `second`, with `first` audible for `ms`. */
  async function listened(first: { durationMs: number }, second: { durationMs: number }, ms: number) {
    const t = setup({ tracks: 0 })
    t.catalog.addTracks(makeTrack('first', { number: 1, ...first }), makeTrack('second', { number: 2, ...second }))
    await t.player.playTracks(['first', 'second'])
    await t.settle()
    t.started()
    t.clock.t += ms
    return t
  }

  it("leaving a track measures its play against its own length, not the next track's", async () => {
    const leave: [string, (t: Awaited<ReturnType<typeof listened>>) => Promise<void>][] = [
      ['next', (t) => t.player.next()],
      ['jump', (t) => t.player.jumpTo(1)],
      ['new queue', (t) => t.player.playTracks(['second'])],
      ['remove it', (t) => t.player.removeFromQueue([t.uidAt(0)])]
    ]
    for (const [how, go] of leave) {
      // 10 s of a 3 min track, then a 10 s one: not a play (its threshold is 30 s, not 5 s)
      let t = await listened({ durationMs: 180_000 }, { durationMs: 10_000 }, 10_000)
      await go(t)
      await t.settle()
      expect(plays(t), how).toEqual([])
      // 25 s of a 40 s track, then a long one: a play (half of it is 20 s, under 30 s)
      t = await listened({ durationMs: 40_000 }, { durationMs: 180_000 }, 25_000)
      await go(t)
      await t.settle()
      expect(plays(t), how).toEqual([{ track_id: 'first', ms_played: 25_000 }])
    }
  })

  it('the decoder-reported length of the played track is what counts', async () => {
    // the catalog says 3 min; the file is 20 s
    const t = await listened({ durationMs: 180_000 }, { durationMs: 180_000 }, 12_000)
    t.engine.emit({ type: 'trackInfo', id: t.uidAt(0), durationMs: 20_000, sampleRate: 44100, channels: 2, codec: 'mp3', bitrateKbps: 320 })
    await t.player.next()
    await t.settle()
    expect(plays(t)).toEqual([{ track_id: 'first', ms_played: 12_000 }])
  })
})

describe('session restore', () => {
  it('persists the queue and restores it paused at the saved position without loading audio', async () => {
    const session = new MemorySessionStore()
    const a = setup({ session })
    await a.player.setShuffle('on')
    await a.player.setRepeat('all')
    await a.player.setVolume(0.5)
    await a.player.playTracks(['t1', 't2', 't3', 't4'], 2)
    await a.settle()
    a.started()
    a.engine.posMs = 61_000
    a.player.saveNow()
    const saved = session.data!
    expect(saved.queue.map((q) => q.uid)).toEqual(a.st().queue.map((q) => q.uid))
    expect(saved.queueIndex).toBe(0)
    expect(saved.positionMs).toBe(61_000)
    expect(saved.volume).toBe(0.5)

    const b = setup({ session })
    await b.player.restore(session.load())
    const s = b.st()
    expect(s.status).toBe('paused')
    expect(s.queue.map((q) => q.uid)).toEqual(saved.queue.map((q) => q.uid))
    expect(s.current?.id).toBe('t3')
    expect(s.positionMs).toBe(61_000)
    expect(s.shuffle).toBe('on')
    expect(s.repeat).toBe('all')
    expect(s.volume).toBe(0.5)
    expect(b.engine.lastCall('setVolumeDb')).toEqual([sliderToDb(0.5)])
    expect(b.engine.callsOf('setCurrent')).toHaveLength(0)
    // shuffle off restores the original (pre-shuffle) order across restarts
    await b.player.setShuffle('off')
    expect(b.ids()).toEqual(['t1', 't2', 't3', 't4'])
    await b.player.play()
    await b.settle()
    const [track, startMs, autoplay] = b.engine.lastCall('setCurrent') as [EngineTrack, number, boolean]
    expect(track.id).toBe(saved.queue[0].uid)
    expect(startMs).toBe(61_000)
    expect(autoplay).toBe(true)
  })

  it('drops tracks that vanished from the catalog', async () => {
    const session = new MemorySessionStore()
    session.data = {
      v: 1,
      queue: [
        { uid: 'u1', trackId: 't1' },
        { uid: 'u2', trackId: 'gone' },
        { uid: 'u3', trackId: 't3' }
      ],
      originalOrder: null,
      queueIndex: 2,
      positionMs: 5000,
      shuffle: 'off',
      repeat: 'off',
      volume: 0.7,
      muted: true,
      context: null,
      savedAt: 0
    }
    const t = setup({ session })
    await t.player.restore(session.load())
    expect(t.st().queue.map((q) => q.uid)).toEqual(['u1', 'u3'])
    expect(t.st().queueIndex).toBe(1)
    expect(t.st().positionMs).toBe(5000)
    expect(t.st().muted).toBe(true)
    expect(t.engine.lastCall('setMuted')).toEqual([true])
  })

  it('a user action during restore wins over the restored session', async () => {
    const session = new MemorySessionStore()
    session.data = { v: 1, queue: [{ uid: 'u1', trackId: 't1' }], originalOrder: null, queueIndex: 0, positionMs: 0, shuffle: 'off', repeat: 'off', volume: 1, muted: false, context: null, savedAt: 0 }
    const t = setup({ session })
    const restoring = t.player.restore(session.load())
    await t.player.playTracks(['t4'])
    await restoring
    await t.settle()
    expect(t.ids()).toEqual(['t4'])
  })
})

describe('loading progress', () => {
  it('reports what a loading track waits on, from the catalog\'s steps to the engine, and nothing once it plays', async () => {
    const t = setup()
    let open!: () => void
    t.catalog.gate = new Promise((r) => (open = r))
    await t.player.playTracks(['t1', 't2'])
    expect(t.st().status).toBe('loading')
    expect(t.st().loading?.label).toBe('Finding a source')
    t.player.onResolveStep({ trackId: 't2', provider: 'youtube', providerName: 'YouTube', kind: 'stream', fraction: null })
    expect(t.st().loading?.label).toBe('Finding a source') // another track (a warm-up): not ours
    t.player.onResolveStep({ trackId: 't1', provider: 'youtube', providerName: 'YouTube', kind: 'stream', fraction: null })
    expect(t.st().loading).toMatchObject({ label: 'Getting the stream from YouTube', fraction: null })
    expect(t.st().loading?.expectMs).toBeGreaterThan(1000)
    t.player.onResolveStep({ trackId: 't1', provider: 'khinsider', providerName: 'KHInsider', kind: 'stream', fraction: null })
    t.catalog.gate = null
    open()
    await t.settle()
    // The fake catalog's sources are KHInsider's.
    expect(t.st().loading?.label).toBe('Connecting to KHInsider')
    const wait = t.st().loading?.wait
    t.started()
    expect(t.st().loading).toBeNull()
    // A stall later is a new wait.
    t.engine.emit({ type: 'buffering', id: t.engine.current!.id, buffering: true })
    expect(t.st().status).toBe('buffering')
    expect(t.st().loading?.label).toBe('Buffering')
    expect(t.st().loading?.wait).not.toBe(wait)
    t.engine.emit({ type: 'buffering', id: t.engine.current!.id, buffering: false })
    expect(t.st().loading).toBeNull()
  })

  it('a source failing mid-track says a backup is being looked for, and why', async () => {
    const t = setup()
    await t.player.playTracks(['t1'])
    await t.settle()
    t.started()
    let open!: () => void
    t.catalog.gate = new Promise((r) => (open = r))
    t.engine.emit({ type: 'error', id: t.engine.current!.id, message: 'stream failed: HTTP 500', recoverable: true })
    expect(t.st().status).toBe('loading')
    expect(t.st().loading).toMatchObject({ label: 'Looking for a backup', detail: 'KHInsider’s MP3 couldn’t be played' })
    t.catalog.gate = null
    open()
    await t.settle()
  })

  it('a preview reports its loading until it was handed to the engine', async () => {
    const t = setup()
    let open!: () => void
    t.catalog.gate = new Promise((r) => (open = r))
    const p = t.player.preview('t3')
    await flush()
    expect(t.st().previewLoading).toMatchObject({ trackId: 't3', label: 'Finding a source' })
    expect(t.st().preview).toBeNull()
    t.player.onResolveStep({ trackId: 't3', provider: 'khinsider', providerName: 'KHInsider', kind: 'stream', fraction: null })
    expect(t.st().previewLoading?.label).toBe('Getting the track from KHInsider')
    t.catalog.gate = null
    open()
    await p
    await t.settle()
    expect(t.st().preview?.track.id).toBe('t3')
    await t.player.stopPreview()
    expect(t.st().previewLoading).toBeNull()
  })
})

describe('volume, loop mode, previews, devices', () => {
  it('maps the volume slider to dB and persists it', async () => {
    const t = setup()
    await t.player.setVolume(0.25)
    expect(t.engine.lastCall('setVolumeDb')).toEqual([sliderToDb(0.25)])
    expect(t.st().volume).toBe(0.25)
    await t.settle()
    await new Promise((r) => setTimeout(r, 5))
    expect(t.session.data?.volume).toBe(0.25)
    await t.player.setVolume(7)
    expect(t.st().volume).toBe(1)
  })

  it('setLoopMode persists through settings and is reflected in the state', async () => {
    const t = setup()
    await t.player.setLoopMode('endless')
    expect(t.settings.audio.loopMode).toBe('endless')
    expect(t.st().loopMode).toBe('endless')
  })

  it('previews start at 35 % (or the first kiai section) and clear on stop/previewEnded', async () => {
    const t = setup()
    await t.player.preview('t2')
    await t.settle()
    expect(t.engine.previewing?.startMs).toBe(Math.round(180_000 * 0.35))
    expect(t.st().preview?.track.id).toBe('t2')
    await t.player.stopPreview()
    expect(t.engine.callsOf('stopPreview')).toHaveLength(1)
    expect(t.st().preview).toBeNull()
    t.catalog.analyses.set('t3', { lufs: -14, truePeakDb: -1, bpm: 120, beats: [], downbeats: [], kiai: [[48.25, 70]], energy: [], intensity: 4 })
    await t.player.preview('t3')
    await t.settle()
    expect(t.engine.previewing?.startMs).toBe(48_250)
    t.engine.emit({ type: 'previewEnded' })
    expect(t.st().preview).toBeNull()
    await t.player.preview('t4', 1234)
    await t.settle()
    expect(t.engine.previewing?.startMs).toBe(1234)
  })

  it('only the latest of rapid previews plays', async () => {
    const t = setup()
    let open!: () => void
    t.catalog.gate = new Promise((r) => (open = r))
    const p1 = t.player.preview('t1')
    const p2 = t.player.preview('t2')
    open()
    await Promise.all([p1, p2])
    await t.settle()
    expect(t.engine.callsOf('preview')).toHaveLength(1)
    expect(t.st().preview?.track.id).toBe('t2')
  })

  it('an older preview resolving while a newer one still fetches its track never plays', async () => {
    const t = setup()
    let resolveA!: () => void
    t.catalog.gate = new Promise((r) => (resolveA = r))
    const p1 = t.player.preview('t1', 1000)
    await flush() // t1 is resolving (gated)
    let tracksB!: () => void
    t.catalog.tracksGate = new Promise((r) => (tracksB = r))
    const p2 = t.player.preview('t2', 2000) // fetching its track (gated)
    await flush()
    t.catalog.gate = null
    resolveA() // t1's sources land: it has been superseded
    await flush()
    expect(t.engine.callsOf('preview')).toHaveLength(0)
    t.catalog.tracksGate = null
    tracksB()
    await Promise.all([p1, p2])
    await t.settle()
    const calls = t.engine.callsOf('preview') as [EngineTrack, number][]
    expect(calls.map(([track, start]) => [track.id.split(':').pop(), start])).toEqual([['t2', 2000]])
    expect(t.st().preview?.track.id).toBe('t2')
  })

  it('resuming the queue ends a preview: never two songs at once', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    t.started()
    await t.player.pause()
    await t.player.preview('t4')
    await t.settle()
    expect(t.st().preview?.track.id).toBe('t4')
    expect(t.engine.callsOf('pause')).toHaveLength(1) // only the user's pause: the queue was already paused
    await t.player.toggle()
    expect(t.engine.callsOf('stopPreview')).toHaveLength(1)
    expect(t.engine.previewing).toBeNull()
    expect(t.st().preview).toBeNull()
    expect(t.st().status).toBe('playing')
    // The preview's fade-out ending afterwards changes nothing.
    t.engine.emit({ type: 'previewEnded', id: (t.engine.lastCall('preview') as [EngineTrack])[0].id })
    expect(t.st().status).toBe('playing')
    expect(t.engine.callsOf('pause')).toHaveLength(1)
  })

  it('a preview pauses an audible queue and resumes it when it ends', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    t.started()
    await t.player.preview('t4')
    await t.settle()
    expect(t.engine.callsOf('pause')).toHaveLength(1)
    expect(t.st().status).toBe('paused')
    expect(t.st().preview?.track.id).toBe('t4')
    // Natural end (the 30 s limit): the queue picks up where it was.
    t.engine.emit({ type: 'previewEnded', id: t.engine.previewing!.track.id })
    await t.settle()
    expect(t.st().preview).toBeNull()
    expect(t.st().status).toBe('playing')
    expect(t.engine.callsOf('play')).toHaveLength(1)
    // Stopped by hand (P again, moving away): same.
    await t.player.preview('t5')
    await t.settle()
    expect(t.st().status).toBe('paused')
    await t.player.stopPreview()
    await t.settle()
    expect(t.st().status).toBe('playing')
    expect(t.engine.callsOf('play')).toHaveLength(2)
  })

  it('pausing during a preview keeps the queue paused after it; skipping plays the next track', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3'])
    await t.settle()
    t.started()
    await t.player.preview('t4')
    await t.settle()
    await t.player.pause()
    t.engine.emit({ type: 'previewEnded', id: t.engine.previewing!.track.id })
    await t.settle()
    expect(t.st().status).toBe('paused')
    expect(t.engine.callsOf('play')).toHaveLength(0)

    await t.player.play()
    t.started()
    await t.player.preview('t5')
    await t.settle()
    expect(t.st().status).toBe('paused')
    await t.player.next() // the queue was only paused for the preview: the skip plays
    await t.settle()
    expect(t.engine.previewing).toBeNull()
    expect(t.st().preview).toBeNull()
    const [track, , autoplay] = t.engine.lastCall('setCurrent') as [EngineTrack, number, boolean]
    expect(track.id).toBe(t.uidAt(1))
    expect(autoplay).toBe(true)
  })

  it('a queue still loading (to play) waits for the preview to end', async () => {
    const t = setup()
    await t.player.preview('t4')
    await t.settle()
    let open!: () => void
    t.catalog.gate = new Promise((r) => (open = r))
    await t.player.playTracks(['t1'])
    // Playing the queue ended the preview.
    expect(t.engine.previewing).toBeNull()
    expect(t.st().preview).toBeNull()
    // A preview requested while it still resolves holds it back.
    t.catalog.gate = null
    await t.player.preview('t5')
    await flush()
    open()
    await t.settle()
    expect(t.st().preview?.track.id).toBe('t5')
    expect(t.engine.lastCall('setCurrent')?.[2]).toBe(false)
    expect(t.st().status).toBe('paused')
    await t.player.stopPreview()
    await t.settle()
    expect(t.st().status).toBe('playing')
  })

  it('a track ending on its own while a preview loads does not cancel the preview', async () => {
    const t = setup()
    await t.player.playTracks(['t1', 't2'])
    await t.settle()
    t.started()
    let open!: () => void
    t.catalog.gate = new Promise((r) => (open = r))
    const p = t.player.preview('t4') // P pressed; still resolving
    await flush()
    t.catalog.gate = null
    t.engine.finishCurrent() // t1 ends: t2 plays
    await t.settle()
    open()
    expect(await p).toBe(true)
    await t.settle()
    expect(t.st().preview?.track.id).toBe('t4')
    expect(t.st().queueIndex).toBe(1)
    expect(t.st().status).toBe('paused') // held for the preview
    await t.player.stopPreview()
    expect(t.st().status).toBe('playing')
  })

  it('ignores the end of a preview a newer one already replaced', async () => {
    const t = setup()
    await t.player.preview('t2')
    await t.settle()
    const first = t.engine.previewing!.track.id
    await t.player.preview('t3')
    await t.settle()
    t.engine.emit({ type: 'previewEnded', id: first })
    expect(t.st().preview?.track.id).toBe('t3')
  })

  it('a preview with nothing playable silences the one it replaced', async () => {
    const t = setup()
    await t.player.playTracks(['t1'])
    await t.settle()
    t.started()
    await t.player.preview('t2')
    await t.settle()
    expect(t.st().status).toBe('paused')
    t.catalog.sources.set('t3', [])
    expect(await t.player.preview('t3')).toBe(false)
    await t.settle()
    expect(t.engine.previewing).toBeNull()
    expect(t.st().preview).toBeNull()
    expect(t.st().status).toBe('playing')
  })

  it('passes the overlay filter through and lists devices', async () => {
    const t = setup()
    await t.player.setOverlayFilter(true)
    expect(t.engine.lastCall('setOverlayFilter')).toEqual([true])
    expect((await t.player.devices()).map((d) => d.id)).toEqual(['default', 'dac'])
  })

  it('liking a queued track updates the queue items', async () => {
    const t = setup()
    t.library.onTracksChanged((ids) => t.player.refreshTracks(ids))
    await t.player.playTracks(['t1', 't2', 't1'])
    await t.settle()
    t.library.toggleLike('t1')
    expect(t.st().queue.map((q) => q.track.liked)).toEqual([true, false, true])
    expect(t.st().current?.liked).toBe(true)
  })

  /** Queue t1, t2, t3 playing, held by a preview of t4; the next preview's track lookup waits on `g`. */
  async function heldByPreview() {
    const t = setup()
    await t.player.playTracks(['t1', 't2', 't3'])
    await t.settle()
    t.started()
    await t.player.preview('t4')
    await t.settle()
    expect(t.st().status).toBe('paused')
    const g = gate()
    t.catalog.tracksGate = g.wait
    const older = t.engine.previewing!.track.id
    return { ...t, g, older }
  }

  it('the old preview ending while a newer one still fetches its track leaves the queue held for the newer one', async () => {
    const t = await heldByPreview()
    const newer = t.player.preview('t5')
    await flush()
    t.engine.emit({ type: 'previewEnded', id: t.older }) // t4 ran out first
    await flush()
    expect(t.st().status).toBe('paused')
    t.catalog.tracksGate = null
    t.g.open()
    expect(await newer).toBe(true)
    await t.settle()
    expect(t.st().preview?.track.id).toBe('t5')
    expect(t.st().status).toBe('paused')
    expect(t.engine.callsOf('play')).toHaveLength(0)
    // and when that one ends, the queue picks up again
    t.engine.emit({ type: 'previewEnded', id: t.engine.previewing!.track.id })
    await t.settle()
    expect(t.st().status).toBe('playing')
    expect(t.engine.callsOf('play')).toHaveLength(1)
  })

  it('…and the same while the newer one resolves its source', async () => {
    const t = await heldByPreview()
    t.catalog.tracksGate = null
    const sources = gate()
    t.catalog.gate = sources.wait
    const newer = t.player.preview('t5')
    await flush()
    t.engine.emit({ type: 'previewEnded', id: t.older })
    await flush()
    expect(t.st().status).toBe('paused')
    t.catalog.gate = null
    sources.open()
    expect(await newer).toBe(true)
    await t.settle()
    expect(t.st().preview?.track.id).toBe('t5')
    expect(t.engine.callsOf('play')).toHaveLength(0)
  })

  it('…but stopping previews still cancels it, and one that finds no track gives the queue back', async () => {
    let t = await heldByPreview()
    let newer = t.player.preview('t5')
    await flush()
    t.engine.emit({ type: 'previewEnded', id: t.older })
    await t.player.stopPreview()
    expect(t.st().status).toBe('playing')
    t.catalog.tracksGate = null
    t.g.open()
    expect(await newer).toBe(false)
    await t.settle()
    expect(t.st().preview).toBeNull()
    expect(t.engine.callsOf('preview')).toHaveLength(1)

    t = await heldByPreview()
    newer = t.player.preview('gone')
    await flush()
    t.engine.emit({ type: 'previewEnded', id: t.older })
    t.catalog.tracksGate = null
    t.g.open()
    expect(await newer).toBe(false)
    await t.settle()
    expect(t.st().status).toBe('playing')
  })

  it('removing the current item while a preview holds the queue plays the next one after the preview', async () => {
    const t = await heldByPreview()
    t.catalog.tracksGate = null
    await t.player.removeFromQueue([t.uidAt(0)])
    await t.settle()
    expect(t.st().current?.id).toBe('t2')
    // one song at a time: it waits, loaded, while the preview plays on
    expect(t.engine.lastCall('setCurrent')![2]).toBe(false)
    expect(t.engine.previewing?.track.id).toBe(t.older)
    expect(t.st().status).toBe('paused')
    t.engine.emit({ type: 'previewEnded', id: t.older })
    await t.settle()
    expect(t.st().status).toBe('playing')
    expect(t.engine.callsOf('play')).toHaveLength(1)
  })

  it('removing the current item after pausing during a preview leaves the next one paused', async () => {
    const t = await heldByPreview()
    t.catalog.tracksGate = null
    await t.player.pause()
    await t.player.removeFromQueue([t.uidAt(0)])
    await t.settle()
    expect(t.st().current?.id).toBe('t2')
    t.engine.emit({ type: 'previewEnded', id: t.older })
    await t.settle()
    expect(t.st().status).toBe('paused')
    expect(t.engine.callsOf('play')).toHaveLength(0)
  })
})
