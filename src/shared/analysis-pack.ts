// Packed real-time analysis frames (AnalysisAPI.readPacked): one Float32Array per frame instead
// of an object holding two typed arrays, so crossing the preload's context bridge is a single
// copy. The preload packs into a reused buffer; the renderer unpacks into a reused frame.
//
//   [rms, peak, onset, positionMs, trackSeq, numBands, waveformLen, ...bands, ...waveform]
import { PACKED_FRAME, type AnalysisFrame } from './types'

/** Pack `f` into `buf` when it has the right length, else into a new array (returned). */
export function packFrame(f: AnalysisFrame, buf?: Float32Array): Float32Array {
  const nb = f.bands.length
  const nw = f.waveform.length
  const len = PACKED_FRAME.HEADER + nb + nw
  const b = buf && buf.length === len ? buf : new Float32Array(len)
  b[PACKED_FRAME.RMS] = f.rms
  b[PACKED_FRAME.PEAK] = f.peak
  b[PACKED_FRAME.ONSET] = f.onset
  b[PACKED_FRAME.POSITION] = f.positionMs
  b[PACKED_FRAME.TRACK_SEQ] = f.trackSeq
  b[PACKED_FRAME.NUM_BANDS] = nb
  b[PACKED_FRAME.WAVEFORM_LEN] = nw
  b.set(f.bands, PACKED_FRAME.HEADER)
  b.set(f.waveform, PACKED_FRAME.HEADER + nb)
  return b
}

/** Unpack into `out` (its arrays are reused when the sizes match). Returns `out`. */
export function unpackFrame(p: Float32Array, out: AnalysisFrame): AnalysisFrame {
  const nb = p[PACKED_FRAME.NUM_BANDS]
  const nw = p[PACKED_FRAME.WAVEFORM_LEN]
  if (out.bands.length !== nb) out.bands = new Float32Array(nb)
  if (out.waveform.length !== nw) out.waveform = new Float32Array(nw)
  const b = out.bands
  const w = out.waveform
  let o = PACKED_FRAME.HEADER
  for (let i = 0; i < nb; i++) b[i] = p[o++]
  for (let i = 0; i < nw; i++) w[i] = p[o++]
  out.rms = p[PACKED_FRAME.RMS]
  out.peak = p[PACKED_FRAME.PEAK]
  out.onset = p[PACKED_FRAME.ONSET]
  out.positionMs = p[PACKED_FRAME.POSITION]
  out.trackSeq = p[PACKED_FRAME.TRACK_SEQ]
  return out
}
