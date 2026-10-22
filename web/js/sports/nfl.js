// NFL sport definition. To add another sport, copy this file, point `dataPath`
// at that sport's pipeline output, and redefine the stats/positions below.
//
// Every stat is a function of an aggregate `a` (summed raw columns over the
// games in the window) and `n` (number of games). `offenseHigh` says whether a
// higher value favors the offense — that drives every rank and edge color.

const perGame = (key) => (a, n) => (n ? a[key] / n : null);
const ratio = (num, den) => (a) => (a[den] ? a[num] / a[den] : null);

export default {
  id: 'nfl',
  name: 'NFL',
  dataPath: 'data/nfl',

  // Team-level matchup stats: team offense vs opponent defense (allowed).
  teamStats: [
    { id: 'pts', label: 'Points / G', fn: perGame('pts'), offenseHigh: true, fmt: 1 },
    { id: 'yds', label: 'Total Yds / G', fn: (a, n) => (n ? (a.pass_yds + a.rush_yds) / n : null), offenseHigh: true, fmt: 1 },
    { id: 'pass_yds', label: 'Pass Yds / G', fn: perGame('pass_yds'), offenseHigh: true, fmt: 1 },
    { id: 'ypa', label: 'Yds / Pass Att', fn: ratio('pass_yds', 'pass_att'), offenseHigh: true, fmt: 2 },
    { id: 'cmp_pct', label: 'Completion %', fn: (a) => (a.pass_att ? (100 * a.cmp) / a.pass_att : null), offenseHigh: true, fmt: 1 },
    { id: 'pass_td', label: 'Pass TD / G', fn: perGame('pass_td'), offenseHigh: true, fmt: 2 },
    { id: 'rush_yds', label: 'Rush Yds / G', fn: perGame('rush_yds'), offenseHigh: true, fmt: 1 },
    { id: 'ypc', label: 'Yds / Carry', fn: ratio('rush_yds', 'rush_att'), offenseHigh: true, fmt: 2 },
    { id: 'rush_td', label: 'Rush TD / G', fn: perGame('rush_td'), offenseHigh: true, fmt: 2 },
    { id: 'first_downs', label: 'First Downs / G', fn: perGame('first_downs'), offenseHigh: true, fmt: 1 },
    { id: 'sacks', label: 'Sacks / G', fn: perGame('sacks'), offenseHigh: false, fmt: 2, note: 'Offense: sacks taken. Defense: sacks made.' },
    { id: 'to', label: 'Turnovers / G', fn: (a, n) => (n ? (a.int + a.fum_lost) / n : null), offenseHigh: false, fmt: 2, note: 'Offense: giveaways. Defense: takeaways.' },
  ],

  // Positions for Defense-vs-Position and player matchups. `key` is the stat
  // used to project a player; `stats` are shown in the DvP table.
  positions: {
    QB: {
      label: 'QB',
      key: 'pass_yds',
      stats: [
        { id: 'fpts', label: 'Fantasy Pts (PPR)', fmt: 1 },
        { id: 'pass_yds', label: 'Pass Yds', fmt: 1 },
        { id: 'pass_td', label: 'Pass TD', fmt: 2 },
        { id: 'int', label: 'INT', fmt: 2, offenseHigh: false },
        { id: 'rush_yds', label: 'Rush Yds', fmt: 1 },
      ],
      // Which players count as "in the matchup": per-game usage threshold.
      relevant: (p) => p.pass_att >= 15,
    },
    RB: {
      label: 'RB',
      key: 'scrim_yds',
      stats: [
        { id: 'fpts', label: 'Fantasy Pts (PPR)', fmt: 1 },
        { id: 'rush_yds', label: 'Rush Yds', fmt: 1 },
        { id: 'rec', label: 'Receptions', fmt: 1 },
        { id: 'rec_yds', label: 'Rec Yds', fmt: 1 },
        { id: 'scrim_yds', label: 'Scrimmage Yds', fmt: 1 },
        { id: 'tds', label: 'TDs', fmt: 2 },
      ],
      relevant: (p) => p.rush_att + p.tgt >= 6,
    },
    WR: {
      label: 'WR',
      key: 'rec_yds',
      stats: [
        { id: 'fpts', label: 'Fantasy Pts (PPR)', fmt: 1 },
        { id: 'tgt', label: 'Targets', fmt: 1 },
        { id: 'rec', label: 'Receptions', fmt: 1 },
        { id: 'rec_yds', label: 'Rec Yds', fmt: 1 },
        { id: 'rec_td', label: 'Rec TD', fmt: 2 },
      ],
      relevant: (p) => p.tgt >= 3,
    },
    TE: {
      label: 'TE',
      key: 'rec_yds',
      stats: [
        { id: 'fpts', label: 'Fantasy Pts (PPR)', fmt: 1 },
        { id: 'tgt', label: 'Targets', fmt: 1 },
        { id: 'rec', label: 'Receptions', fmt: 1 },
        { id: 'rec_yds', label: 'Rec Yds', fmt: 1 },
        { id: 'rec_td', label: 'Rec TD', fmt: 2 },
      ],
      relevant: (p) => p.tgt >= 2.5,
    },
  },

  // Derived per-row columns added to position and player aggregates.
  derive(a) {
    a.scrim_yds = (a.rush_yds || 0) + (a.rec_yds || 0);
    a.tds = (a.pass_td || 0) + (a.rush_td || 0) + (a.rec_td || 0);
    return a;
  },

  // Player table columns (per game averages) by position.
  playerStats: {
    QB: [['pass_att', 'Att'], ['pass_yds', 'Pass Yds'], ['pass_td', 'Pass TD'], ['rush_yds', 'Rush Yds']],
    RB: [['rush_att', 'Car'], ['rush_yds', 'Rush Yds'], ['tgt', 'Tgt'], ['rec_yds', 'Rec Yds']],
    WR: [['tgt', 'Tgt'], ['rec', 'Rec'], ['rec_yds', 'Rec Yds'], ['rec_td', 'Rec TD']],
    TE: [['tgt', 'Tgt'], ['rec', 'Rec'], ['rec_yds', 'Rec Yds'], ['rec_td', 'Rec TD']],
  },

  // ---- projections ---------------------------------------------------------
  projection: {
    // Stats projected per position (fantasy points are rebuilt from these).
    stats: {
      QB: ['pass_att', 'pass_yds', 'pass_td', 'int', 'rush_yds', 'rush_td'],
      RB: ['rush_att', 'rush_yds', 'rush_td', 'tgt', 'rec', 'rec_yds', 'rec_td'],
      WR: ['tgt', 'rec', 'rec_yds', 'rec_td'],
      TE: ['tgt', 'rec', 'rec_yds', 'rec_td'],
    },
    labels: {
      pass_att: 'Att', pass_yds: 'Pass Yds', pass_td: 'Pass TD', int: 'INT', rush_att: 'Car',
      rush_yds: 'Rush Yds', rush_td: 'Rush TD', tgt: 'Tgt', rec: 'Rec', rec_yds: 'Rec Yds', rec_td: 'Rec TD',
      scrim_yds: 'Rush+Rec Yds',
    },
    // Which game-level effects a stat responds to.
    category: {
      pass_att: 'pass', pass_yds: 'pass', pass_td: 'pass', int: 'none', tgt: 'pass', rec: 'pass', rec_yds: 'pass', rec_td: 'pass',
      rush_att: 'rush', rush_yds: 'rush', rush_td: 'rush',
    },
    tdStats: ['pass_td', 'rush_td', 'rec_td'],
    // PPR scoring used for projected fantasy points.
    scoring: { pass_yds: 0.04, pass_td: 4, int: -2, rush_yds: 0.1, rush_td: 6, rec: 1, rec_yds: 0.1, rec_td: 6 },
    // Regression: a factor observed over n games is trusted n / (n + k).
    // Weights below were tuned by backtesting 2025 wks 4-18 + 2026 (see README).
    regress: { opponent: 30, opponentTd: 60, history: 8 },
    recentForm: { games: 3, weight: 0.15, cap: 0.15 },
    history: { cap: 0.12, apply: false },
    vegas: { yardsWeight: 0.5, tdWeight: 0.8, cap: 0.1 },
    gameScript: { rushPerPoint: 0.008, passPerPoint: -0.004, cap: 0.08 },
    rest: { perDay: 0.004, maxDays: 7 },
    // Weather effects (outdoor stadiums only). Wind in mph, temp in °F.
    weather: {
      windFrom: 10, passPerMph: -0.008, rushPerMph: 0.003,
      coldBelow: 35, passPerDegree: -0.003,
      rain: { pass: -0.05, rush: 0.02 }, snow: { pass: -0.08, rush: 0 },
      passFloor: 0.8, rushCap: 1.06,
    },
    // Injuries: share of a missing player's targets/carries that teammates in
    // the projection absorb (the rest goes to depth players), extra weight for
    // the same position, backup-QB hit on pass catchers, Questionable haircut.
    injury: { absorb: 0.7, samePosWeight: 1.5, backupQb: 0.9, questionable: 0.95, cap: 1.6 },
    // Baseline: recency decay per game back, and last season's per-game
    // average counted as `priorGames` games (when he played minPriorGames+).
    baseline: { decay: 1, priorGames: 3, minPriorGames: 4, priorPerSnap: false },
    // Yards per target regressed toward the league fit on depth of target
    // (k = pseudo-targets at the expected rate).
    efficiency: { weight: 0.5, k: 60, rushWeight: 0, rushK: 100 },
    // Opponent's starting DBs (avg ≥ starterPct of snaps, last 3 games) ruled
    // Out/Doubtful: passing-game boost per starter, up to `max`.
    secondary: { perStarter: 0.04, max: 2, starterPct: 70, qbOnly: true },
    // Opponent pace / pass funnel: volume weight on plays faced vs league,
    // tilt weight on neutral pass rate faced; regressed by games (k).
    pace: { volume: 0.5, tilt: 0, k: 6, passOnly: true },
    // Snap-share trend: last `games` snap % vs sample, applied to volume.
    snaps: { weight: 0, games: 2, cap: 0.3 },
    // Touchdowns. Base = xWeight × expected TDs from usage (goal-line / red-zone
    // carries and targets × league TD rate per opportunity) + the rest from TDs
    // actually scored. Red-zone trend compares recent usage to the sample.
    td: { xWeight: 1, trendGames: 3, trendWeight: 0.15, trendCap: 0.25, calib: { floor: 0.1, scale: 0.7 },
      // QB pass TDs shrink toward a league-typical starter (backtest-fitted).
      passCalib: { mean: 1.5, scale: 0.3 } },
    // First TD: share flattening (λ^power), which first-TD factors to weight
    // in (none helped in backtests, so none), their regression pseudo-counts,
    // and a rate for defensive/special-teams TDs.
    firstTd: { power: 0.7, apply: [], kEarly: 15, kHistory: 8, kDefense: 25, dstRate: 0.1, scale: 1 },
    // First-quarter share tilts: regression pseudo-games (backtest-tuned).
    q1: { kPlayer: 30, kTeam: 30, kDefense: 30 },
    // Game model: ridge = pseudo-games pulling ratings to average, priorWeight =
    // weight of last season's games, SDs of margin/total around projections.
    game: { ridge: 6, priorWeight: 0.25, epaWeight: 0.5, epaScale: 0.7, epaFiltered: true, qbDrop: 2.5, marginSd: 14, totalSd: 13,
      // Rest edge (pts per day), skill players out (pts per 100% of team fantasy
      // production), wind above windFrom mph and cold below coldBelow °F on the total.
      restPerDay: 0, injuryPerShare: 10, windFrom: 10, windPerMph: 0.4, coldBelow: 40, coldPerDeg: 0.2 },
    totalClamp: [0.6, 1.6],
  },

  // Stadium coordinates for weather. `indoor` covers domes and retractable
  // roofs (which close in bad weather). Keys are nflverse stadium_id.
  stadiums: {
    ATL97: { lat: 33.755, lon: -84.401, indoor: true },
    BAL00: { lat: 39.278, lon: -76.623 },
    BOS00: { lat: 42.091, lon: -71.264 },
    BUF00: { lat: 42.774, lon: -78.787 },
    BUF01: { lat: 42.774, lon: -78.787 },
    CAR00: { lat: 35.226, lon: -80.853 },
    CHI98: { lat: 41.862, lon: -87.617 },
    CIN00: { lat: 39.095, lon: -84.516 },
    CLE00: { lat: 41.506, lon: -81.699 },
    DAL00: { lat: 32.748, lon: -97.093, indoor: true },
    DEN00: { lat: 39.744, lon: -105.02 },
    DET00: { lat: 42.34, lon: -83.046, indoor: true },
    GNB00: { lat: 44.501, lon: -88.062 },
    HOU00: { lat: 29.685, lon: -95.411, indoor: true },
    IND00: { lat: 39.76, lon: -86.164, indoor: true },
    JAX00: { lat: 30.324, lon: -81.637 },
    KAN00: { lat: 39.049, lon: -94.484 },
    LAX01: { lat: 33.953, lon: -118.339, indoor: true },
    MIA00: { lat: 25.958, lon: -80.239 },
    MIN01: { lat: 44.974, lon: -93.258, indoor: true },
    NAS00: { lat: 36.166, lon: -86.771 },
    NOR00: { lat: 29.951, lon: -90.081, indoor: true },
    NYC01: { lat: 40.814, lon: -74.074 },
    PHI00: { lat: 39.901, lon: -75.168 },
    PHO00: { lat: 33.528, lon: -112.263, indoor: true },
    PIT00: { lat: 40.447, lon: -80.016 },
    SEA00: { lat: 47.595, lon: -122.332 },
    SFO01: { lat: 37.403, lon: -121.97 },
    TAM00: { lat: 27.976, lon: -82.503 },
    VEG00: { lat: 36.091, lon: -115.184, indoor: true },
    WAS00: { lat: 38.908, lon: -76.864 },
    // International / neutral sites
    LON00: { lat: 51.556, lon: -0.28 },
    LON02: { lat: 51.604, lon: -0.066 },
    GER00: { lat: 48.219, lon: 11.625 },
    MUN01: { lat: 48.219, lon: 11.625 },
    FRA00: { lat: 50.069, lon: 8.646 },
    PAR00: { lat: 48.924, lon: 2.36 },
    MAD01: { lat: 40.453, lon: -3.688, indoor: true },
    MEX00: { lat: 19.303, lon: -99.15 },
    SAO00: { lat: -23.545, lon: -46.474 },
    RIO00: { lat: -22.912, lon: -43.23 },
    MEL00: { lat: -37.82, lon: 144.983 },
    DUB00: { lat: 53.335, lon: -6.228 },
  },
  // nflverse schedule times are US Eastern.
  scheduleTimezone: 'America/New_York',

  rawColumns: ['cmp', 'pass_att', 'pass_yds', 'pass_td', 'int', 'rush_att', 'rush_yds', 'rush_td', 'tgt', 'rec', 'rec_yds', 'rec_td', 'fpts', 'car_gl', 'car_rz', 'tgt_rz', 'q1_car', 'q1_tgt', 'ftd_game', 'ftd_team'],
};
