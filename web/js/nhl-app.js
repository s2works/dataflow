// NHL dashboard: Matchups (game previews + upsets), Player Edges, Player Props
// (skaters and goalies), Top Picks (daily top 20 overs / unders), Scorecard
// (live locked picks graded against results, plus the backtest), Defense vs
// Position, Team Rankings. Shares the ranking engine with
// the NFL app; models live in nhl/model.js.

import sport from './sports/nhl.js';
import { buildModel, edgeColor, rankColor, ordinal } from './engine.js';
import { buildNhlProjector, buildNhlGameModel, goalieSaves } from './nhl/model.js';
import { gameFilter } from './gamefilter.js';
import { fairOdds, mountOddsSwitch } from './odds.js';
import { nhlDayPicks, gradeProp, gradeGame, indexResults, tally, MARKET_LABEL, lineupCore } from './nhl/picks.js';
import { rankPicks, RANK_LABELS, MIN_PROB } from './rankpicks.js';
import { nbAtLeast } from './props.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));
const pct = (p) => (p == null ? '–' : `${Math.round(p * 100)}%`);
const signed = (v) => (v == null ? '–' : v > 0 ? `+${v}` : `${v}`);
const POS_NAME = { C: 'centers', W: 'wingers', D: 'defensemen' };
const REFRESH_MS = 5 * 60e3;

const state = { season: null, week: null, lastN: 0, tab: 'matchups', game: null, pos: 'ALL', search: '', propView: 'skaters', edgeMetric: 'pts', core: 'core', pickRank: 'edge', pickMarket: 'all', pickMin: '0', propMin: '0', dvpMetric: 'pts', rankSide: 'off', weekSort: 'time', sort: {} };
let data = null, model = null, projector = null, gameModel = null, history = [], record = null, locked = null, dayPicks = null;
let indexUpdated = {}, lastCheck = null;
const cache = new Map();

// ---------------------------------------------------------------- boot ----
async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function boot() {
  mountOddsSwitch(() => model && render());
  $('#tabs').innerHTML = [['matchups', 'Matchups'], ['edges', 'Player Edges'], ['props', 'Player Props'], ['picks', 'Top Picks'], ['score', 'Scorecard'], ['dvp', 'Defense vs Position'], ['rankings', 'Team Rankings']]
    .map(([id, label]) => `<a href="#${id}" data-tab="${id}">${label}</a>`).join('');
  const weekLabel = $('#week').closest('label');
  if (weekLabel?.firstChild) weekLabel.firstChild.textContent = 'Date ';
  document.title = 'Edge Board · NHL';

  const index = await fetchJSON(`${sport.dataPath}/index.json`);
  indexUpdated = index.updated ?? {};
  lastCheck = new Date();
  record = await fetchJSON(`${sport.dataPath}/nhl_record.json`).catch(() => null);
  $('#season').innerHTML = index.seasons.map((s) => `<option value="${s}">${s}-${String(s + 1).slice(2)}</option>`).join('');
  $('#season').onchange = (e) => loadSeason(+e.target.value);
  $('#week').onchange = (e) => { state.week = +e.target.value; state.game = null; if (location.hash.includes('/')) history_.replaceState(null, '', '#matchups'); recompute(); };
  $('#window').onchange = (e) => { state.lastN = +e.target.value; recompute(); };
  window.addEventListener('hashchange', readHash);
  readHash(false);
  await loadSeason(index.seasons[0]);
  setInterval(checkForUpdates, REFRESH_MS);
  setInterval(renderMeta, 30e3);
}
const history_ = window.history;

async function loadSeason(season, { keepDay = false } = {}) {
  state.season = season;
  if (!cache.has(season)) cache.set(season, await fetchJSON(`${sport.dataPath}/${season}.json`));
  data = cache.get(season);
  history = [];
  if (!cache.has(season - 1)) cache.set(season - 1, await fetchJSON(`${sport.dataPath}/${season - 1}.json`).catch(() => null));
  if (cache.get(season - 1)) history.push(cache.get(season - 1));
  locked = await fetchJSON(`${sport.dataPath}/picks/${season}.json`).catch(() => null);

  const days = [...new Set(data.schedule.map((g) => g.week))].sort((a, b) => a - b);
  const today = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD (game days are local dates)
  const next = data.schedule.find((g) => g.gameday >= today);
  if (!keepDay) state.week = next ? next.week : days[days.length - 1];
  const linked = data.schedule.find((g) => String(g.game_id) === state.game);
  if (linked) state.week = linked.week;
  $('#week').innerHTML = days.map((d) => `<option value="${d}" ${d === state.week ? 'selected' : ''}>${dayLabel(d)}</option>`).join('');
  renderMeta();
  recompute();
}

