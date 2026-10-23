// NHL daily picks: every skater/goalie prop with a line, the model's chance
// over it, and the top overs / unders; plus grading against results.
//
// There are no free NHL prop lines, so each prop gets the line a book would
// most likely post: the half-goal nearest the player's own average (shots,
// blocks, goalie saves) or 0.5 (points, goals, assists). "Edge" = the model's
// chance minus the chance implied by his average alone at that line, i.e. how
// far tonight's matchup moves him off his usual number. Only players books
// commonly post props for are considered: each team's top 9 forwards and top
// 4 defensemen by recent ice time. Used by the Top Picks
// tab, the scorecard and tools/nhl_picks.mjs (which locks each day's picks
// before puck drop).

import { buildModel } from '../engine.js';
import { buildNhlProjector, buildNhlGameModel, goalieSaves } from './model.js';
import { nbAtLeast } from '../props.js';

const halfLine = (avg) => Math.max(0.5, Math.round(avg - 0.5) + 0.5);
const r3 = (x) => Math.round(x * 1000) / 1000;
export const MARKET_LABEL = { sog: 'Shots', pts: 'Points', g: 'Goals', a: 'Assists', blk: 'Blocks', saves: 'Saves' };

// Boom on the line = clears it by 40%+ and by at least this many (4+ shots on
// 2.5, 2+ points on 0.5); bust = 40%+ under by the same minimum (saves: just
// the margin, either way). Stored as smash / dud.
export const SMASH_MARGIN = { sog: 1, blk: 1, pts: 1, g: 1, a: 1, saves: 5 };
function smashOf(market, line, proj, r) {
  const m = SMASH_MARGIN[market];
  const smash = market === 'saves' ? line + m : Math.max(line * 1.4, line + m);
  const dud = market === 'saves' ? line - m : Math.min(line * 0.6, line - m);
  // Counts: at least ceil(smash) (lines are x.5, so smash is usually x.5 too).
  const pSmash = nbAtLeast(proj, r, Math.ceil(smash - 1e-9));
  const pDud = dud >= 0 ? 1 - nbAtLeast(proj, r, Math.floor(dud) + 1) : 0;
  return { smash: Math.ceil(smash - 1e-9), pSmash: r3(pSmash), dud: dud >= 0 ? Math.floor(dud) : null, pDud: r3(pDud) };
}
// What books usually offer (see the comment above).
export const BOOK_COVERAGE = { forwards: 9, defense: 4, recentGames: 5 };

// Each team's top forwards / defensemen by average ice time over their last
// few games (ice time tracks line and pair promotions quickly).
export function lineupCore(players, ctx, cov = BOOK_COVERAGE) {
  const byTeam = new Map();
  for (const p of players) {
    const rows = (ctx.logs.get(p.id) || []).slice(0, cov.recentGames);
    const toi = rows.length ? rows.reduce((s, r) => s + (r.toi || 0), 0) / rows.length : 0;
    const key = `${p.team}:${p.pos === 'D' ? 'D' : 'F'}`;
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push({ id: p.id, toi });
  }
  const keep = new Set();
  for (const [key, list] of byTeam) {
    list.sort((a, b) => b.toi - a.toi).slice(0, key.endsWith(':D') ? cov.defense : cov.forwards).forEach((x) => keep.add(x.id));
  }
  return keep;
}

