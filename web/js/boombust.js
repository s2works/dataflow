// Boom / bust: specific matchup angles and boom/bust probabilities.
//
// Boom = fantasy points ≥ max(1.5 × the player's average, a position floor).
// Bust = fantasy points ≤ 0.5 × the player's average.
//
// Angles are plain rules over usage, the opponent's per-position allowances,
// Vegas lines, weather and injuries. Each is backtested (tools/fit_boom_bust.mjs)
// so the UI can show how often it actually produced booms/busts vs normal.

export const BOOM = { mult: 1.5, floor: { QB: 22, RB: 16, WR: 16, TE: 12 } };
export const BUST = { mult: 0.5 };

export const boomLine = (pos, avg) => Math.max(BOOM.mult * avg, BOOM.floor[pos] ?? 0);
export const bustLine = (avg) => BUST.mult * avg;

// Rank helpers: "soft" = the opponent allows among the most to this position.
const softRank = (model, opp, pos, stat) => {
  const s = model.posStat(opp, pos, stat, 'def');
  return s.rank == null ? null : model.N - s.rank + 1; // 1 = allows the most
};

// Game context from the team's perspective.
export function gameContext(p, r) {
  const g = r.game;
  const spread = g.spread_line == null ? null : r.isHome ? g.spread_line : -g.spread_line; // + = favored
  const total = g.total_line ?? null;
  const implied = spread != null && total != null ? (total + spread) / 2 : null;
  return { g, spread, total, implied };
}

const w = (r) => r.weather ?? {};
const badWeather = (r) => (w(r).wind ?? 0) >= 15 || (w(r).snow ?? 0) >= 0.1 || (w(r).precip ?? 0) >= 0.05 || (w(r).prob ?? 0) >= 60;

// Each angle: id, kind (boom|bust), positions, test(ctx) -> false | text.
export const ANGLES = [
  {
    id: 'rb_receiving', kind: 'boom', pos: ['RB'], label: 'Receiving back vs soft coverage',
    test: ({ p, r, model, total }) => {
      const soft = softRank(model, r.opp, 'RB', 'rec');
      return p.avg.tgt >= 2.5 && soft <= 8 && total >= 45.5 &&
        `${p.avg.tgt.toFixed(1)} tgt/G · ${r.opp} allows the ${ord(soft)}-most RB catches · total ${total}`;
    },
  },
  {
    id: 'rb_smash', kind: 'boom', pos: ['RB'], label: 'Workhorse, favored, soft run D',
    test: ({ p, r, model, spread }) => {
      const soft = softRank(model, r.opp, 'RB', 'rush_yds');
      return p.avg.rush_att >= 14 && spread >= 4 && soft <= 10 &&
        `${p.avg.rush_att.toFixed(0)} car/G · favored by ${spread} · ${r.opp} ${ord(soft)}-most RB rush yds allowed`;
    },
  },
  {
    id: 'goal_line', kind: 'boom', pos: ['RB', 'QB'], label: 'Goal-line role in a high-scoring spot',
    test: ({ p, implied }) => (p.avg.car_gl ?? 0) >= 0.8 && implied >= 25 &&
      `${p.avg.car_gl.toFixed(1)} carries inside the 5 per game · implied ${implied.toFixed(1)} pts`,
  },
  {
    id: 'shootout', kind: 'boom', pos: ['QB', 'WR', 'TE'], label: 'Shootout',
    test: ({ p, total, implied }) => total >= 48.5 && implied >= 24.5 && (p.pos === 'QB' || p.avg.tgt >= 6) &&
      `Total ${total}, team implied ${implied.toFixed(1)}`,
  },
  {
    id: 'wr_soft', kind: 'boom', pos: ['WR'], label: 'Target hog vs soft WR defense',
    test: ({ p, r, model }) => {
      const soft = softRank(model, r.opp, 'WR', 'fpts');
      return p.avg.tgt >= 7 && soft <= 6 && `${p.avg.tgt.toFixed(1)} tgt/G · ${r.opp} ${ord(soft)}-most WR points allowed`;
    },
  },
  {
    id: 'te_soft', kind: 'boom', pos: ['TE'], label: 'Involved TE vs soft TE defense',
    test: ({ p, r, model }) => {
      const soft = softRank(model, r.opp, 'TE', 'fpts');
      return p.avg.tgt >= 4.5 && soft <= 6 && `${p.avg.tgt.toFixed(1)} tgt/G · ${r.opp} ${ord(soft)}-most TE points allowed`;
    },
  },
  {
    id: 'volume_bump', kind: 'boom', pos: ['RB', 'WR', 'TE'], label: 'Teammates out',
    test: ({ r }) => {
      const f = r.factors.find((x) => x.id === 'usage');
      return f && f.impact >= 0.1 && f.text;
    },
  },
  {
    id: 'low_total', kind: 'bust', pos: ['QB', 'RB', 'WR', 'TE'], label: 'Low game total',
    test: ({ total }) => total != null && total <= 40.5 && `Total only ${total}`,
  },
  {
    id: 'tough_d', kind: 'bust', pos: ['QB', 'RB', 'WR', 'TE'], label: 'Toughest defenses vs position',
    test: ({ p, r, model }) => {
      const s = model.posStat(r.opp, p.pos, 'fpts', 'def');
      return s.rank != null && s.rank <= 4 && `${r.opp} allows the ${ord(s.rank)}-fewest points to ${p.pos}s`;
    },
  },
  {
    id: 'weather', kind: 'bust', pos: ['QB', 'WR', 'TE'], label: 'Bad weather',
    test: ({ r }) => badWeather(r) && `Wind ${Math.round(w(r).wind ?? 0)} mph${(w(r).snow ?? 0) >= 0.1 ? ', snow' : (w(r).precip ?? 0) >= 0.05 || (w(r).prob ?? 0) >= 60 ? ', rain' : ''}`,
  },
  {
    id: 'rb_script', kind: 'bust', pos: ['RB'], label: 'Early-down back, big underdog',
    test: ({ p, spread }) => spread != null && spread <= -6 && p.avg.tgt < 3 &&
      `${-spread}-pt underdog · only ${p.avg.tgt.toFixed(1)} tgt/G to fall back on`,
  },
  {
    id: 'qb_change', kind: 'bust', pos: ['WR', 'TE', 'RB'], label: 'Backup QB',
    test: ({ r }) => r.factors.find((x) => x.id === 'qb')?.text ?? false,
  },
];

