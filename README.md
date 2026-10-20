# Edge Board

A matchup dashboard for finding statistical edges in pro sports. NFL first;
the structure is built so other sports can be added by copying one pipeline
script and one sport config.

## What it shows

| Tab | What you get |
| --- | --- |
| **Matchups** | Every game in the selected week, with chips for the biggest offense-vs-defense mismatches. Click a game for the full breakdown: team stats, position-by-position (QB/RB/WR/TE) stats, and the players in that game. |
| **Player Edges** | Every key-role player playing that week, with what the opponent allows to their position, a matchup multiplier, and matchup-adjusted fantasy points / key stat. |
| **Projections** | Projected stat line + PPR fantasy points for every key-role player that week, colored by how the spot compares to the player's own average, with the top reasons listed. Click a row for every factor and the full stat line. Each game page also has a projections table. |
| **Defense vs Position** | What each defense allows per game to QB, RB, WR, TE (fantasy points, yards, receptions, TDs), ranked and color-coded, with that week's opponent. |
| **Team Rankings** | Offense and defense ranks for every team stat. |

### How edges are colored

Every stat is ranked 1–32 two ways:

* **Offense rank** — 1 = most productive (e.g. most pass yds/G).
* **Defense rank** — 1 = stingiest (fewest pass yds/G allowed).

**Edge = defense rank − offense rank.** An offense ranked 3rd in passing
facing the defense ranked 30th in passing yards allowed gets **+27** → strong
green. The reverse is −27 → strong red. For stats where lower is better for the
offense (sacks, turnovers) the ranks are flipped automatically.

**Player matchups** use the opponent's per-game allowance to the player's
position: `Matchup × = opponent allowed ÷ league-average allowed`. A 1.40× on a
TE means that defense gives up 40% more fantasy points to tight ends than
average; *Adj FPTS* is the player's average × that multiplier.

### How projections work

`projection = player average × Π(factors)`, per stat (targets, yards, TDs…);
fantasy points are rebuilt from the projected stats. Each factor's impact is
how much projected points move when that one factor is removed — those are the
percentages shown in **Why**.

| Factor | What it does |
| --- | --- |
| Vegas implied total | `(total ± spread) / 2` vs the team's points per game. Strongest single factor. |
| Opponent vs position | What the opponent allows to the position, per stat, heavily regressed (most of it is already in the Vegas line). |
| Weather | Outdoor stadiums only. Wind > 10 mph, cold < 35°F, rain or snow cut passing and nudge rushing. Live forecast from Open-Meteo for games within ~15 days; recorded weather for past games. Domes and retractable roofs are neutral. |
| Divisional game | League-wide divisional vs non-divisional production (from the data). |
| Game script | Favorites run more, underdogs throw more (spread ≥ 3). |
| Rest | Days of rest vs the opponent (bye weeks, short weeks). |
| History vs opponent | The player's past games against this team (this and last season), regressed. |
| Recent form | Last 3 games vs the sample average. |
| Home / road | Shown, but only applied when there's no Vegas line. Backtests showed the line already prices it in. |
| Teammates out | Players ruled **Out/Doubtful** on the official injury report hand their targets (to all pass catchers) and carries (to RBs) to teammates, weighted toward the same position; 70% is absorbed by the players shown, the rest by depth guys. Only the part of a teammate's sample where the injured player actually played counts. Depth players who become starters show up automatically. |
| QB change | If the starting QB is out, the backup is projected as the starter and his pass catchers take a 10% passing hit. |
| Questionable | −5% for the player himself. |

**Backtest** (`node tools/backtest.mjs`, 2025 wks 4–18 + 2026): error of
5.64 / 7.34 PPR pts (MAE / RMSE) vs 5.74 / 7.47 for the plain average, and the
colors line up with results: players flagged **≥ +10%** beat their average
55% of the time, **≤ −10%** only 33%. Teammates of players ruled out really do
score more (10.9 actual vs 10.1 average; projected 10.8), which RMSE rewards;
MAE penalizes any upward shift on right-skewed fantasy scores, so check both. Fantasy points are noisy; treat projections as a
tiebreaker and context, not a lock. All weights live in
`web/js/sports/nfl.js` → `projection`; re-run the backtest after changing them.

### Touchdowns tab

**Anytime TD** (rush or receiving) for every key player, with the no-vig
**fair odds**: if a book pays more than that, the model sees value.

1. **Usage-based expected TDs**: from play-by-play, each player's goal-line
   carries (inside the 5), red-zone carries (6–20), red-zone targets and other
   touches, × the league TD rate for each (a goal-line carry scores ~40% of
   the time, a red-zone target ~26%, a carry outside the 20 under 1%).
   Backtests showed this beats counting past TDs by a wide margin, so it's
   the whole base. It also feeds the fantasy projections now.
2. **Game factors**: the same as projections (Vegas total, opponent vs
   position, weather, game script, divisional, rest, injuries/usage,
   Questionable), plus a **red-zone trend** (last 3 games' red-zone usage vs
   the sample).
3. **Calibration**: P = 1 − e^−(0.1 + 0.7λ), fitted so predicted rates match
   real scoring.

