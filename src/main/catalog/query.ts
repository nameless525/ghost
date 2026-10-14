// Search syntax → SQL, and the Browse / search queries built on it.
//
// Free text and the text filters (game/composer/franchise) go through FTS5 trigram indexes
// (album_fts for browse, track_fts for track search). Terms shorter than 3 characters can't use a
// trigram index and fall back to LIKE over the game/album columns. Album-level filters (year, kind,
// platform, source) hit indexed columns; track-level filters (length, bpm, intensity, liked,
// downloaded) are an uncorrelated `a.id IN (SELECT t.album_id …)` so SQLite evaluates them once.

import type { SQLInputValue } from 'node:sqlite'
import { parseSearch, SOURCE_FORMAT_VALUES, type ParsedSearch, type SearchFilter } from '../../shared/search'
import type { Album, BrowseGroup, BrowsePage, BrowseQuery, GroupBy, SortBy, TrackView } from '../../shared/types'
import { ALBUM_COLUMNS, ftsFold, j, toAlbum, type AlbumRowLite, type CatalogRepo, type Quality } from './repo'

export interface CompileCtx {
  likes: boolean
  downloads: boolean
  downloadsStatus: boolean
}

export interface Compiled {
  where: string[]
  params: SQLInputValue[]
  /** Track-level FTS expression for ranking (track queries only). */
  trackMatch: string | null
  /** No filters at all (fast path). */
  empty: boolean
}

