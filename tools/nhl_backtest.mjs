// NHL backtest: skater props, goalie saves and game predictions.
//
//   node tools/nhl_backtest.mjs                # report
//   node tools/nhl_backtest.mjs --fit          # also write web/data/nhl/nhl_record.json
//
// Each game day (from day 15 on, every 2nd day) is projected using only
// earlier games, with the previous season as history. Reports error and
// calibration for each prop market, the effect of each factor, goalie saves,
// and the game model (win %, totals, how often favorites lost).

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const load = (rel) => import(pathToFileURL(path.join(WEB, rel)).href);
const { default: sport } = await load('js/sports/nhl.js');
const { buildModel } = await load('js/engine.js');
const { buildNhlProjector, buildNhlGameModel, goalieSaves } = await load('js/nhl/model.js');
const { nbAtLeast } = await load('js/props.js');
const { nhlDayPicks, gradeProp, indexResults, tally } = await load('js/nhl/picks.js');
const { probBuckets, modelSide } = await load('js/rankpicks.js');

const FIT = process.argv.includes('--fit');
const read = (s) => {
  const f = path.join(WEB, 'data', 'nhl', `${s}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null;
};
const { seasons } = JSON.parse(fs.readFileSync(path.join(WEB, 'data', 'nhl', 'index.json')));
const P = sport.projection;
const STATS = Object.keys(P.markets);

// ---- collect -------------------------------------------------------------------
const days = [];
for (const season of [...seasons].sort()) {
  const data = read(season), prev = read(season - 1);
  if (!prev) continue; // need a prior season
  const history = [prev];
  for (let d = 15; d <= data.last_week_played; d += 2) {
    const games = data.schedule.filter((g) => g.week === d && g.home_score != null);
    if (!games.length) continue;
    const model = buildModel(sport, data, { beforeWeek: d });
    const actual = new Map(data.player_games.filter((r) => r.week === d).map((r) => [r.id, r]));
    const gActual = new Map((data.goalie_games || []).filter((r) => r.week === d && r.starter).map((r) => [r.team, r]));
    days.push({ season, d, data, history, model, games, actual, gActual });
  }
}

function skaterRows(disabled = []) {
  const out = [];
  for (const day of days) {
    const pr = buildNhlProjector(sport, day.model, { history: day.history, disabled: new Set(disabled) });
    const teams = new Map(day.games.flatMap((g) => [[g.home, g], [g.away, g]]));
    for (const p of day.model.players) {
      if (!p.relevant || !teams.has(p.team)) continue;
      const a = day.actual.get(p.id);
      if (!a) continue;
      out.push({ p, r: pr.project(p, teams.get(p.team)), a });
    }
  }
  return out;
}

const ll = (p, y) => { const q = Math.min(0.99, Math.max(0.01, p)); return -(y ? Math.log(q) : Math.log(1 - q)); };
function score(rows, rs = null) {
  const res = {};
  for (const k of STATS) {
    const mk = P.markets[k];
    const r = rs?.[k] ?? mk.r;
    let abs = 0, loss = 0, n = 0, nl = 0;
    for (const x of rows) {
      const proj = x.r.proj[k], act = x.a[k] || 0;
      abs += Math.abs(proj - act); n++;
      for (const line of mk.lines) { loss += ll(nbAtLeast(proj, r, Math.floor(line) + 1), act > line); nl++; }
    }
    res[k] = { mae: abs / n, ll: loss / nl, n };
  }
  return res;
}
const fmt = (s) => STATS.map((k) => `${k} ${s[k].mae.toFixed(3)}/${s[k].ll.toFixed(4)}`).join('  ');

const full = skaterRows();
console.log(`${full.length} skater-games, ${days.length} game days (seasons with a prior: ${[...new Set(days.map((d) => d.season))].join(', ')})\n`);
console.log('Skater props: MAE / log loss at the market lines (lower is better)');
const plainAvg = skaterRows(['opp', 'home', 'goalie', 'b2b', 'toi']);
console.log(`  average only    ${fmt(score(plainAvg))}`);
console.log(`  full model      ${fmt(score(full))}`);
for (const f of ['opp', 'home', 'goalie']) console.log(`  without ${f.padEnd(7)} ${fmt(score(skaterRows([f])))}`);

// Negative-binomial size per stat: best log loss.
const bestR = {};
for (const k of STATS) {
  let best = null;
  for (const r of [3, 5, 8, 12, 20, 35, 50, 100, 1000]) {
    const s = score(full, { [k]: r })[k].ll;
    if (!best || s < best.s) best = { r, s };
  }
  bestR[k] = best.r;
}
console.log(`\nBest spread (NB size r) per stat: ${JSON.stringify(bestR)}  (config: ${JSON.stringify(Object.fromEntries(STATS.map((k) => [k, P.markets[k].r])))})`);

console.log('\nCalibration at the main lines (predicted → actual over-rate)');
const calib = {};
for (const [k, line] of [['sog', 2.5], ['sog', 1.5], ['pts', 0.5], ['g', 0.5], ['a', 0.5], ['blk', 1.5]]) {
  const xs = full.map((x) => ({ p: nbAtLeast(x.r.proj[k], P.markets[k].r, Math.floor(line) + 1), y: (x.a[k] || 0) > line }));
  const b = [[0, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 1]].map(([lo, hi]) => {
    const s = xs.filter((o) => o.p >= lo && o.p < hi);
    return s.length >= 30 ? { lo, hi, n: s.length, pred: s.reduce((a, o) => a + o.p, 0) / s.length, act: s.filter((o) => o.y).length / s.length } : null;
  }).filter(Boolean);
  calib[`${k}_${line}`] = b.map((x) => ({ lo: x.lo, hi: x.hi, n: x.n, pred: +x.pred.toFixed(3), act: +x.act.toFixed(3) }));
  console.log(`  ${k} over ${line}: ` + b.map((x) => `${(x.pred * 100).toFixed(0)}%→${(x.act * 100).toFixed(0)}% (n=${x.n})`).join(' | '));
}

// ---- goalies --------------------------------------------------------------------
let gAbs = 0, gAbsNaive = 0, gN = 0, gRight = 0, gTot = 0;
for (const day of days) {
  const pr = buildNhlProjector(sport, day.model, { history: day.history });
  for (const g of day.games) for (const [team, opp, home] of [[g.home, g.away, true], [g.away, g.home, false]]) {
    const proj = goalieSaves(sport, pr.ctx, team, opp, home, g);
    const act = day.gActual.get(team);
    if (!proj || !act) continue;
    gTot++;
    if (proj.id === act.id) gRight++;
    if (proj.id !== act.id) continue; // score saves only when the probable goalie started
    const naive = day.data.goalie_games.filter((r) => r.id === proj.id && r.week < day.d && r.starter);
    const nAvg = naive.length ? naive.reduce((s, r) => s + r.saves, 0) / naive.length : proj.saves;
    gAbs += Math.abs(proj.saves - act.saves); gAbsNaive += Math.abs(nAvg - act.saves); gN++;
  }
}
console.log(`\nGoalies: probable starter right ${gRight}/${gTot} (${(100 * gRight / gTot).toFixed(1)}%). Saves MAE ${(gAbs / gN).toFixed(2)} vs his own average ${(gAbsNaive / gN).toFixed(2)} (n=${gN})`);

// ---- games ----------------------------------------------------------------------
const gameRows = [];
for (const day of days) {
  const gm = buildNhlGameModel(sport, day.data, { beforeWeek: day.d, history: day.history, model: day.model });
  for (const g of day.games) gameRows.push({ g, p: gm.predict(g), homeWon: g.home_score > g.away_score, total: g.home_score + g.away_score });
}
const homeRate = gameRows.filter((x) => x.homeWon).length / gameRows.length;
const winLL = gameRows.reduce((s, x) => s + ll(x.p.pHome, x.homeWon), 0) / gameRows.length;
const naiveLL = gameRows.reduce((s, x) => s + ll(homeRate, x.homeWon), 0) / gameRows.length;
const totMae = gameRows.reduce((s, x) => s + Math.abs(x.p.total - x.total), 0) / gameRows.length;
const lgTot = gameRows.reduce((s, x) => s + x.total, 0) / gameRows.length;
const totNaive = gameRows.reduce((s, x) => s + Math.abs(lgTot - x.total), 0) / gameRows.length;
const favLost = gameRows.filter((x) => (x.p.pHome > 0.5) !== x.homeWon).length / gameRows.length;
const o55 = gameRows.reduce((s, x) => s + ll(x.p.pOver55, x.total > 5.5), 0) / gameRows.length;
console.log(`\nGames (${gameRows.length}): win % log loss ${winLL.toFixed(4)} vs "home team ${(homeRate * 100).toFixed(0)}%" ${naiveLL.toFixed(4)}; total goals MAE ${totMae.toFixed(2)} vs league avg ${totNaive.toFixed(2)}; over 5.5 log loss ${o55.toFixed(4)}`);
console.log(`  model favorite lost ${(favLost * 100).toFixed(1)}% of games`);
const dogBuckets = [[0.3, 0.4], [0.4, 0.45], [0.45, 0.5]].map(([lo, hi]) => {
  const xs = gameRows.map((x) => ({ dog: Math.min(x.p.pHome, 1 - x.p.pHome), won: (x.p.pHome < 0.5) === x.homeWon })).filter((o) => o.dog >= lo && o.dog < hi);
  return { lo, hi, n: xs.length, predicted: +(xs.reduce((s, o) => s + o.dog, 0) / (xs.length || 1)).toFixed(3), won: +(xs.filter((o) => o.won).length / (xs.length || 1)).toFixed(3) };
});
for (const b of dogBuckets) console.log(`  underdogs at ${b.lo * 100}–${b.hi * 100}%: n=${b.n} expected ${(b.predicted * 100).toFixed(1)}% won ${(b.won * 100).toFixed(1)}%`);

// ---- daily top 20 overs / unders (same method as the Top Picks tab) -----------
const pickRows = { over: [], under: [] };
const pickMk = {};
const allSides = [], allSidesMk = {}; // every candidate on the model's side (confidence buckets)
const smashRows = [], dudRows = [];
const idxBySeason = new Map();
for (const day of days) {
  if (!idxBySeason.has(day.season)) idxBySeason.set(day.season, indexResults(day.data));
  const pk = nhlDayPicks(sport, day.data, day.history, day.d, { games: day.games, model: day.model });
  for (const p0 of pk.props) {
    const x = modelSide(p0);
    const row = { x, res: gradeProp(x, day.data, idxBySeason.get(day.season)) };
    allSides.push(row);
    if (row.res && !row.res.void) {
      smashRows.push({ p: x.pSmash, y: row.res.actual >= x.smash });
      if (x.dud != null) dudRows.push({ p: x.pDud, y: row.res.actual <= x.dud });
    }
    (allSidesMk[x.market] ??= []).push(row);
  }
  for (const side of ['over', 'under']) for (const x of pk[side]) {
    const row = { x, res: gradeProp(x, day.data, idxBySeason.get(day.season)) };
    pickRows[side].push(row);
    (pickMk[`${side}:${x.market}`] ??= []).push(row);
  }
}
const pickTally = Object.fromEntries(Object.entries(pickRows).map(([k, v]) => [k, tally(v)]));
const pickMarkets = Object.fromEntries(Object.entries(pickMk).sort().map(([k, v]) => [k, tally(v)]));
const totalHit = gameRows.filter((x) => (x.p.pOver55 >= 0.5) === (x.total > 5.5)).length / gameRows.length;
const pf = (t) => `${t.hits}/${t.n} = ${((100 * t.hits) / t.n).toFixed(1)}% (model expected ${((100 * t.exp) / t.n).toFixed(1)}%, his average alone ${((100 * t.expBase) / t.n).toFixed(1)}%; ${t.void} void)`;
console.log('\nTop 20 picks per day');
for (const [k, t] of Object.entries(pickTally)) console.log(`  ${k.padEnd(6)} ${pf(t)}`);
for (const [k, t] of Object.entries(pickMarkets)) console.log(`    ${k.padEnd(12)} ${pf(t)}`);
console.log(`  game winner ${((1 - favLost) * 100).toFixed(1)}%, total 5.5 side ${(totalHit * 100).toFixed(1)}%`);
const byProb = probBuckets(allSides);
const cal = (rows) => [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.45], [0.45, 1.01]].map(([lo, hi]) => {
  const xs = rows.filter((r) => r.p >= lo && r.p < hi);
  return { lo, hi, n: xs.length, pred: xs.length ? +(xs.reduce((s, r) => s + r.p, 0) / xs.length).toFixed(3) : null, hit: xs.length ? +(xs.filter((r) => r.y).length / xs.length).toFixed(3) : null };
});
const smashCal = cal(smashRows), dudCal = cal(dudRows);
const fcal = (bs) => bs.filter((b) => b.n).map((b) => `${Math.round(b.pred * 100)}→${Math.round(b.hit * 100)}% (${b.n})`).join(' | ');
console.log(`\nBoom on the line: ${fcal(smashCal)}\nBust on the line: ${fcal(dudCal)}`);
const byProbMarket = Object.fromEntries(Object.entries(allSidesMk).map(([k, v]) => [k, probBuckets(v)]));
console.log('\nEvery prop on the model\'s side, by model chance: predicted → hit (n)');
console.log('  all     ' + byProb.map((b) => `${Math.round(b.lo * 100)}%+: ${b.n ? `${(b.pred * 100).toFixed(0)}→${(b.hit * 100).toFixed(0)}% (${b.n})` : '–'}`).join(' | '));
for (const [k, bs] of Object.entries(byProbMarket)) console.log(`  ${k.padEnd(7)} ` + bs.map((b) => `${Math.round(b.lo * 100)}%+: ${b.n ? `${(b.pred * 100).toFixed(0)}→${(b.hit * 100).toFixed(0)}% (${b.n})` : '–'}`).join(' | '));

if (FIT) {
  const out = path.join(WEB, 'data', 'nhl', 'nhl_record.json');
  const body = {
    skaterGames: full.length, calib, bestR,
    games: { n: gameRows.length, winLL, naiveLL, homeRate, totMae, totNaive, favLost, dogBuckets },
    goalies: { starterRight: gRight / gTot, savesMae: gAbs / gN, naiveMae: gAbsNaive / gN },
    picks: { days: days.length, ...pickTally, markets: pickMarkets, winner: 1 - favLost, total: totalHit, byProb, byProbMarket, smash: smashCal, dud: dudCal },
  };
  const old = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out)) : null;
  const strip = (o) => JSON.stringify({ ...o, fitted_at: undefined });
  if (old && strip(old) === strip(body)) console.log('\nnhl_record.json unchanged');
  else { fs.writeFileSync(out, JSON.stringify({ fitted_at: new Date().toISOString().slice(0, 10), ...body }) + '\n'); console.log(`\nwrote ${path.relative(process.cwd(), out)}`); }
}
