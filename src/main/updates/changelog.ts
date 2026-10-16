// The release notes shown after an update come from the CHANGELOG.md bundled with the app: one
// "## <version> (<date>)" section per release.

import type { WhatsNew } from '../../shared/types'
import { compareVersions, parseVersion } from './version'

export interface ChangelogSection {
  version: string
  date: string | null
  notes: string
}

/** Every released version's section, in file order (newest first); "## Unreleased" is skipped. */
export function parseChangelog(md: string): ChangelogSection[] {
  const out: ChangelogSection[] = []
  let cur: { version: string; date: string | null; lines: string[] } | null = null
  const flush = () => {
    if (cur) out.push({ version: cur.version, date: cur.date, notes: cur.lines.join('\n').trim() })
    cur = null
  }
  for (const line of md.split(/\r?\n/)) {
    const h = /^## (\S+)(?:\s+\(([^)]*)\))?\s*$/.exec(line)
    if (h) {
      flush()
      if (parseVersion(h[1])) cur = { version: h[1].replace(/^v/, ''), date: h[2] ?? null, lines: [] }
      continue
    }
    cur?.lines.push(line)
  }
  flush()
  return out
}

/**
 * What changed for someone who last ran `from` and now runs `current`: the sections after `from`
 * up to `current`, newest first. Without `from` (updated from a version that didn't record itself),
 * just `current`'s. Null when there is nothing to show.
 */
export function whatsNewSince(sections: ChangelogSection[], current: string, from: string | null): WhatsNew | null {
  if (from && compareVersions(current, from) <= 0) return null
  const picked = sections
    .filter((s) => compareVersions(s.version, current) <= 0 && (from ? compareVersions(s.version, from) > 0 : compareVersions(s.version, current) === 0))
    .sort((a, b) => compareVersions(b.version, a.version))
  if (!picked.length) return null
  return { version: current, from, sections: picked.map(({ version, date, notes }) => ({ version, date, notes })) }
}
