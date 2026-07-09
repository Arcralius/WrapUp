// Background job that fills in metacritic_cache for any game name that
// hasn't been looked up yet. Runs sequentially with a delay between
// requests — this hits an external site on someone else's server, so it
// stays polite (one request at a time, a pause between each) rather than
// firing hundreds of requests at once.

const { getDb } = require('./db');
const { searchGame, normalizeName } = require('./metacritic');

const DELAY_MS = 400;

const state = {
  running: false,
  processed: 0,
  total: 0,
  lastError: null,
};

function getStatus() {
  return { ...state };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runEnrichment() {
  if (state.running) return state;

  const db = getDb();
  const names = db.prepare('SELECT DISTINCT name FROM games').all().map((r) => r.name);
  const cached = new Set(db.prepare('SELECT name_key FROM metacritic_cache').all().map((r) => r.name_key));
  db.close();

  const pending = names.filter((name) => !cached.has(normalizeName(name)));
  if (pending.length === 0) return state;

  state.running = true;
  state.processed = 0;
  state.total = pending.length;
  state.lastError = null;

  (async () => {
    const workerDb = getDb();
    const insert = workerDb.prepare(`
      INSERT OR REPLACE INTO metacritic_cache
        (name_key, original_name, status, matched_title, metacritic_url, cover_url, match_score, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const name of pending) {
      try {
        const result = await searchGame(name);
        insert.run(
          normalizeName(name),
          name,
          result.status,
          result.matchedTitle || null,
          result.metacriticUrl || null,
          result.coverUrl || null,
          result.matchScore || null,
          new Date().toISOString()
        );
      } catch (err) {
        state.lastError = `${name}: ${err.message}`;
      }
      state.processed++;
      await sleep(DELAY_MS);
    }

    workerDb.close();
    state.running = false;
  })();

  return state;
}

module.exports = { runEnrichment, getStatus };