const dayLabel = (d) => {
  const date = data.days?.[d];
  return date ? new Date(`${date}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : `Day ${d}`;
};

function recompute() {
  model = buildModel(sport, data, { beforeWeek: state.week, lastN: state.lastN });
  projector = buildNhlProjector(sport, model, { history });
  gameModel = buildNhlGameModel(sport, data, { beforeWeek: state.week, history, model });
  dayPicks = null; // computed on demand by the Top Picks tab
  render();
}

async function checkForUpdates() {
  try {
    const index = await fetchJSON(`${sport.dataPath}/index.json`);
    lastCheck = new Date();
    const changed = [state.season, state.season - 1].filter((s) => index.updated?.[s] && index.updated[s] !== indexUpdated[s]);
    indexUpdated = index.updated ?? {};
    for (const s of changed) cache.delete(s);
    if (changed.length) await loadSeason(state.season, { keepDay: true });
    else {
      const fresh = await fetchJSON(`${sport.dataPath}/picks/${state.season}.json`).catch(() => null);
      if (fresh && JSON.stringify(fresh) !== JSON.stringify(locked)) { locked = fresh; if (['picks', 'score'].includes(state.tab)) render(); }
      renderMeta();
    }
  } catch (err) { console.warn('refresh check failed', err); }
}

function ago(iso) {
  if (!iso) return '–';
  const mins = Math.round((Date.now() - new Date(iso)) / 60e3);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 2880) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}
function renderMeta() {
  if (data) $('#meta').textContent = `Data: NHL via fastRhockey · through ${dayLabel(data.last_week_played)} · updated ${ago(data.generated_at)} · auto-refresh on (checked ${ago(lastCheck)})`;
}

function readHash(doRender = true) {
  const [tab, game] = location.hash.replace(/^#/, '').split('/');
  state.tab = ['matchups', 'edges', 'props', 'picks', 'score', 'dvp', 'rankings'].includes(tab) ? tab : 'matchups';
  state.game = state.tab === 'matchups' && game ? game : null;
  if (!doRender || !model) return;
  const g = data.schedule.find((x) => String(x.game_id) === state.game);
  if (g && g.week !== state.week) { state.week = g.week; $('#week').value = g.week; recompute(); } else render();
}

function render() {
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === state.tab));
  const view = $('#view');
  if (!model.N) { view.innerHTML = '<div class="card">No games played before this date yet: pick a later date or the previous season.</div>'; return; }
  const views = { matchups: state.game ? viewGame : viewDay, edges: viewEdges, props: viewProps, picks: viewPicks, score: viewScore, dvp: viewDvp, rankings: viewRankings };
  view.innerHTML = (GAME_FILTER_TABS.includes(state.tab) ? games_.bar() : '') + views[state.tab]();
  wire(view);
}

// ------------------------------------------------------------ helpers ----
const dayGames = () => data.schedule.filter((g) => g.week === state.week);
// Game filter chips on player tabs (gamefilter.js).
const GAME_FILTER_TABS = ['edges', 'props', 'picks'];
const games_ = gameFilter(dayGames, () => `${state.season}:${state.week}`);
const shownGames = () => dayGames().filter((g) => games_.on(g.game_id));
const teamName = (abbr) => data.teams.find((t) => t.abbr === abbr)?.name ?? abbr;
const faceoff = (g) => (g.gametime && g.gametime.includes('T') ? new Date(g.gametime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

function table(id, cols, rows, defaultSort) {
  const s = state.sort[id] ?? defaultSort;
  if (s) {
    const col = cols.find((c) => c.id === s.col);
    if (col?.sort) rows = [...rows].sort((a, b) => {
      const x = col.sort(a), y = col.sort(b);
      if (x == null) return 1;
      if (y == null) return -1;
      const r = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return s.asc ? r : -r;
    });
  }
  const head = cols.map((c) => `<th class="${c.cls ?? ''} ${c.sort ? 'sortable' : ''} ${s?.col === c.id ? 'sorted' : ''} ${s?.col === c.id && s.asc ? 'asc' : ''}" ${c.sort ? `data-sort="${id}:${c.id}"` : ''} ${c.title ? `title="${esc(c.title)}"` : ''}>${c.label}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.cls ?? ''}" ${c.bg ? `style="background:${c.bg(r)}"` : ''}>${c.cell(r)}</td>`).join('')}</tr>`).join('');
  return `<div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td class="l muted" colspan="${cols.length}">Nothing to show.</td></tr>`}</tbody></table></div>`;
}

function seg(key, options) {
  return `<span class="seg">${options.map(([v, label]) => `<button data-set="${key}:${v}" class="${String(state[key]) === String(v) ? 'on' : ''}">${label}</button>`).join('')}</span>`;
}

function wire(root) {
  root.querySelectorAll('[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const [id, col] = th.dataset.sort.split(':');
    const cur = state.sort[id];
    state.sort[id] = { col, asc: cur?.col === col ? !cur.asc : false };
    render();
  }));
  root.querySelectorAll('[data-game]').forEach((el) => el.addEventListener('click', () => (location.hash = `matchups/${el.dataset.game}`)));
  games_.wire(root, render);
  root.querySelectorAll('[data-set]').forEach((el) => el.addEventListener('click', () => {
    const [k, v] = el.dataset.set.split(':');
    state[k] = v;
    render();
  }));
  root.querySelector('#search')?.addEventListener('input', (e) => {
    state.search = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const el = $('#search');
    el.focus();
    el.setSelectionRange(pos, pos);
  });
  root.querySelector('.back')?.addEventListener('click', () => (location.hash = 'matchups'));
}

const sampleNote = () => `Using ${state.lastN ? `each team's last ${state.lastN} games` : 'all games'} before ${dayLabel(state.week)}, plus last season as a prior.`;

// Skater projections for the selected day.
function skaterRows(games = dayGames()) {
  const byTeam = new Map(games.flatMap((g) => [[g.home, g], [g.away, g]]));
  return model.players.filter((p) => p.relevant && byTeam.has(p.team)).map((p) => ({ p, r: projector.project(p, byTeam.get(p.team)) }));
}

// Player Props / Edges: optionally only each team's top 9 forwards and top 4
// defensemen by recent ice time (the players books post props for).
function coreOnly(rows) {
  if (state.core === 'all') return rows;
  const core = lineupCore(rows.map((x) => x.p), projector.ctx);
  return rows.filter((x) => core.has(x.p.id));
}
const coreSeg = () => seg('core', [['core', 'Top 9 F / 4 D'], ['all', 'All skaters']]);

function upsetInfo(g) {
  const p = gameModel.predict(g);
  const dogHome = p.pHome < 0.5;
  return { p, dogTeam: dogHome ? g.home : g.away, dog: dogHome ? p.pHome : 1 - p.pHome };
}

// --------------------------------------------------------- matchups ----
function viewDay() {
  let games = dayGames();
  if (!games.length) return '<div class="card">No games on this date.</div>';
  if (state.weekSort === 'upset') games = [...games].sort((a, b) => upsetInfo(b).dog - upsetInfo(a).dog);
  const rows = skaterRows(games);
  const byTeam = new Map();
  for (const x of rows) { if (!byTeam.has(x.p.team)) byTeam.set(x.p.team, []); byTeam.get(x.p.team).push(x); }
  const cards = games.map((g) => {
    const u = upsetInfo(g), p = u.p;
    const gh = goalieSaves(sport, projector.ctx, g.home, g.away, true, g), ga = goalieSaves(sport, projector.ctx, g.away, g.home, false, g);
    const final = g.home_score != null;
    const upset = final
      ? `<div class="upset ${((g.home_score > g.away_score ? g.home : g.away) === u.dogTeam) ? 'hit' : ''}">${((g.home_score > g.away_score ? g.home : g.away) === u.dogTeam) ? `Upset: ${u.dogTeam} won as a ${pct(u.dog)} underdog` : `Favorite won (${u.dogTeam} was ${pct(u.dog)})`}</div>`
      : `<div class="upset" style="--u:${Math.min(1, u.dog / 0.5).toFixed(2)}"><span>Upset chance: <strong>${u.dogTeam} ${pct(u.dog)}</strong> <span class="rk">model</span></span>${u.dog >= 0.45 ? '<span class="badge alert" title="Underdog at 45%+: close to a coin flip">Upset alert</span>' : ''}</div>`;
    const top = (t) => (byTeam.get(t) || []).sort((a, b) => b.r.proj.pts - a.r.proj.pts).slice(0, 3)
      .map((x) => `<span class="pp" title="${esc(`${x.p.name}: ${fmt(x.r.proj.pts, 2)} pts, ${fmt(x.r.proj.sog, 1)} shots projected · P(1+ pt) ${pct(x.r.probs.pts[0])} · P(goal) ${pct(x.r.probs.g[0])}`)}"><span class="pos">${x.p.pos}</span> ${esc(shortName(x.p.name))} <strong>${pct(x.r.probs.pts[0])}</strong> <span class="rk">${fmt(x.r.proj.sog, 1)} SOG</span></span>`).join('');
    const goalieLine = (team, gs) => (gs ? `<span class="pp" title="${esc(`${gs.name}: probable, not confirmed (${gs.reason}). Projected ${fmt(gs.sa, 1)} shots against × ${(gs.sv * 100).toFixed(1)}% save rate.`)}"><span class="pos">G</span> ${esc(shortName(gs.name))} <strong>${fmt(gs.saves, 1)}</strong> <span class="rk">saves</span></span>` : '');
    return `<div class="card game" data-game="${g.game_id}">
      <div class="teams"><span>${g.away}</span><span class="vs">@</span><span>${g.home}</span></div>
      ${winBar(g, p)}
      ${upset}
      <div class="when">${final ? `Final ${g.away} ${g.away_score} – ${g.home} ${g.home_score}` : esc(faceoff(g))} · ${esc(g.venue ?? '')}${restBadges(g, p)}</div>
      <table class="preview">
        <tr><td class="l">Proj. score</td><td>${g.away} ${fmt(p.ptsAway, 1)} – ${g.home} ${fmt(p.ptsHome, 1)}</td></tr>
        <tr><td class="l">Total goals</td><td>${fmt(p.total, 1)} <span class="rk">o5.5 ${pct(p.pOver55)} · o6.5 ${pct(p.pOver65)}</span></td></tr>
        <tr><td class="l">Puck line</td><td>${g.home} −1.5 ${pct(p.pHomeMinus15)} <span class="rk">${g.away} +1.5 ${pct(1 - p.pHomeMinus15)}</span></td></tr>
      </table>
      <div class="preview-players">
        <div class="pp-team"><span class="pp-label">${g.away}</span>${goalieLine(g.away, ga)}${top(g.away)}</div>
        <div class="pp-team"><span class="pp-label">${g.home}</span>${goalieLine(g.home, gh)}${top(g.home)}</div>
      </div>
      <div class="small muted">Player %: chance of 1+ point. Goalies: probable, not confirmed.</div>
    </div>`;
  });
  return `<div class="toolbar"><strong>${esc(dayLabel(state.week))}</strong>${seg('weekSort', [['time', 'By puck drop'], ['upset', 'By upset chance']])}<span class="muted">Game model, probable goalies and top skaters. Click a game for everything. ${sampleNote()}</span></div>
    ${upsetSummary(games)}
    ${modelPicksCard(dayGames())}
    <div class="grid games">${cards.join('')}</div>`;
}

function winBar(g, p) {
  return `<div class="winbar" title="Model win probability (overtime and shootouts included)">
    <span class="wb-away" style="width:${((1 - p.pHome) * 100).toFixed(1)}%">${pct(1 - p.pHome)}</span>
    <span class="wb-home" style="width:${(p.pHome * 100).toFixed(1)}%">${pct(p.pHome)}</span>
  </div>`;
}

// Model picks for the day: winner, puck line and total, graded once final.
function modelPicksCard(games) {
  if (!games.length) return '';
  const res = (ok) => (ok == null ? '<span class="muted">–</span>' : `<span class="res ${ok ? 'res-hit' : 'res-miss'}">${ok ? '✓' : '✗'}</span>`);
  const t = { w: [0, 0], pl: [0, 0], ou: [0, 0] };
  const rows = games.map((g) => {
    const p = gameModel.predict(g);
    const pick = p.pHome >= 0.5 ? g.home : g.away, pickP = Math.max(p.pHome, 1 - p.pHome);
    // Puck line: home −1.5 or away +1.5, whichever the model gives 50%+.
    const homePl = p.pHomeMinus15 >= 0.5;
    const over = p.pOver55 >= 0.5;
    const final = g.home_score != null;
    const margin = final ? g.home_score - g.away_score : null;
    const winOk = final ? (margin > 0 ? g.home : g.away) === pick : null;
    const plOk = final ? (margin >= 2) === homePl : null;
    const ouOk = final ? (g.home_score + g.away_score > 5.5) === over : null;
    for (const [k, v] of [['w', winOk], ['pl', plOk], ['ou', ouOk]]) if (v != null) { t[k][0] += v ? 1 : 0; t[k][1]++; }
    return `<tr><td class="l"><a href="#matchups/${g.game_id}">${g.away} @ ${g.home}</a></td>
      <td class="l"><strong>${pick}</strong> ${pct(pickP)}</td><td>${res(winOk)}</td>
      <td class="l">${homePl ? `${g.home} −1.5` : `${g.away} +1.5`} <span class="rk">${pct(homePl ? p.pHomeMinus15 : 1 - p.pHomeMinus15)}</span></td><td>${res(plOk)}</td>
      <td class="l">${over ? 'Over' : 'Under'} 5.5 <span class="rk">${pct(over ? p.pOver55 : 1 - p.pOver55)} · proj ${fmt(p.total, 1)}</span></td><td>${res(ouOk)}</td>
      <td>${final ? `${g.away_score}–${g.home_score}` : '<span class="muted">–</span>'}</td></tr>`;
  }).join('');
  const rec = (x) => (x[1] ? ` <strong>${x[0]}-${x[1] - x[0]}</strong>` : '');
  const r = record?.picks;
  const note = r ? `Backtest (${record.games.n} games): the model's winner was right ${pct(r.winner)} of the time and its total 5.5 side ${pct(r.total)}. No free NHL betting lines, so these are the model's own numbers; win % includes overtime and shootouts.` : '';
  return `<div class="card" style="margin-bottom:12px"><h3>Model picks</h3>
    <div class="tbl-wrap"><table>
      <tr><th class="l">Game</th><th class="l">Model winner</th><th>${rec(t.w)}</th><th class="l">Puck line</th><th>${rec(t.pl)}</th><th class="l">Total</th><th>${rec(t.ou)}</th><th>Final</th></tr>
      ${rows}</table></div>
    <p class="small muted">${note}</p></div>`;
}

function upsetSummary(games) {
  const open = games.filter((g) => g.home_score == null);
  const r = record?.games;
  const hist = r ? ` In backtests the model's favorite lost <strong>${pct(r.favLost)}</strong> of games: hockey is close to a coin flip, so upsets are normal.` : '';
  if (!open.length) {
    const hits = games.filter((g) => { const u = upsetInfo(g); return (g.home_score > g.away_score ? g.home : g.away) === u.dogTeam; });
    return `<div class="card upset-summary"><strong>${hits.length} upset${hits.length === 1 ? '' : 's'}</strong> out of ${games.length} games${hits.length ? `: ${hits.map((g) => upsetInfo(g).dogTeam).join(', ')}` : ''}.${hist}</div>`;
  }
  const expected = open.reduce((s, g) => s + upsetInfo(g).dog, 0);
  return `<div class="card upset-summary"><strong>Upset watch:</strong> expect about <strong>${expected.toFixed(1)}</strong> upsets in ${open.length} games (the sum of each underdog's chance).${hist}
    <span class="muted small">No free NHL betting lines, so these are the model's own numbers; win % includes overtime and shootouts.</span></div>`;
}