function ord(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function anglesFor(p, r, model) {
  const ctx = { p, r, model, ...gameContext(p, r) };
  const out = [];
  for (const a of ANGLES) {
    if (!a.pos.includes(p.pos)) continue;
    const text = a.test(ctx);
    if (text) out.push({ ...a, text });
  }
  return out;
}

// P(fantasy points ≥ x) from the fitted actual ÷ projected distribution.
export function fptsAtLeast(dist, pos, proj, x) {
  const q = dist?.[`fpts_${pos}`]?.q;
  if (!q || !(proj > 0)) return null;
  const t = x / proj, n = q.length - 1;
  if (t <= q[0]) return 1;
  if (t > q[n]) return 0;
  let i = 0;
  while (i < n && q[i + 1] < t) i++;
  const span = q[i + 1] - q[i];
  return 1 - (i + (span > 0 ? (t - q[i]) / span : 0)) / n;
}

// fit = boombust.json: { dists, calib: { boom: [a, b], bust: [a, b] } }.
// Raw probabilities are linearly recalibrated (a + b·p) against backtests.
export function boomBust(fit, p, r) {
  const cal = (k, v) => (v == null || !fit?.calib?.[k] ? v : Math.min(0.95, Math.max(0.01, fit.calib[k][0] + fit.calib[k][1] * v)));
  const boom = fptsAtLeast(fit?.dists, p.pos, r.projFpts, boomLine(p.pos, r.baseFpts));
  const bustAbove = fptsAtLeast(fit?.dists, p.pos, r.projFpts, bustLine(r.baseFpts));
  return {
    boom: cal('boom', boom),
    bust: cal('bust', bustAbove == null ? null : 1 - bustAbove),
    boomAt: boomLine(p.pos, r.baseFpts),
    bustAt: bustLine(r.baseFpts),
  };
}

// What an angle actually did in backtests, judged by its record rather than its
// intent: 'boom' (more booms), 'floor' (fewer busts), 'bust' (more busts or
// fewer booms), or null (no real effect — hidden).
export function angleEffect(rec) {
  if (!rec || rec.n < 25) return null;
  const dBoom = rec.boom - rec.baseBoom, dBust = rec.bust - rec.baseBust;
  if (dBust >= 0.04 || dBoom <= -0.04) return 'bust';
  if (dBoom >= 0.03) return 'boom';
  if (dBust <= -0.04) return 'floor';
  return null;
}
