// Steam Web API client. Official, documented API — needs a free Steam Web API
// key (steamcommunity.com/dev/apikey) and a SteamID64. The user's profile and
// game details must be public for the achievement endpoints to return anything.
//
// https://developer.valvesoftware.com/wiki/Steam_Web_API

const BASE = 'https://api.steampowered.com';

async function steamFetch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'WrapUp/1.0' } });
  if (res.status === 403) {
    throw new Error('Steam rejected the request (403) — check the API key, and that the profile and game details are public.');
  }
  if (!res.ok) {
    throw new Error(`Steam API returned ${res.status}`);
  }
  return res.json();
}

// Accepts a raw SteamID64, a vanity name, or a full profile URL of either
// shape, and resolves it to a SteamID64.
async function resolveSteamId(apiKey, input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('No Steam ID set.');

  const profileUrlMatch = raw.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profileUrlMatch) return profileUrlMatch[1];

  if (/^\d{17}$/.test(raw)) return raw;

  const vanityMatch = raw.match(/steamcommunity\.com\/id\/([^/\s]+)/i);
  const vanity = vanityMatch ? vanityMatch[1] : raw;

  const data = await steamFetch(
    `${BASE}/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(apiKey)}&vanityurl=${encodeURIComponent(vanity)}`
  );
  if (data?.response?.success !== 1 || !data.response.steamid) {
    throw new Error(`Could not resolve Steam profile "${vanity}".`);
  }
  return data.response.steamid;
}

async function getOwnedGames(apiKey, steamId) {
  const data = await steamFetch(
    `${BASE}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(apiKey)}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1`
  );
  const games = data?.response?.games;
  if (!Array.isArray(games)) {
    throw new Error('Steam returned no games — is the profile (and "Game details") set to public?');
  }
  // playtimeMinutes helps the user judge which unlisted games are worth adding.
  return games.map((g) => ({ appid: g.appid, name: g.name, playtimeMinutes: g.playtime_forever || 0 }));
}

// Returns only the achievements the player has actually unlocked, each with an
// `unlocktime` (unix seconds). Games with no achievements, or where none are
// unlocked, come back as an empty array rather than throwing — that's a normal
// outcome, not an error.
async function getUnlockedAchievements(apiKey, steamId, appid) {
  const url = `${BASE}/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(apiKey)}&steamid=${steamId}&appid=${appid}`;
  let data;
  try {
    data = await steamFetch(url);
  } catch {
    // A game with no achievement schema returns a 400/403 here. Treat as "none".
    return [];
  }
  const achievements = data?.playerstats?.achievements;
  if (!Array.isArray(achievements)) return [];

  return achievements
    .filter((a) => a.achieved === 1 && Number(a.unlocktime) > 0)
    .map((a) => ({ name: a.apiname, unlockedAt: Number(a.unlocktime) * 1000 }));
}

module.exports = { resolveSteamId, getOwnedGames, getUnlockedAchievements };