const C_GAME = sport.projection.game;
const restText = (t, b2b, rest) => (b2b ? `<strong>${t} on a back-to-back</strong>` : rest == null ? `${t}: first game` : `${t}: ${rest - 1} day${rest === 2 ? '' : 's'} rest`);
function restBadges(g, p) {
  const tired = [[g.away, p.b2bAway], [g.home, p.b2bHome]].filter(([, b]) => b).map(([t]) => t);
  return tired.length ? ` <span class="badge alert" title="Played yesterday: second night of a back-to-back (the model docks these teams' goals)">${tired.join(' & ')} B2B</span>` : '';
}

const shortName = (n) => n; // fastRhockey names are already short ("C. McDavid")

// ------------------------------------------------------------- game page ----
function viewGame() {
  const g = data.schedule.find((x) => String(x.game_id) === state.game);
  if (!g) return '<button class="back">← All games</button><div class="card">Game not found for this season.</div>';
  const { p, dogTeam, dog } = upsetInfo(g);
  const gh = goalieSaves(sport, projector.ctx, g.home, g.away, true, g), ga = goalieSaves(sport, projector.ctx, g.away, g.home, false, g);
  const gRow = (team, gs) => (gs ? `<tr><td class="l">${team} goalie</td><td class="l">${esc(gs.name)} <span class="rk">probable: ${esc(gs.reason)}</span></td><td>${fmt(gs.sa, 1)} SA × ${(gs.sv * 100).toFixed(1)}% = <strong>${fmt(gs.saves, 1)} saves</strong></td><td class="l">${gs.probs.map((x) => `o${x.line} ${pct(x.p)}`).join(' · ')}</td></tr>` : '');
  const rows = skaterRows([g]);
  const teamRows = sport.teamStats.map((s) => {
    const side = (off, def) => {
      const o = model.teamStat(off, s.id, 'off'), d = model.teamStat(def, s.id, 'def');
      return { o, d, edge: o.rank != null && d.rank != null ? d.rank - o.rank : null };
    };
    return { s, A: side(g.away, g.home), B: side(g.home, g.away) };
  });
  const vr = (v, d) => `${fmt(v.value, d)}<span class="rk">${ordinal(v.rank)}</span>`;
  const eb = (e) => `<span class="edge" style="background:${edgeColor(e, (model.N - 1) * 0.85)}">${signed(e)}</span>`;
  return `<button class="back">← All games</button>
    <div class="matchup-head"><h2>${esc(teamName(g.away))} @ ${esc(teamName(g.home))}</h2><span class="muted">${g.home_score != null ? `Final ${g.away_score} – ${g.home_score}` : esc(`${dayLabel(g.week)} ${faceoff(g)}`)} · ${esc(g.venue ?? '')}</span></div>
    <div class="stack">
      <div class="card"><h3>Game projection</h3>
        <div class="tbl-wrap"><table>
          <tr><td class="l">Score</td><td class="l" colspan="3">${g.away} ${fmt(p.ptsAway, 2)} – ${g.home} ${fmt(p.ptsHome, 2)} expected goals</td></tr>
          <tr><td class="l">Win %</td><td class="l" colspan="3">${g.home} ${pct(p.pHome)} · ${g.away} ${pct(1 - p.pHome)} <span class="rk">tied after regulation ${pct(p.pRegTie)}</span></td></tr>
          <tr><td class="l">Upset chance</td><td class="l" colspan="3">${dogTeam} ${pct(dog)}</td></tr>
          <tr><td class="l">Total goals</td><td class="l" colspan="3">${fmt(p.total, 2)} · over 5.5 ${pct(p.pOver55)} · over 6.5 ${pct(p.pOver65)}</td></tr>
          <tr><td class="l">Puck line</td><td class="l" colspan="3">${g.home} −1.5 ${pct(p.pHomeMinus15)} · ${g.away} +1.5 ${pct(1 - p.pHomeMinus15)}</td></tr>
          <tr><td class="l">Schedule</td><td class="l" colspan="3">${restText(g.away, p.b2bAway, p.restAway)} · ${restText(g.home, p.b2bHome, p.restHome)}${p.b2bHome || p.b2bAway ? ` <span class="rk">a team on a back-to-back is projected ${fmt(C_GAME.b2bFor, 2)} fewer goals for and ${fmt(C_GAME.b2bAgainst, 2)} more against</span>` : ''}</td></tr>
          ${gRow(g.away, ga)}${gRow(g.home, gh)}
        </table></div>
        <p class="muted small">${record?.games ? `Backtest (${record.games.n} games): win % log loss ${record.games.winLL.toFixed(3)} vs ${record.games.naiveLL.toFixed(3)} for "home team always ${pct(record.games.homeRate)}"; total goals off by ${record.games.totMae.toFixed(2)} on average. Probable goalies were right ${pct(record.goalies.starterRight)} of the time.` : ''}</p>
      </div>
      <div class="card"><h3>Skater props</h3>${propsTable('game-props', rows)}</div>
      <div class="card"><h3>Team matchup</h3>
        <div class="tbl-wrap"><table>
          <tr><th class="l">Stat</th><th>${g.away} off</th><th>${g.home} def</th><th class="c">${g.away} edge</th><th>${g.home} off</th><th>${g.away} def</th><th class="c">${g.home} edge</th></tr>
          ${teamRows.map(({ s, A, B }) => `<tr><td class="l" ${s.note ? `title="${esc(s.note)}"` : ''}>${s.label}</td><td>${vr(A.o, s.fmt)}</td><td>${vr(A.d, s.fmt)}</td><td class="c">${eb(A.edge)}</td><td>${vr(B.o, s.fmt)}</td><td>${vr(B.d, s.fmt)}</td><td class="c">${eb(B.edge)}</td></tr>`).join('')}
        </table></div>
      </div>
    </div>`;
}

