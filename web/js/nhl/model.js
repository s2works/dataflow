// NHL models: skater props, goalie saves and game projections.
//
// Skaters: projection = baseline × Π(factors), per stat (shots, points, goals,
// assists, blocks). Baseline = this season's per-game average with last
// season counted as `priorGames` extra games. Factors: opponent allowance to
// the position (regressed), home ice, the opposing probable goalie's save %,
// back-to-back, ice-time trend. Each factor's impact is reported for the UI.
//
// Goalies: saves = projected shots against × save %, where shots against
// blends the opponent's shot volume with this team's shot suppression and the
// save % is regressed toward league average by shots faced.
//
// Games: opponent-adjusted goal and shot ratings → expected goals per side
// (Poisson) → win % (ties to overtime with a small home edge), total goals,
// puck line.

import { nbAtLeast } from '../props.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const regress = (m, n, k) => 1 + (m - 1) * (n / (n + k));
const avgOf = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0) / (rows.length || 1);
// Player-game rows with play-by-play extras (att is >= sog, so att present
// whenever he shot; pptoi/ixg rows without a shot still carry pptoi or are
// flagged by the team game having play-by-play).
let pbpGames = new Set();
const hasPbp = (r) => pbpGames.has(r.game_id);

// ---- shared context: logs, goalies, league rates -----------------------------
function context(sport, model, history) {
  const data = model.data;
  const beforeWeek = model.beforeWeek;
  const logs = new Map();
  for (const r of data.player_games) {
    if (r.week >= beforeWeek) continue;
    if (!logs.has(r.id)) logs.set(r.id, []);
    logs.get(r.id).push(r);
  }
  for (const rows of logs.values()) rows.sort((a, b) => b.week - a.week);
  const prev = new Map();
  for (const d of history) for (const r of d.player_games) {
    if (!prev.has(r.id)) prev.set(r.id, []);
    prev.get(r.id).push(r);
  }

  // Team games this season before the cutoff.
  const tg = data.team_games.filter((r) => r.week < beforeWeek);
  const lg = { gf: 0, sog: 0, games: 0, homeGf: 0, homeN: 0, homeSog: 0 };
  for (const r of tg) {
    lg.gf += r.gf; lg.sog += r.sog; lg.games++;
    if (r.home) { lg.homeGf += r.gf; lg.homeSog += r.sog; lg.homeN++; }
  }
  // Fall back to last season early on.
  const lgRows = lg.games >= 64 ? tg : [...tg, ...history.flatMap((d) => d.team_games)];
  const L = lgRows.reduce((a, r) => {
    a.gf += r.gf; a.sog += r.sog; a.n++;
    if (r.home) { a.hgf += r.gf; a.hsog += r.sog; a.hn++; }
    return a;
  }, { gf: 0, sog: 0, n: 0, hgf: 0, hsog: 0, hn: 0 });
  const league = {
    gf: L.gf / L.n, sog: L.sog / L.n,
    homeGf: L.hn ? L.hgf / L.hn / (L.gf / L.n) : 1,
    homeSog: L.hn ? L.hsog / L.hn / (L.sog / L.n) : 1,
  };
  league.awayGf = 2 - league.homeGf;
  league.awaySog = 2 - league.homeSog;

  // Goalies: save % (this + last season) and probable starters.
  const goalieRows = [...history.flatMap((d) => d.goalie_games || []), ...(data.goalie_games || []).filter((r) => r.week < beforeWeek)];
  const gSum = new Map();
  let lgSa = 0, lgSv = 0;
  for (const r of goalieRows) {
    const s = gSum.get(r.id) ?? { sa: 0, sv: 0, starts: 0 };
    s.sa += r.sa || 0; s.sv += r.saves || 0; if (r.starter) s.starts++;
    gSum.set(r.id, s);
    lgSa += r.sa || 0; lgSv += r.saves || 0;
  }
  const lgSvPct = lgSa ? lgSv / lgSa : 0.9;
  const S = sport.projection.saves;
  const svPct = (id) => {
    const s = gSum.get(id) ?? { sa: 0, sv: 0 };
    return (s.sv + S.kShots * lgSvPct) / (s.sa + S.kShots);
  };
  const names = new Map([...history, data].flatMap((d) => d.players.map((p) => [p.id, p.name])));
  // Probable starter: most starts in the team's last 10 games; on the second
  // night of a back-to-back, if he started yesterday, the team's other most-
  // used goalie. Right ~64% of the time in 2025-26 backtests (teams rotate),
  // so the UI labels it "probable, not confirmed".
  const starts = new Map();
  const gameDate = new Map(data.schedule.map((g) => [g.game_id, g.gameday]));
  for (const r of (data.goalie_games || []).filter((x) => x.week < beforeWeek && x.starter)) {
    if (!starts.has(r.team)) starts.set(r.team, []);
    starts.get(r.team).push(r);
  }
  for (const rows of starts.values()) rows.sort((a, b) => b.week - a.week);
  const mostStarts = (rows) => {
    const count = new Map();
    rows.forEach((r, i) => count.set(r.id, (count.get(r.id) || 0) + 1 + (rows.length - i) * 0.001));
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  };
  const probable = (team, g = null) => {
    const all = starts.get(team) || [];
    const rows = all.slice(0, 10);
    if (!rows.length) return null;
    let id = mostStarts(rows)[0];
    let reason = `${rows.filter((r) => r.id === id).length} of last ${rows.length} starts`;
    if (g && b2b(team, g) && rows[0].id === id) {
      const other = mostStarts(all).find((x) => x !== id);
      if (other) { reason = `${names.get(id) ?? 'The starter'} played yesterday (back-to-back), so likely the backup`; id = other; }
    }
    return { id, name: names.get(id) ?? 'Goalie', sv: svPct(id), reason, starts: rows.filter((r) => r.id === id).length, of: rows.length };
  };

  // Back-to-back: team played the previous calendar day.
  const dayOf = data.days || {};
  const playedDates = new Map(); // team -> Set(date)
  for (const g of data.schedule) {
    for (const t of [g.home, g.away]) {
      if (!playedDates.has(t)) playedDates.set(t, new Set());
      playedDates.get(t).add(g.gameday);
    }
  }
  const b2b = (team, g) => {
    const d = new Date(`${g.gameday}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return playedDates.get(team)?.has(d.toISOString().slice(0, 10)) ?? false;
  };
  // Days since the team's previous game (null for its first game).
  const sortedDates = new Map([...playedDates].map(([t, set]) => [t, [...set].sort()]));
  const restDays = (team, g) => {
    const prior = (sortedDates.get(team) || []).filter((d) => d < g.gameday);
    if (!prior.length) return null;
    return Math.round((new Date(`${g.gameday}T12:00:00Z`) - new Date(`${prior[prior.length - 1]}T12:00:00Z`)) / 864e5);
  };
  // Who was home in every loaded game (for players' home/away splits).
  const homeOf = new Map([...history, data].flatMap((d) => d.schedule.map((x) => [x.game_id, x.home])));

  // Games with play-by-play (team shot attempts present), and the league's
  // shots-on-goal per attempt.
  pbpGames = new Set([...history.flatMap((d) => d.team_games), ...data.team_games].filter((r) => r.cf != null).map((r) => r.game_id));
  let lgAtt = 0, lgSogP = 0;
  for (const r of [...history.flatMap((d) => d.player_games), ...data.player_games.filter((x) => x.week < beforeWeek)]) {
    if (!pbpGames.has(r.game_id)) continue;
    lgAtt += r.att || 0; lgSogP += r.sog || 0;
  }
  const lgSogPerAtt = lgAtt ? lgSogP / lgAtt : 0.5;

  // Team shots for / against per game (for goalie saves and the game model).
  const teamShots = new Map();
  for (const r of tg) {
    const s = teamShots.get(r.team) ?? { sf: 0, sa: 0, gf: 0, ga: 0, n: 0 };
    s.sf += r.sog; s.sa += r.sa; s.gf += r.gf; s.ga += r.ga; s.n++;
    teamShots.set(r.team, s);
  }

  return { data, beforeWeek, logs, prev, league, lgSvPct, svPct, probable, b2b, restDays, homeOf, teamShots, names, dayOf, lgSogPerAtt };
}

// ---- skaters -------------------------------------------------------------------
export function buildNhlProjector(sport, model, { history = [], disabled = new Set() } = {}) {
  const P = sport.projection;
  const ctx = context(sport, model, history);
  const statKeys = Object.keys(P.markets);

  function baseline(pl) {
    const rows = (ctx.logs.get(pl.id) || []).slice(0, pl.n);
    const prev = ctx.prev.get(pl.id) || [];
    const out = {};
    let w = rows.length;
    for (const k of sport.rawColumns) out[k] = rows.reduce((s, r) => s + (r[k] || 0), 0);
    if (P.baseline.priorGames && prev.length >= P.baseline.minPriorGames) {
      for (const k of sport.rawColumns) out[k] += P.baseline.priorGames * avgOf(prev, k);
      w += P.baseline.priorGames;
    }
    for (const k of sport.rawColumns) out[k] = w ? out[k] / w : 0;

    // Play-by-play extras (games that have them, this + last season).
    const pbpRows = [...rows, ...(P.baseline.priorGames && prev.length >= P.baseline.minPriorGames ? prev : [])].filter(hasPbp);
    const sum = (k) => pbpRows.reduce((s, r) => s + (r[k] || 0), 0);
    const n = pbpRows.length;
    out.pbpGames = n;
    if (n) {
      const att = sum('att'), sog = sum('sog'), ixg = sum('ixg'), g = sum('g');
      out.att = att / n; out.ixg = ixg / n; out.pptoi = sum('pptoi') / n;
      // Shots from attempts: his shots-per-attempt, regressed to league.
      const A = P.attempts;
      if (A.weight && att > 0) {
        const ratio = (sog + A.k * ctx.lgSogPerAtt) / (att + A.k);
        out.sog = (1 - A.weight) * out.sog + A.weight * out.att * ratio;
      }
      // Goals from expected goals: his finishing (goals / xG), regressed to 1.
      const X = P.xg;
      if (X.weight && ixg > 0) {
        const finish = (g + X.k) / (ixg + X.k);
        const fromXg = out.ixg * finish;
        const dg = (1 - X.weight) * out.g + X.weight * fromXg - out.g;
        out.g += dg;
        out.pts += dg; // points move with goals
      }
    }
    return out;
  }

  let gmCache = null;
  const gameModel = () => (gmCache ??= buildNhlGameModel(sport, model.data, { beforeWeek: model.beforeWeek, history, model }));
  const gfAvg = new Map();
  for (const r of model.data.team_games.filter((x) => x.week < model.beforeWeek)) {
    const t = gfAvg.get(r.team) ?? { gf: 0, n: 0 };
    t.gf += r.gf; t.n++;
    gfAvg.set(r.team, t);
  }
  // Regressed toward the league average (10 games).
  const teamAvgGf = (team) => { const t = gfAvg.get(team) ?? { gf: 0, n: 0 }; return (t.gf + 10 * ctx.league.gf) / (t.n + 10); };

  function project(pl, g) {
    const isHome = g.home === pl.team;
    const opp = isHome ? g.away : g.home;
    const base = baseline(pl);
    const factors = [];
    const scoring = (k) => k === 'g' || k === 'a' || k === 'pts';

    // Opponent's allowance to this position, per stat.
    if (!disabled.has('opp')) {
      const n = model.team[opp]?.n ?? 0;
      const mult = {};
      for (const k of statKeys) {
        const s = model.posStat(opp, pl.pos, k, 'def');
        const raw = s.leagueAvg > 0.01 ? s.value / s.leagueAvg : 1;
        // Only for stats where backtests showed it helps (P.opponentStats).
        mult[k] = P.opponentStats.includes(k) ? 1 + P.opponentWeight * (regress(raw, n, P.regress.opponent) - 1) : 1;
      }
      const sp = model.posStat(opp, pl.pos, 'pts', 'def');
      const ss = model.posStat(opp, pl.pos, 'sog', 'def');
      factors.push({
        id: 'opp', label: 'Opponent',
        text: `${opp} vs ${pl.pos}: ${ss.value?.toFixed(1)} SOG/G (${rankWord(model, ss.rank)})`,
        m: (k) => mult[k] ?? 1,
      });
    }

    // Home ice.
    if (!disabled.has('home') && P.homeWeight) {
      const gfm = isHome ? ctx.league.homeGf : ctx.league.awayGf;
      const sm = isHome ? ctx.league.homeSog : ctx.league.awaySog;
      factors.push({
        id: 'home', label: isHome ? 'Home' : 'Road', text: isHome ? 'Home ice' : 'Road game',
        m: (k) => 1 + P.homeWeight * ((scoring(k) ? gfm : k === 'sog' ? sm : 1) - 1),
      });
    }

    // Opposing probable goalie.
    const og = ctx.probable(opp, g);
    if (!disabled.has('goalie') && og && P.goalieWeight) {
      const m = clamp(((1 - og.sv) / (1 - ctx.lgSvPct)) ** P.goalieWeight, 0.75, 1.3);
      factors.push({
        id: 'goalie', label: 'Opp goalie',
        text: `vs ${og.name} (${(og.sv * 100).toFixed(1)}% sv)`,
        m: (k) => (scoring(k) ? m : 1),
      });
    }

    // Second night of a back-to-back: his team tired, or the opponent tired.
    const ownB2b = ctx.b2b(pl.team, g), oppB2b = ctx.b2b(opp, g);
    if (!disabled.has('b2b') && P.b2bWeight && ownB2b) {
      const m = 1 - P.b2bWeight;
      factors.push({ id: 'b2b', label: 'Back-to-back', text: `${pl.team} played yesterday`, m: (k) => (k === 'blk' ? 1 : m) });
    }
    if (!disabled.has('oppB2b') && P.oppB2bWeight && oppB2b) {
      const m = 1 + P.oppB2bWeight;
      factors.push({ id: 'oppB2b', label: 'Tired opponent', text: `${opp} played yesterday`, m: (k) => (k === 'blk' ? 1 : m) });
    }
    // Extra rest (3+ days off): rust or freshness.
    const rest = ctx.restDays(pl.team, g);
    if (!disabled.has('rest') && P.restWeight && rest != null && rest >= 3) {
      const m = 1 + P.restWeight;
      factors.push({ id: 'rest', label: 'Rest', text: `${rest} days since ${pl.team}'s last game`, m: (k) => (k === 'blk' ? 1 : m) });
    }

    // His own home/away split beyond the league-wide home-ice effect,
    // regressed by games played at this venue type (this + last season).
    if (!disabled.has('split') && P.split.weight) {
      const all = [...(ctx.logs.get(pl.id) || []).slice(0, pl.n), ...(ctx.prev.get(pl.id) || [])];
      const venue = all.filter((r) => (ctx.homeOf.get(r.game_id) === r.team) === isHome);
      if (venue.length >= 5 && all.length >= 10) {
        const lgVenue = { sog: isHome ? ctx.league.homeSog : ctx.league.awaySog, g: isHome ? ctx.league.homeGf : ctx.league.awayGf };
        const mult = {};
        for (const k of statKeys) {
          const tot = avgOf(all, k);
          if (!(tot > 0.05)) { mult[k] = 1; continue; }
          const lv = k === 'sog' ? lgVenue.sog : scoring(k) ? lgVenue.g : 1;
          const raw = avgOf(venue, k) / tot / lv;
          mult[k] = clamp(1 + P.split.weight * (regress(raw, venue.length, P.split.k) - 1), 0.8, 1.25);
        }
        const v = avgOf(venue, 'sog'), o = avgOf(all.filter((r) => (ctx.homeOf.get(r.game_id) === r.team) !== isHome), 'sog');
        factors.push({
          id: 'split', label: isHome ? 'Home split' : 'Road split',
          text: `${v.toFixed(1)} SOG/G ${isHome ? 'at home' : 'on the road'} vs ${o.toFixed(1)} ${isHome ? 'away' : 'home'} (${venue.length} games)`,
          m: (k) => mult[k] ?? 1,
        });
      }
    }

    // Hot/cold streak: last N games vs his baseline.
    if (!disabled.has('form') && P.form.weight) {
      const rows = ctx.logs.get(pl.id) || [];
      if (rows.length > P.form.games) {
        const recent = rows.slice(0, P.form.games);
        const mult = {};
        for (const k of statKeys) mult[k] = base[k] > 0.05 ? clamp(1 + P.form.weight * (avgOf(recent, k) / base[k] - 1), 0.8, 1.25) : 1;
        factors.push({ id: 'form', label: 'Form', text: `${avgOf(recent, 'pts').toFixed(2)} pts, ${avgOf(recent, 'sog').toFixed(1)} SOG last ${P.form.games}`, m: (k) => mult[k] });
      }
    }

    // Team scoring tonight: the game model's expected goals for his team vs
    // the team's average (opponent defense, goalie, home ice in one number).
    if (!disabled.has('team') && P.teamGoals.weight) {
      const gm = gameModel();
      const x = gm.predict(g);
      const exp = isHome ? x.ptsHome : x.ptsAway;
      const avg = teamAvgGf(pl.team);
      if (avg > 0) {
        const m = clamp((exp / avg) ** P.teamGoals.weight, 0.75, 1.35);
        factors.push({
          id: 'team', label: 'Team goals',
          text: `${pl.team} expected ${exp.toFixed(2)} goals (avg ${avg.toFixed(2)})`,
          m: (k) => (scoring(k) ? m : k === 'sog' ? 1 + (m - 1) * P.teamGoals.sogShare : 1),
        });
      }
    }

    // Power-play role: recent PP ice time vs his usual (PP1 promotions /
    // demotions move points more than even-strength ice time does).
    if (!disabled.has('pp') && P.pp.weight && base.pbpGames >= P.pp.games + 3) {
      const rows = (ctx.logs.get(pl.id) || []).filter(hasPbp).slice(0, P.pp.games);
      if (rows.length === P.pp.games) {
        const recent = avgOf(rows, 'pptoi');
        const rel = (recent - base.pptoi) / (base.pptoi + P.pp.c);
        const m = clamp(1 + P.pp.weight * rel, 0.75, 1.3);
        if (Math.abs(rel) > 0.05) {
          factors.push({
            id: 'pp', label: 'Power play',
            text: `PP ${recent.toFixed(1)} min last ${P.pp.games} (avg ${base.pptoi.toFixed(1)})`,
            m: (k) => (k === 'blk' ? 1 : k === 'sog' ? 1 + (m - 1) * P.pp.sogShare : m),
          });
        }
      }
    }

    // Ice-time trend (line / power-play promotions show up in TOI first).
    if (!disabled.has('toi') && P.toiTrend.weight) {
      const rows = ctx.logs.get(pl.id) || [];
      if (rows.length > P.toiTrend.games) {
        const recent = avgOf(rows.slice(0, P.toiTrend.games), 'toi');
        const all = avgOf(rows.slice(0, pl.n), 'toi');
        if (all > 5) {
          const m = clamp(1 + P.toiTrend.weight * (recent / all - 1), 1 - P.toiTrend.cap, 1 + P.toiTrend.cap);
          factors.push({ id: 'toi', label: 'Ice time', text: `TOI ${recent.toFixed(1)} last ${P.toiTrend.games} (avg ${all.toFixed(1)})`, m: (k) => (k === 'toi' ? 1 : m) });
        }
      }
    }

    const combine = (skip) => Object.fromEntries(statKeys.map((k) => {
      let m = 1;
      for (const f of factors) if (f !== skip) m *= f.m(k);
      return [k, base[k] * clamp(m, 0.5, 1.8)];
    }));
    const proj = combine(null);
    for (const f of factors) {
      const w = combine(f);
      f.impact = w.pts > 0 ? proj.pts / w.pts - 1 : 0;
      f.impactSog = w.sog > 0 ? proj.sog / w.sog - 1 : 0;
    }
    const probs = {};
    for (const [k, mk] of Object.entries(P.markets)) probs[k] = mk.lines.map((line) => nbAtLeast(proj[k], mk.r, Math.floor(line) + 1));
    return { opp, isHome, game: g, base, proj, probs, factors, oppGoalie: og, toi: base.toi };
  }

  // Schedule spot and his own home/away split, for display. The split and
  // streaks don't feed the projection: they made backtests worse.
  function situation(pl, g) {
    const isHome = g.home === pl.team;
    const opp = isHome ? g.away : g.home;
    const all = [...(ctx.logs.get(pl.id) || []).slice(0, pl.n), ...(ctx.prev.get(pl.id) || [])];
    const atHome = all.filter((r) => ctx.homeOf.get(r.game_id) === r.team);
    const away = all.filter((r) => ctx.homeOf.get(r.game_id) !== r.team);
    const venue = isHome ? atHome : away, other = isHome ? away : atHome;
    const split = Object.fromEntries(statKeys.map((k) => [k, { venue: avgOf(venue, k), other: avgOf(other, k) }]));
    const recent = (ctx.logs.get(pl.id) || []).slice(0, 5);
    return {
      isHome, opp, ownB2b: ctx.b2b(pl.team, g), oppB2b: ctx.b2b(opp, g),
      rest: ctx.restDays(pl.team, g), oppRest: ctx.restDays(opp, g),
      split, nVenue: venue.length, nOther: other.length,
      last5: recent.length >= 5 ? Object.fromEntries(statKeys.map((k) => [k, avgOf(recent, k)])) : null,
    };
  }

  return { project, situation, ctx };
}

