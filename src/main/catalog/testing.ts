// Test helpers: an in-memory catalog seeded through the same write path the crawler uses.
import { DatabaseSync } from 'node:sqlite'
import type { AlbumKind } from '../../shared/types'
import type { AlbumHit, PlatformRef, ProviderAlbum } from '../providers/types'
import { CatalogRepo } from './repo'

export function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY;')
  return db
}

export const P = {
  snes: { slug: 'nintendo-snes', name: 'SNES' },
  ps1: { slug: 'playstation', name: 'PS1' },
  win: { slug: 'windows', name: 'Windows' },
  switch: { slug: 'nintendo-switch', name: 'Switch' },
  ds: { slug: 'nintendo-ds', name: 'DS' },
  genesis: { slug: 'sega-mega-drive-genesis', name: 'Genesis' },
  gba: { slug: 'gameboy-advance', name: 'GBA' }
} satisfies Record<string, PlatformRef>

export function hit(ref: string, title: string, kind: AlbumKind, year: number | null, platforms: PlatformRef[], extra: Partial<AlbumHit> = {}): AlbumHit {
  return {
    provider: 'khinsider',
    ref,
    title,
    titleFromRef: false,
    platforms,
    kind,
    typeLabel: null,
    year,
    thumb: `https://img.example/${ref}/thumbs_small/c.jpg`,
    cover: `https://img.example/${ref}/c.jpg`,
    catalogNo: null,
    addedAt: null,
    ...extra
  }
}

export function detail(h: AlbumHit, tracks: { title: string; ms: number; disc?: number }[], extra: Partial<ProviderAlbum> = {}): ProviderAlbum {
  return {
    ...h,
    altTitles: [],
    titleOriginal: null,
    developers: [],
    publishers: [],
    composers: [],
    images: h.cover ? [h.cover] : [],
    description: null,
    formats: ['mp3', 'flac'],
    totalSizes: {},
    externalId: null,
    tracks: tracks.map((t, i) => ({
      disc: t.disc ?? 1,
      number: i + 1,
      title: t.title,
      durationMs: t.ms,
      locator: `${h.ref}/${String(i + 1).padStart(2, '0')}%2520${encodeURIComponent(encodeURIComponent(t.title))}.mp3`,
      files: [
        { format: 'mp3' as const, sizeBytes: Math.round((t.ms / 1000) * 40_000) },
        { format: 'flac' as const, sizeBytes: Math.round((t.ms / 1000) * 120_000) }
      ],
      composers: []
    })),
    ...extra
  }
}

/** A small hand-written catalog covering the interesting cases. */
export function seedSmall(repo: CatalogRepo): { albums: Record<string, number> } {
  const hits = [
    hit('chrono-trigger-osv', 'Chrono Trigger Original Sound Version', 'ost', 1995, [P.snes]),
    hit('chrono-trigger-snes-gamerip', 'Chrono Trigger (SNES) (Gamerip)', 'gamerip', 1995, [P.snes]),
    hit('chrono-trigger-ds-gamerip', 'Chrono Trigger (DS) (Gamerip)', 'gamerip', 2008, [P.ds]),
    hit('chrono-trigger-time-warp', 'Chrono Trigger: Time Warp Melodies', 'arrange', 2016, [P.snes]),
    hit('chrono-cross-ost', 'Chrono Cross Original Soundtrack', 'ost', 1999, [P.ps1]),
    hit('ff6-osv', 'Final Fantasy VI Original Sound Version', 'ost', 1994, [P.snes]),
    hit('ff7-ost', 'Final Fantasy VII Original Soundtrack', 'ost', 1997, [P.ps1, P.win]),
    hit('hollow-knight-ost', 'Hollow Knight', 'ost', 2017, [P.win, P.switch]),
    hit('silksong', 'Hollow Knight: Silksong', 'ost', 2025, [P.win, P.switch], { cover: null, thumb: null }),
    hit('sonic-1', 'Sonic the Hedgehog (Genesis) (Gamerip)', 'gamerip', 1991, [P.genesis]),
    hit('ys-ost', 'Ys OST', 'ost', 1987, []),
    hit('kirby-gba', 'Kirby: Nightmare in Dream Land', 'gamerip', 2002, [P.gba])
  ]
  const ids = repo.upsertHits(hits, { initial: true })
  repo.assignGames(ids)
  const albums: Record<string, number> = {}
  hits.forEach((h, i) => (albums[h.ref] = ids[i]))
  repo.applyAlbumDetail(
    albums['chrono-trigger-osv'],
    detail(
      hits[0],
      [
        { title: 'Peaceful Days', ms: 172_000 },
        { title: 'Battle with Magus', ms: 172_000 },
        { title: 'Corridors of Time', ms: 228_000 },
        { title: 'Boss Battle 1', ms: 140_000, disc: 2 }
      ],
      { composers: ['Yasunori Mitsuda', 'Nobuo Uematsu'], altTitles: ['クロノ・トリガー オリジナル・サウンド・ヴァージョン'], titleOriginal: 'クロノ・トリガー オリジナル・サウンド・ヴァージョン' }
    )
  )
  repo.applyAlbumDetail(
    albums['ff6-osv'],
    detail(hits[5], [
      { title: 'Opening Theme', ms: 200_000 },
      { title: 'The Decisive Battle', ms: 300_000 },
      { title: 'Dancing Mad', ms: 1_060_000 }
    ], { composers: ['Nobuo Uematsu'] })
  )
  repo.applyAlbumDetail(albums['hollow-knight-ost'], detail(hits[7], [{ title: 'Dirtmouth', ms: 140_000 }, { title: 'Hornet', ms: 180_000 }], { composers: ['Christopher Larkin'], formats: ['mp3'] }))
  return { albums }
}
