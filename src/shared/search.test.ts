import { describe, expect, it } from 'vitest'
import { foldText, formatFilter, parseDuration, parseSearch } from './search'

const f = (q: string) => parseSearch(q).filters
const one = (q: string) => {
  const fs = f(q)
  expect(fs).toHaveLength(1)
  return fs[0]
}

describe('parseSearch: free text', () => {
  it('empty input', () => {
    for (const q of ['', '   ', null, undefined]) {
      const p = parseSearch(q as string)
      expect(p.empty).toBe(true)
      expect(p.terms).toEqual([])
      expect(p.tokens).toEqual([])
    }
  })

  it('splits words and folds case / width', () => {
    const p = parseSearch('Chrono  ＴＲＩＧＧＥＲ')
    expect(p.terms).toEqual(['chrono', 'trigger'])
    expect(p.empty).toBe(false)
  })

  it('quoted phrases keep spaces; smart and Japanese quotes work; unclosed quote runs to end', () => {
    expect(parseSearch('"battle with magus" boss').terms).toEqual(['battle with magus', 'boss'])
    expect(parseSearch('“battle  theme”').terms).toEqual(['battle theme'])
    expect(parseSearch('「戦闘 曲」').terms).toEqual(['戦闘 曲'])
    expect(parseSearch('"unclosed phrase').terms).toEqual(['unclosed phrase'])
  })

  it('apostrophes are not quotes', () => {
    expect(parseSearch("assassin's creed").terms).toEqual(["assassin's", 'creed'])
  })

  it('exclusions with -word and -"phrase"', () => {
    const p = parseSearch('mario -remix -"piano cover" -')
    expect(p.terms).toEqual(['mario'])
    expect(p.excludes).toEqual(['remix', 'piano cover'])
  })

  it('ignores pure punctuation terms', () => {
    expect(parseSearch('mario ~ - !').terms).toEqual(['mario'])
  })

  it('CJK text', () => {
    expect(parseSearch('クロノ・トリガー').terms).toEqual(['クロノ・トリガー'])
  })

  it('unknown keys are free text', () => {
    const p = parseSearch('foo=bar')
    expect(p.filters).toEqual([])
    expect(p.terms).toEqual(['foo=bar'])
  })

  it('word followed by colon and space stays text', () => {
    const p = parseSearch('Kirby: Planet Robobot')
    expect(p.filters).toEqual([])
    expect(p.terms).toEqual(['kirby:', 'planet', 'robobot'])
    const q = parseSearch('Game: the movie')
    expect(q.filters).toEqual([])
    expect(q.terms).toEqual(['game:', 'the', 'movie'])
  })

  it('a bare key word is text', () => {
    expect(parseSearch('game over').terms).toEqual(['game', 'over'])
    expect(parseSearch('game over').filters).toEqual([])
  })
})

