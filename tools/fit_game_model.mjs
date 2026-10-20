// Backtest the game model against results and the Vegas lines.
//
//   node tools/fit_game_model.mjs      # writes web/data/nfl/game_record.json
//
// For every played regular-season game from week 3 on, project it using only
// earlier games, then record: error on margin and total (model vs Vegas),
// against-the-spread and over/under records when the model disagrees with the
// line by N+ points, and win-probability log loss (model vs the moneyline).
// Also fits the margin SD used for win probability.

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const load = (rel) => import(pathToFileURL(path.join(WEB, rel)).href);
const { default: sport } = await load('js/sports/nfl.js');
const { buildGameModel } = await load('js/gamemodel.js');
const { fairOver } = await load('js/props.js');

const readSeason = (s) => {
  const f = path.join(WEB, 'data', 'nfl', `${s}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null;
};
const { seasons } = JSON.parse(fs.readFileSync(path.join(WEB, 'data', 'nfl', 'index.json')));

const rows = [];
for (const season of [...seasons].sort()) {
  const data = readSeason(season);
  const prev = readSeason(season - 1);
  for (let w = 3; w <= Math.min(18, data.last_week_played); w++) {
    const m = buildGameModel(sport, data, { beforeWeek: w, history: prev ? [prev] : [] });
    for (const g of data.schedule.filter((x) => x.week === w && x.game_type === 'REG' && x.home_score != null)) {
      rows.push({ g, p: m.predict(g), margin: g.home_score - g.away_score, total: g.home_score + g.away_score });
    }
  }
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const withSpread = rows.filter((r) => r.g.spread_line != null);
const withTotal = rows.filter((r) => r.g.total_line != null);
const err = {
  margin: { model: mean(rows.map((r) => Math.abs(r.p.margin - r.margin))), vegas: mean(withSpread.map((r) => Math.abs(r.g.spread_line - r.margin))) },
  total: { model: mean(rows.map((r) => Math.abs(r.p.total - r.total))), vegas: mean(withTotal.map((r) => Math.abs(r.g.total_line - r.total))) },
};

function record(kind, th) {
  let w = 0, l = 0;
  for (const r of kind === 'ats' ? withSpread : withTotal) {
    const edge = kind === 'ats' ? r.p.margin - r.g.spread_line : r.p.total - r.g.total_line;
    const res = kind === 'ats' ? r.margin - r.g.spread_line : r.total - r.g.total_line;
    if (Math.abs(edge) < th || res === 0) continue;
    if (Math.sign(res) === Math.sign(edge)) w++; else l++;
  }
  return [w, l];
}
const thresholds = [0, 2, 3, 4, 6];
const ats = Object.fromEntries(thresholds.map((t) => [t, record('ats', t)]));
const ou = Object.fromEntries(thresholds.map((t) => [t, record('ou', t)]));

// Win probability: fit the margin SD by log loss; compare with the moneyline.
const decided = rows.filter((r) => r.margin !== 0);
const normCdf = (x) => 0.5 * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x ** 3)));
const ll = (ps) => -mean(ps.map(([p, y]) => (y ? Math.log(Math.min(0.99, Math.max(0.01, p))) : Math.log(1 - Math.min(0.99, Math.max(0.01, p))))));
let best = null;
for (let sd = 10; sd <= 20; sd += 0.5) {
  const v = ll(decided.map((r) => [normCdf(r.p.margin / sd), r.margin > 0]));
  if (!best || v < best.v) best = { sd, v };
}
const ml = decided.filter((r) => r.g.home_moneyline != null && r.g.away_moneyline != null);
const winLL = {
  model: ll(ml.map((r) => [normCdf(r.p.margin / best.sd), r.margin > 0])),
  market: ll(ml.map((r) => [fairOver(r.g.home_moneyline, r.g.away_moneyline), r.margin > 0])),
  n: ml.length,
};

const pct = ([w, l]) => (w + l ? `${w}-${l} (${((100 * w) / (w + l)).toFixed(1)}%)` : '–');
console.log(`${rows.length} games (seasons ${seasons.join(', ')}, week 3+)`);
console.log(`Margin error: model ${err.margin.model.toFixed(2)} vs Vegas ${err.margin.vegas.toFixed(2)}`);
console.log(`Total error:  model ${err.total.model.toFixed(2)} vs Vegas ${err.total.vegas.toFixed(2)}`);
for (const t of thresholds) console.log(`  disagree by ${t}+: ATS ${pct(ats[t])}   O/U ${pct(ou[t])}`);
console.log(`Win prob log loss: model ${winLL.model.toFixed(4)} vs moneyline ${winLL.market.toFixed(4)} (n=${winLL.n}); margin SD ${best.sd}`);

const out = path.join(WEB, 'data', 'nfl', 'game_record.json');
const body = { games: rows.length, err, ats, ou, winLL, marginSd: best.sd };
const old = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out)) : null;
if (old && JSON.stringify({ ...old, fitted_at: undefined }) === JSON.stringify({ ...body, fitted_at: undefined })) console.log('game_record.json unchanged');
else {
  fs.writeFileSync(out, JSON.stringify({ fitted_at: new Date().toISOString().slice(0, 10), ...body }) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}
