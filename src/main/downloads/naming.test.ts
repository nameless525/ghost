import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { buildDownloadPath, expandHome, extensionFor, MAX_SEGMENT_BYTES, renderTemplateSegments, sanitizeSegment, uniquePath } from './naming'
import { buildTags, fetchableUrl, templateVars } from './tags'
import { makeAlbum, makeTrack } from '../player/testing'

const TEMPLATE = '{game}/{album} ({year})/{disc}-{track} {title}'

describe('renderTemplateSegments', () => {
  it('renders the default template', () => {
    expect(renderTemplateSegments(TEMPLATE, { game: 'Chrono Trigger', album: 'Chrono Trigger OSV', year: 1995, disc: 1, track: 3, title: 'Peaceful Days' })).toEqual([
      'Chrono Trigger',
      'Chrono Trigger OSV (1995)',
      '1-03 Peaceful Days'
    ])
  })

  it('drops brackets and separators left empty by missing values', () => {
    expect(renderTemplateSegments(TEMPLATE, { game: 'Doom', album: 'Doom', year: null, disc: null, track: null, title: 'At Doom’s Gate' })).toEqual(['Doom', 'Doom', 'At Doom’s Gate'])
  })

  it('never lets a value add a folder level or escape the base directory', () => {
    const segs = renderTemplateSegments('{game}/{title}', { game: '../../etc', title: 'AC/DC \\ live' })
    expect(segs).toEqual(['etc', 'AC-DC - live'])
    expect(renderTemplateSegments('../{title}/./x', { title: 'a' })).toEqual(['a', 'x'])
    expect(renderTemplateSegments('/abs/{title}', { title: 'a' })).toEqual(['abs', 'a'])
    expect(renderTemplateSegments('C:\\{title}', { title: 'a' })).toEqual(['a'])
  })

  it('falls back to the title when the template renders to nothing', () => {
    expect(renderTemplateSegments('{nope}', { title: 'Song' })).toEqual(['Song'])
  })
})

describe('sanitizeSegment', () => {
  it('replaces characters illegal on Windows/macOS/Linux', () => {
    expect(sanitizeSegment('Zelda: Breath of the Wild')).toBe('Zelda - Breath of the Wild')
    expect(sanitizeSegment('Re:Zero')).toBe('Re-Zero')
    expect(sanitizeSegment('What? <Boss> *Theme* "Final" | Part 1/2 \\ x')).toBe("What Boss Theme 'Final' - Part 1-2 - x")
    expect(sanitizeSegment('tab\there\u0000nul\u001f')).toBe('tab herenul')
  })

  it('handles dots, spaces and empty names', () => {
    expect(sanitizeSegment('  .hidden. ')).toBe('hidden')
    expect(sanitizeSegment('...')).toBe('_')
    expect(sanitizeSegment('')).toBe('_')
    expect(sanitizeSegment('..')).toBe('_')
    expect(sanitizeSegment('Vol. 2.')).toBe('Vol. 2')
  })

  it('suffixes Windows reserved device names', () => {
    expect(sanitizeSegment('CON')).toBe('CON_')
    expect(sanitizeSegment('nul.txt')).toBe('nul_.txt')
    expect(sanitizeSegment('com1')).toBe('com1_')
    expect(sanitizeSegment('LPT9')).toBe('LPT9_')
    expect(sanitizeSegment('Console')).toBe('Console')
    expect(sanitizeSegment('Con Air')).toBe('Con Air')
  })

  it('truncates to the byte limit without splitting characters, and normalises to NFC', () => {
    const jp = 'ドラゴンクエスト'.repeat(40) // 3 bytes per char
    const s = sanitizeSegment(jp)
    expect(Buffer.byteLength(s, 'utf8')).toBeLessThanOrEqual(MAX_SEGMENT_BYTES)
    expect(s).toBe(jp.slice(0, Math.floor(MAX_SEGMENT_BYTES / 3)))
    const emoji = '🎮'.repeat(100) // 4 bytes, surrogate pairs
    const e = sanitizeSegment(emoji)
    expect(e).toBe('🎮'.repeat(Math.floor(MAX_SEGMENT_BYTES / 4)))
    expect(sanitizeSegment('Pokémon'.normalize('NFD'))).toBe('Pokémon'.normalize('NFC'))
  })
})

