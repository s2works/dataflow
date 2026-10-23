// NFL top picks: every player prop with a line, the model's chance over it vs
// the book's, and the week's top 20 overs / unders; plus grading.
//
// Lines: the Vegas consensus from The Odds API when the refresh job has it
// (data.props, needs ODDS_API_KEY), compared against the book's no-vig
// probability. Games without Vegas lines get an *estimated* line instead: the
// half-yard / half-catch nearest the median outcome for his own average,
// compared against what his average alone implies (same idea as the NHL
// picks). Every row says which kind of line it used.
//
// Used by the Top Picks / Scorecard tabs and tools/nfl_picks.mjs, which saves
// each game's picks until kickoff so the scorecard grades what was shown.

import { overProb, fairOver, impliedProb, poissonAtLeast, medianOutcome, impliedMean } from './props.js';

export const NFL_MARKETS = { pass_yds: 'Pass Yds', pass_td: 'Pass TDs', rush_yds: 'Rush Yds', rec: 'Receptions', rec_yds: 'Rec Yds', scrim_yds: 'Rush + Rec Yds', anytime_td: 'Anytime TD' };
const r3 = (x) => Math.round(x * 1000) / 1000;
// "Smash" = beats the line by 50%+ and by at least this much; "dud" = the
// same margin below it (Boom / Bust tab).
export const SMASH_MARGIN = { pass_yds: 50, rush_yds: 15, rec_yds: 15, scrim_yds: 20, rec: 2, pass_td: 1 };
const halfLine = (x) => Math.max(0.5, Math.round(x - 0.5) + 0.5);

// Same player filter as the Projections tab: active, not ruled out, and in a
// real role (QBs: the starter).
export function projectableRows(sport, model, projector, games) {
  const byTeam = new Map(games.flatMap((g) => [[g.away, g], [g.home, g]]));
  return model.players
    .filter((p) => byTeam.has(p.team) && p.active && !projector.isOut(p))
    .map((p) => ({ p, r: projector.project(p, byTeam.get(p.team)) }))
    .filter(({ p, r }) => {
      const ctx = projector.teamContext(p.team);
      if (p.pos === 'QB') return ctx.newQb ? ctx.newQb.id === p.id : p.relevant;
      return p.relevant || sport.positions[p.pos].relevant(r.proj);
    });
}