function rankWord(model, rank) {
  if (rank == null) return '';
  const most = model.N - rank + 1;
  return most <= model.N / 2 ? `${ordinal(most)}-most` : `${ordinal(rank)}-fewest`;
}
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// ---- goalies ---------------------------------------------------------------------
export function goalieSaves(sport, ctx, team, opp, isHome, game = null) {
  const S = sport.projection.saves;
  const g = ctx.probable(team, game);
  if (!g) return null;
  const lgS = ctx.league.sog;
  const reg = (s, key) => (s ? (s[key] + S.kGames * lgS) / (s.n + S.kGames) : lgS);
  const oppSf = reg(ctx.teamShots.get(opp), 'sf'); // shots the opponent takes
  const ownSa = reg(ctx.teamShots.get(team), 'sa'); // shots this team allows
  const home = isHome ? ctx.league.awaySog : ctx.league.homeSog; // opponent's venue effect
  const sa = lgS * (oppSf / lgS) * (ownSa / lgS) * home;
  const saves = sa * g.sv;
  const lines = [-2, 0, 2].map((d) => Math.floor(saves + d) + 0.5);
  return {
    ...g, sa, saves,
    probs: lines.map((line) => ({ line, p: nbAtLeast(saves, S.r, Math.floor(line) + 1) })),
  };
}

