// Orchestrates the optional profile integrations:
//   Steam / PSN — read achievement + trophy unlock timestamps for games the
//     user ALREADY has in their library, and backfill the dates that are
//     missing: the earliest unlock becomes date_started, the latest becomes
//     date_completed.
//   IGDB — backfill hltb_hours for games that don't have one.
//
// Nothing here ever creates or deletes a game, and nothing overwrites a value
// the user already has. It only fills in blanks.

const { getDb } = require('./db');
const { getSettings } = require('./settings');
const { normalizeName, similarityScore } = require('./metacritic');
const steam = require('./steam');
const psn = require('./psn');
const igdb = require('./igdb');

const DELAY_MS = 250;

// A platform title is only allowed to write dates onto a library game on a
// high-confidence name match. The scorer's exact-name and
// ignore-the-spacing tiers land at 100/95; fuzzier matches below that are
// rejected, because a wrong match here silently writes wrong dates onto a
// game rather than just showing a wrong cover.
const MIN_MATCH_SCORE = 90;

// Progress is tracked per user, not globally: two accounts syncing at once
// mustn't block each other, and lastError can contain a game name — which
// would leak one user's library into another's status response.
const states = new Map();

function stateFor(userId) {
  if (!states.has(userId)) {
    states.set(userId, {
      running: false,
      provider: null,
      processed: 0,
      total: 0,
      updated: 0,
      skipped: 0,
      lastError: null,
      finishedAt: null,
    });
  }
  return states.get(userId);
}