// Picks for one game day. `games` limits which games count (default: all).
export function nhlDayPicks(sport, data, history, day, { games = null, top = 20, model = null, maxPerMarket = { saves: 4 }, coverage = BOOK_COVERAGE } = {}) {
  const P = sport.projection;
  games = games ?? data.schedule.filter((g) => g.week === day);
  model = model ?? buildModel(sport, data, { beforeWeek: day });
  const projector = buildNhlProjector(sport, model, { history });
  const gm = buildNhlGameModel(sport, data, { beforeWeek: day, history, model });
  const byTeam = new Map(games.flatMap((g) => [[g.home, g], [g.away, g]]));
  const props = [];
  const playing = model.players.filter((p) => p.relevant && byTeam.has(p.team));
  const core = coverage ? lineupCore(playing, projector.ctx, coverage) : null;

  for (const p of playing) {
    if (core && !core.has(p.id)) continue;
    const g = byTeam.get(p.team);
    const r = projector.project(p, g);
    for (const [k, mk] of Object.entries(P.markets)) {
      const line = k === 'sog' || k === 'blk' ? halfLine(r.base[k]) : 0.5;
      const at = Math.floor(line) + 1;
      const pr = nbAtLeast(r.proj[k], mk.r, at), pb = nbAtLeast(r.base[k], mk.r, at);
      props.push({
        id: p.id, name: p.name, pos: p.pos, team: p.team, opp: r.opp, home: r.isHome, game_id: g.game_id,
        market: k, line, proj: r3(r.proj[k]), base: r3(r.base[k]), p: r3(pr), pBase: r3(pb), edge: r3(pr - pb),
        ...smashOf(k, line, r.proj[k], mk.r),
        why: r.factors.filter((f) => Math.abs(k === 'sog' ? f.impactSog : f.impact) >= 0.02).map((f) => f.text).slice(0, 3),
      });
    }
  }

  // Goalie saves: probable starter vs his own recent average.
  const S = P.saves;
  const gRows = [...history.flatMap((d) => d.goalie_games || []), ...(data.goalie_games || []).filter((r) => r.week < day)];
  for (const g of games) {
    for (const [team, opp, home] of [[g.home, g.away, true], [g.away, g.home, false]]) {
      const s = goalieSaves(sport, projector.ctx, team, opp, home, g);
      if (!s) continue;
      const mine = gRows.filter((r) => r.id === s.id && r.starter).slice(-20);
      if (mine.length < 5) continue;
      const base = mine.reduce((a, r) => a + (r.saves || 0), 0) / mine.length;
      const line = halfLine(base), at = Math.floor(line) + 1;
      const pr = nbAtLeast(s.saves, S.r, at), pb = nbAtLeast(base, S.r, at);
      props.push({
        id: s.id, name: s.name, pos: 'G', team, opp, home, game_id: g.game_id,
        market: 'saves', line, proj: r3(s.saves), base: r3(base), p: r3(pr), pBase: r3(pb), edge: r3(pr - pb),
        ...smashOf('saves', line, s.saves, S.r),
        why: [`${s.sa.toFixed(1)} shots against × ${(s.sv * 100).toFixed(1)}%`, `probable: ${s.reason}`],
      });
    }
  }

  // Goalie-save edges run much larger than skater edges and the starter is
  // only probable, so they're capped to keep the lists from being all saves.
  const pick = (rows, side) => {
    const out = [], per = {};
    for (const x of rows) {
      if (out.length >= top) break;
      const cap = maxPerMarket[x.market] ?? Infinity;
      if ((per[x.market] ?? 0) >= cap) continue;
      per[x.market] = (per[x.market] ?? 0) + 1;
      out.push({ ...x, side });
    }
    return out;
  };
  const sorted = [...props].sort((a, b) => b.edge - a.edge);
  const over = pick(sorted.filter((x) => x.edge > 0), 'over');
  const under = pick(sorted.reverse().filter((x) => x.edge < 0), 'under');

  const gamePicks = games.map((g) => {
    const x = gm.predict(g);
    return {
      game_id: g.game_id, away: g.away, home: g.home, gametime: g.gametime,
      pHome: r3(x.pHome), total: r3(x.total), pOver55: r3(x.pOver55),
      winner: x.pHome >= 0.5 ? g.home : g.away, pWin: r3(Math.max(x.pHome, 1 - x.pHome)),
    };
  });
  return { day, date: data.days?.[day] ?? null, games: gamePicks, props, over, under };
}

// ---- grading -----------------------------------------------------------------
// Result of one prop: { actual, hit } or null when it can't be graded yet
// (game not final) or is void (player scratched / goalie didn't start).
export function gradeProp(x, data, idx = indexResults(data)) {
  if (!idx.final.has(x.game_id)) return null;
  let actual;
  if (x.market === 'saves') {
    const r = idx.goalies.get(`${x.game_id}:${x.id}`);
    if (!r?.starter) return { void: true };
    actual = r.saves || 0;
  } else {
    const r = idx.skaters.get(`${x.game_id}:${x.id}`);
    if (!r) return { void: true };
    actual = r[x.market] || 0;
  }
  const over = actual > x.line;
  return { actual, hit: (x.side ?? 'over') === 'over' ? over : !over };
}

export function gradeGame(x, data, idx = indexResults(data)) {
  const g = idx.final.get(x.game_id);
  if (!g) return null;
  const winner = g.home_score > g.away_score ? g.home : g.away;
  const total = g.home_score + g.away_score;
  return { winner, total, hitWin: winner === x.winner, hitTotal: x.pOver55 >= 0.5 ? total > 5.5 : total < 5.5 };
}

export function indexResults(data) {
  return {
    final: new Map(data.schedule.filter((g) => g.home_score != null).map((g) => [g.game_id, g])),
    skaters: new Map(data.player_games.map((r) => [`${r.game_id}:${r.id}`, r])),
    goalies: new Map((data.goalie_games || []).map((r) => [`${r.game_id}:${r.id}`, r])),
  };
}

// Totals for a list of graded picks: hits, graded count, what the model
// expected and what his average alone implied (for the side taken).
export function tally(rows) {
  const t = { n: 0, hits: 0, exp: 0, expBase: 0, void: 0, pending: 0 };
  for (const { x, res } of rows) {
    if (!res) { t.pending++; continue; }
    if (res.void) { t.void++; continue; }
    const over = (x.side ?? 'over') === 'over';
    t.n++; t.hits += res.hit ? 1 : 0;
    t.exp += over ? x.p : 1 - x.p;
    t.expBase += over ? x.pBase : 1 - x.pBase;
  }
  return t;
}
