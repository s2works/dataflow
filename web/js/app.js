import nfl from './sports/nfl.js';
import { buildModel, edgeColor, rankColor, ordinal } from './engine.js';
import { buildProjector, fetchForecasts, weatherLabel } from './projections.js';

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
};
let data = null;
let model = null;
let projector = null;
let history = [];
const cache = new Map();
const forecasts = new Map(); // game_id -> forecast (fetched in the browser)

// ---------------------------------------------------------------- boot ----
async function boot() {
  const index = await fetchJSON(`${sport.dataPath}/index.json`);
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
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function loadSeason(season) {
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
  state.week = upcoming ? upcoming.week : weeks[weeks.length - 1][0];
  const linked = data.schedule.find((g) => g.game_id === state.game);
  if (linked) state.week = linked.week;
  $('#week').innerHTML = weeks
    .map(([w, type]) => `<option value="${w}" ${w === state.week ? 'selected' : ''}>${type === 'REG' ? `Week ${w}` : POST_LABELS[type] || type}</option>`)
    .join('');
  $('#meta').textContent = `Data: nflverse · through week ${data.last_week_played} · built ${data.generated_at.slice(0, 10)}`;
  recompute();
}

function recompute() {
  model = buildModel(sport, data, { beforeWeek: state.week, lastN: state.lastN });
  projector = buildProjector(sport, model, { history, weather: forecasts });
  render();
  // Pull live forecasts for this week's outdoor games, then re-project.
  const pending = weekGames().filter((g) => !forecasts.has(g.game_id));
  if (pending.length) {
    fetchForecasts(sport, pending, forecasts).then(() => {
      projector = buildProjector(sport, model, { history, weather: forecasts });
      render();
    });
  }
}

function readHash(doRender = true) {
  const [tab, game] = location.hash.replace(/^#/, '').split('/');
  state.tab = ['matchups', 'players', 'proj', 'dvp', 'rankings'].includes(tab) ? tab : 'matchups';
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
  const views = { matchups: state.game ? viewGame : viewWeek, players: viewPlayers, proj: viewProjections, dvp: viewDvp, rankings: viewRankings };
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
  if (g.spread_line != null) {
    // nflverse spread_line is from the home team's perspective (positive = home favored).
    const fav = g.spread_line > 0 ? g.home : g.away;
    parts.push(g.spread_line === 0 ? 'PK' : `${fav} -${Math.abs(g.spread_line)}`);
  }
  if (g.total_line != null) parts.push(`O/U ${g.total_line}`);
  return parts.join(' · ');
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
      cell: (r) => `<span class="player">${r.img ? `<img loading="lazy" src="${esc(r.img)}" alt="" onerror="this.remove()">` : ''}<span>${esc(r.name)}${r.relevant ? '' : ' <span class="muted" title="Low usage or not active recently">·</span>'}</span></span>`,
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
    .filter((p) => games.has(p.team) && p.relevant)
    .map((p) => ({ p, r: projector.project(p, games.get(p.team)) }));
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
      <td class="l"><span class="player">${p.img ? `<img loading="lazy" src="${esc(p.img)}" alt="" onerror="this.remove()">` : ''}<span>${esc(p.name)}</span></span></td>
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
  if (state.pos !== 'ALL') rows = rows.filter((x) => x.p.pos === state.pos);
  const q = state.search.trim().toLowerCase();
  if (q) rows = rows.filter((x) => x.p.name.toLowerCase().includes(q) || x.p.team.toLowerCase() === q);
  return `<div class="toolbar">
      ${seg('pos', [['ALL', 'All'], ...Object.keys(sport.positions).map((p) => [p, p])])}
      <input id="search" type="search" placeholder="Player or team…" value="${esc(state.search)}">
      <span class="spacer"></span>
      <span class="muted">Average × opponent, Vegas total, game script, weather, divisional, rest, history vs opponent, recent form. Click a row for the full breakdown. ${sampleNote()}</span>
    </div>
    <div class="card">${projTable('proj', rows)}</div>`;
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
