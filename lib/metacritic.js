// Looks up a game's Metacritic page + cover art by scraping their search
// page. Metacritic has no public API, so this parses the Nuxt SSR payload
// (a `__NUXT_DATA__` script tag containing a flat, index-referenced JSON
// array) that the search page embeds — much more stable than scraping
// rendered CSS classes, since it's the same data the page itself renders from.

const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function normalizeName(name) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents (Pokémon -> pokemon)
    .replace(/['’]/g, '') // drop apostrophes rather than splitting on them — "Don't"/"Dont" and "Assassin's"/"Assassins" should normalize identically
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const squash = (s) => s.replace(/\s+/g, '');

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// A small alias table for: (1) abbreviations that won't fuzzy-match their
// real Metacritic title at all (e.g. "CSGO" has no substring relationship
// with "Counter-Strike: Global Offensive"), and (2) known typos in this
// list whose misspelling is different enough that Metacritic's own search
// returns zero results for it. Matched/queried on the normalized name.
const ALIASES = {
  csgo: 'Counter-Strike: Global Offensive',
  cs2: 'Counter-Strike 2',
  pubg: "PlayerUnknown's Battlegrounds",
  rf2: 'rFactor 2',
  dcs: 'DCS World',
  valhiem: 'Valheim',
};

function similarityScore(query, candidate) {
  const a = normalizeName(query);
  const b = normalizeName(candidate);
  if (!a || !b) return 0;
  if (a === b) return 100;

  // Ignore spacing differences entirely before falling back to word-level
  // comparison — "VR Chat" vs "VRChat", "Back4Blood" vs "Back 4 Blood",
  // "DirtyBomb" vs "Dirty Bomb" are the same title with the space moved.
  if (squash(a) === squash(b)) return 95;

  // Word-boundary containment only — raw substring containment lets a short
  // query like "overwatch 2" match "overwatch 2016" (the "2" is a prefix of
  // "2016"), which is a different game entirely.
  const aWords = a.split(' ');
  const bWords = b.split(' ');
  const [shorter, longer] = aWords.length <= bWords.length ? [aWords, bWords] : [bWords, aWords];
  const isWholeWordPrefix = shorter.every((w, i) => longer[i] === w);
  if (isWholeWordPrefix) return shorter.length === longer.length ? 100 : 75;

  const aSet = new Set(aWords);
  const bSet = new Set(bWords);
  const intersection = [...aSet].filter((w) => bSet.has(w)).length;
  const union = new Set([...aSet, ...bSet]).size;
  const overlapScore = union === 0 ? 0 : Math.round((intersection / union) * 70);

  // Catches near-miss typos ("Stardew Vally" vs "Stardew Valley") that word
  // overlap scores harshly since a misspelled word shares zero tokens with
  // the correct one. Metacritic's own search already does this fuzzing
  // server-side (it surfaces the right title as a candidate for a typo'd
  // query) — this just lets our scorer recognize the candidate it handed us.
  //
  // Deliberately narrow: only compares same-shape titles word-for-word (not
  // a whole-string edit ratio), and bails out completely the moment a pair
  // of corresponding words are both pure numbers and differ — "2" vs "2016"
  // or "2" vs "3" is a different sequel/version, never a typo, no matter how
  // small the edit distance looks.
  let editScore = null;
  if (aWords.length === bWords.length) {
    let total = 0;
    let bail = false;
    for (let i = 0; i < aWords.length; i++) {
      const [wa, wb] = [aWords[i], bWords[i]];
      if (wa === wb) { total += 100; continue; }
      if (/^\d+$/.test(wa) && /^\d+$/.test(wb)) { bail = true; break; }
      const wMaxLen = Math.max(wa.length, wb.length);
      total += wMaxLen === 0 ? 0 : (1 - levenshtein(wa, wb) / wMaxLen) * 100;
    }
    if (!bail) editScore = Math.round(total / aWords.length);
  }

  return editScore === null ? overlapScore : Math.max(overlapScore, editScore);
}

function resolve(data, ref) {
  return typeof ref === 'number' ? data[ref] : ref;
}

// Walks the flattened Nuxt payload for every object shaped like a game
// entry (has slug/title/images and type === 'game-title') and resolves it
// into a plain {title, slug, coverUrl, metacriticUrl} record.
function extractGameEntries(data) {
  const entries = [];

  for (let i = 0; i < data.length; i++) {
    const node = data[i];
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    if (!('slug' in node) || !('title' in node) || !('images' in node)) continue;

    const type = resolve(data, node.type);
    if (type !== 'game-title') continue;

    const title = resolve(data, node.title);
    const slug = resolve(data, node.slug);
    if (typeof title !== 'string' || typeof slug !== 'string') continue;

    let coverUrl = null;
    try {
      const imagesRef = resolve(data, node.images);
      const firstImageIdx = Array.isArray(imagesRef) ? imagesRef[0] : null;
      const image = typeof firstImageIdx === 'number' ? data[firstImageIdx] : null;
      if (image && typeof image === 'object') {
        const bucketType = resolve(data, image.bucketType);
        const bucketPath = resolve(data, image.bucketPath);
        if (typeof bucketType === 'string' && typeof bucketPath === 'string') {
          coverUrl = `https://www.metacritic.com/a/img/${bucketType}${bucketPath}`;
        }
      }
    } catch {
      // no image for this entry — leave coverUrl null
    }

    entries.push({
      title,
      metacriticUrl: `https://www.metacritic.com/game/${slug}/`,
      coverUrl,
    });
  }

  return entries;
}

function parseNuxtPayload(html) {
  const match = html.match(
    /<script type="application\/json" data-nuxt-data="nuxt-app" data-ssr="true" id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

const MIN_MATCH_SCORE = 35;

async function runSearch(searchTerm) {
  // A literal "/" survives encodeURIComponent as %2F, but Metacritic's front
  // end treats a decoded slash as an extra path segment and 404s (e.g.
  // "Kingdom Hearts 358/2 Days") — swap it for a space before building the URL.
  const urlSafeTerm = searchTerm.replace(/\//g, ' ');
  const url = `https://www.metacritic.com/search/${encodeURIComponent(urlSafeTerm)}/`;
  const res = await fetch(url, { headers: { 'User-Agent': SEARCH_UA } });
  if (!res.ok) {
    throw new Error(`Metacritic search returned ${res.status}`);
  }

  const html = await res.text();
  const data = parseNuxtPayload(html);
  if (!data) return [];
  return extractGameEntries(data);
}

function pickBest(searchTerm, entries) {
  let best = null;
  for (const entry of entries) {
    const score = similarityScore(searchTerm, entry.title);
    if (!best || score > best.score) best = { ...entry, score };
  }
  return best && best.score >= MIN_MATCH_SCORE ? best : null;
}

async function searchGame(name) {
  const alias = ALIASES[normalizeName(name)];
  const searchTerm = alias || name;

  let best = pickBest(searchTerm, await runSearch(searchTerm));

  // Metacritic's own search sometimes fails on a spaced query for a title
  // that's actually squashed together on their end (e.g. "VR Chat" returns
  // unrelated results, but "VRChat" finds the exact page) — retry once with
  // spaces removed before giving up.
  if (!best && searchTerm.includes(' ')) {
    const squashedTerm = squash(searchTerm);
    best = pickBest(searchTerm, await runSearch(squashedTerm));
  }

  if (!best) return { status: 'not_found' };

  return {
    status: 'found',
    matchedTitle: best.title,
    metacriticUrl: best.metacriticUrl,
    coverUrl: best.coverUrl,
    matchScore: best.score,
  };
}

const METACRITIC_GAME_URL_RE = /^https:\/\/(www\.)?metacritic\.com\/game\/([a-z0-9-]+)\/?$/i;

function parseMetacriticGameUrl(url) {
  const match = typeof url === 'string' ? url.trim().match(METACRITIC_GAME_URL_RE) : null;
  return match ? match[2].toLowerCase() : null;
}

// Fetches a specific Metacritic game page a user has manually pasted in (to
// correct a bad auto-match) and pulls its title/cover the same way search
// results are parsed. Only ever called with a URL matching
// METACRITIC_GAME_URL_RE, never with a bare user string.
async function fetchGameByUrl(url) {
  const slug = parseMetacriticGameUrl(url);
  if (!slug) return null;

  const canonicalUrl = `https://www.metacritic.com/game/${slug}/`;
  const res = await fetch(canonicalUrl, { headers: { 'User-Agent': SEARCH_UA } });
  if (!res.ok) {
    throw new Error(`Metacritic page returned ${res.status}`);
  }

  const html = await res.text();
  const data = parseNuxtPayload(html);
  if (!data) return { metacriticUrl: canonicalUrl, title: null, coverUrl: null };

  const entries = extractGameEntries(data);
  // A detail page can embed more than one "game-title" node (related games
  // in a sidebar, etc.) — prefer the one whose own slug matches the URL.
  const match = entries.find((e) => e.metacriticUrl === canonicalUrl) || entries[0] || null;

  return {
    metacriticUrl: canonicalUrl,
    title: match?.title || null,
    coverUrl: match?.coverUrl || null,
  };
}

module.exports = {
  searchGame,
  normalizeName,
  similarityScore,
  extractGameEntries,
  parseNuxtPayload,
  parseMetacriticGameUrl,
  fetchGameByUrl,
};
