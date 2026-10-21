// Odds display: American (+150 / −120) or decimal (2.50 / 1.83), chosen in
// the top bar and remembered per browser. Data stays American internally.

const KEY = 'oddsFormat';
let format = 'american';
try { if (localStorage.getItem(KEY) === 'decimal') format = 'decimal'; } catch { /* storage blocked */ }

export const oddsFormat = () => format;
export function setOddsFormat(f) {
  format = f === 'decimal' ? 'decimal' : 'american';
  try { localStorage.setItem(KEY, format); } catch { /* storage blocked */ }
}

const toDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);

// A book price given in American odds.
export function fmtOdds(american) {
  if (american == null || !Number.isFinite(american)) return '–';
  if (format === 'decimal') return toDecimal(american).toFixed(2);
  return american > 0 ? `+${american}` : `${american}`;
}

// The fair (no-vig) price for a probability.
export function fairOdds(p) {
  if (!(p > 0 && p < 1)) return '–';
  if (format === 'decimal') return (1 / p).toFixed(2);
  return p >= 0.5 ? `${Math.round((-100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`;
}

// −110 (the usual juice) in the chosen format, for notes.
export const juiceLabel = () => (format === 'decimal' ? '1.91' : '−110');

// Top-bar switch; calls onChange after switching.
export function mountOddsSwitch(onChange) {
  const controls = document.querySelector('.controls');
  if (!controls || document.querySelector('#odds-format')) return;
  const label = document.createElement('label');
  label.title = 'How odds are shown';
  label.innerHTML = `Odds <select id="odds-format"><option value="american">American</option><option value="decimal">Decimal</option></select>`;
  controls.appendChild(label);
  const sel = label.querySelector('select');
  sel.value = format;
  sel.addEventListener('change', () => { setOddsFormat(sel.value); onChange(); });
}
