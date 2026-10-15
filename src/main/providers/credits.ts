// Composer credits as sources list them are not always names: a page's "Composed by" field can
// carry the arrangers ("Arranged by Tomohiko Kira") or bare headings ("Arranged by", "Arranged :").
// Albums store only composers; other credits and headings are dropped.

/** Non-composer roles: an entry starting with one is another credit, not a composer. */
const OTHER_ROLE = /^(?:arranged|arrangements?|arranger|orchestrated|orchestration|orchestrator|performed|performer|lyrics|lyricist|vocals?|sung|mixed|mixing|mastered|mastering|produced|producer|programmed|programming|recorded|recording|engineered|engineer)\b(?:\s+by\b)?/i
/** A composer-role prefix in front of a name ("Composed by: X", "Music: X"). */
const COMPOSER_PREFIX = /^(?:(?:original\s+)?music\s+)?(?:composed|written|composer|composers|music)(?:\s+by)?\s*[:：]\s*|^(?:composed|written)\s+by\s+/i

/** Composer names only: headings and other roles dropped, role prefixes and trailing colons trimmed, duplicates removed. */
export function cleanCredits(names: readonly string[] | null | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of names ?? []) {
    if (typeof raw !== 'string') continue
    let n = raw.replace(/\s+/g, ' ').trim()
    if (OTHER_ROLE.test(n)) continue
    n = n.replace(COMPOSER_PREFIX, '').replace(/\s*[:：]+$/, '').trim()
    if (n.length < 2 || !/\p{L}/u.test(n) || /^(?:by|and|music|composer|composers|composed by)$/i.test(n)) continue
    const k = n.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(n)
  }
  return out
}
