// NFL top picks: lock this week's picks game by game, and backtest the method.
//
//   node tools/nfl_picks.mjs              # update web/data/nfl/picks_<season>.json
//   node tools/nfl_picks.mjs --backtest   # also write web/data/nfl/picks_record.json
//
// Lock: for the current week, every game that hasn't kicked off gets its prop
// candidates (top 15 overs and unders for that game) re-computed on each run;
// at kickoff they freeze. The week's top 20 lists are drawn from those saved
// candidates in the browser, so a Thursday pick is fixed at Thursday kickoff.
//
// Backtest: weeks 4+ of each season, projected from earlier weeks only, on
// estimated lines (free historical prop lines don't exist), graded on results.

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const load = (rel) => import(pathToFileURL(path.join(WEB, rel)).href);
const { default: sport } = await load('js/sports/nfl.js');
const { buildModel } = await load('js/engine.js');
const { buildProjector } = await load('js/projections.js');
const { projectableRows, nflCandidates, topPicks, nflResults, gradeNflPick, tallyPicks } = await load('js/nflpicks.js');
const { probBuckets, modelSide } = await load('js/rankpicks.js');

const dir = path.join(WEB, 'data', 'nfl');
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null);
const readSeason = (s) => read(path.join(dir, `${s}.json`));
const { seasons } = read(path.join(dir, 'index.json'));
const propDist = read(path.join(dir, 'prop_dist.json'))?.stats ?? null;
const PER_GAME = 15;

// Kickoff in UTC from the schedule's Eastern date and time.
function kickoff(g) {
  const [h, m] = (g.gametime || '13:00').split(':').map(Number);
  const guess = new Date(`${g.gameday}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const et = new Date(guess.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() + (utc - et)); // add the Eastern offset back
}

function weekCandidates(data, history, week, games) {
  const model = buildModel(sport, data, { beforeWeek: week });
  const projector = buildProjector(sport, model, { history });
  return nflCandidates(sport, projectableRows(sport, model, projector, games), propDist, data.props ?? {});
}

// ---- lock the current week --------------------------------------------------
const season = Math.max(...seasons);
const data = readSeason(season);
const history = [readSeason(season - 1)].filter(Boolean);
const open = data.schedule.filter((g) => g.home_score == null);
const now = Date.now();
const outFile = path.join(dir, `picks_${season}.json`);
const store = read(outFile) ?? { season, weeks: {} };
let changed = 0;
if (open.length) {
  const week = Math.min(...open.map((g) => g.week));
  const games = data.schedule.filter((g) => g.week === week && kickoff(g).getTime() > now);
  if (games.length) {
    const cands = weekCandidates(data, history, week, games);
    const wk = (store.weeks[week] ??= { week, games: {} });
    for (const g of games) {
      const mine = cands.filter((x) => x.game_id === g.game_id);
      const { over, under } = topPicks(mine, PER_GAME);
      const entry = {
        kickoff: kickoff(g).toISOString(), away: g.away, home: g.home,
        lines: mine.some((x) => x.src === 'vegas') ? 'vegas' : 'est',
        candidates: [...over, ...under].map(({ side, ...x }) => x),
      };
      const prev = wk.games[g.game_id];
      if (prev && JSON.stringify({ ...prev, saved_at: undefined }) === JSON.stringify(entry)) continue;
      wk.games[g.game_id] = { ...entry, saved_at: new Date(now).toISOString() };
      changed++;
    }
    console.log(`week ${week}: ${games.length} games before kickoff, ${changed} updated`);
  }
}
if (changed) { fs.writeFileSync(outFile, JSON.stringify(store)); console.log(`wrote ${path.relative(process.cwd(), outFile)}`); }
else console.log('picks unchanged');

// ---- backtest ------------------------------------------------------------------
if (process.argv.includes('--backtest')) {
  const all = { over: [], under: [] }, mk = {};
  const allSides = [], allSidesMk = {};
  let weeks = 0;
  for (const s of [...seasons].sort()) {
    const d = readSeason(s), prev = readSeason(s - 1);
    const hist = prev ? [prev] : [];
    const idx = nflResults(d);
    for (let w = 4; w <= Math.min(18, d.last_week_played); w++) {
      const games = d.schedule.filter((g) => g.week === w && g.game_type === 'REG' && g.home_score != null);
      if (!games.length) continue;
      const cands = weekCandidates(d, hist, w, games);
      for (const c of cands) {
        if (c.market === 'anytime_td') continue;
        const x = modelSide(c);
        const row = { x, res: gradeNflPick(x, idx) };
        allSides.push(row);
        (allSidesMk[x.market] ??= []).push(row);
      }
      const picks = topPicks(cands);
      weeks++;
      for (const side of ['over', 'under']) for (const x of picks[side]) {
        const row = { x, res: gradeNflPick(x, idx) };
        all[side].push(row);
        (mk[`${side}:${x.market}`] ??= []).push(row);
      }
    }
  }
  const t = { over: tallyPicks(all.over), under: tallyPicks(all.under) };
  const markets = Object.fromEntries(Object.entries(mk).sort().map(([k, v]) => [k, tallyPicks(v)]));
  const pf = (x) => `${x.hits}/${x.n} = ${((100 * x.hits) / x.n).toFixed(1)}% (model ${((100 * x.exp) / x.n).toFixed(1)}%, average-only ${((100 * x.expBook) / x.n).toFixed(1)}%; ${x.void} void, ${x.push} push)`;
  console.log(`\nBacktest, ${weeks} weeks, estimated lines`);
  for (const [k, x] of Object.entries(t)) console.log(`  ${k.padEnd(6)} ${pf(x)}`);
  for (const [k, x] of Object.entries(markets)) console.log(`    ${k.padEnd(16)} ${pf(x)}`);
  const recFile = path.join(dir, 'picks_record.json');
  const byProb = probBuckets(allSides);
  const byProbMarket = Object.fromEntries(Object.entries(allSidesMk).map(([k, v]) => [k, probBuckets(v)]));
  const fb = (bs) => bs.map((b) => `${Math.round(b.lo * 100)}%+: ${b.n ? `${(b.pred * 100).toFixed(0)}→${(b.hit * 100).toFixed(0)}% (${b.n})` : '–'}`).join(' | ');
  console.log('\nEvery prop on the model\'s side, by model chance: predicted → hit (n)');
  console.log(`  all        ${fb(byProb)}`);
  for (const [k, bs] of Object.entries(byProbMarket)) console.log(`  ${k.padEnd(10)} ${fb(bs)}`);
  const body = { weeks, ...t, markets, byProb, byProbMarket };
  const old = read(recFile);
  if (old && JSON.stringify({ ...old, fitted_at: undefined }) === JSON.stringify({ ...body, fitted_at: undefined })) console.log('picks_record.json unchanged');
  else { fs.writeFileSync(recFile, JSON.stringify({ fitted_at: new Date().toISOString().slice(0, 10), ...body }) + '\n'); console.log(`wrote ${path.relative(process.cwd(), recFile)}`); }
}
