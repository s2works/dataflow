// NHL sport definition (same shape as nfl.js, read by the shared engine).
// Positions: C, W (left + right wing) and D; goalies are handled separately.
// "week" in the data is the game-day index of the season (see build_nhl.py).

const perGame = (key) => (a, n) => (n ? a[key] / n : null);

export default {
  id: 'nhl',
  name: 'NHL',
  dataPath: 'data/nhl',
  dayBased: true,

  teamStats: [
    { id: 'gf', label: 'Goals / G', fn: perGame('gf'), offenseHigh: true, fmt: 2 },
    { id: 'sog', label: 'Shots / G', fn: perGame('sog'), offenseHigh: true, fmt: 1 },
    { id: 'shpct', label: 'Shooting %', fn: (a) => (a.sog ? (100 * a.gf) / a.sog : null), offenseHigh: true, fmt: 1,
      note: 'Offense: goals per shot. Defense: goals allowed per shot faced (lower = better goaltending + defense).' },
    { id: 'ppg', label: 'PP Goals / G', fn: perGame('ppg'), offenseHigh: true, fmt: 2 },
    { id: 'hits', label: 'Hits / G', fn: perGame('hits'), offenseHigh: true, fmt: 1, note: 'Offense: hits made. Defense: hits taken.' },
    { id: 'fo', label: 'Faceoff %', fn: (a, n) => (n ? a.fo_pct / n : null), offenseHigh: true, fmt: 1 },
  ],

  positions: {
    C: {
      label: 'C', key: 'pts',
      stats: [
        { id: 'pts', label: 'Points', fmt: 2 }, { id: 'g', label: 'Goals', fmt: 2 }, { id: 'a', label: 'Assists', fmt: 2 },
        { id: 'sog', label: 'Shots', fmt: 2 }, { id: 'blk', label: 'Blocks', fmt: 2 },
      ],
      relevant: (p) => p.toi >= 11,
    },
    W: {
      label: 'W', key: 'pts',
      stats: [
        { id: 'pts', label: 'Points', fmt: 2 }, { id: 'g', label: 'Goals', fmt: 2 }, { id: 'a', label: 'Assists', fmt: 2 },
        { id: 'sog', label: 'Shots', fmt: 2 }, { id: 'blk', label: 'Blocks', fmt: 2 },
      ],
      relevant: (p) => p.toi >= 11,
    },
    D: {
      label: 'D', key: 'pts',
      stats: [
        { id: 'pts', label: 'Points', fmt: 2 }, { id: 'g', label: 'Goals', fmt: 2 }, { id: 'a', label: 'Assists', fmt: 2 },
        { id: 'sog', label: 'Shots', fmt: 2 }, { id: 'blk', label: 'Blocks', fmt: 2 },
      ],
      relevant: (p) => p.toi >= 14,
    },
  },

  derive(a) { return a; },

  rawColumns: ['g', 'a', 'pts', 'sog', 'blk', 'hits', 'ppg', 'pim', 'toi'],

  // ---- projections (all knobs tuned by tools/nhl_backtest.mjs) ---------------
  projection: {
    // Prop markets: stat, label, lines shown, negative-binomial size r
    // (spread around the projection; Poisson as r → ∞).
    markets: {
      sog: { label: 'Shots on goal', lines: [1.5, 2.5, 3.5, 4.5], r: 12 },
      pts: { label: 'Points', lines: [0.5, 1.5], r: 35 },
      g: { label: 'Goals', lines: [0.5], r: 5 },
      a: { label: 'Assists', lines: [0.5], r: 12 },
      blk: { label: 'Blocked shots', lines: [0.5, 1.5, 2.5], r: 5 },
    },
    baseline: { priorGames: 25, minPriorGames: 10 },
    regress: { opponent: 30 },
    opponentWeight: 1,
    // Opponent allowance helped shots/blocks; it hurt points/assists in backtests.
    opponentStats: ['sog', 'blk'],
    homeWeight: 1,
    goalieWeight: 1, // opponent goalie save % on goals/points
    b2bWeight: 0, // second night of a back-to-back
    toiTrend: { weight: 0.6, games: 3, cap: 0.2 },
    saves: { kShots: 1500, kGames: 10, r: 60 },
    game: { ridge: 6, priorWeight: 0.25, shotWeight: 0.5, homeIce: true, goalieWeight: 0.5, otHomeEdge: 0.02, calib: 0.7 },
  },
};
