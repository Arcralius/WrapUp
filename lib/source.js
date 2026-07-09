// Tracks which file each user's game list currently comes from — their most
// recently accepted upload. Every path is built from the user's numeric id
// (a trusted server-side value from the session, never client input) plus a
// server-generated filename (see routes/upload.js), so nothing here is ever
// derived from user-controlled strings.

const fs = require('fs');
const path = require('path');

const DEFAULT_MD_PATH = path.join(__dirname, '..', 'markdown.md');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

function userDir(userId) {
  return path.join(UPLOADS_DIR, String(userId));
}

function ensureUserDir(userId) {
  const dir = userDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Returns { path, meta } for the user's most recent successful upload, or
// { path: null, meta: null } if they haven't uploaded anything yet (a brand
// new account starts with an empty list, not somebody else's data).
function getCurrentSource(userId) {
  const dir = ensureUserDir(userId);
  const pointerPath = path.join(dir, 'latest.json');
  try {
    const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
    const filePath = path.join(dir, pointer.filename);
    if (path.dirname(filePath) === dir && fs.existsSync(filePath)) {
      return { path: filePath, meta: pointer };
    }
  } catch {
    // no pointer yet, or it's unreadable
  }
  return { path: null, meta: null };
}

function recordUpload(userId, { filename, displayName, gameCount }) {
  const dir = ensureUserDir(userId);
  const meta = {
    filename,
    displayName,
    gameCount,
    uploadedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(meta, null, 2));
  return meta;
}

function userUploadPath(userId, filename) {
  return path.join(ensureUserDir(userId), filename);
}

module.exports = {
  getCurrentSource,
  recordUpload,
  ensureUserDir,
  userUploadPath,
  UPLOADS_DIR,
  DEFAULT_MD_PATH,
};
