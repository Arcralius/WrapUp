// PlayStation Network trophy client, via the `psn-api` library.
//
// IMPORTANT: Sony publishes no public trophy API. This talks to the same
// internal endpoints the PlayStation website uses, authenticated with an
// NPSSO token — a session credential the user copies from their own logged-in
// PSN session (https://ca.account.sony.com/api/v1/ssocookie). It is
// unofficial and can break whenever Sony changes those endpoints; that
// tradeoff was accepted deliberately. The token is stored server-side only.

const {
  exchangeNpssoForCode,
  exchangeCodeForAccessToken,
  getUserTitles,
  getUserTrophiesEarnedForTitle,
} = require('psn-api');

// NPSSO -> access token. Throws a clear error if the token is stale, which is
// the common failure (they expire and have to be re-copied).
async function authenticate(npsso) {
  let authorization;
  try {
    const accessCode = await exchangeNpssoForCode(String(npsso).trim());
    authorization = await exchangeCodeForAccessToken(accessCode);
  } catch (err) {
    throw new Error('PSN rejected the NPSSO token — it has probably expired. Grab a fresh one and save it again.');
  }
  if (!authorization?.accessToken) {
    throw new Error('PSN did not return an access token — the NPSSO token is likely invalid or expired.');
  }
  return authorization;
}

// Every trophy title on the account, with the service name needed to fetch its
// trophies ("trophy" for PS3/PS4/Vita, "trophy2" for PS5).
async function getTrophyTitles(authorization) {
  const response = await getUserTitles(authorization, 'me');
  const titles = response?.trophyTitles;
  if (!Array.isArray(titles)) return [];
  return titles.map((t) => ({
    id: t.npCommunicationId,
    name: t.trophyTitleName,
    serviceName: t.npServiceName || 'trophy',
  }));
}

// Only the trophies actually earned, each with the timestamp it was earned at.
// A title with nothing earned returns [] rather than throwing.
async function getEarnedTrophies(authorization, title) {
  let response;
  try {
    response = await getUserTrophiesEarnedForTitle(authorization, 'me', title.id, 'all', {
      npServiceName: title.serviceName,
    });
  } catch {
    return [];
  }

  const trophies = response?.trophies;
  if (!Array.isArray(trophies)) return [];

  return trophies
    .filter((t) => t.earned && t.earnedDateTime)
    .map((t) => ({ name: t.trophyName, unlockedAt: new Date(t.earnedDateTime).getTime() }))
    .filter((t) => Number.isFinite(t.unlockedAt));
}

module.exports = { authenticate, getTrophyTitles, getEarnedTrophies };
