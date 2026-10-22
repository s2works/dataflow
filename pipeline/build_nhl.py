"""Build the NHL dashboard dataset from sportsdataverse's fastRhockey data.

Downloads per-season Parquet files (schedule, team / skater / goalie box
scores) from github.com/sportsdataverse/fastRhockey-nhl-data, which updates
nightly from the NHL's own API, and writes compact JSON for the dashboard.

NHL games are played almost daily, so instead of weeks every game gets a
`week` field holding its *game-day index* within the season (1 = first day).
That keeps the shared engine (which ranks using games before a given index)
working unchanged; the UI labels the index with its date.

Season labels follow the start year (2026 = the 2026-27 season); fastRhockey
labels files by end year (2027).

fastRhockey posts each night's games the next morning. Games that have
finished but aren't in it yet are filled in straight from the NHL's own API
(api-web.nhle.com boxscores, free, no key), parsed the same way fastRhockey
does, so results land within a couple of hours of the final horn.

Usage:
    python pipeline/build_nhl.py                    # last three seasons
    python pipeline/build_nhl.py --seasons 2025 2026
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

BASE = "https://raw.githubusercontent.com/sportsdataverse/fastRhockey-nhl-data/main/nhl"
FILES = {
    "schedule": BASE + "/schedules/parquet/nhl_schedule_{end}.parquet",
    "team": BASE + "/team_box/parquet/team_box_{end}.parquet",
    "skater": BASE + "/skater_box/parquet/skater_box_{end}.parquet",
    "goalie": BASE + "/goalie_box/parquet/goalie_box_{end}.parquet",
}

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "web" / "data" / "nhl"
CACHE_DIR = ROOT / ".cache" / "nhl"
CACHE_HOURS = 1

NHL_API = "https://api-web.nhle.com/v1/gamecenter/{id}/boxscore"
GAME_TYPES = {"R": "REG", "P": "POST"}
# Skater positions: left/right wing grouped as wingers.
POSITIONS = {"C": "C", "L": "W", "R": "W", "D": "D"}


def fetch(url: str, name: str) -> bytes | None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / name
    if path.exists() and dt.datetime.now().timestamp() - path.stat().st_mtime < CACHE_HOURS * 3600:
        return path.read_bytes()
    try:
        print(f"  downloading {url}")
        with urllib.request.urlopen(url, timeout=120) as resp:
            data = resp.read()
    except Exception as exc:  # noqa: BLE001 - season may not exist yet
        print(f"  missing {url}: {exc}")
        return None
    path.write_bytes(data)
    return data


def clean(value):
    if value is None:
        return None
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float):
        if math.isnan(value):
            return None
        return int(value) if value.is_integer() else round(value, 2)
    return value


def records(df: pd.DataFrame) -> list[dict]:
    return [{k: clean(v) for k, v in row.items()} for row in df.to_dict("records")]


def minutes(toi) -> float:
    """'16:33' -> 16.55"""
    try:
        m, s = str(toi).split(":")
        return round(int(m) + int(s) / 60, 1)
    except ValueError:
        return 0.0


def api_boxscores(sched: pd.DataFrame) -> tuple[list, list, list, dict]:
    """Team / skater / goalie rows (fastRhockey's columns) for finished games
    missing from fastRhockey, from the NHL API. Returns ({game_id: (home, away
    score)} too). Games that started 2.5+ hours ago and aren't final in the
    schedule are tried; anything not final yet is skipped."""
    now = dt.datetime.now(dt.timezone.utc)
    start = pd.to_datetime(sched["game_time"], utc=True, errors="coerce")
    todo = sched[(~sched["game_state"].isin(["OFF", "FINAL"])) & (start < now - dt.timedelta(hours=2.5))
                 & (start > now - dt.timedelta(days=5))]
    teams, skaters, goalies, scores = [], [], [], {}
    for gid in todo["game_id"]:
        try:
            with urllib.request.urlopen(urllib.request.Request(NHL_API.format(id=gid), headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as resp:
                box = json.loads(resp.read())
        except Exception as exc:  # noqa: BLE001
            print(f"  NHL API {gid}: {exc}")
            continue
        if box.get("gameState") not in ("OFF", "FINAL"):
            continue
        pbs = box.get("playerByGameStats", {})
        sides = {"home": box["homeTeam"], "away": box["awayTeam"]}
        for side, team in sides.items():
            other = sides["away" if side == "home" else "home"]
            tp = pbs.get(f"{side}Team", {})
            sk = (tp.get("forwards") or []) + (tp.get("defense") or [])
            fo = [p["faceoffWinningPctg"] for p in sk if (p.get("faceoffWinningPctg") or 0) > 0]
            teams.append({
                "game_id": gid, "team_abbrev": team["abbrev"], "home_away": side,
                "goals": team.get("score"), "goals_against": other.get("score"), "shots_on_goal": team.get("sog"),
                **{col: sum(p.get(key) or 0 for p in sk) for col, key in [("blocked_shots", "blockedShots"), ("hits", "hits"),
                   ("pim", "pim"), ("power_play_goals", "powerPlayGoals"), ("giveaways", "giveaways"), ("takeaways", "takeaways")]},
                "faceoff_win_pctg": round(sum(fo) / len(fo), 4) if fo else None,
            })
            for p in sk:
                skaters.append({
                    "game_id": gid, "team_abbrev": team["abbrev"], "player_id": p["playerId"],
                    "player_name": (p.get("name") or {}).get("default"), "position": p.get("position"),
                    "goals": p.get("goals"), "assists": p.get("assists"), "points": p.get("points"),
                    "shots_on_goal": p.get("sog"), "blocked_shots": p.get("blockedShots"), "hits": p.get("hits"),
                    "power_play_goals": p.get("powerPlayGoals"), "pim": p.get("pim"), "toi": p.get("toi"),
                })
            for p in tp.get("goalies") or []:
                goalies.append({
                    "game_id": gid, "team_abbrev": team["abbrev"], "player_id": p["playerId"],
                    "player_name": (p.get("name") or {}).get("default"), "starter": bool(p.get("starter")),
                    "shots_against": p.get("shotsAgainst"), "saves": p.get("saves"), "goals_against": p.get("goalsAgainst"),
                    "toi": p.get("toi"), "decision": p.get("decision"),
                })
        scores[gid] = (sides["home"].get("score"), sides["away"].get("score"), box.get("gameState"))
    if todo.shape[0]:
        print(f"  NHL API: {len(scores)} of {todo.shape[0]} finished games not yet in fastRhockey filled in")
    return teams, skaters, goalies, scores


def write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text() == text:
        return False
    path.write_text(text)
    return True


def build_season(season: int) -> dict | None:
    end = season + 1
    print(f"Season {season}-{str(end)[2:]}")
    raw = {k: fetch(url.format(end=end), f"{k}_{end}.parquet") for k, url in FILES.items()}
    if raw["schedule"] is None:
        return None
    sched = pd.read_parquet(io.BytesIO(raw["schedule"]))
    sched = sched[sched["game_type"].isin(GAME_TYPES)].copy()
    sched["game_type"] = sched["game_type"].map(GAME_TYPES)
    sched = sched.sort_values(["game_date", "game_time", "game_id"])
    api_team, api_sk, api_gl, api_scores = api_boxscores(sched)
    for gid, (hs, aws, state) in api_scores.items():
        row = sched["game_id"] == gid
        sched.loc[row, ["home_score", "away_score", "game_state"]] = [hs, aws, state]
    # Game-day index used as the "week" everywhere.
    days = {d: i + 1 for i, d in enumerate(sorted(sched["game_date"].unique()))}
    sched["week"] = sched["game_date"].map(days)
    played = sched["game_state"].isin(["OFF", "FINAL"])
    sched.loc[~played, ["home_score", "away_score"]] = None

    team_box = pd.read_parquet(io.BytesIO(raw["team"])) if raw["team"] else pd.DataFrame()
    if api_team:
        team_box = pd.concat([team_box, pd.DataFrame(api_team)], ignore_index=True)
    nick = team_box.drop_duplicates("team_abbrev").set_index("team_abbrev")["team_name"].to_dict() if len(team_box) else {}
    city = {**dict(zip(sched["home_team_abbr"], sched["home_team_name"])), **dict(zip(sched["away_team_abbr"], sched["away_team_name"]))}
    teams = [{"abbr": a, "name": f"{city.get(a, '')} {nick.get(a, '')}".strip()} for a in sorted(city)]

    schedule = sched.rename(columns={"home_team_abbr": "home", "away_team_abbr": "away", "game_date": "gameday"})
    schedule["gametime"] = schedule["game_time"].astype(str)
    schedule = schedule[["game_id", "game_type", "week", "gameday", "gametime", "away", "home", "away_score", "home_score", "venue"]]

    games = sched.set_index("game_id")[["week", "game_type", "home_team_abbr", "away_team_abbr"]]
    known = set(games.index)

    # ---- team games -----------------------------------------------------------
    team_games = []
    if len(team_box):
        tb = team_box[team_box["game_id"].isin(known)].copy()
        opp = tb[["game_id", "team_abbrev", "shots_on_goal", "goals", "blocked_shots", "hits"]].rename(columns={
            "team_abbrev": "opp", "shots_on_goal": "sa", "goals": "ga2", "blocked_shots": "opp_blk", "hits": "opp_hits"})
        tb = tb.merge(opp, on="game_id")
        tb = tb[tb["team_abbrev"] != tb["opp"]]
        tb["week"] = tb["game_id"].map(games["week"])
        tb["game_type"] = tb["game_id"].map(games["game_type"])
        tb["home"] = tb["home_away"] == "home"
        tb = tb.rename(columns={
            "team_abbrev": "team", "goals": "gf", "goals_against": "ga", "shots_on_goal": "sog",
            "blocked_shots": "blk", "power_play_goals": "ppg", "faceoff_win_pctg": "fo_pct",
        })
        tb["fo_pct"] = (tb["fo_pct"] * 100).round(1)
        team_games = records(tb[["game_id", "week", "game_type", "team", "opp", "home", "gf", "ga", "sog", "sa",
                                 "blk", "hits", "pim", "ppg", "giveaways", "takeaways", "fo_pct"]].sort_values(["week", "game_id", "team"]))

    # ---- skaters ----------------------------------------------------------------
    players, player_games, position_games = [], [], []
    if raw["skater"]:
        sk = pd.read_parquet(io.BytesIO(raw["skater"]))
        if api_sk:
            sk = pd.concat([sk, pd.DataFrame(api_sk)], ignore_index=True)
        sk = sk[sk["game_id"].isin(known)].copy()
        sk["pos"] = sk["position"].map(POSITIONS)
        sk["toi"] = sk["toi"].map(minutes)
        sk["week"] = sk["game_id"].map(games["week"])
        home = sk["game_id"].map(games["home_team_abbr"])
        away = sk["game_id"].map(games["away_team_abbr"])
        sk["opp"] = home.where(sk["team_abbrev"] != home, away)
        sk = sk.rename(columns={"team_abbrev": "team", "player_id": "id", "goals": "g", "assists": "a", "points": "pts",
                                "shots_on_goal": "sog", "blocked_shots": "blk", "power_play_goals": "ppg"})
        cols = ["g", "a", "pts", "sog", "blk", "hits", "ppg", "pim", "toi"]
        sk[cols] = sk[cols].fillna(0)
        latest = sk.sort_values("week").groupby("id").tail(1)
        players = records(latest[["id", "player_name", "pos", "team"]].rename(columns={"player_name": "name"}).sort_values("name"))
        pg = sk[["id", "game_id", "week", "team", "opp", *cols]].sort_values(["week", "game_id", "team"])
        player_games = [{k: v for k, v in r.items() if v not in (0, None) or k in ("id", "game_id", "week", "team", "opp")} for r in records(pg)]
        pos = sk.groupby(["game_id", "week", "team", "opp", "pos"], as_index=False)[cols].sum()
        position_games = records(pos.sort_values(["week", "game_id", "team", "pos"]))

    # ---- goalies ---------------------------------------------------------------
    goalie_games = []
    if raw["goalie"]:
        gb = pd.read_parquet(io.BytesIO(raw["goalie"]))
        if api_gl:
            gb = pd.concat([gb, pd.DataFrame(api_gl)], ignore_index=True)
        gb = gb[gb["game_id"].isin(known)].copy()
        gb["toi"] = gb["toi"].map(minutes)
        gb = gb[gb["toi"] > 0]
        gb["week"] = gb["game_id"].map(games["week"])
        home = gb["game_id"].map(games["home_team_abbr"])
        away = gb["game_id"].map(games["away_team_abbr"])
        gb["opp"] = home.where(gb["team_abbrev"] != home, away)
        gb = gb.rename(columns={"team_abbrev": "team", "player_id": "id", "shots_against": "sa", "goals_against": "ga"})
        goalie_games = records(gb[["id", "game_id", "week", "team", "opp", "starter", "sa", "saves", "ga", "toi", "decision"]]
                               .sort_values(["week", "game_id", "team"]))
        names = gb.drop_duplicates("id", keep="last")
        players += records(names[["id", "player_name", "team"]].rename(columns={"player_name": "name"}).assign(pos="G"))

    played_days = sorted({r["week"] for r in team_games})
    return {
        "sport": "nhl",
        "season": season,
        "season_label": f"{season}-{str(end)[2:]}",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "last_week_played": played_days[-1] if played_days else 0,
        "days": {str(v): k for k, v in days.items()},
        "teams": teams,
        "schedule": records(schedule),
        "team_games": team_games,
        "position_games": position_games,
        "players": players,
        "player_games": player_games,
        "goalie_games": goalie_games,
    }


def main() -> None:
    today = dt.date.today()
    # The NHL season starts in Sept/Oct; Jan-Aug belongs to the previous one.
    current = today.year if today.month >= 9 else today.year - 1
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seasons", type=int, nargs="+", default=[current - 2, current - 1, current])
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index_path = OUT_DIR / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"seasons": []}
    seasons = set(index["seasons"])
    updated = index.get("updated", {})

    for season in args.seasons:
        data = build_season(season)
        if data is None:
            continue
        out = OUT_DIR / f"{season}.json"
        seasons.add(season)
        if out.exists():
            old = json.loads(out.read_text())
            if {**old, "generated_at": None} == {**json.loads(json.dumps(data)), "generated_at": None}:
                print(f"  {out.relative_to(ROOT)} unchanged")
                continue
        out.write_text(json.dumps(data, separators=(",", ":")))
        updated[str(season)] = data["generated_at"]
        print(f"  wrote {out.relative_to(ROOT)} ({out.stat().st_size / 1024:.0f} KB, {len(data['team_games']) // 2} games, "
              f"{len(data['player_games'])} skater-games, {len(data['goalie_games'])} goalie-games)")

    index = {"seasons": sorted(seasons, reverse=True), "updated": {k: updated[k] for k in sorted(updated)}}
    write_if_changed(index_path, json.dumps(index, indent=2) + "\n")


if __name__ == "__main__":
    main()
