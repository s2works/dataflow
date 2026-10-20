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

  rawColumns: ['cmp', 'pass_att', 'pass_yds', 'pass_td', 'int', 'rush_att', 'rush_yds', 'rush_td', 'tgt', 'rec', 'rec_yds', 'rec_td', 'fpts'],
};
