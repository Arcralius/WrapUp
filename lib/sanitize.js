// Validates and cleans an uploaded markdown buffer before it ever touches
// the parser or the filesystem. Nothing here trusts client-provided
// metadata (filename, mimetype) — those are checked defense-in-depth at the
// route level, but the real gate is what's actually inside the bytes.

const MAX_BYTES = 2 * 1024 * 1024; // 2MB — this file is a personal game list, not a data dump
const MAX_LINES = 20000;
const MAX_LINE_LENGTH = 2000;

function sanitizeMarkdown(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: 'File is empty.' };
  }

  if (buffer.length > MAX_BYTES) {
    return { ok: false, error: `File is too large (max ${MAX_BYTES / 1024 / 1024}MB).` };
  }

  // A NUL byte (or a run of other control bytes) is the cheapest signal that
  // this isn't text — binaries, images, etc. Reject before decoding.
  if (buffer.includes(0)) {
    return { ok: false, error: 'File does not look like a text/markdown file.' };
  }

  let text;
  try {
    text = buffer.toString('utf8');
  } catch {
    return { ok: false, error: 'File is not valid UTF-8 text.' };
  }

  // Strip BOM, normalize line endings.
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // eslint-disable-next-line no-control-regex
  const controlCharRatio = (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length / text.length;
  if (controlCharRatio > 0.01) {
    return { ok: false, error: 'File contains unexpected binary content.' };
  }

  const lines = text.split('\n');
  if (lines.length > MAX_LINES) {
    return { ok: false, error: `File has too many lines (max ${MAX_LINES}).` };
  }
  if (lines.some((l) => l.length > MAX_LINE_LENGTH)) {
    return { ok: false, error: 'File contains an unreasonably long line.' };
  }

  return { ok: true, text };
}

// Never used as a filesystem path — only for display in the UI/logs.
function sanitizeDisplayName(name) {
  if (typeof name !== 'string') return 'upload.md';
  const base = name.split(/[\\/]/).pop() || 'upload.md';
  const cleaned = base.replace(/[^a-zA-Z0-9 ._-]/g, '').slice(0, 100).trim();
  return cleaned || 'upload.md';
}

module.exports = { sanitizeMarkdown, sanitizeDisplayName, MAX_BYTES };
