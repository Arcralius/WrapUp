const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const path = require('path');

const { parseMarkdown } = require('../lib/parser');
const { sanitizeMarkdown, sanitizeDisplayName, MAX_BYTES } = require('../lib/sanitize');
const { getDb, replaceAllGames } = require('../lib/db');
const { recordUpload, userUploadPath } = require('../lib/source');
const { runEnrichment } = require('../lib/enrichment');
const { requireAuth } = require('../lib/auth');

const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const ALLOWED_MIMETYPES = new Set([
  'text/markdown',
  'text/plain',
  'application/octet-stream', // what most browsers send for .md — extension check does the real work
  '',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    files: 1,
  },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      cb(new Error('Only .md, .markdown, or .txt files are accepted.'));
      return;
    }
    if (!ALLOWED_MIMETYPES.has(file.mimetype)) {
      cb(new Error('Unrecognized file type.'));
      return;
    }
    cb(null, true);
  },
});

const router = express.Router();

router.post('/api/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? `File is too large (max ${MAX_BYTES / 1024 / 1024}MB).`
        : err.message || 'Upload rejected.';
      return res.status(400).json({ ok: false, error: message });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file provided.' });
    }

    const clean = sanitizeMarkdown(req.file.buffer);
    if (!clean.ok) {
      return res.status(400).json({ ok: false, error: clean.error });
    }

    const games = parseMarkdown(clean.text);
    if (games.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'No games found. Make sure the file has a "# Played" section with a "- Game (Live Service)" / "- Game (HLTB N Hours)" style list.',
      });
    }

    // The filename is always generated here, scoped under this user's own
    // upload directory — the client's original name is never used to build
    // a filesystem path, only sanitized for display.
    const generatedName = `${crypto.randomUUID()}.md`;
    const destPath = userUploadPath(req.user.id, generatedName);
    fs.writeFileSync(destPath, clean.text, { encoding: 'utf8', mode: 0o600 });

    const meta = recordUpload(req.user.id, {
      filename: generatedName,
      displayName: sanitizeDisplayName(req.file.originalname),
      gameCount: games.length,
    });

    const db = getDb();
    replaceAllGames(db, req.user.id, games);
    db.close();

    runEnrichment();

    res.json({ ok: true, count: games.length, uploadedAt: meta.uploadedAt, displayName: meta.displayName });
  });
});

module.exports = router;
