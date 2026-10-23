// Player-prop math: odds conversions and the model's P(over a line).

// American odds -> implied probability (includes the book's vig).
export function impliedProb(american) {
  if (american == null) return null;
  return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
}

// Remove the vig from a two-sided market; returns the fair P(over).
export function fairOver(overPrice, underPrice) {
  const o = impliedProb(overPrice), u = impliedProb(underPrice);
  if (o == null) return null;
  if (u == null) return o;
  return o / (o + u);
}

// P(actual > line) given a projection, read off the fitted distribution of
// actual ÷ projected for that stat (see tools/fit_prop_dist.mjs).
// Quantiles for a projection: the bucket fitted on similar-sized projections.
function quantilesFor(d, proj) {
  if (!d.buckets?.length) return d.q;
  return (d.buckets.find((b) => b.upTo == null || proj <= b.upTo) ?? d.buckets[d.buckets.length - 1]).q;
}

export function overProb(dist, stat, proj, line) {
  const d = dist?.[stat];
  if (!d || !(proj > 0)) return null;
  const x = line / proj;
  const q = quantilesFor(d, proj), n = q.length - 1;
  if (x < q[0]) return 1;
  if (x >= q[n]) return 0;
  // Fraction of the distribution at or below x, interpolated between quantiles.
  let i = 0;
  while (i < n && q[i + 1] <= x) i++;
  const span = q[i + 1] - q[i];
  const frac = span > 0 ? (x - q[i]) / span : 0;
  return 1 - (i + frac) / n;
}

// Typical (median) outcome for a projection: averages sit above medians for
// skewed stats like yardage, and book lines are set near the median.
export function medianOutcome(dist, stat, proj) {
  const q = dist?.[stat] && quantilesFor(dist[stat], proj);
  return q ? proj * q[Math.floor(q.length / 2)] : proj;
}

// The q-th quantile (0–1) of the outcome for a projection, e.g. 0.25 / 0.75
// for a likely range.
export function outcomeQuantile(dist, stat, proj, q) {
  const qs = dist?.[stat] && quantilesFor(dist[stat], proj);
  if (!qs) return null;
  const i = q * (qs.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return proj * (qs[lo] + (qs[hi] - qs[lo]) * (i - lo));
}

// P(X >= k) for a negative binomial with mean m and size r (Poisson as r → ∞).
// Used for small counts like first-quarter receptions, where r ≈ 8 fit the
// backtest best (slightly more spread than Poisson).
export function nbAtLeast(m, r, k) {
  m = Math.max(m, 0.01);
  const p = r / (r + m);
  let term = Math.pow(p, r), cdf = 0; // P(X = 0)
  for (let x = 0; x < k; x++) {
    cdf += term;
    term *= ((x + r) / (x + 1)) * (1 - p);
  }
  return 1 - cdf;
}

// The projection a book's price implies: the mean whose P(over line) matches
// the book's no-vig chance (bisection on a monotone function). `overFn(m)`
// gives P(over) for a projection m.
export function impliedMean(overFn, line, pBook) {
  if (!(pBook > 0 && pBook < 1)) return null;
  let lo = Math.max(0.01, line * 0.1), hi = Math.max(line * 5, 3);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (overFn(mid) < pBook) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// P(X >= k) for a Poisson with mean lam (pass TDs).
export function poissonAtLeast(lam, k) {
  let term = Math.exp(-lam), cdf = 0;
  for (let i = 0; i < k; i++) { cdf += term; term *= lam / (i + 1); }
  return 1 - cdf;
}
