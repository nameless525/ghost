import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isNetError, NetError } from '../net/errors'
import type { BytesResult, HttpClient } from '../net/http'
import {
  buildModlandIndex,
  decodeModlandCacheHeader,
  encodeModlandCache,
  extractZipEntry,
  filterModlandLines,
  folderTracks,
  forEachModlandLine,
  isPlaceholderComposer,
  MODLAND_FAMILIES,
  MODLAND_ID,
  MODLAND_INDEX_IDLE_MS,
  MODLAND_INDEX_MAX_AGE_MS,
  MODLAND_INDEX_URL,
  modlandAlbumHit,
  isMusicianFolder,
  modlandFileUrl,
  modlandLocator,
  ModlandProvider,
  modlandTitle,
  modlandTrackTitles,
  parseCopyright,
  parseGbsHeader,
  parseModlandLocator,
  parseNsfe,
  parseNsfHeader,
  smartTitle
} from './modland'
import { isIndexProvider } from './types'

const SAMPLE = readFileSync(join(__dirname, '__fixtures__', 'modland', 'allmods-sample.txt'))

// ---------------------------------------------------------------------------
// Builders

interface ZipEntrySpec {
  name: string
  data: Buffer
  method?: number
  utf8?: boolean
  crc?: number
}

/** A minimal zip (local headers, central directory, end record). */
function makeZip(entries: ZipEntrySpec[], opts: { count?: number } = {}): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const method = e.method ?? 8
    const body = method === 8 ? deflateRawSync(e.data) : e.data
    const name = Buffer.from(e.name, e.utf8 ? 'utf8' : 'latin1')
    const crc = e.crc ?? crc32(e.data)
    const flags = e.utf8 ? 0x800 : 0
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(flags, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(flags, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    parts.push(lh, name, body)
    central.push(ch, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(opts.count ?? entries.length, 8)
  end.writeUInt16LE(opts.count ?? entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}

function putString(b: Buffer, at: number, s: string): void {
  b.write(s, at, 31, 'latin1')
}

function nsfHeader(o: { songs: number; first?: number; title?: string; artist?: string; copyright?: string }): Buffer {
  const b = Buffer.alloc(0x80)
  b.write('NESM\x1a', 0, 'latin1')
  b[5] = 1
  b[6] = o.songs
  b[7] = o.first ?? 1
  putString(b, 0x0e, o.title ?? '<?>')
  putString(b, 0x2e, o.artist ?? '<?>')
  putString(b, 0x4e, o.copyright ?? '<?>')
  return b
}

function gbsHeader(o: { songs: number; first?: number; title?: string; artist?: string; copyright?: string }): Buffer {
  const b = Buffer.alloc(0x70)
  b.write('GBS', 0, 'latin1')
  b[3] = 1
  b[4] = o.songs
  b[5] = o.first ?? 1
  putString(b, 0x10, o.title ?? '')
  putString(b, 0x30, o.artist ?? '')
  putString(b, 0x50, o.copyright ?? '')
  return b
}

function nsfe(chunks: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [Buffer.from('NSFE', 'latin1')]
  for (const [id, data] of chunks) {
    const h = Buffer.alloc(8)
    h.writeUInt32LE(data.length, 0)
    h.write(id, 4, 'latin1')
    parts.push(h, data)
  }
  return Buffer.concat(parts)
}

const zstr = (...s: string[]) => Buffer.from(s.map((x) => `${x}\0`).join(''), 'utf8')
const s32 = (...n: number[]) => {
  const b = Buffer.alloc(n.length * 4)
  n.forEach((v, i) => b.writeInt32LE(v, i * 4))
  return b
}

type Route = (url: string, headers: Record<string, string>) => Buffer | Error

function fakeHttp(route: Route): HttpClient & { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = []
  return {
    calls,
    async pageFetch() {
      throw new Error('not used')
    },
    async fetchBytes(url, opts = {}): Promise<BytesResult> {
      const headers = opts.headers ?? {}
      calls.push({ url, headers })
      const r = route(url, headers)
      if (r instanceof Error) throw r
      return { url, status: headers.Range ? 206 : 200, bytes: r, contentType: 'application/octet-stream' }
    },
    limiter() {
      throw new Error('not used')
    },
    blockedUntil: () => 0,
    invalidate: async () => {}
  }
}

// ---------------------------------------------------------------------------

describe('modland: zip', () => {
  const text = Buffer.from('12\tNintendo SPC/A/B/c.spc\n', 'utf8')

  it('extracts deflated and stored entries, picking the named one', () => {
    const zip = makeZip([
      { name: 'readme.txt', data: Buffer.from('hello'), method: 0 },
      { name: 'allmods.txt', data: text }
    ])
    expect(extractZipEntry(zip, 'allmods.txt')).toEqual({ name: 'allmods.txt', data: text })
    expect(extractZipEntry(zip).data.toString()).toBe('hello')
    const stored = makeZip([{ name: 'dir/ALLMODS.TXT', data: text, method: 0 }])
    expect(extractZipEntry(stored, 'allmods.txt').data).toEqual(text)
    const utf8 = makeZip([{ name: 'ファイル.txt', data: text, utf8: true }])
    expect(extractZipEntry(utf8).name).toBe('ファイル.txt')
  })

  it('rejects broken or unsupported archives', () => {
    const fails = (zip: Buffer, re: RegExp, name?: string) => {
      try {
        extractZipEntry(zip, name)
        throw new Error('expected a failure')
      } catch (e) {
        expect(isNetError(e, 'parse')).toBe(true)
        expect((e as Error).message).toMatch(re)
      }
    }
    fails(Buffer.from('<html>not a zip</html>'), /end of central directory|too short/)
    fails(makeZip([{ name: 'allmods.txt', data: text, crc: 1234 }]), /CRC/)
    fails(makeZip([{ name: 'other.txt', data: text }]), /no allmods\.txt/, 'allmods.txt')
    fails(makeZip([{ name: 'allmods.txt', data: text, method: 12 }]), /method 12/)
    fails(makeZip([{ name: 'allmods.txt', data: text }], { count: 0xffff }), /zip64/)
    const zip = makeZip([{ name: 'allmods.txt', data: text }])
    fails(zip.subarray(0, 20), /too short/)
  })
})

describe('modland: index lines', () => {
  it('keeps only the indexed format folders, byte for byte', () => {
    const text = Buffer.from(
      ['1\tAce Tracker/505/x.am', '66144\tNintendo SPC/Y/Chrono Trigger/101 - presentiment.spc\r', '9\tNintendo SPCX/z.spc', '5\tVideo Game Music/Sega Megadrive/A/B/01 é.vgz', '7\tHES/x/y.hes', '8\tGameboy Sound System/a/b.gbs'].join('\n'),
      'utf8'
    )
    const kept = filterModlandLines(text).toString('utf8')
    expect(kept).toBe('66144\tNintendo SPC/Y/Chrono Trigger/101 - presentiment.spc\n5\tVideo Game Music/Sega Megadrive/A/B/01 é.vgz\n8\tGameboy Sound System/a/b.gbs\n')
    const seen: [number, string][] = []
    forEachModlandLine(`#comment\n${kept}junk line\n12x\tNintendo SPC/a/b/c.spc\n`, (size, path) => seen.push([size, path]))
    expect(seen).toEqual([
      [66144, 'Nintendo SPC/Y/Chrono Trigger/101 - presentiment.spc'],
      [5, 'Video Game Music/Sega Megadrive/A/B/01 é.vgz'],
      [8, 'Gameboy Sound System/a/b.gbs']
    ])
  })

  it('the cache file carries its timestamp', () => {
    const buf = encodeModlandCache(Buffer.from('1\tNintendo SPC/a/b/c.spc\n'), 1234)
    expect(decodeModlandCacheHeader(buf)).toEqual({ fetchedAt: 1234 })
    expect(decodeModlandCacheHeader(Buffer.from('#GHOST modland-index v0 fetchedAt=1\n'))).toBeNull()
    expect(decodeModlandCacheHeader(Buffer.from('1\tNintendo SPC/a/b/c.spc\n'))).toBeNull()
    expect(buildModlandIndex(buf, 1234).byRef.has('spc/b')).toBe(true)
  })
})

describe('modland: names', () => {
  it('title-cases lowercase names only', () => {
    expect(smartTitle('legend of zelda - the triforce')).toBe('Legend of Zelda - The Triforce')
    expect(smartTitle('hokuto no ken - tough boy')).toBe('Hokuto no Ken - Tough Boy')
    expect(smartTitle('final fantasy iii')).toBe('Final Fantasy III')
    expect(smartTitle("x-men - wily's revenge (the return)")).toBe("X-Men - Wily's Revenge (The Return)")
    expect(smartTitle('s.c.i. - special criminal investigation')).toBe('S.C.I. - Special Criminal Investigation')
    expect(smartTitle('rpg tsukuru gb')).toBe('RPG Tsukuru GB')
    expect(smartTitle('Secret Of Mana')).toBe('Secret Of Mana')
    expect(smartTitle('ファイナルファンタジー')).toBe('ファイナルファンタジー')
  })

  it('album titles drop chip and platform tags, keep the rest', () => {
    expect(modlandTitle('doki doki panic (fds)', 'nsf')).toEqual({ title: 'Doki Doki Panic', system: 'fds' })
    expect(modlandTitle('cybernoid ii (vrc7)', 'nsf')).toEqual({ title: 'Cybernoid II', system: null })
    expect(modlandTitle('balloon fight (vs)', 'nsf')).toEqual({ title: 'Balloon Fight', system: 'vs' })
    expect(modlandTitle('metal gear (1987)', 'nsf').title).toBe('Metal Gear (1987)')
    expect(modlandTitle('ice hockey (pal) [a2]', 'nsf').title).toBe('Ice Hockey (PAL) [A2]')
    expect(modlandTitle("A Bug's Life (SGB)", 'spc')).toEqual({ title: "A Bug's Life", system: 'sgb' })
    expect(modlandTitle('Phantasy Star (FM)', 'vgm').title).toBe('Phantasy Star (FM)')
    expect(modlandTitle('Mad_as_hatter', 'nsf').title).toBe('Mad as hatter')
    expect(modlandTitle('(Kyuukyoku Senki Gikadiver) Transitional Age', 'vgm').title).toBe('(Kyuukyoku Senki Gikadiver) Transitional Age')
    expect(isPlaceholderComposer('- unknown')).toBe(true)
    expect(isPlaceholderComposer('Koji Kondo')).toBe(false)
  })

  it('track titles: shared prefixes, numbers, numbered dumps', () => {
    expect(modlandTrackTitles(['plok! - beach', 'plok! - boss', 'plok! - cavern'], 'Plok!')).toEqual([
      { number: null, title: 'Beach' },
      { number: null, title: 'Boss' },
      { number: null, title: 'Cavern' }
    ])
    expect(modlandTrackTitles(['beyond oasis - 01 - introduction', 'beyond oasis - 32 - confession'], 'Beyond Oasis')).toEqual([
      { number: 1, title: 'Introduction' },
      { number: 32, title: 'Confession' }
    ])
    // The prefix is spelled differently from the folder name.
    expect(modlandTrackTitles(['front mission gun hazard - atlas', 'front mission gun hazard - 202'], 'Front Mission - Gun Hazard')).toEqual([
      { number: null, title: 'Atlas' },
      { number: 202, title: 'Track 202' }
    ])
    // Two songs sharing an ordinary word aren't stripped.
    expect(modlandTrackTitles(['battle - boss', 'battle - normal'], 'Some Game').map((t) => t.title)).toEqual(['Battle - Boss', 'Battle - Normal'])
    expect(modlandTrackTitles(['makeruna! makendou (01)', 'makeruna! makendou (12)'], 'Makeruna! Makendou')).toEqual([
      { number: 1, title: 'Track 1' },
      { number: 12, title: 'Track 12' }
    ])
    expect(modlandTrackTitles(['mppp-01', 'mppp-14'], 'Mahou Poi Poi Poitto!').map((t) => t.title)).toEqual(['Track 1', 'Track 14'])
    expect(modlandTrackTitles(['01 opening theme', '02', 'theme 10', 'theme 11'], 'Shougi No Hoshi')).toEqual([
      { number: 1, title: 'Opening Theme' },
      { number: 2, title: 'Track 2' },
      { number: null, title: 'Theme 10' },
      { number: null, title: 'Theme 11' }
    ])
    expect(modlandTrackTitles(['earthbound (battle01)', 'a bad dream'], 'Earthbound').map((t) => t.title)).toEqual(['Battle01', 'A Bad Dream'])
    expect(modlandTrackTitles(['01 - プレリュード'], 'ファイナルファンタジーIV')).toEqual([{ number: 1, title: 'プレリュード' }])
  })

  it('track titles: a short name after a numbered dot is the title, not an extension', () => {
    expect(modlandTrackTitles(['01.Intro', '02.Theme', '03.A'], 'Game')).toEqual([
      { number: 1, title: 'Intro' },
      { number: 2, title: 'Theme' },
      { number: 3, title: 'A' }
    ])
  })
})

describe('modland: building the index', () => {
  const idx = buildModlandIndex(SAMPLE, 1000)
  const album = (ref: string) => {
    const a = idx.byRef.get(ref)
    if (!a) throw new Error(`no ${ref}`)
    return a
  }

  it('keeps playable families only, one album per game', () => {
    expect(MODLAND_FAMILIES.map((f) => f.key)).toEqual(['spc', 'nsf', 'gbs', 'vgm'])
    const refs = [...idx.byRef.keys()]
    // HES, KSS, SGC, PSF, MDX, trackers: no family. Unplayable VGM systems, loose songs and '- misc': skipped.
    expect(refs.some((r) => /hes|kss|sgc|psf|mdx|ace tracker/i.test(r.split('/')[0]))).toBe(false)
    expect(refs.filter((r) => r.startsWith('vgm/')).sort()).toEqual(['vgm/sega master system/land of illusion', 'vgm/sega megadrive/bare knuckle', 'vgm/sega megadrive/beyond oasis', 'vgm/sega megadrive/shougi no hoshi'])
    expect(refs).not.toContain('spc/lode runner twin')
    expect(refs).not.toContain('spc/- misc')
    // NSF: 30 lines, one of them an identical copy merged away.
    expect(idx.files).toEqual({ spc: 52, nsf: 29, gbs: 5, vgm: 10 })
    expect(idx.byFamily.get('spc')!.map((a) => a.title)).toEqual([
      "A Bug's Life",
      'Bishoujo Senshi Sailor Moon R',
      'Chrono Trigger',
      'Earthbound',
      'Front Mission - Gun Hazard',
      'Mahou Poi Poi Poitto!',
      'Makeruna! Makendou',
      'Plok!',
      'Spider-Man',
      'ファイナルファンタジーIV'
    ])
  })

  it('merges a game split over composer folders, and co-composers', () => {
    const eb = album('spc/earthbound')
    expect(eb.members.map((m) => m.dir)).toEqual(['Nintendo SPC/Akio Ohmori/Earthbound', 'Nintendo SPC/Keiichi Suzuki/Earthbound', 'Nintendo SPC/- unknown/EarthBound'])
    expect(eb.composers).toEqual(['Akio Ohmori', 'Keiichi Suzuki'])
    expect(eb.fileCount).toBe(9)
    // The '- unknown' copy of "a bad dream" is a duplicate.
    expect(folderTracks(eb).map((t) => t.title)).toEqual(['A Bad Dream', 'A Flash of Memory', 'A Good Buddy', "A Good Night's Rest", 'Annoyingknock2', 'Appleofenlightenment', 'Arcade', 'Battle01'])
    expect(album('spc/plok!').composers).toEqual(['Tim Follin', 'Geoff Follin'])
    expect(album('spc/spider-man').composers).toEqual(['Fletcher Beasley', 'Joe Perry'])
    expect(album('nsf/tsu ryu/coop-k. manami/hokuto no ken - tough boy.nsf').composers).toEqual(['Tsu Ryu', 'K. Manami'])
    expect(album('vgm/sega megadrive/shougi no hoshi').composers).toEqual([])
  })

  it('multi-song files: one album per file; identical copies merge, covers stay apart', () => {
    const cv = album('nsf/kinuyo yamashita/castlevania.nsf')
    expect(cv.composers).toEqual(['Kinuyo Yamashita'])
    expect(idx.byRef.has('nsf/- unknown/castlevania.nsf')).toBe(false)
    expect(album('nsf/graa/castlevania.nsf').sizeBytes).toBe(16000)
    // Same name, different sizes: two albums.
    expect(album('gbs/allister brimble/casper.gbs').fileCount).toBe(1)
    expect(album('gbs/- unknown/casper.gbs').composers).toEqual([])
    expect(album('nsf/necocat/the hustler #05.nsf').members[0]).toEqual({ dir: 'Nintendo Sound Format/Necocat', composers: ['Necocat'], placeholder: false, files: [{ rel: 'the hustler #05.nsf', size: 24576 }] })
    expect(album('nsf/- unknown/mother.nsfe').title).toBe('Mother')
  })

  it('titles and platforms (KHInsider slugs)', () => {
    const p = (ref: string) => album(ref).platform
    expect(p('spc/chrono trigger')).toEqual({ slug: 'nintendo-snes', name: 'SNES' })
    expect(p("spc/a bug's life (sgb)")).toEqual({ slug: 'gameboy', name: 'GB' })
    expect(p('nsf/koji kondo/super mario bros 3.nsf')).toEqual({ slug: 'nintendo-nes', name: 'NES' })
    expect(album('nsf/koji kondo/doki doki panic (fds).nsf')).toMatchObject({ title: 'Doki Doki Panic', platform: { slug: 'famicom-disk-system' } })
    expect(album('nsf/hirokazu tanaka/balloon fight (vs).nsf').platform.slug).toBe('arcade')
    expect(album('nsf/kuhneghetz/cybernoid ii (vrc7).nsf').title).toBe('Cybernoid II')
    expect(p('gbs/m. maekawa/adventure island 2.gbs')).toEqual({ slug: 'gameboy', name: 'GB' })
    expect(p('vgm/sega megadrive/beyond oasis')).toEqual({ slug: 'sega-mega-drive-genesis', name: 'Genesis' })
    expect(p('vgm/sega master system/land of illusion')).toEqual({ slug: 'sega-master-system', name: 'Master System' })
    expect(album('spc/ファイナルファンタジーiv')).toMatchObject({ title: 'ファイナルファンタジーIV', composers: ['植松伸夫'] })
    expect(album('vgm/sega megadrive/bare knuckle').composers).toEqual(['Yūzō Koshiro'])
    expect(modlandAlbumHit(album('spc/chrono trigger'))).toEqual({
      provider: MODLAND_ID,
      ref: 'spc/chrono trigger',
      title: 'Chrono Trigger',
      titleFromRef: false,
      platforms: [{ slug: 'nintendo-snes', name: 'SNES' }],
      kind: 'gamerip',
      typeLabel: 'Chip rip',
      year: null,
      thumb: null,
      cover: null,
      catalogNo: null,
      addedAt: null
    })
  })

  it("named NSF folders (musicians' own work mixed with rips) only count for known games", () => {
    expect(modlandAlbumHit(album('nsf/koji kondo/super mario bros 3.nsf')).onlyForKnownGame).toBe(true)
    expect(isMusicianFolder(album('nsf/necocat/the hustler #05.nsf'))).toBe(true)
    expect(modlandAlbumHit(album('nsf/- unknown/mother.nsfe')).onlyForKnownGame).toBeUndefined()
    expect(modlandAlbumHit(album('spc/chrono trigger')).onlyForKnownGame).toBeUndefined()
    expect(modlandAlbumHit(album('gbs/m. maekawa/adventure island 2.gbs')).onlyForKnownGame).toBeUndefined()
  })

  it('folder tracks: files of one name in two composer folders are two songs unless they are copies', () => {
    const lines = ['100\tNintendo SPC/A/Game/01.spc', '200\tNintendo SPC/B/Game/01.spc', '150\tNintendo SPC/A/Game/02.spc', '150\tNintendo SPC/B/Game/02.spc'].join('\n')
    const tracks = folderTracks(buildModlandIndex(lines, 0).byRef.get('spc/game')!)
    expect(tracks.map((t) => [t.locator, t.title, t.files[0].sizeBytes])).toEqual([
      ['Nintendo SPC/A/Game/01.spc', 'Track 1', 100],
      ['Nintendo SPC/B/Game/01.spc', 'Track 1 (B)', 200],
      ['Nintendo SPC/A/Game/02.spc', 'Track 2', 150]
    ])
  })

  it('folder tracks: disc numbering, extras last, streams', () => {
    const tracks = folderTracks(album('spc/chrono trigger'))
    expect(tracks.map((t) => `${t.disc}.${t.number} ${t.title}`)).toEqual([
      '1.1 Presentiment',
      '1.2 Chrono Trigger (Looped)',
      '1.2 Chrono Trigger',
      '1.3 Morning Sunlight',
      '1.4 Peaceful Days',
      '1.5 Memories of Green',
      '1.6 Guardia Millennial Fair',
      "1.7 Gato's Song",
      '1.8 A Strange Happening',
      '1.9 Wind Scene',
      '1.10 Goodnight',
      '1.11 Secret of the Forest',
      '3.1 Singing Mountain',
      '3.2 Tyran Castle',
      '3.3 Blackbird (Inside)',
      '3.4 Blackbird (Outside)',
      '3.5 Ocean Waves'
    ])
    const t = tracks[0]
    const path = 'Nintendo SPC/Yasunori Mitsuda/Chrono Trigger/101 - presentiment.spc'
    expect(t).toMatchObject({ durationMs: null, locator: path, files: [{ format: 'chip', sizeBytes: 66144 }], composers: [] })
    expect(t.streams).toEqual([
      {
        provider: MODLAND_ID,
        source: { kind: 'http', url: 'https://ftp.modland.com/pub/modules/Nintendo%20SPC/Yasunori%20Mitsuda/Chrono%20Trigger/101%20-%20presentiment.spc', cacheKey: `modland:${path}`, formatHint: 'spc' },
        format: 'chip',
        lossless: false,
        bitrateKbps: null,
        sizeBytes: 66144,
        expiresAt: null
      }
    ])
    expect(folderTracks(album('vgm/sega megadrive/beyond oasis')).map((x) => `${x.number} ${x.title}`)).toEqual(['1 Introduction', '2 Awakening', '3 To Begin', '4 Battle'])
    expect(folderTracks(album('vgm/sega megadrive/beyond oasis'))[0].streams![0].source).toMatchObject({ formatHint: 'vgz' })
  })
})

describe('modland: locators and headers', () => {
  it('URLs encode each path segment', () => {
    expect(modlandFileUrl('Nintendo Sound Format/Necocat/the hustler #05.nsf')).toBe('https://ftp.modland.com/pub/modules/Nintendo%20Sound%20Format/Necocat/the%20hustler%20%2305.nsf')
    expect(modlandFileUrl('Nintendo SPC/植松伸夫/ファイナルファンタジーIV/01 - プレリュード.spc')).toBe(
      `https://ftp.modland.com/pub/modules/Nintendo%20SPC/${encodeURIComponent('植松伸夫')}/${encodeURIComponent('ファイナルファンタジーIV')}/01%20-%20${encodeURIComponent('プレリュード')}.spc`
    )
    expect(modlandFileUrl('Nintendo SPC/A & B/C?/d+e.spc')).toBe('https://ftp.modland.com/pub/modules/Nintendo%20SPC/A%20%26%20B/C%3F/d%2Be.spc')
  })

  it('locators round-trip; bad ones are refused', () => {
    const multi = 'Nintendo Sound Format/Necocat/the hustler #05.nsf'
    expect(modlandLocator(multi, 3)).toBe(`${multi}#3`)
    expect(parseModlandLocator(`${multi}#3`)).toEqual({ path: multi, subsong: 3 })
    expect(parseModlandLocator('Nintendo SPC/A/B/boss #2.spc')).toEqual({ path: 'Nintendo SPC/A/B/boss #2.spc', subsong: null })
    expect(parseModlandLocator('Gameboy Sound System/a/b.gbs#0')).toEqual({ path: 'Gameboy Sound System/a/b.gbs', subsong: 0 })
    expect(parseModlandLocator(multi)).toBeNull()
    expect(parseModlandLocator('Nintendo SPC/A/B/c.spc#1')).toBeNull()
    expect(parseModlandLocator('HES/a/b.hes#1')).toBeNull()
    expect(parseModlandLocator('Nintendo SPC/A/B/c.mp3')).toBeNull()
    expect(parseModlandLocator('Nintendo SPC/../B/c.spc')).toBeNull()
  })

  it('NSF / GBS / NSFE headers', () => {
    expect(parseNsfHeader(nsfHeader({ songs: 71, first: 1, title: 'Super Mario Bros. 3', copyright: '1988 Nintendo' }))).toEqual({
      songs: 71,
      first: 0,
      title: 'Super Mario Bros. 3',
      artist: null,
      copyright: '1988 Nintendo',
      tracks: null
    })
    expect(parseNsfHeader(nsfHeader({ songs: 5, first: 3 }))!.first).toBe(2)
    expect(parseNsfHeader(Buffer.from('NESM\x1a\x01\x05\x01'))).toBeNull()
    expect(parseNsfHeader(gbsHeader({ songs: 2 }))).toBeNull()
    expect(parseGbsHeader(gbsHeader({ songs: 79, title: 'Adventure Island 2', artist: 'M.Maekawa, M.Okuyama', copyright: '1993 Hudson Soft' }))).toEqual({
      songs: 79,
      first: 0,
      title: 'Adventure Island 2',
      artist: 'M.Maekawa, M.Okuyama',
      copyright: '1993 Hudson Soft',
      tracks: null
    })
    const info = Buffer.alloc(10)
    info[8] = 4
    info[9] = 1
    const file = nsfe([
      ['INFO', info],
      ['DATA', Buffer.alloc(16)],
      ['auth', zstr('Mother', 'Keiichi Suzuki', '1989 Nintendo', 'someone')],
      ['tlbl', zstr('Pollyanna', 'Bein\' Friends', 'Snow Man', 'Eight Melodies')],
      ['time', s32(60_000, -1, 30_000, 45_000)],
      ['fade', s32(5_000, -1, -1, 2_000)],
      ['plst', Buffer.from([3, 0, 2])],
      ['NEND', Buffer.alloc(0)]
    ])
    expect(parseNsfe(file)).toEqual({
      songs: 3,
      first: 0,
      title: 'Mother',
      artist: 'Keiichi Suzuki',
      copyright: '1989 Nintendo',
      tracks: [
        { title: 'Eight Melodies', durationMs: 47_000 },
        { title: 'Pollyanna', durationMs: 65_000 },
        { title: 'Snow Man', durationMs: 40_000 }
      ]
    })
    expect(parseNsfe(nsfe([['auth', zstr('x')]]))).toBeNull()
  })

  it('copyright → year and publisher', () => {
    expect(parseCopyright('1988 Nintendo')).toEqual({ year: 1988, publisher: 'Nintendo' })
    expect(parseCopyright('(C)1993 Hudson Soft')).toEqual({ year: 1993, publisher: 'Hudson Soft' })
    expect(parseCopyright('©1990-1991 Konami')).toEqual({ year: 1990, publisher: 'Konami' })
    expect(parseCopyright('2004')).toEqual({ year: 2004, publisher: null })
    expect(parseCopyright(null)).toEqual({ year: null, publisher: null })
  })
})

describe('modland: provider', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ghost-modland-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const zip = makeZip([{ name: 'allmods.txt', data: SAMPLE }])
  const smb3 = 'Nintendo Sound Format/Koji Kondo/super mario bros 3.nsf'

  function setup(route: Route = () => new NetError('not_found', 'no route'), now = { t: 1_000_000 }) {
    const http = fakeHttp((url, headers) => (url === MODLAND_INDEX_URL ? zip : route(url, headers)))
    const logs: string[] = []
    const p = new ModlandProvider({ http, cacheDir: dir, now: () => now.t, log: (m) => logs.push(m) })
    return { http, p, logs, now }
  }

  it('is an index provider with one section per family', () => {
    const { p } = setup()
    expect(isIndexProvider(p)).toBe(true)
    expect(p.indexRefreshMs).toBe(MODLAND_INDEX_MAX_AGE_MS)
    expect(p.indexPageDelayMs).toBe(0)
    expect(p.indexSections()).toEqual([
      { key: 'spc', label: 'SNES (SPC)' },
      { key: 'nsf', label: 'NES (NSF)' },
      { key: 'gbs', label: 'Game Boy (GBS)' },
      { key: 'vgm', label: 'Sega and others (VGM)' }
    ])
  })

  it('downloads the index once, pages it, and caches it on disk', async () => {
    const { p, http, logs } = setup()
    const spc = await p.fetchIndexPage('spc', 1)
    expect(spc).toMatchObject({ page: 1, totalPages: 1, totalAlbums: 10 })
    expect(spc.items[0]).toMatchObject({ provider: 'modland', ref: "spc/a bug's life (sgb)", title: "A Bug's Life" })
    const vgm = await p.fetchIndexPage('vgm', 1)
    expect(vgm.items.map((i) => i.ref)).toEqual(['vgm/sega megadrive/bare knuckle', 'vgm/sega megadrive/beyond oasis', 'vgm/sega master system/land of illusion', 'vgm/sega megadrive/shougi no hoshi'])
    expect((await p.fetchIndexPage('vgm', 2)).items).toEqual([])
    expect(http.calls.map((c) => c.url)).toEqual([MODLAND_INDEX_URL])
    expect(logs.some((l) => /albums\/files spc 10\/52/.test(l))).toBe(true)
    await expect(p.fetchIndexPage('hes', 1)).rejects.toThrow(/unknown Modland index section/)

    const cache = await readFile(join(dir, 'modland-index.txt'))
    expect(decodeModlandCacheHeader(cache)).toEqual({ fetchedAt: 1_000_000 })
    expect(cache.toString('utf8')).not.toContain('Ace Tracker')

    // A new instance (app restart) reads the cache instead of the network.
    const again = setup(() => new Error('offline'))
    expect((await again.p.fetchIndexPage('nsf', 1)).totalAlbums).toBe(29)
    expect(again.http.calls).toEqual([])
  })

  it('refreshes a stale index, and keeps the old one when the refresh fails', async () => {
    const { p } = setup()
    await p.fetchIndexPage('spc', 1)
    const now = { t: 1_000_000 + MODLAND_INDEX_MAX_AGE_MS + 1 }
    const fresh = setup(undefined, now)
    await fresh.p.fetchIndexPage('spc', 1)
    expect(fresh.http.calls.map((c) => c.url)).toEqual([MODLAND_INDEX_URL])
    // Later pages of a section never trigger a refresh.
    now.t += MODLAND_INDEX_MAX_AGE_MS + 1
    await fresh.p.fetchIndexPage('spc', 2)
    expect(fresh.http.calls.length).toBe(1)

    const failing = new ModlandProvider({
      http: fakeHttp(() => new NetError('network', 'offline')),
      cacheDir: dir,
      now: () => now.t,
      log: () => {}
    })
    const page = await failing.fetchIndexPage('spc', 1)
    expect(page.totalAlbums).toBe(10)

    const empty = await mkdtemp(join(tmpdir(), 'ghost-modland-empty-'))
    try {
      const none = new ModlandProvider({ http: fakeHttp(() => new NetError('network', 'offline')), cacheDir: empty })
      await expect(none.fetchIndexPage('spc', 1)).rejects.toThrow(/offline/)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('lets the parsed index go after it has been unused for a while, and reloads it from disk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const { p, http, logs } = setup()
      await p.fetchIndexPage('spc', 1)
      const held = () => (p as unknown as { index: unknown }).index
      expect(held()).not.toBeNull()
      vi.advanceTimersByTime(MODLAND_INDEX_IDLE_MS - 60_000)
      await p.fetchIndexPage('spc', 1) // a use pushes the release back
      vi.advanceTimersByTime(MODLAND_INDEX_IDLE_MS - 60_000)
      expect(held()).not.toBeNull()
      vi.advanceTimersByTime(120_000)
      expect(held()).toBeNull()
      expect((await p.fetchIndexPage('spc', 1)).totalAlbums).toBe(10)
      expect(http.calls.map((c) => c.url)).toEqual([MODLAND_INDEX_URL]) // from the disk copy
      expect(logs.some((l) => l.startsWith('index cache:'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pages of 500 in a stable order', async () => {
    const lines = Array.from({ length: 1203 }, (_, i) => `${100 + i}\tNintendo Sound Format/Composer ${i % 7}/game ${String(i).padStart(4, '0')}.nsf`).join('\n')
    const big = makeZip([{ name: 'allmods.txt', data: Buffer.from(lines) }])
    const p = new ModlandProvider({ http: fakeHttp(() => big), cacheDir: dir })
    const pages = await Promise.all([1, 2, 3].map((n) => p.fetchIndexPage('nsf', n)))
    expect(pages.map((pg) => [pg.items.length, pg.totalPages, pg.totalAlbums])).toEqual([
      [500, 3, 1203],
      [500, 3, 1203],
      [203, 3, 1203]
    ])
    const titles = pages.flatMap((pg) => pg.items.map((i) => i.title))
    expect(titles[0]).toBe('Game 0000')
    expect(titles[1202]).toBe('Game 1202')
    expect(new Set(pages.flatMap((pg) => pg.items.map((i) => i.ref))).size).toBe(1203)
  })

  it('getAlbum: SPC / VGM folders need no network', async () => {
    const { p, http } = setup()
    const a = await p.getAlbum('spc/plok!')
    expect(http.calls.length).toBe(1)
    expect(a).toMatchObject({
      provider: 'modland',
      ref: 'spc/plok!',
      title: 'Plok!',
      composers: ['Tim Follin', 'Geoff Follin'],
      formats: ['chip'],
      totalSizes: { chip: 5 * 66100 },
      year: null,
      images: [],
      altTitles: []
    })
    expect(a.tracks.map((t) => t.title)).toEqual(['Akrillic', 'Beach', 'Bonus Level', 'Boss', 'Boxing Glove'])
    await expect(p.getAlbum('spc/no such game')).rejects.toSatisfy((e: unknown) => isNetError(e, 'not_found'))
  })

  it('getAlbum: NSF sub-songs from a 128-byte Range request', async () => {
    const { p, http } = setup((url, headers) => {
      expect(url).toBe(modlandFileUrl(smb3))
      expect(headers).toEqual({ Range: 'bytes=0-127' })
      return nsfHeader({ songs: 3, title: 'Super Mario Bros. 3', artist: 'Koji Kondo', copyright: '1988 Nintendo' })
    })
    const a = await p.getAlbum('nsf/koji kondo/super mario bros 3.nsf')
    expect(a).toMatchObject({ title: 'Super Mario Bros. 3', year: 1988, publishers: ['Nintendo'], composers: ['Koji Kondo'], altTitles: [], totalSizes: { chip: 36992 } })
    expect(a.tracks.map((t) => [t.number, t.title, t.locator])).toEqual([
      [1, 'Song 1', `${smb3}#0`],
      [2, 'Song 2', `${smb3}#1`],
      [3, 'Song 3', `${smb3}#2`]
    ])
    expect(a.tracks[2].streams![0]).toEqual({
      provider: 'modland',
      source: { kind: 'http', url: modlandFileUrl(smb3), cacheKey: `modland:${smb3}`, formatHint: 'nsf', subsong: 2 },
      format: 'chip',
      lossless: false,
      bitrateKbps: null,
      sizeBytes: 36992,
      expiresAt: null
    })
    await p.getAlbum('nsf/koji kondo/super mario bros 3.nsf')
    expect(http.calls.length).toBe(2)
    expect(await p.resolveStream(`${smb3}#2`)).toEqual([{ ...a.tracks[2].streams![0], sizeBytes: null }])
    await expect(p.resolveStream('nope')).rejects.toSatisfy((e: unknown) => isNetError(e, 'parse'))
  })

  it('getAlbum: GBS composers from the header when the folder has none; one song → the game title', async () => {
    const { p } = setup((url) => (url.includes('casper') ? gbsHeader({ songs: 1, title: 'Casper', artist: 'Someone Else, Another Person' }) : new NetError('not_found', 'x')))
    const a = await p.getAlbum('gbs/- unknown/casper.gbs')
    expect(a.composers).toEqual(['Someone Else', 'Another Person'])
    expect(a.tracks.map((t) => [t.title, t.locator])).toEqual([['Casper', 'Gameboy Sound System/- unknown/casper.gbs#0']])
    expect(a.tracks[0].streams![0].source).toMatchObject({ formatHint: 'gbs', subsong: 0 })
  })

  it('getAlbum: NSFE is read whole for titles and lengths; a bad header is a parse error', async () => {
    const info = Buffer.alloc(10)
    info[8] = 2
    const file = nsfe([
      ['INFO', info],
      ['auth', zstr('Mother (Famicom)', '<?>', '1989 Nintendo', '')],
      ['tlbl', zstr('Pollyanna', 'Snow Man')],
      ['time', s32(60_000, 30_000)],
      ['NEND', Buffer.alloc(0)]
    ])
    const { p, http } = setup((url) => (url.endsWith('Mother.nsfe') ? file : nsfHeader({ songs: 1 }).subarray(0, 10)))
    const a = await p.getAlbum('nsf/- unknown/mother.nsfe')
    expect(http.calls[1].headers).toEqual({})
    expect(a).toMatchObject({ title: 'Mother', altTitles: ['Mother (Famicom)'], composers: [], year: 1989 })
    expect(a.tracks.map((t) => [t.title, t.durationMs])).toEqual([
      ['Pollyanna', 70_000],
      ['Snow Man', 40_000]
    ])
    await expect(p.getAlbum('nsf/koji kondo/legend of zelda.nsf')).rejects.toSatisfy((e: unknown) => isNetError(e, 'parse'))
  })

  it('searchAlbums matches words or squashed titles', async () => {
    const { p } = setup()
    expect((await p.searchAlbums('plok')).map((h) => h.ref)).toEqual(['spc/plok!'])
    expect((await p.searchAlbums('mario bros 3')).map((h) => h.ref)).toEqual(['nsf/koji kondo/super mario bros 3.nsf'])
    expect((await p.searchAlbums('makerunamakendou')).map((h) => h.ref)).toEqual(['spc/makeruna! makendou'])
    expect(await p.searchAlbums('  ')).toEqual([])
  })
})