| Predicted | Actual (backtest) |
| --- | --- |
| 10–20% | 15.8% (pred 15.7%) |
| 20–30% | 24.7% (pred 24.7%) |
| 30–45% | 34.7% (pred 35.7%) |
| 45%+ | 55.1% (pred 52.4%) |

Log loss 0.549 vs 0.698 for "TDs scored so far" (lower is better).

**QB passing TDs**: projected passing TDs with 2+ / 3+ probabilities and
fair odds. Honest caveat: this barely beats a coin flip in backtests, so
projections are shrunk hard toward a league-typical 1.5.

### Player props vs projection

**Projections → Props vs projection** lists each prop line (pass yds, pass
TDs, rush yds, receptions, rec yds) next to the model: projection, **median**,
model P(over), the book's P(over) with the vig removed, and the **lean** (the
side where the model's probability beats the book's). The Touchdowns tab gets
the anytime-TD price too, and game pages get a props card.

* **Why median:** books set lines near the median, and yardage averages run
  above medians (a few big games). P(over) comes from the backtested spread of
  actual ÷ projected per stat (`tools/fit_prop_dist.mjs`, refit each run), not
  a bell curve. Holdout check (fit 2025, test 2026, with the player's average
  as a stand-in line): predicted over-rates land within a few points for
  receptions, receiving and rushing yards; passing yards is still a small
  sample. Real lines are sharper than that stand-in, so expect fewer and
  smaller leans than you'd guess, and treat leans under ~5% as noise.
* **Setup:** lines come from [The Odds API](https://the-odds-api.com). Get a
  key and add it as the repo secret **`ODDS_API_KEY`** (Settings → Secrets and
  variables → Actions). Each game costs 6 credits per pull (6 markets × US
  region); ~14 games a week ≈ 85 credits per full refresh. Set the repo
  variable **`PROPS_MIN_HOURS`** to match your plan (e.g. 168 = weekly for a
  small free allowance, 12 for twice a day on a paid plan). The job stops
  when credits run low.

### Injuries & line movement

Each game page has an **Injury report** card (status, injury, the player's
usage, and who absorbs it) and a **Line movement** card: open vs current
spread, total and moneylines, plus step charts of each over time. Badges
(OUT / D / Q) appear next to player names everywhere.

nflverse only publishes the *current* line, so the refresh job records a
snapshot of every upcoming game's line on each run (`web/data/nfl/lines_<season>.json`).
"Open" is the first line it saw; history starts when the job first runs.

### Auto-refresh

* `.github/workflows/refresh-nfl-data.yml` runs every 2 hours during the
  season (Sept–Feb): new stats, scores, injury reports and lines. It only
  commits when something changed.
* The dashboard checks `index.json` every 5 minutes (and when you come back to
  the tab) and reloads changed data in place, keeping your week/tab. Weather
  forecasts refresh hourly. The footer shows when data last changed.
* Hosted on Vercel (project `dataflow`, root directory `web/`, no build
  step): **https://dataflow-swart-three.vercel.app**. Every push to the
  production branch, including the refresh job's data commits, redeploys
  automatically.

### Controls

* **Week** — rankings only ever use games *before* the selected week, so you
  can pick past weeks to back-test how edges played out.
* **Sample** — season to date, or each team's last 5 / last 3 games.
* **Season** — current and previous season are built by default.

## Running it

```bash
pip install -r requirements.txt
python pipeline/build_nfl.py          # downloads data -> web/data/nfl/*.json
python -m http.server 8000 -d web     # open http://localhost:8000
```

The dashboard is static HTML/JS (no build step), so `web/` can be hosted on
GitHub Pages, Vercel, Netlify, etc.

`.github/workflows/refresh-nfl-data.yml` rebuilds the data daily during the
season and commits it.

## Data

All data comes from [nflverse](https://github.com/nflverse/nflverse-data)
(public, free): weekly player stats and the schedule, which includes betting
lines (spread, total, moneylines), rest days, recorded game weather and the
official weekly injury reports.
Upcoming-game forecasts are fetched in the browser from
[Open-Meteo](https://open-meteo.com) (free, no API key). Team totals are summed from player stats;
points come from final scores. Fantasy points are PPR.

## Adding another sport

1. `pipeline/build_<sport>.py` — emit the same JSON shape (`teams`,
   `schedule`, `team_games`, `position_games`, `players`, `player_games`).
2. `web/js/sports/<sport>.js` — copy `nfl.js` and define that sport's team
   stats, positions and usage thresholds.
3. Register it in `SPORTS` in `web/js/app.js`.

`web/js/engine.js` (ranking + edge math) is sport-agnostic.

## Layout

```
pipeline/build_nfl.py     data download + aggregation
web/index.html            dashboard shell
web/styles.css
web/js/app.js             views / UI
web/js/engine.js          ranks, edges, player matchup math
web/js/projections.js     player projection + touchdown model, weather forecasts
web/js/sports/nfl.js      NFL stats, positions, projection weights, stadiums
tools/backtest.mjs        projection accuracy check
web/data/nfl/             generated JSON (committed)
```
