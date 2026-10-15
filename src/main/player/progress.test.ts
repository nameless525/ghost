import { describe, expect, it } from 'vitest'
import { RESOLVE_END, Typical, WaitTracker, formatBytes, formatBytesOf, type EngineWait } from './progress'

const wait = (over: Partial<EngineWait> = {}): EngineWait => ({
  started: false,
  connected: true,
  bytes: 0,
  totalBytes: null,
  wholeFile: false,
  bufferedMs: 0,
  targetMs: 200,
  stalledMs: 0,
  stallTimeoutMs: 8000,
  ...over
})

function setup() {
  const clock = { t: 1_000_000 }
  const typical = new Typical()
  const w = new WaitTracker('u1:1', typical, () => clock.t)
  return { clock, typical, w }
}

describe('WaitTracker', () => {
  it('starts as an estimated "Finding a source" step on the resolve span', () => {
    const { w } = setup()
    const p = w.progress()
    expect(p.label).toBe('Finding a source')
    expect(p.fraction).toBeNull()
    expect(p.expectMs).toBeGreaterThan(0)
    expect(p.span).toEqual([0, RESOLVE_END])
    expect(p.wait).toBe('u1:1#0')
  })

  it('names the provider of each network step and learns how long they take', () => {
    const { clock, typical, w } = setup()
    expect(w.onResolveStep({ trackId: '1', provider: 'youtube', providerName: 'YouTube', kind: 'stream', fraction: null })).toBe(true)
    expect(w.progress().label).toBe('Getting the stream from YouTube')
    expect(w.progress().expectMs).toBe(Typical.defaultFor('stream:youtube'))
    clock.t += 3000
    w.opened('youtube')
    expect(w.progress().label).toBe('Connecting to YouTube')
    expect(w.progress().span).toEqual([RESOLVE_END, 1])
    // The first measurement replaces the default; later ones are averaged in.
    expect(typical.get('stream:youtube')).toBe(3000)
  })

  it('a search step says what it searches; a measured step reports its fraction', () => {
    const { w } = setup()
    w.onResolveStep({ trackId: '1', provider: 'soundcloud', providerName: 'SoundCloud', kind: 'search', fraction: null })
    expect(w.progress().label).toBe('Searching SoundCloud for this track')
    w.onResolveStep({ trackId: '1', provider: 'soundcloud', providerName: 'SoundCloud', kind: 'stream', fraction: 0.25, detail: '1.0 of 4.0 MB' })
    expect(w.progress()).toMatchObject({ label: 'Downloading from SoundCloud', fraction: 0.25, expectMs: null, detail: '1.0 of 4.0 MB' })
    // Same step, more bytes: updates in place.
    expect(w.onResolveStep({ trackId: '1', provider: 'soundcloud', providerName: 'SoundCloud', kind: 'stream', fraction: 0.5, detail: '2.0 of 4.0 MB' })).toBe(true)
    expect(w.progress().fraction).toBe(0.5)
    expect(w.onResolveStep({ trackId: '1', provider: 'soundcloud', providerName: 'SoundCloud', kind: 'stream', fraction: 0.5, detail: '2.0 of 4.0 MB' })).toBe(false)
  })

  it('successive resolve steps move forward on the bar', () => {
    const { w } = setup()
    const s0 = w.progress().span![0]
    w.onResolveStep({ trackId: '1', provider: 'khinsider', providerName: 'KHInsider', kind: 'stream', fraction: null })
    const s1 = w.progress().span![0]
    w.onResolveStep({ trackId: '1', provider: 'youtube', providerName: 'YouTube', kind: 'search', fraction: null })
    const s2 = w.progress().span![0]
    expect(s1).toBeGreaterThan(s0)
    expect(s2).toBeGreaterThan(s1)
    expect(s2).toBeLessThan(RESOLVE_END)
  })

  it('shows the one-time yt-dlp download while resolving', () => {
    const { w } = setup()
    w.onTool({ tool: 'yt-dlp', fraction: 0.4, detail: '12.0 of 30.0 MB', done: false })
    expect(w.progress()).toMatchObject({ label: 'Setting up YouTube support (one-time)', fraction: 0.4 })
    w.onTool({ tool: 'yt-dlp', fraction: 1, done: true })
    expect(w.progress().label).toBe('Getting the stream')
  })

  it('opening: waits on the connection, then the whole file or the first audio', () => {
    const { w } = setup()
    w.opened('chip')
    expect(w.progress().label).toBe('Connecting')
    expect(w.poll(wait({ connected: false }))).toBe(false)
    expect(w.poll(wait({ wholeFile: true, bytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 }))).toBe(true)
    expect(w.progress()).toMatchObject({ label: 'Downloading', fraction: 0.25, detail: '1.0 of 4.0 MB', span: [RESOLVE_END, 1] })
    // Tiny changes don't rebroadcast.
    expect(w.poll(wait({ wholeFile: true, bytes: 1024 * 1024 + 10, totalBytes: 4 * 1024 * 1024 }))).toBe(false)
    expect(w.poll(wait({ wholeFile: true, bytes: 4 * 1024 * 1024, totalBytes: 4 * 1024 * 1024, bufferedMs: 100 }))).toBe(true)
    expect(w.progress()).toMatchObject({ label: 'Buffering', fraction: 0.5 })
  })

  it('a local file opens without a "Connecting" step', () => {
    const { w } = setup()
    w.opened('download')
    expect(w.progress().label).toBe('Opening the file')
  })

  it('a long stall says so and counts down to the fallback', () => {
    const { w } = setup()
    w.opened('khinsider')
    w.poll(wait({ stalledMs: 2600, stallTimeoutMs: 8000 }))
    expect(w.progress()).toMatchObject({ label: 'Waiting for the network', fraction: null, expectMs: null })
    expect(w.progress().detail).toContain('6 s')
  })

  it('a stall mid-track and a fallback are new waits; a stall while still opening is not', () => {
    const { w } = setup()
    w.opened('khinsider')
    expect(w.stalled()).toBe(false)
    w.playing()
    expect(w.stalled()).toBe(true)
    expect(w.progress()).toMatchObject({ label: 'Buffering', span: [0, 1], wait: 'u1:1#1' })
    w.poll(wait({ bufferedMs: 375, targetMs: 750 }))
    expect(w.progress().fraction).toBe(0.5)
    expect(w.fallback()).toBe(true)
    expect(w.progress()).toMatchObject({ label: 'Trying another source', wait: 'u1:1#2', span: [0, RESOLVE_END] })
  })

  it('a tracker for an already-audible track only shows stalls', () => {
    const typical = new Typical()
    const w = WaitTracker.playing('u2:3', typical, () => 0)
    expect(w.poll(wait())).toBe(false)
    expect(w.stalled()).toBe(true)
    expect(w.progress().label).toBe('Buffering')
  })
})

describe('Typical', () => {
  it('learns an exponential moving average and ignores nonsense', () => {
    const t = new Typical()
    const d = Typical.defaultFor('stream:khinsider')
    t.record('stream:khinsider', 400)
    expect(t.get('stream:khinsider')).toBe(400)
    t.record('stream:khinsider', 1400)
    expect(t.get('stream:khinsider')).toBeCloseTo(400 * 0.7 + 1400 * 0.3)
    t.record('stream:khinsider', -5)
    t.record('stream:khinsider', 10 * 60_000)
    expect(t.get('stream:khinsider')).toBeCloseTo(700)
    expect(d).toBeGreaterThan(0)
  })
})

describe('formatBytes', () => {
  it('formats KB and MB', () => {
    expect(formatBytes(512)).toBe('1 KB')
    expect(formatBytes(300 * 1024)).toBe('300 KB')
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB')
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB')
    expect(formatBytesOf(1.2 * 1024 * 1024, 4.5 * 1024 * 1024)).toBe('1.2 of 4.5 MB')
    expect(formatBytesOf(300 * 1024, 4.5 * 1024 * 1024)).toBe('300 KB of 4.5 MB')
  })
})
