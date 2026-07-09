// The very first account ever created on this instance inherits the bundled
// sample list (the site owner's own game list) as a starting point, fed
// through the exact same upload pipeline every later upload goes through.
// Every subsequent signup starts with an empty list until the user uploads
// their own file — this only ever fires once, for user id 1.

const fs = require('fs');
const crypto = require('crypto');
const { getDb } = require('./db');
const { sanitizeMarkdown } = require('./sanitize');
const { parseMarkdown } = require('./parser');
const { recordUpload, userUploadPath, DEFAULT_MD_PATH } = require('./source');
const { importFromMarkdown } = require('../scripts/import');
const { runEnrichment } = require('./enrichment');

function bootstrapFirstUser(userId) {
  const db = getDb();
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  db.close();
  if (userCount !== 1) return;
  if (!fs.existsSync(DEFAULT_MD_PATH)) return;

  const raw = fs.readFileSync(DEFAULT_MD_PATH);
  const clean = sanitizeMarkdown(raw);
  if (!clean.ok) return;

  const games = parseMarkdown(clean.text);
  if (games.length === 0) return;

  const generatedName = `${crypto.randomUUID()}.md`;
  fs.writeFileSync(userUploadPath(userId, generatedName), clean.text, { encoding: 'utf8', mode: 0o600 });
  recordUpload(userId, {
    filename: generatedName,
    displayName: 'markdown.md (starter data)',
    gameCount: games.length,
  });

  importFromMarkdown(userId);
  runEnrichment();
}

module.exports = { bootstrapFirstUser };