const cpLen = (s: string) => [...s].length
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9f]/
const phrase = (t: string) => `"${t.replace(/"/g, '""')}"`
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`
const ph = (n: number) => Array.from({ length: n }, () => '?').join(',')

/** Common alternate spellings → KHInsider platform names / slugs (folded). */
const PLATFORM_ALIASES: Record<string, string[]> = {
  'super nintendo': ['snes'],
  'super famicom': ['snes'],
  sfc: ['snes'],
  famicom: ['nes', 'family'],
  fc: ['nes'],
  'mega drive': ['genesis'],
  megadrive: ['genesis'],
  md: ['genesis'],
  pc: ['windows', 'ms-dos', 'ibm'],
  dos: ['ms-dos'],
  mac: ['macos'],
  osx: ['macos'],
  psx: ['ps1'],
  ps: ['ps1'],
  playstation: ['ps1'],
  'playstation 2': ['ps2'],
  'playstation 3': ['ps3'],
  'playstation 4': ['ps4'],
  'playstation 5': ['ps5'],
  'game boy': ['gb'],
  gameboy: ['gb'],
  'game boy advance': ['gba'],
  'game boy color': ['gbc', 'gb'],
  gcn: ['gc'],
  gamecube: ['gc'],
  'nintendo 64': ['n64'],
  'nintendo switch': ['switch'],
  ns: ['switch'],
  'wii u': ['wii u'],
  x360: ['xbox 360'],
  'pc-98': ['pc-98'],
  pc98: ['pc-98'],
  vita: ['ps vita'],
  'turbografx': ['turbografx-16'],
  'pc engine': ['turbografx-16']
}

function numericCond(col: string, f: SearchFilter, where: string[], params: SQLInputValue[]): void {
  if (f.num === null) return
  switch (f.op) {
    case '=':
      if (f.max !== null) {
        where.push(`(${col} >= ? AND ${col} < ?)`)
        params.push(f.num, f.max)
      } else {
        where.push(`${col} = ?`)
        params.push(f.num)
      }
      return
    case '!=':
      if (f.max !== null) {
        where.push(`(${col} IS NULL OR NOT (${col} >= ? AND ${col} < ?))`)
        params.push(f.num, f.max)
      } else {
        where.push(`(${col} IS NULL OR ${col} != ?)`)
        params.push(f.num)
      }
      return
    default:
      where.push(`${col} ${f.op} ?`)
      params.push(f.num)
  }
}

export class QueryEngine {
  private platformCache: { rev: number; at: number; rows: { slug: string; name_fold: string }[] } | null = null
  private bucketCache = new Map<string, { groups: BucketRow[]; at: number }>()

  constructor(
    private repo: CatalogRepo,
    private quality: () => Quality
  ) {}

  ctx(): CompileCtx {
    const likes = this.repo.tableInfo('likes')
    const dl = this.repo.tableInfo('downloads')
    return { likes: likes.has && likes.cols.has('track_id'), downloads: dl.has && dl.cols.has('track_id'), downloadsStatus: dl.cols.has('status') }
  }

  /** Platform slugs matching a platform filter value. */
  platformSlugs(value: string): string[] {
    const now = Date.now()
    if (!this.platformCache || this.platformCache.rev !== this.repo.revision || now - this.platformCache.at > 60_000) {
      this.platformCache = {
        rev: this.repo.revision,
        at: now,
        rows: this.repo.all<{ slug: string; name_fold: string }>(`SELECT DISTINCT slug, name_fold FROM album_platforms`)
      }
    }
    const wanted = new Set([value, ...(PLATFORM_ALIASES[value] ?? [])])
    const out = new Set<string>()
    for (const r of this.platformCache.rows) {
      if (wanted.has(r.name_fold) || wanted.has(r.slug)) out.add(r.slug)
      else if (cpLen(value) >= 3 && (r.slug.includes(value) || r.name_fold.includes(value))) out.add(r.slug)
    }
    return [...out]
  }

  /**
   * Compile a parsed query. `level='album'` produces conditions on alias `a` (albums);
   * `level='track'` produces conditions on `t` (tracks), `a` and `an` (analysis).
   */
  compile(p: ParsedSearch, level: 'album' | 'track', ctx: CompileCtx = this.ctx()): Compiled {
    const where: string[] = []
    const params: SQLInputValue[] = []
    const albumPos: string[] = []
    const albumNeg: string[] = []
    const trackPos: string[] = []
    const trackNeg: string[] = []
    const tWhere: string[] = []
    const tParams: SQLInputValue[] = []
    const textPos = level === 'album' ? albumPos : trackPos
    const textNeg = level === 'album' ? albumNeg : trackNeg

    /** A multi-word query: a lone letter/digit in it is a word ("mega man 2"), not a title initial. */
    const multiWord = p.terms.length + p.excludes.length > 1
    /**
     * Route one text term. ≥3 characters: an FTS phrase. 2 non-CJK characters: an indexed
     * word-prefix phrase (docs are space-padded, so " ff" matches words starting with "ff").
     * 1 character: alone, game/album title starts with it (index range); among other words, that
     * whole word (" 2 "). Short CJK: LIKE on plain tables.
     */
    const term = (raw: string, negate: boolean, col: 'any' | 'game' | 'composers' | 'franchise', onTrack: boolean) => {
      const t = ftsFold(raw)
      if (!t) return
      const n = cpLen(t)
      const pos = onTrack ? trackPos : albumPos
      const neg = onTrack ? trackNeg : albumNeg
      const colPrefix = col === 'any' ? '' : `{${col}} : `
      if (n >= 3) return void (negate ? neg : pos).push(colPrefix + phrase(t))
      if (n === 2 && !CJK.test(t)) return void (negate ? neg : pos).push(colPrefix + phrase(' ' + t))
      if (n === 1 && !CJK.test(t) && multiWord && col === 'any') return void (negate ? neg : pos).push(phrase(' ' + t + ' '))
      // Short fallbacks on plain tables.
      const not = negate ? 'NOT ' : ''
      if (col === 'composers') {
        where.push(`a.id ${not}IN (SELECT album_id FROM album_composers WHERE name_fold LIKE ? ESCAPE '\\')`)
        params.push(like(t))
      } else if (col === 'franchise') {
        where.push(`a.game_id ${not}IN (SELECT id FROM games WHERE franchise LIKE ? ESCAPE '\\')`)
        params.push(like(t))
      } else if (n === 1 && !CJK.test(t)) {
        // A single letter/digit: names starting with it (uses the sort_name / sort_title indexes).
        const hi = t + '\uffff'
        if (onTrack && col === 'any') {
          where.push(`${negate ? 'NOT ' : ''}(t.title LIKE ? ESCAPE '\\')`)
          params.push(t.replace(/[\\%_]/g, (c) => '\\' + c) + '%')
        } else {
          where.push(`${negate ? 'NOT ' : ''}(a.game_id IN (SELECT id FROM games WHERE sort_name >= ? AND sort_name < ?)${col === 'any' ? ' OR (a.sort_title >= ? AND a.sort_title < ?)' : ''})`)
          params.push(t, hi)
          if (col === 'any') params.push(t, hi)
        }
      } else {
        const conds = [`a.game_id IN (SELECT id FROM games WHERE name LIKE ? ESCAPE '\\' OR alt_names LIKE ? ESCAPE '\\')`]
        params.push(like(t), like(t))
        if (col === 'any') {
          conds.push(`a.title LIKE ? ESCAPE '\\'`, `a.alt_titles LIKE ? ESCAPE '\\'`)
          params.push(like(t), like(t))
          if (onTrack) {
            conds.push(`t.title LIKE ? ESCAPE '\\'`)
            params.push(like(t))
          }
        }
        where.push(`${negate ? 'NOT ' : ''}(${conds.join(' OR ')})`)
      }
    }

    for (const t of p.terms) term(t, false, 'any', level === 'track')
    for (const t of p.excludes) term(t, true, 'any', level === 'track')

    for (const f of p.filters) {
      switch (f.key) {
        case 'game':
        case 'franchise':
        case 'composer': {
          // Track queries match composers per track; game/franchise are album properties.
          const onTrack = level === 'track' && f.key === 'composer'
          term(f.text, f.op === '!=', f.key === 'composer' ? 'composers' : f.key, onTrack)
          break
        }
        case 'platform': {
          const slugs = this.platformSlugs(f.text)
          if (f.op === '!=') {
            if (slugs.length) {
              where.push(`a.id NOT IN (SELECT album_id FROM album_platforms WHERE slug IN (${ph(slugs.length)}))`)
              params.push(...slugs)
            }
          } else if (!slugs.length) where.push('0')
          else {
            where.push(`a.id IN (SELECT album_id FROM album_platforms WHERE slug IN (${ph(slugs.length)}))`)
            params.push(...slugs)
          }
          break
        }
        case 'year':
          numericCond('a.year', f, where, params)
          break
        case 'kind':
          where.push(`a.kind ${f.op === '!=' ? '!=' : '='} ?`)
          params.push(f.text)
          break
        case 'source': {
          const v = f.text
          let cond: string
          const ps: SQLInputValue[] = []
          if (SOURCE_FORMAT_VALUES.has(v)) {
            cond = `(instr(a.formats, ?) > 0 OR a.id IN (SELECT st.album_id FROM sources s JOIN tracks st ON st.id = s.track_id WHERE s.format = ?))`
            ps.push(`"${v}"`, v)
          } else if (v === 'lossless') {
            cond = `(instr(a.formats, '"flac"') > 0 OR instr(a.formats, '"wav"') > 0 OR a.id IN (SELECT st.album_id FROM sources s JOIN tracks st ON st.id = s.track_id WHERE s.lossless = 1))`
          } else if (v === 'lossy') {
            cond = `(instr(a.formats, '"mp3"') > 0 OR instr(a.formats, '"ogg"') > 0 OR instr(a.formats, '"m4a"') > 0 OR instr(a.formats, '"aac"') > 0 OR instr(a.formats, '"opus"') > 0)`
          } else {
            cond = `(a.provider = ? OR a.id IN (SELECT st.album_id FROM sources s JOIN tracks st ON st.id = s.track_id WHERE s.provider = ?))`
            ps.push(v, v)
          }
          where.push(f.op === '!=' ? `NOT ${cond}` : cond)
          params.push(...ps)
          break
        }
        case 'length':
          numericCond('t.duration_ms', f, tWhere, tParams)
          break
        case 'bpm':
          numericCond('an.bpm', f, tWhere, tParams)
          break
        case 'intensity':
          numericCond('an.intensity', f, tWhere, tParams)
          break
        case 'liked':
        case 'downloaded': {
          const has = f.key === 'liked' ? ctx.likes : ctx.downloads
          if (!has) {
            // No table yet: nothing is liked/downloaded.
            tWhere.push(f.bool ? '0' : '1')
            break
          }
          const sub =
            f.key === 'liked'
              ? `SELECT track_id FROM likes`
              : `SELECT track_id FROM downloads${ctx.downloadsStatus ? ` WHERE status = 'done'` : ''}`
          tWhere.push(`t.id ${f.bool ? '' : 'NOT '}IN (${sub})`)
          break
        }
      }
    }

    const ftsCond = (pos: string[], neg: string[], table: string, id: string) => {
      if (pos.length) {
        where.push(`${id} IN (SELECT rowid FROM ${table} WHERE ${table} MATCH ?)`)
        params.push(`(${pos.join(' AND ')})${neg.map((n) => ` NOT ${n}`).join('')}`)
        return `(${pos.join(' AND ')})${neg.map((n) => ` NOT ${n}`).join('')}`
      }
      if (neg.length) {
        where.push(`${id} NOT IN (SELECT rowid FROM ${table} WHERE ${table} MATCH ?)`)
        params.push(neg.join(' OR '))
      }
      return null
    }
    ftsCond(albumPos, albumNeg, 'album_fts', 'a.id')
    const trackMatch = level === 'track' ? ftsCond(trackPos, trackNeg, 'track_fts', 't.id') : null

    if (tWhere.length) {
      if (level === 'album') {
        where.push(`a.id IN (SELECT t.album_id FROM tracks t LEFT JOIN analysis an ON an.track_id = t.id WHERE t.removed = 0 AND ${tWhere.join(' AND ')})`)
        params.push(...tParams)
      } else {
        where.push(...tWhere)
        params.push(...tParams)
      }
    }
    return { where, params, trackMatch, empty: where.length === 0 }
  }

  // ---------------------------------------------------------------------------
  // Browse

  browse(q: BrowseQuery): BrowsePage {
    const limit = Math.max(1, Math.min(500, Math.floor(q.limit || 50)))
    const offset = Math.max(0, Math.floor(q.offset || 0))
    const c = this.compile(parseSearch(q.text), 'album')
    switch (q.group) {
      case 'album':
        return this.browseAlbums(c, q.sort, offset, limit)
      case 'game':
        return this.browseGames(c, q.sort, offset, limit)
      default:
        return this.browseBuckets(q.group, q.text, c, q.sort, offset, limit)
    }
  }

  private gameFilter(c: Compiled): { sql: string; params: SQLInputValue[] } {
    if (c.empty) return { sql: '', params: [] }
    return { sql: `WHERE g.id IN (SELECT a.game_id FROM albums a WHERE a.gone = 0 AND ${c.where.join(' AND ')})`, params: c.params }
  }

  private browseGames(c: Compiled, sort: SortBy, offset: number, limit: number): BrowsePage {
    const f = this.gameFilter(c)
    const total = this.repo.get<{ n: number }>(`SELECT COUNT(*) AS n FROM games g ${f.sql}`, ...f.params)!.n
    const rows = this.repo.all<GameGroupRow>(
      `SELECT g.id, g.name, g.year, g.platforms, g.cover, g.hero, g.accent, g.album_count FROM games g ${f.sql} ORDER BY ${GAME_ORDER[sort] ?? GAME_ORDER.title} LIMIT ? OFFSET ?`,
      ...f.params,
      limit,
      offset
    )
    return { total, offset, groups: rows.map(gameGroup) }
  }

  private browseAlbums(c: Compiled, sort: SortBy, offset: number, limit: number): BrowsePage {
    const where = ['a.gone = 0', ...c.where].join(' AND ')
    const total = this.repo.get<{ n: number }>(`SELECT COUNT(*) AS n FROM albums a WHERE ${where}`, ...c.params)!.n
    const rows = this.repo.all<AlbumGroupRow>(
      `SELECT a.id, a.title, a.kind, a.year, a.platforms, a.cover, a.game_id, g.name AS game_name, g.cover AS game_cover, g.hero, g.accent
       FROM albums a LEFT JOIN games g ON g.id = a.game_id WHERE ${where} ORDER BY ${ALBUM_ORDER[sort] ?? ALBUM_ORDER.title} LIMIT ? OFFSET ?`,
      ...c.params,
      limit,
      offset
    )
    return {
      total,
      offset,
      groups: rows.map((r) => {
        const platforms = j<string[]>(r.platforms, [])
        return {
          key: `album:${r.id}`,
          kind: 'album' as const,
          title: r.title,
          subtitle: [r.game_name && r.game_name !== r.title ? r.game_name : null, r.year, KIND_LABEL[r.kind] ?? null].filter(Boolean).join(' · ') || null,
          cover: r.cover ?? r.game_cover ?? null,
          hero: r.hero ?? null,
          accent: r.accent ?? null,
          year: r.year ?? null,
          platforms,
          albumCount: 1,
          gameId: r.game_id != null ? String(r.game_id) : null
        }
      })
    }
  }

  /** Aggregate buckets (+ representative art) for a non-game grouping; cached per query and revision. */
  private bucketRows(group: GroupBy, text: string, c: Compiled): BucketRow[] {
    const cacheKey = `${group}\u0000${text}\u0000${this.repo.revision}`
    const hit = this.bucketCache.get(cacheKey)
    if (hit && Date.now() - hit.at < 60_000) return hit.groups
    const where = ['a.gone = 0', ...c.where].join(' AND ')
    let from: string
    let key: string
    let title: string
    let extraWhere = ''
    switch (group) {
      case 'platform':
        from = 'album_platforms ap JOIN albums a ON a.id = ap.album_id'
        key = 'ap.slug'
        title = 'MIN(ap.name)'
        break
      case 'year':
        from = 'albums a'
        key = 'a.year'
        title = "COALESCE(CAST(a.year AS TEXT), 'Unknown year')"
        break
      case 'composer':
        from = 'album_composers ac JOIN albums a ON a.id = ac.album_id'
        key = 'ac.name_fold'
        title = 'MIN(ac.name)'
        break
      case 'franchise':
        from = 'albums a JOIN games g ON g.id = a.game_id'
        key = 'lower(g.franchise)'
        title = 'MIN(g.franchise)'
        extraWhere = 'g.franchise IS NOT NULL AND '
        break
      default:
        return []
    }
    const rows = this.repo.all<BucketRow>(
      `SELECT ${key} AS k, ${title} AS title, COUNT(*) AS n, MIN(a.sort_year) AS y, MAX(a.sort_added) AS added, SUM(a.total_ms) AS len,
              AVG(a.intensity) AS inten${group === 'franchise' ? ', COUNT(DISTINCT g.id) AS games' : ''}
       FROM ${from} WHERE ${extraWhere}${where} GROUP BY ${key}`,
      ...c.params
    )
    // Representative art: the most recently added album with a cover in each bucket (SQLite's
    // bare-column rule returns the other columns from the row holding MAX()).
    const art = new Map<string, { cover: string; hero: string | null; accent: string | null }>()
    const artFrom = group === 'franchise' ? from : `${from} LEFT JOIN games g ON g.id = a.game_id`
    for (const r of this.repo.all<{ k: unknown; cover: string; hero: string | null; accent: string | null }>(
      `SELECT ${key} AS k, COALESCE(a.cover, g.cover) AS cover, g.hero AS hero, g.accent AS accent, MAX(a.sort_added * 8 - a.kind_rank) AS score
       FROM ${artFrom} WHERE ${extraWhere}${where} AND COALESCE(a.cover, g.cover) IS NOT NULL GROUP BY ${key}`,
      ...c.params
    )) {
      art.set(String(r.k ?? 'unknown'), { cover: r.cover, hero: r.hero, accent: r.accent })
    }
    for (const r of rows) {
      r.k = String(r.k ?? 'unknown')
      const a = art.get(r.k)
      r.cover = a?.cover ?? null
      r.hero = a?.hero ?? null
      r.accent = a?.accent ?? null
    }
    this.bucketCache.set(cacheKey, { groups: rows, at: Date.now() })
    if (this.bucketCache.size > 16) this.bucketCache.delete(this.bucketCache.keys().next().value!)
    return rows
  }

  private browseBuckets(group: GroupBy, text: string, c: Compiled, sort: SortBy, offset: number, limit: number): BrowsePage {
    const rows = [...this.bucketRows(group, text, c)]
    const byTitle = (a: BucketRow, b: BucketRow) => (group === 'year' ? (a.y ?? 9999) - (b.y ?? 9999) : a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }))
    const seed = sortSeed()
    switch (sort) {
      case 'year':
        rows.sort((a, b) => (a.y ?? 9999) - (b.y ?? 9999) || byTitle(a, b))
        break
      case 'recent':
        rows.sort((a, b) => (b.added ?? 0) - (a.added ?? 0) || byTitle(a, b))
        break
      case 'length':
        rows.sort((a, b) => b.n - a.n || byTitle(a, b))
        break
      case 'intensity':
        rows.sort((a, b) => (a.inten ?? 1000) - (b.inten ?? 1000) || byTitle(a, b))
        break
      case 'random':
        rows.sort((a, b) => hash32(a.k + seed) - hash32(b.k + seed))
        break
      default:
        rows.sort(byTitle)
    }
    const groups: BrowseGroup[] = rows.slice(offset, offset + limit).map((r) => {
      const year = r.y != null && r.y < 9999 ? r.y : null
      const subtitle = [
        group === 'franchise' && r.games ? `${r.games} game${r.games === 1 ? '' : 's'}` : null,
        `${r.n} album${r.n === 1 ? '' : 's'}`,
        group !== 'year' && year ? `since ${year}` : null
      ]
        .filter(Boolean)
        .join(' · ')
      return {
        key: `${group}:${r.k}`,
        kind: group,
        title: r.title,
        subtitle,
        cover: r.cover ?? null,
        hero: r.hero ?? null,
        accent: r.accent ?? null,
        year: group === 'year' ? (r.k === 'unknown' ? null : Number(r.k)) : year,
        platforms: group === 'platform' ? [r.title] : [],
        albumCount: r.n,
        gameId: null
      }
    })
    return { total: rows.length, offset, groups }
  }

  /** Albums in a carousel group, filtered by the same query. */
  groupAlbums(groupKey: string, q: Pick<BrowseQuery, 'text' | 'group' | 'sort'>): Album[] {
    const i = groupKey.indexOf(':')
    const kind = (i > 0 ? groupKey.slice(0, i) : 'game') as GroupBy
    const value = i > 0 ? groupKey.slice(i + 1) : groupKey
    const c = this.compile(parseSearch(q.text), 'album')
    const scope = bucketScope(kind, value)
    const where = ['a.gone = 0', scope.sql, ...c.where].join(' AND ')
    const order = kind === 'game' && (q.sort === 'title' || q.sort === 'year') ? 'a.kind_rank, a.sort_year, a.sort_title, a.id' : ALBUM_ORDER[q.sort] ?? ALBUM_ORDER.title
    const rows = this.repo.all<AlbumRowLite>(
      `SELECT ${ALBUM_COLUMNS} FROM albums a LEFT JOIN games g ON g.id = a.game_id WHERE ${where} ORDER BY ${order} LIMIT 1000`,
      ...scope.params,
      ...c.params
    )
    return rows.map(toAlbum)
  }

  /** Random game (and album in it) matching the query, for F2. */
  random(text = ''): { groupKey: string; albumId: string | null } | null {
    const c = this.compile(parseSearch(text), 'album')
    const f = this.gameFilter(c)
    const n = this.repo.get<{ n: number }>(`SELECT COUNT(*) AS n FROM games g ${f.sql}`, ...f.params)!.n
    if (!n) return null
    const off = Math.floor(Math.random() * n)
    const g = this.repo.get<{ id: number }>(`SELECT g.id FROM games g ${f.sql} ORDER BY g.rnd LIMIT 1 OFFSET ?`, ...f.params, off)
    if (!g) return null
    const where = ['a.gone = 0', 'a.game_id = ?', ...c.where].join(' AND ')
    const a = this.repo.get<{ id: number }>(`SELECT a.id FROM albums a WHERE ${where} ORDER BY random() LIMIT 1`, g.id, ...c.params)
    return { groupKey: `game:${g.id}`, albumId: a ? String(a.id) : null }
  }

  // ---------------------------------------------------------------------------
  // Track queries

  private trackQuery(text: string, limit: number, ranked: boolean): { where: string; params: SQLInputValue[]; order: string; join: string } | null {
    const p = parseSearch(text)
    if (p.empty) return null
    const c = this.compile(p, 'track')
    const where = ['t.removed = 0', 'a.gone = 0', ...c.where].join(' AND ')
    if (ranked && c.trackMatch) {
      return {
        join: `JOIN (SELECT rowid AS rid, rank FROM track_fts WHERE track_fts MATCH ?) m ON m.rid = t.id`,
        where,
        params: [c.trackMatch, ...c.params, limit],
        order: `ORDER BY m.rank, a.sort_title, t.disc, t.position LIMIT ?`
      }
    }
    return { join: '', where, params: [...c.params, limit], order: `ORDER BY a.sort_title, t.disc, t.position LIMIT ?` }
  }

  searchTracks(text: string, limit = 50): TrackView[] {
    const q = this.trackQuery(text, Math.max(1, Math.min(1000, limit)), true)
    if (!q) return []
    const rows = this.repo.all<Parameters<CatalogRepo['toTrackViews']>[0][number]>(
      `SELECT ${TRACK_COLS} FROM tracks t ${q.join} JOIN albums a ON a.id = t.album_id LEFT JOIN games g ON g.id = a.game_id LEFT JOIN analysis an ON an.track_id = t.id
       WHERE ${q.where} ${q.order}`,
      ...q.params
    )
    return this.repo.toTrackViews(rows, this.quality())
  }

  queryTrackIds(text: string, limit = 1000): string[] {
    const q = this.trackQuery(text, Math.max(1, Math.min(10_000, limit)), false)
    if (!q) return []
    return this.repo
      .all<{ id: number }>(
        `SELECT t.id FROM tracks t JOIN albums a ON a.id = t.album_id LEFT JOIN analysis an ON an.track_id = t.id WHERE ${q.where} ${q.order}`,
        ...q.params
      )
      .map((r) => String(r.id))
  }
}

const TRACK_COLS = `
  t.id, t.album_id, t.disc, t.number, t.title, t.title_original, t.duration_ms, t.composers, t.files, t.locator,
  a.title AS album_title, a.kind AS album_kind, a.year AS album_year, a.platforms AS album_platforms,
  a.cover AS album_cover, a.composers AS album_composers, a.provider AS album_provider, a.provider_ref AS album_ref,
  g.id AS game_id, g.name AS game_name, g.year AS game_year, g.cover AS game_cover, g.hero AS game_hero, g.accent AS game_accent,
  an.bpm AS bpm, an.intensity AS intensity, an.lufs AS lufs`

export const GAME_ORDER: Record<SortBy, string> = {
  title: 'g.sort_name, g.id',
  year: 'g.sort_year, g.sort_name, g.id',
  recent: 'g.added_at DESC, g.sort_name, g.id',
  length: 'g.sort_len, g.sort_name, g.id',
  intensity: 'g.sort_intensity, g.sort_name, g.id',
  random: 'g.rnd, g.id'
}

export const ALBUM_ORDER: Record<SortBy, string> = {
  title: 'a.sort_title, a.id',
  year: 'a.sort_year, a.sort_title, a.id',
  recent: 'a.sort_added DESC, a.sort_title, a.id',
  length: 'a.sort_len, a.sort_title, a.id',
  intensity: 'a.sort_intensity, a.sort_title, a.id',
  random: 'a.rnd, a.id'
}

const KIND_LABEL: Record<string, string> = {
  ost: 'Soundtrack',
  gamerip: 'Gamerip',
  arrange: 'Arrangement',
  remix: 'Remix',
  single: 'Single',
  compilation: 'Compilation',
  other: 'Other'
}

interface GameGroupRow {
  id: number
  name: string
  year: number | null
  platforms: string
  cover: string | null
  hero: string | null
  accent: string | null
  album_count: number
}

interface AlbumGroupRow {
  id: number
  title: string
  kind: string
  year: number | null
  platforms: string
  cover: string | null
  game_id: number | null
  game_name: string | null
  game_cover: string | null
  hero: string | null
  accent: string | null
}

interface BucketRow {
  k: string
  title: string
  n: number
  y: number | null
  added: number | null
  len: number | null
  inten: number | null
  games?: number
  cover?: string | null
  hero?: string | null
  accent?: string | null
}

function platformSummary(platforms: string[]): string {
  if (!platforms.length) return ''
  const shown = platforms.slice(0, 3).join(' · ')
  return platforms.length > 3 ? `${shown} +${platforms.length - 3}` : shown
}

function gameGroup(r: GameGroupRow): BrowseGroup {
  const platforms = j<string[]>(r.platforms, [])
  return {
    key: `game:${r.id}`,
    kind: 'game',
    title: r.name,
    subtitle: [r.year, platformSummary(platforms)].filter(Boolean).join(' · ') || null,
    cover: r.cover ?? null,
    hero: r.hero ?? null,
    accent: r.accent ?? null,
    year: r.year ?? null,
    platforms,
    albumCount: r.album_count,
    gameId: String(r.id)
  }
}

/** SQL scope (on alias a) for a group key's members. */
function bucketScope(kind: GroupBy, value: string): { sql: string; params: SQLInputValue[] } {
  switch (kind) {
    case 'game':
      return { sql: 'a.game_id = ?', params: [Number(value)] }
    case 'album':
      return { sql: 'a.id = ?', params: [Number(value)] }
    case 'platform':
      return { sql: 'a.id IN (SELECT album_id FROM album_platforms WHERE slug = ?)', params: [value] }
    case 'year':
      return value === 'unknown' ? { sql: 'a.year IS NULL', params: [] } : { sql: 'a.year = ?', params: [Number(value)] }
    case 'composer':
      return { sql: 'a.id IN (SELECT album_id FROM album_composers WHERE name_fold = ?)', params: [value] }
    case 'franchise':
      return { sql: 'a.game_id IN (SELECT id FROM games WHERE lower(franchise) = ?)', params: [value] }
  }
}

let seedValue = String(Math.random())
function sortSeed(): string {
  return seedValue
}
/** Reshuffle 'random' sort orders. */
export function reseedRandom(): void {
  seedValue = String(Math.random())
}

function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
