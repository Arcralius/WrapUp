const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const state = {
  years: [],
  selectedYear: null,
};

const yearListEl = document.getElementById('yearList');
const tlMonthsEl = document.getElementById('tlMonths');
const tlEmptyEl = document.getElementById('tlEmpty');
const userChipEl = document.getElementById('userChip');
const logoutBtn = document.getElementById('logoutBtn');

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

function fmtDay(iso) {
  const [, , d] = iso.split('-');
  return Number(d);
}

async function loadYears() {
  const [summaryRes, inProgressRes] = await Promise.all([
    fetch('/api/summary'),
    fetch('/api/games?status=in_progress'),
  ]);
  const summary = await summaryRes.json();
  const inProgress = await inProgressRes.json();

  const years = new Set(summary.years.map((y) => y.year));
  for (const g of inProgress) {
    if (g.date_started) years.add(Number(g.date_started.slice(0, 4)));
  }
  state.years = [...years].sort((a, b) => b - a);
}

function renderYearSidebar() {
  yearListEl.innerHTML = '';
  for (const year of state.years) {
    const btn = document.createElement('button');
    btn.className = 'tl-year-btn' + (year === state.selectedYear ? ' active' : '');
    btn.textContent = year;
    btn.addEventListener('click', () => selectYear(year));
    yearListEl.appendChild(btn);
  }
}

function selectYear(year) {
  state.selectedYear = year;
  renderYearSidebar();
  loadTimeline(year);
}

let observer = null;

function setupScrollReveal() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );
  document.querySelectorAll('.tl-month').forEach((el) => observer.observe(el));
}

function buildCard(g) {
  const card = document.createElement('div');
  card.className = 'tl-card';

  const placeholder = () => {
    const div = document.createElement('div');
    div.className = 'tl-cover-placeholder';
    div.textContent = (g.name[0] || '?').toUpperCase();
    return div;
  };

  let cover;
  if (g.cover_url) {
    cover = document.createElement('img');
    cover.className = 'tl-cover';
    cover.src = g.cover_url;
    cover.alt = '';
    cover.loading = 'lazy';
    cover.addEventListener('error', () => cover.replaceWith(placeholder()), { once: true });
  } else {
    cover = placeholder();
  }

  const nameEl = document.createElement(g.metacritic_url ? 'a' : 'span');
  nameEl.className = 'tl-card-name';
  nameEl.textContent = g.name;
  if (g.metacritic_url) {
    nameEl.href = g.metacritic_url;
    nameEl.target = '_blank';
    nameEl.rel = 'noopener noreferrer';
  }

  const isInProgress = g.status === 'in_progress';
  const dayLabel = isInProgress ? `Started ${fmtDay(g.date_started)}` : `Day ${fmtDay(g.date_completed)}`;
  const secondaryLabel = isInProgress ? 'Playing' : (g.hltb_hours != null ? fmtHours(g.hltb_hours) : '');

  const meta = document.createElement('div');
  meta.className = 'tl-card-meta';
  meta.innerHTML = `<span>${dayLabel}</span><span>${secondaryLabel}</span>`;

  const body = document.createElement('div');
  body.className = 'tl-card-body';
  body.appendChild(nameEl);
  body.appendChild(meta);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.type = 'button';
  deleteBtn.title = 'Remove this game';
  deleteBtn.textContent = '✕';
  deleteBtn.addEventListener('click', async () => {
    if (!window.confirm('Remove this game from your list?')) return;
    const res = await fetch(`/api/games/${g.id}`, { method: 'DELETE' });
    if (res.ok) await loadTimeline(state.selectedYear);
  });

  card.appendChild(cover);
  card.appendChild(body);
  card.appendChild(deleteBtn);

  const playCount = g.play_count || 1;
  if (playCount > 1) {
    const replay = document.createElement('span');
    replay.className = 'replay-badge';
    replay.textContent = `↺ ×${playCount}`;
    replay.title = `Played ${playCount} times`;
    card.appendChild(replay);
  }

  return card;
}