// ------------------------------------------------------- player edges ----
const EDGE_METRICS = [['pts', 'Points', 2], ['sog', 'Shots', 2], ['g', 'Goals', 2], ['a', 'Assists', 2], ['blk', 'Blocks', 2]];

function viewEdges() {
  const N = model.N;
  const k = state.edgeMetric;
  const [, mLabel, d] = EDGE_METRICS.find((m) => m[0] === k);
  const scoring = k === 'pts' || k === 'g' || k === 'a';
  let rows = coreOnly(skaterRows(shownGames())).map((x) => {
    const s = model.posStat(x.r.opp, x.p.pos, k, 'def');
    // Regressed toward 1 by the opponent's games played (raw early-season
    // numbers swing wildly), same as the projection model.
    const raw = s.value != null && s.leagueAvg > 0.01 ? s.value / s.leagueAvg : null;
    const n = model.team[x.r.opp]?.n ?? 0;
    const mult = raw == null ? null : 1 + (raw - 1) * (n / (n + sport.projection.regress.opponent));
    return { ...x, s, raw, mult, sit: projector.situation(x.p, x.r.game), og: x.r.oppGoalie, oppSa: model.teamStat(x.r.opp, 'sog', 'def') };
  });
  if (state.pos !== 'ALL') rows = rows.filter((x) => x.p.pos === state.pos);
  const q = state.search.trim().toLowerCase();
  if (q) rows = rows.filter((x) => x.p.name.toLowerCase().includes(q) || x.p.team.toLowerCase() === q);
  const lgSv = projector.ctx.lgSvPct;
  const spot = (x) => {
    const t = x.sit, chips = [];
    if (t.oppB2b) chips.push(`<span class="chip" style="background:${edgeColor(1, 2)}" title="Opponent played yesterday">${x.r.opp} on B2B</span>`);
    if (t.ownB2b) chips.push(`<span class="chip" style="background:${edgeColor(-1, 2)}" title="His team played yesterday">${x.p.team} on B2B</span>`);
    if (!t.ownB2b && t.rest != null && t.rest >= 4) chips.push(`<span class="chip ctx">${t.rest - 1} days off</span>`);
    const sp = t.split[k];
    if (t.nVenue >= 10 && t.nOther >= 10 && sp.other > 0.05) {
      const r = sp.venue / sp.other - 1;
      if (Math.abs(r) >= 0.25) chips.push(`<span class="chip ctx" title="His own ${mLabel.toLowerCase()} per game ${t.isHome ? 'at home' : 'on the road'} vs ${t.isHome ? 'away' : 'home'} (this + last season). Shown for context: personal splits didn't predict better in backtests.">${fmt(sp.venue, d)} ${t.isHome ? 'home' : 'road'} vs ${fmt(sp.other, d)} ${t.isHome ? 'road' : 'home'}</span>`);
    }
    if (t.last5 && x.p.avg[k] > 0.05) {
      const r = t.last5[k] / x.p.avg[k] - 1;
      if (Math.abs(r) >= 0.4) chips.push(`<span class="chip ctx" title="Last 5 games vs season average. Context only: streaks didn't predict better in backtests.">${r > 0 ? 'Hot' : 'Cold'}: ${fmt(t.last5[k], d)} last 5</span>`);
    }
    return chips.join('') || '<span class="muted">–</span>';
  };
  const cols = [
    { id: 'name', label: 'Player', cls: 'l', sort: (x) => x.p.name, cell: (x) => esc(x.p.name) },
    { id: 'pos', label: 'Pos', cls: 'c', sort: (x) => x.p.pos, cell: (x) => `<span class="pos">${x.p.pos}</span>` },
    { id: 'game', label: 'Game', cls: 'l', sort: (x) => x.p.team, cell: (x) => `${x.p.team} <span class="vs">${x.r.isHome ? 'vs' : '@'}</span> ${x.r.opp}` },
    { id: 'gp', label: 'GP', sort: (x) => x.p.n, cell: (x) => x.p.n },
    { id: 'toi', label: 'TOI', sort: (x) => x.p.avg.toi, cell: (x) => fmt(x.p.avg.toi, 1) },
    { id: 'avg', label: `${mLabel}/G`, title: `His ${mLabel.toLowerCase()} per game (sample above)`, sort: (x) => x.p.avg[k], cell: (x) => fmt(x.p.avg[k], d) },
    {
      id: 'allow', label: 'Opp allows to pos', title: `${mLabel} per game the opponent allows to his position (rank: 1 = stingiest, ${N} = most generous)`,
      sort: (x) => x.s.value, bg: (x) => edgeColor(x.s.rank != null ? x.s.rank - (N + 1) / 2 : null, (N - 1) / 2),
      cell: (x) => `${fmt(x.s.value, d)}<span class="rk">${ordinal(x.s.rank)}</span>`,
    },
    {
      id: 'mult', label: 'Matchup ×', title: `Opponent allowed ÷ league average allowed to this position, regressed toward 1.00 by games played (${sport.projection.regress.opponent} games = halfway). Hover a cell for the raw number.`,
      sort: (x) => x.mult, bg: (x) => edgeColor(x.mult != null ? (x.mult - 1) * 100 : null, 20),
      cell: (x) => (x.mult == null ? '–' : `<span title="raw ${x.raw.toFixed(2)}×">${x.mult.toFixed(2)}×</span>`),
    },
    { id: 'adj', label: `Adj ${mLabel}/G`, title: `${mLabel}/G × matchup multiplier (raw, no other factors)`, sort: (x) => (x.mult == null ? null : x.p.avg[k] * x.mult), cell: (x) => (x.mult == null ? '–' : fmt(x.p.avg[k] * x.mult, d)) },
    {
      id: 'goalie', label: 'Opp goalie', title: 'Probable opposing goalie and save % (this + last season, regressed). Green = leaky goalie (good for scorers).',
      sort: (x) => (x.og ? -x.og.sv : null), bg: (x) => (x.og && (scoring || k === 'sog') ? edgeColor((lgSv - x.og.sv) * 1000, 15) : ''),
      cell: (x) => (x.og ? `${esc(x.og.name)} <span class="rk">${(x.og.sv * 100).toFixed(1)}%</span>` : '–'),
    },
    {
      id: 'oppsa', label: 'Opp shots allowed', title: `Shots per game the opponent allows (rank: 1 = fewest)`,
      sort: (x) => x.oppSa.value, bg: (x) => edgeColor(x.oppSa.rank != null ? x.oppSa.rank - (N + 1) / 2 : null, (N - 1) / 2),
      cell: (x) => `${fmt(x.oppSa.value, 1)}<span class="rk">${ordinal(x.oppSa.rank)}</span>`,
    },
    {
      id: 'model', label: 'Model', title: `Full model projection (everything that backtested well: opponent, home ice, goalie, ice-time trend) and change vs his average`,
      sort: (x) => (x.r.base[k] ? x.r.proj[k] / x.r.base[k] : null), bg: (x) => edgeColor(x.r.base[k] ? (x.r.proj[k] / x.r.base[k] - 1) * 100 : null, 25),
      cell: (x) => { const r = x.r.base[k] ? x.r.proj[k] / x.r.base[k] - 1 : 0; return `<strong>${fmt(x.r.proj[k], d)}</strong> <span class="rk">${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(0)}%</span>`; },
    },
    { id: 'spot', label: 'Spot', cls: 'l wrap', title: 'Back-to-backs, rest, his home/road split and streaks', cell: (x) => `<div class="chips">${spot(x)}</div>` },
  ];
  return `<div class="toolbar">
      ${seg('edgeMetric', EDGE_METRICS.map(([v, l]) => [v, l]))}
      ${seg('pos', [['ALL', 'All'], ['C', 'C'], ['W', 'W'], ['D', 'D']])}
      ${coreSeg()}
      <input id="search" type="search" placeholder="Player or team…" value="${esc(state.search)}">
      <span class="spacer"></span>
      <span class="muted">Every skater playing ${esc(dayLabel(state.week))} vs what tonight's opponent allows to his position. Green = soft matchup. ${sampleNote()}</span>
    </div>
    <div class="card">${table(`edges-${k}`, cols, rows, { col: 'mult', asc: false })}</div>`;
}

// --------------------------------------------------------- top picks ----
const pp = (x) => `${(x * 100).toFixed(0)}%`;
const resCell = (res) => (!res ? '<span class="muted">pending</span>'
  : res.void ? '<span class="muted" title="Did not play / goalie did not start">void</span>'
  : `<span class="res ${res.hit ? 'res-hit' : 'res-miss'}">${res.hit ? '✓' : '✗'} ${res.actual}</span>`);
