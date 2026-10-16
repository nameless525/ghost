// Release versions: "0.4.1" / "v0.4.1", optionally with a pre-release tag ("0.5.0-beta.2").

export interface Version {
  major: number
  minor: number
  patch: number
  pre: string | null
}

export function parseVersion(v: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null }
}

/** < 0 when a is older than b, 0 when equal, > 0 when newer. An unparseable version is older than any. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return x ? 1 : y ? -1 : 0
  if (x.major !== y.major) return x.major - y.major
  if (x.minor !== y.minor) return x.minor - y.minor
  if (x.patch !== y.patch) return x.patch - y.patch
  // A pre-release comes before its release.
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  return x.pre < y.pre ? -1 : 1
}

/** "v0.4.1" → "0.4.1" (null when it isn't a version). */
export function cleanVersion(v: string): string | null {
  return parseVersion(v) ? v.trim().replace(/^v/, '') : null
}
