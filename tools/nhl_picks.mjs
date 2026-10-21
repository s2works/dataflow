// Lock each NHL game day's picks before puck drop, for the live scorecard.
//
//   node tools/nhl_picks.mjs
//
// For every game day in the next two days that hasn't started yet, writes the
// model's game picks and top 20 overs / unders to
// web/data/nhl/picks/<season>.json. A day is re-computed on each run until its
// first game starts, then frozen for good. If a run comes after some of a
// day's games started, only the games not yet started are locked (partial).
// Grading happens in the browser against the season's results.

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const load = (rel) => import(pathToFileURL(path.join(WEB, rel)).href);
const { default: sport } = await load('js/sports/nhl.js');
const { nhlDayPicks } = await load('js/nhl/picks.js');

const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null);
const dir = path.join(WEB, 'data', 'nhl');
const { seasons } = read(path.join(dir, 'index.json'));
const season = Math.max(...seasons);
const data = read(path.join(dir, `${season}.json`));
const prev = read(path.join(dir, `${season - 1}.json`));
const history = prev ? [prev] : [];

const now = Date.now();
const horizon = now + 2 * 864e5;
const outFile = path.join(dir, 'picks', `${season}.json`);
const out = read(outFile) ?? { season, days: {} };
const start = (g) => new Date(g.gametime).getTime();

let changed = 0;
for (const day of [...new Set(data.schedule.map((g) => g.week))]) {
  const games = data.schedule.filter((g) => g.week === day);
  const date = data.days?.[day] ?? games[0].gameday;
  const first = Math.min(...games.map(start));
  if (first > horizon) continue;
  const prior = out.days[date];
  if (prior && now >= new Date(prior.locks_at).getTime()) continue; // frozen
  const open = games.filter((g) => start(g) > now && g.home_score == null);
  if (!open.length) continue;
  const picks = nhlDayPicks(sport, data, history, day, { games: open });
  const entry = {
    day, date, partial: open.length < games.length,
    locks_at: new Date(Math.min(...open.map(start))).toISOString(),
    data_through: data.days?.[data.last_week_played] ?? null,
    games: picks.games, over: picks.over, under: picks.under,
  };
  const same = prior && JSON.stringify({ ...prior, locked_at: undefined }) === JSON.stringify({ ...entry, locked_at: undefined });
  if (same) continue;
  out.days[date] = { ...entry, locked_at: new Date(now).toISOString() };
  changed++;
  console.log(`${date}: ${open.length}/${games.length} games, locks ${entry.locks_at}`);
}

if (changed) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  out.days = Object.fromEntries(Object.entries(out.days).sort());
  fs.writeFileSync(outFile, JSON.stringify(out));
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
} else console.log('no changes');
