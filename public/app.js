const state = {
  summary: null,
  activeTab: 'all',
  editingGameId: null,
  editingMetacriticUrl: null,
};

const heroStatsEl = document.getElementById('heroStats');
const yearChartEl = document.getElementById('yearChart');
const tabsEl = document.getElementById('tabs');
const sectionTitleEl = document.getElementById('sectionTitle');
const sectionStatsEl = document.getElementById('sectionStats');
const gameGridEl = document.getElementById('gameGrid');
const refreshBtn = document.getElementById('refreshBtn');
const uploadInput = document.getElementById('uploadInput');
const uploadStatusEl = document.getElementById('uploadStatus');
const sourceLineEl = document.getElementById('sourceLine');
const enrichBannerEl = document.getElementById('enrichBanner');
const enrichBannerTextEl = document.getElementById('enrichBannerText');
const userChipEl = document.getElementById('userChip');
const logoutBtn = document.getElementById('logoutBtn');
const addGameBtn = document.getElementById('addGameBtn');
const addGameOverlay = document.getElementById('addGameOverlay');
const addGameForm = document.getElementById('addGameForm');
const addGameError = document.getElementById('addGameError');
const addGameSubmit = document.getElementById('addGameSubmit');
const cancelAddGame = document.getElementById('cancelAddGame');
const gameModalTitle = document.getElementById('gameModalTitle');
const gameStatusSelect = document.getElementById('gameStatus');
const gameStartField = document.getElementById('gameStartField');
const gameEndField = document.getElementById('gameEndField');
const gameEndInput = document.getElementById('gameEnd');
const gameMetacriticUrlInput = document.getElementById('gameMetacriticUrl');
const pieCard = document.getElementById('pieCard');
const pieTitle = document.getElementById('pieTitle');
const pieSvg = document.getElementById('pieSvg');
const pieLegend = document.getElementById('pieLegend');
const shareBtn = document.getElementById('shareBtn');
const shareOverlay = document.getElementById('shareOverlay');
const shareListEl = document.getElementById('shareList');
const shareScopeSelect = document.getElementById('shareScopeSelect');
const createShareBtn = document.getElementById('createShareBtn');
const shareStatusEl = document.getElementById('shareStatus');
const closeShareModal = document.getElementById('closeShareModal');

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
let enrichPollTimer = null;

// Every /api/* route requires a session cookie; a 401 means it's missing or
// expired, so bounce to the login page rather than rendering a broken page.
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

