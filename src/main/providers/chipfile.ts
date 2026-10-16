// Multi-song chip files (NSF, NSFE, GBS): song counts, titles and lengths from their headers. Shared
// by Modland (loose files, read with a Range request) and the chip rip sets (the engine hands over
// the head of each such file in an archive listing).

/** The engine's default fade (Album loop mode) when a song has a length but no fade. */
const DEFAULT_FADE_MS = 10_000
/** NSFE files are read whole for their song titles; anything bigger isn't one. */
export const MAX_NSFE_BYTES = 1024 * 1024

export interface ChipFileInfo {
  /** Songs in the file (after an NSFE playlist, when there is one). */
  songs: number
  /** Song the file starts with (0-based). */
  first: number
  title: string | null
  artist: string | null
  copyright: string | null
  /** NSFE: per-song title and length (album-mode estimate: length + fade). */
  tracks: { title: string | null; durationMs: number | null }[] | null
}

export const PLACEHOLDER_TEXT = /^(?:<\s*\?\s*>|\?+|n\/?a|unknown|-+|none)$/i

function decodeText(b: Buffer): string | null {
  const end = b.indexOf(0)
  const raw = end >= 0 ? b.subarray(0, end) : b
  let s: string
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    try {
      s = new TextDecoder('shift_jis', { fatal: true }).decode(raw)
    } catch {
      s = raw.toString('latin1')
    }
  }
  s = s.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s && !PLACEHOLDER_TEXT.test(s) ? s : null
}

/** NSF header (0x80 bytes): 'NESM\x1a', songs at 6, first song (1-based) at 7, strings at 0x0E/0x2E/0x4E. */
export function parseNsfHeader(b: Buffer): ChipFileInfo | null {
  if (b.length < 0x6e || b.toString('latin1', 0, 5) !== 'NESM\x1a') return null
  const songs = Math.max(1, b[6])
  return {
    songs,
    first: Math.min(songs - 1, Math.max(0, b[7] - 1)),
    title: decodeText(b.subarray(0x0e, 0x2e)),
    artist: decodeText(b.subarray(0x2e, 0x4e)),
    copyright: decodeText(b.subarray(0x4e, 0x6e)),
    tracks: null
  }
}

/** GBS header (0x70 bytes): 'GBS', version, songs at 4, first song (1-based) at 5, strings at 0x10/0x30/0x50. */
export function parseGbsHeader(b: Buffer): ChipFileInfo | null {
  if (b.length < 0x70 || b.toString('latin1', 0, 3) !== 'GBS') return null
  const songs = Math.max(1, b[4])
  return {
    songs,
    first: Math.min(songs - 1, Math.max(0, b[5] - 1)),
    title: decodeText(b.subarray(0x10, 0x30)),
    artist: decodeText(b.subarray(0x30, 0x50)),
    copyright: decodeText(b.subarray(0x50, 0x70)),
    tracks: null
  }
}

/**
 * NSFE: 'NSFE' then chunks (u32 size, 4-char id, data): INFO (songs at 8, first song 0-based at 9),
 * auth (game, artist, copyright, ripper), tlbl (titles), time / fade (s32 ms, -1 = unset), plst
 * (play order; libgme then numbers sub-songs by playlist position).
 */
export function parseNsfe(b: Buffer): ChipFileInfo | null {
  if (b.length < 8 || b.toString('latin1', 0, 4) !== 'NSFE') return null
  let info: Buffer | null = null
  let auth: (string | null)[] = []
  let tlbl: (string | null)[] = []
  let time: number[] = []
  let fade: number[] = []
  let plst: number[] | null = null
  const strings = (d: Buffer) => {
    const out: (string | null)[] = []
    let s = 0
    for (let i = 0; i < d.length; i++) {
      if (d[i] === 0) {
        out.push(decodeText(d.subarray(s, i)))
        s = i + 1
      }
    }
    if (s < d.length) out.push(decodeText(d.subarray(s)))
    return out
  }
  const ints = (d: Buffer) => Array.from({ length: Math.floor(d.length / 4) }, (_, i) => d.readInt32LE(i * 4))
  for (let p = 4; p + 8 <= b.length; ) {
    const size = b.readUInt32LE(p)
    const id = b.toString('latin1', p + 4, p + 8)
    const data = b.subarray(p + 8, Math.min(b.length, p + 8 + size))
    p += 8 + size
    if (id === 'NEND') break
    if (id === 'INFO') info = data
    else if (id === 'auth') auth = strings(data)
    else if (id === 'tlbl') tlbl = strings(data)
    else if (id === 'time') time = ints(data)
    else if (id === 'fade') fade = ints(data)
    else if (id === 'plst') plst = [...data]
  }
  if (!info || info.length < 9) return null
  const total = Math.max(1, info[8])
  const order = plst?.length ? plst : Array.from({ length: total }, (_, i) => i)
  const tracks = order.map((t) => {
    const len = time[t]
    const f = fade[t]
    return { title: tlbl[t] ?? null, durationMs: len != null && len > 0 ? len + (f != null && f >= 0 ? f : DEFAULT_FADE_MS) : null }
  })
  return {
    songs: order.length,
    first: plst?.length ? 0 : Math.min(total - 1, info.length > 9 ? info[9] : 0),
    title: auth[0] ?? null,
    artist: auth[1] ?? null,
    copyright: auth[2] ?? null,
    tracks
  }
}

export function parseChipHeader(ext: string, b: Buffer): ChipFileInfo | null {
  if (ext === 'nsfe') return parseNsfe(b)
  if (ext === 'nsf') return parseNsfHeader(b)
  if (ext === 'gbs') return parseGbsHeader(b)
  return null
}
