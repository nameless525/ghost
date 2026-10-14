// Chapters from a timestamped track list in an upload's description:
//   "00:00 Title", "1:02:03 - Title", "Title - 12:34", "1. Title (12:34)", "[00:00] Title",
//   "00:00 - 2:54 - Title" / "1 - Title - 00:00-01:53" (start-end ranges).
// yt-dlp derives chapters for YouTube itself; for other sites (SoundCloud) the description is all
// there is. Shared so any provider with "one long upload + a track list" can split it.

export interface TextChapter {
  startMs: number
  endMs: number
  /** The line without its timestamp(s); numbering and decoration are left to the caller. */
  title: string
}

const TS = String.raw`(?:(\d{1,2}):)?(\d{1,2}):(\d{2})`
/** A timestamp, optionally followed by the end of a range ("00:00-01:53", "01:53-06-58", "2:54 - 5:15"). */
const LINE_TS = new RegExp(String.raw`(?<![\d:])${TS}(?![\d:])(?:\s*[-–—~]\s*(?:\d{1,2}[:-])?\d{1,2}[:-]\d{2}(?![\d:]))?`, 'g')

function firstTimestampMs(line: string): { ms: number; index: number } | null {
  LINE_TS.lastIndex = 0
  const m = LINE_TS.exec(line)
  if (!m) return null
  const h = Number(m[1] ?? 0)
  const min = Number(m[2])
  const sec = Number(m[3])
  if (sec >= 60 || (m[1] != null && min >= 60)) return null
  return { ms: ((h * 60 + min) * 60 + sec) * 1000, index: m.index }
}

/**
 * Chapters from a description's track list. Needs ≥ `minChapters` timestamps that start within
 * the first 10 s, rise, and fit in `durationSec` (the last chapter ends there; without a duration
 * there is no end, so nothing is returned). Lines that break the order are skipped; if more than
 * a fifth of them do, the list isn't a track list of this upload and nothing is returned.
 */
export function parseDescriptionChapters(description: string | null | undefined, durationSec: number | null | undefined, minChapters = 2): TextChapter[] {
  if (!description || !durationSec || durationSec <= 0) return []
  const totalMs = Math.round(durationSec * 1000)
  const marks: { ms: number; title: string }[] = []
  for (const raw of description.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line || line.length > 200) continue
    const ts = firstTimestampMs(line)
    if (!ts) continue
    const title = line
      .replace(LINE_TS, ' ')
      .replace(/[[(（]\s*[\])）]/g, ' ')
      .replace(/^[\s\-–—:|~•·.)\]]+|[\s\-–—:|~•·([]+$/gu, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    marks.push({ ms: ts.ms, title })
  }
  if (marks.length < minChapters) return []
  const kept: typeof marks = []
  for (const m of marks) {
    if (m.ms >= totalMs - 1000) continue
    if (kept.length && m.ms <= kept[kept.length - 1].ms) continue
    kept.push(m)
  }
  if (kept.length < minChapters || kept.length < marks.length * 0.8 || kept[0].ms > 10_000) return []
  return kept.map((m, i) => ({
    startMs: i === 0 ? 0 : m.ms,
    endMs: i + 1 < kept.length ? kept[i + 1].ms : totalMs,
    title: m.title || `Part ${i + 1}`
  }))
}
