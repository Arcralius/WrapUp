// Profile page: save the third-party credentials and kick off the syncs.
//
// Credentials are write-only from here — the server never sends them back, so
// a field that's already configured shows a "saved" placeholder rather than
// the value. Leaving a field untouched keeps whatever is stored; clearing it
// (typing nothing after it was set) is handled by the explicit Clear buttons.

const userChipEl = document.getElementById('userChip');
const logoutBtn = document.getElementById('logoutBtn');
const saveStatusEl = document.getElementById('saveStatus');
const syncBanner = document.getElementById('syncBanner');
const syncBannerText = document.getElementById('syncBannerText');

const steamApiKeyEl = document.getElementById('steamApiKey');
const steamIdEl = document.getElementById('steamId');
const psnNpssoEl = document.getElementById('psnNpsso');
const igdbClientIdEl = document.getElementById('igdbClientId');
const igdbClientSecretEl = document.getElementById('igdbClientSecret');

let syncPollTimer = null;

async function requireAuthOrRedirect() {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    window.location.href = 'login.html';
    return null;
  }
  const { user } = await res.json();
  userChipEl.textContent = user.username;
  userChipEl.dataset.initial = user.username[0] || '?';
  return user;
}

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = 'login.html';
});

const navToggle = document.getElementById('navToggle');
const topbarActions = document.getElementById('topbarActions');
if (navToggle && topbarActions) {
  navToggle.addEventListener('click', () => {
    const open = topbarActions.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(open));
  });
}

function setStatus(message, kind) {
  saveStatusEl.textContent = message || '';
  saveStatusEl.className = 'upload-status' + (kind ? ` ${kind}` : '');
}

async function loadSettings() {
  const s = await (await fetch('/api/settings')).json();
  steamIdEl.value = s.steamId || '';
  // Secrets are never returned; just signal whether one is stored.
  steamApiKeyEl.placeholder = s.steamApiKeySet ? '•••••••• saved (type to replace)' : 'Not set';
  psnNpssoEl.placeholder = s.psnNpssoSet ? '•••••••• saved (type to replace)' : 'Not set';
  igdbClientIdEl.placeholder = s.igdbSet ? '•••••••• saved (type to replace)' : 'Not set';
  igdbClientSecretEl.placeholder = s.igdbSet ? '•••••••• saved (type to replace)' : 'Not set';
}

// Only sends the fields the user actually typed into — an untouched (empty)
// secret field is omitted so the stored value survives.
async function saveFields(fields) {
  const payload = {};
  for (const [key, el] of Object.entries(fields)) {
    const value = el.value.trim();
    if (el.type === 'password') {
      if (value !== '') payload[key] = value;   // omitted = keep what's stored
    } else {
      payload[key] = value;                      // plain fields always sent
    }
  }

  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await res.json();
  if (!res.ok || !result.ok) {
    setStatus(result.error || 'Could not save.', 'error');
    return;
  }
  // Clear the secret inputs so the raw values don't linger in the DOM.
  for (const el of Object.values(fields)) {
    if (el.type === 'password') el.value = '';
  }
  setStatus('Saved.', 'success');
  await loadSettings();
}

document.getElementById('steamForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveFields({ steamApiKey: steamApiKeyEl, steamId: steamIdEl });
});

document.getElementById('psnForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveFields({ psnNpsso: psnNpssoEl });
});

document.getElementById('igdbForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveFields({ igdbClientId: igdbClientIdEl, igdbClientSecret: igdbClientSecretEl });
});

const PROVIDER_LABEL = { steam: 'Steam achievements', psn: 'PSN trophies', igdb: 'IGDB completion times' };

for (const btn of document.querySelectorAll('[data-sync]')) {
  btn.addEventListener('click', async () => {
    const provider = btn.dataset.sync;
    setStatus('');
    const res = await fetch(`/api/sync/${provider}`, { method: 'POST' });
    const result = await res.json();
    if (!res.ok || !result.ok) {
      setStatus(result.error || 'Could not start the sync.', 'error');
      return;
    }
    pollSync();
  });
}

async function pollSync() {
  clearTimeout(syncPollTimer);

  let status;
  try {
    status = await (await fetch('/api/sync/status')).json();
  } catch {
    return;
  }

  const label = PROVIDER_LABEL[status.provider] || 'Sync';

  if (status.running) {
    syncBanner.classList.add('visible');
    syncBannerText.textContent = `${label}: ${status.processed}/${status.total} checked, ${status.updated} updated…`;
    syncPollTimer = setTimeout(pollSync, 2000);
  } else {
    syncBanner.classList.remove('visible');
    if (status.finishedAt) {
      const parts = [`${label} finished — ${status.updated} game${status.updated === 1 ? '' : 's'} updated`];
      if (status.skipped) parts.push(`${status.skipped} with nothing to fill in`);
      setStatus(parts.join(', ') + '.', status.lastError ? 'error' : 'success');
      if (status.lastError) {
        setStatus(`${parts.join(', ')}. Last error: ${status.lastError}`, 'error');
      }
    }
  }
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  await loadSettings();
  pollSync();
})();