function fmtHours(hours) {
  if (hours == null) return null;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded % 1 === 0 ? rounded : rounded.toFixed(1)}h`;
}

function fmtDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function loadSummary() {
  const res = await fetch('/api/summary');
  state.summary = await res.json();
  renderHeroStats();
  renderYearChart();
  renderTabs();
}

function renderHeroStats() {
  const { overall, years, undated, liveService, inProgress } = state.summary;
  const totalHours = overall.totalHours || 0;
  const yearsTracked = years.length;

  heroStatsEl.innerHTML = '';
  const tiles = [
    { value: overall.count || 0, label: 'Games completed' },
    { value: `${Math.round(totalHours).toLocaleString()}h`, label: 'Total hours (HLTB)' },
    { value: yearsTracked, label: 'Years tracked' },
    { value: inProgress.count || 0, label: 'Currently playing' },
    { value: undated.count || 0, label: 'Completed, date unknown' },
    { value: liveService.count || 0, label: 'Live service games' },
  ];

  for (const t of tiles) {
    const div = document.createElement('div');
    div.className = 'stat-tile';
    div.innerHTML = `<div class="value">${t.value}</div><div class="label">${t.label}</div>`;
    heroStatsEl.appendChild(div);
  }
}

function renderYearChart() {
  const years = [...state.summary.years].sort((a, b) => a.year - b.year);
  yearChartEl.innerHTML = '';

  if (years.length === 0) {
    yearChartEl.innerHTML = '<p class="empty-state">No dated completions yet.</p>';
    return;
  }

  const max = Math.max(...years.map((y) => y.count));
  const TRACK_HEIGHT_PX = 110;

  for (const y of years) {
    const wrap = document.createElement('div');
    wrap.className = 'year-bar-wrap';
    wrap.dataset.year = y.year;
    if (String(state.activeTab) === String(y.year)) wrap.classList.add('active');

    const heightPx = Math.max((y.count / max) * TRACK_HEIGHT_PX, 4);
    wrap.innerHTML = `
      <div class="year-bar-count">${y.count}</div>
      <div class="year-bar-track"><div class="year-bar" style="height:${heightPx}px"></div></div>
      <div class="year-bar-label">${y.year}</div>
    `;
    wrap.addEventListener('click', () => selectTab(String(y.year)));
    yearChartEl.appendChild(wrap);
  }
}

function renderTabs() {
  const years = [...state.summary.years].sort((a, b) => b.year - a.year);
  tabsEl.innerHTML = '';

  const defs = [
    { key: 'all', label: 'All Time' },
    ...years.map((y) => ({ key: String(y.year), label: String(y.year) })),
    { key: 'undated', label: 'Date Unknown' },
    { key: 'live_service', label: 'Live Service' },
    { key: 'in_progress', label: 'Currently Playing' },
  ];

  for (const d of defs) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (state.activeTab === d.key ? ' active' : '');
    btn.textContent = d.label;
    btn.addEventListener('click', () => selectTab(d.key));
    tabsEl.appendChild(btn);
  }
}

function selectTab(key) {
  state.activeTab = key;
  renderTabs();
  renderYearChart();
  loadGames(key);
}

async function loadGames(tabKey) {
  let url = '/api/games';
  let title = 'All Time';
  let statsText = '';

  if (tabKey === 'all') {
    url = '/api/games?status=completed';
    title = 'All Time';
  } else if (tabKey === 'undated') {
    url = '/api/games?year=undated';
    title = 'Completed — Date Unknown';
  } else if (tabKey === 'live_service') {
    url = '/api/games?status=live_service';
    title = 'Live Service';
  } else if (tabKey === 'in_progress') {
    url = '/api/games?status=in_progress';
    title = 'Currently Playing';
  } else {
    url = `/api/games?year=${tabKey}&status=completed`;
    title = tabKey;
  }

  const res = await fetch(url);
  const games = await res.json();

  sectionTitleEl.textContent = title;

  if (tabKey === 'live_service') {
    statsText = `${games.length} ongoing`;
  } else if (tabKey === 'in_progress') {
    statsText = `${games.length} in progress`;
  } else {
    const totalHours = games.reduce((sum, g) => sum + (g.hltb_hours || 0), 0);
    statsText = `${games.length} game${games.length === 1 ? '' : 's'} · ${Math.round(totalHours)}h total`;
  }
  sectionStatsEl.textContent = statsText;

  const isYearTab = /^\d{4}$/.test(tabKey);
  renderGameGrid(games, { groupByMonth: isYearTab });

  if (isYearTab) {
    renderPieChart(games, tabKey);
    pieCard.style.display = '';
  } else if (tabKey === 'all') {
    renderPieChart(games, 'All Time');
    pieCard.style.display = '';
  } else {
    pieCard.style.display = 'none';
  }
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function buildGameCard(g) {
  const card = document.createElement('div');
  card.className = 'game-card';

  let metaBadges = '';
  if (g.status === 'live_service') {
    metaBadges += '<span class="badge badge-live">Live Service</span>';
  } else if (g.status === 'in_progress') {
    metaBadges += '<span class="badge badge-progress">Playing</span>';
    if (g.hltb_hours != null) {
      metaBadges += `<span class="badge badge-hours">${fmtHours(g.hltb_hours)}</span>`;
    }
  } else {
    if (g.hltb_hours != null) {
      metaBadges += `<span class="badge badge-hours">${fmtHours(g.hltb_hours)}</span>`;
    }
    if (!g.date_completed) {
      metaBadges += '<span class="badge badge-undated">Date unknown</span>';
    }
  }

  let dateText = '';
  if (g.date_completed) {
    dateText = fmtDate(g.date_completed);
  } else if (g.status === 'in_progress' && g.date_started) {
    dateText = `Started ${fmtDate(g.date_started)}`;
  }

  // Cover + name are built as real DOM nodes (not innerHTML strings) so a
  // game name with quotes/HTML in it can never break out into markup.
  const placeholder = () => {
    const div = document.createElement('div');
    div.className = 'game-cover-placeholder';
    div.textContent = (g.name[0] || '?').toUpperCase();
    return div;
  };

  let cover;
  if (g.cover_url) {
    cover = document.createElement('img');
    cover.className = 'game-cover';
    cover.src = g.cover_url;
    cover.alt = '';
    cover.loading = 'lazy';
    cover.addEventListener('error', () => cover.replaceWith(placeholder()), { once: true });
  } else {
    cover = placeholder();
  }

  const nameEl = document.createElement(g.metacritic_url ? 'a' : 'span');
  nameEl.className = 'game-name';
  nameEl.textContent = g.name;
  if (g.metacritic_url) {
    nameEl.href = g.metacritic_url;
    nameEl.target = '_blank';
    nameEl.rel = 'noopener noreferrer';
  }

  const body = document.createElement('div');
  body.className = 'game-body';
  body.appendChild(nameEl);

  const metaRow = document.createElement('div');
  metaRow.className = 'game-meta';
  metaRow.innerHTML = `<span>${dateText}</span><span>${metaBadges}</span>`;
  body.appendChild(metaRow);

  const editBtn = document.createElement('button');
  editBtn.className = 'edit-btn';
  editBtn.type = 'button';
  editBtn.title = 'Edit this game';
  editBtn.textContent = '✎';
  editBtn.addEventListener('click', () => openEditGameModal(g));
  body.appendChild(editBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.type = 'button';
  deleteBtn.title = 'Remove this game';
  deleteBtn.textContent = '✕';
  deleteBtn.addEventListener('click', () => deleteGame(g.id));
  body.appendChild(deleteBtn);

  card.appendChild(cover);
  card.appendChild(body);
  return card;
}

function buildGameGridEl(games) {
  const grid = document.createElement('div');
  grid.className = 'game-grid';
  for (const g of games) grid.appendChild(buildGameCard(g));
  return grid;
}

function renderGameGrid(games, { groupByMonth = false } = {}) {
  gameGridEl.innerHTML = '';

  if (games.length === 0) {
    gameGridEl.innerHTML = '<div class="empty-state">Nothing here yet.</div>';
    return;
  }

  if (!groupByMonth) {
    gameGridEl.appendChild(buildGameGridEl(games));
    return;
  }

  // Months with nothing that month are simply skipped, same as the Timeline
  // page — a sparse year shouldn't render empty headers.
  const byMonth = new Map();
  for (const g of games) {
    const dateKey = g.date_completed || g.date_started;
    if (!dateKey) continue;
    const monthIdx = Number(dateKey.split('-')[1]) - 1;
    if (!byMonth.has(monthIdx)) byMonth.set(monthIdx, []);
    byMonth.get(monthIdx).push(g);
  }

  const sortedMonths = [...byMonth.keys()].sort((a, b) => b - a);
  for (const monthIdx of sortedMonths) {
    const monthGames = byMonth.get(monthIdx);
    const group = document.createElement('div');
    group.className = 'month-group';
    group.innerHTML = `
      <div class="month-group-header">
        <span class="month-group-name">${MONTH_NAMES[monthIdx]}</span>
        <span class="month-group-count">${monthGames.length} game${monthGames.length === 1 ? '' : 's'}</span>
      </div>
    `;
    group.appendChild(buildGameGridEl(monthGames));
    gameGridEl.appendChild(group);
  }
}

async function deleteGame(id) {
  if (!window.confirm('Remove this game from your list?')) return;
  const res = await fetch(`/api/games/${id}`, { method: 'DELETE' });
  if (!res.ok) return;
  await loadSummary();
  await loadGames(state.activeTab);
}

// --- Hours-by-game pie chart (dataviz: fixed categorical order, "Other"
// bucket past 7 slices, legend always present, native <title> for hover). ---
const PIE_COLORS = ['--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6', '--cat-7', '--cat-8'];
const PIE_MAX_SLICES = 7;

function renderPieChart(games, label) {
  pieTitle.textContent = `Hours by game — ${label}`;

  // Aggregate by name — a replayed game (e.g. completed once in 2024, again
  // in 2026) should count as one slice with combined hours, not compete
  // against itself, especially in the All Time view where that's common.
  const byName = new Map();
  for (const g of games) {
    if (g.hltb_hours == null || g.hltb_hours <= 0) continue;
    byName.set(g.name, (byName.get(g.name) || 0) + g.hltb_hours);
  }

  const withHours = [...byName.entries()]
    .map(([name, hltb_hours]) => ({ name, hltb_hours }))
    .sort((a, b) => b.hltb_hours - a.hltb_hours);

  if (withHours.length === 0) {
    pieSvg.innerHTML = '';
    pieLegend.innerHTML = '<p class="empty-state">No games with known hours this year.</p>';
    return;
  }

  const top = withHours.slice(0, PIE_MAX_SLICES);
  const rest = withHours.slice(PIE_MAX_SLICES);
  const restHours = rest.reduce((sum, g) => sum + g.hltb_hours, 0);

  const slices = top.map((g, i) => ({
    name: g.name,
    hours: g.hltb_hours,
    color: `var(${PIE_COLORS[i]})`,
  }));
  if (restHours > 0) {
    slices.push({ name: `Other (${rest.length})`, hours: restHours, color: 'var(--cat-other)' });
  }

  const total = slices.reduce((sum, s) => sum + s.hours, 0);
  const cx = 100;
  const cy = 100;
  const r = 80;
  const innerR = 48; // donut hole

  let angle = -90; // start at 12 o'clock
  const paths = [];
  for (const s of slices) {
    const fraction = s.hours / total;
    const sweep = fraction * 360;
    const startAngle = angle;
    const endAngle = angle + sweep;
    paths.push(donutSlicePath(cx, cy, r, innerR, startAngle, endAngle, s));
    angle = endAngle;
  }

  pieSvg.innerHTML = paths.join('');
  pieLegend.innerHTML = '';
  for (const s of slices) {
    const row = document.createElement('div');
    row.className = 'pie-legend-row';
    row.innerHTML = `
      <span class="pie-swatch" style="background:${s.color}"></span>
      <span class="pie-legend-name"></span>
      <span class="pie-legend-hours">${fmtHours(s.hours)}</span>
    `;
    row.querySelector('.pie-legend-name').textContent = s.name;
    pieLegend.appendChild(row);
  }
}

function donutSlicePath(cx, cy, r, innerR, startAngle, endAngle, slice) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  const x1 = cx + r * Math.cos(toRad(startAngle));
  const y1 = cy + r * Math.sin(toRad(startAngle));
  const x2 = cx + r * Math.cos(toRad(endAngle));
  const y2 = cy + r * Math.sin(toRad(endAngle));

  const ix1 = cx + innerR * Math.cos(toRad(endAngle));
  const iy1 = cy + innerR * Math.sin(toRad(endAngle));
  const ix2 = cx + innerR * Math.cos(toRad(startAngle));
  const iy2 = cy + innerR * Math.sin(toRad(startAngle));

  const d = [
    `M ${x1} ${y1}`,
    `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
    `L ${ix1} ${iy1}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2} ${iy2}`,
    'Z',
  ].join(' ');

  const title = `${escapeXml(slice.name)}: ${fmtHours(slice.hours)}`;
  return `<path class="pie-slice" d="${d}" fill="${slice.color}"><title>${title}</title></path>`;
}

