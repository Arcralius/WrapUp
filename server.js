const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { getDb } = require('./lib/db');
const { importFromMarkdown } = require('./scripts/import');
const { getCurrentSource } = require('./lib/source');
const { normalizeName, parseMetacriticGameUrl, fetchGameByUrl } = require('./lib/metacritic');
const { runEnrichment, getStatus: getEnrichmentStatus } = require('./lib/enrichment');
const { requireAuth } = require('./lib/auth');
const { listShares, getOrCreateShare, regenerateShare, disableShare, resolveToken } = require('./lib/share');
const authRouter = require('./routes/auth');
const uploadRouter = require('./routes/upload');

const app = express();
const PORT = process.env.PORT || 3000;

// Only trust X-Forwarded-* headers when explicitly told to (e.g. running
// behind your own nginx/Traefik/cloud load balancer) — trusting them by
// default would let anyone spoof their client IP via that header, which
// matters here since rate limiting keys on req.ip.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY);
}

app.use(helmet({
  // HSTS assumes every visitor already reached you over HTTPS; this app is
  // just as often self-hosted plain-HTTP on a LAN or behind a reverse proxy
  // that already sets its own HSTS. Sending it unconditionally here could
  // get a non-HTTPS deployment's users' browsers to "remember" HTTPS-only
  // for a host that doesn't have it — leave that decision to the proxy.
  hsts: false,
  contentSecurityPolicy: {
    // useDefaults: false so ONLY the directives listed below apply — helmet's
    // built-in defaults otherwise merge in `upgrade-insecure-requests`, which
    // makes browsers rewrite every http:// subresource fetch (style.css,
    // app.js, ...) to https:// before requesting it. Harmless on a real HTTPS
    // deployment, but this app is just as often self-hosted plain-HTTP on a
    // LAN, where that rewritten request has nothing listening on 443 and
    // silently fails — which broke every page: CSS and JS both refused to
    // load, leaving raw unstyled HTML with none of the display:none rules
    // (modals, banners) applied.
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // No inline <script> anywhere in this app, so script-src stays strict.
      scriptSrc: ["'self'"],
      // A handful of inline style="" attributes exist; covers/art are
      // hotlinked from Metacritic's CDN.
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://www.metacritic.com'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));

// A generous ceiling on the whole API as a DoS backstop, plus a much
// tighter one on signup/login specifically — those are the endpoints an
// attacker actually benefits from hammering (account enumeration, credential
// stuffing, or just burning CPU on scrypt hashing).
//
// validate.xForwardedForHeader is off deliberately: by default
// express-rate-limit *throws* (crashing every request, not just logging a
// warning) the moment it sees an X-Forwarded-For header while `trust proxy`
// is unset — which is exactly what almost every hosting platform's edge
// proxy sends. Without TRUST_PROXY configured, rate limiting falls back to
// keying on the raw socket address (accurate when directly exposed, merged
// across clients behind an unconfigured proxy) — degraded, not down.
const rateLimitValidation = { xForwardedForHeader: false };

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  validate: rateLimitValidation,
}));
app.use(
  ['/api/auth/signup', '/api/auth/login'],
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    validate: rateLimitValidation,
    message: { ok: false, error: 'Too many attempts. Try again later.' },
  })
);

app.use(express.json());
app.use(cookieParser());

app.use(authRouter);
app.use(express.static(path.join(__dirname, 'public')));
app.use(uploadRouter);

function attachMetacritic(rows) {
  const db = getDb();
  const cacheRows = db.prepare('SELECT * FROM metacritic_cache').all();
  db.close();
  const cacheMap = new Map(cacheRows.map((r) => [r.name_key, r]));

  return rows.map((g) => {
    const cached = cacheMap.get(normalizeName(g.name));
    return {
      ...g,
      metacritic_url: cached?.metacritic_url || null,
      cover_url: cached?.cover_url || null,
      metacritic_status: cached?.status || 'pending',
    };
  });
}