// Every prop we can price for these players. `props` = data.props.
export function nflCandidates(sport, rows, propDist, props = {}) {
  const TD = sport.projection.td;
  // Share of the model in the projection when a Vegas line exists (the rest is
  // the projection the book's price implies): books know about role changes
  // and news the model can't see.
  const W = sport.projection.marketBlend;
  const passLam = (x) => TD.passCalib.mean + TD.passCalib.scale * (x - TD.passCalib.mean);
  const out = [];
  for (const { p, r } of rows) {
    const gid = r.game.game_id;
    const gameHasLines = Object.keys(props[gid]?.players ?? {}).length > 0;
    const book = props[gid]?.players?.[p.id];
    for (const stat of Object.keys(NFL_MARKETS)) {
      const b = book?.[stat];
      let line, pModel, pBook, src, proj, base, raw = null, smash = null, dud = null, pSmash = null, pDud = null;
      if (stat === 'anytime_td') {
        if (b?.over == null) continue; // only priced against a real book
        line = 0.5; proj = r.td.lambda; base = r.td.baseLambda; pBook = impliedProb(b.over); src = 'vegas';
        pModel = W * r.td.anytime + (1 - W) * pBook;
      } else {
        proj = stat === 'pass_td' ? r.td.passLambda : r.proj[stat];
        base = stat === 'pass_td' ? (r.base.pass_td != null ? passLam(r.base.pass_td) : null) : r.base[stat];
        if (proj == null || base == null) continue;
        const over = (m, l) => (stat === 'pass_td' ? poissonAtLeast(m, Math.floor(l) + 1) : overProb(propDist, stat, m, l));
        if (b?.line != null) {
          // Skip broken quotes: the two sides' implied chances should add to 100-125%.
          const vig = impliedProb(b.over) + impliedProb(b.under);
          if (b.over == null || b.under == null || !(vig >= 0.98 && vig <= 1.25)) continue;
          line = b.line; pBook = fairOver(b.over, b.under); src = 'vegas';
        } else {
          // A book lists this game but not this prop for him: skip rather than guess.
          if (gameHasLines) continue;
          if (stat === 'pass_yds' || stat === 'pass_td' ? p.pos !== 'QB' : !(stat === 'rec' ? base >= 2 : base >= 20)) continue;
          // Scrimmage yards only for backs (for receivers it ≈ receiving yards).
          if (stat === 'scrim_yds' && p.pos !== 'RB') continue;
          line = stat === 'pass_td' ? (base >= 1.2 ? 1.5 : 0.5) : halfLine(medianOutcome(propDist, stat, base));
          pBook = over(base, line); src = 'est';
        }
        if (src === 'vegas') {
          const implied = impliedMean((m) => over(m, line), line, pBook);
          if (implied != null) { raw = proj; proj = W * proj + (1 - W) * implied; }
        }
        pModel = over(proj, line);
        // Smash / dud chances from the same outcome spread.
        const mg = SMASH_MARGIN[stat];
        smash = Math.max(line * 1.5, line + mg);
        dud = Math.max(0, Math.min(line / 1.5, line - mg));
        pSmash = over(proj, smash);
        pDud = dud > 0 ? 1 - over(proj, dud) : 0;
      }
      if (pModel == null || pBook == null) continue;
      out.push({
        id: p.id, name: p.name, pos: p.pos, team: p.team, opp: r.opp, home: r.isHome, game_id: gid, week: r.game.week,
        market: stat, line, src, price: b ? { over: b.over ?? null, under: b.under ?? null, open: b.open ?? null } : null,
        proj: r3(proj), ...(raw != null ? { projModel: r3(raw) } : {}), base: r3(base), p: r3(pModel),
        ...(smash != null ? { smash: r3(smash), pSmash: r3(pSmash), dud: r3(dud), pDud: r3(pDud) } : {}), pBook: r3(pBook), edge: r3(pModel - pBook),
        why: r.factors.filter((f) => Math.abs(f.impact) >= 0.03).slice(0, 3).map((f) => f.text ?? f.label),
      });
    }
  }
  return out;
}

export function topPicks(cands, top = 20) {
  const sorted = [...cands].sort((a, b) => b.edge - a.edge);
  return {
    over: sorted.filter((x) => x.edge > 0).slice(0, top).map((x) => ({ ...x, side: 'over' })),
    under: sorted.reverse().filter((x) => x.edge < 0 && x.market !== 'anytime_td').slice(0, top).map((x) => ({ ...x, side: 'under' })),
  };
}

// ---- grading ---------------------------------------------------------------------
export function nflResults(data) {
  return {
    final: new Set(data.schedule.filter((g) => g.home_score != null).map((g) => g.game_id)),
    rows: new Map(data.player_games.map((r) => [`${r.game_id}:${r.id}`, r])),
  };
}

export function gradeNflPick(x, idx) {
  if (!idx.final.has(x.game_id)) return null;
  const r = idx.rows.get(`${x.game_id}:${x.id}`);
  if (!r) return { void: true };
  const actual = x.market === 'anytime_td' ? (r.rush_td || 0) + (r.rec_td || 0)
    : x.market === 'scrim_yds' ? (r.rush_yds || 0) + (r.rec_yds || 0) : r[x.market] || 0;
  const over = actual > x.line;
  return { actual, hit: x.side === 'under' ? !over : over };
}

// Hits, graded count, model expectation and book (or average-only) expectation.
export function tallyPicks(rows) {
  const t = { n: 0, hits: 0, exp: 0, expBook: 0, void: 0, pending: 0, push: 0 };
  for (const { x, res } of rows) {
    if (!res) { t.pending++; continue; }
    if (res.void) { t.void++; continue; }
    if (res.actual === x.line) { t.push++; continue; } // whole-number lines can push
    const over = x.side !== 'under';
    t.n++; t.hits += res.hit ? 1 : 0;
    t.exp += over ? x.p : 1 - x.p;
    t.expBook += over ? x.pBook : 1 - x.pBook;
  }
  return t;
}