describe('parseSearch: filters', () => {
  it('the DESIGN example', () => {
    const p = parseSearch('boss platform=snes intensity>5 length<4m')
    expect(p.terms).toEqual(['boss'])
    expect(p.filters.map((x) => [x.key, x.op])).toEqual([
      ['platform', '='],
      ['intensity', '>'],
      ['length', '<']
    ])
    expect(p.filters[0].text).toBe('snes')
    expect(p.filters[1].num).toBe(5)
    expect(p.filters[2].num).toBe(240_000)
    expect(p.errors).toEqual([])
  })

  it('all operators and their aliases', () => {
    expect(one('year=1995').op).toBe('=')
    expect(one('year==1995').op).toBe('=')
    expect(one('year:1995').op).toBe('=')
    expect(one('year!=1995').op).toBe('!=')
    expect(one('year<>1995').op).toBe('!=')
    expect(one('year>1995').op).toBe('>')
    expect(one('year<1995').op).toBe('<')
    expect(one('year>=1995').op).toBe('>=')
    expect(one('year=>1995').op).toBe('>=')
    expect(one('year<=1995').op).toBe('<=')
    expect(one('year=<1995').op).toBe('<=')
  })

  it('tolerates spaces around operators (except colon)', () => {
    const a = one('year >= 2000')
    expect(a).toMatchObject({ key: 'year', op: '>=', num: 2000 })
    const b = one('composer = mitsuda')
    expect(b).toMatchObject({ key: 'composer', text: 'mitsuda' })
  })

  it('key aliases and case-insensitive keys', () => {
    expect(one('Artist=Uematsu').key).toBe('composer')
    expect(one('series=zelda').key).toBe('franchise')
    expect(one('console=gba').key).toBe('platform')
    expect(one('DUR<3m').key).toBe('length')
    expect(one('stars>=6').key).toBe('intensity')
    expect(one('type=gamerip').key).toBe('kind')
    expect(one('fmt=flac').key).toBe('source')
    expect(one('fav=yes').key).toBe('liked')
    expect(one('dl=yes').key).toBe('downloaded')
  })

  it('quoted filter values', () => {
    const x = one('composer="Yoko Shimomura"')
    expect(x.value).toBe('Yoko Shimomura')
    expect(x.text).toBe('yoko shimomura')
  })

  it('text filters reject range operators', () => {
    const p = parseSearch('composer>abc')
    expect(p.filters).toEqual([])
    expect(p.errors).toHaveLength(1)
    expect(p.tokens.map((t) => t.type)).toEqual(['key', 'op', 'invalid'])
  })

  it('year values: 4-digit, 2-digit and decades', () => {
    expect(one('year=1995')).toMatchObject({ num: 1995, max: 1996 })
    expect(one('year=95')).toMatchObject({ num: 1995, max: 1996 })
    expect(one('year=05')).toMatchObject({ num: 2005, max: 2006 })
    expect(one('year=1990s')).toMatchObject({ num: 1990, max: 2000 })
    expect(one('year=90s')).toMatchObject({ num: 1990, max: 2000 })
    expect(one('year=199x')).toMatchObject({ num: 1990, max: 2000 })
    expect(one('year>1990s')).toMatchObject({ op: '>', num: 1999 })
    expect(one('year<1990s')).toMatchObject({ op: '<', num: 1990 })
    expect(one('year<=1990s')).toMatchObject({ op: '<=', num: 1999 })
    expect(one('year>=1990s')).toMatchObject({ op: '>=', num: 1990 })
    expect(parseSearch('year=abc').errors).toHaveLength(1)
  })

  it('length values', () => {
    expect(one('length<4m').num).toBe(240_000)
    expect(one('length<3:30').num).toBe(210_000)
    expect(one('length<240s').num).toBe(240_000)
    expect(one('length<240').num).toBe(240_000)
    expect(one('length>4m30s').num).toBe(270_000)
    expect(one('length>1h').num).toBe(3_600_000)
    // = means "rounds to" at the precision typed
    expect(one('length=4m')).toMatchObject({ num: 240_000, max: 300_000 })
    expect(one('length=3:30')).toMatchObject({ num: 210_000, max: 211_000 })
    // Equivalent spellings: the same range.
    for (const [colon, unit] of [
      ['3:30.5', '210.5s'],
      ['1:02:03.25', '3723.25s'],
      ['3:30', '210s']
    ]) {
      const a = one(`length=${colon}`)
      const b = one(`length=${unit}`)
      expect([a.num, a.max]).toEqual([b.num, b.max])
    }
    expect(one('length=3:30.5')).toMatchObject({ num: 210_500, max: 210_600 })
    expect(parseSearch('length<soon').errors).toHaveLength(1)
  })

  it('number values with = as rounding range', () => {
    expect(one('bpm=140')).toMatchObject({ num: 139.5, max: 140.5 })
    const s = one('intensity=5.2')
    expect(s.num).toBeCloseTo(5.15)
    expect(s.max).toBeCloseTo(5.25)
    expect(one('bpm>=140bpm').num).toBe(140)
    expect(one('stars>6.5★').num).toBe(6.5)
    expect(parseSearch('bpm>fast').errors).toHaveLength(1)
  })

  it('kind values map to canonical AlbumKind', () => {
    expect(one('kind=soundtrack').text).toBe('ost')
    expect(one('kind=OST').text).toBe('ost')
    expect(one('kind=rip').text).toBe('gamerip')
    expect(one('kind=arrangement').text).toBe('arrange')
    expect(one('kind!=remix')).toMatchObject({ op: '!=', text: 'remix' })
    expect(parseSearch('kind=banana').errors).toHaveLength(1)
  })

  it('source values map to canonical ids', () => {
    expect(one('source=FLAC').text).toBe('flac')
    expect(one('source=yt').text).toBe('youtube')
    expect(one('source=kh').text).toBe('khinsider')
    expect(one('source=chip').text).toBe('chip')
    expect(one('source=lossless').text).toBe('lossless')
  })

  it('bool values; != flips', () => {
    expect(one('liked=yes').bool).toBe(true)
    expect(one('liked=no').bool).toBe(false)
    expect(one('liked=1').bool).toBe(true)
    expect(one('downloaded=false').bool).toBe(false)
    expect(one('liked!=yes')).toMatchObject({ op: '=', bool: false })
    expect(parseSearch('liked=maybe').errors).toHaveLength(1)
  })

  it('incomplete filters while typing are ignored without errors', () => {
    const p = parseSearch('boss platform=')
    expect(p.terms).toEqual(['boss'])
    expect(p.filters).toEqual([])
    expect(p.errors).toEqual([])
    expect(p.tokens.map((t) => t.type)).toEqual(['text', 'key', 'op'])
  })

  it('full-width operators and keys via NFKC are text (keys must be ASCII) but values fold', () => {
    expect(one('platform=ＳＮＥＳ').text).toBe('snes')
  })

  it('multiple filters of the same key are all kept', () => {
    const fs = f('year>=1990 year<2000')
    expect(fs.map((x) => [x.op, x.num])).toEqual([
      ['>=', 1990],
      ['<', 2000]
    ])
  })
})

