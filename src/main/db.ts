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

/**
 * Close the main connection at quit (last thing): the last connection to close checkpoints the WAL
 * and removes it, so the next start opens a clean file instead of replaying a large log.
 */
export function closeDb(): void {
  if (!db) return
  try {
    db.close()
  } catch (e) {
    console.error('[db] close failed:', e)
  }
  db = null
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('DB not opened')
  return db
}

/**
 * Run `fn` inside a write transaction (node:sqlite has no helper). Not re-entrant. IMMEDIATE: the
 * catalog worker writes the same file on its own connection, and a deferred transaction that read
 * first fails with SQLITE_BUSY (no busy wait) if the worker committed in between.
 */
export function tx<T>(d: DatabaseSync, fn: () => T): T {
  d.exec('BEGIN IMMEDIATE')
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
