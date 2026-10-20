"""Build the NFL dashboard dataset from nflverse public data.

Downloads weekly player stats and the schedule from the nflverse-data GitHub
releases and writes compact JSON files that the static dashboard in web/ reads.

Rankings are NOT computed here: the dashboard computes them in the browser so
it can re-rank on the fly for different windows (full season, last N games).

Usage:
    python pipeline/build_nfl.py                 # current + previous season
    python pipeline/build_nfl.py --seasons 2025 2026
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import math
import urllib.request
from pathlib import Path

import pandas as pd

RELEASES = "https://github.com/nflverse/nflverse-data/releases/download"
PLAYER_STATS_URL = RELEASES + "/stats_player/stats_player_week_{season}.csv"
SCHEDULE_URL = RELEASES + "/schedules/games.csv"

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "web" / "data" / "nfl"
CACHE_DIR = ROOT / ".cache"

TEAMS = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens",
    "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys",
    "DEN": "Denver Broncos", "DET": "Detroit Lions", "GB": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAX": "Jacksonville Jaguars",
    "KC": "Kansas City Chiefs", "LA": "Los Angeles Rams", "LAC": "Los Angeles Chargers",
    "LV": "Las Vegas Raiders", "MIA": "Miami Dolphins", "MIN": "Minnesota Vikings",
    "NE": "New England Patriots", "NO": "New Orleans Saints", "NYG": "New York Giants",
    "NYJ": "New York Jets", "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers",
    "SEA": "Seattle Seahawks", "SF": "San Francisco 49ers", "TB": "Tampa Bay Buccaneers",
    "TEN": "Tennessee Titans", "WAS": "Washington Commanders",
}

# Fantasy-relevant positions; FB is folded into RB.
POSITIONS = {"QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "TE"}

# Columns summed into team-game offense rows (and, mirrored, defense allowed).
TEAM_COLS = {
    "completions": "cmp",
    "attempts": "pass_att",
    "passing_yards": "pass_yds",
    "passing_tds": "pass_td",
    "passing_interceptions": "int",
    "sacks_suffered": "sacks",
    "carries": "rush_att",
    "rushing_yards": "rush_yds",
    "rushing_tds": "rush_td",
    "rushing_fumbles_lost": "rush_fum_lost",
    "receiving_fumbles_lost": "rec_fum_lost",
    "sack_fumbles_lost": "sack_fum_lost",
    "passing_first_downs": "pass_fd",
    "rushing_first_downs": "rush_fd",
}

# Columns summed per position within a team-game.
POS_COLS = {
    "completions": "cmp",
    "attempts": "pass_att",
    "passing_yards": "pass_yds",
    "passing_tds": "pass_td",
    "passing_interceptions": "int",
    "carries": "rush_att",
    "rushing_yards": "rush_yds",
    "rushing_tds": "rush_td",
    "targets": "tgt",
    "receptions": "rec",
    "receiving_yards": "rec_yds",
    "receiving_tds": "rec_td",
    "fantasy_points_ppr": "fpts",
}

PLAYER_COLS = POS_COLS


def fetch(url: str, cache_name: str, max_age_hours: float) -> bytes:
    CACHE_DIR.mkdir(exist_ok=True)
    path = CACHE_DIR / cache_name
    if path.exists():
        age = dt.datetime.now().timestamp() - path.stat().st_mtime
        if age < max_age_hours * 3600:
            return path.read_bytes()
    print(f"  downloading {url}")
    with urllib.request.urlopen(url, timeout=120) as resp:
        data = resp.read()
    path.write_bytes(data)
    return data


def clean(value):
    """Make a value JSON-safe and compact."""
    if value is None:
        return None
    if isinstance(value, float):
        if math.isnan(value):
            return None
        return int(value) if value.is_integer() else round(value, 2)
    if hasattr(value, "item"):  # numpy scalar
        return clean(value.item())
    return value


def records(df: pd.DataFrame) -> list[dict]:
    return [{k: clean(v) for k, v in row.items()} for row in df.to_dict("records")]


def build_schedule(games: pd.DataFrame, season: int) -> pd.DataFrame:
    g = games[games["season"] == season].copy()
    keep = [
        "game_id", "game_type", "week", "gameday", "weekday", "gametime",
        "away_team", "home_team", "away_score", "home_score", "location",
        "spread_line", "total_line", "away_moneyline", "home_moneyline",
        "div_game", "roof", "stadium", "stadium_id", "temp", "wind",
        "away_rest", "home_rest",
    ]
    g = g[keep].rename(columns={"away_team": "away", "home_team": "home"})
    return g.sort_values(["week", "gameday", "gametime", "game_id"])


def build_team_games(stats: pd.DataFrame, schedule: pd.DataFrame) -> pd.DataFrame:
    """One row per (game, team) with that team's offensive production."""
    team = (
        stats.groupby(["game_id", "week", "season_type", "team", "opponent_team"], as_index=False)[
            list(TEAM_COLS)
        ]
        .sum()
        .rename(columns={**TEAM_COLS, "opponent_team": "opp", "season_type": "game_type"})
    )
    team["fum_lost"] = team.pop("rush_fum_lost") + team.pop("rec_fum_lost") + team.pop("sack_fum_lost")
    team["first_downs"] = team.pop("pass_fd") + team.pop("rush_fd")

    # Points come from the schedule (player stats don't carry defensive/ST scores).
    sched = schedule.set_index("game_id")
    pf, pa, home = [], [], []
    for gid, tm in zip(team["game_id"], team["team"]):
        row = sched.loc[gid] if gid in sched.index else None
        if row is None:
            pf.append(None); pa.append(None); home.append(None)
            continue
        is_home = row["home"] == tm
        pf.append(row["home_score"] if is_home else row["away_score"])
        pa.append(row["away_score"] if is_home else row["home_score"])
        home.append(bool(is_home))
    team["pts"] = pf
    team["pts_allowed"] = pa
    team["home"] = home
    return team.sort_values(["week", "game_id", "team"])