app.get('/api/source', requireAuth, (req, res) => {
  const { meta } = getCurrentSource(req.user.id);
  if (!meta) {
    return res.json({ kind: 'none', displayName: 'No file uploaded yet' });
  }
  res.json({ kind: 'upload', displayName: meta.displayName, uploadedAt: meta.uploadedAt, gameCount: meta.gameCount });
});

function getGamesForUser(userId, { year, status }) {
  const db = getDb();

  let query = 'SELECT * FROM games WHERE user_id = ?';
  const params = [userId];

  if (year === 'undated') {
    query += ' AND status = ? AND year IS NULL';
    params.push('completed');
  } else if (year) {
    query += ' AND year = ?';
    params.push(Number(year));
  }

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY date_completed IS NULL, date_completed ASC, date_started IS NULL, date_started ASC, name ASC';

  const rows = db.prepare(query).all(...params);
  db.close();
  return attachMetacritic(rows);
}

function getSummaryForUser(userId) {
  const db = getDb();

  const years = db
    .prepare(`
      SELECT year, COUNT(*) AS count, SUM(hltb_hours) AS totalHours
      FROM games
      WHERE user_id = ? AND status = 'completed' AND year IS NOT NULL
      GROUP BY year
      ORDER BY year DESC
    `)
    .all(userId);

  const undated = db
    .prepare(`
      SELECT COUNT(*) AS count, SUM(hltb_hours) AS totalHours
      FROM games
      WHERE user_id = ? AND status = 'completed' AND year IS NULL
    `)
    .get(userId);

  const liveService = db
    .prepare(`SELECT COUNT(*) AS count FROM games WHERE user_id = ? AND status = 'live_service'`)
    .get(userId);

  const inProgress = db
    .prepare(`SELECT COUNT(*) AS count FROM games WHERE user_id = ? AND status = 'in_progress'`)
    .get(userId);

  const overall = db
    .prepare(`
      SELECT COUNT(*) AS count, SUM(hltb_hours) AS totalHours
      FROM games
      WHERE user_id = ? AND status = 'completed'
    `)
    .get(userId);

  db.close();
  return { years, undated, liveService, inProgress, overall };
}

// A single year's worth of stats — deliberately a much smaller shape than
// getSummaryForUser, since a year-scoped share link must not expose the
// existence or totals of the user's other years.
function getYearSummaryForUser(userId, year) {
  const db = getDb();
  const completed = db
    .prepare(`SELECT COUNT(*) AS count, SUM(hltb_hours) AS totalHours FROM games WHERE user_id = ? AND status = 'completed' AND year = ?`)
    .get(userId, year);
  db.close();
  return { year, completed };
}

app.get('/api/games', requireAuth, (req, res) => {
  res.json(getGamesForUser(req.user.id, req.query));
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime());
}

const VALID_STATUSES = new Set(['completed', 'in_progress', 'live_service']);

// Shared by create (POST) and edit (PATCH) — same shape, same rules either
// way. `status` is explicit rather than inferred from a "still playing"
// boolean so live_service (can't be "finished", so never has a completion
// date) round-trips correctly through edits instead of silently becoming
// in_progress. A live_service game CAN have a start date though — "started
// playing this ongoing game on X" is meaningful even though it never has an
// end date — so only dateCompleted is restricted to completed games.
function parseGamePayload(body) {
  const { name, status, dateStarted, dateCompleted, hltbHours } = body || {};

  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 200) {
    return { error: 'Enter a game name (1-200 characters).' };
  }
  if (!VALID_STATUSES.has(status)) {
    return { error: 'Status must be completed, in_progress, or live_service.' };
  }
  if (dateStarted != null && !isValidDate(dateStarted)) {
    return { error: 'Start date must be in YYYY-MM-DD format.' };
  }
  if (status === 'completed' && (dateCompleted == null || !isValidDate(dateCompleted))) {
    return { error: 'Enter a completion date, or change the status.' };
  }
  if (status !== 'completed' && dateCompleted != null) {
    return { error: 'Only a completed game can have a completion date.' };
  }
  if (dateStarted && dateCompleted && dateStarted > dateCompleted) {
    return { error: 'Start date must be before the completion date.' };
  }
  let hours = null;
  if (hltbHours != null && hltbHours !== '') {
    hours = Number(hltbHours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 10000) {
      return { error: 'Hours must be a positive number.' };
    }
  }

  const year = status === 'completed' ? Number(dateCompleted.slice(0, 4)) : null;

  return {
    data: {
      name: name.trim(),
      status,
      dateStarted: dateStarted || null,
      dateCompleted: status === 'completed' ? dateCompleted : null,
      year,
      hours,
    },
  };
}

