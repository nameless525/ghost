// The real yt-dlp release for this OS: downloaded from GitHub, checked against the published
// SHA-256 sums, and run (including on Windows, where the unit tests' shell-script stand-in can't).
// It needs the network, so it only runs with GHOST_NET_TESTS=1 (CI sets it).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { YtDlp } from './ytdlp'

describe.runIf(process.env.GHOST_NET_TESTS === '1')('yt-dlp: the real release on this OS', () => {
  it('downloads, verifies and runs it', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'ghost-ytdlp-'))
    try {
      const y = new YtDlp({ binDir, systemDirs: [], jsRuntime: null, autoUpdate: false })
      const bin = await y.ensure()
      expect(bin.managed).toBe(true)
      expect(bin.version).toMatch(/^\d{4}\.\d{2}\.\d{2}/)
      const r = await y.run(['--version'])
      expect(r.stdout.trim()).toBe(bin.version)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 180_000)
})
