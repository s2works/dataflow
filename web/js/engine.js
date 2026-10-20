// Sport-agnostic ranking + matchup engine.
//
// Ranks are always oriented so that #1 is the best *unit*:
//   offense rank 1  = most offense-favorable value (e.g. most pass yds/G)
//   defense rank 1  = least offense-favorable value allowed (stingiest)
// A matchup edge is then simply  defenseRank - offenseRank :
//   offense 3rd vs defense 30th  ->  +27  (big edge for the offense, green)
//   offense 30th vs defense 3rd  ->  -27  (big edge for the defense, red)

const sum = (target, row, cols) => {
  for (const c of cols) target[c] = (target[c] || 0) + (row[c] || 0);
  return target;
};

function rankMap(values, higherFirst) {
  // values: [[key, number|null]] -> Map(key -> rank), ties share the best rank.
  const valid = values.filter(([, v]) => v != null && Number.isFinite(v));
  valid.sort((a, b) => (higherFirst ? b[1] - a[1] : a[1] - b[1]));
  const ranks = new Map();
  valid.forEach(([k, v], i) => {
    const prev = i > 0 ? valid[i - 1] : null;
    ranks.set(k, prev && prev[1] === v ? ranks.get(prev[0]) : i + 1);
  });
  return ranks;
}

