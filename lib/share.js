// Manages a user's share links. Each link has a scope — `year: null` means
// the whole library, `year: 2025` means just that year — and the token
// itself is a high-entropy, server-generated opaque string, never guessable
// and never derived from the username/email. There's at most one live token
// per (user, scope): re-creating a scope you already share just hands back
// the existing link; regenerating swaps it for a fresh one and kills the
// old, so a leaked link can always be revoked.

const crypto = require('crypto');
const { getDb } = require('./db');

function normalizeYear(year) {
  if (year == null || year === '') return null;
  const n = Number(year);
  return Number.isInteger(n) ? n : undefined; // undefined signals "invalid"
}

function listShares(userId) {
  const db = getDb();
  const rows = db.prepare('SELECT token, year, created_at FROM share_tokens WHERE user_id = ? ORDER BY year IS NOT NULL, year')
    .all(userId);
  db.close();
  return rows;
}

// Returns the existing token for this scope if there is one, otherwise
// creates it. Idempotent by design — clicking "create" twice for the same
// year doesn't spawn a second link.
function getOrCreateShare(userId, year) {
  const scope = normalizeYear(year);
  if (scope === undefined) return null;

  const db = getDb();
  const existing = db.prepare('SELECT token FROM share_tokens WHERE user_id = ? AND year IS ?').get(userId, scope);
  if (existing) {
    db.close();
    return existing.token;
  }
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO share_tokens (token, user_id, year, created_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, scope, new Date().toISOString());
  db.close();
  return token;
}

// Both take the *old* token plus the owner's id, so a request can't
// regenerate/revoke a link it doesn't own just by guessing another user's
// token shape.
function regenerateShare(oldToken, userId) {
  const db = getDb();
  const existing = db.prepare('SELECT year FROM share_tokens WHERE token = ? AND user_id = ?').get(oldToken, userId);
  if (!existing) {
    db.close();
    return null;
  }
  const newToken = crypto.randomBytes(24).toString('base64url');
  db.prepare('DELETE FROM share_tokens WHERE token = ?').run(oldToken);
  db.prepare('INSERT INTO share_tokens (token, user_id, year, created_at) VALUES (?, ?, ?, ?)')
    .run(newToken, userId, existing.year, new Date().toISOString());
  db.close();
  return newToken;
}

function disableShare(token, userId) {
  const db = getDb();
  const result = db.prepare('DELETE FROM share_tokens WHERE token = ? AND user_id = ?').run(token, userId);
  db.close();
  return result.changes > 0;
}

function resolveToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const db = getDb();
  const row = db.prepare('SELECT user_id, year FROM share_tokens WHERE token = ?').get(token);
  db.close();
  return row ? { userId: row.user_id, year: row.year } : null;
}

module.exports = { listShares, getOrCreateShare, regenerateShare, disableShare, resolveToken };
