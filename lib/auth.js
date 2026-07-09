// Password hashing, session tokens, and auth middleware.
//
// Passwords: scrypt (Node's built-in crypto — no bcrypt native dependency to
// compile), a random per-password salt, and a constant-time comparison on
// verify so a byte-by-byte hash mismatch can't leak timing information.
//
// Sessions: opaque, high-entropy, server-generated tokens stored in the
// `sessions` table and checked on every request — not a stateless signed
// JWT — so logout actually revokes access immediately instead of just
// waiting out an expiry. The cookie is HttpOnly (unreadable to page JS, so
// an XSS bug can't steal it), SameSite=Lax (sent on top-level navigation but
// not cross-site POSTs, the standard CSRF mitigation for cookie sessions),
// and Secure whenever the request arrived over TLS.

const crypto = require('crypto');
const { getDb } = require('./db');

const SCRYPT_KEYLEN = 64;
const SESSION_COOKIE = 'wrapup_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt}:${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hashHex] = (stored || '').split(':');
  if (!salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now.toISOString(), expiresAt.toISOString());
  return { token, expiresAt };
}

function destroySession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function getUserForToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.email
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, new Date().toISOString());
  return row || null;
}

function setSessionCookie(res, token, expiresAt, secure) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    expires: expiresAt,
    path: '/',
  });
}

function clearSessionCookie(res, secure) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const db = getDb();
  const user = getUserForToken(db, token);
  db.close();

  if (!user) {
    return res.status(401).json({ ok: false, error: 'Not signed in.' });
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  getUserForToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  SESSION_COOKIE,
};