describe('parseSearch: tokens for highlighting', () => {
  it('covers every non-space character with offsets', () => {
    const q = ' boss  platform=snes "a b" -remix year>abc'
    const p = parseSearch(q)
    for (const t of p.tokens) expect(q.slice(t.start, t.end)).toBe(t.text)
    const covered = new Set<number>()
    for (const t of p.tokens) for (let i = t.start; i < t.end; i++) covered.add(i)
    for (let i = 0; i < q.length; i++) if (q[i] !== ' ') expect(covered.has(i)).toBe(true)
    expect(p.tokens.map((t) => t.type)).toEqual(['text', 'key', 'op', 'value', 'phrase', 'exclude', 'key', 'op', 'invalid'])
    expect(p.errors[0]).toMatchObject({ start: q.indexOf('abc'), end: q.length })
  })

  it('tokens are sorted and non-overlapping', () => {
    const p = parseSearch('a=1 composer  =  "x y" bpm>=140 "q')
    let last = -1
    for (const t of p.tokens) {
      expect(t.start).toBeGreaterThanOrEqual(last)
      expect(t.end).toBeGreaterThan(t.start)
      last = t.end
    }
  })
})

describe('helpers', () => {
  it('parseDuration', () => {
    expect(parseDuration('4m')).toEqual({ ms: 240_000, unit: 60_000 })
    expect(parseDuration('3:30')).toEqual({ ms: 210_000, unit: 1000 })
    expect(parseDuration('1:02:03')).toEqual({ ms: 3_723_000, unit: 1000 })
    expect(parseDuration('240s')).toEqual({ ms: 240_000, unit: 1000 })
    expect(parseDuration('4.5m')!.ms).toBe(270_000)
    expect(parseDuration('90 sec')!.ms).toBe(90_000)
    expect(parseDuration('3:30.5')).toEqual({ ms: 210_500, unit: 100 })
    expect(parseDuration('1:02:03.25')).toEqual({ ms: 3_723_250, unit: 10 })
    expect(parseDuration('3:30.12345')).toEqual({ ms: 210_123, unit: 1 })
    expect(parseDuration('3:75')).toBeNull()
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('abc')).toBeNull()
  })

  it('foldText', () => {
    expect(foldText('  Ｆｉｎａｌ   FANTASY ')).toBe('final fantasy')
  })

  it('formatFilter round-trips', () => {
    const x = one('composer="yoko shimomura"')
    expect(formatFilter(x)).toBe('composer="yoko shimomura"')
    expect(one(formatFilter(x)).text).toBe('yoko shimomura')
  })

  it('never throws on random input', () => {
    const chars = 'ab =<>!:"\'-12 m:s“「★'
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let n = 0; n < 2000; n++) {
      let q = ''
      const len = Math.floor(rnd() * 20)
      for (let i = 0; i < len; i++) q += chars[Math.floor(rnd() * chars.length)]
      q = q.replace(/ab/g, () => ['year', 'bpm', 'length', 'kind', 'liked', 'game'][Math.floor(rnd() * 6)])
      expect(() => parseSearch(q)).not.toThrow()
    }
  })
})
