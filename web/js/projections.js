// Player stat projections.
//
// projection = baseline × recent form × Π(game factors), per stat.
// Each factor is a multiplier per stat; fantasy points are rebuilt from the
// projected stats. A factor's "impact" is how much projected fantasy points
// move when that one factor is removed, which drives the justification text.
//
// Factors: opponent vs position, recent form, home/away, divisional game,
// weather (outdoor only), Vegas implied team total, game script (spread),
// rest differential, the player's history against this opponent, and
// injuries (vacated targets/carries flow to teammates, QB changes, and a
// small haircut for players listed Questionable).

import { ordinal } from './engine.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const regress = (m, n, k) => 1 + (m - 1) * (n / (n + k));
const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)}%`;

export function buildProjector(sport, model, { history = [], weather = new Map(), disabled = new Set() } = {}) {
  const cfg = sport.projection;
  const data = model.data;
  const beforeWeek = model.beforeWeek;

  // ---- league-level home / divisional effects (all loaded seasons) --------
  const scheduleById = new Map();
  for (const d of [...history, data]) for (const g of d.schedule) scheduleById.set(g.game_id, g);
  const leagueRows = [
    ...history.flatMap((d) => d.team_games),
    ...data.team_games.filter((r) => r.week < beforeWeek),
  ];
  const metric = { pass: 'pass_yds', rush: 'rush_yds', td: 'pts' };
  const league = {};
  for (const [cat, col] of Object.entries(metric)) {
    const all = [], home = [], away = [], div = [];
    for (const r of leagueRows) {
      if (r[col] == null) continue;
      all.push(r[col]);
      (r.home ? home : away).push(r[col]);
      if (scheduleById.get(r.game_id)?.div_game) div.push(r[col]);
    }
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const base = mean(all);
    league[cat] = {
      home: base ? mean(home) / base : 1,
      away: base ? mean(away) / base : 1,
      div: base && div.length > 30 ? mean(div) / base : 1,
    };
  }

  // ---- per-player game logs ----------------------------------------------
  const logs = new Map(); // id -> rows (current season, before week), newest first
  for (const r of data.player_games) {
    if (r.week >= beforeWeek) continue;
    if (!logs.has(r.id)) logs.set(r.id, []);
    logs.get(r.id).push(r);
  }
  for (const rows of logs.values()) rows.sort((a, b) => b.week - a.week);
  const pastByPlayer = new Map(); // id -> all prior rows incl. previous seasons
  for (const d of history) for (const r of d.player_games) {
    if (!pastByPlayer.has(r.id)) pastByPlayer.set(r.id, []);
    pastByPlayer.get(r.id).push(r);
  }
  for (const [id, rows] of logs) pastByPlayer.set(id, [...(pastByPlayer.get(id) || []), ...rows]);

  const fptsOf = (stats, keys) => keys.reduce((s, k) => s + (cfg.scoring[k] || 0) * (stats[k] || 0), 0);

  // ---- expected TDs from usage ---------------------------------------------
  // League P(TD) per opportunity by field zone, pooled over loaded seasons.
  const rateSets = [...history, data].map((d) => d.td_rates).filter(Boolean);
  const R = rateSets.length
    ? {
        rush: Object.fromEntries(['gl', 'rz', 'out'].map((z) => [z, rateSets.reduce((s, r) => s + r.rush[z], 0) / rateSets.length])),
        rec: Object.fromEntries(['rz', 'out'].map((z) => [z, rateSets.reduce((s, r) => s + r.rec[z], 0) / rateSets.length])),
      }
    : null;
  const xRush = (a) => (R ? (a.car_gl || 0) * R.rush.gl + (a.car_rz || 0) * R.rush.rz + Math.max(0, (a.rush_att || 0) - (a.car_gl || 0) - (a.car_rz || 0)) * R.rush.out : null);
  const xRec = (a) => (R ? (a.tgt_rz || 0) * R.rec.rz + Math.max(0, (a.tgt || 0) - (a.tgt_rz || 0)) * R.rec.out : null);
  const rowsAvg = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0) / (rows.length || 1);

  // ---- baseline: recency-weighted sample + last season as a prior ---------
  // Game i back (0 = latest) weighs decay^i; last season's per-game average
  // counts as `priorGames` extra games. decay 1 / priorGames 0 = plain average.
  const B = cfg.baseline;
  const prevByPlayer = new Map();
  for (const d of history) for (const r of d.player_games) {
    if (!prevByPlayer.has(r.id)) prevByPlayer.set(r.id, []);
    prevByPlayer.get(r.id).push(r);
  }
  const playerPos = new Map([...history, data].flatMap((d) => d.players.map((p) => [p.id, p.pos])));

  // ---- yards per target vs depth of target -------------------------------
  // League fit (players with 20+ targets): yards/target ≈ a + b × aDOT.
  const E = cfg.efficiency;
  const yptFit = (() => {
    const agg = new Map();
    for (const r of [...history.flatMap((d) => d.player_games), ...data.player_games.filter((x) => x.week < beforeWeek)]) {
      if (!r.tgt) continue;
      const a = agg.get(r.id) ?? { tgt: 0, yds: 0, air: 0 };
      a.tgt += r.tgt; a.yds += r.rec_yds || 0; a.air += r.air || 0;
      agg.set(r.id, a);
    }
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const a of agg.values()) {
      if (a.tgt < 20) continue;
      const x = a.air / a.tgt, y = a.yds / a.tgt, w = a.tgt;
      sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
    }
    if (!sw) return null;
    const b = (sw * sxy - sx * sy) / (sw * sxx - sx * sx);
    return { a: (sy - b * sx) / sw, b };
  })();

  // League yards per carry by position (for rushing efficiency regression).
  const ypcLeague = (() => {
    const agg = {};
    for (const r of [...history.flatMap((d) => d.player_games), ...data.player_games.filter((x) => x.week < beforeWeek)]) {
      const pos = playerPos.get(r.id);
      if (!pos || !r.rush_att) continue;
      const a = (agg[pos] ??= { att: 0, yds: 0 });
      a.att += r.rush_att; a.yds += r.rush_yds || 0;
    }
    return Object.fromEntries(Object.entries(agg).map(([p, a]) => [p, a.yds / a.att]));
  })();

  function baselineAvg(pl) {
    const rows = (logs.get(pl.id) || []).slice(0, pl.n);
    const prev = prevByPlayer.get(pl.id) || [];
    if (B.decay === 1 && (!B.priorGames || prev.length < B.minPriorGames)) return pl.avg;
    const out = {};
    let wSum = 0;
    rows.forEach((r, i) => {
      const w = B.decay ** i;
      wSum += w;
      for (const k of sport.rawColumns) out[k] = (out[k] || 0) + w * (r[k] || 0);
    });
    if (B.priorGames && prev.length >= B.minPriorGames) {
      // Optionally rescale last season to this season's role: production per
      // snap then × snap share now (capped), so a promoted backup isn't held
      // to his old numbers.
      let scale = 1;
      if (B.priorPerSnap) {
        const nowSnap = rowsAvg(rows.filter((r) => r.snap != null), 'snap');
        const prevSnap = rowsAvg(prev.filter((r) => r.snap != null), 'snap');
        if (nowSnap > 5 && prevSnap > 5) scale = Math.max(0.5, Math.min(2, nowSnap / prevSnap));
      }
      for (const k of sport.rawColumns) out[k] = (out[k] || 0) + B.priorGames * scale * rowsAvg(prev, k);
      wSum += B.priorGames;
    }
    for (const k of sport.rawColumns) out[k] = wSum ? (out[k] || 0) / wSum : 0;
    return sport.derive(out);
  }

  // ---- injuries & vacated usage ------------------------------------------
  const I = cfg.injury;
  const report = new Map(); // player id -> injury report entry for this week
  for (const r of data.injuries || []) if (r.week === beforeWeek) report.set(r.id, r);
  const reportPublished = report.size > 0;
  const statusOf = (id) => report.get(id)?.status ?? null;
  const isOut = (p) => ['Out', 'Doubtful'].includes(statusOf(p.id));
  const byTeam = new Map();
  for (const p of model.players) {
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(p);
  }
  const sampleGames = (p) => (logs.get(p.id) || []).slice(0, p.n).map((r) => r.game_id);
  const playedFor = (p) => new Set((logs.get(p.id) || []).filter((r) => r.team === p.team).map((r) => r.game_id));
  const meaningful = (p) => (p.avg.tgt || 0) >= 2 || (p.avg.rush_att || 0) >= 4 || (p.pos === 'QB' && p.avg.pass_att >= 15);

  // ---- opponent secondary: starting DBs ruled out this week ---------------
  const normName = (n) => String(n).toLowerCase().replace(/[.'’-]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/, '').trim();
  const dbOut = new Map(); // team -> [names of starting DBs out]
  {
    const snaps = new Map(); // team|name -> [pct by week desc]
    for (const [week, team, name, pct] of data.db_snaps || []) {
      if (week >= beforeWeek) continue;
      const k = `${team}|${normName(name)}`;
      if (!snaps.has(k)) snaps.set(k, []);
      snaps.get(k).push([week, pct]);
    }
    for (const r of data.injuries || []) {
      if (r.week !== beforeWeek || r.pos !== 'DB' || !['Out', 'Doubtful'].includes(r.status)) continue;
      const hist = (snaps.get(`${r.team}|${normName(r.name)}`) || []).sort((a, b) => b[0] - a[0]).slice(0, 3);
      if (!hist.length) continue;
      const avg = hist.reduce((s, x) => s + x[1], 0) / hist.length;
      if (avg >= cfg.secondary.starterPct) {
        if (!dbOut.has(r.team)) dbOut.set(r.team, []);
        dbOut.get(r.team).push(r.name);
      }
    }
  }

  // ---- defenses: plays faced and pass rate faced (pace / pass funnel) ------
  const defFaced = new Map(); // defense -> { plays, npass, nplays, games }
  let lgPlays = 0, lgNpass = 0, lgNplays = 0, lgGames = 0;
  for (const r of data.team_games) {
    if (r.week >= beforeWeek || !r.plays) continue;
    const d = defFaced.get(r.opp) ?? { plays: 0, npass: 0, nplays: 0, games: 0 };
    d.plays += r.plays; d.npass += r.npass || 0; d.nplays += r.nplays || 0; d.games++;
    defFaced.set(r.opp, d);
    lgPlays += r.plays; lgNpass += r.npass || 0; lgNplays += r.nplays || 0; lgGames++;
  }

  const contexts = new Map();
  function teamContext(team) {
    if (contexts.has(team)) return contexts.get(team);
    const roster = byTeam.get(team) || [];
    // Missing = real role and ruled Out/Doubtful on this week's report. Players
    // absent for weeks (IR) aren't added: backtests showed their absence is
    // already reflected in teammates' recent numbers.
    const missing = roster.filter((p) => meaningful(p) && isOut(p));
    const available = roster.filter((p) => p.active && !isOut(p));
    const starter = roster.find((p) => p.pos === 'QB' && p.relevant);
    const qbOut = starter && isOut(starter) ? starter : null;
    const newQb = qbOut
      ? available.filter((p) => p.pos === 'QB').sort((a, b) => b.avg.pass_att * b.n - a.avg.pass_att * a.n)[0] ?? null
      : null;

    // Redistribute each missing player's targets (to all pass catchers) and
    // carries (to RBs), weighted toward the same position. Only the share of a
    // teammate's sample in which the missing player actually played counts —
    // games he already missed are baked into the teammate's average.
    const extra = new Map();
    for (const m of missing) {
      if (m.pos === 'QB') continue;
      const mPlayed = playedFor(m);
      for (const [stat, eligible, min] of [['tgt', () => true, 1], ['rush_att', (p) => p.pos === 'RB', 2]]) {
        const vol = m.avg[stat] || 0;
        if (vol < min) continue;
        const pool = available.filter((p) => p.pos !== 'QB' && eligible(p) && (p.avg[stat] || 0) > 0);
        const w = (p) => p.avg[stat] * (p.pos === m.pos ? I.samePosWeight : 1);
        const total = pool.reduce((s, p) => s + w(p), 0);
        if (!total) continue;
        for (const p of pool) {
          const sg = sampleGames(p);
          const overlap = sg.length ? sg.filter((id) => mPlayed.has(id)).length / sg.length : 0;
          const add = vol * I.absorb * (w(p) / total) * overlap;
          if (add < 0.05) continue;
          const e = extra.get(p.id) ?? { tgt: 0, rush_att: 0, from: new Set() };
          e[stat] += add;
          e.from.add(m.name);
          extra.set(p.id, e);
        }
      }
    }
    const ctx = { missing, qbOut, newQb, extra, available };
    contexts.set(team, ctx);
    return ctx;
  }

  // ---- weather for a game ------------------------------------------------
  function gameWeather(g) {
    const st = sport.stadiums[g.stadium_id];
    if (st?.indoor || (!st && ['dome', 'closed'].includes(g.roof))) return { indoor: true };
    if (g.home_score != null) return g.temp != null ? { temp: g.temp, wind: g.wind ?? 0, source: 'recorded' } : { unrecorded: true };
    return weather.get(g.game_id) ?? { unknown: true };
  }

  function weatherFactor(w) {
    const W = cfg.weather;
    if (!w || w.indoor || w.unknown || w.unrecorded || w.error) return null;
    let pass = 1, rush = 1;
    const notes = [];
    if (w.wind > W.windFrom) {
      pass *= 1 + W.passPerMph * (w.wind - W.windFrom);
      rush *= 1 + W.rushPerMph * (w.wind - W.windFrom);
      notes.push(`wind ${Math.round(w.wind)} mph`);
    }
    if (w.temp != null && w.temp < W.coldBelow) {
      pass *= 1 + W.passPerDegree * (W.coldBelow - w.temp);
      notes.push(`${Math.round(w.temp)}°F`);
    }
    if (w.snow >= 0.1) {
      pass *= 1 + W.snow.pass; rush *= 1 + W.snow.rush;
      notes.push('snow');
    } else if (w.precip >= 0.05 || w.prob >= 60) {
      pass *= 1 + W.rain.pass; rush *= 1 + W.rain.rush;
      notes.push(`rain ${w.prob != null ? `${Math.round(w.prob)}%` : ''}`.trim());
    }
    if (!notes.length) return null;
    return { pass: Math.max(W.passFloor, pass), rush: Math.min(W.rushCap, rush), notes };
  }

  // ---- project one player in one game --------------------------------------
  function project(pl, g) {
    const pos = pl.pos;
    const keys = cfg.stats[pos];
    const isHome = g.home === pl.team;
    const opp = isHome ? g.away : g.home;
    const avg = baselineAvg(pl);
    const base = Object.fromEntries(keys.map((k) => [k, avg[k] || 0]));
    // TD base: blend usage-based expected TDs with TDs actually scored.
    const TD = cfg.td;
    const xr = xRush(avg), xc = xRec(avg);
    if (R && avg.car_gl != null) {
      if ('rush_td' in base) base.rush_td = TD.xWeight * xr + (1 - TD.xWeight) * base.rush_td;
      if ('rec_td' in base) base.rec_td = TD.xWeight * xc + (1 - TD.xWeight) * base.rec_td;
    }
    const cat = (k) => (cfg.tdStats.includes(k) ? 'td' : cfg.category[k]);
    const factors = [];

    // 1. Opponent vs position (per stat, regressed by sample size).
    {
      const n = model.team[opp]?.n ?? 0;
      const mult = {};
      for (const k of keys) {
        const s = model.posStat(opp, pos, k, 'def');
        const raw = s.leagueAvg > 0.05 ? s.value / s.leagueAvg : 1;
        mult[k] = regress(raw, n, cfg.tdStats.includes(k) ? cfg.regress.opponentTd : cfg.regress.opponent);
      }
      const fp = model.posStat(opp, pos, 'fpts', 'def');
      const most = model.N - fp.rank + 1; // 1 = allows the most
      const text = most <= model.N / 2
        ? `${opp} allows the ${most === 1 ? '' : ordinal(most) + '-'}most FPTS to ${pos}s (${fp.value.toFixed(1)}/G)`
        : `${opp} allows the ${fp.rank === 1 ? '' : ordinal(fp.rank) + '-'}fewest FPTS to ${pos}s (${fp.value.toFixed(1)}/G)`;
      factors.push({ id: 'opp', label: 'Opponent', text, m: (k) => mult[k] });
    }

    // 2. Recent form: last N games vs the sample average.
    {
      const F = cfg.recentForm;
      const rows = logs.get(pl.id) || [];
      if (rows.length > F.games) {
        const recent = rows.slice(0, F.games);
        const ravg = (k) => recent.reduce((s, r) => s + (r[k] || 0), 0) / recent.length;
        const mult = {};
        // TDs are too noisy for this; the red-zone trend factor covers them.
        for (const k of keys) mult[k] = base[k] > 0 && !['rush_td', 'rec_td'].includes(k) ? clamp(1 + F.weight * (ravg(k) / base[k] - 1), 1 - F.cap, 1 + F.cap) : 1;
        const rf = fptsOf(Object.fromEntries(keys.map((k) => [k, ravg(k)])), keys);
        factors.push({ id: 'form', label: 'Recent form', text: `Last ${F.games}: ${rf.toFixed(1)} FPTS/G vs ${fptsOf(base, keys).toFixed(1)} avg`, m: (k) => mult[k] });
      }
    }

    // 2b. Red-zone trend: recent expected TDs (usage) vs the sample.
    if (R) {
      const rows = logs.get(pl.id) || [];
      if (rows.length > TD.trendGames && xr + xc > 0.02) {
        const recent = rows.slice(0, TD.trendGames);
        const rr = xRush({ car_gl: rowsAvg(recent, 'car_gl'), car_rz: rowsAvg(recent, 'car_rz'), rush_att: rowsAvg(recent, 'rush_att') });
        const rc = xRec({ tgt_rz: rowsAvg(recent, 'tgt_rz'), tgt: rowsAvg(recent, 'tgt') });
        const mR = xr > 0.01 ? clamp(1 + TD.trendWeight * (rr / xr - 1), 1 - TD.trendCap, 1 + TD.trendCap) : 1;
        const mC = xc > 0.01 ? clamp(1 + TD.trendWeight * (rc / xc - 1), 1 - TD.trendCap, 1 + TD.trendCap) : 1;
        const opp = (rws) => rowsAvg(rws, 'car_gl') + rowsAvg(rws, 'car_rz') + rowsAvg(rws, 'tgt_rz');
        const sample = rows.slice(0, pl.n);
        factors.push({
          id: 'rz', label: 'Red-zone trend',
          text: `Red-zone looks last ${TD.trendGames}: ${opp(recent).toFixed(1)}/G vs ${opp(sample).toFixed(1)} avg`,
          m: (k) => (k === 'rush_td' ? mR : k === 'rec_td' ? mC : 1),
        });
      }
    }

    // 2b2. Yards per target regressed toward what his depth of target supports.
    if (E.weight && yptFit && base.tgt > 0.5 && 'rec_yds' in base) {
      const rows = [...(logs.get(pl.id) || []).slice(0, pl.n), ...(prevByPlayer.get(pl.id) || [])];
      const tgt = rows.reduce((s, r) => s + (r.tgt || 0), 0);
      const air = rows.reduce((s, r) => s + (r.air || 0), 0);
      const yds = rows.reduce((s, r) => s + (r.rec_yds || 0), 0);
      if (tgt >= 5) {
        const exp = yptFit.a + yptFit.b * (air / tgt);
        const obs = yds / tgt;
        const reg = (tgt * obs + E.k * exp) / (tgt + E.k);
        const now = base.rec_yds / base.tgt;
        const m = clamp(1 + E.weight * (reg / now - 1), 0.75, 1.25);
        factors.push({
          id: 'ypt', label: 'Efficiency',
          text: `${obs.toFixed(1)} yds/target vs ${exp.toFixed(1)} expected from ${(air / tgt).toFixed(1)}-yd depth`,
          m: (k) => (k === 'rec_yds' ? m : 1),
        });
      }
    }

    // 2b2b. Yards per carry regressed toward the league rate for his position.
    if (E.rushWeight && base.rush_att > 2 && 'rush_yds' in base && ypcLeague[pl.pos]) {
      const rows = [...(logs.get(pl.id) || []).slice(0, pl.n), ...(prevByPlayer.get(pl.id) || [])];
      const att = rows.reduce((s, r) => s + (r.rush_att || 0), 0);
      const yds = rows.reduce((s, r) => s + (r.rush_yds || 0), 0);
      if (att >= 10) {
        const reg = (yds + E.rushK * ypcLeague[pl.pos]) / (att + E.rushK);
        const now = base.rush_yds / base.rush_att;
        const m = clamp(1 + E.rushWeight * (reg / now - 1), 0.8, 1.2);
        factors.push({
          id: 'ypc', label: 'Rush efficiency',
          text: `${(yds / att).toFixed(1)} yds/carry vs ${ypcLeague[pl.pos].toFixed(1)} league (${pl.pos})`,
          m: (k) => (k === 'rush_yds' ? m : 1),
        });
      }
    }

    // 2b3. Opponent's starting cornerbacks/safeties out.
    {
      const out = dbOut.get(opp) || [];
      const D = cfg.secondary;
      if (D.perStarter && out.length && pl.pos !== 'RB' && (!D.qbOnly || pl.pos === 'QB')) {
        const m = 1 + D.perStarter * Math.min(out.length, D.max);
        factors.push({
          id: 'secondary', label: 'Secondary out',
          text: `${opp} without starting DB${out.length > 1 ? 's' : ''} ${out.join(', ')}`,
          m: (k) => (['tgt', 'rec', 'rec_yds', 'rec_td', 'pass_yds', 'pass_td'].includes(k) ? m : k === 'int' ? 1 / m : 1),
        });
      }
    }

    // 2b4. Opponent pace (plays faced) and pass funnel (neutral pass rate faced).
    {
      const P = cfg.pace;
      const d = defFaced.get(opp);
      if ((P.volume || P.tilt) && d?.games && lgGames) {
        const shrink = d.games / (d.games + P.k);
        const vol = 1 + P.volume * shrink * ((d.plays / d.games) / (lgPlays / lgGames) - 1);
        const prFaced = d.nplays ? d.npass / d.nplays : null;
        const prLg = lgNplays ? lgNpass / lgNplays : null;
        const tilt = prFaced && prLg ? P.tilt * shrink * (prFaced / prLg - 1) : 0;
        const passM = vol * (1 + tilt), rushM = (P.passOnly ? 1 : vol) * (1 - tilt);
        if (Math.abs(passM - 1) > 0.005 || Math.abs(rushM - 1) > 0.005) {
          factors.push({
            id: 'pace', label: 'Pace / funnel',
            text: `${opp} faces ${(d.plays / d.games).toFixed(0)} plays/G (lg ${(lgPlays / lgGames).toFixed(0)}), ${prFaced ? (prFaced * 100).toFixed(0) : '–'}% passes in close games (lg ${prLg ? (prLg * 100).toFixed(0) : '–'}%)`,
            m: (k) => (cat(k) === 'pass' ? passM : cat(k) === 'rush' || k === 'rush_td' ? rushM : 1),
          });
        }
      }
    }

    // 2c. Snap-share trend: playing time over the last games vs his sample
    // (role changes show up in snaps before they show up in stats).
    {
      const S = cfg.snaps;
      const rows = (logs.get(pl.id) || []).filter((r) => r.snap != null);
      if (S.weight && pl.pos !== 'QB' && rows.length > S.games) {
        const recent = rowsAvg(rows.slice(0, S.games), 'snap');
        const all = rowsAvg(rows.slice(0, pl.n), 'snap');
        if (all > 5) {
          const m = clamp(1 + S.weight * (recent / all - 1), 1 - S.cap, 1 + S.cap);
          factors.push({
            id: 'snaps', label: 'Snap trend',
            text: `Snaps last ${S.games}: ${recent.toFixed(0)}% vs ${all.toFixed(0)}% avg`,
            m: (k) => (k === 'pass_att' || k === 'pass_yds' || k === 'pass_td' || k === 'int' ? 1 : m),
          });
        }
      }
    }

    // 3. Home / away.
    {
      const side = isHome ? 'home' : 'away';
      const neutral = g.location === 'Neutral';
      // Home field is already priced into the Vegas line, so it only moves the
      // projection when there is no line (backtests confirmed the overlap).
      const priced = g.spread_line != null && g.total_line != null;
      if (!neutral) {
        factors.push({
          id: 'home', label: isHome ? 'Home' : 'Road',
          text: `${isHome ? 'Home' : 'Road'} game${priced ? ' (priced into Vegas line)' : ''}`,
          m: (k) => (priced || cat(k) === 'none' ? 1 : league[cat(k)][side]),
        });
      }
    }

    // 4. Divisional game.
    if (g.div_game) {
      factors.push({ id: 'div', label: 'Divisional', text: `Divisional game (league: ${pct(league.td.div - 1)} scoring)`, m: (k) => (cat(k) === 'none' ? 1 : league[cat(k)].div) });
    }

    // 5. Weather.
    const w = gameWeather(g);
    const wf = weatherFactor(w);
    if (wf) {
      factors.push({
        id: 'weather', label: 'Weather', text: `${w.source === 'forecast' ? 'Forecast' : 'Weather'}: ${wf.notes.join(', ')}`,
        m: (k) => (cat(k) === 'rush' || k === 'rush_td' ? wf.rush : cat(k) === 'none' ? 1 : wf.pass),
      });
    }

    // 6 + 7. Vegas: implied team total and game script from the spread.
    const tm = model.team[pl.team];
    if (g.spread_line != null && g.total_line != null && tm?.n) {
      const spread = isHome ? g.spread_line : -g.spread_line; // + = this team favored
      const implied = (g.total_line + spread) / 2;
      const avgPts = tm.off.pts / tm.n;
      const V = cfg.vegas;
      const r = clamp(implied / avgPts - 1, -V.cap, V.cap);
      factors.push({
        id: 'vegas', label: 'Vegas total', text: `Implied team total ${implied.toFixed(1)} vs ${avgPts.toFixed(1)} pts/G`,
        m: (k) => (cat(k) === 'none' ? 1 : 1 + r * (cfg.tdStats.includes(k) ? V.tdWeight : V.yardsWeight)),
      });
      const S = cfg.gameScript;
      const rush = clamp(1 + S.rushPerPoint * spread, 1 - S.cap, 1 + S.cap);
      const pass = clamp(1 + S.passPerPoint * spread, 1 - S.cap, 1 + S.cap);
      if (Math.abs(spread) >= 3) {
        factors.push({
          id: 'script', label: 'Game script',
          text: spread > 0 ? `Favored by ${spread} → more rushing late` : `${-spread}-pt underdog → more passing late`,
          m: (k) => (cat(k) === 'rush' || k === 'rush_td' ? rush : cat(k) === 'none' ? 1 : pass),
        });
      }
    }

    // 8. Rest differential.
    {
      const mine = isHome ? g.home_rest : g.away_rest;
      const theirs = isHome ? g.away_rest : g.home_rest;
      if (mine != null && theirs != null && mine !== theirs) {
        const R = cfg.rest;
        const diff = clamp(mine - theirs, -R.maxDays, R.maxDays);
        factors.push({ id: 'rest', label: 'Rest', text: `${mine} days rest vs ${theirs} for ${opp}${mine >= 12 ? ' (off bye)' : mine <= 5 ? ' (short week)' : ''}`, m: (k) => (cat(k) === 'none' ? 1 : 1 + R.perDay * diff) });
      }
    }

    // 9. Player history vs this opponent (any loaded season).
    {
      const prior = (pastByPlayer.get(pl.id) || []).filter((r) => r.opp === opp && r.game_id !== g.game_id);
      const baseF = fptsOf(base, keys);
      if (prior.length && baseF > 0) {
        const vs = prior.reduce((s, r) => s + fptsOf(r, keys), 0) / prior.length;
        const H = cfg.history;
        const m = clamp(regress(vs / baseF, prior.length, cfg.regress.history), 1 - H.cap, 1 + H.cap);
        // Shown for context; only weighted in when history.apply is on (with
        // three seasons loaded, backtests found it hurt every stat).
        factors.push({
          id: 'hist', label: `vs ${opp}`,
          text: `${prior.length} prior game${prior.length > 1 ? 's' : ''} vs ${opp}: ${vs.toFixed(1)} FPTS/G${H.apply ? '' : ' (context only)'}`,
          m: () => (H.apply ? m : 1),
        });
      }
    }

    // 10. Injuries: vacated usage, QB change, own questionable tag.
    {
      const ctx = teamContext(pl.team);
      const e = ctx.extra.get(pl.id);
      if (e) {
        const rec = base.tgt ? Math.min(I.cap, (base.tgt + e.tgt) / base.tgt) : 1;
        const rush = base.rush_att ? Math.min(I.cap, (base.rush_att + e.rush_att) / base.rush_att) : 1;
        const bits = [e.tgt >= 0.1 && `+${e.tgt.toFixed(1)} tgt`, e.rush_att >= 0.1 && `+${e.rush_att.toFixed(1)} car`].filter(Boolean);
        factors.push({
          id: 'usage', label: 'Teammates out',
          text: `${[...e.from].join(', ')} out → ${bits.join(', ')}/G`,
          m: (k) => (['tgt', 'rec', 'rec_yds', 'rec_td'].includes(k) ? rec : ['rush_att', 'rush_yds', 'rush_td'].includes(k) ? rush : 1),
        });
      }
      if (ctx.qbOut && pl.pos !== 'QB') {
        factors.push({
          id: 'qb', label: 'QB change',
          text: `${ctx.qbOut.name} out → ${ctx.newQb?.name ?? 'backup'} at QB`,
          m: (k) => (['pass_yds', 'pass_td', 'rec_yds', 'rec_td', 'rec'].includes(k) ? I.backupQb : 1),
        });
      }
      if (ctx.newQb?.id === pl.id) {
        factors.push({ id: 'qb', label: 'QB change', text: `Projected starter (${ctx.qbOut.name} out)`, m: () => 1 });
      }
      const st = report.get(pl.id);
      if (st?.status === 'Questionable') {
        factors.push({ id: 'status', label: 'Questionable', text: `Questionable${st.injury ? ` (${st.injury})` : ''}`, m: (k) => (cat(k) === 'none' ? 1 : I.questionable) });
      }
    }

    // ---- combine ----------------------------------------------------------
    for (let i = factors.length - 1; i >= 0; i--) if (disabled.has(factors[i].id)) factors.splice(i, 1);
    const [lo, hi] = cfg.totalClamp;
    const combine = (skip) => {
      const out = {};
      for (const k of keys) {
        let m = 1;
        for (const f of factors) if (f !== skip) m *= f.m(k);
        out[k] = base[k] * clamp(m, lo, hi);
      }
      return out;
    };
    const proj = combine(null);
    const baseF = fptsOf(base, keys);
    const projF = fptsOf(proj, keys);
    const tdOf = (st) => (st.rush_td || 0) + (st.rec_td || 0);
    const projTd = tdOf(proj);
    for (const f of factors) {
      const w = combine(f);
      const without = fptsOf(w, keys);
      f.impact = without > 0 ? projF / without - 1 : 0;
      f.tdImpact = tdOf(w) > 0 ? projTd / tdOf(w) - 1 : 0;
    }
    factors.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
    // Scrimmage yards (rushing + receiving), a prop market of its own.
    if ('rush_yds' in proj || 'rec_yds' in proj) {
      proj.scrim_yds = (proj.rush_yds || 0) + (proj.rec_yds || 0);
      base.scrim_yds = (base.rush_yds || 0) + (base.rec_yds || 0);
    }

    return {
      opp, isHome, game: g, weather: w,
      base, proj, keys,
      baseFpts: baseF, projFpts: projF,
      delta: baseF > 0 ? projF / baseF - 1 : 0,
      factors,
      // Touchdowns: expected rush+rec TDs (λ), P(anytime) assuming Poisson.
      td: {
        lambda: projTd,
        baseLambda: tdOf(base),
        // Calibrated against backtests: raw Poisson is too extreme at both ends.
        anytime: 1 - Math.exp(-(TD.calib.floor + TD.calib.scale * projTd)),
        xRush: xr, xRec: xc,
        actual: (pl.avg.rush_td || 0) + (pl.avg.rec_td || 0),
        rzLooks: (pl.avg.car_gl || 0) + (pl.avg.car_rz || 0) + (pl.avg.tgt_rz || 0),
        glCarries: pl.avg.car_gl || 0,
        passLambda: proj.pass_td != null ? TD.passCalib.mean + TD.passCalib.scale * (proj.pass_td - TD.passCalib.mean) : null,
      },
    };
  }

  return { project, league, gameWeather, teamContext, isOut, statusOf, report, reportPublished };
}

// Fetch kickoff-window forecasts for outdoor games from Open-Meteo (free, no key,
// CORS-enabled). Forecasts exist ~16 days out; later games stay "unknown".
export async function fetchForecasts(sport, games, into) {
  const today = new Date();
  const horizon = new Date(today.getTime() + 15 * 864e5).toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);
  const jobs = games
    .filter((g) => g.home_score == null && !into.has(g.game_id))
    .filter((g) => g.gameday && g.gameday >= todayStr && g.gameday <= horizon)
    .map(async (g) => {
      const st = sport.stadiums[g.stadium_id];
      if (!st || st.indoor) return;
      const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
        latitude: st.lat, longitude: st.lon,
        hourly: 'temperature_2m,wind_speed_10m,precipitation,precipitation_probability,snowfall',
        temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch',
        timezone: sport.scheduleTimezone, start_date: g.gameday, end_date: g.gameday,
      });
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        const h = (await res.json()).hourly;
        const hour = (g.gametime || '13:00').slice(0, 2);
        let i = h.time.indexOf(`${g.gameday}T${hour}:00`);
        if (i < 0) i = 13;
        const span = [i, i + 1, i + 2, i + 3].filter((j) => j < h.time.length);
        const mean = (arr) => span.reduce((s, j) => s + (arr[j] ?? 0), 0) / span.length;
        const total = (arr) => span.reduce((s, j) => s + (arr[j] ?? 0), 0);
        into.set(g.game_id, {
          temp: mean(h.temperature_2m),
          wind: mean(h.wind_speed_10m),
          precip: total(h.precipitation),
          prob: Math.max(...span.map((j) => h.precipitation_probability[j] ?? 0)),
          snow: total(h.snowfall),
          source: 'forecast',
        });
      } catch (err) {
        into.set(g.game_id, { error: String(err) });
      }
    });
  await Promise.all(jobs);
}

export function weatherLabel(w) {
  if (!w) return '';
  if (w.indoor) return 'Indoors';
  if (w.unrecorded) return 'Weather not recorded';
  if (w.unknown) return 'Forecast not available yet';
  if (w.error) return 'Forecast unavailable';
  const parts = [`${Math.round(w.temp)}°F`, `wind ${Math.round(w.wind)} mph`];
  if (w.snow >= 0.1) parts.push(`snow ${w.snow.toFixed(1)}"`);
  else if (w.prob != null) parts.push(`precip ${Math.round(w.prob)}%`);
  return parts.join(' · ');
}
