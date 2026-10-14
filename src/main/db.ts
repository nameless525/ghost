// One SQLite database for the whole app (node:sqlite, built into Electron's Node).
// Each module owns its own tables and creates them with `ensureSchema` (idempotent DDL).
import { DatabaseSync } from 'node:sqlite'

export type DB = DatabaseSync

let db: DatabaseSync | null = null

export function openDb(file: string): DatabaseSync {
  if (db) return db
  db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY;')
  return db
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('DB not opened')
  return db
}

/** Run `fn` inside a transaction (node:sqlite has no helper). Not re-entrant. */
export function tx<T>(d: DatabaseSync, fn: () => T): T {
  d.exec('BEGIN')
  try {
    const out = fn()
    d.exec('COMMIT')
    return out
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
}

export function ensureSchema(d: DatabaseSync, ddl: string): void {
  d.exec(ddl)
}
