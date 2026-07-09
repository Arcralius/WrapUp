const fs = require('fs');
const { parseMarkdown } = require('../lib/parser');
const { getDb, replaceAllGames } = require('../lib/db');
const { getCurrentSource } = require('../lib/source');

// A brand new account has no uploaded file yet — that's not an error, it's
// just an empty list until they upload their own.
function importFromMarkdown(userId) {
  const { path: sourcePath } = getCurrentSource(userId);
  if (!sourcePath) return 0;

  const text = fs.readFileSync(sourcePath, 'utf8');
  const games = parseMarkdown(text);

  const db = getDb();
  replaceAllGames(db, userId, games);
  db.close();

  return games.length;
}

module.exports = { importFromMarkdown };
