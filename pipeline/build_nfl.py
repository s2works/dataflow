"""Build the NFL dashboard dataset from nflverse public data.

Downloads weekly player stats and the schedule from the nflverse-data GitHub
releases and writes compact JSON files that the static dashboard in web/ reads.

Rankings are NOT computed here: the dashboard computes them in the browser so
it can re-rank on the fly for different windows (full season, last N games).

Also records a snapshot of every upcoming game's betting line on each run
(web/data/nfl/lines_<season>.json), which is how line movement is tracked:
nflverse only publishes the current line.

Files are only rewritten when their content changed, so the scheduled refresh
job commits nothing when there is nothing new.

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
INJURIES_URL = RELEASES + "/injuries/injuries_{season}.csv"
PBP_URL = RELEASES + "/pbp/play_by_play_{season}.csv.gz"
PBP_COLS = [
    "game_id", "season_type", "yardline_100", "rush_attempt", "pass_attempt", "two_point_attempt",
    "rusher_player_id", "receiver_player_id", "rush_touchdown", "pass_touchdown",
]

# How long a downloaded file is reused locally (the scheduled job starts clean).
CACHE_HOURS = 1

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

RZ_COLS = ["car_gl", "car_rz", "tgt_rz"]
PLAYER_COLS = POS_COLS  # plus RZ_COLS when play-by-play is available


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

    extra = [c for c in RZ_COLS if c in s.columns]
    games = (
        s[["player_id", "game_id", "week", "team", "opponent_team", *PLAYER_COLS, *extra]]
        .rename(columns={**PLAYER_COLS, "player_id": "id", "opponent_team": "opp"})
        .sort_values(["week", "game_id", "team"])
    )
    # Drop all-zero stat columns per row to keep the file small.
    rows = []
    for r in records(games):
        rows.append({k: v for k, v in r.items() if v not in (0, None) or k in ("id", "game_id", "week", "team", "opp")})
    return players, rows


def build_injuries(season: int) -> list[dict]:
    """Weekly official injury report entries for skill positions."""
    try:
        raw = fetch(INJURIES_URL.format(season=season), f"injuries_{season}.csv", CACHE_HOURS)
    except Exception as exc:  # noqa: BLE001 - not published yet
        print(f"  no injury report for {season}: {exc}")
        return []
    inj = pd.read_csv(io.BytesIO(raw), low_memory=False)
    inj = inj[inj["position"].isin(POSITIONS) & inj["report_status"].isin(["Out", "Doubtful", "Questionable"])]
    inj = inj.rename(columns={
        "gsis_id": "id", "full_name": "name", "position": "pos", "report_status": "status",
        "report_primary_injury": "injury", "practice_status": "practice",
    })
    inj["pos"] = inj["pos"].map(POSITIONS)
    return records(inj[["week", "team", "id", "name", "pos", "status", "injury", "practice"]].sort_values(["week", "team", "name"]))


def update_line_history(season: int, schedule: pd.DataFrame) -> dict:
    """Append the current line for every unplayed game when it changed."""
    path = OUT_DIR / f"lines_{season}.json"
    history = json.loads(path.read_text()) if path.exists() else {}
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes")
    for g in records(schedule):
        if g["home_score"] is not None or g["spread_line"] is None:
            continue
        snap = [g["spread_line"], g["total_line"], g["away_moneyline"], g["home_moneyline"]]
        rows = history.setdefault(g["game_id"], [])
        if not rows or rows[-1][1:] != snap:
            rows.append([now, *snap])
    write_if_changed(path, json.dumps(history, separators=(",", ":"), sort_keys=True))
    return history


def write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text() == text:
        return False
    path.write_text(text)
    return True


def build_red_zone(season: int) -> tuple[pd.DataFrame | None, dict | None]:
    """Per player-game red-zone usage from play-by-play, plus league TD rates.

    car_gl  carries inside the 5      car_rz  carries at the 6-20
    tgt_rz  targets inside the 20
    td_rates: P(TD | opportunity) by zone, used to turn usage into expected TDs.
    """
    try:
        raw = fetch(PBP_URL.format(season=season), f"pbp_{season}.csv.gz", CACHE_HOURS)
    except Exception as exc:  # noqa: BLE001
        print(f"  no play-by-play for {season}: {exc}")
        return None, None
    pbp = pd.read_csv(io.BytesIO(raw), compression="gzip", usecols=PBP_COLS, low_memory=False)
    pbp = pbp[pbp["season_type"].isin(["REG", "POST"]) & (pbp["two_point_attempt"] != 1)]

    runs = pbp[(pbp["rush_attempt"] == 1) & pbp["rusher_player_id"].notna()].copy()
    runs["zone"] = pd.cut(runs["yardline_100"], [0, 5, 20, 100], labels=["gl", "rz", "out"])
    tgts = pbp[(pbp["pass_attempt"] == 1) & pbp["receiver_player_id"].notna()].copy()
    tgts["zone"] = pd.cut(tgts["yardline_100"], [0, 20, 100], labels=["rz", "out"])

    def rate(df, td_col, zone):
        z = df[df["zone"] == zone]
        return round(float(z[td_col].mean()), 4) if len(z) else None

    td_rates = {
        "rush": {z: rate(runs, "rush_touchdown", z) for z in ["gl", "rz", "out"]},
        "rec": {z: rate(tgts, "pass_touchdown", z) for z in ["rz", "out"]},
    }

    car = (
        runs[runs["zone"] != "out"]
        .pivot_table(index=["game_id", "rusher_player_id"], columns="zone", values="rush_attempt", aggfunc="count", observed=False)
        .rename(columns={"gl": "car_gl", "rz": "car_rz"})[["car_gl", "car_rz"]]
        .rename_axis(index=["game_id", "player_id"])
    )
    tgt = (
        tgts[tgts["zone"] == "rz"]
        .groupby(["game_id", "receiver_player_id"]).size().rename("tgt_rz")
        .rename_axis(index=["game_id", "player_id"])
    )
    rz = car.join(tgt, how="outer").fillna(0).astype(int).reset_index()
    return rz, td_rates


def build_season(season: int, games: pd.DataFrame) -> dict | None:
    print(f"Season {season}")
    try:
        raw = fetch(PLAYER_STATS_URL.format(season=season), f"stats_player_week_{season}.csv", CACHE_HOURS)
    except Exception as exc:  # noqa: BLE001 - season may simply not exist yet
        print(f"  no player stats for {season}: {exc}")
        return None
    stats = pd.read_csv(io.BytesIO(raw), low_memory=False)
    stats = stats[stats["season_type"].isin(["REG", "POST"])].copy()
    stats["pos"] = stats["position"].map(POSITIONS)
    num_cols = list(set(TEAM_COLS) | set(POS_COLS))
    stats[num_cols] = stats[num_cols].fillna(0)

    rz, td_rates = build_red_zone(season)
    if rz is not None:
        stats = stats.merge(rz, on=["game_id", "player_id"], how="left")
        stats[RZ_COLS] = stats[RZ_COLS].fillna(0)

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
        "injuries": build_injuries(season),
        "td_rates": td_rates,
        "line_history": update_line_history(season, schedule),
    }


def main() -> None:
    this_year = dt.date.today().year
    # NFL seasons start in September; Jan-Aug belongs to the previous season.
    current = this_year if dt.date.today().month >= 9 else this_year - 1
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seasons", type=int, nargs="+", default=[current - 1, current])
    args = parser.parse_args()

    games = pd.read_csv(io.BytesIO(fetch(SCHEDULE_URL, "games.csv", CACHE_HOURS)), low_memory=False)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    index_path = OUT_DIR / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"seasons": []}
    seasons = set(index["seasons"])
    updated = index.get("updated", {})

    for season in args.seasons:
        data = build_season(season, games)
        if data is None:
            continue
        out = OUT_DIR / f"{season}.json"
        seasons.add(season)
        # Compare without the timestamp so unchanged data isn't rewritten.
        if out.exists():
            old = json.loads(out.read_text())
            if {**old, "generated_at": None} == {**json.loads(json.dumps(data)), "generated_at": None}:
                print(f"  {out.relative_to(ROOT)} unchanged")
                continue
        out.write_text(json.dumps(data, separators=(",", ":")))
        updated[str(season)] = data["generated_at"]
        print(f"  wrote {out.relative_to(ROOT)} ({out.stat().st_size / 1024:.0f} KB, "
              f"{len(data['team_games'])} team-games, {len(data['player_games'])} player-games, "
              f"{len(data['injuries'])} injury entries)")

    # The dashboard polls this small file to know when to reload.
    index = {"seasons": sorted(seasons, reverse=True), "updated": {k: updated[k] for k in sorted(updated)}}
    write_if_changed(index_path, json.dumps(index, indent=2) + "\n")


if __name__ == "__main__":
    main()