const tallyText = (t) => (t.n ? `<strong>${t.hits}-${t.n - t.hits}</strong> (${pct(t.hits / t.n)})` : '<span class="muted">–</span>');

function currentPicks() {
  // Ranked by something other than edge, or one market: re-rank live.
  if (state.pickRank !== 'edge' || state.pickMarket !== 'all' || +state.pickMin > 0) {
    const pk = nhlDayPicks(sport, data, history, state.week, { games: shownGames(), ...(state.lastN ? {} : { model }) });
    const cands = state.pickMarket === 'all' ? pk.props : pk.props.filter((x) => x.market === state.pickMarket);
    return { ...pk, ...rankPicks(cands, {
      by: state.pickRank, minProb: +state.pickMin, maxPerMarket: state.pickMarket === 'all' ? { saves: 4 } : {},
      // Model-chance views: no goal/assist unders or 85%+ sides (see confidentProps).
      ...(state.pickRank === 'edge' ? {} : { noUnder: NO_UNDER, maxProb: MAX_CONF }),
    }), source: 'ranked' };
  }
  // Some games filtered out: re-rank within the games shown.
  if (games_.active()) {
    const games = shownGames();
    return { ...nhlDayPicks(sport, data, history, state.week, { games, ...(state.lastN ? {} : { model }) }), source: 'filtered' };
  }
  const date = data.days?.[state.week];
  const lock = locked?.days?.[date];
  if (lock) return { ...lock, source: 'locked' };
  if (!dayPicks) {
    // Same inputs as the locked picks: season-to-date sample, games before this day.
    dayPicks = nhlDayPicks(sport, data, history, state.week, state.lastN ? {} : { model });
  }
  return { ...dayPicks, source: 'live' };
}

function picksTable(id, rows, idx) {
  const cols = [
    { id: 'rank', label: '#', cell: (x) => x.i + 1 },
    { id: 'name', label: 'Player', cls: 'l', cell: (x) => `${esc(x.name)} <span class="pos">${x.pos}</span>` },
    { id: 'game', label: 'Game', cls: 'l', cell: (x) => `${x.team} <span class="vs">${x.home ? 'vs' : '@'}</span> ${x.opp}` },
    { id: 'prop', label: 'Prop', cls: 'l', cell: (x) => `<strong>${x.side === 'over' ? 'Over' : 'Under'} ${x.line}</strong> ${MARKET_LABEL[x.market]}` },
    { id: 'proj', label: 'Proj', title: 'Model projection (his average in small print)', cell: (x) => `<strong>${fmt(x.proj, x.market === 'saves' ? 1 : 2)}</strong> <span class="rk">avg ${fmt(x.base, x.market === 'saves' ? 1 : 2)}</span>` },
    { id: 'p', label: 'Model', title: 'Model chance this side hits (fair odds)', cell: (x) => { const q = x.side === 'over' ? x.p : 1 - x.p; return `<strong>${pp(q)}</strong> <span class="rk">${fairOdds(q)}</span>`; } },
    { id: 'pb', label: 'His avg', title: 'Chance implied by his average alone at this line', cell: (x) => pp(x.side === 'over' ? x.pBase : 1 - x.pBase) },
    {
      id: 'edge', label: 'Edge', title: 'Model chance minus average-only chance, for this side',
      bg: (x) => edgeColor((x.side === 'over' ? x.edge : -x.edge) * 100, 15),
      cell: (x) => { const e = Math.round((x.side === 'over' ? x.edge : -x.edge) * 100); return e >= 0 ? `+${e}` : `−${-e}`; },
    },
    { id: 'why', label: 'Why', cls: 'l wrap', cell: (x) => `<span class="small muted">${esc((x.why || []).join(' · '))}</span>` },
    { id: 'res', label: 'Result', cls: 'c', cell: (x) => resCell(gradeProp(x, data, idx)) },
  ];
  return table(id, cols, rows.map((x, i) => ({ ...x, i })), null);
}

function viewPicks() {
  const pk = currentPicks();
  const idx = indexResults(data);
  const date = data.days?.[state.week];
  const tOver = tally(pk.over.map((x) => ({ x, res: gradeProp(x, data, idx) })));
  const tUnder = tally(pk.under.map((x) => ({ x, res: gradeProp(x, data, idx) })));
  const games = pk.games.map((x) => ({ x, r: gradeGame(x, data, idx) }));
  const status = pk.source === 'ranked'
    ? `<span class="badge alert">Re-ranked</span> By ${RANK_LABELS[state.pickRank].toLowerCase()}${state.pickMarket !== 'all' ? `, ${MARKET_LABEL[state.pickMarket].toLowerCase()} only` : ''}${+state.pickMin > 0 ? `, model ${Math.round(state.pickMin * 100)}%+ only` : ''}, computed live. The Scorecard grades the default list (all markets, ranked by edge).`
    : pk.source === 'filtered'
    ? `<span class="badge alert">Filtered</span> Top picks re-ranked within the ${pk.games.length} game${pk.games.length === 1 ? '' : 's'} selected. The Scorecard grades the full-day list.`
    : pk.source === 'locked' && Date.now() < new Date(pk.locks_at).getTime()
    ? `<span class="badge alert">Saved</span> Snapshot ${esc(new Date(pk.locked_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}. Updates with new data until the first puck drop (${esc(new Date(pk.locks_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}), then locks for the Scorecard.`
    : pk.source === 'locked'
    ? `<span class="badge pick">Locked</span> Saved ${esc(new Date(pk.locked_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}, before puck drop${pk.partial ? ` (only the ${pk.games.length} games not yet started at that time)` : ''}. These count on the Scorecard.`
    : (date && date >= new Date().toISOString().slice(0, 10)
      ? '<span class="badge alert">Preview</span> Not locked yet: these lock automatically before the first game and can still change until then.'
      : '<span class="badge alert">Recomputed</span> No locked picks for this day (before the scorecard started), so these are recomputed now from games before this date. Not counted on the live Scorecard.');
  const gRows = games.map(({ x, r }) => `<tr><td class="l">${x.away} @ ${x.home}</td>
      <td class="l"><strong>${x.winner}</strong> ${pct(x.pWin)}</td><td>${r ? resCell({ hit: r.hitWin, actual: r.winner }) : resCell(null)}</td>
      <td class="l"><strong>${x.pOver55 >= 0.5 ? 'Over' : 'Under'} 5.5</strong> ${pct(x.pOver55 >= 0.5 ? x.pOver55 : 1 - x.pOver55)} <span class="rk">proj ${fmt(x.total, 1)}</span></td><td>${r ? resCell({ hit: r.hitTotal, actual: r.total }) : resCell(null)}</td></tr>`).join('');
  return `<div class="toolbar"><strong>${esc(dayLabel(state.week))}</strong>
      <span class="muted small">Rank by</span>${seg('pickRank', Object.entries(RANK_LABELS))}
      ${seg('pickMarket', [['all', 'All'], ...Object.entries(MARKET_LABEL)])}
      <span class="muted small">Model chance</span>${seg('pickMin', MIN_PROB)}</div>
    <div class="toolbar"><span class="muted">${status}</span></div>
    <div class="card upset-summary">Top 20 overs: ${tallyText(tOver)} · Top 20 unders: ${tallyText(tUnder)}
      · Winners: ${tallyText({ n: games.filter((g) => g.r).length, hits: games.filter((g) => g.r?.hitWin).length })}
      · Totals: ${tallyText({ n: games.filter((g) => g.r).length, hits: games.filter((g) => g.r?.hitTotal).length })}
      ${confidenceLine(record?.picks, state.pickMarket, MARKET_LABEL[state.pickMarket])}
      <div class="small muted">Only each team's top 9 forwards and top 4 defensemen by recent ice time (the players books post props for). No free NHL prop lines, so each line is the one a book would most likely post: the half-goal nearest his own average (shots, blocks, saves) or 0.5 (points, goals, assists). Edge = how far tonight's matchup moves the model's chance off what his average alone implies. Real books shade lines too, so compare with the actual line before betting. Goalies are probable, not confirmed (a different starter = void).</div></div>
    <div class="stack">
      <div class="card"><h3>Top 20 overs</h3>${picksTable('pick-over', pk.over, idx)}</div>
      <div class="card"><h3>Top 20 unders</h3>${picksTable('pick-under', pk.under, idx)}</div>
    </div>
    <div class="card" style="margin-top:12px"><h3>Game picks</h3><div class="tbl-wrap"><table>
      <tr><th class="l">Game</th><th class="l">Winner</th><th>Result</th><th class="l">Total</th><th>Result</th></tr>${gRows}</table></div></div>`;
}


