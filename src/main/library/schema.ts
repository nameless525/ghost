// Tables owned by the library/services workstream. Idempotent DDL, applied at startup.
import { ensureSchema, type DB } from '../db'

export const LIBRARY_DDL = `
CREATE TABLE IF NOT EXISTS likes (
  track_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS likes_at ON likes(at DESC);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL,
  played_at INTEGER NOT NULL,
  ms_played INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS history_played_at ON history(played_at DESC);
CREATE INDEX IF NOT EXISTS history_track ON history(track_id);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'manual',
  query TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_items (
  uid TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS playlist_items_order ON playlist_items(playlist_id, position);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL,
  path TEXT,
  format TEXT,
  status TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER,
  error TEXT,
  title TEXT NOT NULL DEFAULT '',
  game_name TEXT,
  album_title TEXT NOT NULL DEFAULT '',
  cover TEXT,
  batch TEXT,
  cleared INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS downloads_track ON downloads(track_id);
CREATE INDEX IF NOT EXISTS downloads_status ON downloads(status);
`

export function ensureLibrarySchema(db: DB): void {
  ensureSchema(db, LIBRARY_DDL)
}
