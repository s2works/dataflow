// Game projections: projected score, spread, total and win probability.
//
// Opponent-adjusted offense/defense ratings (a points-based "simple rating
// system"): each game says
//     home pts = μ + O[home] + D[away] + HFA/2
//     away pts = μ + O[away] + D[home] − HFA/2
// O = points scored above average, D = points allowed above average (positive =
// bad defense). Solved by weighted, ridge-regularized least squares, so a team
// with few games is pulled toward average. Last season's games count at a
// reduced weight as a prior.
//
// The same fit is run on offensive EPA per play (a steadier measure of team
// quality than points), converted to points via plays per game, and blended
// in with weight epaWeight. Win probability treats the final margin as normal
// around the projected spread. All knobs live in sport.projection.game and are
// tuned by tools/backtest.mjs.

const normCdf = (x) => {
  // Abramowitz–Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};

export function buildGameModel(sport, data, { beforeWeek = Infinity, history = [] } = {}) {
  const C = sport.projection.game;
  const games = [];
  const push = (g, w) => {
    if (g.home_score == null || g.away_score == null) return;
    games.push({ h: g.home, a: g.away, hp: g.home_score, ap: g.away_score, neutral: g.location === 'Neutral', w });
  };
  for (const d of history) for (const g of d.schedule) push(g, C.priorWeight);
  for (const g of data.schedule) if (g.week < beforeWeek) push(g, 1);

  const teams = data.teams.map((t) => t.abbr);
  const W = games.reduce((s, g) => s + g.w, 0);
  const mu = W ? games.reduce((s, g) => s + g.w * (g.hp + g.ap), 0) / (2 * W) : 22;
  const hGames = games.filter((g) => !g.neutral);
  const hw = hGames.reduce((s, g) => s + g.w, 0);
  const hfa = hw ? hGames.reduce((s, g) => s + g.w * (g.hp - g.ap), 0) / hw : 1.5;

  // Generic opponent-adjusted fit over offense rows {off, def, y, w, s}:
  // y = mean + O[off] + D[def] + s.
  function fit(rows, mean, ridge) {
    const o = Object.fromEntries(teams.map((t) => [t, 0]));
    const d = Object.fromEntries(teams.map((t) => [t, 0]));
    for (let it = 0; it < 60; it++) {
      const oNum = {}, dNum = {}, oDen = {}, dDen = {};
      for (const t of teams) { oNum[t] = 0; dNum[t] = 0; oDen[t] = ridge; dDen[t] = ridge; }
      for (const r of rows) {
        if (!(r.off in o) || !(r.def in d)) continue;
        oNum[r.off] += r.w * (r.y - mean - d[r.def] - r.s); oDen[r.off] += r.w;
        dNum[r.def] += r.w * (r.y - mean - o[r.off] - r.s); dDen[r.def] += r.w;
      }
      for (const t of teams) { o[t] = oNum[t] / oDen[t]; d[t] = dNum[t] / dDen[t]; }
    }
    return { o, d };
  }

  // Points
  const side = (g) => (g.neutral ? 0 : hfa / 2);
  const ptRows = games.flatMap((g) => [
    { off: g.h, def: g.a, y: g.hp, w: g.w, s: side(g) },
    { off: g.a, def: g.h, y: g.ap, w: g.w, s: -side(g) },
  ]);
  const pts = fit(ptRows, mu, C.ridge);

  // EPA per play, as points: (EPA/play above average) × plays per game.
  const epaRows = [];
  const addEpa = (rows, w) => {
    for (const r of rows) if (r.plays) epaRows.push({ off: r.team, def: r.opp, y: r.epa / r.plays, w, s: 0, plays: r.plays });
  };
  for (const d of history) addEpa(d.team_games, C.priorWeight);
  addEpa(data.team_games.filter((r) => r.week < beforeWeek), 1);
  const ew = epaRows.reduce((s, r) => s + r.w, 0);
  const epaMean = ew ? epaRows.reduce((s, r) => s + r.w * r.y, 0) / ew : 0;
  const playsPerGame = ew ? epaRows.reduce((s, r) => s + r.w * r.plays, 0) / ew : 60;
  const epa = ew ? fit(epaRows, epaMean, C.ridge) : null;

  const a = epa ? C.epaWeight : 0;
  const O = {}, D = {};
  for (const t of teams) {
    O[t] = (1 - a) * pts.o[t] + a * (epa ? epa.o[t] * playsPerGame * C.epaScale : 0);
    D[t] = (1 - a) * pts.d[t] + a * (epa ? epa.d[t] * playsPerGame * C.epaScale : 0);
  }

  function predict(g) {
    const s = g.location === 'Neutral' ? 0 : hfa / 2;
    const ptsHome = mu + O[g.home] + D[g.away] + s;
    const ptsAway = mu + O[g.away] + D[g.home] - s;
    const margin = ptsHome - ptsAway; // + = home wins by
    return {
      ptsHome, ptsAway, margin,
      total: ptsHome + ptsAway,
      pHome: normCdf(margin / C.marginSd),
      // P(home covers the market spread) and P(over the market total), for edges.
      pHomeCover: g.spread_line != null ? normCdf((margin - g.spread_line) / C.marginSd) : null,
      pOver: g.total_line != null ? normCdf((ptsHome + ptsAway - g.total_line) / C.totalSd) : null,
    };
  }

  // Net rating: points better than average per game on a neutral field.
  const rating = (t) => ({ off: O[t], def: -D[t], net: O[t] - D[t] });
  return { predict, rating, mu, hfa, teams };
}
