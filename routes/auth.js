const express = require('express');
const { getDb } = require('../lib/db');
const {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  SESSION_COOKIE,
} = require('../lib/auth');
const { bootstrapFirstUser } = require('../lib/bootstrap');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function isSecureRequest(req) {
  // Trust X-Forwarded-Proto only if you've configured `app.set('trust proxy', ...)`
  // for your actual reverse proxy; here we just check the direct connection.
  return req.secure;
}

router.post('/api/auth/signup', (req, res) => {
  const { username, email, password } = req.body || {};

  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ ok: false, error: 'Username must be 3-32 characters: letters, numbers, _ or -.' });
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const db = getDb();
  try {
    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'That username or email is already registered.' });
    }

    const passwordHash = hashPassword(password);
    const result = db.prepare(
      'INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)'
    ).run(username, email, passwordHash, new Date().toISOString());

    const userId = Number(result.lastInsertRowid);
    const { token, expiresAt } = createSession(db, userId);
    setSessionCookie(res, token, expiresAt, isSecureRequest(req));

    res.json({ ok: true, user: { id: userId, username, email } });

    // Fire-and-forget, after responding — the bundled sample list import +
    // Metacritic enrichment shouldn't hold up the signup response.
    bootstrapFirstUser(userId);
  } finally {
    db.close();
  }
});

router.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: 'Username and password are required.' });
  }

  const db = getDb();
  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);

    // Same generic error whether the username doesn't exist or the password
    // is wrong — a distinct "no such user" message lets an attacker enumerate
    // registered accounts.
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
    }

    const { token, expiresAt } = createSession(db, user.id);
    setSessionCookie(res, token, expiresAt, isSecureRequest(req));
    res.json({ ok: true, user: { id: user.id, username: user.username, email: user.email } });
  } finally {
    db.close();
  }
});

router.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const db = getDb();
    destroySession(db, token);
    db.close();
  }
  clearSessionCookie(res, isSecureRequest(req));
  res.json({ ok: true });
});

router.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

module.exports = router;