// ---- games -------------------------------------------------------------------------
const poisson = (lam, k) => { let p = Math.exp(-lam); for (let i = 1; i <= k; i++) p *= lam / i; return p; };

export function buildNhlGameModel(sport, data, { beforeWeek = Infinity, history = [], model = null } = {}) {
  const C = sport.projection.game;
  const teams = data.teams.map((t) => t.abbr);
  const rows = [];
  const add = (tgs, w) => {
    for (const r of tgs) rows.push({ off: r.team, def: r.opp, gf: r.gf, sog: r.sog, xgf: r.xgf, home: r.home, w });
  };
  for (const d of history) add(d.team_games, C.priorWeight);
  add(data.team_games.filter((r) => r.week < beforeWeek), 1);
  const W = rows.reduce((s, r) => s + r.w, 0);
  const mGf = rows.reduce((s, r) => s + r.w * r.gf, 0) / W;
  const mSog = rows.reduce((s, r) => s + r.w * r.sog, 0) / W;
  const shPct = mGf / mSog;
  const homeRows = rows.filter((r) => r.home);
  const hfa = C.homeIce ? homeRows.reduce((s, r) => s + r.w * r.gf, 0) / homeRows.reduce((s, r) => s + r.w, 0) - mGf : 0;

  // Expected goals: only games with play-by-play.
  const xgRows = rows.filter((r) => r.xgf != null);
  const mXg = xgRows.length ? xgRows.reduce((s, r) => s + r.w * r.xgf, 0) / xgRows.reduce((s, r) => s + r.w, 0) : mGf;
  function fit(key, mean) {
    const o = Object.fromEntries(teams.map((t) => [t, 0]));
    const d = Object.fromEntries(teams.map((t) => [t, 0]));
    for (let it = 0; it < 50; it++) {
      const on = {}, dn = {}, od = {}, dd = {};
      for (const t of teams) { on[t] = 0; dn[t] = 0; od[t] = C.ridge; dd[t] = C.ridge; }
      for (const r of rows) {
        if (!(r.off in o) || !(r.def in d) || r[key] == null) continue;
        const s = key === 'gf' ? (r.home ? hfa / 2 : -hfa / 2) : 0;
        on[r.off] += r.w * (r[key] - mean - d[r.def] - s); od[r.off] += r.w;
        dn[r.def] += r.w * (r[key] - mean - o[r.off] - s); dd[r.def] += r.w;
      }
      for (const t of teams) { o[t] = on[t] / od[t]; d[t] = dn[t] / dd[t]; }
    }
    return { o, d };
  }
  const goals = fit('gf', mGf);
  const shots = fit('sog', mSog);
  const xg = C.xgWeight ? fit('xgf', mXg) : null;
  const xs = mGf / mXg; // expected goals → goals scale
  const O = {}, D = {};
  for (const t of teams) {
    const wx = xg ? C.xgWeight : 0;
    O[t] = (1 - C.shotWeight - wx) * goals.o[t] + C.shotWeight * shots.o[t] * shPct + (xg ? wx * xg.o[t] * xs : 0);
    D[t] = (1 - C.shotWeight - wx) * goals.d[t] + C.shotWeight * shots.d[t] * shPct + (xg ? wx * xg.d[t] * xs : 0);
  }

  // Goalie: probable starter's save % vs the team's average this season.
  const ctx = model ? context(sport, model, history) : null;
  const teamSv = new Map();
  for (const r of (data.goalie_games || []).filter((x) => x.week < beforeWeek)) {
    const s = teamSv.get(r.team) ?? { sa: 0, sv: 0 };
    s.sa += r.sa || 0; s.sv += r.saves || 0;
    teamSv.set(r.team, s);
  }
  let gameNow = null;
  const goalieAdj = (team, oppShots) => {
    if (!ctx || !C.goalieWeight) return { goals: 0 };
    const g = ctx.probable(team, gameNow);
    const s = teamSv.get(team);
    if (!g || !s?.sa) return { goals: 0, goalie: g };
    const teamPct = (s.sv + 500 * ctx.lgSvPct) / (s.sa + 500);
    return { goals: C.goalieWeight * oppShots * (teamPct - g.sv), goalie: g };
  };

  function predict(g) {
    gameNow = g;
    let lh = mGf + O[g.home] + D[g.away] + hfa / 2;
    let la = mGf + O[g.away] + D[g.home] - hfa / 2;
    const gh = goalieAdj(g.home, la / shPct), ga = goalieAdj(g.away, lh / shPct);
    la += gh.goals; // home goalie affects away goals
    lh += ga.goals;
    // Second night of a back-to-back: fewer goals for, more against.
    const b2bHome = ctx ? ctx.b2b(g.home, g) : false, b2bAway = ctx ? ctx.b2b(g.away, g) : false;
    if (C.b2bFor || C.b2bAgainst) {
      if (b2bHome) { lh -= C.b2bFor || 0; la += C.b2bAgainst || 0; }
      if (b2bAway) { la -= C.b2bFor || 0; lh += C.b2bAgainst || 0; }
    }
    lh = Math.max(0.8, lh); la = Math.max(0.8, la);
    let pH = 0, pT = 0, pPL = 0, over55 = 0, over65 = 0;
    for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
      const p = poisson(lh, i) * poisson(la, j);
      if (i > j) pH += p; else if (i === j) pT += p;
      if (i - j >= 2) pPL += p;
      if (i + j >= 6) over55 += p;
      if (i + j >= 7) over65 += p;
    }
    // Squeeze toward 50/50 by C.calib (backtests: raw Poisson was overconfident).
    const pHome = 0.5 + C.calib * (pH + pT * (0.5 + C.otHomeEdge) - 0.5);
    return {
      ptsHome: lh, ptsAway: la, margin: lh - la, total: lh + la, pHome,
      pRegTie: pT, pHomeMinus15: pPL, pOver55: over55, pOver65: over65,
      goalieHome: gh.goalie, goalieAway: ga.goalie, b2bHome, b2bAway,
      restHome: ctx?.restDays(g.home, g) ?? null, restAway: ctx?.restDays(g.away, g) ?? null,
    };
  }
  const rating = (t) => ({ off: O[t], def: -D[t], net: O[t] - D[t] });
  return { predict, rating, teams, mGf, hfa };
}