function escapeXml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// --- Add / Edit Game modal ---

function updateModalFieldVisibility() {
  const status = gameStatusSelect.value;
  gameStartField.style.display = status === 'live_service' ? 'none' : '';
  gameEndField.style.display = status === 'completed' ? '' : 'none';
  gameEndInput.required = status === 'completed';
}

function openAddGameModal() {
  state.editingGameId = null;
  addGameForm.reset();
  gameModalTitle.textContent = 'Add a game';
  addGameSubmit.textContent = 'Add game';
  updateModalFieldVisibility();
  addGameError.classList.remove('visible');
  addGameOverlay.classList.add('visible');
  document.getElementById('gameName').focus();
}

function openEditGameModal(g) {
  state.editingGameId = g.id;
  addGameForm.reset();
  gameModalTitle.textContent = 'Edit game';
  addGameSubmit.textContent = 'Save changes';

  document.getElementById('gameName').value = g.name;
  gameStatusSelect.value = g.status;
  document.getElementById('gameStart').value = g.date_started || '';
  gameEndInput.value = g.date_completed || '';
  document.getElementById('gameHours').value = g.hltb_hours ?? '';
  gameMetacriticUrlInput.value = g.metacritic_url || '';

  updateModalFieldVisibility();
  addGameError.classList.remove('visible');
  addGameOverlay.classList.add('visible');
  document.getElementById('gameName').focus();
}

