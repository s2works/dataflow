# Edge Board

A matchup dashboard for finding statistical edges in pro sports. NFL first;
the structure is built so other sports can be added by copying one pipeline
script and one sport config.

## Sports

On player tabs (NFL: Player Edges, Projections, Touchdowns, Boom / Bust, Top
Picks; NHL: Player Edges, Player Props, Top Picks) a row of **game chips**
filters by game: click to hide/show a game, double-click for only that game,
or All / None. Top Picks re-rank within the selected games.

Switch sport with the **NFL / NHL** toggle next to the logo (remembered per
browser; `?sport=nhl` links straight to it). The NFL is documented first;
the NHL section is below.

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
| History vs opponent | The player's past games against this team. Shown as context only: it hurt accuracy once three seasons were loaded. |
| Recent form | Last 3 games vs the sample average. |
| Home / road | Shown, but only applied when there's no Vegas line. Backtests showed the line already prices it in. |
| Efficiency | Yards per target pulled toward what his depth of target supports. |
| Secondary out | QBs facing a defense missing starting corners/safeties. |
| Pace | Opponents that face more plays per game boost the passing game. |
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

### Accuracy upgrades (Oct 2026): what was added and what was tested

Each idea was added as its own switchable factor in `web/js/sports/nfl.js`
and backtested alone on the same 2025–26 games (each season using the one
before it as history). Kept only if it helped; the rest stay in the code,
switched off, so they can be re-tested as the season fills in.

| Factor | Result | Status |
| --- | --- | --- |
| **Last season as a prior** (3 games' worth, fades as this season's games add up) | 2026 fantasy MAE 5.79 → 5.65; helps TDs too | **on** (`baseline.priorGames`) |
| **Yards/target vs depth of target** (regress toward aDOT-based expectation) | rec yds RMSE 28.0 → 27.9; aDOT predicts future YPT better than past YPT | **on**, half weight (`efficiency`) |
| **Opponent's starting DBs out** (from injury report + DB snap shares) | pass yds better (fires in ~22% of QB games); receivers individually didn't benefit | **on for QBs** (`secondary`) |
| **Opponent pace** (plays faced vs league) | pass yds 61.5 → 61.3 MAE | **on, passing only** (`pace.volume`) |
| **Game model: garbage-time-filtered EPA** (win prob 10–90%) | small gain on margin and total | **on** (`game.epaFiltered`) |
| **Game model: starting QB out** | teams without their starter scored 2.8 below the model; Vegas already prices it | **on**, 2.5 pts (`game.qbDrop`) |
| Recency weighting of recent games | worse on its own | off (`baseline.decay`) |
| Snap-share trend / prior rescaled by snap share | worse (recent form already covers it) | off (`snaps`, `baseline.priorPerSnap`) |
| Pass-funnel tilt (pass rate faced) | worse | off (`pace.tilt`) |
| Yards/carry regression | rush yds a hair better, fantasy pts worse | off (`efficiency.rushWeight`) |
| Next Gen Stats (RYOE, separation, YAC over expected) | ~0 correlation with future efficiency (≤ 2% extra R²) | not loaded |
| Player history vs this opponent | with 3 seasons loaded it hurt every stat | **context only** (`history.apply`) |

Same 2025–26 games, before → after: fantasy MAE 5.567 → 5.535, RMSE
7.199 → 7.110; pass yds RMSE 79.6 → 78.0; rec yds 29.0 → 27.9; receptions
2.19 → 2.13; anytime-TD log loss 0.5494 → 0.5476. The pipeline now also builds
2024 so 2025 has a prior and every backtest/calibration has a third season.

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

**First TD** (Touchdowns → First TD, and a card on each game page): chance a
player scores the **game's** first TD and his **team's** first TD, with fair
odds. Each player's share of his team's expected TDs (everything above:
red-zone usage, Vegas, opponent, weather, injuries; flattened as λ^0.7 since
raw rates over-favor stars) × the chance his team scores first, from both
teams' expected TDs. Backtest (2025 + 2026): predicted rates match actual
within ~1–3 pts per bucket and beat "same odds for everyone" clearly.

