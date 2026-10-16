// ghost-art pipeline end to end, minus Electron: fetch (mocked net.fetch, through the shared HTTP
// client's scheduler) → native processArt (the real addon, skipped when it isn't built) → disk
// cache → buckets / caps / accent hooks.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const tmp = mkdtempSync(join(tmpdir(), 'ghost-art-test-'))
const addon = resolve(__dirname, '../../../native/dist/ghost.node')

const net = vi.hoisted(() => ({ fetch: null as ((url: string, init?: RequestInit) => Promise<Response>) | null }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => resolve(__dirname, '../../..'), getPath: () => tmp },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  net: { fetch: (url: string, init?: RequestInit) => net.fetch!(url, init) }
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
    // The app's own network path (electronFetch over net.fetch), quick to retry.
    const { createHttpClient } = await import('./http')
    ;(await import('./shared')).setSharedHttp(createHttpClient({ cacheDir: null, backoffMs: 1 }))
    net.fetch = async (url, init) => {
      fetched.push(url)
      expect((init as RequestInit).cache).toBe('no-store')
      const special = answers.get(url)
      if (special) return special(init!)
      if (url.endsWith('/missing.png')) return new Response('nope', { status: 404 })
      const gate = gates.get(url)
      if (gate) await gate
      return new Response(new Uint8Array(big), { status: 200, headers: { 'content-type': 'image/png' } })
    }
  })
  /** URLs whose fetch waits until the promise settles (download-order test). */
  const gates = new Map<string, Promise<void>>()
  /** URLs answered otherwise than with `big`. */
  const answers = new Map<string, (init: RequestInit) => Response | Promise<Response>>()
  const image = (bytes: Uint8Array | string, type = 'image/png') => new Response(typeof bytes === 'string' ? bytes : new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } })
  const cacheFiles = (url: string) => {
    const h = createHash('sha1').update(url).digest('hex')
    const d = join(tmp, 'art', h.slice(0, 2))
    return { d, data: join(d, h), meta: join(d, `${h}.json`) }
  }

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

  it("small sizes come from the source's thumbnail, not the full scan", async () => {
    const url = 'https://nu.vgmtreasurechest.com/soundtracks/some-game-ost/Cover.png'
    const thumb = 'https://nu.vgmtreasurechest.com/soundtracks/some-game-ost/thumbs/Cover.png'
    expect(dims((await art.getArt(url, 40)).bytes)).toEqual([128, 64])
    expect(fetched).toContain(thumb)
    expect(fetched).not.toContain(url)
    // a bigger size needs the full scan
    expect(dims((await art.getArt(url, 300)).bytes)).toEqual([512, 256])
    expect(fetched).toContain(url)
    // no thumbnail (404): the full scan, resized
    const lone = 'https://nu.vgmtreasurechest.com/soundtracks/other-ost/missing.png'
    await expect(art.getArt(lone, 40)).rejects.toThrow(/not_found/)
    expect(fetched).toContain('https://nu.vgmtreasurechest.com/soundtracks/other-ost/thumbs/missing.png')
  })

  it('a connection that drops after the headers is retried like one that never answered', async () => {
    const url = 'https://cdn.example/covers/reset.png'
    let calls = 0
    answers.set(url, () => {
      if (calls++ > 0) return image(big)
      const body = new ReadableStream<Uint8Array>({ pull: (c) => c.error(new TypeError('terminated')) })
      return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } })
    })
    expect(dims((await art.getArt(url, 300)).bytes)).toEqual([512, 256])
    expect(calls).toBe(2)
  })

  it('an image over the native size limits is never served, not even as a small size', async () => {
    const url = 'https://cdn.example/covers/strip.png'
    answers.set(url, () => image(png(17_000, 1, () => [200, 40, 40])))
    await expect(art.getArt(url, 128)).rejects.toThrow(/\[parse\] unusable image/)
    await expect(art.getArt(url)).rejects.toThrow(/\[parse\] unusable image/)
    expect(existsSync(cacheFiles(url).meta)).toBe(false)
    expect(fetched.filter((u) => u === url)).toHaveLength(1) // (not again at once)
  })

  it('a corrupt image is neither served nor cached, and a later good one is', async () => {
    const url = 'https://cdn.example/covers/flaky.jpg'
    answers.set(url, () => image('temporary server error', 'image/jpeg'))
    await expect(art.getArt(url)).rejects.toThrow(/unusable image/)
    await expect(art.getArt(url)).rejects.toThrow(/unusable image/)
    expect(fetched.filter((u) => u === url)).toHaveLength(1)
    expect(existsSync(cacheFiles(url).meta)).toBe(false)
    // later on, the server sends the real cover
    answers.set(url, () => image(big))
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 16 * 60_000)
      expect(dims((await art.getArt(url)).bytes)).toEqual([1600, 800])
    } finally {
      vi.useRealTimers()
    }
    expect(fetched.filter((u) => u === url)).toHaveLength(2)
  })

  it('a corrupt image an earlier version cached as is gets fetched again', async () => {
    const url = 'https://cdn.example/covers/kept-broken.jpg'
    const f = cacheFiles(url)
    mkdirSync(f.d, { recursive: true })
    writeFileSync(f.data, 'temporary server error')
    writeFileSync(f.meta, JSON.stringify({ v: 2, type: 'image/jpeg', url, w: null, width: null, height: null, accent: null, at: 1 }))
    answers.set(url, () => image(big))
    expect(dims((await art.getArt(url, 300)).bytes)).toEqual([512, 256])
    expect(fetched.filter((u) => u === url)).toHaveLength(1)
    expect(JSON.parse(readFileSync(f.meta, 'utf8'))).toMatchObject({ v: 2, width: 1600, height: 800 })
  })

  it('formats only the browser reads are served as fetched, within limits of their own', async () => {
    const svg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
    answers.set('https://cdn.example/covers/logo.svg', () => image(svg, 'image/svg+xml'))
    for (const w of [undefined, 128]) {
      const a = await art.getArt('https://cdn.example/covers/logo.svg', w)
      expect(a).toMatchObject({ type: 'image/svg+xml' })
      expect(a.bytes.toString()).toBe(svg)
    }
    // AVIF: the size its header gives decides
    const avif = (side: number) => {
      const box = (type: string, body: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, 8 + body.length]), Buffer.from(type, 'latin1'), body])
      const ispe = Buffer.alloc(12)
      ispe.writeUInt32BE(side, 4)
      ispe.writeUInt32BE(side, 8)
      return Buffer.concat([box('ftyp', Buffer.from('avif\0\0\0\0avifmif1', 'latin1')), box('meta', box('ispe', ispe))])
    }
    answers.set('https://cdn.example/covers/ok.avif', () => image(avif(800), 'image/avif'))
    answers.set('https://cdn.example/covers/huge.avif', () => image(avif(9000), 'image/avif'))
    expect((await art.getArt('https://cdn.example/covers/ok.avif', 128)).type).toBe('image/avif')
    await expect(art.getArt('https://cdn.example/covers/huge.avif', 128)).rejects.toThrow(/unusable image/)
  })

  it("a source thumbnail that's corrupt isn't used: the full scan is resized instead", async () => {
    const url = 'https://nu.vgmtreasurechest.com/soundtracks/broken-thumb-ost/Cover.png'
    const thumb = 'https://nu.vgmtreasurechest.com/soundtracks/broken-thumb-ost/thumbs/Cover.png'
    answers.set(thumb, () => image('<html>oops</html>', 'image/png'))
    expect(dims((await art.getArt(url, 40)).bytes)).toEqual([128, 64])
    expect(fetched.filter((u) => u === thumb)).toHaveLength(1)
    expect(dims((await art.getArt(url, 40)).bytes)).toEqual([128, 64])
    expect(fetched.filter((u) => u === thumb || u === url)).toHaveLength(2)
  })

  it('downloads at most six at a time, newest first; a repeat request moves one up', async () => {
    const release: (() => void)[] = []
    const url = (i: number) => `https://h${i}.example/c${i}.png`
    for (let i = 0; i < 9; i++) gates.set(url(i), new Promise<void>((r) => release.push(r)))
    const started = () => fetched.filter((u) => /^https:\/\/h\d\.example/.test(u))
    // One at a time: each request reads the disk cache before it joins the queue, so requests made
    // together can join in any order on a busy machine (and "newest" would be whichever came last).
    const done: Promise<unknown>[] = []
    for (let i = 0; i < 9; i++) {
      done.push(art.getArt(url(i), 300))
      await vi.waitFor(() => {
        const q = art.artDownloadQueue()
        expect(q.waiting + q.running).toBe(i + 1)
      })
    }
    await vi.waitFor(() => expect(started()).toHaveLength(6))
    expect(art.artDownloadQueue()).toEqual({ waiting: 3, running: 6 })
    // c6, c7, c8 wait; asking for c6 again puts it ahead of the newer c7 and c8
    const again = art.getArt(url(6), 300)
    release[0]()
    await vi.waitFor(() => expect(started()).toHaveLength(7))
    expect(started()[6]).toBe(url(6))
    release[1]()
    await vi.waitFor(() => expect(started()).toHaveLength(8))
    expect(started()[7]).toBe(url(8)) // then newest first
    release.forEach((r) => r())
    await Promise.all([...done, again])
    expect(art.artDownloadQueue()).toEqual({ waiting: 0, running: 0 })
  })
})
