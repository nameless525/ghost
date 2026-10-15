import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GhostNotification, TaskProgress } from '../../shared/types'
import type { EngineCacheProgress } from '../engine/types'
import type { Broadcast } from '../ipc'
import type { ToolProgress } from './progress'
import { mbDetail, TaskReporter, TypicalMs, watchArchiveDownload, ytDlpInstallReporter } from './tasks'

const MB = 1048576

describe('task progress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a new step goes out at once; its updates at most once per interval (the latest wins), unchanged ones never; done always last', () => {
    const sent: TaskProgress[] = []
    const r = new TaskReporter((p) => sent.push(p), 200, () => Date.now())
    r.step('scan', { label: 'Looking for music files', detail: null, fraction: null, expectMs: null })
    expect(sent).toHaveLength(1)
    const since = sent[0].since
    r.step('scan', { label: 'Looking for music files', detail: '1 found', fraction: null, expectMs: null })
    r.step('scan', { label: 'Looking for music files', detail: '2 found', fraction: null, expectMs: null })
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(sent.map((p) => p.detail)).toEqual([null, '2 found'])
    expect(sent[1].since).toBe(since) // same step
    vi.advanceTimersByTime(500)
    r.step('scan', { label: 'Looking for music files', detail: '2 found', fraction: null, expectMs: null })
    expect(sent).toHaveLength(2) // unchanged
    vi.advanceTimersByTime(50)
    r.step('scan', { label: 'Reading tags', detail: '1 of 10 files', fraction: 0.1, expectMs: null, span: [0.15, 1] })
    expect(sent).toHaveLength(3)
    expect(sent[2]).toMatchObject({ key: 'scan', label: 'Reading tags', fraction: 0.1, span: [0.15, 1], since: Date.now() })
    r.step('scan', { label: 'Reading tags', detail: '5 of 10 files', fraction: 0.5, expectMs: null, span: [0.15, 1] }) // held…
    r.done('scan') // …and dropped: done is last
    vi.advanceTimersByTime(1000)
    expect(sent).toHaveLength(4)
    expect(sent[3]).toMatchObject({ key: 'scan', done: true, fraction: 1, label: 'Reading tags' })
    expect(r.active('scan')).toBe(false)
    r.done('scan')
    expect(sent).toHaveLength(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('learns typical step lengths per provider from defaults', () => {
    const t = new TypicalMs({ khinsider: 900 }, 1000)
    expect(t.get('khinsider')).toBe(900)
    expect(t.get('zophar')).toBe(1000)
    t.record('khinsider', 2900)
    expect(t.get('khinsider')).toBe(1500)
    t.record('khinsider', Number.NaN)
    expect(t.get('khinsider')).toBe(1500)
  })

  it('a chiptune set downloading through the engine: bytes, then unpacking; polling stops with the listing', async () => {
    const sent: TaskProgress[] = []
    const tasks = new TaskReporter((p) => sent.push(p), 200, () => Date.now())
    let fill: EngineCacheProgress | null = null
    let probes = 0
    let finish!: (v: string) => void
    const work = new Promise<string>((r) => (finish = r))
    const watched = watchArchiveDownload(
      work,
      () => {
        probes++
        return fill
      },
      'album:7',
      tasks
    )
    vi.advanceTimersByTime(200)
    expect(sent).toEqual([]) // nothing known yet: the worker's own first step stands
    fill = { bytes: 4.2 * MB, totalBytes: 12 * MB }
    vi.advanceTimersByTime(200)
    expect(sent.at(-1)).toMatchObject({ key: 'album:7', label: 'Downloading the chiptune set', detail: '4.2 of 12.0 MB', span: [0.1, 0.9] })
    expect(sent.at(-1)!.fraction).toBeCloseTo(0.35)
    fill = { bytes: 12 * MB, totalBytes: 12 * MB }
    vi.advanceTimersByTime(200)
    expect(sent.at(-1)).toMatchObject({ label: 'Unpacking the chiptune set', fraction: null, span: [0.9, 1] })
    finish('listing')
    expect(await watched).toBe('listing')
    const n = probes
    vi.advanceTimersByTime(2000)
    expect(probes).toBe(n)
    expect(vi.getTimerCount()).toBe(0)
    expect(tasks.active('album:7')).toBe(false) // the worker sends the done
    expect(sent.some((p) => p.done)).toBe(false)
  })

  it('the yt-dlp install: player progress, a bar and one toast updated in place, then "ready" (or the error)', () => {
    const events: [string, unknown][] = []
    const tools: ToolProgress[] = []
    const report = ytDlpInstallReporter({ broadcast: ((e: string, p: unknown) => events.push([e, p])) as Broadcast, onTool: (p) => tools.push(p) }, 250)
    report({ phase: 'download', bytes: 0, totalBytes: null })
    for (let b = 1; b <= 34; b++) report({ phase: 'download', bytes: b * MB, totalBytes: 34 * MB }) // a burst: held back
    vi.advanceTimersByTime(250)
    report({ phase: 'check', bytes: 34 * MB, totalBytes: 34 * MB }) // its first run
    report({ phase: 'done', bytes: 34 * MB, totalBytes: 34 * MB })
    const bars = events.filter(([e]) => e === 'progress').map(([, p]) => p as TaskProgress)
    const toasts = events.filter(([e]) => e === 'notify').map(([, p]) => p as GhostNotification)
    const all = `One-time download · ${mbDetail(34 * MB, 34 * MB)}`
    expect(bars.map((p) => p.detail)).toEqual(['One-time download', all, 'Checking that it works', 'Checking that it works'])
    expect(bars[0]).toMatchObject({ key: 'tool:yt-dlp', label: 'Setting up YouTube support', fraction: null, span: [0, 0.95] })
    expect(bars[1]).toMatchObject({ fraction: 1, span: [0, 0.95] })
    expect(bars[2]).toMatchObject({ fraction: null, expectMs: 2500, span: [0.95, 1] })
    expect(bars.at(-1)).toMatchObject({ done: true })
    expect(toasts.every((n) => n.id === 'tool-yt-dlp')).toBe(true)
    expect(toasts).toHaveLength(4)
    expect(toasts[1]).toMatchObject({ kind: 'progress', progress: 0.95, body: 'One-time download for YouTube and SoundCloud · 34.0 of 34.0 MB' })
    expect(toasts[3]).toMatchObject({ kind: 'success', title: 'YouTube support is ready' })
    expect(tools.map((t) => t.done)).toEqual([false, false, false, true])
    expect(tools[1]).toMatchObject({ tool: 'yt-dlp', fraction: 1 })

    // A failed attempt says why; the next one starts afresh.
    events.length = 0
    report({ phase: 'download', bytes: 0, totalBytes: null })
    report({ phase: 'error', bytes: 0, totalBytes: null, error: 'HTTP 503' })
    const again = events.filter(([e]) => e === 'notify').map(([, p]) => p as GhostNotification)
    expect(again.map((n) => n.kind)).toEqual(['progress', 'error'])
    expect(again[1].body).toMatch(/HTTP 503/)
    expect(tools.at(-1)).toMatchObject({ done: true, fraction: null, error: 'HTTP 503' })
    events.length = 0
    report({ phase: 'download', bytes: 0, totalBytes: null })
    expect(events.map(([e]) => e)).toEqual(['progress', 'notify'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