def build_position_games(stats: pd.DataFrame) -> pd.DataFrame:
    """One row per (game, team, position) with that position group's production."""
    s = stats[stats["pos"].notna()]
    pos = (
        s.groupby(["game_id", "week", "team", "opponent_team", "pos"], as_index=False)[list(POS_COLS)]
        .sum()
        .rename(columns={**POS_COLS, "opponent_team": "opp"})
    )
    return pos.sort_values(["week", "game_id", "team", "pos"])


def build_player_games(stats: pd.DataFrame) -> tuple[list[dict], list[dict]]:
    s = stats[stats["pos"].notna()].copy()
    # Drop rows with no offensive involvement at all.
    involvement = s[["attempts", "carries", "targets"]].sum(axis=1)
    s = s[involvement > 0]

    latest = s.sort_values("week").groupby("player_id").tail(1)
    players = records(
        latest[["player_id", "player_display_name", "pos", "team", "headshot_url"]]
        .rename(columns={"player_id": "id", "player_display_name": "name", "headshot_url": "img"})
        .sort_values("name")
    )

    games = (
        s[["player_id", "game_id", "week", "team", "opponent_team", *PLAYER_COLS]]
        .rename(columns={**PLAYER_COLS, "player_id": "id", "opponent_team": "opp"})
        .sort_values(["week", "game_id", "team"])
    )
    # Drop all-zero stat columns per row to keep the file small.
    rows = []
    for r in records(games):
        rows.append({k: v for k, v in r.items() if v not in (0, None) or k in ("id", "game_id", "week", "team", "opp")})
    return players, rows


def build_season(season: int, games: pd.DataFrame) -> dict | None:
    print(f"Season {season}")
    try:
        raw = fetch(PLAYER_STATS_URL.format(season=season), f"stats_player_week_{season}.csv", 6)
    except Exception as exc:  # noqa: BLE001 - season may simply not exist yet
        print(f"  no player stats for {season}: {exc}")
        return None
    stats = pd.read_csv(io.BytesIO(raw), low_memory=False)
    stats = stats[stats["season_type"].isin(["REG", "POST"])].copy()
    stats["pos"] = stats["position"].map(POSITIONS)
    num_cols = list(set(TEAM_COLS) | set(POS_COLS))
    stats[num_cols] = stats[num_cols].fillna(0)

    schedule = build_schedule(games, season)
    team_games = build_team_games(stats, schedule)
    pos_games = build_position_games(stats)
    players, player_games = build_player_games(stats)

    played_weeks = sorted(int(w) for w in team_games["week"].unique())
    return {
        "sport": "nfl",
        "season": season,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "last_week_played": played_weeks[-1] if played_weeks else 0,
        "teams": [{"abbr": k, "name": v} for k, v in TEAMS.items()],
        "schedule": records(schedule),
        "team_games": records(team_games),
        "position_games": records(pos_games),
        "players": players,
        "player_games": player_games,
    }


def main() -> None:
    this_year = dt.date.today().year
    # NFL seasons start in September; Jan-Aug belongs to the previous season.
    current = this_year if dt.date.today().month >= 9 else this_year - 1
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seasons", type=int, nargs="+", default=[current - 1, current])
    args = parser.parse_args()

    games = pd.read_csv(io.BytesIO(fetch(SCHEDULE_URL, "games.csv", 6)), low_memory=False)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    index_path = OUT_DIR / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"seasons": []}
    seasons = set(index["seasons"])

    for season in args.seasons:
        data = build_season(season, games)
        if data is None:
            continue
        out = OUT_DIR / f"{season}.json"
        out.write_text(json.dumps(data, separators=(",", ":")))
        seasons.add(season)
        print(f"  wrote {out.relative_to(ROOT)} ({out.stat().st_size / 1024:.0f} KB, "
              f"{len(data['team_games'])} team-games, {len(data['player_games'])} player-games)")

    index = {"seasons": sorted(seasons, reverse=True)}
    index_path.write_text(json.dumps(index, indent=2) + "\n")


if __name__ == "__main__":
    main()
