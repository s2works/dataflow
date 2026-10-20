import nfl from './sports/nfl.js';
import { buildModel, edgeColor, rankColor, ordinal } from './engine.js';
import { buildProjector, fetchForecasts, weatherLabel } from './projections.js';
import { overProb, fairOver, impliedProb, poissonAtLeast, medianOutcome, outcomeQuantile, nbAtLeast } from './props.js';
import { buildQ1, Q1_STATS } from './q1.js';
import { ANGLES, anglesFor, boomBust, angleEffect } from './boombust.js';
import { buildFirstTd } from './firsttd.js';

const ANGLE_LABELS = Object.fromEntries(ANGLES.map((a) => [a.id, a.label]));

const SPORTS = { nfl };
const sport = SPORTS.nfl;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));
const signed = (v) => (v == null ? '–' : v > 0 ? `+${v}` : `${v}`);
const POST_LABELS = { WC: 'Wild Card', DIV: 'Divisional', CON: 'Conference', SB: 'Super Bowl' };

const state = {
  season: null,
  week: null,
  lastN: 0,
  tab: 'matchups',
  game: null,
  pos: 'ALL',
  showAll: false,
  search: '',
  dvpMetric: 'fpts',
  rankSide: 'off',
  sort: {},
  expanded: null,
  tdView: 'any',
  projView: 'proj',
};
let data = null;
let model = null;
let projector = null;
let history = [];
const cache = new Map();
const forecasts = new Map(); // game_id -> forecast (fetched in the browser)
const REFRESH_MS = 5 * 60e3; // how often to check for new data
const WEATHER_MS = 60 * 60e3; // how often to refetch forecasts
let indexUpdated = {};
let propDist = null; // outcome distributions for P(over a line)
let boomFit = null; // boom/bust distributions, calibration and angle records
let lastCheck = null;
let forecastsAt = 0;

// ---------------------------------------------------------------- boot ----
async function boot() {
  const index = await fetchJSON(`${sport.dataPath}/index.json`);
  indexUpdated = index.updated ?? {};
  lastCheck = new Date();
  propDist = (await fetchJSON(`${sport.dataPath}/prop_dist.json`).catch(() => null))?.stats ?? null;
  boomFit = await fetchJSON(`${sport.dataPath}/boombust.json`).catch(() => null);
  const seasonSel = $('#season');
  seasonSel.innerHTML = index.seasons.map((s) => `<option>${s}</option>`).join('');
  state.season = index.seasons[0];
  seasonSel.onchange = () => loadSeason(+seasonSel.value);
  $('#week').onchange = (e) => {
    state.week = +e.target.value;
    state.game = null;
    if (location.hash.includes('/')) history.replaceState(null, '', '#matchups');
    recompute();
  };
  $('#window').onchange = (e) => { state.lastN = +e.target.value; recompute(); };
  window.addEventListener('hashchange', readHash);
  readHash(false);
  await loadSeason(state.season);
  setInterval(checkForUpdates, REFRESH_MS);
  setInterval(renderMeta, 30e3);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > 60e3) checkForUpdates();
  });
}

// Auto-refresh: the scheduled pipeline bumps index.json when data changes.
async function checkForUpdates() {
  try {
    const index = await fetchJSON(`${sport.dataPath}/index.json`);
    lastCheck = new Date();
    const changed = [state.season, state.season - 1].filter((s) => index.updated?.[s] && index.updated[s] !== indexUpdated[s]);
    indexUpdated = index.updated ?? {};
    for (const s of changed) cache.delete(s);
    const staleWeather = Date.now() - forecastsAt > WEATHER_MS;
    if (staleWeather) forecasts.clear();
    if (changed.length) await loadSeason(state.season, { keepWeek: true });
    else if (staleWeather) recompute();
    else renderMeta();
  } catch (err) {
    console.warn('refresh check failed', err);
  }
}

