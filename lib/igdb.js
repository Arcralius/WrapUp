// IGDB client — fills in "how long to beat" style completion times.
//
// Why IGDB and not Metacritic or HowLongToBeat: Metacritic serves scores and
// reviews, not completion times, and its only official API is paid/enterprise.
// HowLongToBeat has no public API and actively blocks automation. IGDB
// (Twitch/Amazon) publishes an official, free-for-non-commercial
// `game_time_to_beat` resource, so it's the one source that can actually
// deliver this data with a key the user can get themselves.
//
// Credentials are a Twitch Client ID + Client Secret (dev.twitch.tv). If the
// user hasn't set them, the whole integration is simply skipped.
//
// https://api-docs.igdb.com/

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const IGDB_URL = 'https://api.igdb.com/v4';

async function getAccessToken(clientId, clientSecret) {
  const res = await fetch(
    `${TOKEN_URL}?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  if (!res.ok) {
    throw new Error('Twitch/IGDB rejected those credentials — double-check the Client ID and Client Secret.');
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Twitch/IGDB did not return an access token.');
  return data.access_token;
}

async function igdbQuery(clientId, token, endpoint, body) {
  const res = await fetch(`${IGDB_URL}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Client-ID': clientId,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`IGDB ${endpoint} returned ${res.status}`);
  }
  return res.json();
}

// IGDB's Apocalypse query language is a plain string body; the name is
// interpolated into a quoted search term, so escape any quotes/backslashes in
// it rather than letting a game title break out of the string.
function escapeQuery(name) {
  return String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Looks a game up by name and returns its "normally" completion time in hours
// (IGDB reports seconds), or null when IGDB has no time-to-beat data for it.
async function getTimeToBeatHours(clientId, token, gameName) {
  const games = await igdbQuery(
    clientId,
    token,
    'games',
    `search "${escapeQuery(gameName)}"; fields id,name; limit 1;`
  );
  if (!Array.isArray(games) || games.length === 0) return null;

  const gameId = games[0].id;
  const times = await igdbQuery(
    clientId,
    token,
    'game_time_to_beat',
    `where game_id = ${gameId}; fields normally,hastily,completely; limit 1;`
  );
  if (!Array.isArray(times) || times.length === 0) return null;

  // Prefer "normally"; fall back to the others so a game with only one figure
  // still gets something useful.
  const seconds = times[0].normally || times[0].completely || times[0].hastily;
  if (!seconds || seconds <= 0) return null;

  return Math.round((seconds / 3600) * 2) / 2; // hours, rounded to nearest 0.5
}

module.exports = { getAccessToken, getTimeToBeatHours };
