const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '..', 'db', 'games.db');

const GAMES_TABLE_SQL = `
  CREATE TABLE games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('completed', 'live_service', 'in_progress')),
    date_started TEXT,
    date_completed TEXT,
    year INTEGER,
    hltb_hours REAL
  )
`;

// year IS NULL means "whole library". No column-level UNIQUE on user_id
// here — a user can hold one link per scope (one whole-library link, plus
// one per individual year), enforced by the expression index below instead.
const SHARE_TOKENS_TABLE_SQL = `
  CREATE TABLE share_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    year INTEGER,
    created_at TEXT NOT NULL
  )
`;

// Rebuilds the games table in place if it predates the `date_started` /
// `in_progress` columns — SQLite can't ALTER a CHECK constraint, so this is
// the standard rename-copy-drop pattern, done inside a transaction so a
// crash mid-migration can't leave data half-moved.
function migrateGamesTable(db) {
  const columns = db.prepare("PRAGMA table_info(games)").all();
  if (columns.length === 0) return; // fresh DB — the CREATE TABLE below handles it
  const hasDateStarted = columns.some((c) => c.name === 'date_started');
  if (hasDateStarted) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE games RENAME TO games_old');
    db.exec(GAMES_TABLE_SQL);
    db.exec(`
      INSERT INTO games (id, user_id, name, status, date_completed, year, hltb_hours)
      SELECT id, user_id, name, status, date_completed, year, hltb_hours FROM games_old
    `);
    db.exec('DROP TABLE games_old');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Same rename-copy-drop pattern as migrateGamesTable: the original
// share_tokens had a column-level UNIQUE(user_id), capping each user at one
// link total. Rebuilding drops that in favor of the (user_id, year)
// expression-unique index created below, which allows one link per scope.
function migrateShareTokensTable(db) {
  const columns = db.prepare("PRAGMA table_info(share_tokens)").all();
  if (columns.length === 0) return; // fresh DB — the CREATE TABLE below handles it
  const hasYear = columns.some((c) => c.name === 'year');
  if (hasYear) return;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE share_tokens RENAME TO share_tokens_old');
    db.exec(SHARE_TOKENS_TABLE_SQL);
    db.exec(`
      INSERT INTO share_tokens (token, user_id, created_at)
      SELECT token, user_id, created_at FROM share_tokens_old
    `);
    db.exec('DROP TABLE share_tokens_old');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Opaque, server-generated session tokens (never derived from user input),
    -- checked against this table on every request — not stateless JWTs — so a
    -- session can be revoked (logout) immediately rather than just expiring.
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);

  migrateShareTokensTable(db);

  db.exec(`
    -- One link per user per scope (whole library, or a single year). The
    -- token is the only credential — whoever holds it can read that scope at
    -- /api/shared/:token/*, a completely separate, read-only route tree from
    -- the authenticated /api/games/* routes (no write endpoint ever accepts
    -- a share token, only a session cookie).
    ${SHARE_TOKENS_TABLE_SQL.replace('CREATE TABLE share_tokens', 'CREATE TABLE IF NOT EXISTS share_tokens')}
    ;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_share_user_scope ON share_tokens(user_id, COALESCE(year, -1));
  `);

  migrateGamesTable(db);

  db.exec(`
    -- Every row is owned by exactly one user; every query in server.js filters
    -- on user_id so one account can never see another's list. status is
    -- 'completed' (has date_completed), 'in_progress' (has date_started, no
    -- end yet), or 'live_service' (neither, can't be "finished").
    ${GAMES_TABLE_SQL.replace('CREATE TABLE games', 'CREATE TABLE IF NOT EXISTS games')}
    ;
    CREATE INDEX IF NOT EXISTS idx_games_user ON games(user_id);
    CREATE INDEX IF NOT EXISTS idx_games_user_year ON games(user_id, year);
    CREATE INDEX IF NOT EXISTS idx_games_user_status ON games(user_id, status);

    -- Keyed by normalized game name (not games.id, and shared across all
    -- users deliberately — a Metacritic lookup for "Hades" is the same
    -- regardless of who has it on their list, so nothing user-specific here).
    CREATE TABLE IF NOT EXISTS metacritic_cache (
      name_key TEXT PRIMARY KEY,
      original_name TEXT,
      status TEXT NOT NULL CHECK(status IN ('found', 'not_found')),
      matched_title TEXT,
      metacritic_url TEXT,
      cover_url TEXT,
      match_score INTEGER,
      checked_at TEXT NOT NULL
    );
  `);
  return db;
}

function replaceAllGames(db, userId, games) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM games WHERE user_id = ?').run(userId);
    const insert = db.prepare(`
      INSERT INTO games (user_id, name, status, date_started, date_completed, year, hltb_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const g of games) {
      insert.run(userId, g.name, g.status, g.dateStarted || null, g.dateCompleted, g.year, g.hltbHours);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { getDb, replaceAllGames, DB_PATH };
