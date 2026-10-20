// Entry point: pick the sport from ?sport= (remembered per browser) and load
// that sport's app. NFL is the default.
const SPORTS = { nfl: './app.js', nhl: './nhl-app.js' };

let sport = new URLSearchParams(location.search).get('sport');
if (!SPORTS[sport]) {
  try { sport = localStorage.getItem('sport'); } catch { sport = null; }
}
if (!SPORTS[sport]) sport = 'nfl';
try { localStorage.setItem('sport', sport); } catch { /* storage unavailable */ }

document.querySelectorAll('#sport-switch a').forEach((a) => {
  a.classList.toggle('on', a.dataset.sport === sport);
  // Switching sport starts on that sport's Matchups tab.
  a.href = `?sport=${a.dataset.sport}#matchups`;
});
document.documentElement.dataset.sport = sport;
import(SPORTS[sport]);