function getStatus(userId) {
  return { ...stateFor(userId) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toDate = (ms) => new Date(ms).toISOString().slice(0, 10);

function buildTitleIndex(titles) {
  return titles.map((t) => ({ ...t, key: normalizeName(t.name) }));
}

function findMatch(gameName, titleIndex) {
  const key = normalizeName(gameName);
  let best = null;
  for (const t of titleIndex) {
    // Cheap exact hit first, then fall back to the scorer.
    const score = t.key === key ? 100 : similarityScore(gameName, t.name);
    if (!best || score > best.score) best = { title: t, score };
  }
  return best && best.score >= MIN_MATCH_SCORE ? best.title : null;
}

// Applies the unlock timestamps to one library row. Returns true if anything
// actually changed.
function applyDates(db, game, unlockTimes) {
  if (unlockTimes.length === 0) return false;

  const earliest = toDate(Math.min(...unlockTimes));
  const latest = toDate(Math.max(...unlockTimes));

  const sets = [];
  const params = [];

  // Completion date: only for games marked completed that don't have one.
  // A live_service / in_progress game has no completion date by definition,
  // so it's left alone.
  let newCompleted = game.date_completed;
  if (game.status === 'completed' && !game.date_completed) {
    newCompleted = latest;
    sets.push('date_completed = ?', 'year = ?');
    params.push(latest, Number(latest.slice(0, 4)));
  }

  // Start date: the earliest unlock, for any status, when it's missing — but
  // never let it land after the completion date (that would be nonsense, and
  // the manual-edit form would reject the same combination).
  if (!game.date_started && (!newCompleted || earliest <= newCompleted)) {
    sets.push('date_started = ?');
    params.push(earliest);
  }

  if (sets.length === 0) return false;

  params.push(game.id);
  db.prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return true;
}

// Library rows that still have something for us to fill in.
function getGamesNeedingDates(db, userId) {
  return db.prepare(`
    SELECT id, name, status, date_started, date_completed
    FROM games
    WHERE user_id = ?
      AND (date_started IS NULL OR (status = 'completed' AND date_completed IS NULL))
  `).all(userId);
}

function beginRun(state, provider, total) {
  state.running = true;
  state.provider = provider;
  state.processed = 0;
  state.total = total;
  state.updated = 0;
  state.skipped = 0;
  state.lastError = null;
  state.finishedAt = null;
}

function endRun(state, err) {
  if (err) state.lastError = err.message;
  state.running = false;
  state.finishedAt = new Date().toISOString();
}

// --- Steam -----------------------------------------------------------------

async function runSteamSync(userId) {
  const state = stateFor(userId);
  if (state.running) return getStatus(userId);

  const settings = getSettings(userId);
  if (!settings.steam_api_key || !settings.steam_id) {
    throw new Error('Set your Steam API key and Steam ID on the profile page first.');
  }

  beginRun(state, 'steam', 0);

  (async () => {
    const db = getDb();
    try {
      const steamId = await steam.resolveSteamId(settings.steam_api_key, settings.steam_id);
      const owned = await steam.getOwnedGames(settings.steam_api_key, steamId);
      const index = buildTitleIndex(owned);

      const games = getGamesNeedingDates(db, userId);
      state.total = games.length;

      for (const game of games) {
        try {
          const match = findMatch(game.name, index);
          if (!match) {
            state.skipped++;
          } else {
            const achievements = await steam.getUnlockedAchievements(settings.steam_api_key, steamId, match.appid);
            const times = achievements.map((a) => a.unlockedAt);
            if (applyDates(db, game, times)) state.updated++;
            else state.skipped++;
            await sleep(DELAY_MS);
          }
        } catch (err) {
          state.lastError = `${game.name}: ${err.message}`;
        }
        state.processed++;
      }
      endRun(state, null);
    } catch (err) {
      endRun(state, err);
    } finally {
      db.close();
    }
  })();

  return getStatus(userId);
}

// --- PSN -------------------------------------------------------------------

async function runPsnSync(userId) {
  const state = stateFor(userId);
  if (state.running) return getStatus(userId);

  const settings = getSettings(userId);
  if (!settings.psn_npsso) {
    throw new Error('Set your PSN NPSSO token on the profile page first.');
  }

  beginRun(state, 'psn', 0);

  (async () => {
    const db = getDb();
    try {
      const auth = await psn.authenticate(settings.psn_npsso);
      const titles = await psn.getTrophyTitles(auth);
      const index = buildTitleIndex(titles);

      const games = getGamesNeedingDates(db, userId);
      state.total = games.length;

      for (const game of games) {
        try {
          const match = findMatch(game.name, index);
          if (!match) {
            state.skipped++;
          } else {
            const trophies = await psn.getEarnedTrophies(auth, match);
            const times = trophies.map((t) => t.unlockedAt);
            if (applyDates(db, game, times)) state.updated++;
            else state.skipped++;
            await sleep(DELAY_MS);
          }
        } catch (err) {
          state.lastError = `${game.name}: ${err.message}`;
        }
        state.processed++;
      }
      endRun(state, null);
    } catch (err) {
      endRun(state, err);
    } finally {
      db.close();
    }
  })();

  return getStatus(userId);
}

// --- IGDB (completion times) ----------------------------------------------

async function runIgdbSync(userId) {
  const state = stateFor(userId);
  if (state.running) return getStatus(userId);

  const settings = getSettings(userId);
  if (!settings.igdb_client_id || !settings.igdb_client_secret) {
    throw new Error('Set your IGDB (Twitch) Client ID and Secret on the profile page first.');
  }

  beginRun(state, 'igdb', 0);

  (async () => {
    const db = getDb();
    try {
      const token = await igdb.getAccessToken(settings.igdb_client_id, settings.igdb_client_secret);

      const games = db.prepare(
        'SELECT id, name FROM games WHERE user_id = ? AND hltb_hours IS NULL'
      ).all(userId);
      state.total = games.length;

      const update = db.prepare('UPDATE games SET hltb_hours = ? WHERE id = ?');

      for (const game of games) {
        try {
          const hours = await igdb.getTimeToBeatHours(settings.igdb_client_id, token, game.name);
          if (hours != null) {
            update.run(hours, game.id);
            state.updated++;
          } else {
            state.skipped++;
          }
          await sleep(DELAY_MS);
        } catch (err) {
          state.lastError = `${game.name}: ${err.message}`;
        }
        state.processed++;
      }
      endRun(state, null);
    } catch (err) {
      endRun(state, err);
    } finally {
      db.close();
    }
  })();

  return getStatus(userId);
}

// --- Discover: games on the platform that are NOT in the library yet -------
//
// The user's library is a hand-curated list, so a platform account almost
// always contains many titles that aren't in it. Discover returns exactly
// those — every platform title that doesn't match an existing library game —
// so the user can pick which ones to add. It never adds anything on its own.

function libraryIndex(db, userId) {
  const rows = db.prepare('SELECT name FROM games WHERE user_id = ?').all(userId);
  return buildTitleIndex(rows);
}

async function discoverGames(userId, provider) {
  const settings = getSettings(userId);
  let titles;

  if (provider === 'steam') {
    if (!settings.steam_api_key || !settings.steam_id) {
      throw new Error('Set your Steam API key and Steam ID on the profile page first.');
    }
    const steamId = await steam.resolveSteamId(settings.steam_api_key, settings.steam_id);
    const owned = await steam.getOwnedGames(settings.steam_api_key, steamId);
    titles = owned.map((g) => ({
      provider: 'steam',
      ref: String(g.appid),
      name: g.name,
      detail: g.playtimeMinutes ? `${Math.round(g.playtimeMinutes / 60)}h played` : null,
      sortKey: g.playtimeMinutes || 0,
    }));
  } else if (provider === 'psn') {
    if (!settings.psn_npsso) {
      throw new Error('Set your PSN NPSSO token on the profile page first.');
    }
    const auth = await psn.authenticate(settings.psn_npsso);
    const trophyTitles = await psn.getTrophyTitles(auth);
    titles = trophyTitles.map((t) => ({
      provider: 'psn',
      ref: t.id,
      serviceName: t.serviceName,
      name: t.name,
      detail: t.progress != null ? `${t.progress}% trophies` : null,
      sortKey: t.progress || 0,
    }));
  } else {
    throw new Error('Discovery is only available for Steam and PSN.');
  }

  const db = getDb();
  let index;
  try {
    index = libraryIndex(db, userId);
  } finally {
    db.close();
  }

  // A platform title is a candidate only if nothing in the library matches it.
  const candidates = titles
    .filter((t) => t.name && !findMatch(t.name, index))
    .sort((a, b) => b.sortKey - a.sortKey || a.name.localeCompare(b.name));

  return candidates;
}

// --- Import: add the games the user explicitly picked --------------------
//
// Runs in the background and reuses the same per-user progress/banner as sync.
// Each picked game is inserted as in_progress with its earliest unlock as the
// start date (the "earliest achievement is an indicator" rule) — we never
// guess a completion, so the user marks those done themselves afterward.

async function fetchUnlockTimes(provider, ctx, item) {
  if (provider === 'steam') {
    const achievements = await steam.getUnlockedAchievements(ctx.apiKey, ctx.steamId, item.ref);
    return achievements.map((a) => a.unlockedAt);
  }
  const trophies = await psn.getEarnedTrophies(ctx.auth, { id: item.ref, serviceName: item.serviceName });
  return trophies.map((t) => t.unlockedAt);
}

function runImport(provider) {
  return async function (userId, items) {
    const state = stateFor(userId);
    if (state.running) return getStatus(userId);
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('No games were selected to add.');
    }

    const settings = getSettings(userId);
    const ctx = {};
    // Authenticate up front so a bad credential fails before we claim to start.
    if (provider === 'steam') {
      if (!settings.steam_api_key || !settings.steam_id) {
        throw new Error('Set your Steam API key and Steam ID on the profile page first.');
      }
      ctx.apiKey = settings.steam_api_key;
      ctx.steamId = await steam.resolveSteamId(settings.steam_api_key, settings.steam_id);
    } else {
      if (!settings.psn_npsso) {
        throw new Error('Set your PSN NPSSO token on the profile page first.');
      }
      ctx.auth = await psn.authenticate(settings.psn_npsso);
    }

    beginRun(state, `${provider}-import`, items.length);

    (async () => {
      const db = getDb();
      try {
        const index = libraryIndex(db, userId);
        const insert = db.prepare(
          'INSERT INTO games (user_id, name, status, date_started, date_completed, year, hltb_hours) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );

        for (const item of items) {
          try {
            // Guard against a game that got added (or picked twice) in the meantime.
            if (!item.name || findMatch(item.name, index)) {
              state.skipped++;
            } else {
              let dateStarted = null;
              try {
                const times = await fetchUnlockTimes(provider, ctx, item);
                if (times.length) dateStarted = toDate(Math.min(...times));
              } catch {
                // No achievement data is fine — still add the game, just undated.
              }
              insert.run(userId, item.name, 'in_progress', dateStarted, null, null, null);
              index.push({ name: item.name, key: normalizeName(item.name) });
              state.updated++;
              await sleep(DELAY_MS);
            }
          } catch (err) {
            state.lastError = `${item.name}: ${err.message}`;
          }
          state.processed++;
        }
        endRun(state, null);
      } catch (err) {
        endRun(state, err);
      } finally {
        db.close();
      }
    })();

    return getStatus(userId);
  };
}

const runSteamImport = runImport('steam');
const runPsnImport = runImport('psn');

module.exports = {
  runSteamSync, runPsnSync, runIgdbSync, getStatus, findMatch, applyDates, buildTitleIndex,
  discoverGames, runSteamImport, runPsnImport,
};
