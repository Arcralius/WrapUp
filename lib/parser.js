// Parses the "# Played" section of markdown.md into structured game records.
//
// Line shapes handled:
//   - Name (Live Service)
//   - Name (HLTB 12 Hours)               <- completed, date unknown
//   - Name (HLTB 12½ Hours)              <- fractional hours via the ½ glyph
//   - Name (HTLB 12 Hours)               <- source typo, treated same as HLTB
//   - Name (12 Hours)                    <- no HLTB/HTLB prefix
//   - Name DD/MM/YYYY (HLTB 12 Hours)    <- completed with a known date
//   - Name (2018) (HLTB 33 Hours)        <- release year is part of the title
//
// The trailing "(...)" is always the status/duration marker; anything before
// it is the title (which may itself contain parentheses, e.g. a release year).
// Stray "**" bold markers that show up around a couple of closing parens in
// the source file are stripped before parsing.

const LINE_RE = /^-\s+(.*)$/;
const TRAILING_RE = /^(.*?)(?:\s+(\d{2})\/(\d{2})\/(\d{4}))?\s*\(([^()]*)\)\s*$/;
const HOURS_RE = /^(?:H[TL][TL]B\s+)?(\d+)(½)?\s*Hours?$/i;

function parseLine(rawLine) {
  const lineMatch = LINE_RE.exec(rawLine.trim());
  if (!lineMatch) return null;

  const cleaned = lineMatch[1].replace(/\*\*/g, '').trim();
  const m = TRAILING_RE.exec(cleaned);
  if (!m) return null;

  const name = m[1].trim();
  const [, , day, month, year, marker] = m;
  const dateCompleted = day ? `${year}-${month}-${day}` : null;
  const markerText = marker.trim();

  if (!name) return null;

  if (/^live service$/i.test(markerText)) {
    return {
      name,
      status: 'live_service',
      dateCompleted: null,
      year: null,
      hltbHours: null,
    };
  }

  const hoursMatch = HOURS_RE.exec(markerText);
  const hltbHours = hoursMatch
    ? parseInt(hoursMatch[1], 10) + (hoursMatch[2] ? 0.5 : 0)
    : null;

  return {
    name,
    status: 'completed',
    dateCompleted,
    year: dateCompleted ? Number(year) : null,
    hltbHours,
  };
}

function parseMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const playedStart = lines.findIndex((l) => /^#\s*Played\s*$/i.test(l.trim()));
  if (playedStart === -1) return [];

  const games = [];
  const seen = new Set();

  for (let i = playedStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#\s/.test(line.trim())) break; // next section starts, stop
    if (!line.trim().startsWith('-')) continue;

    const parsed = parseLine(line);
    if (!parsed) continue;

    const dedupeKey = `${parsed.name}|${parsed.dateCompleted}|${parsed.hltbHours}|${parsed.status}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    games.push(parsed);
  }

  return games;
}

module.exports = { parseMarkdown, parseLine };
