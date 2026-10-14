// Catalog tables (DESIGN §6.5). Owned by the catalog workstream; created idempotently at startup.
//
// IDs are INTEGER rowids exposed to the rest of the app as decimal strings ("123"). Rows in
// albums/tracks are never deleted (only flagged), so ids other modules store (likes, playlists,
// downloads) stay valid across re-crawls. Games are derived and may be re-clustered.
//
// Sort columns (sort_*) are denormalised NOT NULL values so every browse ordering is an index walk.

import type { DB } from '../db'

export const CATALOG_SCHEMA_VERSION = 1

/** Sentinels used by sort columns for unknown values (sort last in ascending order). */
export const UNKNOWN_YEAR = 9999
export const UNKNOWN_LEN = 1e15
export const UNKNOWN_INTENSITY = 1000

export const CATALOG_DDL = `
CREATE TABLE IF NOT EXISTS catalog_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS games (
  id              INTEGER PRIMARY KEY,
  norm_key        TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  sort_name       TEXT NOT NULL,
  alt_names       TEXT NOT NULL DEFAULT '[]',
  year            INTEGER,
  sort_year       INTEGER NOT NULL DEFAULT ${UNKNOWN_YEAR},
  platforms       TEXT NOT NULL DEFAULT '[]',
  franchise       TEXT,
  franchise_guess TEXT,
  cover           TEXT,
  hero            TEXT,
  logo            TEXT,
  accent          TEXT,
  igdb_id         INTEGER,
  igdb_json       TEXT,
  igdb_checked_at INTEGER,
  sgdb_id         INTEGER,
  sgdb_json       TEXT,
  sgdb_checked_at INTEGER,
  album_count     INTEGER NOT NULL DEFAULT 0,
  has_primary     INTEGER NOT NULL DEFAULT 0,
  added_at        INTEGER NOT NULL DEFAULT 0,
  total_ms        INTEGER,
  sort_len        INTEGER NOT NULL DEFAULT ${UNKNOWN_LEN},
  intensity       REAL,
  sort_intensity  REAL NOT NULL DEFAULT ${UNKNOWN_INTENSITY},
  rnd             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS games_sort_name ON games(sort_name);
CREATE INDEX IF NOT EXISTS games_sort_year ON games(sort_year, sort_name);
CREATE INDEX IF NOT EXISTS games_added ON games(added_at DESC, sort_name);
CREATE INDEX IF NOT EXISTS games_sort_len ON games(sort_len, sort_name);
CREATE INDEX IF NOT EXISTS games_sort_intensity ON games(sort_intensity, sort_name);
CREATE INDEX IF NOT EXISTS games_rnd ON games(rnd);
CREATE INDEX IF NOT EXISTS games_cover ON games(cover);
CREATE INDEX IF NOT EXISTS games_franchise ON games(franchise);
CREATE INDEX IF NOT EXISTS games_igdb_todo ON games(igdb_checked_at, album_count DESC);

CREATE TABLE IF NOT EXISTS albums (
  id             INTEGER PRIMARY KEY,
  provider       TEXT NOT NULL,
  provider_ref   TEXT NOT NULL,
  game_id        INTEGER,
  title          TEXT NOT NULL,
  title_from_ref INTEGER NOT NULL DEFAULT 0,
  sort_title     TEXT NOT NULL,
  title_original TEXT,
  alt_titles     TEXT NOT NULL DEFAULT '[]',
  kind           TEXT NOT NULL DEFAULT 'ost',
  kind_rank      INTEGER NOT NULL DEFAULT 0,
  type_label     TEXT,
  year           INTEGER,
  sort_year      INTEGER NOT NULL DEFAULT ${UNKNOWN_YEAR},
  platforms      TEXT NOT NULL DEFAULT '[]',
  catalog_no     TEXT,
  developers     TEXT NOT NULL DEFAULT '[]',
  publishers     TEXT NOT NULL DEFAULT '[]',
  composers      TEXT NOT NULL DEFAULT '[]',
  cover          TEXT,
  thumb          TEXT,
  images         TEXT NOT NULL DEFAULT '[]',
  formats        TEXT NOT NULL DEFAULT '[]',
  sizes          TEXT NOT NULL DEFAULT '{}',
  track_count    INTEGER,
  total_ms       INTEGER,
  sort_len       INTEGER NOT NULL DEFAULT ${UNKNOWN_LEN},
  intensity      REAL,
  sort_intensity REAL NOT NULL DEFAULT ${UNKNOWN_INTENSITY},
  description    TEXT,
  ext_id         TEXT,
  added_at       INTEGER,
  sort_added     INTEGER NOT NULL DEFAULT 0,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  detail_at      INTEGER,
  detail_error   TEXT,
  art_checked_at INTEGER,
  gone           INTEGER NOT NULL DEFAULT 0,
  rnd            INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider, provider_ref)
);
CREATE INDEX IF NOT EXISTS albums_game ON albums(game_id, kind_rank, sort_year);
CREATE INDEX IF NOT EXISTS albums_sort_title ON albums(sort_title);
CREATE INDEX IF NOT EXISTS albums_sort_year ON albums(sort_year, sort_title);
CREATE INDEX IF NOT EXISTS albums_added ON albums(sort_added DESC, sort_title);
CREATE INDEX IF NOT EXISTS albums_sort_len ON albums(sort_len, sort_title);
CREATE INDEX IF NOT EXISTS albums_sort_intensity ON albums(sort_intensity, sort_title);
CREATE INDEX IF NOT EXISTS albums_rnd ON albums(rnd);
CREATE INDEX IF NOT EXISTS albums_kind ON albums(kind);
CREATE INDEX IF NOT EXISTS albums_year ON albums(year);

CREATE TABLE IF NOT EXISTS album_platforms (
  album_id  INTEGER NOT NULL,
  slug      TEXT NOT NULL,
  name      TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  PRIMARY KEY (album_id, slug)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS album_platforms_slug ON album_platforms(slug, album_id);
CREATE INDEX IF NOT EXISTS album_platforms_name ON album_platforms(name_fold, album_id);

CREATE TABLE IF NOT EXISTS album_composers (
  album_id  INTEGER NOT NULL,
  name_fold TEXT NOT NULL,
  name      TEXT NOT NULL,
  PRIMARY KEY (album_id, name_fold)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS album_composers_name ON album_composers(name_fold, album_id);

CREATE TABLE IF NOT EXISTS tracks (
  id             INTEGER PRIMARY KEY,
  album_id       INTEGER NOT NULL,
  disc           INTEGER NOT NULL DEFAULT 1,
  number         INTEGER NOT NULL,
  position       INTEGER NOT NULL,
  title          TEXT NOT NULL,
  title_original TEXT,
  duration_ms    INTEGER,
  composers      TEXT NOT NULL DEFAULT '[]',
  locator        TEXT NOT NULL,
  files          TEXT NOT NULL DEFAULT '[]',
  removed        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(album_id, locator)
);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_id, removed, position);
CREATE INDEX IF NOT EXISTS tracks_duration ON tracks(duration_ms);

CREATE TABLE IF NOT EXISTS sources (
  id             INTEGER PRIMARY KEY,
  track_id       INTEGER NOT NULL,
  provider       TEXT NOT NULL,
  locator        TEXT NOT NULL,
  cache_key      TEXT NOT NULL,
  url            TEXT,
  path           TEXT,
  headers        TEXT,
  format         TEXT NOT NULL,
  bitrate        INTEGER,
  lossless       INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  size_bytes     INTEGER,
  confidence     REAL NOT NULL DEFAULT 1,
  verified_at    INTEGER NOT NULL,
  expires_at     INTEGER,
  failures       INTEGER NOT NULL DEFAULT 0,
  last_failed_at INTEGER,
  last_error     TEXT,
  needs_refresh  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(track_id, cache_key)
);
CREATE INDEX IF NOT EXISTS sources_track ON sources(track_id, provider);

CREATE TABLE IF NOT EXISTS analysis (
  track_id       INTEGER PRIMARY KEY,
  cache_key      TEXT,
  lufs           REAL,
  lra            REAL,
  true_peak      REAL,
  bpm            REAL,
  bpm_confidence REAL,
  intensity      REAL,
  duration_ms    INTEGER,
  beats          BLOB,
  downbeats      BLOB,
  kiai           BLOB,
  energy         BLOB,
  analyzed_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS analysis_bpm ON analysis(bpm);
CREATE INDEX IF NOT EXISTS analysis_intensity ON analysis(intensity);

CREATE VIRTUAL TABLE IF NOT EXISTS album_fts USING fts5(
  game, album, tracks, composers, franchise, platforms,
  tokenize = "trigram remove_diacritics 1"
);
CREATE VIRTUAL TABLE IF NOT EXISTS track_fts USING fts5(
  title, album, game, composers,
  tokenize = "trigram remove_diacritics 1"
);

CREATE TABLE IF NOT EXISTS crawl_jobs (
  id          INTEGER PRIMARY KEY,
  provider    TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,
  initial     INTEGER NOT NULL DEFAULT 0,
  message     TEXT
);
CREATE TABLE IF NOT EXISTS crawl_pages (
  job_id      INTEGER NOT NULL,
  section     TEXT NOT NULL,
  page        INTEGER NOT NULL,
  total_pages INTEGER,
  items       INTEGER,
  fetched_at  INTEGER,
  error       TEXT,
  PRIMARY KEY (job_id, section, page)
);
`

/** Columns added after a table first shipped: [table, column, definition]. */
const ADDED_COLUMNS: [string, string, string][] = [['sources', 'needs_refresh', 'INTEGER NOT NULL DEFAULT 0']]

export function ensureCatalogSchema(db: DB): void {
  db.exec(CATALOG_DDL)
  for (const [table, col, def] of ADDED_COLUMNS) {
    const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
  }
  db.prepare(`INSERT INTO catalog_meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(CATALOG_SCHEMA_VERSION))
}