app.post('/api/games', requireAuth, (req, res) => {
  const { error, data } = parseGamePayload(req.body);
  if (error) return res.status(400).json({ ok: false, error });

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO games (user_id, name, status, date_started, date_completed, year, hltb_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, data.name, data.status, data.dateStarted, data.dateCompleted, data.year, data.hours);
  db.close();

  runEnrichment();

  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});

app.patch('/api/games/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid game id.' });
  }

  const { error, data } = parseGamePayload(req.body);
  if (error) return res.status(400).json({ ok: false, error });

  const db = getDb();
  const result = db.prepare(`
    UPDATE games
    SET name = ?, status = ?, date_started = ?, date_completed = ?, year = ?, hltb_hours = ?
    WHERE id = ? AND user_id = ?
  `).run(data.name, data.status, data.dateStarted, data.dateCompleted, data.year, data.hours, id, req.user.id);
  db.close();

  if (result.changes === 0) {
    return res.status(404).json({ ok: false, error: 'Game not found.' });
  }

  runEnrichment();

  res.json({ ok: true });
});

// Lets a user correct a bad auto-match by pasting in the real Metacritic
// page themselves. The game's name is read from their own owned row (never
// trusted from the request body), and the URL must match a plain
// metacritic.com/game/<slug>/ shape before we ever fetch it.
app.post('/api/games/:id/metacritic-override', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid game id.' });
  }

  const { metacriticUrl } = req.body || {};
  if (typeof metacriticUrl !== 'string' || !parseMetacriticGameUrl(metacriticUrl)) {
    return res.status(400).json({
      ok: false,
      error: 'Enter a valid Metacritic game URL, e.g. https://www.metacritic.com/game/hades/',
    });
  }

  const db = getDb();
  try {
    const game = db.prepare('SELECT name FROM games WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!game) {
      return res.status(404).json({ ok: false, error: 'Game not found.' });
    }

    let detail;
    try {
      detail = await fetchGameByUrl(metacriticUrl);
    } catch {
      return res.status(502).json({ ok: false, error: 'Could not reach that Metacritic page — double check the URL.' });
    }

    db.prepare(`
      INSERT OR REPLACE INTO metacritic_cache
        (name_key, original_name, status, matched_title, metacritic_url, cover_url, match_score, checked_at)
      VALUES (?, ?, 'found', ?, ?, ?, 100, ?)
    `).run(normalizeName(game.name), game.name, detail.title, detail.metacriticUrl, detail.coverUrl, new Date().toISOString());

    res.json({ ok: true, metacriticUrl: detail.metacriticUrl, coverUrl: detail.coverUrl });
  } catch (err) {
    console.error('metacritic-override failed:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong saving that link.' });
  } finally {
    db.close();
  }
});

app.delete('/api/games/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid game id.' });
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM games WHERE id = ? AND user_id = ?').run(id, req.user.id);
  db.close();

  if (result.changes === 0) {
    return res.status(404).json({ ok: false, error: 'Game not found.' });
  }
  res.json({ ok: true });
});

app.get('/api/enrich-metacritic/status', requireAuth, (req, res) => {
  res.json(getEnrichmentStatus());
});