// Backtest: hit rate of every prop by the model's chance for its side.
function confidenceLine(rec, market, label) {
  const bs = (market !== 'all' && rec?.byProbMarket?.[market]) || rec?.byProb;
  if (!bs) return '';
  const cells = bs.filter((b) => b.n >= 20).map((b) => `<span class="chip" title="${b.n} props">model ${Math.round(b.lo * 100)}${b.hi > 1 ? '+' : `–${Math.round(b.hi * 100)}`}% → <strong>hit ${Math.round(b.hit * 100)}%</strong></span>`).join('');
  return cells ? `<div class="chips" style="margin-top:6px"><span class="small muted">Backtest${market !== 'all' ? ` (${label})` : ''}, every prop on the model's side:</span>${cells}</div>` : '';
}

// --------------------------------------------------------- scorecard ----
function viewScore() {
  const idx = indexResults(data);
  const days = Object.values(locked?.days ?? {});
  const all = { over: [], under: [] }, mk = {}, perDay = [];
  let gw = 0, gt = 0, gn = 0;
  for (const d of days) {
    const row = { d, over: [], under: [], gw: 0, gt: 0, gn: 0 };
    for (const side of ['over', 'under']) for (const x of d[side]) {
      const r = { x, res: gradeProp(x, data, idx) };
      all[side].push(r); row[side].push(r);
      (mk[`${side}:${x.market}`] ??= []).push(r);
    }
    for (const x of d.games) { const r = gradeGame(x, data, idx); if (!r) continue; row.gn++; row.gw += r.hitWin; row.gt += r.hitTotal; }
    gw += row.gw; gt += row.gt; gn += row.gn;
    perDay.push(row);
  }
  const line = (t) => (t.n ? `${t.hits}-${t.n - t.hits} · <strong>${pct(t.hits / t.n)}</strong> <span class="rk">model ${pct(t.exp / t.n)} · his avg ${pct(t.expBase / t.n)}</span>` : '<span class="muted">none graded yet</span>');
  const beat = (t) => (t.n ? edgeColor(((t.hits - t.expBase) / t.n) * 100, 10) : '');
  const sumCard = (title, t) => `<div class="card"><h3>${title}</h3><div style="background:${beat(t)};padding:6px;border-radius:6px">${line(t)}</div>${t.pending ? `<div class="small muted">${t.pending} pending</div>` : ''}${t.void ? `<div class="small muted">${t.void} void</div>` : ''}</div>`;
  const tO = tally(all.over), tU = tally(all.under);
  const mkRows = Object.entries(mk).sort().map(([k, v]) => { const t = tally(v); const [side, m] = k.split(':'); return t.n ? `<tr><td class="l">${side === 'over' ? 'Over' : 'Under'} ${MARKET_LABEL[m]}</td><td style="background:${beat(t)}">${line(t)}</td></tr>` : ''; }).join('');
  const dayRows = perDay.reverse().map((r) => { const o = tally(r.over), u = tally(r.under); return `<tr><td class="l">${esc(r.d.date)}${r.d.partial ? ' <span class="rk" title="Locked after some games had started: only the later games count">partial</span>' : ''}${Date.now() < new Date(r.d.locks_at).getTime() ? ' <span class="rk">upcoming</span>' : ''}</td><td style="background:${beat(o)}">${tallyText(o)}</td><td style="background:${beat(u)}">${tallyText(u)}</td><td>${r.gn ? `${r.gw}-${r.gn - r.gw}` : '–'}</td><td>${r.gn ? `${r.gt}-${r.gn - r.gt}` : '–'}</td></tr>`; }).join('');
  const B = record?.picks;
  const bLine = (t) => (t ? `${t.hits}-${t.n - t.hits} · <strong>${pct(t.hits / t.n)}</strong> <span class="rk">model ${pct(t.exp / t.n)} · his avg ${pct(t.expBase / t.n)}</span>` : '–');
  const bMk = B ? Object.entries(B.markets).map(([k, t]) => { const [side, m] = k.split(':'); return `<tr><td class="l">${side === 'over' ? 'Over' : 'Under'} ${MARKET_LABEL[m]}</td><td style="background:${beat(t)}">${bLine(t)}</td></tr>`; }).join('') : '';
  return `<div class="toolbar"><strong>Live scorecard</strong><span class="muted">Picks locked before puck drop each day (Top Picks tab), graded when the results come in the next morning. Green = beat what the players' own averages implied, which is the real test of the model.</span></div>
    <div class="grid games">
      ${sumCard('Top 20 overs', tO)}${sumCard('Top 20 unders', tU)}
      <div class="card"><h3>Game winners</h3>${gn ? `${gw}-${gn - gw} · <strong>${pct(gw / gn)}</strong>` : '<span class="muted">none graded yet</span>'}</div>
      <div class="card"><h3>Totals (5.5)</h3>${gn ? `${gt}-${gn - gt} · <strong>${pct(gt / gn)}</strong>` : '<span class="muted">none graded yet</span>'}</div>
    </div>
    <div class="grid two" style="margin-top:12px">
      <div class="card"><h3>By day</h3><div class="tbl-wrap"><table><tr><th class="l">Date</th><th>Overs</th><th>Unders</th><th>Winners</th><th>Totals</th></tr>${dayRows || '<tr><td class="l muted" colspan="5">No locked days yet.</td></tr>'}</table></div></div>
      <div class="card"><h3>By market (live)</h3><div class="tbl-wrap"><table style="width:auto">${mkRows || '<tr><td class="l muted">Nothing graded yet.</td></tr>'}</table></div></div>
    </div>
    ${B ? `<div class="card" style="margin-top:12px"><h3>Backtest: same method on ${B.days} past game days</h3>
      <p class="small muted">Each day re-projected using only earlier games (2025-26 and this season so far). What to expect over a long run; any one night will swing a lot.</p>
      <div class="tbl-wrap"><table style="width:auto">
        <tr><td class="l">Top 20 overs</td><td style="background:${beat(B.over)}">${bLine(B.over)}</td></tr>
        <tr><td class="l">Top 20 unders</td><td style="background:${beat(B.under)}">${bLine(B.under)}</td></tr>
        <tr><td class="l">Game winners</td><td>${pct(B.winner)}</td></tr>
        <tr><td class="l">Totals (5.5)</td><td>${pct(B.total)}</td></tr>
        ${bMk}
      </table></div></div>` : ''}`;
}

// ----------------------------------------------------------- props ----
const why = (r) => r.factors
  .filter((f) => Math.abs(f.impact) >= 0.01 || Math.abs(f.impactSog) >= 0.01)
  .map((f) => { const v = Math.abs(f.impact) >= Math.abs(f.impactSog) ? f.impact : f.impactSog; return `<span class="chip" style="background:${edgeColor(v * 100, 12)}">${esc(f.text)} <strong>${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(0)}%</strong></span>`; })
  .slice(0, 3).join('') || '<span class="muted">≈ his average</span>';

// Props at the line a book would most likely post (as in Top Picks) where the
// model gives one side at least `min`. Leaves out goal / assist unders (books
// rarely offer them) and sides over 85% (priced too steeply to matter).
const NO_UNDER = ['g', 'a'];
const MAX_CONF = 0.85;
function confidentProps(x, min) {
  const out = [];
  for (const [k, mk] of Object.entries(sport.projection.markets)) {
    const line = k === 'sog' || k === 'blk' ? Math.max(0.5, Math.round(x.r.base[k] - 0.5) + 0.5) : 0.5;
    const p = nbAtLeast(x.r.proj[k], mk.r, Math.floor(line) + 1);
    if (p >= min && p <= MAX_CONF) out.push({ k, line, side: 'Over', q: p });
    else if (1 - p >= min && 1 - p <= MAX_CONF && !NO_UNDER.includes(k)) out.push({ k, line, side: 'Under', q: 1 - p });
  }
  return out.sort((a, b) => b.q - a.q);
}

