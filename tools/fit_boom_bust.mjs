// Fit boom/bust probabilities and backtest every angle.
//
//   node tools/fit_boom_bust.mjs        # writes web/data/nfl/boombust.json
//
// For each position: distribution of actual ÷ projected fantasy points (for
// P(boom) / P(bust)). For each angle in web/js/boombust.js: how often it fired
// and how often those players actually boomed/busted, vs the normal rate for
// the same players (so the UI can say "hit 31% vs 18% normal").

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const load = (rel) => import(pathToFileURL(path.join(WEB, rel)).href);
const { default: sport } = await load('js/sports/nfl.js');
const { buildModel } = await load('js/engine.js');
const { buildProjector } = await load('js/projections.js');
const { ANGLES, anglesFor, boomLine, bustLine, boomBust, angleEffect } = await load('js/boombust.js');

const cfg = sport.projection;
const fptsOf = (row, keys) => keys.reduce((s, k) => s + (cfg.scoring[k] || 0) * (row[k] || 0), 0);
const readSeason = (s) => {
  const f = path.join(WEB, 'data', 'nfl', `${s}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null;
};
const { seasons } = JSON.parse(fs.readFileSync(path.join(WEB, 'data', 'nfl', 'index.json')));

const rows = [];
for (const season of [...seasons].sort()) {
  const data = readSeason(season);
  const prev = readSeason(season - 1);
  for (let w = 4; w <= Math.min(18, data.last_week_played); w++) {
    const model = buildModel(sport, data, { beforeWeek: w });
    const pr = buildProjector(sport, model, { history: prev ? [prev] : [] });
    const actual = new Map(data.player_games.filter((r) => r.week === w).map((r) => [r.id, r]));
    for (const p of model.players.filter((x) => x.relevant)) {
      const g = data.schedule.find((x) => x.week === w && (x.home === p.team || x.away === p.team));
      const a = actual.get(p.id);
      if (!g || !a) continue;
      const r = pr.project(p, g);
      if (!(r.baseFpts > 1)) continue;
      const pts = fptsOf(a, cfg.stats[p.pos]);
      rows.push({
        season, week: w, p, r, model, pts,
        boom: pts >= boomLine(p.pos, r.baseFpts),
        bust: pts <= bustLine(r.baseFpts),
        angles: anglesFor(p, r, model).map((x) => x.id),
      });
    }
  }
}

// ---- fantasy-point distributions per position --------------------------------
const Q = 50;
const dists = {};
for (const pos of Object.keys(cfg.stats)) {
  const ratios = rows.filter((x) => x.p.pos === pos).map((x) => x.pts / x.r.projFpts).sort((a, b) => a - b);
  dists[`fpts_${pos}`] = { n: ratios.length, q: Array.from({ length: Q + 1 }, (_, i) => +ratios[Math.round((i / Q) * (ratios.length - 1))].toFixed(3)) };
}

// ---- base rates and angle results ----------------------------------------------
const rate = (xs, k) => (xs.length ? xs.filter((x) => x[k]).length / xs.length : null);
const base = {};
for (const pos of Object.keys(cfg.stats)) {
  const xs = rows.filter((x) => x.p.pos === pos);
  base[pos] = { n: xs.length, boom: +rate(xs, 'boom').toFixed(3), bust: +rate(xs, 'bust').toFixed(3) };
}
const angles = {};
console.log(`${rows.length} player-games (weeks 4+, ${seasons.join(', ')})\n`);
console.log('Angle                                   fired   boom (normal)    bust (normal)   effect');
for (const a of ANGLES) {
  const xs = rows.filter((x) => x.angles.includes(a.id));
  if (!xs.length) { console.log(`  ${a.label.padEnd(38)} never fired`); continue; }
  const exp = (k) => xs.reduce((s, x) => s + base[x.p.pos][k], 0) / xs.length; // same-position normal
  angles[a.id] = { n: xs.length, boom: +rate(xs, 'boom').toFixed(3), bust: +rate(xs, 'bust').toFixed(3), baseBoom: +exp('boom').toFixed(3), baseBust: +exp('bust').toFixed(3) };
  const s = angles[a.id];
  const pc = (v) => `${(v * 100).toFixed(0)}%`.padStart(4);
  console.log(`  ${a.label.padEnd(38)} ${String(s.n).padStart(5)}   ${pc(s.boom)} (${pc(s.baseBoom)})      ${pc(s.bust)} (${pc(s.baseBust)})   → ${angleEffect(s) ?? 'no effect (hidden)'}`);
}

// ---- calibration: fit a + b·p for P(boom) and P(bust) by log loss -------------
const calib = {};
for (const k of ['boom', 'bust']) {
  const raw = rows.map((x) => ({ y: x[k], p: boomBust({ dists }, x.p, x.r)[k] })).filter((o) => o.p != null);
  let best = null;
  for (let a = 0; a <= 0.2001; a += 0.01) for (let b = 0.3; b <= 1.2001; b += 0.05) {
    let ll = 0;
    for (const o of raw) { const q = Math.min(0.95, Math.max(0.01, a + b * o.p)); ll -= o.y ? Math.log(q) : Math.log(1 - q); }
    if (!best || ll < best.ll) best = { a: +a.toFixed(2), b: +b.toFixed(2), ll };
  }
  calib[k] = [best.a, best.b];
}
for (const k of ['boom', 'bust']) {
  console.log(`\nP(${k}) calibration (a=${calib[k][0]}, b=${calib[k][1]})`);
  const ps = rows.map((x) => ({ x, p: boomBust({ dists, calib }, x.p, x.r)[k] }));
  for (const [lo, hi] of [[0, 0.12], [0.12, 0.18], [0.18, 0.25], [0.25, 0.35], [0.35, 1]]) {
    const xs = ps.filter((o) => o.p >= lo && o.p < hi);
    if (xs.length < 20) continue;
    const pred = xs.reduce((s, o) => s + o.p, 0) / xs.length;
    console.log(`  ${(lo * 100).toFixed(0).padStart(2)}–${(hi * 100).toFixed(0)}%  n=${String(xs.length).padEnd(5)} predicted ${(pred * 100).toFixed(1)}%  actual ${(rate(xs.map((o) => o.x), k) * 100).toFixed(1)}%`);
  }
}

// ---- example: the game the user asked about ------------------------------------
const ex = rows.filter((x) => x.r.game.game_id === '2026_06_WAS_SF' && x.p.pos === 'RB');
if (ex.length) {
  console.log('\nExample 2026 wk 6 WAS @ SF (RBs)');
  for (const x of ex) {
    const bb = boomBust({ dists, calib }, x.p, x.r);
    console.log(`  ${x.p.name.padEnd(22)} avg ${x.r.baseFpts.toFixed(1).padStart(4)}  P(boom) ${(bb.boom * 100).toFixed(0)}%  actual ${x.pts.toFixed(1)}${x.boom ? ' BOOM' : ''}  angles: ${x.angles.join(', ') || '–'}`);
  }
}

const out = path.join(WEB, 'data', 'nfl', 'boombust.json');
const body = { dists, calib, base, angles };
const old = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out)) : null;
if (old && JSON.stringify({ ...old, fitted_at: undefined }) === JSON.stringify({ ...body, fitted_at: undefined })) console.log('\nboombust.json unchanged');
else {
  fs.writeFileSync(out, JSON.stringify({ fitted_at: new Date().toISOString().slice(0, 10), ...body }) + '\n');
  console.log(`\nwrote ${path.relative(process.cwd(), out)}`);
}
