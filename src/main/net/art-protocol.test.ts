// ghost-art pipeline end to end, minus Electron: fetch (mocked) → native processArt (the real
// addon, skipped when it isn't built) → disk cache → buckets / caps / accent hooks.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const tmp = mkdtempSync(join(tmpdir(), 'ghost-art-test-'))
const addon = resolve(__dirname, '../../../native/dist/ghost.node')

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => resolve(__dirname, '../../..'), getPath: () => tmp },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  net: {}
}))

/** Minimal RGB PNG (filter 0 rows) from a pixel function. */
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3)
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const dims = (b: Buffer): [number, number] | null => {
  if (b[0] === 0x89) return [b.readUInt32BE(16), b.readUInt32BE(20)]
  // JPEG: walk to the first SOFn marker.
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null
    const m = b[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}

describe.skipIf(!existsSync(addon))('ghost-art protocol pipeline', () => {
  let art: typeof import('./art-protocol')
  const fetched: string[] = []
  const big = png(2400, 1200, (x, y) => (x < 1200 && y < 600 ? [40, 90, 220] : [16, 12, 20]))

  beforeAll(async () => {
    process.env.GHOST_NATIVE_ADDON = addon
    art = await import('./art-protocol')
    art.setArtDir(join(tmp, 'art'))
    art.setArtFetch(async (url, init) => {
      fetched.push(url)
      expect((init as RequestInit).cache).toBe('no-store')
      if (url.endsWith('/missing.png')) return new Response('nope', { status: 404 })
      return new Response(new Uint8Array(big), { status: 200, headers: { 'content-type': 'image/png' } })
    })
  })

  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('snaps widths to buckets', () => {
    expect([1, 128, 129, 300, 512, 700, 1000, 1500, 1600, 5000].map(art.artBucket)).toEqual([128, 128, 256, 512, 512, 768, 1024, 1600, 1600, 1600])
  })

  it('caps, caches, buckets and reports the accent without nativeImage', async () => {
    const accents: [string, string | null][] = []
    const off = art.onArtAccent((u, hex) => accents.push([u, hex]))
    const url = 'https://cdn.example/covers/big.png'
    const base = await art.getArt(url)
    expect(base.type).toBe('image/jpeg')
    expect(dims(base.bytes)).toEqual([1600, 800])
    // w=300 → the 512 bucket; w=100 → 128; w=5000 → the base (no upscale, no extra file).
    expect(dims((await art.getArt(url, 300)).bytes)).toEqual([512, 256])
    expect(dims((await art.getArt(url, 100)).bytes)).toEqual([128, 64])
    expect(dims((await art.getArt(url, 5000)).bytes)).toEqual([1600, 800])
    expect(fetched.filter((u) => u === url)).toHaveLength(1)
    await new Promise((r) => setImmediate(r))
    off()
    expect(accents).toHaveLength(1)
    const hex = accents[0][1]!
    expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
    // The accent is remembered and stored in the meta (no second decode).
    expect(await art.artAccent(url)).toBe(hex)
    const metas = readdirSync(join(tmp, 'art'), { recursive: true }).filter((f) => String(f).endsWith('.json'))
    expect(metas).toHaveLength(3) // base + 512 + 128
    const baseMeta = metas.map((f) => JSON.parse(readFileSync(join(tmp, 'art', String(f)), 'utf8'))).find((m) => m.w === null)
    expect(baseMeta).toMatchObject({ v: 2, width: 1600, height: 800, accent: hex, type: 'image/jpeg' })
  })

  it('404s stay errors', async () => {
    await expect(art.getArt('https://cdn.example/covers/missing.png')).rejects.toThrow(/not_found/)
  })
})