Also computed and shown, but **not weighted in**: early-game role (share of
1st-quarter touches), his history of scoring his team's first TD, and which
positions the defense gives up first TDs to. Each was tested at several
strengths and made predictions worse or no better, so they're context only
(switch one on via `firstTd.apply` in `web/js/sports/nfl.js` and re-run
`node tools/backtest.mjs` to re-test as more data comes in).

**QB passing TDs**: projected passing TDs with 2+ / 3+ probabilities and
fair odds. Honest caveat: this barely beats a coin flip in backtests, so
projections are shrunk hard toward a league-typical 1.5.

### Game projections (score, spread, total, win %)

Each game page opens with **model vs Vegas**: projected score, spread, total
and win probability, plus the model's lean and its track record at that size
of disagreement. Week cards show a one-line model projection and Team
Rankings has a **Power** column (points better than average on a neutral
field).

* Model: opponent-adjusted offense/defense ratings from points scored/allowed,
  blended 50/50 with the same fit on offensive **EPA per play** (from
  play-by-play), ridge-regularized toward average, last season counted at 25%
  weight, home field from the data. Win % = normal on the margin (SD 14,
  fitted).
* **Honest backtest** (`node tools/fit_game_model.mjs`, 301 games, 2025–26,
  each projected only from earlier games), against the closing lines nflverse
  records:

  | | Model | Vegas |
  | --- | --- | --- |
  | Avg miss, margin | 10.1 | 9.7 |
  | Avg miss, total | 10.6 | 10.2 |
  | Win % log loss | 0.650 | 0.628 |

  When the model disagrees with the spread by 3+ points it went 57-56 ATS
  (50%); totals 46-46. Break-even at −110 is 52.4%. Closing lines are the
  sharpest numbers in betting, so this is a second opinion, not an edge.
  Opening lines are softer, and line snapshots are now being recorded, so this
  can be re-tested against openers once a few weeks are collected.

### Upsets

