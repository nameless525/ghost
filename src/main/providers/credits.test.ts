import { describe, expect, it } from 'vitest'
import { cleanCredits } from './credits'

describe('cleanCredits', () => {
  it('drops headings and other roles, keeps composers', () => {
    expect(cleanCredits(['Arranged by', 'Arranged :'])).toEqual([])
    expect(cleanCredits(['Yasunori Mitsuda', 'Arranged by Tomohiko Kira', 'Sachiko Miyano', 'arranged by H.T', 'Lyrics: Someone'])).toEqual(['Yasunori Mitsuda', 'Sachiko Miyano'])
  })

  it('trims composer prefixes, colons and duplicates', () => {
    expect(cleanCredits(['Composed by: Nobuo Uematsu', 'Music: Koji Kondo', 'nobuo uematsu', 'Yoko Shimomura :'])).toEqual(['Nobuo Uematsu', 'Koji Kondo', 'Yoko Shimomura'])
  })

  it('keeps names that merely start like a role word', () => {
    expect(cleanCredits(['Mixmaster Mike', 'Producers Guild Orchestra'])).toEqual(['Mixmaster Mike', 'Producers Guild Orchestra'])
    expect(cleanCredits(['Hiroki Kikuta', '作曲：植松伸夫'])).toEqual(['Hiroki Kikuta', '作曲：植松伸夫'])
  })
})

describe('stored credits', () => {
  it('are cleaned once in the catalog (albums, their composer index and tracks)', async () => {
    const { CatalogRepo } = await import('../catalog/repo')
    const { hit, memoryDb } = await import('../catalog/testing')
    const db = memoryDb()
    const repo = new CatalogRepo(db)
    const [id] = repo.upsertHits([hit('arc-rise', 'Arc Rise Fantasia Original Soundtrack', 'ost', 2009, [])], { initial: true })
    db.prepare(`UPDATE albums SET composers = ? WHERE id = ?`).run(JSON.stringify(['Arranged by', 'Arranged :', 'Yasunori Mitsuda']), id)
    db.prepare(`INSERT INTO album_composers(album_id, name_fold, name) VALUES (?, 'arranged by', 'Arranged by')`).run(id)
    expect(repo.cleanStoredCredits()).toBe(1)
    const row = db.prepare(`SELECT composers FROM albums WHERE id = ?`).get(id) as { composers: string }
    expect(JSON.parse(row.composers)).toEqual(['Yasunori Mitsuda'])
    const names = (db.prepare(`SELECT name FROM album_composers WHERE album_id = ?`).all(id) as { name: string }[]).map((r) => r.name)
    expect(names).toEqual(['Yasunori Mitsuda'])
    // Once only.
    db.prepare(`UPDATE albums SET composers = ? WHERE id = ?`).run(JSON.stringify(['Arranged by']), id)
    expect(repo.cleanStoredCredits()).toBe(0)
  })
})