function closeAddGameModal() {
  addGameOverlay.classList.remove('visible');
}

addGameBtn.addEventListener('click', openAddGameModal);
cancelAddGame.addEventListener('click', closeAddGameModal);
addGameOverlay.addEventListener('click', (e) => {
  if (e.target === addGameOverlay) closeAddGameModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && addGameOverlay.classList.contains('visible')) closeAddGameModal();
});

gameStatusSelect.addEventListener('change', updateModalFieldVisibility);

addGameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  addGameError.classList.remove('visible');
  addGameSubmit.disabled = true;

  try {
    const status = gameStatusSelect.value;
    const payload = {
      name: document.getElementById('gameName').value.trim(),
      status,
      dateStarted: status === 'live_service' ? null : (document.getElementById('gameStart').value || null),
      dateCompleted: status === 'completed' ? (gameEndInput.value || null) : null,
      hltbHours: document.getElementById('gameHours').value || null,
    };

    const isEdit = state.editingGameId != null;
    const res = await fetch(isEdit ? `/api/games/${state.editingGameId}` : '/api/games', {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json();

    if (!res.ok || !result.ok) {
      addGameError.textContent = result.error || 'Could not save game.';
      addGameError.classList.add('visible');
      return;
    }

    const gameId = isEdit ? state.editingGameId : result.id;
    const metacriticUrl = gameMetacriticUrlInput.value.trim();
    if (metacriticUrl) {
      const overrideRes = await fetch(`/api/games/${gameId}/metacritic-override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metacriticUrl }),
      });
      const overrideResult = await overrideRes.json();
      if (!overrideRes.ok || !overrideResult.ok) {
        addGameError.textContent = overrideResult.error || 'Game saved, but the Metacritic URL could not be verified.';
        addGameError.classList.add('visible');
        await loadSummary();
        await loadGames(state.activeTab);
        return;
      }
    }

    closeAddGameModal();
    await loadSummary();
    await loadGames(state.activeTab);
    pollEnrichment();
  } catch {
    addGameError.textContent = 'Something went wrong — check your connection and try again.';
    addGameError.classList.add('visible');
  } finally {
    addGameSubmit.disabled = false;
  }
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('loading');
  refreshBtn.disabled = true;
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await loadSummary();
    await loadGames(state.activeTab);
    await loadSource();
    pollEnrichment();
  } finally {
    refreshBtn.classList.remove('loading');
    refreshBtn.disabled = false;
  }
});

function setUploadStatus(message, kind) {
  uploadStatusEl.textContent = message || '';
  uploadStatusEl.className = 'upload-status' + (kind ? ` ${kind}` : '');
}

async function loadSource() {
  try {
    const res = await fetch('/api/source');
    const info = await res.json();
    sourceLineEl.textContent = info.kind === 'upload'
      ? `Source: uploaded file "${info.displayName}" (${info.gameCount} games, ${new Date(info.uploadedAt).toLocaleString()})`
      : `Source: ${info.displayName}`;
  } catch {
    sourceLineEl.textContent = '';
  }
}

uploadInput.addEventListener('change', async () => {
  const file = uploadInput.files[0];
  if (!file) return;

  const label = document.querySelector('.btn-upload');

  // Client-side checks are UX only — the server re-validates everything
  // (extension, size, and the actual file content) before touching disk or the DB.
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!['.md', '.markdown', '.txt'].includes(ext)) {
    setUploadStatus('Only .md, .markdown, or .txt files are accepted.', 'error');
    uploadInput.value = '';
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    setUploadStatus(`File is too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB).`, 'error');
    uploadInput.value = '';
    return;
  }

  label.classList.add('loading');
  setUploadStatus('Uploading…');

  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const result = await res.json();

    if (!res.ok || !result.ok) {
      setUploadStatus(result.error || 'Upload failed.', 'error');
      return;
    }

    setUploadStatus(`Loaded ${result.count} games from "${result.displayName}".`, 'success');
    await loadSummary();
    await loadGames('all');
    await loadSource();
    pollEnrichment();
  } catch {
    setUploadStatus('Upload failed — check your connection and try again.', 'error');
  } finally {
    label.classList.remove('loading');
    uploadInput.value = '';
  }
});

async function pollEnrichment() {
  clearTimeout(enrichPollTimer);

  let status;
  try {
    status = await (await fetch('/api/enrich-metacritic/status')).json();
  } catch {
    return;
  }

  if (status.running) {
    enrichBannerEl.classList.add('visible');
    enrichBannerTextEl.textContent = `Fetching Metacritic covers & links… (${status.processed}/${status.total})`;
    enrichPollTimer = setTimeout(pollEnrichment, 2000);
  } else if (enrichBannerEl.classList.contains('visible')) {
    // Just finished — refresh the currently visible games so new covers/links show up.
    enrichBannerEl.classList.remove('visible');
    await loadGames(state.activeTab);
  }
}

// --- Share link modal (supports multiple links: whole library + one per year) ---

function scopeLabel(year) {
  return year == null ? 'Whole library' : String(year);
}

async function copyShareLink(url, statusEl) {
  try {
    await navigator.clipboard.writeText(url);
    statusEl.textContent = 'Copied!';
  } catch {
    statusEl.textContent = url;
  }
}

function renderShareList(shares) {
  shareListEl.innerHTML = '';

  if (shares.length === 0) {
    shareListEl.innerHTML = '<p class="auth-hint" style="margin-bottom:16px">No share links yet.</p>';
  }

  for (const share of shares) {
    const row = document.createElement('div');
    row.className = 'share-row';
    row.innerHTML = `
      <div class="share-row-top">
        <span class="share-row-scope">${scopeLabel(share.year)}</span>
      </div>
      <input type="text" readonly value="${share.url}" />
      <p class="auth-hint" style="margin:0 0 8px"></p>
      <div class="share-row-actions">
        <button type="button" class="btn-refresh" data-action="copy">Copy</button>
        <button type="button" class="btn-refresh" data-action="regenerate">Regenerate</button>
        <button type="button" class="btn-refresh" data-action="disable">Turn off</button>
      </div>
    `;

    const rowStatus = row.querySelector('.auth-hint');
    row.querySelector('[data-action="copy"]').addEventListener('click', () => {
      copyShareLink(share.url, rowStatus);
    });
    row.querySelector('[data-action="regenerate"]').addEventListener('click', async () => {
      if (!window.confirm('The old link will stop working immediately. Continue?')) return;
      await fetch(`/api/share/${share.token}/regenerate`, { method: 'POST' });
      await refreshShareList();
    });
    row.querySelector('[data-action="disable"]').addEventListener('click', async () => {
      if (!window.confirm('Turn off this link? It will stop working immediately.')) return;
      await fetch(`/api/share/${share.token}`, { method: 'DELETE' });
      await refreshShareList();
    });

    shareListEl.appendChild(row);
  }
}

function populateShareScopeOptions() {
  const years = state.summary ? state.summary.years.map((y) => y.year).sort((a, b) => b - a) : [];
  shareScopeSelect.innerHTML = '<option value="">Whole library</option>'
    + years.map((y) => `<option value="${y}">${y}</option>`).join('');
}

async function refreshShareList() {
  const shares = await (await fetch('/api/share')).json();
  renderShareList(shares);
}

async function openShareModal() {
  shareStatusEl.textContent = '';
  populateShareScopeOptions();
  shareOverlay.classList.add('visible');
  await refreshShareList();
}

shareBtn.addEventListener('click', openShareModal);
closeShareModal.addEventListener('click', () => shareOverlay.classList.remove('visible'));
shareOverlay.addEventListener('click', (e) => {
  if (e.target === shareOverlay) shareOverlay.classList.remove('visible');
});

createShareBtn.addEventListener('click', async () => {
  const raw = shareScopeSelect.value;
  const year = raw === '' ? null : Number(raw);
  const res = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year }),
  });
  if (!res.ok) {
    shareStatusEl.textContent = 'Could not create that link.';
    return;
  }
  shareStatusEl.textContent = '';
  await refreshShareList();
});

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;

  await loadSummary();
  await loadGames('all');
  await loadSource();
  pollEnrichment();
})();
