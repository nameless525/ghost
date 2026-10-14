import { describe, expect, it } from 'vitest'
import { packFrame, unpackFrame } from './analysis-pack'
import { PACKED_FRAME, type AnalysisFrame } from './types'

const sample = (): AnalysisFrame => ({
  bands: Float32Array.from({ length: 96 }, (_, i) => i / 96),
  waveform: Float32Array.from({ length: 512 }, (_, i) => Math.sin(i / 10)),
  rms: 0.25,
  peak: 0.75,
  onset: 0.5,
  positionMs: 123456.5,
  trackSeq: 7
})

describe('packed analysis frames', () => {
  it('round-trips through packFrame/unpackFrame', () => {
    const f = sample()
    const p = packFrame(f)
    expect(p.length).toBe(PACKED_FRAME.HEADER + 96 + 512)
    const out: AnalysisFrame = { bands: new Float32Array(96), waveform: new Float32Array(512), rms: 0, peak: 0, onset: 0, positionMs: 0, trackSeq: 0 }
    const r = unpackFrame(p, out)
    expect(r).toBe(out)
    expect(Array.from(r.bands)).toEqual(Array.from(f.bands))
    expect(Array.from(r.waveform)).toEqual(Array.from(f.waveform))
    expect(r.rms).toBeCloseTo(0.25)
    expect(r.peak).toBeCloseTo(0.75)
    expect(r.onset).toBeCloseTo(0.5)
    expect(r.positionMs).toBeCloseTo(123456.5, 0)
    expect(r.trackSeq).toBe(7)
  })

  it('reuses its buffers (no per-frame allocation) and adapts to other sizes', () => {
    const f = sample()
    const a = packFrame(f)
    const b = packFrame(f, a)
    expect(b).toBe(a)
    const out: AnalysisFrame = { bands: new Float32Array(96), waveform: new Float32Array(512), rms: 0, peak: 0, onset: 0, positionMs: 0, trackSeq: 0 }
    const bands = out.bands
    unpackFrame(a, out)
    expect(out.bands).toBe(bands)
    const small = packFrame({ ...f, bands: new Float32Array(8).fill(1), waveform: new Float32Array(16) })
    unpackFrame(small, out)
    expect(out.bands.length).toBe(8)
    expect(out.waveform.length).toBe(16)
  })
})
