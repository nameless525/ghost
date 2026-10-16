import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisFrame, PlayerState, TrackAnalysis, TrackView } from '@shared/types'
import type { BeatEvent } from './beat'

const h = vi.hoisted(() => ({ frame: null as AnalysisFrame | null, tick: null as ((dt: number, now: number) => void) | null }))
vi.mock('./frame', () => ({ frame: () => h.frame }))
vi.mock('./ticker', () => ({
  TickPriority: { audio: 0, normal: 1 },
  ticker: {
    add: (fn: (dt: number, now: number) => void) => {
      h.tick = fn
      return () => (h.tick = null)
    }
  }
}))

const track = (id: string, bpm: number | null = null) => ({ id, title: id, analysis: bpm ? { bpm, intensity: null, lufs: null } : null }) as unknown as TrackView
/** A 120 BPM grid, a beat every 500 ms for a minute. */
const grid: TrackAnalysis = {
  lufs: null,
  truePeakDb: null,
  bpm: 120,
  beats: Array.from({ length: 120 }, (_, i) => i * 0.5),
  downbeats: Array.from({ length: 30 }, (_, i) => i * 2),
  kiai: [],
  energy: [],
  intensity: null
}
const onsetFrame = (onset: number) => ({ bands: new Float32Array(96), waveform: new Float32Array(512), rms: 0.3, peak: 0.5, onset, positionMs: 0, trackSeq: 1 }) as AnalysisFrame

let now = 0
let events: BeatEvent[] = []
let setPlayer: (s: Partial<PlayerState>) => void

async function clock() {
  vi.resetModules()
  const { usePlayer } = await import('../state/player')
  const { BeatClock } = await import('./beat')
  setPlayer = (s) => usePlayer.setState(s)
  const beat = new BeatClock()
  beat.onBeat((e) => events.push(e))
  return beat
}

/** Run `ms` of frames; `onset` gives each frame's onset strength. */
function run(ms: number, onset: (t: number) => number = () => 0.05) {
  for (const end = now + ms; now < end; ) {
    now += 16
    h.frame = onsetFrame(onset(now))
    h.tick!(16, now)
  }
}

/** Onset peaks every 500 ms. */
const peaks = (t: number) => (t % 500 < 16 ? 1 : 0.05)

describe('beat clock voice', () => {
  beforeEach(() => {
    now = 0
    events = []
    h.frame = null
  })

  it('an audible preview pulses even when the queue it holds has a beat grid', async () => {
    const beat = await clock()
    // an analysed queue track, paused for the preview (positionAt in the future: no extrapolation)
    setPlayer({ status: 'paused', current: track('queue'), currentAnalysis: grid, positionMs: 30_000, positionAt: 1e15, preview: { track: track('preview'), startedAt: 0 } })
    run(3000, peaks)
    expect(events.length).toBeGreaterThanOrEqual(4)
    expect(events.every((e) => e.fromOnset)).toBe(true)
    expect(beat.playing).toBe(true)
  })

  it('a preview loading while the queue plays leaves the queue on its grid', async () => {
    const beat = await clock()
    setPlayer({ status: 'playing', current: track('queue'), currentAnalysis: grid, positionMs: 10_000, positionAt: 1e15, preview: { track: track('preview'), startedAt: 0 } })
    run(16)
    for (let pos = 10_000; pos <= 12_000; pos += 16) {
      setPlayer({ positionMs: pos })
      run(16, peaks)
    }
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events.every((e) => !e.fromOnset)).toBe(true)
    expect(beat.bpm).toBe(120)
  })

  it('uses the preview’s tempo when its analysis has one', async () => {
    await clock()
    setPlayer({ status: 'paused', current: null, currentAnalysis: null, preview: { track: track('preview', 150), startedAt: 0 } })
    run(3000, peaks)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.bpm === 150 && Math.abs(e.beatLength - 400) < 1e-9)).toBe(true)
  })

  it('back on the queue after the preview: its grid, its tempo, no carried-over beat', async () => {
    const beat = await clock()
    setPlayer({ status: 'paused', current: track('queue'), currentAnalysis: grid, positionMs: 20_000, positionAt: 1e15, preview: { track: track('preview'), startedAt: 0 } })
    // onsets every 300 ms (in 16 ms frames): an estimate near 200 BPM
    run(4000, (t) => (t % 300 < 16 ? 1 : 0.05))
    expect(beat.bpm).toBeGreaterThan(190)
    // the preview ends and hands playback back
    events = []
    setPlayer({ status: 'playing', preview: null, positionMs: 20_100 })
    run(16)
    expect(events).toHaveLength(0)
    expect(beat.bpm).toBe(120)
    setPlayer({ positionMs: 20_520 })
    run(16)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ fromOnset: false, index: 41, downbeat: false })
  })
})