describe('buildDownloadPath', () => {
  const vars = { game: 'Final Fantasy VI', album: 'Original Sound Version', year: 1994, disc: 2, track: 5, title: 'Dancing Mad' }

  it('joins base dir, folders, file stem and extension', () => {
    expect(buildDownloadPath({ baseDir: '/Users/me/Music/GHOST/', template: TEMPLATE, vars, ext: 'FLAC', platform: 'darwin' })).toBe(
      '/Users/me/Music/GHOST/Final Fantasy VI/Original Sound Version (1994)/2-05 Dancing Mad.flac'
    )
    expect(buildDownloadPath({ baseDir: 'C:\\Users\\me\\Music\\GHOST', template: TEMPLATE, vars, ext: 'mp3', platform: 'win32' })).toBe(
      'C:\\Users\\me\\Music\\GHOST\\Final Fantasy VI\\Original Sound Version (1994)\\2-05 Dancing Mad.mp3'
    )
  })

  it('keeps Windows paths under MAX_PATH by shortening the longest segments', () => {
    const long = { ...vars, album: 'A'.repeat(170), title: 'T'.repeat(170) }
    const p = buildDownloadPath({ baseDir: 'C:\\Users\\someone\\Music\\GHOST', template: TEMPLATE, vars: long, ext: 'flac', platform: 'win32' })
    expect(p.length).toBeLessThanOrEqual(259 - 4)
    expect(p.endsWith('.flac')).toBe(true)
    expect(p).toContain('\\Final Fantasy VI\\')
    const mac = buildDownloadPath({ baseDir: '/m', template: TEMPLATE, vars: long, ext: 'flac', platform: 'darwin' })
    expect(mac).toContain('A'.repeat(170))
  })
})

describe('expandHome', () => {
  it('expands only a leading ~', () => {
    expect(expandHome('~/Music/GHOST')).toBe(homedir() + '/Music/GHOST')
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('/a/~/b')).toBe('/a/~/b')
    expect(expandHome('~user/x')).toBe('~user/x')
  })
})

describe('uniquePath', () => {
  it('appends a counter before the extension', () => {
    const taken = new Set(['/m/a.mp3', '/m/a (2).mp3'])
    expect(uniquePath('/m/a.mp3', (p) => taken.has(p))).toBe('/m/a (3).mp3')
    expect(uniquePath('/m/b.mp3', (p) => taken.has(p))).toBe('/m/b.mp3')
    expect(uniquePath('/m/Vol. 2/noext', (p) => p === '/m/Vol. 2/noext')).toBe('/m/Vol. 2/noext (2)')
  })
})

describe('extensionFor', () => {
  it('prefers the real container from the URL, then the format hint, then the format', () => {
    expect(extensionFor('mp3', { kind: 'http', url: 'https://x/a%20b.MP3?x=1', cacheKey: 'k' })).toBe('mp3')
    expect(extensionFor('opus', { kind: 'http', url: 'https://rr.googlevideo.com/videoplayback?id=1', cacheKey: 'k', formatHint: 'webm' })).toBe('webm')
    expect(extensionFor('aac', { kind: 'http', url: 'https://x/videoplayback', cacheKey: 'k' })).toBe('m4a')
    expect(extensionFor('chip', { kind: 'http', url: 'https://x/Super%20Metroid.spc', cacheKey: 'k' })).toBe('spc')
    expect(extensionFor('flac', { kind: 'file', path: '/a/b.flac' })).toBe('flac')
    expect(extensionFor('unknown', { kind: 'http', url: 'https://x/page.php', cacheKey: 'k' })).toBe('bin')
  })
})

describe('tags', () => {
  it('builds TagInfo with genre, comment, cover and ReplayGain from the analysis', () => {
    const track = makeTrack('t1', { title: 'Battle', number: 7, disc: 1, composers: ['Uematsu'], gameName: 'FF6' })
    const album = makeAlbum('al1', { title: 'FF6 OSV', year: 1994, trackCount: 61, cover: 'https://img/ff6.jpg' })
    const tags = buildTags(track, album, null, { lufs: -12, truePeakDb: -0.5, bpm: null, beats: [], downbeats: [], kiai: [], energy: [], intensity: null })
    expect(tags).toEqual({
      title: 'Battle',
      album: 'FF6 OSV',
      albumArtist: 'FF6',
      artist: 'Uematsu',
      composer: 'Uematsu',
      trackNumber: 7,
      trackTotal: 61,
      discNumber: 1,
      year: 1994,
      genre: 'Video Game',
      comment: 'GHOST',
      coverUrl: 'https://img/ff6.jpg',
      replayGainTrackDb: -6,
      replayGainTrackPeak: 0.944061
    })
    expect(buildTags(track, null, null, null).replayGainTrackDb).toBeNull()
  })

  it('template vars fall back sensibly', () => {
    const v = templateVars(makeTrack('t', { gameName: null, gameId: null, albumTitle: 'Loose Album', year: null, composers: [] }), null, null)
    expect(v.game).toBe('Loose Album')
    expect(v.year).toBeNull()
    expect(renderTemplateSegments(TEMPLATE, v)).toEqual(['Loose Album', 'Loose Album', '1-01 Track t'])
  })

  it('only passes fetchable cover URLs to the engine', () => {
    expect(fetchableUrl('https://a/b.jpg')).toBe('https://a/b.jpg')
    expect(fetchableUrl('ghost-art://img?u=' + encodeURIComponent('https://a/b.jpg'))).toBe('https://a/b.jpg')
    expect(fetchableUrl('data:image/png;base64,xx')).toBeNull()
    expect(fetchableUrl(null)).toBeNull()
  })
})