Favorites lose about a third of NFL games (Vegas favorites lost 33% of
2024–26 games; the model's favorites 36.5%). The Matchups page shows it:

* **Upset watch** banner: expected upsets this week = the sum of each
  underdog's chance (e.g. 5.1 of 14 in Week 7), plus the historical rate.
  After a week is played it lists the upsets that happened.
* Each card: the underdog and its chance (Vegas moneyline without the vig,
  which is better calibrated than the model; model's number next to it).
  **Upset alert** = Vegas and the model both give the underdog 40%+.
  **Model upset pick** = the model favors the Vegas underdog; a gap like that
  often means the market knows something first (QB status, lineup news).
* Sort cards **by upset chance**.
* Backtest: underdogs at 35–45% won 38.5%, at 25–35% won 27%, at
  0–25% won 20%; the chances shown are real.

The game model also now adjusts for injured skill players (10 pts per 100%
of a team's fantasy production ruled out, applied to the margin), wind above
10 mph (−0.4 per mph on the total) and cold below 40°F (−0.2 per degree),
using the live forecast for upcoming games. Rest was tested and added nothing
once injuries were in. Margin error 10.25 → 10.22, total 10.28 → 10.23.

### First-quarter projections

**Projections → 1st quarter**: 1Q passing yards, rushing yards, receptions and
receiving yards for every key player, with the median and likely range (middle
50% of outcomes) for yardage, and P(1+) / P(2+) for receptions.

* 1Q projection = full-game projection × the share of that stat that comes in
  the first quarter. League: ~22% of passing/receiving, ~24% of rushing.
  The share is nudged by the player's, team's and opponent's own 1Q
  tendencies, regressed hard (k = 30 games); backtests found those worth only
  ~1% in error, so the full-game projection does almost all the work.
  Cell color = this player's 1Q share vs league (fast/slow starters).
* Yardage ranges come from the backtested spread of outcomes, fitted
  separately by projection size (zero-yard quarters are common for fringe
  players, rarer for stars). Receptions use a negative binomial (r = 8), which
  backtested best: P(1+) predicted 41% → actual 39%, 59% → 61%, 75% → 73%.

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
  region); ~14 games a week ≈ 85 credits per full refresh. The defaults fit
  the **free plan (500 credits/month)**: each game is pulled once, about 48
  hours before kickoff (`PROPS_DAYS_AHEAD=2`, `PROPS_MIN_HOURS=72`, ≈ 420
  credits a month). On a paid plan set the repo variables
  **`PROPS_DAYS_AHEAD`** (e.g. 7) and **`PROPS_MIN_HOURS`** (e.g. 12) for
  earlier and repeated pulls as lines move.
* **Markets:** the default six cost 6 credits a game. Rush + rec yds
  (`player_rush_reception_yds`) is supported but not pulled by default (a 7th
  credit per game is too close to the free 500 a month). To swap it in, set
  the repo variable **`PROPS_MARKETS`** to a comma list, e.g.
  `player_pass_yds,player_rush_yds,player_receptions,player_reception_yds,player_rush_reception_yds,player_anytime_td`
  (drops pass TDs). Scrimmage yards are projected either way (rush + rec
  projections, with their own fitted spread for running backs: holdout
  predicted 37% → 38%, 44% → 45%, 53% → 56%). The job stops when credits run low.

### Top Picks and Scorecard

**Top Picks** ranks every priced prop for the week (pass yds, pass TDs, rush
yds, receptions, rec yds, rush + rec (scrimmage) yds for backs, plus anytime
TD when a book prices it) by **edge**
= the model's chance minus the book's no-vig chance, and lists the top 20
overs and top 20 unders with the line, price, projection, reasons and, once
games are final, ✓/✗. Lines are the **Vegas consensus** whenever the refresh
job has pulled them; a game without Vegas props gets **estimated** lines
(the half-yard nearest the median outcome for his own average, compared with
what that average implies), clearly marked *est.*

`tools/nfl_picks.mjs` (refresh job) saves each game's candidates to
`web/data/nfl/picks_<season>.json` on every run until kickoff, then freezes
them, so the **Scorecard** grades exactly what was shown before the game:
overall, by week, by market and **against Vegas vs estimated lines**, each
next to what the model expected and what the book implied. Backtest
(`--backtest`, `picks_record.json`, 33 weeks on estimated lines): top 20
overs hit 66% vs 49% implied by player averages, unders 56% vs 49%. Free
historical Vegas prop lines don't exist, and real lines already price in
injuries and role changes (where most of that edge comes from), so the
live "against Vegas" record is the real test.

### Boom / Bust tab

**Boom** = at least 1.5× the player's average (and at least QB 22 / RB 16 /
WR 16 / TE 12 PPR); **bust** = half his average or less. Each player gets a
calibrated P(boom) and P(bust) next to the normal rate for his position, plus
**angles**: specific setups like *receiving back vs a defense that allows lots
of RB catches in a high-total game*.

Every angle is backtested (`tools/fit_boom_bust.mjs`, refit each refresh) and
labeled by what it **actually** did, not what it was meant to do:

| Angle | Effect | Boom | Bust | Games |
| --- | --- | --- | --- | --- |
| Receiving back vs soft coverage (2.5+ tgt/G, top-8 RB catches allowed, total 45.5+) | Boom | 19% vs 13% | 12% vs 26% | 59 |
| Teammates out (usage bump ≥ 10%) | Boom | 20% vs 15% | 24% vs 28% | 304 |
| Shootout / goal-line role / target hog vs soft WR D / TE vs soft TE D | Safe floor | ≈ normal | 14–19% vs 23–29% | 54–209 |
| Bad weather (wind 15+, rain, snow) | Bust risk | 7% vs 15% | 38% vs 25% | 169 |
| Backup QB | Bust risk | 9% vs 15% | 32% vs 27% | 85 |

Angles with no real effect (low totals, toughest defenses, workhorse favorites,
early-down underdog backs) are tracked but hidden. New angles go in
`web/js/boombust.js`; the fit script reports their record.

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
  production branch (`main`), including the refresh job's data commits, redeploys
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
web/js/props.js           prop odds math, P(over a line)
web/js/boombust.js        boom/bust angles and probabilities
web/js/firsttd.js         first-TD probabilities
web/js/q1.js              first-quarter projections
web/js/gamemodel.js       game projections (ratings, spread, total, win %)
web/js/sports/nfl.js      NFL stats, positions, projection weights, stadiums
tools/backtest.mjs        projection accuracy check
tools/fit_prop_dist.mjs   prop outcome distributions (refit by the refresh job)
tools/fit_boom_bust.mjs   boom/bust calibration + angle records (refit by the refresh job)
tools/fit_game_model.mjs  game model record vs results and Vegas (refit by the refresh job)
web/data/nfl/             generated JSON (committed)
```

### Reliable hourly refresh (free)

GitHub runs the refresh job on its own hourly timer, but drops many scheduled
runs when it's busy. To make it dependable, have [cron-job.org](https://cron-job.org)
(free) trigger it every hour:

1. **GitHub token:** github.com → Settings → Developer settings → Personal
   access tokens → **Fine-grained tokens** → Generate new token. Repository
   access: *Only select repositories* → `s2works/dataflow`. Repository
   permissions → **Actions: Read and write**. Copy the token.
2. **cron-job.org:** create a free account → *Create cronjob*.
   * URL: `https://api.github.com/repos/s2works/dataflow/actions/workflows/refresh-nfl-data.yml/dispatches`
   * Schedule: every hour (e.g. minute 5)
   * Advanced → Request method **POST**; headers
     `Accept: application/vnd.github+json`,
     `Authorization: Bearer <your token>`,
     `X-GitHub-Api-Version: 2022-11-28`,
     `Content-Type: application/json`; request body `{"ref":"main"}`
   * *Test run* should return **204** and a new run appears under Actions.

When the token expires, generate a new one and paste it into the cronjob.

## NHL

Data: [sportsdataverse/fastRhockey-nhl-data](https://github.com/sportsdataverse/fastRhockey-nhl-data)
(free, updated nightly from the NHL's API): schedule plus team, skater and
goalie box scores. Games that have finished but aren't in it yet
(it posts the next morning) are filled in from the NHL's own API
(`api-web.nhle.com` boxscores, free, no key), so last night's results usually
land within a couple of hours of the final horn. `pipeline/build_nhl.py` writes `web/data/nhl/<season>.json`
(season = start year; the last three are built for priors and backtests).
NHL plays almost daily, so the date picker selects a **game day** instead of
a week. There are **no free NHL betting lines or injury feed**, so the game
model stands on its own (judged against results) and goalies are *probable*.

| Tab | What you get |
| --- | --- |
| **Matchups** | Day preview cards: model win % bar, upset chance, projected score, total goals (over 5.5 / 6.5), puck line, probable goalies with projected saves, top 3 skaters (chance of a point, projected shots), a **B2B** badge for teams on the second night of a back-to-back. Upset watch banner. Click a game for the full projection (incl. rest days), skater props and team matchup. |
| **Player Edges** | Every skater playing that day vs what tonight's opponent allows to his position, for points, shots, goals, assists or blocks: his per-game number, opponent allowance with rank, matchup multiplier (regressed toward 1.00 by games played), adjusted number, opposing probable goalie and save %, opponent shots allowed, the full model's projection, and a **Spot** column (opponent or own team on a back-to-back, extra rest, his home/road split, hot/cold last 5). |
| **Player Props** | Skaters: shots on goal (chance of 2+ … 5+), points (1+ with fair odds, 2+), anytime goal, assist, blocked shots, with the top reasons. Goalie saves view: probable starter, why, shots against × save %, chances at three lines. |
| **Top Picks** | The day's top 20 overs and top 20 unders across shots, points, goals, assists, blocks and goalie saves (saves capped at 4 per list), plus game picks (winner, total 5.5), each graded ✓/✗ once results are in. Lines are estimated (no free NHL prop lines): the half-goal nearest the player's own average for shots/blocks/saves, 0.5 for points/goals/assists. Edge = the model's chance minus what his average alone implies at that line. |
| **Scorecard** | Live record of the locked picks (overall, by day, by market): hit rate vs what the model expected and what the players' averages implied (beating the latter is the real test), plus the same method backtested on past game days. |
| **Defense vs Position** | What each team allows per game to centers, wingers and defensemen (points, goals, assists, shots, blocks), plus shots and goals allowed. |
| **Team Rankings** | Offense/defense ranks (goals, shots, shooting %, PP goals, hits, faceoffs) and a Power rating. |

**Models** (`web/js/nhl/model.js`, settings in `web/js/sports/nhl.js`,
backtest `node tools/nhl_backtest.mjs [--fit]`; 2025-26 and 2026-27 game
days, each projected from earlier games only, ~21,600 skater-games):

* **Skaters:** season average with last season counted as 25 games ×
  opponent vs position (shots and blocks only: it hurt points/assists) ×
  home ice × opposing probable goalie's save % (scoring) × ice-time trend
  (last 3 games; line/PP promotions show up in minutes first). Each stat has
  its own backtested spread. Calibration: shots 2.5+ predicted 41% → 41%,
  56% → 57%; 1+ point 42% → 43%; anytime goal 26% → 26%; 1+ assist
  41% → 41%; blocks 1.5+ 42% → 40%. Also tested and left out of skater
  projections (weights 0, shown as context on Player Edges instead): his
  team or the opponent on a back-to-back and 3+ days of rest (no change in
  error), his own home/road split (worse at every regression strength) and
  hot/cold last-5 form (worse).
* **Goalies:** probable starter = most starts in the last 10, or the backup
  on the second night of a back-to-back if the starter played yesterday:
  right 64% of the time (vs 57% for "most recent starts"). Saves = shots
  against (opponent volume × team suppression × venue, regressed) × save %
  (regressed by shots faced); MAE 5.5 vs 5.7 for the goalie's own average.
* **Picks / scorecard:** `tools/nhl_picks.mjs` runs in the refresh job and
  saves each game day's picks to `web/data/nhl/picks/<season>.json`,
  re-computed until the day's first puck drop and then frozen (a run after
  some games started locks only the later ones, marked *partial*). Backtest
  (`nhl_backtest.mjs`, 103 game days): top 20 overs hit 49% vs 43% implied
  by the players' averages; unders 64% vs 56%. Saves were the strongest
  market (overs 64% vs 48%) but ~35% void on a wrong probable goalie; shots
  and points overs hit 4-5 points below the model's own expectation
  (picking the biggest edges also picks up the model's errors).
* **Games:** opponent-adjusted goal and shot ratings (50/50), home ice,
  probable-goalie adjustment (half weight), back-to-backs (a team on the
  second night scores 0.2 fewer goals and allows 0.2 more: win % log loss
  0.6848 → 0.6833), Poisson goals per side, ties to overtime with a small
  home edge, squeezed 30% toward 50/50 (raw was overconfident). Win % log
  loss 0.683 vs 0.691 for "home team always 54%"; total goals MAE 1.80 vs
  1.83. The model's favorite lost **45%** of games:
  hockey is close to a coin flip, so the cards always show the upset chance.
