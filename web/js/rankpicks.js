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

export function rankPicks(cands, { by = 'edge', top = 20, maxPerMarket = {}, noUnder = ['anytime_td'] } = {}) {
  const list = (over) => {
    const out = [], per = {};
    const rows = cands.filter((x) => SIDE[by](x, over) && (over || !noUnder.includes(x.market)))
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
