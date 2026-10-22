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
const { buildQ1 } = await load('js/q1.js');

// Stats with a prop market, and the smallest projection worth fitting on.
const STATS = {
  pass_yds: 120, rush_yds: 15, rec: 1, rec_yds: 12, scrim_yds: 20, rush_att: 5, pass_att: 15,
  // First quarter (projections from web/js/q1.js)
  q1_pass_yds: 25, q1_rush_yds: 4, q1_rec: 0.3, q1_rec_yds: 4,
};
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
    const q1 = buildQ1(sport, model, pr, { history: prev ? [prev] : [] });
    const actual = new Map(data.player_games.filter((r) => r.week === w).map((r) => [r.id, r]));
    for (const p of model.players.filter((x) => x.relevant)) {
      const g = data.schedule.find((x) => x.week === w && (x.home === p.team || x.away === p.team));
      const a = actual.get(p.id);
      if (!g || !a) continue;
      const r = pr.project(p, g);
      const q = q1.project(p, r);
      for (const [k, min] of Object.entries(STATS)) {
        const proj = k in r.proj ? r.proj[k] : q[k]?.proj;
        if (proj == null || proj < min) continue;
        if (k === 'scrim_yds' && p.pos !== 'RB') continue; // a running-back market
        // Stand-in line for the holdout: player's average (Q1: average × league share).
        const base = k in r.base ? r.base[k] : r.base[q[k].full] * q[k].league;
        const actual = k === 'scrim_yds' ? (a.rush_yds || 0) + (a.rec_yds || 0) : a[k] || 0;
        out.push({ k, proj, base, actual });
      }
    }
  }
  return out;
}

// Separate fits by projection size: a high-volume player has fewer zero games
// than a fringe one, so pooling everyone distorts the low end (worst for
// first-quarter stats, where zero is common).
const BUCKET_MIN = 150; // rows per bucket
const quantiles = (xs) => {
  const r = xs.sort((a, b) => a - b);
  return Array.from({ length: Q + 1 }, (_, i) => +r[Math.min(r.length - 1, Math.round((i / Q) * (r.length - 1)))].toFixed(3));
};
function fit(rows) {
  const dist = {};
  for (const k of Object.keys(STATS)) {
    const xs = rows.filter((x) => x.k === k).sort((a, b) => a.proj - b.proj);
    if (xs.length < 50) continue;
    const nb = Math.max(1, Math.min(4, Math.floor(xs.length / BUCKET_MIN)));
    const buckets = [];
    for (let b = 0; b < nb; b++) {
      const part = xs.slice(Math.floor((b * xs.length) / nb), Math.floor(((b + 1) * xs.length) / nb));
      buckets.push({ upTo: b === nb - 1 ? null : +part[part.length - 1].proj.toFixed(2), q: quantiles(part.map((x) => x.actual / x.proj)) });
    }
    dist[k] = { n: xs.length, q: quantiles(xs.map((x) => x.actual / x.proj)), buckets };
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

if (sorted.length > 1) {
  const test = sorted[sorted.length - 1];
  const train = fit(sorted.slice(0, -1).flatMap((s) => all[s]));
  const rows = all[test].filter((x) => x.k === 'q1_rec');
  for (const line of [0.5, 1.5]) {
    const bs = [[0, 0.35], [0.35, 0.55], [0.55, 0.75], [0.75, 1]].map(([lo, hi]) => ({ lo, hi, n: 0, p: 0, y: 0 }));
    for (const x of rows) {
      const p = overProb(train, 'q1_rec', x.proj, line);
      const b = bs.find((b) => p >= b.lo && p < b.hi) ?? bs[bs.length - 1];
      b.n++; b.p += p; b.y += x.actual > line ? 1 : 0;
    }
    console.log(`  q1 receptions over ${line}: ` + bs.filter((b) => b.n).map((b) => `pred ${(100 * b.p / b.n).toFixed(0)}% → ${(100 * b.y / b.n).toFixed(0)}% (n=${b.n})`).join(' | '));
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