app.post('/api/enrich-metacritic', requireAuth, (req, res) => {
  runEnrichment();
  res.json(getEnrichmentStatus());
});

app.get('/api/summary', requireAuth, (req, res) => {
  res.json(getSummaryForUser(req.user.id));
});

app.post('/api/refresh', requireAuth, (req, res) => {
  try {
    const count = importFromMarkdown(req.user.id);
    runEnrichment();
    res.json({ ok: true, count });
  } catch (err) {
    console.error('refresh failed:', err);
    res.status(500).json({ ok: false, error: 'Could not refresh — check the server logs.' });
  }
});

// --- Share link management (authenticated — only the owner can list,
// create, regenerate, or revoke their own links) ---

function buildShareUrl(req, token) {
  return `${req.protocol}://${req.get('host')}/shared.html?token=${token}`;
}

function shareRowToApi(req, row) {
  return { token: row.token, year: row.year, url: buildShareUrl(req, row.token), createdAt: row.created_at };
}

app.get('/api/share', requireAuth, (req, res) => {
  res.json(listShares(req.user.id).map((row) => shareRowToApi(req, row)));
});

// body: { year: null | number } — null shares the whole library, a number
// shares just that year. Idempotent: re-requesting a scope you already
// share returns the existing link rather than creating a duplicate.
app.post('/api/share', requireAuth, (req, res) => {
  const { year } = req.body || {};
  const token = getOrCreateShare(req.user.id, year);
  if (!token) {
    return res.status(400).json({ ok: false, error: 'Invalid year.' });
  }
  const db = getDb();
  const row = db.prepare('SELECT token, year, created_at FROM share_tokens WHERE token = ?').get(token);
  db.close();
  res.json(shareRowToApi(req, row));
});

app.post('/api/share/:token/regenerate', requireAuth, (req, res) => {
  const newToken = regenerateShare(req.params.token, req.user.id);
  if (!newToken) {
    return res.status(404).json({ ok: false, error: 'Share link not found.' });
  }
  const db = getDb();
  const row = db.prepare('SELECT token, year, created_at FROM share_tokens WHERE token = ?').get(newToken);
  db.close();
  res.json(shareRowToApi(req, row));
});

app.delete('/api/share/:token', requireAuth, (req, res) => {
  const removed = disableShare(req.params.token, req.user.id);
  if (!removed) {
    return res.status(404).json({ ok: false, error: 'Share link not found.' });
  }
  res.json({ ok: true });
});

// --- Public read-only view (no session cookie, no auth) — a completely
// separate route tree from everything above. Nothing under /api/shared/*
// ever inserts, updates, or deletes; it only ever calls the same read
// helpers used by the authenticated dashboard, and a year-scoped token can
// only ever see that one year — the query string can't widen it. ---

function resolveShare(req, res) {
  const share = resolveToken(req.params.token);
  if (!share) {
    res.status(404).json({ ok: false, error: 'This share link is invalid or has been turned off.' });
    return null;
  }
  return share;
}

app.get('/api/shared/:token/profile', (req, res) => {
  const share = resolveShare(req, res);
  if (!share) return;
  const db = getDb();
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(share.userId);
  db.close();
  res.json({ username: user.username, year: share.year });
});

app.get('/api/shared/:token/summary', (req, res) => {
  const share = resolveShare(req, res);
  if (!share) return;
  res.json(share.year == null ? getSummaryForUser(share.userId) : getYearSummaryForUser(share.userId, share.year));
});

app.get('/api/shared/:token/games', (req, res) => {
  const share = resolveShare(req, res);
  if (!share) return;
  // A year-scoped link ignores whatever the client asks for and always
  // returns exactly that year's completed games — the scope is enforced
  // here, not by trusting the caller to only request the "allowed" year.
  const query = share.year == null ? req.query : { year: share.year, status: 'completed' };
  res.json(getGamesForUser(share.userId, query));
});

app.listen(PORT, () => {
  console.log(`WrapUp running at http://localhost:${PORT}`);
});
