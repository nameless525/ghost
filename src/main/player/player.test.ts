import { afterEach, describe, expect, it } from 'vitest'
import type { Settings } from '../../shared/types'
import type { EngineTrack } from '../engine/types'
import { sliderToDb } from '../engine/types'
import { createLibrary } from '../library'
import { HISTORY_MIN_MS, MAX_FAIL_STREAK, Player } from './player'
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

function setup(opts: { seed?: number; session?: MemorySessionStore; tracks?: number; files?: Set<string> } = {}) {
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
    heartbeatMs: 0,
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
})
