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
export function overProb(dist, stat, proj, line) {
  const d = dist?.[stat];
  if (!d || !(proj > 0)) return null;
  const x = line / proj;
  const q = d.q, n = q.length - 1;
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
  const q = dist?.[stat]?.q;
  return q ? proj * q[Math.floor(q.length / 2)] : proj;
}

// P(X >= k) for a Poisson with mean lam (pass TDs).
export function poissonAtLeast(lam, k) {
  let term = Math.exp(-lam), cdf = 0;
  for (let i = 0; i < k; i++) { cdf += term; term *= lam / (i + 1); }
  return 1 - cdf;
}
