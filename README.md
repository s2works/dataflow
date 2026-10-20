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

**Backtest** (`node tools/backtest.mjs`, 2025 wks 4–18 + 2026): mean absolute
error 5.63 PPR pts vs 5.74 for the plain average, and the colors line up with
results — players flagged **≥ +10%** beat their average 56.5% of the time,
**≤ −10%** only 34.9%. Fantasy points are noisy; treat projections as a
tiebreaker and context, not a lock. All weights live in
`web/js/sports/nfl.js` → `projection`; re-run the backtest after changing them.

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
lines (spread, total, moneylines), rest days and recorded game weather.
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
web/js/projections.js     player projection model + weather forecasts
web/js/sports/nfl.js      NFL stats, positions, projection weights, stadiums
tools/backtest.mjs        projection accuracy check
web/data/nfl/             generated JSON (committed)
```
