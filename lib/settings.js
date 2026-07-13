// Per-user credentials for the optional sync integrations (Steam, PSN, IGDB).
//
// These are secrets. They're stored server-side and used only by the sync
// jobs — getPublicSettings() is the ONLY thing the browser ever sees, and it
// reports just whether each credential is set (plus the Steam ID, which is a
// public identifier, not a secret). The raw values are never sent back to the
// client, so a saved key can be replaced but not read out again.

const { getDb } = require('./db');

const SECRET_FIELDS = ['steam_api_key', 'psn_npsso', 'igdb_client_id', 'igdb_client_secret'];

function getSettings(userId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  db.close();
  return row || {};
}

// What the profile page is allowed to know: which integrations are configured,
// never the credentials themselves.
function getPublicSettings(userId) {
  const s = getSettings(userId);
  return {
    steamId: s.steam_id || '',
    steamApiKeySet: Boolean(s.steam_api_key),
    psnNpssoSet: Boolean(s.psn_npsso),
    igdbSet: Boolean(s.igdb_client_id && s.igdb_client_secret),
  };
}

// Only fields actually present in the payload are touched, and a field sent as
// an empty string clears that credential (so an integration can be turned off).
// A field that's absent/undefined is left exactly as it was — that's what lets
// the UI show "already set" placeholders without needing the real value.
function saveSettings(userId, patch) {
  const allowed = ['steam_api_key', 'steam_id', 'psn_npsso', 'igdb_client_id', 'igdb_client_secret'];
  const updates = {};
  for (const field of allowed) {
    if (patch[field] !== undefined) {
      const value = String(patch[field]).trim();
      updates[field] = value === '' ? null : value;
    }
  }
  if (Object.keys(updates).length === 0) return;

  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id, updated_at) VALUES (?, ?)')
    .run(userId, new Date().toISOString());

  const setClause = Object.keys(updates).map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE user_settings SET ${setClause}, updated_at = ? WHERE user_id = ?`)
    .run(...Object.values(updates), new Date().toISOString(), userId);
  db.close();
}

module.exports = { getSettings, getPublicSettings, saveSettings, SECRET_FIELDS };