function ago(iso) {
  if (!iso) return '–';
  const mins = Math.round((Date.now() - new Date(iso)) / 60e3);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

function renderMeta() {
  if (!data) return;
  $('#meta').textContent = `Data: nflverse · through week ${data.last_week_played} · updated ${ago(data.generated_at)} · auto-refresh on (checked ${ago(lastCheck)})`;
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function loadSeason(season, { keepWeek = false } = {}) {
  state.season = season;
  if (!cache.has(season)) cache.set(season, await fetchJSON(`${sport.dataPath}/${season}.json`));
  data = cache.get(season);
  // The previous season feeds league factors and player-vs-opponent history.
  history = [];
  if (!cache.has(season - 1)) cache.set(season - 1, await fetchJSON(`${sport.dataPath}/${season - 1}.json`).catch(() => null));
  if (cache.get(season - 1)) history.push(cache.get(season - 1));

  // Weeks: default to the first week with unplayed games.
  const weeks = [...new Map(data.schedule.map((g) => [g.week, g.game_type])).entries()];
  // Upcoming week = first week with a game today or later (scores can lag a day).
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = data.schedule.find((g) => g.gameday >= today) ?? data.schedule.find((g) => g.home_score == null);
  if (!keepWeek) state.week = upcoming ? upcoming.week : weeks[weeks.length - 1][0];
  const linked = data.schedule.find((g) => g.game_id === state.game);
  if (linked) state.week = linked.week;
  $('#week').innerHTML = weeks
    .map(([w, type]) => `<option value="${w}" ${w === state.week ? 'selected' : ''}>${type === 'REG' ? `Week ${w}` : POST_LABELS[type] || type}</option>`)
    .join('');
  renderMeta();
  recompute();
}

function recompute() {
  model = buildModel(sport, data, { beforeWeek: state.week, lastN: state.lastN });
  projector = buildProjector(sport, model, { history, weather: forecasts });
  render();
  // Pull live forecasts for this week's outdoor games, then re-project.
  const pending = weekGames().filter((g) => !forecasts.has(g.game_id));
  if (pending.length) {
    forecastsAt = Date.now();
    fetchForecasts(sport, pending, forecasts).then(() => {
      projector = buildProjector(sport, model, { history, weather: forecasts });
      render();
    });
  }
}

function readHash(doRender = true) {
  const [tab, game] = location.hash.replace(/^#/, '').split('/');
  state.tab = ['matchups', 'players', 'proj', 'td', 'boom', 'dvp', 'rankings'].includes(tab) ? tab : 'matchups';
  state.game = state.tab === 'matchups' && game ? game : null;
  if (!doRender || !model) return;
  // Opening a game from another week re-ranks using games before that week.
  const g = data.schedule.find((x) => x.game_id === state.game);
  if (g && g.week !== state.week) {
    state.week = g.week;
    $('#week').value = g.week;
    recompute();
  } else render();
}

function render() {
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === state.tab));
  const view = $('#view');
  if (!model.N) {
    view.innerHTML = `<div class="card">No games played before this week yet — pick a later week or the previous season.</div>`;
    return;
  }
  const views = { matchups: state.game ? viewGame : viewWeek, players: viewPlayers, proj: viewProjections, td: viewTouchdowns, boom: viewBoomBust, dvp: viewDvp, rankings: viewRankings };
  view.innerHTML = views[state.tab]();
  wire(view);
}

// ---------------------------------------------------------- helpers ----
const weekGames = () => data.schedule.filter((g) => g.week === state.week);
const teamName = (abbr) => data.teams.find((t) => t.abbr === abbr)?.name ?? abbr;

function opponentMap() {
  const m = new Map();
  for (const g of weekGames()) {
    m.set(g.away, { opp: g.home, home: false, game: g });
    m.set(g.home, { opp: g.away, home: true, game: g });
  }
  return m;
}

function gameLine(g) {
  const parts = [];
  if (g.home_score != null) parts.push(`Final ${g.away} ${g.away_score} – ${g.home} ${g.home_score}`);
  else parts.push(`${g.weekday ?? ''} ${g.gameday ?? ''} ${g.gametime ?? ''}`.trim());
  const open = openingLine(g);
  if (g.spread_line != null) {
    const moved = open && open.spread !== g.spread_line ? ` (open ${spreadText(g, open.spread)})` : '';
    parts.push(spreadText(g, g.spread_line) + moved);
  }
  if (g.total_line != null) {
    const moved = open && open.total !== g.total_line ? ` (open ${open.total})` : '';
    parts.push(`O/U ${g.total_line}${moved}`);
  }
  return parts.join(' · ');
}

// nflverse spread_line is from the home team's perspective (positive = home favored).
function spreadText(g, spread) {
  if (spread == null) return '–';
  if (spread === 0) return 'PK';
  return `${spread > 0 ? g.home : g.away} -${Math.abs(spread)}`;
}

// Line snapshots recorded by the refresh job: [time, spread, total, awayML, homeML].
function lineHistory(g) {
  return (data.line_history?.[g.game_id] ?? []).map(([t, spread, total, aml, hml]) => ({ t, spread, total, aml, hml }));
}

function openingLine(g) {
  return lineHistory(g)[0] ?? null;
}

// All offense-vs-defense comparisons for one direction of a game.
function sideEdges(off, def) {
  const rows = [];
  for (const s of sport.teamStats) {
    const o = model.teamStat(off, s.id, 'off');
    const d = model.teamStat(def, s.id, 'def');
    rows.push({ group: 'Team', label: s.label, fmtD: s.fmt, o, d, edge: model.edge(o.rank, d.rank), note: s.note });
  }
  return rows;
}

function posEdges(off, def) {
  const rows = [];
  for (const [pos, cfg] of Object.entries(sport.positions)) {
    for (const s of cfg.stats) {
      const o = model.posStat(off, pos, s.id, 'off');
      const d = model.posStat(def, pos, s.id, 'def');
      rows.push({ group: pos, label: `${pos} ${s.label}`, fmtD: s.fmt, o, d, edge: model.edge(o.rank, d.rank) });
    }
  }
  return rows;
}

function edgeBadge(edge, scale = model.N - 1) {
  return `<span class="edge" style="background:${edgeColor(edge, scale * 0.85)}">${signed(edge)}</span>`;
}

function valRank(v, d) {
  return `${fmt(v.value, d)}<span class="rk">${ordinal(v.rank)}</span>`;
}

// Generic sortable table. cols: {id, label, cls, sort(row)->value, cell(row)->html, desc}
function table(id, cols, rows, defaultSort) {
  const s = state.sort[id] ?? defaultSort;
  if (s) {
    const col = cols.find((c) => c.id === s.col);
    if (col?.sort) {
      rows = [...rows].sort((a, b) => {
        const x = col.sort(a), y = col.sort(b);
        if (x == null) return 1;
        if (y == null) return -1;
        const r = typeof x === 'string' ? x.localeCompare(y) : x - y;
        return s.asc ? r : -r;
      });
    }
  }
  const head = cols
    .map((c) => {
      const cls = [c.cls, c.sort ? 'sortable' : '', s?.col === c.id ? 'sorted' : '', s?.col === c.id && s.asc ? 'asc' : ''].join(' ');
      return `<th class="${cls}" ${c.sort ? `data-sort="${id}:${c.id}"` : ''} ${c.title ? `title="${esc(c.title)}"` : ''}>${c.label}</th>`;
    })
    .join('');
  const body = rows
    .map((r) => `<tr ${r._style ? `style="${r._style}"` : ''}>${cols.map((c) => `<td class="${c.cls ?? ''}" ${c.bg ? `style="background:${c.bg(r)}"` : ''}>${c.cell(r)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td class="l muted" colspan="${cols.length}">Nothing to show.</td></tr>`}</tbody></table></div>`;
}

function wire(root) {
  root.querySelectorAll('[data-sort]').forEach((th) =>
    th.addEventListener('click', () => {
      const [id, col] = th.dataset.sort.split(':');
      const cur = state.sort[id];
      state.sort[id] = { col, asc: cur?.col === col ? !cur.asc : false };
      render();
    }),
  );
  root.querySelectorAll('[data-game]').forEach((el) => el.addEventListener('click', () => (location.hash = `matchups/${el.dataset.game}`)));
  root.querySelectorAll('[data-set]').forEach((el) =>
    el.addEventListener('click', () => {
      const [k, v] = el.dataset.set.split(':');
      state[k] = v === 'true' ? true : v === 'false' ? false : v;
      render();
    }),
  );
  root.querySelector('#search')?.addEventListener('input', (e) => {
    state.search = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const el = $('#search');
    el.focus();
    el.setSelectionRange(pos, pos);
  });
  root.querySelectorAll('[data-expand]').forEach((el) =>
    el.addEventListener('click', () => {
      state.expanded = state.expanded === el.dataset.expand ? null : el.dataset.expand;
      render();
    }),
  );
  root.querySelector('.back')?.addEventListener('click', () => (location.hash = 'matchups'));
}

function seg(key, options) {
  return `<span class="seg">${options
    .map(([v, label]) => `<button data-set="${key}:${v}" class="${String(state[key]) === String(v) ? 'on' : ''}">${label}</button>`)
    .join('')}</span>`;
}

const sampleNote = () =>
  `Using ${state.lastN ? `each team's last ${state.lastN} games` : 'all games'} before ${state.week > 18 ? 'this round' : `week ${state.week}`}.`;

// ------------------------------------------------------------ views ----
function viewWeek() {
  const games = weekGames();
  const cards = games.map((g) => {
    const all = [
      ...sideEdges(g.away, g.home).map((r) => ({ ...r, team: g.away })),
      ...sideEdges(g.home, g.away).map((r) => ({ ...r, team: g.home })),
      ...posEdges(g.away, g.home).filter((r) => r.label.includes('Fantasy')).map((r) => ({ ...r, team: g.away })),
      ...posEdges(g.home, g.away).filter((r) => r.label.includes('Fantasy')).map((r) => ({ ...r, team: g.home })),
    ].filter((r) => r.edge != null && r.edge >= 10);
    all.sort((a, b) => b.edge - a.edge);
    const chips = all.slice(0, 6).map((r) => {
      const label = r.group === 'Team' ? r.label.replace(' / G', '') : `${r.group} fantasy`;
      return `<span class="chip" style="background:${edgeColor(r.edge, (model.N - 1) * 0.85)}" title="${esc(r.team)} offense ${ordinal(r.o.rank)} vs defense ${ordinal(r.d.rank)}">${r.team} ${esc(label)} ${ordinal(r.o.rank)} v ${ordinal(r.d.rank)}</span>`;
    });
    return `<div class="card game" data-game="${g.game_id}">
      <div class="teams"><span>${g.away}</span><span class="vs">@</span><span>${g.home}</span></div>
      <div class="when">${esc(gameLine(g))}</div>
      <div class="when">${esc(weatherLabel(projector.gameWeather(g)))}</div>
      <div class="chips">${chips.join('') || '<span class="muted">No large edges.</span>'}</div>
    </div>`;
  });
  return `<div class="toolbar"><strong>Biggest offensive edges by game</strong><span class="muted">— offense rank vs opponent defense rank; edge ≥ 10 spots. ${sampleNote()}</span></div>
    <div class="grid games">${cards.join('')}</div>`;
}

function matchupTable(id, rowsA, rowsB, a, b) {
  // rowsA: a's offense vs b's defense; rowsB: b's offense vs a's defense (same order).
  const merged = rowsA.map((r, i) => ({ label: r.label, note: r.note, fmtD: r.fmtD, A: r, B: rowsB[i] }));
  const cols = [
    { id: 'stat', label: 'Stat', cls: 'l', cell: (r) => `<span ${r.note ? `title="${esc(r.note)}"` : ''}>${esc(r.label)}</span>` },
    { id: 'ao', label: `${a} Off`, cell: (r) => valRank(r.A.o, r.fmtD) },
    { id: 'bd', label: `${b} Def`, cell: (r) => valRank(r.A.d, r.fmtD) },
    { id: 'ae', label: `${a} edge`, cls: 'c', sort: (r) => r.A.edge, cell: (r) => edgeBadge(r.A.edge) },
    { id: 'bo', label: `${b} Off`, cell: (r) => valRank(r.B.o, r.fmtD) },
    { id: 'ad', label: `${a} Def`, cell: (r) => valRank(r.B.d, r.fmtD) },
    { id: 'be', label: `${b} edge`, cls: 'c', sort: (r) => r.B.edge, cell: (r) => edgeBadge(r.B.edge) },
  ];
  return table(id, cols, merged, null);
}

function viewGame() {
  const g = data.schedule.find((x) => x.game_id === state.game);
  if (!g) return `<button class="back">← All games</button><div class="card">Game not found for this season.</div>`;
  const { away: a, home: h } = g;
  const players = playerRows().filter((p) => p.relevant && (p.team === a || p.team === h));

  const posBlocks = Object.keys(sport.positions)
    .map((pos) => {
      const ra = posEdges(a, h).filter((r) => r.group === pos);
      const rb = posEdges(h, a).filter((r) => r.group === pos);
      return `<div class="card"><h3>${pos} matchup</h3>${matchupTable(`pos-${pos}`, ra, rb, a, h)}</div>`;
    })
    .join('');

  return `<button class="back">← All games</button>
    <div class="matchup-head"><h2>${esc(teamName(a))} @ ${esc(teamName(h))}</h2><span class="muted">${esc(gameLine(g))}</span><span class="muted">${esc(weatherLabel(projector.gameWeather(g)))}</span></div>
    <div class="stack">
      <div class="card"><h3>Team matchup</h3>
        <p class="muted" style="margin:0 0 8px">Values per game with league rank. Offense rank 1 = most productive; defense rank 1 = stingiest. Edge = defense rank − offense rank (positive = offense advantage). ${sampleNote()}</p>
        ${matchupTable('team', sideEdges(a, h), sideEdges(h, a), a, h)}
      </div>
      <div class="grid two">
        <div class="card"><h3>Line movement</h3>${lineMovement(g)}</div>
        <div class="card"><h3>Injury report</h3>${injuryCard(a, h)}</div>
      </div>
      ${hasProps(g) ? `<div class="card"><h3>Props vs projection</h3>${propsTable('game-props', propRows(projRows().filter((r) => r.p.team === a || r.p.team === h)))}</div>` : ''}
      <div class="card"><h3>First touchdown</h3>${firstTdTable('game-ftd', firstTdRows([g]), 10)}</div>
      <div class="card"><h3>Touchdown chances</h3>${tdTable('game-td', projRows().filter((r) => r.p.team === a || r.p.team === h), 10)}</div>
      <div class="card"><h3>Projections</h3>${projTable('game-proj', projRows().filter((r) => r.p.team === a || r.p.team === h))}</div>
      <div class="card"><h3>Player edges</h3>${playersTable('game-players', players)}</div>
      <div class="grid two">${posBlocks}</div>
    </div>`;
}

function playerRows() {
  const opps = opponentMap();
  return model.players
    .filter((p) => opps.has(p.team))
    .map((p) => ({ ...p, m: model.playerMatchup(p, opps.get(p.team).opp), home: opps.get(p.team).home }));
}

function playersTable(id, rows) {
  const N = model.N;
  const cols = [
    {
      id: 'name', label: 'Player', cls: 'l', sort: (r) => r.name,
      cell: (r) => `<span class="player">${r.img ? `<img loading="lazy" src="${esc(r.img)}" alt="" onerror="this.remove()">` : ''}<span>${esc(r.name)}${injuryBadge(r.id)}${r.relevant ? '' : ' <span class="muted" title="Low usage or not active recently">·</span>'}</span></span>`,
    },
    { id: 'pos', label: 'Pos', cls: 'c', sort: (r) => r.pos, cell: (r) => `<span class="pos">${r.pos}</span>` },
    { id: 'team', label: 'Team', cls: 'l', sort: (r) => r.team, cell: (r) => `${r.team} <span class="vs">${r.home ? 'vs' : '@'}</span> ${r.m.opp}` },
    { id: 'n', label: 'G', sort: (r) => r.n, cell: (r) => r.n },
    { id: 'fpts', label: 'FPTS/G', title: 'PPR fantasy points per game', sort: (r) => r.avg.fpts, cell: (r) => fmt(r.avg.fpts) },
    {
      id: 'key', label: 'Key stat/G', title: 'QB: pass yds · RB: scrimmage yds · WR/TE: rec yds',
      sort: (r) => r.avg[sport.positions[r.pos].key],
      cell: (r) => fmt(r.avg[sport.positions[r.pos].key]),
    },
    {
      id: 'allow', label: 'Opp allows to pos', title: 'Fantasy points per game the opponent allows to this position (rank: 1 = toughest, ' + N + ' = softest)',
      sort: (r) => r.m.fptsAllowed,
      bg: (r) => edgeColor(r.m.edge, (N - 1) / 2),
      cell: (r) => `${fmt(r.m.fptsAllowed)} <span class="rk">${ordinal(r.m.fptsRank)}</span>`,
    },
    {
      id: 'keyallow', label: 'Opp allows key', title: 'Key stat per game allowed to the position',
      sort: (r) => r.m.keyAllowed,
      bg: (r) => edgeColor(r.m.keyRank != null ? r.m.keyRank - (N + 1) / 2 : null, (N - 1) / 2),
      cell: (r) => `${fmt(r.m.keyAllowed)} <span class="rk">${ordinal(r.m.keyRank)}</span>`,
    },
    {
      id: 'mult', label: 'Matchup ×', title: 'Opponent allowed ÷ league average allowed to this position (fantasy points)',
      sort: (r) => r.m.fptsMult,
      bg: (r) => edgeColor(r.m.fptsMult != null ? (r.m.fptsMult - 1) * 100 : null, 35),
      cell: (r) => (r.m.fptsMult == null ? '–' : `${r.m.fptsMult.toFixed(2)}×`),
    },
    { id: 'proj', label: 'Adj FPTS', title: 'FPTS/G × matchup multiplier', sort: (r) => r.m.projFpts, cell: (r) => `<strong>${fmt(r.m.projFpts)}</strong>` },
    { id: 'projkey', label: 'Adj key stat', title: 'Key stat/G × opponent key-stat multiplier', sort: (r) => r.m.projKey, cell: (r) => fmt(r.m.projKey) },
  ];
  return table(id, cols, rows, { col: 'mult', asc: false });
}

function viewPlayers() {
  let rows = playerRows();
  if (!state.showAll) rows = rows.filter((p) => p.relevant);
  if (state.pos !== 'ALL') rows = rows.filter((p) => p.pos === state.pos);
  const q = state.search.trim().toLowerCase();
  if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q) || p.team.toLowerCase() === q);
  return `<div class="toolbar">
      ${seg('pos', [['ALL', 'All'], ...Object.keys(sport.positions).map((p) => [p, p])])}
      <input id="search" type="search" placeholder="Player or team…" value="${esc(state.search)}">
      ${seg('showAll', [[false, 'Starters / key roles'], [true, 'Everyone']])}
      <span class="spacer"></span>
      <span class="muted">${sampleNote()}</span>
    </div>
    <div class="card">${playersTable('players', rows)}</div>`;
}

// ------------------------------------------------------ projections ----
function projRows() {
  const games = new Map();
  for (const g of weekGames()) { games.set(g.away, g); games.set(g.home, g); }
  return model.players
    .filter((p) => games.has(p.team) && p.active && !projector.isOut(p))
    .map((p) => ({ p, r: projector.project(p, games.get(p.team)) }))
    .filter(({ p, r }) => {
      const ctx = projector.teamContext(p.team);
      if (p.pos === 'QB') return ctx.newQb ? ctx.newQb.id === p.id : p.relevant;
      // Depth players qualify when teammates' absences push them into a real role.
      return p.relevant || sport.positions[p.pos].relevant(r.proj);
    });
}

const STATUS_SHORT = { Out: 'OUT', Doubtful: 'D', Questionable: 'Q' };
function injuryBadge(id) {
  const st = projector.report.get(id);
  if (!st) return '';
  return ` <span class="inj inj-${st.status.toLowerCase()}" title="${esc(`${st.status}${st.injury ? ` – ${st.injury}` : ''}${st.practice ? ` · ${st.practice}` : ''}`)}">${STATUS_SHORT[st.status]}</span>`;
}

const deltaColor = (d) => edgeColor(d * 100, 25);
const pctTxt = (d) => (Math.round(d * 100) === 0 ? '±0%' : `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(0)}%`);

function projTable(id, rows) {
  const P = sport.projection;
  const sorters = {
    name: (x) => x.p.name,
    pos: (x) => x.p.pos,
    proj: (x) => x.r.projFpts,
    base: (x) => x.r.baseFpts,
    delta: (x) => x.r.delta,
  };
  const s = state.sort[id] ?? { col: 'delta', asc: false };
  rows = [...rows].sort((a, b) => {
    const x = sorters[s.col](a), y = sorters[s.col](b);
    const r = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return s.asc ? r : -r;
  });
  const th = (col, label, cls = '', title = '') =>
    `<th class="${cls} ${col ? 'sortable' : ''} ${s.col === col ? 'sorted' : ''} ${s.col === col && s.asc ? 'asc' : ''}" ${col ? `data-sort="${id}:${col}"` : ''} ${title ? `title="${esc(title)}"` : ''}>${label}</th>`;
  const fmtStat = (k, v) => (k.endsWith('_td') || k === 'int' ? v.toFixed(2) : v.toFixed(1));

  const body = rows.map(({ p, r }) => {
    const key = `${id}:${p.id}`;
    const line = r.keys
      .filter((k) => r.base[k] > 0.05)
      .map((k) => {
        const d = r.base[k] ? r.proj[k] / r.base[k] - 1 : 0;
        const good = k === 'int' ? -d : d;
        return `<span class="chip" style="background:${deltaColor(good)}" title="${esc(P.labels[k])}: ${fmtStat(k, r.proj[k])} projected vs ${fmtStat(k, r.base[k])} avg">${fmtStat(k, r.proj[k])} ${esc(P.labels[k])}</span>`;
      })
      .join('');
    const why = r.factors
      .filter((f) => Math.abs(f.impact) >= 0.01)
      .slice(0, 3)
      .map((f) => `<span class="chip" style="background:${edgeColor(f.impact * 100, 12)}">${esc(f.text)} <strong>${pctTxt(f.impact)}</strong></span>`)
      .join('') || '<span class="muted">No strong factors — projection ≈ average.</span>';
    let html = `<tr class="clickable" data-expand="${key}">
      <td class="l"><span class="player">${p.img ? `<img loading="lazy" src="${esc(p.img)}" alt="" onerror="this.remove()">` : ''}<span>${esc(p.name)}${injuryBadge(p.id)}</span></span></td>
      <td class="c"><span class="pos">${p.pos}</span></td>
      <td class="l">${p.team} <span class="vs">${r.isHome ? 'vs' : '@'}</span> ${r.opp}</td>
      <td style="background:${deltaColor(r.delta)}"><strong>${r.projFpts.toFixed(1)}</strong></td>
      <td>${r.baseFpts.toFixed(1)}</td>
      <td style="background:${deltaColor(r.delta)}"><strong>${pctTxt(r.delta)}</strong></td>
      <td class="l"><div class="chips">${line}</div></td>
      <td class="l"><div class="chips">${why}</div></td>
    </tr>`;
    if (state.expanded === key) {
      const all = r.factors
        .map((f) => `<tr><td class="l">${esc(f.label)}</td><td class="l">${esc(f.text)}</td><td><span class="edge" style="background:${edgeColor(f.impact * 100, 12)}">${pctTxt(f.impact)}</span></td></tr>`)
        .join('');
      const stats = r.keys
        .map((k) => `<tr><td class="l">${esc(P.labels[k])}</td><td>${fmtStat(k, r.base[k])}</td><td><strong>${fmtStat(k, r.proj[k])}</strong></td></tr>`)
        .join('');
      html += `<tr class="detail"><td colspan="8"><div class="grid two">
        <div><h3>All factors (impact on fantasy pts)</h3><table>${all}</table></div>
        <div><h3>Stat line: average → projection</h3><table><tr><th class="l">Stat</th><th>Avg</th><th>Proj</th></tr>${stats}</table>
        <p class="muted">${esc(weatherLabel(r.weather))} · ${p.n} games in sample</p></div>
      </div></td></tr>`;
    }
    return html;
  }).join('');

  return `<div class="tbl-wrap"><table><thead><tr>
      ${th('name', 'Player', 'l')}${th('pos', 'Pos', 'c')}${th('', 'Game', 'l')}
      ${th('proj', 'Proj FPTS', '', 'Projected PPR fantasy points')}
      ${th('base', 'Avg', '', 'Average over the selected sample')}
      ${th('delta', 'vs Avg', '', 'Projection vs the player’s own average — green = better spot than usual')}
      ${th('', 'Projected line', 'l', 'Each stat colored by projection vs average')}
      ${th('', 'Why', 'l', 'Biggest factors behind the projection. Click a row for all of them.')}
    </tr></thead><tbody>${body || '<tr><td colspan="8" class="l muted">Nothing to show.</td></tr>'}</tbody></table></div>`;
}

function viewProjections() {
  let rows = projRows();
  const props = state.projView === 'props';
  if (state.pos !== 'ALL') rows = rows.filter((x) => x.p.pos === state.pos);
  const q = state.search.trim().toLowerCase();
  if (q) rows = rows.filter((x) => x.p.name.toLowerCase().includes(q) || x.p.team.toLowerCase() === q);
  return `<div class="toolbar">
      ${seg('projView', [['proj', 'Projections'], ['q1', '1st quarter'], ['props', 'Props vs projection']])}
      ${seg('pos', [['ALL', 'All'], ...Object.keys(sport.positions).map((p) => [p, p])])}
      <input id="search" type="search" placeholder="Player or team…" value="${esc(state.search)}">
      <span class="spacer"></span>
      <span class="muted">${props ? propsNote() : ''}${state.projView === 'q1' ? q1Note() : ''}Average × opponent, Vegas total, game script, weather, divisional, rest, history vs opponent, recent form. Click a row for the full breakdown. ${sampleNote()}</span>
    </div>
    <div class="card">${props ? propsTable('props', propRows(rows)) : state.projView === 'q1' ? q1Table('q1', rows) : projTable('proj', rows)}</div>`;
}

// ------------------------------------------------------- 1st quarter ----
function q1Note() {
  return 'First quarter = full-game projection × the share that comes in Q1 (league ~22% passing, ~24% rushing), nudged by the player\'s, team\'s and opponent\'s own Q1 tendencies (lightly: backtests found them worth ~1%). Range = middle 50% of outcomes. ';
}

function q1Table(id, rows) {
  const q1 = buildQ1(sport, model, projector, { history });
  const data1 = rows.map((x) => ({ ...x, q: q1.project(x.p, x.r) })).filter((x) => Object.keys(x.q).length);
  const statCols = Object.entries(Q1_STATS).map(([k, def]) => ({
    id: k, label: def.label, cls: 'l',
    title: 'Projection · median · likely range (middle 50%). Grey: share of his production that comes in Q1 vs league.',
    sort: (x) => x.q[k]?.proj ?? -1,
    bg: (x) => (x.q[k] ? edgeColor((x.q[k].share / x.q[k].league - 1) * 100, 25) : 'transparent'),
    cell: (x) => {
      const v = x.q[k];
      if (!v) return '<span class="muted">–</span>';
      const d = k === 'q1_rec' ? 2 : 1;
      const pos0 = (n) => Math.max(0, n);
      // Receptions are small counts: show P(1+) / P(2+) (the usual 0.5 / 1.5 lines).
      const detail = k === 'q1_rec'
        ? `<span class="small muted">1+ ${pctFmt(nbAtLeast(v.proj, 8, 1))} · 2+ ${pctFmt(nbAtLeast(v.proj, 8, 2))}</span>`
        : `<span class="small muted">med ${pos0(medianOutcome(propDist, k, v.proj)).toFixed(d)}</span>`;
      const lo = outcomeQuantile(propDist, k, v.proj, 0.25), hi = outcomeQuantile(propDist, k, v.proj, 0.75);
      const range = lo != null && k !== 'q1_rec' ? ` <span class="rk">${pos0(lo).toFixed(0)}–${pos0(hi).toFixed(0)}</span>` : '';
      const tip = [`Projection ${v.proj.toFixed(d)} (full game ${x.r.proj[v.full].toFixed(1)} × ${(v.share * 100).toFixed(0)}% Q1 share)`,
        v.player.share != null ? `His Q1 share: ${(v.player.share * 100).toFixed(0)}% over ${v.player.n} games` : '',
        v.team.share != null ? `Team Q1 share: ${(v.team.share * 100).toFixed(0)}%` : '',
        v.defense.share != null ? `${x.r.opp} allows ${(v.defense.share * 100).toFixed(0)}% in Q1` : '',
        `League: ${(v.league * 100).toFixed(0)}%`].filter(Boolean).join('\n');
      return `<span title="${esc(tip)}"><strong>${pos0(v.proj).toFixed(d)}</strong> ${detail}${range}</span>`;
    },
  }));
  const cols = [
    { id: 'name', label: 'Player', cls: 'l', sort: (x) => x.p.name, cell: (x) => `${esc(x.p.name)}${injuryBadge(x.p.id)}` },
    { id: 'pos', label: 'Pos', cls: 'c', sort: (x) => x.p.pos, cell: (x) => `<span class="pos">${x.p.pos}</span>` },
    { id: 'game', label: 'Game', cls: 'l', cell: (x) => `${x.p.team} <span class="vs">${x.r.isHome ? 'vs' : '@'}</span> ${x.r.opp}` },
    ...statCols,
  ];
  const sortBy = { QB: 'q1_pass_yds', RB: 'q1_rush_yds' }[state.pos] ?? 'q1_rec_yds';
  return table(id, cols, data1, { col: sortBy, asc: false });
}

// ------------------------------------------------------------ props ----
const PROP_STATS = { pass_yds: 'Pass Yds', pass_td: 'Pass TDs', rush_yds: 'Rush Yds', rec: 'Receptions', rec_yds: 'Rec Yds' };
const hasProps = (g) => Object.keys(data.props?.[g.game_id]?.players ?? {}).length > 0;

function propsNote() {
  const games = weekGames().filter(hasProps);
  if (!games.length) {
    return 'No prop lines for this week yet. They come from The Odds API once ODDS_API_KEY is set on the refresh job (see README). ';
  }
  const t = games.map((g) => data.props[g.game_id].fetched_at).sort().pop();
  return `Lines: consensus of US books via The Odds API, pulled ${ago(t)}. Model P(over) uses the backtested spread of outcomes around projections. `;
}

function propRows(rows) {
  const out = [];
  for (const { p, r } of rows) {
    const book = data.props?.[r.game.game_id]?.players?.[p.id];
    if (!book) continue;
    for (const [stat, label] of Object.entries(PROP_STATS)) {
      const b = book[stat];
      if (!b || b.line == null) continue;
      const proj = stat === 'pass_td' ? r.td.passLambda : r.proj[stat];
      if (proj == null) continue;
      const pOver = stat === 'pass_td' ? poissonAtLeast(proj, Math.floor(b.line) + 1) : overProb(propDist, stat, proj, b.line);
      const fair = fairOver(b.over, b.under);
      const edge = pOver != null && fair != null ? pOver - fair : null;
      const median = stat === 'pass_td' ? proj : medianOutcome(propDist, stat, proj);
      out.push({ p, r, stat, label, b, proj, median, pOver, fair, edge });
    }
  }
  return out;
}

function propsTable(id, rows) {
  const lean = (x) => (x.edge == null ? '–' : Math.abs(x.edge) < 0.03 ? '<span class="muted">No edge</span>' : `<strong>${x.edge > 0 ? 'Over' : 'Under'}</strong> ${pctTxt(Math.abs(x.edge))}`);
  const cols = [
    { id: 'name', label: 'Player', cls: 'l', sort: (x) => x.p.name, cell: (x) => `${esc(x.p.name)}${injuryBadge(x.p.id)}` },
    { id: 'pos', label: 'Pos', cls: 'c', sort: (x) => x.p.pos, cell: (x) => `<span class="pos">${x.p.pos}</span>` },
    { id: 'game', label: 'Game', cls: 'l', cell: (x) => `${x.p.team} <span class="vs">${x.r.isHome ? 'vs' : '@'}</span> ${x.r.opp}` },
    { id: 'stat', label: 'Market', cls: 'l', sort: (x) => x.label, cell: (x) => x.label },
    {
      id: 'line', label: 'Line', title: 'Consensus line (opening line in grey if it moved)', sort: (x) => x.b.line,
      cell: (x) => `${x.b.line}${x.b.open != null && x.b.open !== x.b.line ? ` <span class="rk">from ${x.b.open}</span>` : ''}`,
    },
    { id: 'odds', label: 'O / U', title: 'Over / under prices', cell: (x) => `<span class="small">${fmtMl(x.b.over)} / ${fmtMl(x.b.under)}</span>` },
    { id: 'proj', label: 'Projection', title: 'Projected average', sort: (x) => x.proj, cell: (x) => x.proj.toFixed(x.stat === 'pass_td' || x.stat === 'rec' ? 2 : 1) },
    {
      id: 'median', label: 'Median', title: 'Typical outcome. Averages run above medians for yardage (a few big games), and books set lines near the median, so this is what to compare to the line.',
      sort: (x) => x.median, cell: (x) => `<strong>${x.median.toFixed(x.stat === 'pass_td' || x.stat === 'rec' ? 2 : 1)}</strong>`,
    },
    {
      id: 'diff', label: 'vs Line', title: 'Median minus the line. Green = above the line (over), red = below (under)',
      sort: (x) => (x.median - x.b.line) / x.b.line, bg: (x) => deltaColor((x.median - x.b.line) / x.b.line),
      cell: (x) => `${x.median - x.b.line >= 0 ? '+' : '−'}${Math.abs(x.median - x.b.line).toFixed(1)}`,
    },
    { id: 'pover', label: 'Model P(over)', sort: (x) => x.pOver, cell: (x) => (x.pOver == null ? '–' : pctFmt(x.pOver)) },
    { id: 'fair', label: 'Book P(over)', title: 'Book’s probability with the vig removed', sort: (x) => x.fair, cell: (x) => (x.fair == null ? '–' : pctFmt(x.fair)) },
    {
      id: 'edge', label: 'Lean', title: 'Model probability minus the book’s, on the side the model prefers',
      sort: (x) => Math.abs(x.edge ?? 0), bg: (x) => (x.edge == null || Math.abs(x.edge) < 0.03 ? 'transparent' : edgeColor(Math.abs(x.edge) * 100, 15)),
      cell: lean,
    },
  ];
  return table(id, cols, rows, { col: 'edge', asc: false });
}

function injuryCard(a, h) {
  if (!projector.reportPublished) {
    return `<p class="muted">The official injury report for this week isn't out yet (teams file Wed–Fri). Projections update automatically once it is.</p>`;
  }
  const rows = [];
  for (const team of [a, h]) {
    const ctx = projector.teamContext(team);
    const roster = new Map(model.players.filter((p) => p.team === team).map((p) => [p.id, p]));
    for (const e of projector.report.values()) {
      if (e.team !== team) continue;
      const p = roster.get(e.id);
      const usage = p ? [p.avg.tgt >= 0.5 && `${p.avg.tgt.toFixed(1)} tgt`, p.avg.rush_att >= 0.5 && `${p.avg.rush_att.toFixed(1)} car`, p.pos === 'QB' && p.avg.pass_att >= 1 && `${p.avg.pass_att.toFixed(0)} att`].filter(Boolean).join(', ') : '';
      const gains = p && ctx.missing.includes(p)
        ? [...ctx.extra.entries()]
            .filter(([, x]) => x.from.has(p.name))
            .sort(([, x], [, y]) => y.tgt + y.rush_att - (x.tgt + x.rush_att))
            .map(([id]) => model.players.find((q) => q.id === id)?.name)
            .filter(Boolean)
        : [];
      rows.push({ team, e, usage, gains, order: { Out: 0, Doubtful: 1, Questionable: 2 }[e.status] });
    }
  }
  rows.sort((x, y) => x.team.localeCompare(y.team) || x.order - y.order);
  if (!rows.length) return '<p class="muted">No QB/RB/WR/TE on the report.</p>';
  return `<div class="tbl-wrap"><table>
    <tr><th class="l">Player</th><th class="l">Status</th><th>Usage/G</th><th class="l">Volume goes to</th></tr>
    ${rows.map(({ team, e, usage, gains }) => `<tr>
      <td class="l">${team} <span class="pos">${e.pos}</span> ${esc(e.name)}</td>
      <td class="l wrap"><span class="inj inj-${e.status.toLowerCase()}">${e.status}</span> <span class="muted">${esc(e.injury ?? '')}</span></td>
      <td>${usage || '<span class="muted">–</span>'}</td>
      <td class="l muted wrap">${gains.length ? esc(gains.slice(0, 3).join(', ')) : ''}</td>
    </tr>`).join('')}
  </table></div>`;
}

// Step chart of one line over time. Single series, so no legend: the heading names it.
function lineChart(points, label, fmtY) {
  const W = 320, H = 90, P = { l: 34, r: 10, t: 10, b: 18 };
  const ts = points.map((p) => +new Date(p.t));
  const ys = points.map((p) => p.y);
  const t0 = Math.min(...ts), t1 = Math.max(Date.now(), ...ts);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 2) { y0 -= 1; y1 += 1; }
  const x = (t) => P.l + ((t - t0) / (t1 - t0 || 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b);
  let d = '';
  points.forEach((p, i) => {
    const px = x(ts[i]), py = y(p.y);
    d += i === 0 ? `M${px},${py}` : `H${px}V${py}`;
  });
  d += `H${x(t1)}`;
  const fmtT = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' });
  const dots = points.map((p, i) => `<g class="pt"><circle cx="${x(ts[i])}" cy="${y(p.y)}" r="9" fill="transparent"/><circle cx="${x(ts[i])}" cy="${y(p.y)}" r="4" fill="var(--accent)" stroke="var(--panel)" stroke-width="2"/><title>${esc(`${label}: ${fmtY(p.y)} · ${fmtT(ts[i])}`)}</title></g>`).join('');
  return `<svg class="linechart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} over time">
    <line x1="${P.l}" x2="${W - P.r}" y1="${y(y0)}" y2="${y(y0)}" stroke="var(--line)"/>
    <text x="${P.l - 6}" y="${y(y1) + 4}" text-anchor="end">${esc(String(y1))}</text>
    <text x="${P.l - 6}" y="${y(y0) + 4}" text-anchor="end">${esc(String(y0))}</text>
    <text x="${P.l}" y="${H - 3}">${esc(fmtT(t0))}</text>
    <text x="${W - P.r}" y="${H - 3}" text-anchor="end">now</text>
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    ${dots}
  </svg>`;
}

function lineMovement(g) {
  const hist = lineHistory(g);
  if (g.home_score != null && !hist.length) return '<p class="muted">Game played before line tracking started.</p>';
  if (!hist.length) return '<p class="muted">No line posted yet.</p>';
  const open = hist[0], cur = hist[hist.length - 1];
  const since = new Date(open.t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const ds = cur.spread - open.spread; // + = moved toward home
  const dt = cur.total - open.total;
  const spreadMove = ds === 0 ? 'no move' : `${Math.abs(ds)} pts toward ${ds > 0 ? g.home : g.away}`;
  const totalMove = dt === 0 ? 'no move' : `${dt > 0 ? '+' : '−'}${Math.abs(dt)}`;
  const summary = `<table>
    <tr><th class="l"></th><th>Open</th><th>Now</th><th class="l">Move</th></tr>
    <tr><td class="l">Spread</td><td>${spreadText(g, open.spread)}</td><td><strong>${spreadText(g, cur.spread)}</strong></td><td class="l">${spreadMove}</td></tr>
    <tr><td class="l">Total</td><td>${open.total ?? '–'}</td><td><strong>${cur.total ?? '–'}</strong></td><td class="l">${totalMove}</td></tr>
    <tr><td class="l">Moneyline</td><td>${g.away} ${fmtMl(open.aml)} / ${g.home} ${fmtMl(open.hml)}</td><td>${g.away} ${fmtMl(cur.aml)} / ${g.home} ${fmtMl(cur.hml)}</td><td></td></tr>
  </table>`;
  const charts = hist.length > 1
    ? `<div class="grid two charts">
        <div><div class="muted small">${g.home} spread (+ = ${g.home} favored)</div>${lineChart(hist.map((h) => ({ t: h.t, y: h.spread })), `${g.home} spread`, (v) => spreadText(g, v))}</div>
        <div><div class="muted small">Total</div>${lineChart(hist.map((h) => ({ t: h.t, y: h.total })), 'Total', (v) => String(v))}</div>
      </div>`
    : '';
  return `${summary}${charts}<p class="muted small">Tracked since ${since} (${hist.length} line change${hist.length === 1 ? '' : 's'} recorded). Opening = first line the refresh job saw.</p>`;
}

const fmtMl = (v) => (v == null ? '–' : v > 0 ? `+${v}` : `${v}`);

// ------------------------------------------------------- touchdowns ----
// American odds equivalent of a probability (no vig): a fair price to compare
// against a sportsbook's.
function fairOdds(p) {
  if (!(p > 0 && p < 1)) return '–';
  return p >= 0.5 ? `${Math.round((-100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`;
}
const pctFmt = (p) => `${(p * 100).toFixed(0)}%`;

function tdWhy(r, impactKey = 'tdImpact') {
  return r.factors
    .filter((f) => Math.abs(f[impactKey]) >= 0.01)
    .sort((a, b) => Math.abs(b[impactKey]) - Math.abs(a[impactKey]))
    .slice(0, 3)
    .map((f) => `<span class="chip" style="background:${edgeColor(f[impactKey] * 100, 15)}">${esc(f.text)} <strong>${pctTxt(f[impactKey])}</strong></span>`)
    .join('') || '<span class="muted">No strong factors.</span>';
}

function bookTd(x) {
  const b = data.props?.[x.r.game.game_id]?.players?.[x.p.id]?.anytime_td;
  if (!b?.over) return null;
  return { price: b.over, edge: x.r.td.anytime - impliedProb(b.over) };
}

function tdTable(id, rows, limit = 0) {
  rows = rows
    .filter(({ r }) => r.td.lambda > 0.005)
    .map((x) => ({ ...x, d: x.r.td.baseLambda > 0 ? x.r.td.lambda / x.r.td.baseLambda - 1 : 0 }));
  if (limit) rows = rows.sort((a, b) => b.r.td.anytime - a.r.td.anytime).slice(0, limit);
  const cols = [
    { id: 'name', label: 'Player', cls: 'l', sort: (x) => x.p.name, cell: (x) => `${esc(x.p.name)}${injuryBadge(x.p.id)}` },
    { id: 'pos', label: 'Pos', cls: 'c', sort: (x) => x.p.pos, cell: (x) => `<span class="pos">${x.p.pos}</span>` },
    { id: 'game', label: 'Game', cls: 'l', cell: (x) => `${x.p.team} <span class="vs">${x.r.isHome ? 'vs' : '@'}</span> ${x.r.opp}` },
    {
      id: 'any', label: 'Anytime TD', title: 'Probability of at least one rushing or receiving TD',
      sort: (x) => x.r.td.anytime, bg: (x) => deltaColor(x.d), cell: (x) => `<strong>${pctFmt(x.r.td.anytime)}</strong>`,
    },
    { id: 'odds', label: 'Fair odds', title: 'No-vig American odds for that probability. A book paying more than this is +EV on the model.', sort: (x) => x.r.td.anytime, cell: (x) => fairOdds(x.r.td.anytime) },
    {
      id: 'book', label: 'Book', title: 'Consensus anytime-TD price (includes the book’s vig). Green when the model’s probability beats the book’s implied probability.',
      sort: (x) => bookTd(x)?.edge ?? -1, bg: (x) => { const b = bookTd(x); return b ? edgeColor(b.edge * 100, 15) : 'transparent'; },
      cell: (x) => { const b = bookTd(x); return b ? `${fmtMl(b.price)} <span class="rk">${pctTxt(b.edge)}</span>` : '<span class="muted">–</span>'; },
    },
    { id: 'lam', label: 'Exp TDs', title: 'Projected rushing + receiving TDs this game', sort: (x) => x.r.td.lambda, cell: (x) => x.r.td.lambda.toFixed(2) },
    { id: 'delta', label: 'vs Usual', title: 'This matchup vs the player’s usage-based TD expectation', sort: (x) => x.d, bg: (x) => deltaColor(x.d), cell: (x) => pctTxt(x.d) },
    { id: 'rz', label: 'RZ looks/G', title: 'Red-zone carries + red-zone targets per game', sort: (x) => x.r.td.rzLooks, cell: (x) => x.r.td.rzLooks.toFixed(1) },
    { id: 'gl', label: 'GL car/G', title: 'Carries inside the 5 per game', sort: (x) => x.r.td.glCarries, cell: (x) => x.r.td.glCarries.toFixed(1) },
    { id: 'act', label: 'TDs/G', title: 'Rush + rec TDs actually scored per game in the sample', sort: (x) => x.r.td.actual, cell: (x) => x.r.td.actual.toFixed(2) },
    { id: 'why', label: 'Why', cls: 'l wrap', cell: (x) => `<div class="chips">${tdWhy(x.r)}</div>` },
  ];
  return table(id, cols, rows, { col: 'any', asc: false });
}

function qbTdTable(id, rows) {
  const C = sport.projection.td.passCalib;
  rows = rows
    .filter(({ p, r }) => p.pos === 'QB' && r.td.passLambda != null)
    .map((x) => {
      const lam = x.r.td.passLambda;
      const baseLam = C.mean + C.scale * ((x.r.base.pass_td || 0) - C.mean);
      const p2 = 1 - Math.exp(-lam) * (1 + lam);
      const p3 = 1 - Math.exp(-lam) * (1 + lam + (lam * lam) / 2);
      return { ...x, lam, p2, p3, d: baseLam > 0 ? lam / baseLam - 1 : 0 };
    });
  const cols = [
    { id: 'name', label: 'QB', cls: 'l', sort: (x) => x.p.name, cell: (x) => `${esc(x.p.name)}${injuryBadge(x.p.id)}` },
    { id: 'game', label: 'Game', cls: 'l', cell: (x) => `${x.p.team} <span class="vs">${x.r.isHome ? 'vs' : '@'}</span> ${x.r.opp}` },
    { id: 'lam', label: 'Pass TDs', title: 'Projected passing TDs (shrunk toward league average, as backtests require)', sort: (x) => x.lam, bg: (x) => deltaColor(x.d), cell: (x) => `<strong>${x.lam.toFixed(2)}</strong>` },
    { id: 'p2', label: '2+ TD', sort: (x) => x.p2, bg: (x) => deltaColor(x.d), cell: (x) => `${pctFmt(x.p2)} <span class="rk">${fairOdds(x.p2)}</span>` },
    { id: 'p3', label: '3+ TD', sort: (x) => x.p3, cell: (x) => `${pctFmt(x.p3)} <span class="rk">${fairOdds(x.p3)}</span>` },
    { id: 'avg', label: 'Pass TD/G', title: 'Actual passing TDs per game in the sample', sort: (x) => x.r.base.pass_td, cell: (x) => (x.r.base.pass_td || 0).toFixed(2) },
    { id: 'rush', label: 'Rush TD', title: 'Anytime rushing TD probability', sort: (x) => x.r.td.anytime, cell: (x) => pctFmt(x.r.td.anytime) },
    { id: 'why', label: 'Why', cls: 'l wrap', cell: (x) => `<div class="chips">${tdWhy(x.r, 'impact')}</div>` },
  ];
  return table(id, cols, rows, { col: 'lam', asc: false });
}

function viewTouchdowns() {
  let rows = projRows();
  const q = state.search.trim().toLowerCase();
  if (q) rows = rows.filter((x) => x.p.name.toLowerCase().includes(q) || x.p.team.toLowerCase() === q);
  if (state.tdView === 'first') return viewFirstTd(q);
  const any = state.tdView === 'any';
  if (any && state.pos !== 'ALL') rows = rows.filter((x) => x.p.pos === state.pos);
  return `<div class="toolbar">
      ${seg('tdView', [['any', 'Anytime TD'], ['first', 'First TD'], ['qb', 'QB passing TDs']])}
      ${any ? seg('pos', [['ALL', 'All'], ...Object.keys(sport.positions).map((p) => [p, p])]) : ''}
      <input id="search" type="search" placeholder="Player or team…" value="${esc(state.search)}">
      <span class="spacer"></span>
      <span class="muted">${any
        ? 'Built from red-zone and goal-line usage × league TD rates, then Vegas total, opponent, weather, game script, red-zone trend and injuries. Backtested: predicted rates match actual scoring within ~1–3 pts per bucket.'
        : 'Passing TDs are hard to predict: backtests show only a small edge over a coin flip, so numbers are shrunk hard toward average. Treat as a lean, not a lock.'} ${sampleNote()}</span>
    </div>
    <div class="card">${any ? tdTable('td', rows) : qbTdTable('qbtd', rows)}</div>`;
}

// -------------------------------------------------------- boom / bust ----
const EFFECT_STYLE = {
  boom: { label: 'Boom', color: () => `rgba(var(--good-rgb), .45)` },
  floor: { label: 'Safe floor', color: () => `rgba(var(--good-rgb), .18)` },
  bust: { label: 'Bust risk', color: () => `rgba(var(--bad-rgb), .4)` },
};

function boomRows() {
  return projRows().map(({ p, r }) => {
    const bb = boomBust(boomFit, p, r);
    // Only angles with a real backtested effect are shown, labeled by that effect.
    const angles = anglesFor(p, r, model)
      .map((a) => ({ ...a, rec: boomFit?.angles?.[a.id], effect: angleEffect(boomFit?.angles?.[a.id]) }))
      .filter((a) => a.effect);
    const base = boomFit?.base?.[p.pos] ?? { boom: 0.14, bust: 0.26 };
    return { p, r, ...bb, base, angles };
  });
}

function angleChip(a) {
  const st = EFFECT_STYLE[a.effect];
  const rec = a.rec ? `Backtest: ${pctFmt(a.rec.boom)} boom vs ${pctFmt(a.rec.baseBoom)} normal, ${pctFmt(a.rec.bust)} bust vs ${pctFmt(a.rec.baseBust)} (n=${a.rec.n})` : '';
  const stat = a.effect === 'bust' ? `${pctFmt(a.rec.bust)} bust` : a.effect === 'boom' ? `${pctFmt(a.rec.boom)} boom` : `${pctFmt(a.rec.bust)} bust`;
  return `<span class="chip" style="background:${st.color()}" title="${esc(`${a.text}\n${rec}`)}"><strong>${esc(a.label)}</strong> · ${esc(a.text)} <span class="rk">${stat} vs ${pctFmt(a.effect === 'boom' ? a.rec.baseBoom : a.rec.baseBust)}</span></span>`;
}

function boomTable(id, rows, kind) {
  const isBoom = kind === 'boom';
  const cols = [
    { id: 'name', label: 'Player', cls: 'l', sort: (x) => x.p.name, cell: (x) => `${esc(x.p.name)}${injuryBadge(x.p.id)}` },
    { id: 'pos', label: 'Pos', cls: 'c', sort: (x) => x.p.pos, cell: (x) => `<span class="pos">${x.p.pos}</span>` },
    { id: 'game', label: 'Game', cls: 'l', cell: (x) => `${x.p.team} <span class="vs">${x.r.isHome ? 'vs' : '@'}</span> ${x.r.opp}` },
    { id: 'avg', label: 'Avg', title: 'Average PPR points', sort: (x) => x.r.baseFpts, cell: (x) => x.r.baseFpts.toFixed(1) },
    { id: 'proj', label: 'Proj', sort: (x) => x.r.projFpts, cell: (x) => x.r.projFpts.toFixed(1) },
    {
      id: 'boom', label: 'Boom %', title: 'Chance of ≥ 1.5× his average (and at least QB 22 / RB 16 / WR 16 / TE 12). Grey = normal rate for the position.',
      sort: (x) => x.boom, bg: (x) => (x.boom == null ? 'transparent' : edgeColor((x.boom - x.base.boom) * 100, 12)),
      cell: (x) => `<strong>${x.boom == null ? '–' : pctFmt(x.boom)}</strong> <span class="rk">${pctFmt(x.base.boom)}</span>`,
    },
    {
      id: 'bust', label: 'Bust %', title: 'Chance of ≤ half his average. Grey = normal rate for the position.',
      sort: (x) => x.bust, bg: (x) => (x.bust == null ? 'transparent' : edgeColor((x.base.bust - x.bust) * 100, 12)),
      cell: (x) => `<strong>${x.bust == null ? '–' : pctFmt(x.bust)}</strong> <span class="rk">${pctFmt(x.base.bust)}</span>`,
    },
    { id: 'line', label: 'Boom at', title: 'Points needed for a boom / bust week', cell: (x) => `${x.boomAt.toFixed(0)}+ <span class="rk">bust ≤ ${x.bustAt.toFixed(0)}</span>` },
    { id: 'angles', label: 'Angles', cls: 'l wrap', sort: (x) => x.angles.length, cell: (x) => `<div class="chips">${x.angles.map(angleChip).join('') || '<span class="muted">–</span>'}</div>` },
  ];
  return table(id, cols, rows, { col: isBoom ? 'boom' : 'bust', asc: false });
}

function viewBoomBust() {
  if (!boomFit) return '<div class="card">Boom/bust model not built yet — run <code>node tools/fit_boom_bust.mjs</code>.</div>';
  let rows = boomRows();
  if (state.pos !== 'ALL') rows = rows.filter((x) => x.p.pos === state.pos);
  const q = state.search.trim().toLowerCase();
  if (q) rows = rows.filter((x) => x.p.name.toLowerCase().includes(q) || x.p.team.toLowerCase() === q);
  const boom = rows.filter((x) => x.angles.some((a) => a.effect === 'boom') || x.boom >= x.base.boom + 0.05);
  const bust = rows.filter((x) => x.angles.some((a) => a.effect === 'bust') || x.bust >= x.base.bust + 0.06);
  const recs = Object.entries(boomFit.angles ?? {});
  const legend = recs
    .map(([id, rec]) => ({ id, rec, effect: angleEffect(rec) }))
    .filter((a) => a.effect)
    .map((a) => `<tr><td class="l">${esc(ANGLE_LABELS[a.id] ?? a.id)}</td><td class="l">${EFFECT_STYLE[a.effect].label}</td><td>${pctFmt(a.rec.boom)} <span class="rk">vs ${pctFmt(a.rec.baseBoom)}</span></td><td>${pctFmt(a.rec.bust)} <span class="rk">vs ${pctFmt(a.rec.baseBust)}</span></td><td>${a.rec.n}</td></tr>`)
    .join('');
  return `<div class="toolbar">
      ${seg('pos', [['ALL', 'All'], ...Object.keys(sport.positions).map((p) => [p, p])])}
      <input id="search" type="search" placeholder="Player or team…" value="${esc(state.search)}">
      <span class="spacer"></span>
      <span class="muted">Boom = 1.5× his average or more; bust = half or less. Angles are specific matchup setups, each shown with its backtested record. ${sampleNote()}</span>
    </div>
    <div class="stack">
      <div class="card"><h3>Boom candidates</h3>${boomTable('boom', boom, 'boom')}</div>
      <div class="card"><h3>Bust risks</h3>${boomTable('bust', bust, 'bust')}</div>
      <div class="card"><h3>Angle track record (2025 + 2026 backtest)</h3>
        <div class="tbl-wrap"><table><tr><th class="l">Angle</th><th class="l">What it actually does</th><th>Boom rate</th><th>Bust rate</th><th>Games</th></tr>${legend}</table></div>
        <p class="muted small">Angles that showed no real effect in backtests (e.g. low game totals, tough defenses, workhorse backs as favorites) are tracked but not shown.</p>
      </div>
    </div>`;
}

// ------------------------------------------------------------ first TD ----
function firstTdRows(games) {
  const ft = buildFirstTd(sport, model, projector, { history });
  return games.flatMap((g) => {
    const res = ft.forGame(g);
    return res.players.map((x) => ({ ...x, g, teamInfo: res.teams[x.team], oppTeam: res.teams[x.team === g.home ? g.away : g.home] }));
  });
}

function firstTdTable(id, rows, limit = 0) {
  if (limit) rows = [...rows].sort((a, b) => b.gameFirst - a.gameFirst).slice(0, limit);
  const ctx = (f, label) => (f?.text ? `<span class="chip ctx" title="Shown for context: not weighted in (no backtested edge)">${esc(label)}: ${esc(f.text)}</span>` : '');
  const cols = [
    { id: 'name', label: 'Player', cls: 'l', sort: (x) => x.p.name, cell: (x) => `${esc(x.p.name)}${injuryBadge(x.p.id)}` },
    { id: 'pos', label: 'Pos', cls: 'c', sort: (x) => x.p.pos, cell: (x) => `<span class="pos">${x.p.pos}</span>` },
    {
      id: 'game', label: 'Game', cls: 'l', title: 'Chance this team scores the game’s first TD',
      cell: (x) => `${x.p.team} <span class="vs">${x.r.isHome ? 'vs' : '@'}</span> ${x.r.opp} <span class="rk">${pctFmt(x.teamInfo.pFirst)} team first</span>`,
    },
    {
      id: 'gf', label: 'First TD', title: 'Chance he scores the first TD of the game',
      sort: (x) => x.gameFirst, bg: (x) => edgeColor((x.gameFirst - 0.045) * 100, 8),
      cell: (x) => `<strong>${(x.gameFirst * 100).toFixed(1)}%</strong> <span class="rk">${fairOdds(x.gameFirst)}</span>`,
    },
    {
      id: 'tf', label: 'Team 1st TD', title: 'Chance he scores his team’s first TD',
      sort: (x) => x.teamFirst, cell: (x) => `${(x.teamFirst * 100).toFixed(1)}% <span class="rk">${fairOdds(x.teamFirst)}</span>`,
    },
    { id: 'any', label: 'Anytime', sort: (x) => x.r.td.anytime, cell: (x) => pctFmt(x.r.td.anytime) },
    { id: 'share', label: 'Team TD share', title: 'His share of the team’s expected TDs (after flattening)', sort: (x) => x.share, cell: (x) => pctFmt(x.share) },
    { id: 'rz', label: 'RZ looks/G', sort: (x) => x.r.td.rzLooks, cell: (x) => x.r.td.rzLooks.toFixed(1) },
    {
      id: 'ctx', label: 'Context (not weighted)', cls: 'l wrap',
      title: 'Early-game role, his first-TD history and what this defense allows. Backtests found none of these predict first TDs beyond the TD share, so they are informational.',
      cell: (x) => `<div class="chips">${ctx(x.f.early, 'Early role')}${ctx(x.f.hist, 'History')}${ctx(x.f.def, 'Defense')}</div>`,
    },
  ];
  return table(id, cols, rows, { col: 'gf', asc: false });
}

function viewFirstTd(q) {
  let rows = firstTdRows(weekGames());
  if (state.pos !== 'ALL') rows = rows.filter((x) => x.p.pos === state.pos);
  if (q) rows = rows.filter((x) => x.p.name.toLowerCase().includes(q) || x.p.team.toLowerCase() === q);
  rows = rows.filter((x) => x.gameFirst >= 0.005);
  return `<div class="toolbar">
      ${seg('tdView', [['any', 'Anytime TD'], ['first', 'First TD'], ['qb', 'QB passing TDs']])}
      ${seg('pos', [['ALL', 'All'], ...Object.keys(sport.positions).map((p) => [p, p])])}
      <input id="search" type="search" placeholder="Player or team…" value="${esc(state.search)}">
      <span class="spacer"></span>
      <span class="muted">Each player's share of his team's expected TDs (red-zone usage, Vegas, opponent, weather, injuries…) × the chance his team scores first. Backtested: predicted rates match actual within ~1–3 pts; early role, first-TD history and defense tendencies added nothing, so they're shown as context only. A typical starter is ~4–5%. ${sampleNote()}</span>
    </div>
    <div class="card">${firstTdTable('ftd', rows)}</div>`;
}

function viewDvp() {
  const metrics = [
    ['fpts', 'Fantasy pts'],
    ['key', 'Yards (key stat)'],
    ['rec', 'Receptions'],
    ['tds', 'TDs'],
  ];
  const N = model.N;
  const opps = opponentMap();
  const statFor = (pos) => (state.dvpMetric === 'key' ? sport.positions[pos].key : state.dvpMetric);
  const rows = model.teams.map((t) => ({ t, opp: opps.get(t) }));
  const cols = [
    { id: 'team', label: 'Defense', cls: 'l', sort: (r) => r.t, cell: (r) => `<strong>${r.t}</strong> <span class="muted">${esc(teamName(r.t))}</span>` },
    { id: 'g', label: 'G', sort: (r) => model.team[r.t].n, cell: (r) => model.team[r.t].n },
    {
      id: 'opp', label: 'Faces', cls: 'l', title: 'Opponent in the selected week',
      sort: (r) => r.opp?.opp, cell: (r) => (r.opp ? `<a href="#matchups/${r.opp.game.game_id}">${r.opp.home ? 'vs' : '@'} ${r.opp.opp}</a>` : '<span class="muted">bye</span>'),
    },
    ...Object.keys(sport.positions).map((pos) => {
      const st = () => statFor(pos);
      return {
        id: pos, label: `vs ${pos}`, title: `Per game allowed to ${pos}. Rank 1 = toughest, ${N} = softest`,
        sort: (r) => model.posStat(r.t, pos, st(), 'def').value,
        bg: (r) => {
          const s = model.posStat(r.t, pos, st(), 'def');
          return edgeColor(s.rank != null ? s.rank - (N + 1) / 2 : null, (N - 1) / 2);
        },
        cell: (r) => valRank(model.posStat(r.t, pos, st(), 'def'), st() === 'tds' ? 2 : 1),
      };
    }),
  ];
  return `<div class="toolbar">
      ${seg('dvpMetric', metrics)}
      <span class="spacer"></span>
      <span class="muted">Green = soft defense (allows a lot to that position). Key stat: QB pass yds, RB scrimmage yds, WR/TE rec yds. ${sampleNote()}</span>
    </div>
    <div class="card">${table('dvp', cols, rows, { col: 'TE', asc: false })}</div>`;
}

function viewRankings() {
  const side = state.rankSide;
  const N = model.N;
  const opps = opponentMap();
  const rows = model.teams.map((t) => ({ t }));
  const cols = [
    { id: 'team', label: 'Team', cls: 'l', sort: (r) => r.t, cell: (r) => `<strong>${r.t}</strong> <span class="muted">${esc(teamName(r.t))}</span>` },
    { id: 'g', label: 'G', sort: (r) => model.team[r.t].n, cell: (r) => model.team[r.t].n },
    {
      id: 'opp', label: 'Next', cls: 'l', sort: (r) => opps.get(r.t)?.opp,
      cell: (r) => { const o = opps.get(r.t); return o ? `<a href="#matchups/${o.game.game_id}">${o.home ? 'vs' : '@'} ${o.opp}</a>` : '<span class="muted">bye</span>'; },
    },
    ...sport.teamStats.map((s) => ({
      id: s.id, label: s.label.replace(' / G', '/G'), title: s.note,
      sort: (r) => model.teamStat(r.t, s.id, side).rank * -1,
      bg: (r) => rankColor(model.teamStat(r.t, s.id, side).rank, N),
      cell: (r) => valRank(model.teamStat(r.t, s.id, side), s.fmt),
    })),
  ];
  return `<div class="toolbar">
      ${seg('rankSide', [['off', 'Offense'], ['def', 'Defense (allowed)']])}
      <span class="spacer"></span>
      <span class="muted">Rank 1 = best ${side === 'off' ? 'offense' : 'defense'} in that stat. ${sampleNote()}</span>
    </div>
    <div class="card">${table('rank-' + side, cols, rows, { col: 'pts', asc: false })}</div>`;
}

boot().catch((err) => {
  $('#view').innerHTML = `<div class="card">Failed to load data: ${esc(err.message)}.<br><span class="muted">Run <code>python pipeline/build_nfl.py</code> and serve <code>web/</code> over HTTP (e.g. <code>python -m http.server -d web</code>).</span></div>`;
  console.error(err);
});
