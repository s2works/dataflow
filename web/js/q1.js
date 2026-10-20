// First-quarter projections: receptions, receiving / rushing / passing yards.
//
// Q1 projection = full-game projection × Q1 share, where the Q1 share starts at
// the league rate (~22% of passing, ~24% of rushing) and is tilted by:
//   player    his own share of production that comes in the 1st quarter
//   team      fast/slow-starting offenses (scripted openings)
//   defense   how much this opponent gives up early vs late
// Each tilt is regressed toward 1 by games played (n / (n + k)); k values
// are tuned by backtest (tools/backtest.mjs).

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Q1 stat -> full-game stat it is a share of.
export const Q1_STATS = {
  q1_pass_yds: { full: 'pass_yds', label: '1Q Pass Yds', pos: ['QB'] },
  q1_rush_yds: { full: 'rush_yds', label: '1Q Rush Yds', pos: ['QB', 'RB'] },
  q1_rec: { full: 'rec', label: '1Q Receptions', pos: ['RB', 'WR', 'TE'] },
  q1_rec_yds: { full: 'rec_yds', label: '1Q Rec Yds', pos: ['RB', 'WR', 'TE'] },
};

export function buildQ1(sport, model, projector, { history = [], disabled = new Set() } = {}) {
  const K = sport.projection.q1;
  const data = model.data;
  const prior = [...history.flatMap((d) => d.player_games), ...data.player_games.filter((r) => r.week < model.beforeWeek)];
  const keys = Object.keys(Q1_STATS);

  // League shares and per-player / per-team / per-defense sums.
  const league = {};
  const sums = { player: new Map(), team: new Map(), defense: new Map() };
  const add = (map, key, r) => {
    const s = map.get(key) ?? { games: new Set() };
    for (const k of keys) {
      const f = Q1_STATS[k].full;
      s[k] = (s[k] || 0) + (r[k] || 0);
      s[f] = (s[f] || 0) + (r[f] || 0);
    }
    s.games.add(r.game_id);
    map.set(key, s);
  };
  for (const r of prior) {
    for (const k of keys) {
      const f = Q1_STATS[k].full;
      league[k] = league[k] ?? { q1: 0, full: 0 };
      league[k].q1 += r[k] || 0;
      league[k].full += r[f] || 0;
    }
    add(sums.player, r.id, r);
    // Team and defense tendencies use the current season only (rosters change).
    add(sums.team, `${r.game_id.slice(0, 4)}|${r.team}`, r);
    add(sums.defense, `${r.game_id.slice(0, 4)}|${r.opp}`, r);
  }
  const L = Object.fromEntries(keys.map((k) => [k, league[k].full ? league[k].q1 / league[k].full : 0.22]));
  const season = String(data.season);

  function tilt(s, k, kReg) {
    if (!s) return { m: 1, n: 0 };
    const f = Q1_STATS[k].full;
    if (!(s[f] > 0)) return { m: 1, n: 0 };
    const raw = s[k] / s[f] / L[k];
    const n = s.games.size;
    return { m: clamp(1 + (raw - 1) * (n / (n + kReg)), 0.5, 1.8), n, share: s[k] / s[f] };
  }

  function project(p, r) {
    const out = {};
    for (const [k, def] of Object.entries(Q1_STATS)) {
      if (!def.pos.includes(p.pos)) continue;
      const full = r.proj[def.full];
      if (full == null) continue;
      const pl = disabled.has('player') ? { m: 1 } : tilt(sums.player.get(p.id), k, K.kPlayer);
      const tm = disabled.has('team') ? { m: 1 } : tilt(sums.team.get(`${season}|${p.team}`), k, K.kTeam);
      const df = disabled.has('defense') ? { m: 1 } : tilt(sums.defense.get(`${season}|${r.opp}`), k, K.kDefense);
      const share = L[k] * pl.m * tm.m * df.m;
      out[k] = { proj: full * share, share, league: L[k], player: pl, team: tm, defense: df, label: def.label, full: def.full };
    }
    return out;
  }

  return { project, league: L };
}
