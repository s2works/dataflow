// Fit outcome distributions for player-prop comparisons.
//
//   node tools/fit_prop_dist.mjs            # writes web/data/nfl/prop_dist.json
//
// Prop lines are medians; projections are averages, and yardage is skewed
// (many quiet games, a few big ones). So instead of assuming a bell curve,
// collect actual ÷ projected from backtests, per stat, and keep its quantiles.
// P(over a line) is then read straight off that empirical distribution.
// Prints a holdout check: fit on all seasons but the latest, test on the
// latest using "line = player's average" as a stand-in for a book line.

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const load = (rel) => import(pathToFileURL(path.join(WEB, rel)).href);
const { default: sport } = await load('js/sports/nfl.js');
const { buildModel } = await load('js/engine.js');
const { buildProjector } = await load('js/projections.js');
const { overProb } = await load('js/props.js');

// Stats with a prop market, and the smallest projection worth fitting on.
const STATS = { pass_yds: 120, rush_yds: 15, rec: 1, rec_yds: 12, rush_att: 5, pass_att: 15 };
const Q = 50; // quantile resolution

const readSeason = (s) => {
  const f = path.join(WEB, 'data', 'nfl', `${s}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null;
};
const { seasons } = JSON.parse(fs.readFileSync(path.join(WEB, 'data', 'nfl', 'index.json')));

function collect(season) {
  const data = readSeason(season);
  const prev = readSeason(season - 1);
  const out = [];
  for (let w = 4; w <= Math.min(18, data.last_week_played); w++) {
    const model = buildModel(sport, data, { beforeWeek: w });
    const pr = buildProjector(sport, model, { history: prev ? [prev] : [] });
    const actual = new Map(data.player_games.filter((r) => r.week === w).map((r) => [r.id, r]));
    for (const p of model.players.filter((x) => x.relevant)) {
      const g = data.schedule.find((x) => x.week === w && (x.home === p.team || x.away === p.team));
      const a = actual.get(p.id);
      if (!g || !a) continue;
      const r = pr.project(p, g);
      for (const [k, min] of Object.entries(STATS)) {
        if (!(k in r.proj) || r.proj[k] < min) continue;
        out.push({ k, proj: r.proj[k], base: r.base[k], actual: a[k] || 0 });
      }
    }
  }
  return out;
}

function fit(rows) {
  const dist = {};
  for (const k of Object.keys(STATS)) {
    const ratios = rows.filter((x) => x.k === k).map((x) => x.actual / x.proj).sort((a, b) => a - b);
    if (ratios.length < 50) continue;
    dist[k] = {
      n: ratios.length,
      q: Array.from({ length: Q + 1 }, (_, i) => +ratios[Math.min(ratios.length - 1, Math.round((i / Q) * (ratios.length - 1)))].toFixed(3)),
    };
  }
  return dist;
}

const sorted = [...seasons].sort();
const all = Object.fromEntries(sorted.map((s) => [s, collect(s)]));

// Holdout check on the latest season.
if (sorted.length > 1) {
  const test = sorted[sorted.length - 1];
  const train = fit(sorted.slice(0, -1).flatMap((s) => all[s]));
  console.log(`Holdout ${test} (fit on ${sorted.slice(0, -1).join(', ')}): line = player's average, rounded to .5`);
  for (const k of Object.keys(train)) {
    const rows = all[test].filter((x) => x.k === k);
    const buckets = [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 1]].map(() => ({ n: 0, p: 0, y: 0 }));
    for (const x of rows) {
      const line = Math.floor(x.base) + 0.5;
      const p = overProb(train, k, x.proj, line);
      const b = buckets[p < 0.4 ? 0 : p < 0.5 ? 1 : p < 0.6 ? 2 : 3];
      b.n++; b.p += p; b.y += x.actual > line ? 1 : 0;
    }
    const txt = buckets.filter((b) => b.n).map((b) => `pred ${(100 * b.p / b.n).toFixed(0)}% → ${(100 * b.y / b.n).toFixed(0)}% (n=${b.n})`).join(' | ');
    console.log(`  ${k.padEnd(9)} ${txt}`);
  }
}

const dist = fit(sorted.flatMap((s) => all[s]));
const out = path.join(WEB, 'data', 'nfl', 'prop_dist.json');
const old = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out)) : null;
if (old && JSON.stringify(old.stats) === JSON.stringify(dist)) {
  console.log('prop_dist.json unchanged');
  process.exit(0);
}
fs.writeFileSync(out, JSON.stringify({ fitted_at: new Date().toISOString().slice(0, 10), stats: dist }) + '\n');
console.log(`wrote ${path.relative(process.cwd(), out)}: ${Object.entries(dist).map(([k, v]) => `${k} n=${v.n}`).join(', ')}`);