function propsTable(id, rows, { min = 0 } = {}) {
  const P = sport.projection.markets;
  const cell = (x, k, i) => {
    const p = x.r.probs[k][i];
    const base = x.r.base[k] ? x.r.proj[k] / x.r.base[k] - 1 : 0;
    return { p, base };
  };
  const cols = [
    { id: 'name', label: 'Player', cls: 'l', sort: (x) => x.p.name, cell: (x) => esc(x.p.name) },
    { id: 'pos', label: 'Pos', cls: 'c', sort: (x) => x.p.pos, cell: (x) => `<span class="pos">${x.p.pos}</span>` },
    { id: 'game', label: 'Game', cls: 'l', cell: (x) => `${x.p.team} <span class="vs">${x.r.isHome ? 'vs' : '@'}</span> ${x.r.opp}` },
    { id: 'toi', label: 'TOI', title: 'Average minutes', sort: (x) => x.r.base.toi, cell: (x) => fmt(x.r.base.toi, 1) },
    {
      id: 'sog', label: 'Shots', title: `Projected shots on goal · chance of ${P.sog.lines.map((l) => `${Math.ceil(l)}+`).join(' / ')}`,
      sort: (x) => x.r.proj.sog, bg: (x) => edgeColor(cell(x, 'sog', 0).base * 100, 25),
      cell: (x) => `<strong>${fmt(x.r.proj.sog, 2)}</strong> <span class="rk">${x.r.probs.sog.map((p, i) => `${Math.ceil(P.sog.lines[i])}+ ${pct(p)}`).join(' · ')}</span>`,
    },
    {
      id: 'pts', label: 'Points', title: 'Projected points · chance of 1+ (fair odds) / 2+',
      sort: (x) => x.r.proj.pts, bg: (x) => edgeColor(cell(x, 'pts', 0).base * 100, 25),
      cell: (x) => `<strong>${fmt(x.r.proj.pts, 2)}</strong> <span class="rk">1+ ${pct(x.r.probs.pts[0])} (${fairOdds(x.r.probs.pts[0])}) · 2+ ${pct(x.r.probs.pts[1])}</span>`,
    },
    {
      id: 'g', label: 'Goal', title: 'Anytime goal: chance of 1+ goal (fair odds)',
      sort: (x) => x.r.probs.g[0], cell: (x) => `<strong>${pct(x.r.probs.g[0])}</strong> <span class="rk">${fairOdds(x.r.probs.g[0])}</span>`,
    },
    {
      id: 'a', label: 'Assist', title: 'Chance of 1+ assist (fair odds)',
      sort: (x) => x.r.probs.a[0], cell: (x) => `<strong>${pct(x.r.probs.a[0])}</strong> <span class="rk">${fairOdds(x.r.probs.a[0])}</span>`,
    },
    {
      id: 'blk', label: 'Blocks', title: `Projected blocked shots · chance of ${P.blk.lines.map((l) => `${Math.ceil(l)}+`).join(' / ')}`,
      sort: (x) => x.r.proj.blk, bg: (x) => edgeColor(cell(x, 'blk', 0).base * 100, 25),
      cell: (x) => `<strong>${fmt(x.r.proj.blk, 2)}</strong> <span class="rk">${x.r.probs.blk.map((p, i) => `${Math.ceil(P.blk.lines[i])}+ ${pct(p)}`).join(' · ')}</span>`,
    },
    ...(min > 0 ? [{
      id: 'conf', label: 'Confident', cls: 'l wrap', title: `Props at the usual book line where the model gives a side ${Math.round(min * 100)}%+`,
      sort: (x) => x.conf[0]?.q ?? 0,
      cell: (x) => `<div class="chips">${x.conf.map((c) => `<span class="chip" style="background:${c.side === 'Over' ? 'rgba(var(--good-rgb),.25)' : 'rgba(var(--bad-rgb),.2)'}">${c.side} ${c.line} ${MARKET_LABEL[c.k]} <strong>${pct(c.q)}</strong></span>`).join('')}</div>`,
    }] : []),
    { id: 'why', label: 'Why', cls: 'l wrap', cell: (x) => `<div class="chips">${why(x.r)}</div>` },
  ];
  if (min > 0) rows = rows.map((x) => ({ ...x, conf: confidentProps(x, min) })).filter((x) => x.conf.length);
  return table(id, cols, rows, min > 0 ? { col: 'conf', asc: false } : { col: 'pts', asc: false });
}

function goaliesTable(games) {
  const rows = games.flatMap((g) => [[g.away, g.home, false], [g.home, g.away, true]].map(([t, o, h]) => ({ t, o, h, g, s: goalieSaves(sport, projector.ctx, t, o, h, g) }))).filter((x) => x.s);
  const cols = [
    { id: 'name', label: 'Goalie', cls: 'l', sort: (x) => x.s.name, cell: (x) => `${esc(x.s.name)} <span class="rk">probable</span>` },
    { id: 'game', label: 'Game', cls: 'l', cell: (x) => `${x.t} <span class="vs">${x.h ? 'vs' : '@'}</span> ${x.o}` },
    { id: 'why', label: 'Why him', cls: 'l wrap', cell: (x) => `<span class="small muted">${esc(x.s.reason)}</span>` },
    { id: 'sa', label: 'Shots against', title: 'Opponent shot volume × this team\'s shot suppression (both regressed to league)', sort: (x) => x.s.sa, cell: (x) => fmt(x.s.sa, 1) },
    { id: 'sv', label: 'Save %', title: 'This + last season, regressed toward league average by shots faced', sort: (x) => x.s.sv, cell: (x) => `${(x.s.sv * 100).toFixed(1)}%` },
    { id: 'saves', label: 'Saves', sort: (x) => x.s.saves, cell: (x) => `<strong>${fmt(x.s.saves, 1)}</strong>` },
    { id: 'lines', label: 'Over chance', cls: 'l', cell: (x) => x.s.probs.map((l) => `o${l.line} ${pct(l.p)}`).join(' · ') },
  ];
  return table('goalies', cols, rows, { col: 'saves', asc: false });
}

// Smash / dud spots: the chance a prop at the usual book line clears it by a
// wide margin (or falls well short). Same players as Top Picks.
function smashTableNhl(id, rows, kind, idx) {
  const smash = kind === 'smash';
  const cols = [
    { id: 'name', label: 'Player', cls: 'l', cell: (x) => `${esc(x.name)} <span class="pos">${x.pos}</span>` },
    { id: 'game', label: 'Game', cls: 'l', cell: (x) => `${x.team} <span class="vs">${x.home ? 'vs' : '@'}</span> ${x.opp}` },
    { id: 'prop', label: 'Line', cls: 'l', cell: (x) => `${x.line} ${MARKET_LABEL[x.market]}` },
    { id: 'proj', label: 'Proj', sort: (x) => x.proj, cell: (x) => `<strong>${fmt(x.proj, x.market === 'saves' ? 1 : 2)}</strong>` },
    { id: 'vs', label: 'vs Line', sort: (x) => x.proj / x.line - 1, bg: (x) => edgeColor((x.proj / x.line - 1) * 100, 60), cell: (x) => { const v = Math.round((x.proj / x.line - 1) * 100); return v >= 0 ? `+${v}%` : `−${-v}%`; } },
    { id: 'p', label: smash ? 'Over' : 'Under', title: 'Model chance of clearing the line on this side', sort: (x) => (smash ? x.p : 1 - x.p), cell: (x) => pct(smash ? x.p : 1 - x.p) },
    {
      id: 'ps', label: smash ? 'Boom' : 'Bust', sort: (x) => (smash ? x.pSmash : x.pDud),
      title: smash ? 'Chance of clearing the line by 40%+ and by at least 1 (shots, blocks, points, goals, assists) or 5 saves' : 'Chance of falling 40%+ short (same minimum margins)',
      bg: (x) => (smash ? `rgba(var(--good-rgb), ${Math.min(0.6, x.pSmash)})` : `rgba(var(--bad-rgb), ${Math.min(0.6, x.pDud)})`),
      cell: (x) => `<strong>${pct(smash ? x.pSmash : x.pDud)}</strong> <span class="rk">${smash ? `${x.smash}+` : `≤ ${x.dud}`}</span>`,
    },
    {
      id: 'res', label: 'Result', cls: 'c',
      cell: (x) => {
        const r = gradeProp({ ...x, side: 'over' }, data, idx);
        if (!r) return '<span class="muted">pending</span>';
        if (r.void) return '<span class="muted">void</span>';
        const hit = smash ? r.actual >= x.smash : r.actual <= x.dud;
        const clear = smash ? r.actual > x.line : r.actual < x.line;
        return `<span class="res ${hit ? 'res-hit' : clear ? '' : 'res-miss'}">${hit ? '✓✓' : clear ? '✓' : '✗'} ${r.actual}</span>`;
      },
    },
  ];
  return table(id, cols, rows, { col: 'ps', asc: false });
}

