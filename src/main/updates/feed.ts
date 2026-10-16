// The newest GHOST release, from GitHub's API (one request per check; the unauthenticated limit is
// 60 an hour per address, GHOST makes one a day): its version, notes, and the installer for this
// system with its SHA-256 (GitHub's own digest of the uploaded file, else the release's SHA256SUMS).

import { cleanVersion } from './version'

export const RELEASES_API = 'https://api.github.com/repos/nameless525/ghost/releases/latest'

export interface ReleaseAsset {
  name: string
  url: string
  size: number | null
  /** Hex SHA-256 of the file, when the release says. */
  sha256: string | null
}

export interface Release {
  version: string
  /** Markdown: the changelog section (the release page's install footer left out). */
  notes: string
  url: string
  publishedAt: number | null
  assets: ReleaseAsset[]
}

/** How this copy of GHOST was installed, which decides what it downloads and whether it can install it. */
export type InstallKind = 'mac-app' | 'nsis' | 'appimage' | 'deb' | 'none'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

interface GhAsset {
  name?: unknown
  size?: unknown
  browser_download_url?: unknown
  digest?: unknown
}

/** The notes of a release body: everything before a `---` line (the install instructions under it are for the web page). */
export function releaseNotes(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const cut = lines.findIndex((l) => l.trim() === '---')
  return (cut >= 0 ? lines.slice(0, cut) : lines).join('\n').trim()
}

export function parseRelease(json: unknown): Release | null {
  const r = json as { tag_name?: unknown; body?: unknown; html_url?: unknown; published_at?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }
  if (!r || typeof r !== 'object' || r.draft === true || r.prerelease === true) return null
  const version = typeof r.tag_name === 'string' ? cleanVersion(r.tag_name) : null
  if (!version) return null
  const published = typeof r.published_at === 'string' ? Date.parse(r.published_at) : NaN
  const assets: ReleaseAsset[] = []
  for (const a of Array.isArray(r.assets) ? (r.assets as GhAsset[]) : []) {
    if (typeof a?.name !== 'string' || typeof a.browser_download_url !== 'string') continue
    const digest = typeof a.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest)?.[1]?.toLowerCase() : undefined
    assets.push({ name: a.name, url: a.browser_download_url, size: typeof a.size === 'number' ? a.size : null, sha256: digest ?? null })
  }
  return {
    version,
    notes: releaseNotes(typeof r.body === 'string' ? r.body : ''),
    url: typeof r.html_url === 'string' ? r.html_url : `https://github.com/nameless525/ghost/releases/tag/v${version}`,
    publishedAt: Number.isFinite(published) ? published : null,
    assets
  }
}

/** The installer this system takes from a release (electron-builder.yml's artifactName patterns). */
export function assetFor(release: Release, platform: NodeJS.Platform, arch: string, kind: InstallKind): ReleaseAsset | null {
  const suffix =
    platform === 'darwin'
      ? `-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
      : platform === 'win32'
        ? `-windows-${arch}-setup.exe`
        : platform === 'linux'
          ? kind === 'deb'
            ? `-linux-${arch === 'x64' ? 'amd64' : arch}.deb`
            : `-linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`
          : null
  if (!suffix) return null
  return release.assets.find((a) => a.name.endsWith(suffix)) ?? null
}

/** "<hex>  <name>" lines (sha256sum's output). */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim())
    if (m) out.set(m[2], m[1].toLowerCase())
  }
  return out
}

const GH_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }

/**
 * The newest release (null when the repository has none yet). Fills in a missing digest from the
 * release's SHA256SUMS file.
 */
export async function fetchLatestRelease(fetchImpl: Fetch, url: string, userAgent: string): Promise<Release | null> {
  const res = await fetchImpl(url, { headers: { ...GH_HEADERS, 'User-Agent': userAgent }, signal: AbortSignal.timeout(20_000) })
  if (res.status === 404) return null
  if (res.status === 403 || res.status === 429) throw new Error('GitHub asked GHOST to slow down (rate limit). It will try again later.')
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`)
  const release = parseRelease(await res.json())
  if (!release) return null
  const sums = release.assets.find((a) => a.name === 'SHA256SUMS')
  if (sums && release.assets.some((a) => !a.sha256 && a !== sums)) {
    try {
      const r = await fetchImpl(sums.url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(20_000) })
      if (r.ok) {
        const map = parseSha256Sums(await r.text())
        for (const a of release.assets) a.sha256 ??= map.get(a.name) ?? null
      }
    } catch {
      /* the installer without a checksum isn't installed (see Updater) */
    }
  }
  return release
}
