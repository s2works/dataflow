// Re-rank prop candidates for the Top Picks tabs (NFL and NHL).
//   edge  — model chance minus the line's chance (book no-vig, or the
//           player's average on estimated lines). The default; what the
//           Scorecard grades.
//   model — the model's own chance for that side, ignoring the line's price.
//   proj  — how far the projection clears the line, relative to the line.
// Each candidate: { market, line, proj, p (model P over), pBook | pBase }.

const book = (x) => x.pBook ?? x.pBase;
const SCORE = {
  edge: (x, over) => (over ? x.p - book(x) : book(x) - x.p),
  model: (x, over) => (over ? x.p : 1 - x.p),
  proj: (x, over) => (over ? x.proj - x.line : x.line - x.proj) / Math.max(x.line, 0.5),
};
// Which side a candidate belongs to under each ranking.
const SIDE = {
  edge: (x, over) => (over ? x.p > book(x) : x.p < book(x)),
  model: (x, over) => (over ? x.p > 0.5 : x.p < 0.5),
  proj: (x, over) => (over ? x.proj > x.line : x.proj < x.line),
};

export const RANK_LABELS = { edge: 'Edge', model: 'Model chance', proj: 'Projection vs line' };
export const MIN_PROB = [['0', 'Any'], ['0.55', '55%+'], ['0.6', '60%+'], ['0.65', '65%+']];

// Backtest hit rate of every candidate by the model's chance for its side:
// rows of { x (with side), res } → [{ lo, hi, n, pred, hit }].
export const PROB_BUCKETS = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 1.01]];
export function probBuckets(rows) {
  return PROB_BUCKETS.map(([lo, hi]) => {
    let n = 0, hits = 0, pred = 0;
    for (const { x, res } of rows) {
      const q = x.side === 'under' ? 1 - x.p : x.p;
      if (q < lo || q >= hi || !res || res.void || res.actual === x.line) continue;
      n++; hits += res.hit ? 1 : 0; pred += q;
    }
    return { lo, hi, n, pred: n ? +(pred / n).toFixed(3) : null, hit: n ? +(hits / n).toFixed(3) : null };
  });
}
// The model's side for a candidate: whichever it gives 50%+.
export const modelSide = (x) => ({ ...x, side: x.p >= 0.5 ? 'over' : 'under' });

export function rankPicks(cands, { by = 'edge', top = 20, maxPerMarket = {}, noUnder = ['anytime_td'], minProb = 0 } = {}) {
  const list = (over) => {
    const out = [], per = {};
    const rows = cands.filter((x) => SIDE[by](x, over) && (over || !noUnder.includes(x.market)) && (over ? x.p : 1 - x.p) >= minProb)
      .sort((a, b) => SCORE[by](b, over) - SCORE[by](a, over));
    for (const x of rows) {
      if (out.length >= top) break;
      if ((per[x.market] ?? 0) >= (maxPerMarket[x.market] ?? Infinity)) continue;
      per[x.market] = (per[x.market] ?? 0) + 1;
      out.push({ ...x, side: over ? 'over' : 'under' });
    }
    return out;
  };
  return { over: list(true), under: list(false) };
}