function viewSmashNhl() {
  const pk = nhlDayPicks(sport, data, history, state.week, { games: shownGames(), ...(state.lastN ? {} : { model }), ...(state.core === 'all' ? { coverage: null } : {}) });
  let props = pk.props;
  if (state.pos !== 'ALL') props = props.filter((x) => x.pos === state.pos);
  const q = state.search.trim().toLowerCase();
  if (q) props = props.filter((x) => x.name.toLowerCase().includes(q) || x.team.toLowerCase() === q);
  const idx = indexResults(data);
  const smash = [...props].sort((a, b) => b.pSmash - a.pSmash).slice(0, 20);
  const dud = props.filter((x) => x.dud != null && x.pDud > 0).sort((a, b) => b.pDud - a.pDud).slice(0, 20);
  const cal = (bs) => (bs ? bs.filter((b) => b.n >= 100).map((b) => `<span class="chip">model ${Math.round(b.pred * 100)}% → <strong>${Math.round(b.hit * 100)}%</strong></span>`).join('') : '');
  const rec = record?.picks;
  return `<div class="stack">
      <div class="card"><h3>Boom on the line</h3>
        <p class="small muted">Props at the usual book line the model expects him to clear comfortably: 40%+ over the line and by at least 1 (shots, blocks, points, goals, assists) or 5 saves, e.g. 4+ shots on a 2.5 line, 2+ points on 0.5. Click a column to sort. Result: ✓✓ boomed · ✓ cleared the line only · ✗ missed.</p>
        <div class="chips">${cal(rec?.smash) ? `<span class="small muted">Backtest:</span>${cal(rec.smash)}` : ''}</div>
        ${smashTableNhl('nhl-smash', smash, 'smash', idx)}</div>
      <div class="card"><h3>Bust on the line</h3>
        <p class="small muted">The chance he falls 40%+ short (lines of 1.5+; e.g. 1 or fewer shots on a 2.5 line, 2 or fewer on 3.5): strong unders. Result: ✓✓ busted · ✓ under only · ✗ went over.</p>
        <div class="chips">${cal(rec?.dud) ? `<span class="small muted">Backtest:</span>${cal(rec.dud)}` : ''}</div>
        ${smashTableNhl('nhl-dud', dud, 'dud', idx)}</div>
    </div>`;
}

function viewProps() {
  const games = shownGames();
  const skaters = state.propView === 'skaters';
  const smashV = state.propView === 'smash';
  let rows = skaters ? coreOnly(skaterRows(games)) : [];
  if (state.pos !== 'ALL') rows = rows.filter((x) => x.p.pos === state.pos);
  const q = state.search.trim().toLowerCase();
  if (q) rows = rows.filter((x) => x.p.name.toLowerCase().includes(q) || x.p.team.toLowerCase() === q);
  const rec = record?.calib;
  const calib = rec ? `Backtested: shots 2.5+ predicted 41% → actual ${pct(rec['sog_2.5']?.find((b) => b.lo === 0.35)?.act)}; 1+ point predicted 42% → ${pct(rec['pts_0.5']?.find((b) => b.lo === 0.35)?.act)}.` : '';
  return `<div class="toolbar">
      ${seg('propView', [['skaters', 'Skaters'], ['goalies', 'Goalie saves'], ['smash', 'Boom / bust on the line']])}
      ${skaters || smashV ? seg('pos', [['ALL', 'All'], ['C', 'C'], ['W', 'W'], ['D', 'D']]) : ''}
      ${skaters || smashV ? coreSeg() : ''}
      ${skaters ? `<span class="muted small">Model chance</span>${seg('propMin', MIN_PROB)}` : ''}
      ${skaters || smashV ? `<input id="search" type="search" placeholder="Player or team…" value="${esc(state.search)}">` : ''}
      <span class="spacer"></span>
      <span class="muted">${smashV ? `Skaters and probable goalies at the usual book line (as in Top Picks). ${sampleNote()}` : skaters ? `Average (last season as a 25-game prior) × opponent vs position (shots, blocks), home ice, opposing goalie, ice-time trend. Chances use each stat's backtested spread. ${calib}` : 'Probable goalies (not confirmed: right ~64% of the time in backtests). Saves = shots against × save %.'}${smashV ? '' : ` ${sampleNote()}`}</span>
    </div>
    ${state.propView === 'smash' ? viewSmashNhl() : `<div class="card">${skaters ? propsTable('props', rows, { min: +state.propMin }) : goaliesTable(games)}</div>`}`;
}

// -------------------------------------------------------------- DvP ----
function viewDvp() {
  const N = model.N;
  const opp = new Map(dayGames().flatMap((g) => [[g.home, { opp: g.away, home: true, g }], [g.away, { opp: g.home, home: false, g }]]));
  const metric = state.dvpMetric;
  const rows = model.teams.map((t) => ({ t }));
  const cols = [
    { id: 'team', label: 'Defense', cls: 'l', sort: (r) => r.t, cell: (r) => `<strong>${r.t}</strong> <span class="muted">${esc(teamName(r.t))}</span>` },
    { id: 'gp', label: 'GP', sort: (r) => model.team[r.t].n, cell: (r) => model.team[r.t].n },
    { id: 'faces', label: 'Faces', cls: 'l', cell: (r) => { const o = opp.get(r.t); return o ? `<a href="#matchups/${o.g.game_id}">${o.home ? 'vs' : '@'} ${o.opp}</a>` : '<span class="muted">–</span>'; } },
    ...['C', 'W', 'D'].map((pos) => ({
      id: pos, label: `vs ${POS_NAME[pos]}`, title: `Per game allowed to ${POS_NAME[pos]}. Rank 1 = stingiest, ${N} = most generous`,
      sort: (r) => model.posStat(r.t, pos, metric, 'def').value,
      bg: (r) => { const s = model.posStat(r.t, pos, metric, 'def'); return edgeColor(s.rank != null ? s.rank - (N + 1) / 2 : null, (N - 1) / 2); },
      cell: (r) => { const s = model.posStat(r.t, pos, metric, 'def'); return `${fmt(s.value, 2)}<span class="rk">${ordinal(s.rank)}</span>`; },
    })),
    ...[['sog', 'Shots allowed/G'], ['gf', 'Goals allowed/G']].map(([id, label]) => ({
      id: `t_${id}`, label, sort: (r) => model.teamStat(r.t, id, 'def').value,
      bg: (r) => rankColor(N + 1 - model.teamStat(r.t, id, 'def').rank, N),
      cell: (r) => { const s = model.teamStat(r.t, id, 'def'); return `${fmt(s.value, id === 'sog' ? 1 : 2)}<span class="rk">${ordinal(s.rank)}</span>`; },
    })),
  ];
  return `<div class="toolbar">
      ${seg('dvpMetric', [['pts', 'Points'], ['g', 'Goals'], ['a', 'Assists'], ['sog', 'Shots'], ['blk', 'Blocks']])}
      <span class="spacer"></span>
      <span class="muted">What each defense allows per game to centers, wingers and defensemen. Green = generous (good for the shooter). Blocks = blocked shots those skaters record against this team. ${sampleNote()}</span>
    </div>
    <div class="card">${table('dvp', cols, rows, { col: 'W', asc: false })}</div>`;
}

// --------------------------------------------------------- rankings ----
function viewRankings() {
  const side = state.rankSide, N = model.N;
  const rows = model.teams.map((t) => ({ t }));
  const cols = [
    { id: 'team', label: 'Team', cls: 'l', sort: (r) => r.t, cell: (r) => `<strong>${r.t}</strong> <span class="muted">${esc(teamName(r.t))}</span>` },
    { id: 'gp', label: 'GP', sort: (r) => model.team[r.t].n, cell: (r) => model.team[r.t].n },
    {
      id: 'power', label: 'Power', title: 'Model net rating: goals better than an average team per game (goals and shots, opponent-adjusted)',
      sort: (r) => gameModel.rating(r.t).net, bg: (r) => edgeColor(gameModel.rating(r.t).net * 10, 6),
      cell: (r) => { const x = gameModel.rating(r.t); return `<strong>${x.net >= 0 ? '+' : ''}${x.net.toFixed(2)}</strong>`; },
    },
    ...sport.teamStats.map((s) => ({
      id: s.id, label: s.label, title: s.note,
      sort: (r) => -model.teamStat(r.t, s.id, side).rank,
      bg: (r) => rankColor(model.teamStat(r.t, s.id, side).rank, N),
      cell: (r) => { const v = model.teamStat(r.t, s.id, side); return `${fmt(v.value, s.fmt)}<span class="rk">${ordinal(v.rank)}</span>`; },
    })),
  ];
  return `<div class="toolbar">${seg('rankSide', [['off', 'Offense'], ['def', 'Defense (allowed)']])}<span class="spacer"></span><span class="muted">Rank 1 = best ${side === 'off' ? 'offense' : 'defense'} in that stat. ${sampleNote()}</span></div>
    <div class="card">${table('rank-' + side, cols, rows, { col: 'power', asc: false })}</div>`;
}

boot().catch((err) => {
  $('#view').innerHTML = `<div class="card">Failed to load NHL data: ${esc(err.message)}.<br><span class="muted">Run <code>python pipeline/build_nhl.py</code>.</span></div>`;
  console.error(err);
});
