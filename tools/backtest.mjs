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
      if (g && a) items.push({ p, g, actual: fpts(a, cfg.stats[p.pos]) });
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