async function loadTimeline(year) {
  const [completedRes, inProgressRes] = await Promise.all([
    fetch(`/api/games?year=${year}&status=completed`),
    fetch('/api/games?status=in_progress'),
  ]);
  const completed = (await completedRes.json()).filter((g) => g.date_completed);
  const inProgress = (await inProgressRes.json())
    .filter((g) => g.date_started && Number(g.date_started.slice(0, 4)) === year);

  tlMonthsEl.innerHTML = '';

  if (completed.length === 0 && inProgress.length === 0) {
    tlEmptyEl.style.display = 'block';
    return;
  }
  tlEmptyEl.style.display = 'none';

  // Placed by completion month for finished games, by start month for ones
  // still being played — a currently-playing game has no end date yet, but
  // it still belongs on the timeline at the point it entered the picture.
  const byMonth = new Map();
  for (const g of completed) {
    const monthIdx = Number(g.date_completed.split('-')[1]) - 1;
    if (!byMonth.has(monthIdx)) byMonth.set(monthIdx, []);
    byMonth.get(monthIdx).push(g);
  }
  for (const g of inProgress) {
    const monthIdx = Number(g.date_started.split('-')[1]) - 1;
    if (!byMonth.has(monthIdx)) byMonth.set(monthIdx, []);
    byMonth.get(monthIdx).push(g);
  }

  const now = new Date();
  const isCurrentYear = year === now.getFullYear();
  const currentMonthIdx = now.getMonth();

  // Chronological, and months with nothing completed are simply never
  // rendered — a "timeline" implies motion through the year, not 12 evenly
  // spaced slots including dead air.
  const sortedMonths = [...byMonth.keys()].sort((a, b) => a - b);

  let scrollTarget = null;

  for (const monthIdx of sortedMonths) {
    const section = document.createElement('section');
    section.className = 'tl-month';
    if (isCurrentYear && monthIdx === currentMonthIdx) {
      section.classList.add('current');
      scrollTarget = section;
    }

    const sortKey = (g) => g.date_completed || g.date_started;
    const monthGames = byMonth.get(monthIdx).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const completedCount = monthGames.filter((g) => g.status === 'completed').length;
    const playingCount = monthGames.length - completedCount;
    const countLabel = playingCount > 0
      ? `${completedCount} completed, ${playingCount} started`
      : `${completedCount} completed`;

    const header = document.createElement('div');
    header.className = 'tl-month-header';
    header.innerHTML = `
      <span class="tl-month-name">${MONTH_NAMES[monthIdx]} ${year}</span>
      <span class="tl-month-count">${countLabel}</span>
    `;

    const grid = document.createElement('div');
    grid.className = 'tl-month-grid';
    for (const g of monthGames) grid.appendChild(buildCard(g));

    section.appendChild(header);
    section.appendChild(grid);
    tlMonthsEl.appendChild(section);
  }

  // If this is the current year, aim for the current month; if that month
  // had nothing completed, fall back to the most recent populated month
  // before it so the page still opens on "where you left off."
  if (isCurrentYear && !scrollTarget) {
    const priorMonths = sortedMonths.filter((m) => m <= currentMonthIdx);
    const fallbackIdx = priorMonths.length ? priorMonths[priorMonths.length - 1] : sortedMonths[sortedMonths.length - 1];
    scrollTarget = tlMonthsEl.children[sortedMonths.indexOf(fallbackIdx)];
  }

  setupScrollReveal();

  if (scrollTarget) {
    // Reveal immediately rather than waiting on the scroll observer, since
    // we're about to jump straight to it.
    requestAnimationFrame(() => {
      scrollTarget.classList.add('visible');
      scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;

  await loadYears();

  const now = new Date();
  state.selectedYear = state.years.includes(now.getFullYear()) ? now.getFullYear() : state.years[0] || now.getFullYear();

  renderYearSidebar();
  if (state.years.length === 0) {
    tlEmptyEl.textContent = 'No completed games with a known date yet.';
    tlEmptyEl.style.display = 'block';
    return;
  }
  await loadTimeline(state.selectedYear);
})();