export function buildModel(sport, data, { beforeWeek = Infinity, lastN = 0 } = {}) {
  const teams = data.teams.map((t) => t.abbr);
  const teamCols = Object.keys(data.team_games[0] || {}).filter(
    (k) => typeof data.team_games[0][k] === 'number' && k !== 'week',
  );
  const posCols = sport.rawColumns;
  const positions = Object.keys(sport.positions);

  // ---- index rows -------------------------------------------------------
  const tgByKey = new Map();
  const gamesByTeam = new Map(teams.map((t) => [t, []]));
  for (const r of data.team_games) {
    if (r.week >= beforeWeek) continue;
    tgByKey.set(`${r.game_id}|${r.team}`, r);
    gamesByTeam.get(r.team)?.push(r);
  }
  const pgByKey = new Map();
  for (const r of data.position_games) {
    if (r.week >= beforeWeek) continue;
    pgByKey.set(`${r.game_id}|${r.team}|${r.pos}`, r);
  }

  // ---- team aggregates -------------------------------------------------
  const team = {};
  for (const t of teams) {
    let games = gamesByTeam.get(t).sort((a, b) => b.week - a.week);
    if (lastN > 0) games = games.slice(0, lastN);
    const off = {}, def = {}, offPos = {}, defPos = {};
    for (const p of positions) { offPos[p] = {}; defPos[p] = {}; }
    for (const g of games) {
      sum(off, g, teamCols);
      const opp = tgByKey.get(`${g.game_id}|${g.opp}`);
      if (opp) sum(def, opp, teamCols);
      for (const p of positions) {
        const o = pgByKey.get(`${g.game_id}|${t}|${p}`);
        if (o) sum(offPos[p], o, posCols);
        const d = pgByKey.get(`${g.game_id}|${g.opp}|${p}`);
        if (d) sum(defPos[p], d, posCols);
      }
    }
    for (const p of positions) { sport.derive(offPos[p]); sport.derive(defPos[p]); }
    team[t] = { n: games.length, games: games.map((g) => g.game_id), lastWeek: games[0]?.week ?? null, off, def, offPos, defPos };
  }
  const active = teams.filter((t) => team[t].n > 0);
  const N = active.length;

  // ---- team stat values + ranks ----------------------------------------
  const teamVals = {}; // statId -> { off: Map(team->val), def: ..., offRank, defRank }
  for (const s of sport.teamStats) {
    const off = active.map((t) => [t, s.fn(team[t].off, team[t].n)]);
    const def = active.map((t) => [t, s.fn(team[t].def, team[t].n)]);
    teamVals[s.id] = {
      off: new Map(off), def: new Map(def),
      offRank: rankMap(off, s.offenseHigh),
      defRank: rankMap(def, !s.offenseHigh),
      leagueAvg: avg(off.map(([, v]) => v)),
    };
  }

  // ---- position stat values + ranks (per game) --------------------------
  const posVals = {}; // pos -> statId -> {...}
  for (const p of positions) {
    posVals[p] = {};
    const ids = new Set([...sport.positions[p].stats.map((s) => s.id), sport.positions[p].key, ...posCols, 'scrim_yds', 'tds']);
    for (const id of ids) {
      const high = sport.positions[p].stats.find((s) => s.id === id)?.offenseHigh ?? true;
      const off = active.map((t) => [t, (team[t].offPos[p][id] || 0) / team[t].n]);
      const def = active.map((t) => [t, (team[t].defPos[p][id] || 0) / team[t].n]);
      posVals[p][id] = {
        off: new Map(off), def: new Map(def),
        offRank: rankMap(off, high),
        defRank: rankMap(def, !high),
        leagueAvg: avg(def.map(([, v]) => v)),
      };
    }
  }

  // ---- players -----------------------------------------------------------
  const playerInfo = new Map(data.players.map((p) => [p.id, p]));
  const pgames = new Map();
  for (const r of data.player_games) {
    if (r.week >= beforeWeek) continue;
    if (!pgames.has(r.id)) pgames.set(r.id, []);
    pgames.get(r.id).push(r);
  }
  const players = [];
  for (const [id, rows] of pgames) {
    const info = playerInfo.get(id);
    if (!info || !sport.positions[info.pos]) continue;
    rows.sort((a, b) => b.week - a.week);
    const curTeam = rows[0].team;
    const window = lastN > 0 ? rows.slice(0, lastN) : rows;
    const tot = {};
    for (const r of window) sum(tot, r, posCols);
    sport.derive(tot);
    const avgs = {};
    for (const k of Object.keys(tot)) avgs[k] = tot[k] / window.length;
    // "Active" = played in one of the current team's two most recent games.
    const recent = team[curTeam]?.games.slice(0, 2) ?? [];
    const isActive = recent.includes(rows[0].game_id);
    players.push({
      ...info, team: curTeam, n: window.length, avg: avgs, active: isActive,
      relevant: isActive && sport.positions[info.pos].relevant(avgs),
    });
  }

  // ---- public API ----------------------------------------------------------
  const model = {
    sport, data, teams: active, N, team, players, beforeWeek, lastN,

    teamStat(t, statId, side) {
      const v = teamVals[statId];
      return { value: v[side].get(t) ?? null, rank: v[side + 'Rank'].get(t) ?? null, leagueAvg: v.leagueAvg };
    },

    posStat(t, pos, statId, side) {
      const v = posVals[pos][statId];
      return { value: v[side].get(t) ?? null, rank: v[side + 'Rank'].get(t) ?? null, leagueAvg: v.leagueAvg };
    },

    // Edge in rank places: positive favors the offense.
    edge(offRank, defRank) {
      if (offRank == null || defRank == null) return null;
      return defRank - offRank;
    },

    // Player vs opponent: scale the player's averages by how much the opponent
    // allows to his position relative to league average.
    playerMatchup(pl, opp) {
      const pos = pl.pos;
      const cfg = sport.positions[pos];
      const fp = model.posStat(opp, pos, 'fpts', 'def');
      const key = model.posStat(opp, pos, cfg.key, 'def');
      const mult = (s) => (s.leagueAvg ? s.value / s.leagueAvg : null);
      return {
        opp,
        fptsAllowed: fp.value,
        fptsRank: fp.rank, // 1 = toughest, N = softest
        fptsMult: mult(fp),
        keyAllowed: key.value,
        keyRank: key.rank,
        keyMult: mult(key),
        projKey: pl.avg[cfg.key] != null && mult(key) != null ? pl.avg[cfg.key] * mult(key) : null,
        projFpts: pl.avg.fpts != null && mult(fp) != null ? pl.avg.fpts * mult(fp) : null,
        // Same orientation as team edges: softest defense => +(N-1)/2-ish.
        edge: fp.rank != null ? fp.rank - (N + 1) / 2 : null,
      };
    },
  };
  return model;
}

function avg(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// Map an edge to a background color. `scale` is the edge at full saturation.
export function edgeColor(edge, scale) {
  if (edge == null) return 'transparent';
  const t = Math.max(-1, Math.min(1, edge / scale));
  if (Math.abs(t) < 0.08) return 'transparent';
  const hue = t > 0 ? 'var(--good-rgb)' : 'var(--bad-rgb)';
  const alpha = (0.12 + 0.6 * Math.abs(t)).toFixed(2);
  return `rgba(${hue}, ${alpha})`;
}

// Color a lone rank where 1 = best.
export function rankColor(rank, N) {
  if (rank == null) return 'transparent';
  return edgeColor((N + 1) / 2 - rank, (N - 1) / 2);
}

export function ordinal(n) {
  if (n == null) return '–';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
