// First touchdown: P(player scores his team's first TD) and P(game's first TD).
//
// Treat each player's touchdowns as arriving at a rate λ (expected rush+rec TDs
// from the projection model, which already folds in Vegas, red-zone usage,
// opponent, weather, injuries...). Who scores *first* then depends on each
// player's share of his team's rate (flattened by λ^power), and three
// first-TD-specific factors are computed alongside:
//
//   early role   share of the team's first-quarter touches vs his overall share
//                (scripted opening drives)
//   history      how often his TDs were his team's first, vs chance
//   defense      which positions this defense gives up first TDs to
//
// Backtests (2025 + 2026) found none of the three improve predictions beyond
// the TD share at any strength, so they are shown as context and only
// weighted in when listed in config `firstTd.apply`.
//
// P(team first TD) = his weighted share × P(team scores a TD)
// P(game first TD) = his weighted share × P(his team scores first)
// with P(team scores) = 1 − e^−Λ and P(A first) = Λa/(Λa+Λb)·(1 − e^−(Λa+Λb)).

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

export function buildFirstTd(sport, model, projector, { history = [], disabled = new Set() } = {}) {
  const C = sport.projection.firstTd;
  const data = model.data;
  const beforeWeek = model.beforeWeek;
  const info = new Map([...history, data].flatMap((d) => d.players.map((p) => [p.id, p])));

  // ---- per-game team totals (current season before this week, plus history) --
  const prior = [...history.flatMap((d) => d.player_games), ...data.player_games.filter((r) => r.week < beforeWeek)];
  const teamGame = new Map(); // game|team -> { q1, opp, tds }
  for (const r of prior) {
    const k = `${r.game_id}|${r.team}`;
    const t = teamGame.get(k) ?? { q1: 0, opp: 0, tds: 0 };
    t.q1 += (r.q1_car || 0) + (r.q1_tgt || 0);
    t.opp += (r.rush_att || 0) + (r.tgt || 0);
    t.tds += (r.rush_td || 0) + (r.rec_td || 0);
    teamGame.set(k, t);
  }
  const byPlayer = new Map();
  for (const r of prior) {
    if (!byPlayer.has(r.id)) byPlayer.set(r.id, []);
    byPlayer.get(r.id).push(r);
  }

  // ---- defenses: which positions score the first TD against them ----------
  const current = data.player_games.filter((r) => r.week < beforeWeek);
  const allowed = new Map(); // defense -> { pos -> n, total }
  const league = {};
  let leagueTotal = 0;
  for (const r of current) {
    if (!r.ftd_team) continue;
    const pos = info.get(r.id)?.pos;
    const pk = sport.positions[pos] ? pos : 'other';
    const a = allowed.get(r.opp) ?? { total: 0 };
    a[pk] = (a[pk] || 0) + 1;
    a.total++;
    allowed.set(r.opp, a);
    league[pk] = (league[pk] || 0) + 1;
    leagueTotal++;
  }
  const leagueShare = (pos) => (leagueTotal ? (league[pos] || 0) / leagueTotal : 0);

  function defenseFactor(opp, pos) {
    const a = allowed.get(opp);
    const n = model.team[opp]?.n ?? 0;
    const ls = leagueShare(pos);
    if (!a || !n || !ls) return { m: 1 };
    const share = (a[pos] || 0) / n; // first TDs to this position per game played
    const lsPerGame = ls * (leagueTotal / Math.max(1, current.length ? new Set(current.map((r) => `${r.game_id}|${r.opp}`)).size : 1));
    const raw = lsPerGame > 0 ? share / lsPerGame : 1;
    const m = clamp(1 + (raw - 1) * (n / (n + C.kDefense)), 0.7, 1.4);
    return { m, text: `${opp} gave up the first TD to a ${pos} in ${a[pos] || 0} of ${n} games (league ${(lsPerGame * 100).toFixed(0)}%)` };
  }

  function earlyFactor(p) {
    const rows = (byPlayer.get(p.id) || []).filter((r) => r.team === p.team).sort((a, b) => b.week - a.week).slice(0, Math.max(p.n, 1));
    let q1 = 0, q1Team = 0, opp = 0, oppTeam = 0;
    for (const r of rows) {
      const t = teamGame.get(`${r.game_id}|${r.team}`);
      if (!t) continue;
      q1 += (r.q1_car || 0) + (r.q1_tgt || 0);
      q1Team += t.q1;
      opp += (r.rush_att || 0) + (r.tgt || 0);
      oppTeam += t.opp;
    }
    if (!q1Team || !opp || !oppTeam) return { m: 1 };
    const q1Share = q1 / q1Team, share = opp / oppTeam;
    const n = rows.length;
    const m = clamp(1 + (q1Share / share - 1) * (n / (n + C.kEarly)), 0.6, 1.6);
    return { m, q1Share, share, text: `${(q1Share * 100).toFixed(0)}% of team's 1st-quarter touches vs ${(share * 100).toFixed(0)}% overall` };
  }

  function historyFactor(p) {
    let obs = 0, exp = 0, scored = 0;
    for (const r of byPlayer.get(p.id) || []) {
      const t = teamGame.get(`${r.game_id}|${r.team}`);
      const mine = (r.rush_td || 0) + (r.rec_td || 0);
      if (!t || !t.tds || !mine) continue;
      scored++;
      obs += r.ftd_team ? 1 : 0;
      exp += Math.min(1, mine / t.tds); // chance one of his TDs was first if order were random
    }
    if (!scored) return { m: 1 };
    const m = clamp((obs + C.kHistory) / (exp + C.kHistory), 0.6, 1.6);
    return { m, obs, exp, text: `Team's first TD in ${obs} of ${scored} games he scored (≈ ${exp.toFixed(1)} expected by chance)` };
  }

  // ---- one game --------------------------------------------------------------
  function forGame(g) {
    const teams = {};
    for (const team of [g.away, g.home]) {
      const roster = model.players.filter((p) => p.team === team && p.active && !projector.isOut(p));
      const rows = roster
        .map((p) => {
          const r = projector.project(p, g);
          const lam = r.td.lambda;
          if (!(lam > 0.002)) return null;
          const f = {
            early: disabled.has('early') ? { m: 1 } : earlyFactor(p),
            hist: disabled.has('hist') ? { m: 1 } : historyFactor(p),
            def: disabled.has('def') ? { m: 1 } : defenseFactor(r.opp, p.pos),
          };
          // λ^power flattens shares: raw TD rates over-concentrate on stars.
          const tilt = C.apply.reduce((m, k) => m * f[k].m, 1);
          return { p, r, lam, f, w: lam ** C.power * tilt };
        })
        .filter(Boolean);
      const lam = rows.reduce((s, x) => s + x.lam, 0) + C.dstRate;
      const W = rows.reduce((s, x) => s + x.w, 0) + C.dstRate;
      teams[team] = { rows, lam, W, pScore: 1 - Math.exp(-lam) };
    }
    const A = teams[g.away], B = teams[g.home];
    const both = A.lam + B.lam;
    const pAnyTd = 1 - Math.exp(-both);
    for (const [team, T] of Object.entries(teams)) {
      T.pFirst = (T.lam / both) * pAnyTd; // this team scores the game's first TD
      for (const x of T.rows) {
        x.share = x.w / T.W;
        x.teamFirst = C.scale * x.share * T.pScore;
        x.gameFirst = C.scale * x.share * T.pFirst;
        x.team = team;
      }
    }
    return { teams, pAnyTd, players: [...A.rows, ...B.rows] };
  }

  return { forGame };
}
