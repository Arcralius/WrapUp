// Read-only view backed by /api/shared/:token/* — a completely separate,
// unauthenticated route tree on the server with no write endpoints at all.
// This script never calls fetch() with a method other than the default GET.

const TOKEN = new URLSearchParams(window.location.search).get('token');

const state = {
  summary: null,
  activeTab: 'all',
  scopedYear: null,
};

const taglineEl = document.getElementById('tagline');
const sharedContentEl = document.getElementById('sharedContent');
const sharedErrorEl = document.getElementById('sharedError');
const heroStatsEl = document.getElementById('heroStats');
const yearChartEl = document.getElementById('yearChart');
const tabsEl = document.getElementById('tabs');
const sectionTitleEl = document.getElementById('sectionTitle');
const sectionStatsEl = document.getElementById('sectionStats');
const gameGridEl = document.getElementById('gameGrid');
const pieCard = document.getElementById('pieCard');
const pieTitle = document.getElementById('pieTitle');
const pieSvg = document.getElementById('pieSvg');
const pieLegend = document.getElementById('pieLegend');

function showError(message) {
  sharedContentEl.style.display = 'none';
  sharedErrorEl.textContent = message;
  sharedErrorEl.style.display = 'block';
}

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
  const res = await fetch(`/api/shared/${TOKEN}/summary`);
  if (!res.ok) throw new Error('not found');
  state.summary = await res.json();
  renderHeroStats();
  renderYearChart();
  renderTabs();
}

function renderHeroStats() {
  const { overall, years, undated, liveService, inProgress } = state.summary;
  const totalHours = overall.totalHours || 0;

  heroStatsEl.innerHTML = '';
  const tiles = [
    { value: overall.count || 0, label: 'Games completed' },
    { value: `${Math.round(totalHours).toLocaleString()}h`, label: 'Total hours (HLTB)' },
    { value: years.length, label: 'Years tracked' },
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
  let url;
  let title;

  if (tabKey === 'all') {
    url = `/api/shared/${TOKEN}/games?status=completed`;
    title = 'All Time';
  } else if (tabKey === 'undated') {
    url = `/api/shared/${TOKEN}/games?year=undated`;
    title = 'Completed — Date Unknown';
  } else if (tabKey === 'live_service') {
    url = `/api/shared/${TOKEN}/games?status=live_service`;
    title = 'Live Service';
  } else if (tabKey === 'in_progress') {
    url = `/api/shared/${TOKEN}/games?status=in_progress`;
    title = 'Currently Playing';
  } else {
    url = `/api/shared/${TOKEN}/games?year=${tabKey}&status=completed`;
    title = tabKey;
  }

  const res = await fetch(url);
  const games = await res.json();

  sectionTitleEl.textContent = title;

  let statsText;
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
  } else if (g.date_started) {
    dateText = `Started ${fmtDate(g.date_started)}`;
  }

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

// --- Hours-by-game pie chart (same categorical palette + rules as the dashboard) ---
const PIE_COLORS = ['--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6', '--cat-7', '--cat-8'];
const PIE_MAX_SLICES = 7;

function renderPieChart(games, label) {
  pieTitle.textContent = `Hours by game — ${label}`;

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
  const innerR = 48;

  let angle = -90;
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

// A year-scoped link only ever shows that one year — no tabs, no
// multi-year chart, no undated/live-service/in-progress sections, since a
// year-scoped share must not reveal anything about the rest of the library.
async function loadScopedYear(year) {
  document.querySelector('.chart-card').style.display = 'none'; // the multi-year bar chart
  tabsEl.style.display = 'none';

  const summaryRes = await fetch(`/api/shared/${TOKEN}/summary`);
  const summary = await summaryRes.json();

  heroStatsEl.innerHTML = '';
  const tiles = [
    { value: summary.completed.count || 0, label: 'Games completed' },
    { value: `${Math.round(summary.completed.totalHours || 0).toLocaleString()}h`, label: 'Total hours (HLTB)' },
  ];
  for (const t of tiles) {
    const div = document.createElement('div');
    div.className = 'stat-tile';
    div.innerHTML = `<div class="value">${t.value}</div><div class="label">${t.label}</div>`;
    heroStatsEl.appendChild(div);
  }

  sectionTitleEl.textContent = String(year);

  const gamesRes = await fetch(`/api/shared/${TOKEN}/games?year=${year}&status=completed`);
  const games = await gamesRes.json();
  const totalHours = games.reduce((sum, g) => sum + (g.hltb_hours || 0), 0);
  sectionStatsEl.textContent = `${games.length} game${games.length === 1 ? '' : 's'} · ${Math.round(totalHours)}h total`;

  renderGameGrid(games, { groupByMonth: true });
  renderPieChart(games, String(year));
  pieCard.style.display = '';
}

(async function init() {
  if (!TOKEN) {
    showError('No share link token provided.');
    return;
  }

  try {
    const profileRes = await fetch(`/api/shared/${TOKEN}/profile`);
    if (!profileRes.ok) throw new Error('not found');
    const { username, year } = await profileRes.json();
    state.scopedYear = year;

    if (year != null) {
      taglineEl.textContent = `${username}'s ${year} in review`;
      await loadScopedYear(year);
    } else {
      taglineEl.textContent = `${username}'s gaming library`;
      await loadSummary();
      await loadGames('all');
    }
    sharedContentEl.style.display = '';
  } catch {
    showError('This share link is invalid or has been turned off.');
  }
})();
