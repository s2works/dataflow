// Backtest player projections against actual results.
//
//   node tools/backtest.mjs            # all built seasons
//
// Prints mean absolute / root-mean-square error (PPR points) for: the plain average, the full
// model, and the full model minus each factor (lower = better; if removing a
// factor lowers the error, that factor is hurting). Then checks that the
// red/green buckets line up with how players actually did.

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const load = (rel) => import(pathToFileURL(path.join(WEB, rel)).href);
const { default: sport } = await load('js/sports/nfl.js');
const { buildModel } = await load('js/engine.js');
const { buildProjector } = await load('js/projections.js');

const cfg = sport.projection;
const FACTORS = ['opp', 'form', 'home', 'div', 'weather', 'vegas', 'script', 'rest', 'hist', 'usage', 'qb', 'status'];
const readSeason = (s) => {
  const f = path.join(WEB, 'data', 'nfl', `${s}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null;
};
const fpts = (r, keys) => keys.reduce((s, k) => s + (cfg.scoring[k] || 0) * (r[k] || 0), 0);

const { seasons } = JSON.parse(fs.readFileSync(path.join(WEB, 'data', 'nfl', 'index.json')));
const weeks = [];
for (const season of seasons) {
  const data = readSeason(season);
  const prev = readSeason(season - 1);
  const history = prev ? [prev] : [];
  const lastWeek = Math.min(18, data.last_week_played);
  for (let w = 4; w <= lastWeek; w++) {
    const model = buildModel(sport, data, { beforeWeek: w });
    const games = data.schedule.filter((g) => g.week === w && g.game_type === 'REG');
    const actual = new Map(data.player_games.filter((r) => r.week === w).map((r) => [r.id, r]));
    const items = [];
    for (const p of model.players.filter((x) => x.relevant)) {
      const g = games.find((x) => x.home === p.team || x.away === p.team);
      const a = actual.get(p.id);
      if (g && a) items.push({ p, g, row: a, actual: fpts(a, cfg.stats[p.pos]) });
    }
    weeks.push({ model, history, items });
  }
}

function evaluate(disabled) {
  let abs = 0, sq = 0, n = 0;
  const results = [];
  for (const wk of weeks) {
    const pr = buildProjector(sport, wk.model, { history: wk.history, disabled: new Set(disabled) });
    for (const it of wk.items) {
      const r = pr.project(it.p, it.g);
      abs += Math.abs(r.projFpts - it.actual);
      sq += (r.projFpts - it.actual) ** 2;
      n++;
      results.push({ r, actual: it.actual });
    }
  }
  return { mae: abs / n, rmse: Math.sqrt(sq / n), n, results };
}

const base = evaluate(FACTORS);
const full = evaluate([]);
console.log(`${full.n} player-games, seasons ${seasons.join(', ')} (weeks 4+)\n`);
// MAE rewards the median and RMSE the mean; fantasy scoring is right-skewed,
// so upward adjustments (e.g. teammates out) can be right on average and still
// raise MAE. Look at both.
const row = (label, e) => console.log(`  ${label.padEnd(20)} ${e.mae.toFixed(3)}   ${e.rmse.toFixed(3)}`);
console.log('Error in PPR pts (lower is better)   MAE     RMSE');
row('plain average', base);
row('full model', full);
for (const f of FACTORS) row(`without ${f}`, evaluate([f]));

console.log('\nColor calibration: how often the player beat his own average');
const buckets = [['≥ +10%', 0.1, 9], ['+5 to +10%', 0.05, 0.1], ['±5%', -0.05, 0.05], ['−5 to −10%', -0.1, -0.05], ['≤ −10%', -9, -0.1]];
for (const [label, lo, hi] of buckets) {
  const xs = full.results.filter(({ r }) => r.delta >= lo && r.delta < hi);
  const beat = xs.filter(({ r, actual }) => actual > r.baseFpts).length;
  console.log(`  ${label.padEnd(12)} n=${String(xs.length).padEnd(5)} beat avg ${((100 * beat) / xs.length).toFixed(1)}%`);
}

// ---- Anytime touchdown probabilities ----------------------------------------
// Log loss / Brier (lower is better) of P(rush or rec TD) against what happened.
// "TDs scored only" is the naive model: the player's actual TD rate, Poisson.
const scoredTd = (a) => (a.rush_td || 0) + (a.rec_td || 0) > 0;

function tdEval(disabled, probOf) {
  let ll = 0, brier = 0, n = 0;
  const out = [];
  for (const wk of weeks) {
    const pr = buildProjector(sport, wk.model, { history: wk.history, disabled: new Set(disabled) });
    for (const it of wk.items) {
      const a = it.row;
      const r = pr.project(it.p, it.g);
      const p = Math.min(0.97, Math.max(0.005, probOf ? probOf(it.p, r) : r.td.anytime));
      const y = scoredTd(a) ? 1 : 0;
      ll -= y ? Math.log(p) : Math.log(1 - p);
      brier += (p - y) ** 2;
      n++;
      out.push({ p, y, r });
    }
  }
  return { ll: ll / n, brier: brier / n, out };
}

const tdFull = tdEval([]);
const tdRow = (label, e) => console.log(`  ${label.padEnd(20)} ${e.ll.toFixed(4)}   ${e.brier.toFixed(4)}`);
console.log('\nAnytime TD (rush/rec)          log loss  Brier');
tdRow('TDs scored only', tdEval(FACTORS, (p) => 1 - Math.exp(-((p.avg.rush_td || 0) + (p.avg.rec_td || 0)))));
tdRow('usage base only', tdEval(FACTORS));
tdRow('full model', tdFull);
for (const f of ['opp', 'rz', 'div', 'weather', 'vegas', 'script', 'hist', 'usage', 'qb', 'status']) tdRow(`without ${f}`, tdEval([f]));

console.log('\nTD calibration: predicted vs actual scoring rate');
for (const [lo, hi] of [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.45], [0.45, 1]]) {
  const xs = tdFull.out.filter((x) => x.p >= lo && x.p < hi);
  if (!xs.length) continue;
  const pred = xs.reduce((s, x) => s + x.p, 0) / xs.length;
  const act = xs.reduce((s, x) => s + x.y, 0) / xs.length;
  console.log(`  ${(lo * 100).toFixed(0).padStart(2)}–${(hi * 100).toFixed(0)}%   n=${String(xs.length).padEnd(5)} predicted ${(pred * 100).toFixed(1)}%  actual ${(act * 100).toFixed(1)}%`);
}

// ---- QB passing TDs: P(2+) from a Poisson on projected pass TDs ----------------
{
  const pr = [];
  for (const wk of weeks) {
    const proj = buildProjector(sport, wk.model, { history: wk.history });
    for (const it of wk.items) {
      if (it.p.pos !== 'QB') continue;
      const lam = proj.project(it.p, it.g).td.passLambda;
      pr.push({ p: 1 - Math.exp(-lam) * (1 + lam), y: (it.row.pass_td || 0) >= 2 ? 1 : 0 });
    }
  }
  console.log('\nQB 2+ passing TDs: predicted vs actual');
  for (const [lo, hi] of [[0, 0.3], [0.3, 0.45], [0.45, 0.6], [0.6, 1]]) {
    const xs = pr.filter((x) => x.p >= lo && x.p < hi);
    if (!xs.length) continue;
    const m = (f) => (100 * xs.reduce((s, x) => s + f(x), 0)) / xs.length;
    console.log(`  ${(lo * 100).toFixed(0).padStart(2)}–${(hi * 100).toFixed(0)}%   n=${String(xs.length).padEnd(4)} predicted ${m((x) => x.p).toFixed(1)}%  actual ${m((x) => x.y).toFixed(1)}%`);
  }
}
